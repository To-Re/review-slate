const { test } = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), Module = require('node:module'), cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures.cjs');
const { anchorFor } = require('../dist/anchors');

const dispose = () => ({ dispose() {} });
function memory() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } };
}
function gateOnce(object, method) {
  const original = object[method].bind(object); let enter, release, first = true;
  const started = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  object[method] = async (...args) => {
    if (first) { first = false; enter(); await wait; }
    return original(...args);
  };
  return { started, release, restore: () => { object[method] = original; } };
}
async function editor(t, f, workspaceState = memory()) {
  const commands = new Map(), errors = [], calls = [], posts = [], information = [], reveals = [], picks = [];
  let panel, receive, activeEditor, change;
  const mock = {
    EventEmitter: class { event = dispose; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class {}, ThemeColor: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 }, ExtensionMode: { Test: 3 },
    Range: class { constructor(start, _first, end, _last) { this.start = { line: start }; this.end = { line: end }; } },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath }), from: value => ({ ...value, toString: () => value.scheme + '://' + value.authority + value.path }) },
    extensions: { getExtension: () => undefined },
    workspace: { isTrusted: true, textDocuments: [], workspaceFolders: [{ uri: { fsPath: f.root } }],
      registerTextDocumentContentProvider: dispose, onDidSaveTextDocument: dispose, onDidCloseTextDocument: dispose,
      onDidChangeTextDocument: fn => { change = fn; return dispose(); } },
    window: {
      createTreeView: () => ({ ...dispose(), visible: false, selection: [],
        reveal: async (node, options) => { reveals.push({ node, options }); }, onDidChangeCheckboxState: dispose, onDidChangeVisibility: dispose }),
      registerFileDecorationProvider: dispose, registerWebviewViewProvider: (_id, provider) => { panel = provider; return dispose(); },
      onDidChangeActiveTextEditor: dispose, get activeTextEditor() { return activeEditor; },
      showQuickPick: async items => { const mode = picks.shift(); return items.find(item => item.filter === mode); },
      showInformationMessage: async message => { information.push(message); }, showErrorMessage: async message => { errors.push(message); },
      showTextDocument: async (...args) => { calls.push(['showTextDocument', ...args]); }
    },
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return dispose(); },
      executeCommand: async (...args) => { calls.push(args); } }
  };
  for (const name of ['extension', 'tree', 'history', 'settings', 'panel', 'commit-picker']) delete require.cache[require.resolve('../dist/' + name)];
  const load = Module._load;
  Module._load = function(id, ...args) { return id === 'vscode' ? mock : load.call(this, id, ...args); };
  let ReviewExtension;
  try { ({ ReviewExtension } = require('../dist/extension')); } finally { Module._load = load; }
  const app = new ReviewExtension({ extensionPath: path.resolve(__dirname, '..'), extensionMode: 3,
    globalStorageUri: { fsPath: f.storage }, globalState: memory(), workspaceState });
  t.after(() => app.dispose()); await app.ready;
  panel.resolveWebviewView({ show() {}, webview: {
    onDidReceiveMessage: handler => { receive = handler; return dispose(); },
    postMessage: async message => { posts.push(message); return true; }
  } });
  const command = (name, node) => commands.get('codeReview.' + name)(node);
  return { app, command, errors, calls, posts, information, reveals, workspaceState, mock,
    filter: mode => { picks.push(mode); return command('filter'); },
    send: message => receive({ requestId: randomUUID(), ...message }),
    model: () => posts.findLast(post => post.type === 'render'),
    file: name => app.tree.findTarget(name),
    editor: value => { activeEditor = value; }, change: document => change({ document }) };
}
async function prepared(t) {
  const f = await fixture(t);
  await f.write('src/a.txt', 'changed alpha\nsecond line\n');
  await f.write('src/b.txt', 'changed beta\n');
  await f.choose(); return f;
}
async function noGit(action) {
  const originals = { execFile: cp.execFile, spawn: cp.spawn }; let calls = 0;
  for (const method of Object.keys(originals)) cp[method] = function(command, ...args) {
    if (command === 'git') calls++;
    return originals[method].call(this, command, ...args);
  };
  try { await action(); } finally { Object.assign(cp, originals); }
  assert.equal(calls, 0, 'changing only the filter must not launch Git');
}

