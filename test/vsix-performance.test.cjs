const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), Module = require('node:module');
const { fixture } = require('./fixtures.cjs');
const { snapshotId } = require('../dist/model');

test('扫描以有界并发和批量对象读取覆盖全部文件，冷/热结果相同', async t => {
  const initial = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`nested/f${String(i).padStart(4, '0')}.txt`, `base ${i}\n`]));
  const f = await fixture(t, initial);
  await Promise.all(Object.keys(initial).map((name, i) => f.write(name, `current ${i}\n`)));
  const calls = [], read = f.repo.read.bind(f.repo), working = f.repo.working.bind(f.repo);
  let active = 0, peak = 0;
  f.repo.read = async (...args) => { calls.push(args[0]); return read(...args); };
  f.repo.working = async (...args) => { active++; peak = Math.max(peak, active); try { return await working(...args); } finally { active--; } };
  const cold = await f.repo.scan(f.base), hot = await f.repo.scan(f.base);
  assert.equal(cold.length, 1100); assert.ok(cold.every(row => !row.error));
  assert.deepEqual(hot.map(row => [row.path, row.fingerprint]), cold.map(row => [row.path, row.fingerprint]));
  assert.ok(peak > 1 && peak <= 8, `observed ${peak} concurrent reads`); assert.equal(active, 0);
  assert.ok(calls.filter(args => args[0] === 'cat-file').length <= 12, 'Git batches stay bounded across cache eviction');
  assert.ok(calls.filter(args => args[0] === 'cat-file').every(args => args[1].startsWith('--batch')));
  await f.write('nested/f0500.txt', 'changed again\n');
  const changed = await f.repo.scan(f.base);
  assert.notEqual(changed.find(row => row.path.endsWith('f0500.txt')).fingerprint, hot.find(row => row.path.endsWith('f0500.txt')).fingerprint);
});

test('Diff 定向读取当前磁盘，拒绝旧 CR、读取中切分支及符号链接父目录', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'first\n'); await f.choose();
  const session = f.service.view.session, original = f.service.selection('src/a.txt');
  let scans = 0; const scan = f.repo.scan.bind(f.repo);
  f.repo.scan = async (...args) => { scans++; return scan(...args); };
  await f.write('src/a.txt', 'fresh\n');
  const current = await f.service.openFile('src/a.txt', session.id);
  assert.equal(current.pair.right.data.toString(), 'fresh\n'); assert.notEqual(current.key, original.key);
  assert.equal(f.service.view.files[0].fingerprint, require('../dist/model').pairId(current.pair));
  assert.equal(scans, 0);
  await assert.rejects(f.service.openFile('src/a.txt', 'wrong-review'), /CR 已改变/);
  await f.service.mark({ session: session.id, files: [{ path: original.file, fingerprint: require('../dist/model').pairId(original.pair), checked: true }] }).then(() => assert.fail('stale mark succeeded'), error => assert.match(error.message, /已变化/));
  const pair = f.repo.pair.bind(f.repo);
  f.repo.pair = async (...args) => { const result = await pair(...args); f.git('switch', '-qc', 'switched'); return result; };
  await assert.rejects(f.service.openFile('src/a.txt', session.id), /分支或 CR/);
  f.repo.pair = pair; f.git('switch', '-q', 'feature'); await f.service.refresh();
  const outside = path.join(f.temp, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'a.txt'), 'secret synthetic\n');
  await fs.rm(path.join(f.root, 'src'), { recursive: true }); await fs.symlink(outside, path.join(f.root, 'src'));
  const linked = await f.service.openFile('src/a.txt', session.id);
  assert.equal(linked.pair.right.mode, '000000'); assert.equal(linked.pair.right.data.length, 0);
  assert.equal(await f.repo.editablePath('src/a.txt', current.pair.right), undefined);
  assert.notEqual(snapshotId(linked.pair.right), snapshotId(current.pair.right));
});

