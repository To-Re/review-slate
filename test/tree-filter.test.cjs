const { test } = require('node:test'), assert = require('node:assert/strict');
const Module = require('node:module'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures.cjs');

const disposable = () => ({ dispose() {} });
function baseMock() {
  return {
    EventEmitter: class { event = disposable; fire() {} dispose() {} },
    ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { static File = {}; constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath }), from: value => ({ ...value, toString: () => value.scheme + '://' + value.authority + value.path }) },
    Range: class {}, ExtensionMode: { Test: 3 }
  };
}
function load(name, mock) {
  for (const file of ['extension', 'tree', 'history', 'settings', 'panel', 'commit-picker']) delete require.cache[require.resolve('../dist/' + file)];
  const previous = Module._load;
  Module._load = function (id, ...args) { return id === 'vscode' ? mock : previous.call(this, id, ...args); };
  try { return require('../dist/' + name); } finally { Module._load = previous; }
}
test('树筛选仅投影匹配目标和祖先，完整目录统计与标记安全不随隐藏项变化', () => {
  const { ReviewTree, treeFilter } = load('tree', baseMock()), tree = new ReviewTree();
  const snapshot = { mode: '100644', data: Buffer.from('synthetic') };
  const row = (name, status = 'pending', extra = {}) => ({ path: name, left: snapshot, right: snapshot, fingerprint: name, status, ...extra });
  const view = {
    session: { id: 'scope', base: 'a'.repeat(40), label: 'base' },
    files: [row('src/reviewed', 'reviewed'), row('src/pending'), row('src/changed', 'changed'), row('src/dirty', 'reviewed'), row('src/error', 'reviewed', { error: 'synthetic error' }),
      row('src/retained', 'pending', { commentOnly: true }), row('deleted/file', 'pending', { commentOnly: true, deletedOnly: true }), row('own/uncommented'), row('src/x'), row('src/x/child'), row('src/xx/child')],
    notes: { comments: [{ path: 'src/reviewed', state: 'resolved' }, { path: 'src/retained', state: 'open', anchor: {} }, { path: 'own', target: 'directory', state: 'resolved' }, { path: 'src/x', target: 'directory', state: 'open' }],
      deleted: [{ path: 'deleted/file', state: 'open' }, { path: 'deleted/dir', target: 'directory', state: 'open' }], replies: new Map([['orphan', { body: 'synthetic' }]]) }
  };
  const before = JSON.stringify(view), dirty = new Set(['src/dirty']);
  tree.render(view, dirty, 'all');
  const oldDirectory = tree.findTarget('src', 'directory');
  const fullDirectory = tree.getTreeItem(tree.findTarget('src', 'directory'));
  tree.render(view, dirty, 'unreviewed');
  for (const name of ['pending', 'changed', 'dirty', 'error', 'x', 'x/child', 'xx/child']) assert.ok(tree.findTarget('src/' + name));
  for (const name of ['reviewed', 'retained']) assert.equal(tree.findTarget('src/' + name), undefined);
  assert.ok(tree.findTarget('src/reviewed', undefined, true));
  assert.ok(tree.getChildren(oldDirectory).every(node => node.path !== 'src/reviewed'), 'stable old directory handles cannot bypass the current projection');
  const filteredDirectory = tree.getTreeItem(tree.findTarget('src', 'directory'));
  assert.equal(filteredDirectory.description, fullDirectory.description); assert.equal(filteredDirectory.checkboxState, undefined);
  assert.match(filteredDirectory.tooltip, /包含隐藏项/);
  tree.render(view, dirty, 'comments');
  assert.ok(tree.findTarget('src/reviewed')); assert.ok(tree.findTarget('src/retained'));
  assert.ok(tree.findTarget('own', 'directory')); assert.equal(tree.findTarget('own/uncommented'), undefined);
  assert.ok(tree.findTarget('src/x', 'directory')); assert.equal(tree.findTarget('src/x'), undefined); assert.equal(tree.findTarget('src/x/child'), undefined); assert.equal(tree.findTarget('src/xx', 'directory'), undefined);
  assert.equal(tree.findTarget('deleted', 'directory'), undefined);
  assert.equal(tree.getParent(tree.findTarget('src/reviewed')).path, 'src');
  assert.equal(tree.getTreeItem(tree.findTarget('src', 'directory')).description, fullDirectory.description);
  assert.equal(JSON.stringify(view), before); assert.equal(treeFilter('bad-mode'), 'all');
  view.notes.comments = []; tree.render(view, dirty, 'comments');
  assert.equal(tree.nodes[0].kind, 'base'); assert.equal(tree.nodes[1].label, '暂无带评论的文件或目录');
  assert.equal(tree.getTreeItem(tree.nodes[1]).command.command, 'codeReview.clearFilter');
  tree.render({ ...view, error: 'failed' }, dirty, 'comments'); assert.equal(tree.nodes[0].retry, true);
});

