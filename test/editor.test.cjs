const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), Module = require('node:module');
const { fixture } = require('./fixtures.cjs');
const memory = () => { const map = new Map(); return { get: key => map.get(key), update: async (key, value) => map.set(key, value) }; };
const disposable = () => ({ dispose() {} });

test('编辑器适配：入口、两种基点、通知不阻塞、原生 Diff、勾选、评论与重建恢复', async t => {
  const f = await fixture(t); let pick, view, provider, panel, editor, checkbox, receive, html, saveDocument, changeDocument, confirmation, suppress = false;
  const commands = new Map(), calls = [], posts = [], errors = [], warnings = [], textDocuments = [];
  class Emitter { listeners = []; event = fn => { this.listeners.push(fn); return disposable(); }; fire(value) { this.listeners.forEach(fn => fn(value)); } dispose() {} }
  const mock = {
    EventEmitter: Emitter, TreeItem: class { constructor(label, collapsed) { this.label = label; this.collapsibleState = collapsed; } },
    ThemeIcon: class { static File = { id: 'file' }; constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 }, ExtensionMode: { Test: 3 },
    Range: class { constructor(start, _s, end, _e) { this.start = { line: start }; this.end = { line: end }; } },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath }), from: o => ({ ...o, toString: () => o.scheme + '://' + o.authority + o.path }) },
    extensions: { getExtension: () => undefined }, env: { clipboard: { writeText: async text => calls.push(['clipboard', text]) } },
    workspace: { isTrusted: true, textDocuments, workspaceFolders: [{ uri: { fsPath: f.root } }],
      registerTextDocumentContentProvider: (_scheme, p) => { provider = p; return disposable(); }, onDidSaveTextDocument: fn => { saveDocument = fn; return disposable(); }, onDidChangeTextDocument: fn => { changeDocument = fn; return disposable(); }, onDidCloseTextDocument: disposable },
    window: {
      registerFileDecorationProvider: () => disposable(),
      createTreeView: (id, options) => { const result = { ...disposable(), options, visible: false, selection: [], reveal: async (...args) => calls.push(['reveal', ...args]), onDidChangeCheckboxState: fn => { checkbox = fn; return disposable(); }, onDidChangeVisibility: disposable }; if (id === 'codeReview.files') view = result; return result; },
      registerWebviewViewProvider: (_id, p) => { panel = p; return disposable(); },
      showQuickPick: async (items, options) => pick ? pick(items, options) : undefined,
      showInputBox: async () => undefined,
      showInformationMessage: () => suppress ? new Promise(() => {}) : Promise.resolve(),
      showErrorMessage: text => { errors.push(text); return suppress ? new Promise(() => {}) : Promise.resolve(); },
      showWarningMessage: async (...args) => { warnings.push(args); return confirmation; },
      showTextDocument: async (...args) => calls.push(['document', ...args]),
      onDidChangeActiveTextEditor: disposable,
      get activeTextEditor() { return editor; }
    },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); }, executeCommand: async (...args) => calls.push(args) }
  };
  const previous = Module._load; Module._load = function(id, ...args) { return id === 'vscode' ? mock : previous.call(this, id, ...args); };
  let activate; try { ({ activate } = require('../dist/extension')); } finally { Module._load = previous; }
  const context = { extensionPath: path.resolve(__dirname, '..'), extensionMode: 3, subscriptions: [], globalStorageUri: { fsPath: f.storage }, globalState: memory(), workspaceState: memory() };
  let app = activate(context); t.after(() => app.dispose()); await app.ready;
  assert.equal(app.tree.nodes.length, 0); assert.equal(view.message, undefined); assert.equal(commands.size, 21);
  let menus = 0;
  pick = items => { menus++; assert.equal(items.length, 2); assert.deepEqual(items.map(i => i.label), ['本地主分支 · main', '选择一个提交…']); return items[0]; };
  suppress = true;
  let timer;
  try {
    await Promise.race([Promise.all([commands.get('codeReview.handoff')(), commands.get('codeReview.configure')()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('通知阻塞命令队列')), 4000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(menus, 1); assert.equal(app.service.view.session.base, f.base);
  const baseItem = app.tree.getTreeItem(app.tree.nodes[0]);
  assert.match(baseItem.label, /对比起点/); assert.match(baseItem.description, /initial/);
  await commands.get('codeReview.copyBase')(app.tree.nodes[0]); assert.equal(calls.findLast(c => c[0] === 'clipboard')[1], f.base);
  const saved = app.service.view.session;
  pick = items => items.find(item => item.source?.ref === 'refs/heads/feature');
  await commands.get('codeReview.defaultBase')();
  assert.equal((await app.service.state.defaultBase()).ref, 'refs/heads/feature');
  assert.deepEqual(app.service.view.session, saved);
  pick = () => undefined; await commands.get('codeReview.configure')(); assert.deepEqual(app.service.view.session, saved);
  pick = (items, options) => options.title === '选择基点' ? items.find(i => i.chooseCommit) : items.find(i => i.oid === f.base);
  await commands.get('codeReview.configure')(); assert.equal(app.service.view.session.base, f.base);
  await f.write('src/a.txt', 'review target\n'); await commands.get('codeReview.refresh')();
  const folder = app.tree.nodes.find(n => n.kind === 'folder'), file = folder.children[0];
  await commands.get('codeReview.open')(file); const diff = calls.findLast(c => c[0] === 'vscode.diff');
  assert.equal(provider.provideTextDocumentContent(diff[1]), 'alpha\n');
  assert.equal(diff[2].scheme, 'file'); assert.equal(diff[2].fsPath, path.join(f.root, 'src/a.txt'));
  assert.equal(diff[4].preview, true);
  await commands.get('codeReview.open')(file); const reopened = calls.findLast(c => c[0] === 'vscode.diff');
  assert.equal(reopened[1].toString(), diff[1].toString()); assert.equal(reopened[2].toString(), diff[2].toString());
  assert.equal(view.options.showCollapseAll, false);
  await commands.get('codeReview.expandAll')(); assert.ok(calls.some(c => c[0] === 'reveal' && c[1].kind === 'folder' && c[2].expand === true));
  await commands.get('codeReview.collapseAll')(); assert.ok(calls.some(c => c[0] === 'workbench.actions.treeView.codeReview.files.collapseAll'));
  let buffer = 'review target\n'; const document = { uri: diff[2], isDirty: false, getText: () => buffer }; textDocuments.push(document);
  checkbox({ items: [[folder, 1]] }); await app.whenIdle(); assert.equal(app.service.view.files[0].status, 'reviewed');
  panel.resolveWebviewView({ show() {}, webview: { set options(value) { assert.deepEqual(value.localResourceRoots, []); }, set html(value) { html = value; }, onDidReceiveMessage: fn => { receive = fn; return disposable(); }, postMessage: async value => { posts.push(value); return true; } } });
  assert.match(html, /default-src 'none'/); receive({ action: 'ready' });
  const model = posts.at(-1);
  editor = { document, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 13 } } };
  await commands.get('codeReview.commentSelection')(); const anchored = posts.at(-1); assert.match(anchored.anchor, /工作区侧/);
  const requestId = require('node:crypto').randomUUID(); receive({ action: 'add', requestId, key: model.key, body: 'retain note' }); await app.whenIdle();
  assert.equal(app.service.view.notes.comments.length, 1); assert.deepEqual(app.service.view.notes.comments[0].anchor.selected, ['review target']);
  assert.ok(posts.some(p => p.type === 'ack' && p.requestId === requestId && !p.error));
  await commands.get('codeReview.handoff')(); const handoff = calls.findLast(call => call[0] === 'clipboard')[1];
  assert.ok(handoff.includes(JSON.stringify(f.root))); assert.ok(handoff.includes(JSON.stringify(app.service.comments.pendingFile(app.service.view.session))));
  buffer = 'edited in diff\n'; document.isDirty = true; changeDocument({ document });
  const dirtyFile = app.tree.nodes.find(n => n.kind === 'folder').children[0];
  assert.equal(app.tree.getTreeItem(dirtyFile).checkboxState, undefined);
  await commands.get('codeReview.mark')(dirtyFile); assert.match(errors.at(-1), /未保存/);
  await commands.get('codeReview.mark')(app.tree.nodes.find(n => n.kind === 'folder')); assert.match(errors.at(-1), /未保存/);
  await commands.get('codeReview.commentSelection')(); assert.match(errors.at(-1), /先保存/);
  assert.deepEqual(app.service.view.notes.comments[0].anchor.selected, ['review target']);
  await f.write('src/a.txt', buffer); document.isDirty = false; saveDocument(document); await app.whenIdle();
  assert.equal(app.service.view.files[0].status, 'changed');
  await commands.get('codeReview.commentSelection')(); const afterEdit = posts.at(-1);
  assert.equal(afterEdit.quote, 'edited in diff');
  receive({ action: 'add', requestId: require('node:crypto').randomUUID(), key: afterEdit.key, body: 'new source comment' }); await app.whenIdle();
  assert.equal(app.service.view.notes.comments.length, 2);
  assert.deepEqual(app.service.view.notes.comments.find(c => c.body === 'new source comment').anchor.selected, ['edited in diff']);
  await commands.get('codeReview.mark')(app.tree.nodes.find(n => n.kind === 'folder'));
  assert.equal(app.service.view.files[0].status, 'reviewed');
  const removable = app.service.view.notes.comments.find(c => c.body === 'new source comment');
  receive({ action: 'delete', requestId: require('node:crypto').randomUUID(), key: posts.findLast(p => p.type === 'render').key, id: removable.id, revision: removable.revision }); await app.whenIdle();
  assert.equal(app.service.view.notes.comments.length, 1); assert.equal(posts.findLast(p => p.type === 'render').deleted[0].id, removable.id);
  assert.equal(app.service.view.files[0].status, 'reviewed');
  receive({ action: 'restore', requestId: require('node:crypto').randomUUID(), key: posts.findLast(p => p.type === 'render').key, id: removable.id, revision: removable.revision }); await app.whenIdle();
  assert.equal(app.service.view.notes.comments.length, 2); assert.equal(posts.findLast(p => p.type === 'render').deleted.length, 0);
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'reviewed');
  app.dispose(); app = activate(context); await app.ready;
  assert.equal(app.service.view.session.base, f.base); assert.equal(app.service.view.files[0].status, 'reviewed'); assert.ok(app.service.view.notes.comments.some(c => c.body === 'retain note')); assert.equal(app.service.view.notes.comments.length, 2);
  await f.write('src/a.txt', 'changed\n'); await commands.get('codeReview.refresh')();
  const currentFile = app.tree.nodes.find(n => n.kind === 'folder').children[0]; await commands.get('codeReview.since')(currentFile);
  const incremental = calls.findLast(c => c[0] === 'vscode.diff'); assert.equal(provider.provideTextDocumentContent(incremental[1]), 'edited in diff\n'); assert.equal(provider.provideTextDocumentContent(incremental[2]), 'changed\n');
  assert.equal(incremental[2].scheme, 'code-review');
  await f.write('src/new_test.go', 'package src\n'); await f.write('src/raw.bin', Buffer.from([0, 1, 2]));
  await fs.symlink(path.join(f.root, 'src/a.txt'), path.join(f.root, 'src/link.txt'));
  await fs.chmod(path.join(f.root, 'src/b.txt'), 0o755);
  await commands.get('codeReview.refresh')();
  for (const name of ['src/raw.bin', 'src/link.txt', 'src/b.txt']) {
    await commands.get('codeReview.open')({ path: name });
    assert.equal(calls.findLast(c => c[0] === 'vscode.diff')[2].scheme, 'code-review', name);
  }
  const nodes = app.tree.nodes.find(n => n.kind === 'folder').children;
  const testItem = app.tree.getTreeItem(nodes.find(n => n.path === 'src/new_test.go'));
  assert.equal(testItem.iconPath.id, 'file'); assert.match(testItem.description, /测试/);
  const testDecoration = app.tree.provideFileDecoration(testItem.resourceUri);
  assert.equal(testDecoration.badge, 'T'); assert.equal(testDecoration.color.id, 'codeReview.addedForeground');
  const changedItem = app.tree.getTreeItem(nodes.find(n => n.path === 'src/a.txt'));
  assert.equal(app.tree.provideFileDecoration(changedItem.resourceUri).color.id, 'codeReview.changedForeground');
  await fs.unlink(path.join(f.root, 'src/b.txt')); await commands.get('codeReview.refresh')();
  await commands.get('codeReview.open')({ path: 'src/b.txt' });
  assert.equal(calls.findLast(c => c[0] === 'vscode.diff')[2].scheme, 'code-review');
  const deleted = app.tree.getTreeItem(app.tree.nodes.find(n => n.kind === 'folder').children.find(n => n.path === 'src/b.txt'));
  assert.equal(app.tree.provideFileDecoration(deleted.resourceUri).color.id, 'codeReview.deletedForeground');
  panel.resolveWebviewView({ show() {}, webview: { onDidReceiveMessage: fn => { receive = fn; return disposable(); }, postMessage: async value => { posts.push(value); return true; } } }); receive({ action: 'ready' });
  const beforeDirectory = app.service.view.files.map(file => [file.path, file.status]), diffCount = calls.filter(c => c[0] === 'vscode.diff').length;
  await commands.get('codeReview.commentDirectory')(app.tree.nodes.find(n => n.kind === 'folder'));
  let directoryModel = posts.findLast(p => p.type === 'render');
  assert.equal(directoryModel.target, 'directory'); assert.equal(directoryModel.file, 'src/'); assert.equal(directoryModel.anchor, undefined); assert.equal(directoryModel.cards.length, 0);
  assert.equal(calls.filter(c => c[0] === 'vscode.diff').length, diffCount);
  receive({ action: 'add', requestId: require('node:crypto').randomUUID(), key: directoryModel.key, body: 'directory design feedback' }); await app.whenIdle();
  directoryModel = posts.findLast(p => p.type === 'render'); assert.equal(directoryModel.cards.length, 1); assert.equal(directoryModel.cards[0].location, '目录评论');
  assert.equal(app.service.view.notes.comments.find(c => c.body === 'directory design feedback').target, 'directory');
  assert.deepEqual(app.service.view.files.map(file => [file.path, file.status]), beforeDirectory);
  receive({ action: 'selection', requestId: require('node:crypto').randomUUID(), key: directoryModel.key }); await app.whenIdle(); assert.match(errors.at(-1), /目录评论不绑定代码行/);
  assert.deepEqual(directoryModel.targets.map(target => [target.path, target.pending]), [['src/a.txt', 2]]);
  receive({ action: 'openTarget', requestId: require('node:crypto').randomUUID(), key: directoryModel.key, path: 'src/a.txt' }); await app.whenIdle();
  assert.equal(posts.findLast(p => p.type === 'render').file, 'src/a.txt');
  assert.equal(calls.findLast(c => c[0] === 'reveal')[1].path, 'src/a.txt');
  assert.equal(calls.findLast(c => c[0] === 'reveal')[2].select, true);
  assert.equal(calls.findLast(c => c[0] === 'reveal')[2].focus, true, 'move tree focus with selection so the old row is not highlighted');
  await commands.get('codeReview.commentDirectory')(app.tree.findTarget('src', 'directory'));
  receive({ action: 'openTarget', requestId: require('node:crypto').randomUUID(), key: directoryModel.key, path: 'src/../outside.txt' }); await app.whenIdle();
  assert.match(errors.at(-1), /评论位置已变化/);
  const documentCount = calls.filter(c => c[0] === 'document').length;
  await commands.get('codeReview.pending')();
  let overviewModel = posts.findLast(p => p.type === 'render');
  assert.equal(overviewModel.overview, true); assert.equal(overviewModel.cards.length, 3);
  assert.equal(calls.filter(c => c[0] === 'document').length, documentCount, 'pending comments do not open Markdown');
  assert.ok(overviewModel.cards.some(c => c.targetLabel === 'src/'));
  const overviewKey = overviewModel.key, editable = overviewModel.cards.find(c => c.body === 'directory design feedback');
  receive({ action: 'edit', requestId: require('node:crypto').randomUUID(), key: overviewKey, id: editable.id, revision: editable.revision, body: 'edited in overview' }); await app.whenIdle();
  overviewModel = posts.findLast(p => p.type === 'render');
  const revised = overviewModel.cards.find(c => c.id === editable.id); assert.equal(revised.body, 'edited in overview');
  assert.equal(overviewModel.cards.length, 3, 'editing does not create a new comment');
  receive({ action: 'resolve', requestId: require('node:crypto').randomUUID(), key: overviewKey, id: revised.id, revision: revised.revision }); await app.whenIdle();
  assert.equal(posts.findLast(p => p.type === 'render').cards.length, 2);
  assert.equal(app.service.view.notes.comments.find(c => c.id === revised.id).state, 'resolved');
  const toDelete = posts.findLast(p => p.type === 'render').cards.find(c => c.body === 'new source comment');
  receive({ action: 'delete', requestId: require('node:crypto').randomUUID(), key: overviewKey, id: toDelete.id, revision: toDelete.revision }); await app.whenIdle();
  assert.equal(posts.findLast(p => p.type === 'render').cards.length, 1);
  const jump = posts.findLast(p => p.type === 'render').cards[0];
  receive({ action: 'openTarget', requestId: require('node:crypto').randomUUID(), key: overviewKey, id: jump.id }); await app.whenIdle();
  assert.equal(posts.findLast(p => p.type === 'render').file, 'src/a.txt'); assert.equal(posts.findLast(p => p.type === 'render').overview, false);
  receive({ action: 'delete', requestId: require('node:crypto').randomUUID(), key: overviewKey, id: jump.id, revision: jump.revision }); await app.whenIdle();
  assert.match(errors.at(-1), /评论对象已切换/); assert.ok(app.service.view.notes.comments.some(c => c.id === jump.id));
  await commands.get('codeReview.open')({ path: 'src/a.txt' });
  assert.ok(posts.findLast(p => p.type === 'render').cards.every(c => c.body !== 'directory design feedback'));
  const oldSession = app.service.view.session, oldModel = posts.findLast(p => p.type === 'render'), oldComment = app.service.view.notes.comments[0];
  assert.equal(app.history.nodes.length, 1);
  const recordItem = app.history.getTreeItem(app.history.nodes[0]);
  assert.match(recordItem.label, /feature/); assert.match(recordItem.description, /当前/); assert.equal(recordItem.contextValue, 'savedReview');
  f.git('switch', '-qc', 'other');
  receive({ action: 'resolve', requestId: require('node:crypto').randomUUID(), key: overviewKey, id: jump.id, revision: jump.revision }); await app.whenIdle();
  assert.match(errors.at(-1), /评论对象已切换/);
  for (const action of ['edit', 'delete', 'resolve']) {
    receive({ action, requestId: require('node:crypto').randomUUID(), key: oldModel.key, id: oldComment.id, revision: oldComment.revision, body: 'must not save' }); await app.whenIdle();
    assert.match(errors.at(-1), /分支或 CR 已改变/);
  }
  assert.deepEqual((await app.service.comments.load()).comments.find(c => c.id === oldComment.id), oldComment);
  await commands.get('codeReview.refresh')(); assert.equal(app.service.view.session, undefined); assert.equal(posts.findLast(p => p.type === 'render').cards.length, 0);
  await commands.get('codeReview.openReview')(app.history.nodes[0]); assert.match(errors.at(-1), /先切换到分支/);
  assert.equal(f.git('branch', '--show-current'), 'other');
  f.git('switch', '-q', 'feature'); await commands.get('codeReview.refresh')(); assert.equal(app.service.view.session.id, oldSession.id);
  await commands.get('codeReview.deleteReview')(app.history.nodes[0]); assert.equal(app.service.view.session, undefined);
  const trash = app.history.nodes[0]; assert.equal(trash.id, 'deleted');
  const deletedReview = trash.children[0]; assert.equal(app.history.getTreeItem(deletedReview).contextValue, 'deletedReview');
  await commands.get('codeReview.restoreReview')(deletedReview); assert.equal(app.service.view.session, undefined);
  await commands.get('codeReview.openReview')(app.history.nodes[0]); assert.equal(app.service.view.session.id, oldSession.id);
  assert.ok(app.service.view.notes.comments.some(c => c.id === oldComment.id));
  const changes = []; provider.onDidChange(uri => changes.push(uri.toString()));
  await f.write('src/a.txt', 'first incremental edit\n'); await commands.get('codeReview.refresh')();
  await commands.get('codeReview.since')({ path: 'src/a.txt' }); const firstIncremental = calls.findLast(c => c[0] === 'vscode.diff');
  assert.equal(provider.provideTextDocumentContent(firstIncremental[2]), 'first incremental edit\n');
  await f.write('src/a.txt', 'second incremental edit\n'); await commands.get('codeReview.since')({ path: 'src/a.txt' });
  const secondIncremental = calls.findLast(c => c[0] === 'vscode.diff');
  assert.equal(secondIncremental[1].toString(), firstIncremental[1].toString());
  assert.equal(secondIncremental[2].toString(), firstIncremental[2].toString());
  assert.equal(provider.provideTextDocumentContent(firstIncremental[2]), 'second incremental edit\n');
  assert.ok(changes.includes(firstIncremental[2].toString()));
  await commands.get('codeReview.open')({ path: 'src/a.txt' });
  assert.notEqual(calls.findLast(c => c[0] === 'vscode.diff')[1].toString(), firstIncremental[1].toString());
  const manifest = JSON.parse(await fs.readFile(path.join(context.extensionPath, 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.menus['scm/historyItem/context'][0].command, 'codeReview.fromCommit');
  const currentId = app.service.view.session.id;
  await commands.get('codeReview.fromCommit')({ id: 'git', rootUri: mock.Uri.file(f.root) }, { id: 'scm-graph-incoming-changes' });
  assert.equal(app.service.view.session.id, currentId); assert.match(errors.at(-1), /真实提交/);
  await commands.get('codeReview.fromCommit')(undefined, undefined); assert.equal(app.service.view.session.id, currentId);
  const other = await fixture(t, { 'second.txt': 'different repo\n' });
  await commands.get('codeReview.fromCommit')({ id: 'git', rootUri: mock.Uri.file(other.root) }, { id: other.base });
  assert.equal(app.service.repo.root, f.root); assert.match(errors.at(-1), /不在当前工作区/);
  mock.workspace.workspaceFolders.push({ uri: mock.Uri.file(other.root) });
  await commands.get('codeReview.fromCommit')({ id: 'git', rootUri: { scheme: 'vscode-remote', fsPath: other.root } }, { id: other.base });
  assert.equal(app.service.repo.root, other.root); assert.equal(app.service.view.session.base, other.base);
  assert.equal(context.workspaceState.get('selectedRepository'), other.root); assert.equal(other.git('branch', '--show-current'), 'feature');
  assert.ok(calls.some(c => c[0] === 'codeReview.files.focus'));
  await commands.get('codeReview.fromCommit')({ id: 'git', rootUri: mock.Uri.file(f.root) }, { id: f.base });
  assert.equal(app.service.repo.root, f.root); assert.equal(app.service.view.session.id, oldSession.id);
  assert.ok(app.service.view.notes.comments.some(c => c.id === oldComment.id));
  app.history.render({ ...app.service.view, session: undefined, sessions: [{ ...oldSession, deletedAt: '2026-11-02' }], purgePending: [oldSession.id] });
  const unfinished = app.history.nodes.find(n => n.id === 'purge-pending');
  assert.match(app.history.getTreeItem(unfinished).label, /删除未完成/);
  assert.equal(app.history.getTreeItem(unfinished.children[0]).contextValue, 'purgePendingReview');
  await f.write('uncommented/nested/example.txt', 'only a file change, no directory comment');
  await commands.get('codeReview.refresh')();
  const doomed = app.history.nodes.find(n => n.review?.id === oldSession.id);
  await commands.get('codeReview.purgeReview')(doomed);
  assert.equal(app.service.view.session.id, oldSession.id); assert.equal(warnings.at(-1)[1].modal, true);
  assert.ok(warnings.at(-1)[1].detail.includes(oldSession.base));
  confirmation = '永久删除'; await commands.get('codeReview.purgeReview')(doomed);
  assert.ok(!app.service.view.sessions.some(s => s.id === oldSession.id));
  assert.equal(app.service.view.session, undefined);
  assert.ok(context.workspaceState.get('discardedReviewDrafts').length > 0);
  const { hash } = require('../dist/model');
  for (const directory of ['uncommented', 'uncommented/nested']) {
    assert.ok(context.workspaceState.get('discardedReviewDrafts').includes(hash(f.root + '\0' + oldSession.id + '\0directory\0' + directory)));
  }
  assert.equal((await app.service.comments.load()).comments.length, 0);
  await assert.rejects(fs.stat(app.service.state.location(oldSession)), { code: 'ENOENT' });
});