test('Diff 定向读取检查所选文件的新合并冲突，不把冲突内容打开为正常 Diff', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'feature\n'); f.git('add', '-A'); f.git('commit', '-qm', 'feature');
  await f.choose();
  f.git('switch', '-qc', 'other', f.base); await f.write('src/a.txt', 'other\n'); f.git('add', '-A'); f.git('commit', '-qm', 'other'); f.git('switch', '-q', 'feature');
  assert.throws(() => f.git('merge', 'other'), /Command failed/);
  await assert.rejects(f.service.openFile('src/a.txt', f.service.view.session.id), /合并冲突/);
  assert.match(f.service.view.files.find(row => row.path === 'src/a.txt').error, /合并冲突/);
});

async function editor(t, f, nativeEvents = false) {
  const dispose = () => ({ dispose() {} }), commands = new Map(), errors = [], calls = [], posts = [];
  let save, panel, receive, activeEditor, activeChanged, tabsChanged;
  class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
  const activeTabGroup = { activeTab: undefined }, tabs = new Map();
  const tabGroups = { activeTabGroup, onDidChangeTabs: fn => { tabsChanged = fn; return dispose(); }, onDidChangeTabGroups: dispose };
  const focus = tab => {
    activeTabGroup.activeTab = tab;
    // Real tab/editor notifications need not expose their new values in one atomic step.
    tabsChanged?.();
    activeEditor = { document: { uri: tab.input.modified, isDirty: false, getText: () => '' } };
    activeChanged?.(activeEditor);
  };
  const memory = () => { const map = new Map(); return { get: key => map.get(key), update: async (key, value) => map.set(key, value) }; };
  const mock = {
    EventEmitter: class { event = dispose; fire() {} dispose() {} }, TreeItem: class {}, ThemeIcon: class {}, ThemeColor: class {}, TabInputTextDiff,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 }, ExtensionMode: { Test: 3 },
    Range: class { constructor(start, _first, end, _last) { this.start = { line: start }; this.end = { line: end }; } },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath }), from: value => ({ ...value, toString: () => value.scheme + '://' + value.authority + value.path }) },
    extensions: { getExtension: () => undefined },
    workspace: { isTrusted: true, textDocuments: [], workspaceFolders: [{ uri: { fsPath: f.root } }], registerTextDocumentContentProvider: dispose,
      onDidSaveTextDocument: fn => { save = fn; return dispose(); }, onDidChangeTextDocument: dispose, onDidCloseTextDocument: dispose },
    window: { createTreeView: () => ({ ...dispose(), visible: false, onDidChangeCheckboxState: dispose, onDidChangeVisibility: dispose }),
      registerFileDecorationProvider: dispose, registerWebviewViewProvider: (_id, provider) => { panel = provider; return dispose(); },
      onDidChangeActiveTextEditor: fn => { activeChanged = fn; return dispose(); }, tabGroups: nativeEvents ? tabGroups : undefined,
      get activeTextEditor() { return activeEditor; }, showTextDocument: async (...args) => { calls.push(['showTextDocument', ...args]); },
      showInformationMessage: async () => {}, showErrorMessage: async message => { errors.push(message); } },
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return dispose(); }, executeCommand: async (...args) => {
      calls.push(args);
      if (nativeEvents && args[0] === 'vscode.diff') {
        // The previous editor can receive a focus event while the next Diff is opening.
        if (activeEditor) activeChanged(activeEditor);
        if (nativeEvents.previewGap) {
          // Actual Trae preview replacement: the old tab disappears before its
          // editor changes, and duplicate tab notifications precede the new tab.
          activeTabGroup.activeTab = undefined; tabsChanged(); tabsChanged();
        }
        const tab = { input: new TabInputTextDiff(args[1], args[2]) };
        tabs.set(args[3].split(' · ').at(-1), tab); focus(tab);
        await nativeEvents.afterOpen?.();
      }
    } }
  };
  for (const name of ['extension', 'tree', 'history', 'settings', 'panel', 'commit-picker']) delete require.cache[require.resolve('../dist/' + name)];
  const load = Module._load; Module._load = function(id, ...args) { return id === 'vscode' ? mock : load.call(this, id, ...args); };
  let ReviewExtension; try { ({ ReviewExtension } = require('../dist/extension')); } finally { Module._load = load; }
  const app = new ReviewExtension({ extensionPath: path.resolve(__dirname, '..'), extensionMode: 3, globalStorageUri: { fsPath: f.storage }, globalState: memory(), workspaceState: memory() });
  t.after(() => app.dispose()); await app.ready;
  panel.resolveWebviewView({ show() {}, webview: {
    onDidReceiveMessage: handler => { receive = handler; return dispose(); },
    postMessage: async message => { posts.push(message); return true; }
  } });
  return { app, commands, errors, calls, posts, receive: message => receive(message), setEditor: editor => { activeEditor = editor; }, save: () => save(),
    focusFile: file => focus(tabs.get(file)), refocus: () => activeChanged(activeEditor),
    focusForeignWithGap: () => {
      const tab = { input: new TabInputTextDiff({ scheme: 'git', toString: () => 'git:/foreign' }, { scheme: 'file', toString: () => '/foreign' }) };
      activeTabGroup.activeTab = tab; activeEditor = undefined; tabsChanged();
      activeEditor = { document: { uri: tab.input.modified, isDirty: false } }; activeChanged(activeEditor);
    } };
}