test('QA 筛选：偏好保存失败保持原显示，连续异步选择按用户顺序恢复且不扫描', async t => {
  const f = await prepared(t), state = memory(), h = await editor(t, f, state);
  const update = state.update.bind(state); let writes = 0;
  state.update = async (key, value) => { if (key === 'treeFilter' && !writes++) throw new Error('synthetic preference failure'); await update(key, value); };
  await noGit(() => h.filter('comments'));
  assert.match(h.errors.pop(), /synthetic preference failure/);
  assert.equal(state.get('treeFilter'), undefined);
  assert.ok(h.file('src/a.txt')); assert.doesNotMatch(h.app.view.message, /筛选：/);
  const gate = gateOnce(state, 'update');
  try {
    await noGit(async () => {
      const first = h.filter('comments'); await gate.started;
      const second = h.filter('unreviewed');
      await Promise.resolve(); // The second QuickPick choice is delivered before the later clear command.
      const third = h.command('clearFilter');
      assert.ok(h.file('src/a.txt'), 'no filtered model before persistence succeeds');
      gate.release(); await Promise.all([first, second, third]); await h.app.whenIdle();
    });
  } finally { gate.release(); gate.restore(); }
  assert.equal(state.get('treeFilter'), 'all'); assert.doesNotMatch(h.app.view.message, /筛选：/);
  await noGit(() => h.filter('comments'));
  assert.equal(h.file('src/a.txt'), undefined); assert.match(h.app.view.message, /有评论.*0\/2/);
  h.app.dispose(); await h.app.whenIdle();
  const reopened = await editor(t, f, state);
  assert.equal(reopened.file('src/a.txt'), undefined); assert.match(reopened.app.view.message, /有评论.*0\/2/);
  await noGit(() => reopened.filter(undefined));
  assert.equal(state.get('treeFilter'), 'comments'); assert.deepEqual(h.errors, []); assert.deepEqual(reopened.errors, []);
});

test('QA 筛选：目录或整树标记在读取途中切入筛选后不能改写隐藏成员', async t => {
  const f = await prepared(t), h = await editor(t, f);
  for (const checked of [true, false]) {
    await h.command('clearFilter');
    if (!checked) await h.command('mark');
    const session = h.app.service.view.session;
    const before = await h.app.service.state.records(session);
    const staleFolder = h.app.tree.findTarget('src', 'directory');
    const gate = gateOnce(h.app.service.repo, 'scan');
    try {
      const marking = h.command(checked ? 'mark' : 'unmark', checked ? staleFolder : undefined);
      await gate.started; await h.filter('comments'); gate.release(); await marking; await h.app.whenIdle();
    } finally { gate.release(); gate.restore(); }
    assert.match(h.errors.pop(), /切换到全部后批量标记/);
    assert.deepEqual(await h.app.service.state.records(session), before);
    for (const node of [staleFolder, undefined]) {
      await noGit(() => h.command(checked ? 'mark' : 'unmark', node));
      assert.match(h.errors.pop(), /切换到全部后批量标记/);
    }
    assert.deepEqual(await h.app.service.state.records(session), before);
  }
  assert.deepEqual(h.errors, []);
});