async function host(t, f, preferences = new Map()) {
  const mock = baseMock(), commands = new Map(), views = new Map(), calls = [], posts = [], errors = [], information = [], documents = [];
  let checkbox, dirtyChanged, receive, choice, quickPick;
  const memory = values => ({ get: key => values.get(key), update: async (key, value) => { values.set(key, value); } });
  mock.extensions = { getExtension: () => undefined };
  mock.workspace = { workspaceFolders: [{ uri: { fsPath: f.root } }], textDocuments: documents, registerTextDocumentContentProvider: disposable,
    onDidSaveTextDocument: disposable, onDidChangeTextDocument: fn => { dirtyChanged = fn; return disposable(); }, onDidCloseTextDocument: disposable };
  mock.window = {
    createTreeView: (id, options) => { const view = { ...disposable(), visible: false, selection: [], onDidChangeVisibility: disposable,
      onDidChangeCheckboxState: fn => { if (id === 'codeReview.files') checkbox = fn; return disposable(); },
      reveal: async (node, args) => { assert.ok(options.treeDataProvider.findTarget(node.path, node.kind === 'folder' ? 'directory' : undefined)); calls.push(['reveal', node, args]); } }; views.set(id, view); return view; },
    registerFileDecorationProvider: disposable, registerWebviewViewProvider: (_id, panel) => { panel.resolveWebviewView({ show() {}, webview: {
      onDidReceiveMessage: fn => { receive = fn; return disposable(); }, postMessage: async value => { posts.push(value); return true; }
    } }); return disposable(); },
    onDidChangeActiveTextEditor: disposable,
    showQuickPick: async items => { quickPick = items; return items.find(item => item.filter === choice); },
    showErrorMessage: async text => { errors.push(text); }, showInformationMessage: async text => { information.push(text); },
    showTextDocument: async (...args) => { calls.push(['showTextDocument', ...args]); }
  };
  mock.commands = { registerCommand: (name, handler) => { commands.set(name, handler); return disposable(); }, executeCommand: async (...args) => { calls.push(args); } };
  const { ReviewExtension } = load('extension', mock);
  const context = { extensionPath: path.resolve(__dirname, '..'), globalStorageUri: { fsPath: f.storage }, workspaceState: memory(preferences), globalState: memory(new Map()) };
  const app = new ReviewExtension(context); t.after(() => app.dispose()); await app.ready;
  let scans = 0; const scan = app.service.repo.scan.bind(app.service.repo);
  app.service.repo.scan = async (...args) => { scans++; return scan(...args); };
  const command = (name, node) => commands.get('codeReview.' + name)(node);
  return { app, context, preferences, commands, command, views, calls, posts, errors, information, documents,
    get scans() { return scans; }, get quickPick() { return quickPick; },
    filter: async mode => { choice = mode; await command('filter'); }, checkbox: items => checkbox({ items }), dirty: () => dirtyChanged(),
    message: async value => { receive({ ...value, requestId: randomUUID() }); await app.whenIdle(); } };
}
async function changed(t, preferences) {
  const f = await fixture(t); await f.write('src/a.txt', 'A current line long enough\n'); await f.write('src/b.txt', 'B current\n'); await f.choose();
  return { f, h: await host(t, f, preferences) };
}
function hold(object, method) {
  const original = object[method].bind(object); let release, enter;
  const started = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; }); let first = true;
  object[method] = async (...args) => { if (first) { first = false; enter(); await wait; } return original(...args); };
  return { started, release, restore: () => { object[method] = original; } };
}
test('筛选和清除只更新内存树及工作区偏好，不阻塞刷新/打开、不取消导航或评论锚点', async t => {
  const { f, h } = await changed(t);
  const node = name => h.app.tree.findTarget('src/' + name + '.txt');
  await h.command('open', node('a'));
  const selected = h.app.selected, anchor = require('../dist/anchors').anchorFor(selected.pair.right, 'right', 0, 0); h.app.anchor = anchor;
  const initialScans = h.scans, navigation = h.app.navigation;
  await h.filter('comments'); assert.equal(h.scans, initialScans); assert.equal(h.app.navigation, navigation); assert.equal(h.app.selected, selected); assert.equal(h.app.anchor, anchor);
  assert.equal(h.preferences.get('treeFilter'), 'comments'); assert.match(h.views.get('codeReview.files').message, /筛选：有评论.*全部范围 0\/2/);
  await h.filter(undefined); assert.equal(h.preferences.get('treeFilter'), 'comments'); assert.equal(h.quickPick.find(item => item.filter === 'comments').description, '当前');
  await h.command('clearFilter');
  const gate = hold(h.app.service.repo, 'scan'), refresh = h.command('refresh'); await gate.started;
  try { await h.filter('unreviewed'); assert.equal(h.app.navigation, navigation); } finally { gate.release(); }
  await refresh; gate.restore(); assert.equal(h.scans, initialScans + 1);
  const pairGate = hold(h.app.service.repo, 'pair'), opening = h.command('open', node('b')); await pairGate.started;
  try { await h.filter('comments'); } finally { pairGate.release(); }
  await opening; pairGate.restore(); assert.equal(h.app.selected.file, 'src/b.txt'); assert.equal(h.calls.findLast(call => call[0] === 'vscode.diff')[3], '基点 → 当前工作区 · src/b.txt');
  assert.deepEqual(h.errors, []);
  h.app.dispose(); const restored = await host(t, f, h.preferences); assert.equal(restored.app.filter, 'comments');
  h.preferences.set('treeFilter', 'invalid'); restored.app.dispose(); const invalid = await host(t, f, h.preferences); assert.equal(invalid.app.filter, 'all');
});
test('非全部拒绝目录/整树勾选及旧命令，单文件标记后隐藏并保留Diff；脏文件重新出现', async t => {
  const { h, f } = await changed(t), folder = h.app.tree.findTarget('src', 'directory');
  await h.command('open', h.app.tree.findTarget('src/a.txt'));
  await h.filter('unreviewed');
  const before = h.scans;
  for (const name of ['mark', 'unmark']) { await h.command(name, folder); await h.command(name); }
  h.checkbox([[folder, 1]]); await h.app.whenIdle();
  assert.equal(h.scans, before); assert.equal(h.errors.length, 5); assert.ok(h.errors.every(error => /切换到全部/.test(error)));
  await h.command('mark', h.app.tree.findTarget('src/a.txt'));
  assert.equal(h.app.tree.findTarget('src/a.txt'), undefined); assert.equal(h.app.selected.file, 'src/a.txt');
  assert.match(h.views.get('codeReview.files').message, /全部范围 1\/2/);
  h.documents.push({ uri: { scheme: 'file', fsPath: path.join(f.root, 'src/a.txt') }, isDirty: true });
  const afterMark = h.scans; h.dirty(); assert.ok(h.app.tree.findTarget('src/a.txt')); assert.equal(h.scans, afterMark);
  h.documents[0].isDirty = false; h.dirty(); assert.equal(h.app.tree.findTarget('src/a.txt'), undefined);
  await h.command('clearFilter');
  const queueGate = hold(h.app.service.repo, 'scan'), refreshing = h.command('refresh'); await queueGate.started;
  await h.filter('comments');
  const queuedMark = h.command('mark', folder);
  try { await h.command('clearFilter'); } finally { queueGate.release(); }
  await refreshing; await queuedMark; queueGate.restore();
  assert.match(h.errors.at(-1), /切换到全部/, 'a queued batch received under a filter cannot become authorized by a later clear');
  const records = await h.app.service.state.records(h.app.service.view.session);
  const writeGate = hold(h.app.service.state, 'record'), marking = h.command('mark', h.app.tree.findTarget('src', 'directory'));
  await writeGate.started;
  try { await h.filter('comments'); } finally { writeGate.release(); }
  await marking; writeGate.restore();
  assert.match(h.errors.at(-1), /切换到全部/);
  assert.deepEqual(await h.app.service.state.records(h.app.service.view.session), records, 'filter changes while awaiting the storage lock must be checked again');
  await h.command('clearFilter'); const restored = h.app.tree.findTarget('src', 'directory');
  await f.write('src/new.txt', 'new synthetic\n'); await h.command('mark', restored);
  assert.match(h.errors.at(-1), /目录文件列表已变化/);
});
test('评论打开及定位隐藏目标自动恢复全部并reveal，偏好和提示一致', async t => {
  const { h } = await changed(t), service = h.app.service;
  const selected = service.selection('src/a.txt'), { anchorFor } = require('../dist/anchors');
  await service.add(selected, 'synthetic line', anchorFor(selected.pair.right, 'right', 0, 0));
  await h.command('refresh'); await h.command('mark', h.app.tree.findTarget('src/a.txt'));
  for (const action of ['openTarget', 'locate']) {
    await h.command('pending'); const key = h.app.pendingKey(), comment = service.view.notes.comments[0];
    await h.filter('unreviewed'); assert.equal(h.app.tree.findTarget('src/a.txt'), undefined);
    await h.message({ action, key, id: comment.id });
    assert.equal(h.preferences.get('treeFilter'), 'all'); assert.ok(h.app.tree.findTarget('src/a.txt'));
    assert.equal(h.calls.findLast(call => call[0] === 'reveal')[1].path, 'src/a.txt');
    assert.equal(h.information.at(-1), '已显示全部，以定位评论对象');
  }
  assert.deepEqual(h.errors, []);
});