test('保存事件合并等待中的刷新，扫描中发生的新保存仍触发后续完整刷新', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'initial\n'); await f.choose();
  const { app, commands, save, errors, calls } = await editor(t, f);
  let scans = 0; const scan = app.service.repo.scan.bind(app.service.repo);
  app.service.repo.scan = async (...args) => { scans++; return scan(...args); };
  for (let i = 0; i < 20; i++) save();
  await app.whenIdle(); assert.equal(scans, 1);
  let resume, entered; const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; }); let gate = true;
  app.service.repo.scan = async (...args) => { scans++; if (gate) { gate = false; entered(); await barrier; } return scan(...args); };
  const refreshed = commands.get('codeReview.refresh')(); await started;
  await f.write('src/a.txt', 'during scan\n'); for (let i = 0; i < 20; i++) save();
  resume(); await refreshed; await app.whenIdle();
  assert.equal(scans, 3); assert.equal(app.service.selection('src/a.txt').pair.right.data.toString(), 'during scan\n');
  await commands.get('codeReview.open')({ path: 'src/a.txt', session: app.service.view.session.id });
  assert.equal(scans, 3); assert.ok(calls.some(args => args[0] === 'vscode.diff')); assert.deepEqual(errors, []);

  let releaseScan, scanEntered;
  const waitingScan = new Promise(resolve => { scanEntered = resolve; });
  const heldScan = new Promise(resolve => { releaseScan = resolve; });
  app.service.repo.scan = async (...args) => { scanEntered(); await heldScan; return scan(...args); };
  const refreshing = commands.get('codeReview.refresh')(); await waitingScan;
  let timeout;
  try {
    await Promise.race([
      commands.get('codeReview.open')({ path: 'src/a.txt', session: app.service.view.session.id }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Diff waited for the blocked full scan')), 3000); })
    ]);
    assert.equal(calls.findLast(args => args[0] === 'vscode.diff')[3], '基点 → 当前工作区 · src/a.txt');
  } finally { clearTimeout(timeout); releaseScan(); }
  await refreshing; await app.whenIdle(); assert.deepEqual(errors, []);
});

function gateOnce(object, method, afterRead = false) {
  const original = object[method].bind(object); let release, enter, held = true;
  const started = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  object[method] = async (...args) => {
    if (!held) return original(...args);
    held = false;
    const result = afterRead ? await original(...args) : undefined;
    enter(); await wait;
    return afterRead ? result : original(...args);
  };
  return { started, release, restore: () => { object[method] = original; } };
}

async function twoFileEditor(t) {
  const f = await fixture(t); await f.write('src/a.txt', 'A current\n'); await f.write('src/b.txt', 'B current\n'); await f.choose();
  const h = await editor(t, f);
  const node = name => h.app.tree.findTarget('src/' + name + '.txt', 'file');
  const command = (name, target) => h.commands.get('codeReview.' + name)(target);
  return { f, ...h, node, command };
}

