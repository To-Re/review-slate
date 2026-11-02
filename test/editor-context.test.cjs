const { test } = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), Module = require('node:module'), { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures.cjs');

test('编辑器归属：固定的旧 Diff、普通 Git Diff 和仅标签切换不能借共享工作区 URI 写入另一轮 CR', async t => {
  const f = await fixture(t), commands = new Map(), calls = [], errors = [], posts = [];
  const disposable = () => ({ dispose() {} });
  const memory = () => { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => values.set(key, value) }; };
  let editor, activeChanged, tabsChanged, groupsChanged, panel, receive;
  class Emitter { event = () => disposable(); fire() {} dispose() {} }
  class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
  const activeTabGroup = { activeTab: undefined, isActive: true }, tabGroups = {
    activeTabGroup,
    onDidChangeTabs: fn => { tabsChanged = fn; return disposable(); },
    onDidChangeTabGroups: fn => { groupsChanged = fn; return disposable(); }
  };
  const uri = (scheme, fsPath) => ({ scheme, fsPath, toString: () => scheme + ':' + fsPath });
  const mock = {
    EventEmitter: Emitter, TabInputTextDiff,
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { static File = { id: 'file' }; constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 }, ExtensionMode: { Test: 3 },
    Uri: { file: file => uri('file', file), from: value => ({ ...value, toString: () => value.scheme + '://' + value.authority + value.path }) },
    extensions: { getExtension: () => undefined },
    workspace: {
      isTrusted: true, textDocuments: [], workspaceFolders: [{ uri: { fsPath: f.root } }],
      registerTextDocumentContentProvider: disposable, onDidSaveTextDocument: disposable,
      onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable
    },
    window: {
      tabGroups,
      get activeTextEditor() { return editor; },
      onDidChangeActiveTextEditor: fn => { activeChanged = fn; return disposable(); },
      createTreeView: () => ({ ...disposable(), visible: false, selection: [], onDidChangeCheckboxState: disposable, onDidChangeVisibility: disposable }),
      registerFileDecorationProvider: disposable,
      registerWebviewViewProvider: (_id, value) => { panel = value; return disposable(); },
      showInformationMessage: async () => undefined,
      showErrorMessage: async text => { errors.push(text); }
    },
    commands: {
      registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); },
      executeCommand: async (...args) => { calls.push(args); }
    }
  };
  const previousLoad = Module._load;
  Module._load = function(id, ...args) { return id === 'vscode' ? mock : previousLoad.call(this, id, ...args); };
  let activate;
  try { ({ activate } = require('../dist/extension')); } finally { Module._load = previousLoad; }
  const app = activate({ extensionPath: path.resolve(__dirname, '..'), extensionMode: 3, subscriptions: [], globalStorageUri: { fsPath: f.storage }, globalState: memory(), workspaceState: memory() });
  t.after(() => app.dispose()); await app.ready;
  panel.resolveWebviewView({ show() {}, webview: {
    options: {}, html: '', onDidReceiveMessage: fn => { receive = fn; return disposable(); },
    postMessage: async model => { posts.push(model); return true; }
  } });
  await f.write('src/a.txt', 'second baseline\n'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'second');
  const secondBase = f.git('rev-parse', 'HEAD');
  await f.write('src/a.txt', 'current work\n');
  const open = async base => {
    await app.service.choose(base, 'audit baseline');
    await commands.get('codeReview.open')({ path: 'src/a.txt' });
    const diff = calls.findLast(call => call[0] === 'vscode.diff');
    return { input: new TabInputTextDiff(diff[1], diff[2]), session: app.service.view.session, isActive: true };
  };
  const focus = (tab, side, text) => {
    activeTabGroup.activeTab = tab;
    editor = { document: { uri: tab.input[side], isDirty: false, getText: () => text },
      selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
    activeChanged(editor);
  };
  const commentable = () => calls.findLast(call => call[0] === 'setContext' && call[1] === 'codeReview.commentable')?.[2];
  const add = async (body, session, side) => {
    const beforeErrors = errors.length;
    await commands.get('codeReview.commentSelection')();
    assert.equal(errors.length, beforeErrors, errors.at(-1));
    const model = posts.findLast(post => post.type === 'render');
    receive({ action: 'add', key: model.key, requestId: randomUUID(), body }); await app.whenIdle();
    assert.equal(errors.length, beforeErrors, errors.at(-1));
    const comment = app.service.view.notes.comments.find(item => item.body === body);
    assert.ok(comment); assert.equal(comment.scope, session.id); assert.equal(comment.anchor.side, side);
  };
  const rejectSelection = async () => {
    const count = app.service.view.notes.comments.length, beforeErrors = errors.length;
    assert.equal(commentable(), false);
    await commands.get('codeReview.commentSelection')();
    assert.equal(errors.length, beforeErrors + 1);
    assert.equal(app.service.view.notes.comments.length, count);
  };

  const a = await open(f.base);
  focus(a, 'original', 'alpha\n'); assert.equal(commentable(), true); await add('A left', a.session, 'left');
  focus(a, 'modified', 'current work\n'); assert.equal(commentable(), true); await add('A right', a.session, 'right');
  const b = await open(secondBase);
  assert.notEqual(a.input.original.toString(), b.input.original.toString());
  assert.equal(a.input.modified.toString(), b.input.modified.toString());
  focus(b, 'modified', 'current work\n'); assert.equal(commentable(), true); await add('B right', b.session, 'right');
  focus(a, 'original', 'alpha\n'); await rejectSelection();
  focus(a, 'modified', 'current work\n'); await rejectSelection();

  // Two diff tabs can share the same active TextDocument; no editor-change event is required.
  assert.equal(typeof tabsChanged, 'function'); assert.equal(typeof groupsChanged, 'function');
  activeTabGroup.activeTab = b; tabsChanged({ opened: [], closed: [], changed: [b] });
  assert.equal(commentable(), true); await add('B after tab-only change', b.session, 'right');
  activeTabGroup.activeTab = a; tabsChanged({ opened: [], closed: [], changed: [a] }); await rejectSelection();
  activeTabGroup.activeTab = b; groupsChanged({ opened: [], closed: [], changed: [activeTabGroup] });
  assert.equal(commentable(), true);

  const gitDiff = { input: new TabInputTextDiff(uri('git', '/src/a.txt?HEAD'), b.input.modified), isActive: true };
  focus(gitDiff, 'modified', 'current work\n'); await rejectSelection();
  activeTabGroup.activeTab = b; tabsChanged({ opened: [], closed: [], changed: [b] });
  assert.equal(commentable(), true); await add('B restored after Git diff', b.session, 'right');
  await commands.get('codeReview.pending')();
  assert.equal(posts.findLast(post => post.type === 'render').overview, true);
  // Tab property updates are not navigation: pinning or a dirty-state update
  // must leave the user's pending overview and directory composer in place.
  b.isPinned = true; tabsChanged({ opened: [], closed: [], changed: [b] });
  assert.equal(posts.findLast(post => post.type === 'render').overview, true);
  await commands.get('codeReview.commentDirectory')({ kind: 'folder', path: 'src' });
  assert.equal(posts.findLast(post => post.type === 'render').target, 'directory');
  b.isDirty = true; tabsChanged({ opened: [], closed: [], changed: [b] });
  assert.equal(posts.findLast(post => post.type === 'render').target, 'directory');
  await app.service.openReview(a.session.id);
  assert.deepEqual(app.service.view.notes.comments.map(note => note.body).sort(), ['A left', 'A right']);
});