test('过期评论定位不清除后来导航的筛选偏好，也不覆盖后来手动选择', async t => {
  const { h } = await changed(t), service = h.app.service;
  await service.add(service.selection('src/a.txt'), 'synthetic target');
  await h.command('refresh'); await h.command('mark', h.app.tree.findTarget('src/a.txt'));
  for (const laterMode of [undefined, 'comments']) {
    await h.command('pending'); const key = h.app.pendingKey(), comment = service.view.notes.comments[0];
    await h.filter('unreviewed');
    const gate = hold(h.context.workspaceState, 'update');
    const opening = h.message({ action: 'openTarget', key, id: comment.id }); await gate.started;
    let manual;
    try {
      await h.command('open', h.app.tree.findTarget('src/b.txt'));
      if (laterMode) manual = h.filter(laterMode);
    } finally { gate.release(); }
    await opening; await manual; gate.restore();
    assert.equal(h.app.selected.file, 'src/b.txt');
    assert.equal(h.app.filter, laterMode || 'unreviewed');
    assert.equal(h.preferences.get('treeFilter'), laterMode || 'unreviewed');
    assert.ok(!h.information.includes('已显示全部，以定位评论对象'));
  }
  assert.deepEqual(h.errors, []);
});

test('自动定位真正执行时目标已被先前筛选显示，不再覆盖该模式', async t => {
  const { h } = await changed(t), service = h.app.service;
  await service.add(service.selection('src/a.txt'), 'synthetic target');
  await h.command('refresh'); await h.command('mark', h.app.tree.findTarget('src/a.txt'));
  await h.command('pending'); const key = h.app.pendingKey(), comment = service.view.notes.comments[0];
  await h.filter('unreviewed');
  const writeGate = hold(h.context.workspaceState, 'update'), manual = h.filter('comments'); await writeGate.started;
  const autoGate = hold(h.app, 'setTreeFilter');
  const opening = h.message({ action: 'openTarget', key, id: comment.id }); await autoGate.started;
  writeGate.release(); await manual; writeGate.restore();
  assert.ok(h.app.tree.findTarget('src/a.txt'));
  autoGate.release(); await opening; autoGate.restore();
  assert.equal(h.app.selected.file, 'src/a.txt'); assert.equal(h.app.filter, 'comments');
  assert.equal(h.preferences.get('treeFilter'), 'comments');
  assert.ok(!h.information.includes('已显示全部，以定位评论对象')); assert.deepEqual(h.errors, []);
});