test('导航接收时固定序号：执行中和仍排队的旧目录/概览不能覆盖后点文件', async t => {
  const h = await twoFileEditor(t);
  for (const mode of ['running', 'queued']) for (const name of ['commentDirectory', 'pending']) {
    await h.command('open', h.node('a'));
    const gate = gateOnce(h.app.service.repo, 'scan');
    const refresh = mode === 'queued' ? h.command('refresh') : undefined;
    if (refresh) await gate.started;
    const older = h.command(name, name === 'commentDirectory' ? h.app.tree.findTarget('src', 'directory') : undefined);
    if (!refresh) await gate.started;
    try {
      await h.command('open', h.node('b'));
      assert.equal(h.app.selected.file, 'src/b.txt');
    } finally { gate.release(); }
    await Promise.all([older, refresh]); await h.app.whenIdle(); gate.restore();
    assert.equal(h.app.selected.file, 'src/b.txt', `${mode} ${name}`);
    assert.equal(h.app.overview, undefined);
    assert.equal(h.posts.findLast(post => post.type === 'render').file, 'src/b.txt');
  }
  assert.deepEqual(h.errors, []);
});

test('评论提交在接收时保留目标与选区，晚到确认不清除后来文件的锚点', async t => {
  const h = await twoFileEditor(t), { anchorFor } = require('../dist/anchors');
  for (const mode of ['checking', 'queued']) {
    await h.command('open', h.node('a'));
    const selected = h.app.selected, anchor = anchorFor(selected.pair.right, 'right', 0, 0); h.app.anchor = anchor;
    const gate = gateOnce(mode === 'queued' ? h.app.service.repo : h.app.service, mode === 'queued' ? 'scan' : 'assertCurrent');
    const refresh = mode === 'queued' ? h.command('refresh') : undefined;
    if (refresh) await gate.started;
    h.receive({ action: 'add', key: selected.key, requestId: require('node:crypto').randomUUID(), body: 'anchor ' + mode });
    if (!refresh) await gate.started;
    let newerAnchor;
    try {
      await h.command('open', h.node('b'));
      newerAnchor = anchorFor(h.app.selected.pair.right, 'right', 0, 0); h.app.anchor = newerAnchor;
    } finally { gate.release(); }
    await refresh; await h.app.whenIdle(); gate.restore();
    const saved = h.app.service.view.notes.comments.find(comment => comment.body === 'anchor ' + mode);
    assert.equal(saved.path, 'src/a.txt'); assert.deepEqual(saved.anchor, anchor);
    assert.equal(h.app.selected.file, 'src/b.txt'); assert.equal(h.app.anchor, newerAnchor);
  }
  assert.deepEqual(h.errors, []);
});

test('定位、选区和评论目标导航等待期间后点文件，旧动作不能重新展示或重设选区', async t => {
  const h = await twoFileEditor(t), { anchorFor } = require('../dist/anchors');
  await h.command('open', h.node('a'));
  await h.app.service.add(h.app.selected, 'line location', anchorFor(h.app.selected.pair.right, 'right', 0, 0));
  const comment = h.app.service.view.notes.comments[0];
  for (const action of ['locate', 'selection', 'openTarget']) {
    await h.command(action === 'openTarget' ? 'pending' : 'open', action === 'openTarget' ? undefined : h.node('a'));
    const key = h.posts.findLast(post => post.type === 'render').key;
    if (action === 'selection') h.setEditor({
      document: { uri: { scheme: 'file', fsPath: path.join(h.f.root, 'src/a.txt'), toString: () => path.join(h.f.root, 'src/a.txt') }, isDirty: false, getText: () => 'A current\n' },
      selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
    });
    const gate = gateOnce(h.app.service.repo, 'scan'), shown = h.calls.filter(call => call[0] === 'showTextDocument').length;
    h.receive({ action, key, id: comment.id, requestId: require('node:crypto').randomUUID() });
    await gate.started;
    try { await h.command('open', h.node('b')); } finally { gate.release(); }
    await h.app.whenIdle(); gate.restore();
    assert.equal(h.app.selected.file, 'src/b.txt', action); assert.equal(h.app.anchor, undefined);
    assert.equal(h.calls.filter(call => call[0] === 'showTextDocument').length, shown);
  }
  assert.deepEqual(h.errors, []);
});