test('QA 筛选：在途选区与隐藏对象仍可提交原行评论，草稿身份和导航不因筛选改变', async t => {
  const f = await prepared(t), h = await editor(t, f);
  await h.command('open', h.file('src/a.txt'));
  const diff = h.calls.findLast(call => call[0] === 'vscode.diff');
  h.editor({ document: { uri: diff[2], isDirty: false, getText: () => 'changed alpha\nsecond line\n' },
    selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } });
  const gate = gateOnce(h.app.service.repo, 'scan');
  try {
    const selecting = h.command('commentSelection'); await gate.started;
    await h.filter('comments'); gate.release(); await selecting; await h.app.whenIdle();
  } finally { gate.release(); gate.restore(); }
  const model = h.model(), anchor = h.app.anchor, selection = h.app.selected;
  assert.equal(h.file('src/a.txt'), undefined); assert.equal(model.file, 'src/a.txt');
  assert.ok(anchor); assert.match(model.quote, /changed alpha/);
  const beforeDiffs = h.calls.filter(call => call[0] === 'vscode.diff').length;
  await noGit(async () => { await h.filter('unreviewed'); await h.filter('comments'); });
  assert.equal(h.app.selected, selection); assert.equal(h.app.anchor, anchor);
  assert.equal(h.model().draftKey, model.draftKey); assert.equal(h.model().key, model.key);
  assert.equal(h.calls.filter(call => call[0] === 'vscode.diff').length, beforeDiffs);
  h.send({ action: 'add', key: model.key, body: 'Synthetic selected line comment' }); await h.app.whenIdle();
  const comment = h.app.service.view.notes.comments.find(item => item.body === 'Synthetic selected line comment');
  assert.equal(comment.path, 'src/a.txt'); assert.deepEqual(comment.anchor.selected, ['changed alpha']);
  assert.ok(h.file('src/a.txt')); assert.equal(h.model().draftKey, model.draftKey); assert.deepEqual(h.errors, []);
});

test('QA 筛选：定位期间切换模式仍完成有效导航，失效锚点与旧 CR 请求不清除筛选', async t => {
  const f = await prepared(t), h = await editor(t, f);
  const selection = h.app.service.selection('src/a.txt');
  await h.app.service.add(selection, 'Synthetic anchor', anchorFor(selection.pair.right, 'right', 0, 0), randomUUID());
  await h.command('mark', h.file('src/a.txt'));
  await h.command('open', h.file('src/a.txt'));
  const comment = h.app.service.view.notes.comments[0];
  await h.filter('unreviewed'); assert.equal(h.file('src/a.txt'), undefined);
  const gate = gateOnce(h.app.service.repo, 'scan');
  try {
    h.send({ action: 'locate', key: h.model().key, id: comment.id }); await gate.started;
    await h.filter('comments'); gate.release(); await h.app.whenIdle();
  } finally { gate.release(); gate.restore(); }
  assert.equal(h.workspaceState.get('treeFilter'), 'comments', 'now-visible target does not reset the newer filter');
  assert.equal(h.reveals.at(-1).node.path, 'src/a.txt');
  assert.ok(h.calls.some(call => call[0] === 'showTextDocument'));
  assert.deepEqual(h.errors, []);
  await f.write('src/a.txt', 'unrelated replacement\n'); await h.command('refresh');
  await h.command('open', h.file('src/a.txt'));
  const shows = h.calls.filter(call => call[0] === 'showTextDocument').length;
  h.send({ action: 'locate', key: h.model().key, id: comment.id }); await h.app.whenIdle();
  assert.match(h.errors.pop(), /位置待确认/); assert.equal(h.workspaceState.get('treeFilter'), 'comments');
  assert.equal(h.calls.filter(call => call[0] === 'showTextDocument').length, shows);
  const oldKey = h.model().key;
  f.git('switch', '-qc', 'another-review');
  await h.command('refresh'); await h.app.service.choose(f.base, 'Synthetic second CR'); await h.command('refresh');
  h.send({ action: 'openTarget', key: oldKey, id: comment.id }); await h.app.whenIdle();
  assert.ok(h.errors.pop()); assert.equal(h.workspaceState.get('treeFilter'), 'comments');
  assert.equal(h.calls.filter(call => call[0] === 'showTextDocument').length, shows);
  assert.deepEqual(h.errors, []);
});