test('发布版本防止旧文件读取和旧完整扫描将更新内容回退成已审', async t => {
  const h = await twoFileEditor(t);
  await h.command('mark', h.node('a'));
  const repo = h.app.service.repo;
  // A superseded target read must publish neither old bytes nor an old error.
  for (const failure of [false, true]) {
    await h.f.write('src/a.txt', 'A current\n'); await h.command('refresh');
    const gate = gateOnce(repo, 'pair', true), pair = repo.pair.bind(repo); let first = true;
    if (failure) repo.pair = async (...args) => { const own = first; first = false; const result = await pair(...args); if (own) throw new Error('obsolete read failure'); return result; };
    const old = h.command('open', h.node('a')); await gate.started;
    try {
      await h.f.write('src/a.txt', 'newest ' + failure + '\n'); await h.command('open', h.node('a'));
    } finally { gate.release(); }
    await old; await h.app.whenIdle(); gate.restore();
    const row = h.app.service.view.files.find(file => file.path === 'src/a.txt');
    assert.equal(row.right.data.toString(), 'newest ' + failure + '\n'); assert.equal(row.status, 'changed'); assert.equal(row.error, undefined);
  }
  // The full refresh read first, but the targeted read published first.
  await h.f.write('src/a.txt', 'A current\n'); await h.command('refresh');
  const full = gateOnce(repo, 'scan', true), refreshing = h.command('refresh'); await full.started;
  try { await h.f.write('src/a.txt', 'fresh after scan\n'); await h.command('open', h.node('a')); } finally { full.release(); }
  await refreshing; await h.app.whenIdle(); full.restore();
  let row = h.app.service.view.files.find(file => file.path === 'src/a.txt');
  assert.equal(row.right.data.toString(), 'fresh after scan\n'); assert.equal(row.status, 'changed');
  // The targeted read read first, but the newer full refresh published first.
  const target = gateOnce(repo, 'pair', true), opening = h.command('open', h.node('a')); await target.started;
  try { await h.f.write('src/a.txt', 'fresh after target\n'); await h.command('refresh'); } finally { target.release(); }
  await opening; await h.app.whenIdle(); target.restore();
  row = h.app.service.view.files.find(file => file.path === 'src/a.txt');
  assert.equal(row.right.data.toString(), 'fresh after target\n'); assert.equal(row.status, 'changed');
  assert.equal(h.app.selected.pair.right.data.toString(), 'fresh after target\n'); assert.deepEqual(h.errors, []);
});

test('刷新后为已回到基点的旧目标补读，不覆盖补读期间后点文件', async t => {
  const h = await twoFileEditor(t); await h.command('open', h.node('a'));
  await h.f.write('src/a.txt', 'alpha\n');
  const gate = gateOnce(h.app.service.repo, 'pair', true), refreshing = h.command('refresh');
  await gate.started;
  try { await h.command('open', h.node('b')); } finally { gate.release(); }
  await refreshing; await h.app.whenIdle(); gate.restore();
  assert.equal(h.app.selected.file, 'src/b.txt');
  assert.equal(h.posts.findLast(post => post.type === 'render').file, 'src/b.txt'); assert.deepEqual(h.errors, []);
});

test('原生 Diff 的旧编辑器焦点事件与新标签事件分开发生，评论目标不落后于当前文件', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'A current\n'); await f.write('src/b.txt', 'B current\n'); await f.choose();
  const h = await editor(t, f, true), command = (name, node) => h.commands.get('codeReview.' + name)(node);
  for (const file of ['src/a.txt', 'src/b.txt', 'src/a.txt']) {
    await command('open', h.app.tree.findTarget(file, 'file'));
    assert.equal(h.app.selected.file, file);
    assert.equal(h.posts.findLast(post => post.type === 'render').file, file);
  }
  await command('commentDirectory', h.app.tree.findTarget('src', 'directory')); h.refocus();
  assert.equal(h.app.selected.target, 'directory', 'same-tab focus cannot steal the directory composer');
  await command('pending'); h.refocus();
  assert.equal(h.app.overview, h.app.pendingKey(), 'same-tab focus cannot steal the pending overview');
  h.focusFile('src/b.txt');
  assert.equal(h.app.selected.file, 'src/b.txt'); assert.equal(h.app.overview, undefined);
  await command('open', h.app.tree.findTarget('src/a.txt', 'file'));
  const gate = gateOnce(h.app.service.repo, 'pair'), opening = command('open', h.app.tree.findTarget('src/b.txt', 'file'));
  await gate.started;
  try { h.focusFile('src/b.txt'); } finally { gate.release(); }
  await opening; await h.app.whenIdle(); gate.restore();
  assert.equal(h.app.selected.file, 'src/b.txt'); assert.deepEqual(h.errors, []);
});