test('QA 筛选：批量操作等待真实存储锁时切换模式，拿锁后仍须拒绝写入', async t => {
  const f = await prepared(t), h = await editor(t, f), { locked } = require('../dist/filesystem');
  for (const checked of [true, false]) {
    await h.command('clearFilter');
    if (!checked) await h.command('mark');
    const service = h.app.service, session = service.view.session;
    const before = await service.state.records(session);
    let entered, unlock, reached;
    const acquired = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { unlock = resolve; });
    const recording = new Promise(resolve => { reached = resolve; });
    const holder = locked(service.state.repositoryDirectory, async () => { entered(); await wait; });
    const record = service.state.record.bind(service.state);
    service.state.record = (...args) => { reached(); return record(...args); };
    let marking, timeout;
    try {
      await acquired;
      marking = h.command(checked ? 'mark' : 'unmark', checked ? h.app.tree.findTarget('src', 'directory') : undefined);
      await Promise.race([recording, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('batch did not reach the storage lock')), 3000); })]);
      clearTimeout(timeout);
      await h.filter('comments'); unlock(); await holder; await marking; await h.app.whenIdle();
    } finally {
      clearTimeout(timeout); unlock(); await holder; if (marking) await marking;
      service.state.record = record;
    }
    assert.match(h.errors.pop(), /切换到全部后批量标记/);
    assert.deepEqual(await service.state.records(session), before, 'neither marking nor unmarking may change hidden members after lock wait');
  }
  assert.deepEqual(h.errors, []);
});

test('QA 筛选：真实评论解决、删除与恢复重新匹配，保留评论和目录自评不扩大变更范围', async t => {
  const f = await prepared(t), h = await editor(t, f), service = h.app.service;
  await f.write('src/no-comment.txt', 'uncommented change\n'); await h.command('refresh');
  await service.add(service.selection('src/a.txt'), 'Synthetic file comment', undefined, randomUUID());
  await service.add(service.selection('src/b.txt'), 'Synthetic retained comment', undefined, randomUUID());
  await service.add(service.directorySelection('src'), 'Synthetic directory comment', undefined, randomUUID());
  await f.write('src/b.txt', 'beta\n'); await h.command('refresh');
  await h.filter('comments');
  assert.ok(h.file('src/a.txt')); assert.equal(h.file('src/b.txt').row.commentOnly, true);
  assert.equal(h.file('src/no-comment.txt'), undefined);
  assert.match(h.app.view.message, /全部范围 0\/2/);
  await h.command('open', h.file('src/a.txt'));
  let comment = service.view.notes.comments.find(item => item.path === 'src/a.txt');
  h.send({ action: 'resolve', key: h.model().key, id: comment.id, revision: comment.revision }); await h.app.whenIdle();
  assert.ok(h.file('src/a.txt')); assert.equal(service.view.notes.comments.find(item => item.id === comment.id).state, 'resolved');
  comment = service.view.notes.comments.find(item => item.id === comment.id);
  h.send({ action: 'delete', key: h.model().key, id: comment.id, revision: comment.revision }); await h.app.whenIdle();
  assert.equal(h.file('src/a.txt'), undefined); assert.equal(h.app.selected.file, 'src/a.txt');
  assert.ok(h.app.tree.findTarget('src', 'directory')); assert.equal(h.file('src/no-comment.txt'), undefined);
  const deleted = service.view.notes.deleted.find(item => item.id === comment.id);
  h.send({ action: 'restore', key: h.model().key, id: deleted.id, revision: deleted.revision }); await h.app.whenIdle();
  assert.ok(h.file('src/a.txt')); assert.equal(h.model().file, 'src/a.txt');
  await h.filter('unreviewed');
  assert.equal(h.file('src/b.txt'), undefined); assert.ok(h.file('src/no-comment.txt'));
  assert.match(h.app.view.message, /全部范围 0\/2/); assert.deepEqual(h.errors, []);
});