test('标签先于编辑器切回完整 Diff 时评论使用最新已读内容，增量快照保持原义', async t => {
  const original = 'B current content for location\n', changed = 'prepended\n' + original;
  const f = await fixture(t); await f.write('src/a.txt', 'A current\n'); await f.write('src/b.txt', original); await f.choose();
  const h = await editor(t, f, true), command = (name, file) => h.commands.get('codeReview.' + name)(file && h.app.tree.findTarget(file, 'file'));
  await command('open', 'src/b.txt');
  const { anchorFor } = require('../dist/anchors');
  await h.app.service.add(h.app.selected, 'B line comment', anchorFor(h.app.selected.pair.right, 'right', 0, 0));
  await command('open', 'src/a.txt');
  await f.write('src/b.txt', changed); await command('refresh');
  h.focusFile('src/b.txt');
  assert.equal(h.app.selected.file, 'src/b.txt');
  assert.equal(h.app.selected.pair.right.data.toString(), changed);
  assert.equal(h.posts.findLast(post => post.type === 'render').cards[0].location, '已跟随行号变化 · 2–2 行');

  await command('mark', 'src/b.txt');
  await f.write('src/b.txt', 'first incremental\n'); await command('since', 'src/b.txt');
  await command('open', 'src/a.txt');
  await f.write('src/b.txt', 'later incremental\n'); await command('refresh');
  h.focusFile('src/b.txt');
  assert.equal(h.app.selected.pair.right.data.toString(), 'first incremental\n', 'a since tab retains its read-only snapshot');
  assert.equal(h.calls.findLast(call => call[0] === 'setContext' && call[1] === 'codeReview.commentable')[2], false);
  assert.deepEqual(h.errors, []);
});

test('标签切到外部 Diff 且编辑器暂时为空时清理旧评论目标', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'A current\n'); await f.choose();
  const h = await editor(t, f, true);
  await h.commands.get('codeReview.open')(h.app.tree.findTarget('src/a.txt', 'file'));
  h.focusForeignWithGap();
  assert.equal(h.app.selected, undefined);
  assert.equal(h.posts.findLast(post => post.type === 'render').file, undefined);
  assert.equal(h.calls.findLast(call => call[0] === 'setContext' && call[1] === 'codeReview.commentable')[2], false);
  assert.deepEqual(h.errors, []);
});

test('真实预览替换的空标签过渡不回退评论，随后手动切标签仍取消旧打开', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'A current\n'); await f.write('src/b.txt', 'B current\n'); await f.choose();
  const events = { previewGap: true }, h = await editor(t, f, events);
  const open = file => h.commands.get('codeReview.open')(h.app.tree.findTarget(file, 'file'));
  for (const file of ['src/a.txt', 'src/b.txt', 'src/a.txt']) {
    const before = h.posts.length;
    await open(file);
    assert.equal(h.app.selected.file, file);
    assert.ok(h.posts.slice(before).filter(post => post.type === 'render').every(post => post.file === file), 'the empty-tab transition must not render the previous target');
  }
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  events.afterOpen = async () => { entered(); await held; };
  const opening = open('src/b.txt'); await started;
  const epoch = h.app.navigation;
  try { h.focusFile('src/a.txt'); } finally { release(); }
  await opening; await h.app.whenIdle();
  assert.ok(h.app.navigation > epoch, 'a real later tab navigation must still invalidate the pending command');
  assert.equal(h.app.selected.file, 'src/a.txt');
  assert.equal(h.posts.findLast(post => post.type === 'render').file, 'src/a.txt');
  assert.deepEqual(h.errors, []);
});
