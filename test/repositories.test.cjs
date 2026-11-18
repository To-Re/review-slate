const { test } = require('node:test'), assert = require('node:assert/strict');
const Module = require('node:module'), path = require('node:path');
const { fixture } = require('./fixtures.cjs');

const disposable = () => ({ dispose() {} });
class Emitter { listeners = []; event = fn => { this.listeners.push(fn); return disposable(); }; fire(value) { this.listeners.forEach(fn => fn(value)); } dispose() {} }
function load(mock) {
  for (const file of ['extension', 'tree', 'history', 'settings', 'panel', 'commit-picker']) delete require.cache[require.resolve('../dist/' + file)];
  const previous = Module._load;
  Module._load = function (id, ...args) { return id === 'vscode' ? mock : previous.call(this, id, ...args); };
  try { return require('../dist/extension'); } finally { Module._load = previous; }
}
async function host(t, storage, folders) {
  const commands = new Map(), errors = [], folderChange = new Emitter(), opened = new Emitter(), closed = new Emitter();
  const git = { repositories: [], onDidOpenRepository: opened.event, onDidCloseRepository: closed.event };
  const memory = () => { const map = new Map(); return { get: key => map.get(key), update: async (key, value) => { map.set(key, value); } }; };
  const mock = {
    EventEmitter: Emitter, ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { static File = {}; constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath }), from: value => ({ ...value, toString: () => value.scheme + '://' + value.authority + value.path }) },
    Range: class {}, ExtensionMode: { Test: 3 },
    extensions: { getExtension: id => id === 'vscode.git' ? { activate: async () => ({ getAPI: () => git }) } : undefined },
    workspace: { isTrusted: true, textDocuments: [], workspaceFolders: folders.map(root => ({ uri: { fsPath: root } })), onDidChangeWorkspaceFolders: folderChange.event,
      registerTextDocumentContentProvider: disposable, onDidSaveTextDocument: disposable, onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable },
    window: {
      createTreeView: () => ({ ...disposable(), visible: false, selection: [], onDidChangeVisibility: disposable, onDidChangeCheckboxState: disposable, reveal: async () => {} }),
      registerFileDecorationProvider: disposable, registerWebviewViewProvider: disposable, onDidChangeActiveTextEditor: disposable,
      showErrorMessage: async text => { errors.push(text); }, showInformationMessage: async () => {}, showQuickPick: async () => undefined
    },
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return disposable(); }, executeCommand: async () => {} }
  };
  const { ReviewExtension } = load(mock);
  const context = { extensionPath: path.resolve(__dirname, '..'), globalStorageUri: { fsPath: storage }, workspaceState: memory(), globalState: memory() };
  const app = new ReviewExtension(context); t.after(() => app.dispose()); await app.ready; await app.whenIdle();
  const group = root => app.history.nodes.find(node => node.repository?.root === root);
  return { app, mock, git, commands, errors, group, folderChange, opened, closed };
}

test('工作区新增仓库、Git 扩展后续发现的仓库都会加入分组；移除后退出分组', async t => {
  const a = await fixture(t), b = await fixture(t, { 'b.txt': 'second\n' }), c = await fixture(t, { 'c.txt': 'nested\n' });
  await a.choose();
  const { ReviewService } = require('../dist/review');
  const bService = new ReviewService(b.repo, a.storage); await bService.start(); await bService.choose(b.base, '指定提交');
  const h = await host(t, a.storage, [a.root]);
  assert.equal(h.app.history.nodes.length, 1); assert.equal(h.app.history.nodes[0].review.id, a.service.view.session.id, 'single repository stays flat');

  h.mock.workspace.workspaceFolders.push({ uri: { fsPath: b.root } }); h.folderChange.fire({}); await h.app.whenIdle();
  assert.equal(h.app.service.repo.root, a.root);
  assert.deepEqual(h.group(b.root).children.map(node => node.review.id), [bService.view.session.id]);
  assert.equal(h.app.history.getTreeItem(h.group(b.root)).description.split(' · ')[0], 'feature');

  h.git.repositories.push({ rootUri: { fsPath: c.root } }); h.opened.fire({}); await h.app.whenIdle();
  assert.ok(h.group(c.root), 'repository discovered by the Git extension later');
  assert.match(h.app.history.getTreeItem(h.group(c.root)).description, /暂无审阅/);

  await h.commands.get('codeReview.openReview')(h.group(b.root).children[0]); await h.app.whenIdle();
  assert.equal(h.app.service.repo.root, b.root);
  h.mock.workspace.workspaceFolders.splice(1, 1); h.folderChange.fire({}); await h.app.whenIdle();
  assert.equal(h.group(b.root), undefined);
  assert.equal(h.app.service.repo.root, a.root, 'removing the current repository falls back to a remaining one');
  h.git.repositories.length = 0; h.closed.fire({}); await h.app.whenIdle();
  assert.equal(h.app.history.nodes.length, 1); assert.equal(h.app.history.nodes[0].repository, undefined);
});

test('其他仓库当前 CR 损坏时，仍可直接打开它的另一条 CR；失败的点击不扫描文件', async t => {
  const a = await fixture(t), b = await fixture(t, { 'b.txt': 'second\n' });
  await a.choose();
  const { ReviewService } = require('../dist/review');
  const fs = require('node:fs/promises');
  const bService = new ReviewService(b.repo, a.storage); await bService.start();
  await bService.choose(b.base, '指定提交'); const healthy = bService.view.session;
  await b.write('b.txt', 'changed\n'); b.git('commit', '-qam', 'feature work');
  await b.write('b.txt', 'working tree\n');
  await bService.choose('HEAD', '最新提交'); const broken = bService.view.session;
  assert.notEqual(healthy.id, broken.id);
  const row = bService.view.files.find(file => file.path === 'b.txt');
  await bService.mark({ session: broken.id, files: [{ path: row.path, fingerprint: row.fingerprint, checked: true }] });
  await assert.rejects(new ReviewService(b.repo, a.storage).start().then(() => fs.writeFile(path.join(bService.state.location(broken), 'state.json'), 'invalid'))
    .then(() => new ReviewService(b.repo, a.storage).start()), 'the checked-out CR of the other repository is broken');
  const h = await host(t, a.storage, [a.root, b.root]);
  const record = h.group(b.root).children.find(node => node.review.id === healthy.id);
  let scans = 0; const scan = require('../dist/git').GitRepository.prototype.scan;
  require('../dist/git').GitRepository.prototype.scan = async function (...args) { scans++; return scan.apply(this, args); };
  t.after(() => { require('../dist/git').GitRepository.prototype.scan = scan; });
  await h.commands.get('codeReview.openReview')(record); await h.app.whenIdle();
  assert.equal(h.errors.length, 0, h.errors.join('\n'));
  assert.equal(h.app.service.repo.root, b.root); assert.equal(h.app.service.view.session.id, healthy.id);
  assert.equal(scans, 1, 'only the clicked CR is scanned');
  await h.commands.get('codeReview.openReview')(h.group(a.root).children.find(node => node.review?.id === a.service.view.session.id));
  b.git('switch', '-qc', 'hotfix'); scans = 0;
  await h.commands.get('codeReview.openReview')(h.group(b.root).children.find(node => node.review.id === healthy.id));
  assert.match(h.errors.at(-1), /请先切换到分支 feature/); assert.equal(h.app.service.repo.root, a.root);
  assert.equal(scans, 0, 'a rejected click does not scan the other repository');
});

test('其他仓库只在审阅记录可见时周期读取，至少间隔 15 秒；内容没变不刷新树；旧节点不能在回退后操作新仓库', async t => {
  const a = await fixture(t), b = await fixture(t, { 'b.txt': 'second\n' });
  await a.choose();
  const h = await host(t, a.storage, [a.root, b.root]);
  let reads = 0, renders = 0;
  const read = h.app.readRepositoryReviews.bind(h.app), render = h.app.renderHistory.bind(h.app);
  h.app.readRepositoryReviews = async (...args) => { reads++; return read(...args); };
  h.app.renderHistory = () => { renders++; render(); };
  h.app.loadOtherReviews(); await h.app.whenIdle();
  assert.equal(reads, 0, 'hidden history list is not polled');
  h.app.historyView.visible = true; h.app.reviewsReadAt = 0;
  h.app.loadOtherReviews(); await h.app.whenIdle(); assert.equal(reads, 1);
  assert.equal(renders, 0, 'unchanged summaries do not refresh the tree');
  h.app.loadOtherReviews(); await h.app.whenIdle(); assert.equal(reads, 1, 'periodic reads wait 15 seconds');
  await h.commands.get('codeReview.refresh')(); await h.app.whenIdle(); assert.equal(reads, 2, 'an explicit refresh reads at once');

  // A flat-list node from a repository that left the workspace cannot archive a CR in the fallback repository.
  const flat = await host(t, a.storage, [a.root]);
  const stale = flat.app.history.nodes.find(node => node.review);
  assert.equal(stale.root, a.root);
  flat.app.history.render(flat.app.service.view, b.root, []);
  const foreign = { ...stale, root: b.root };
  await flat.commands.get('codeReview.deleteReview')(foreign);
  assert.match(flat.errors.at(-1), /仓库已切换|已不在当前工作区/);
  assert.ok(!(await flat.app.service.state.sessions()).find(session => session.id === stale.review.id).deletedAt);
});

test('其他仓库的 CR 不在其检出分支时不切换仓库，错误带仓库名；当前仓库不受影响', async t => {
  const a = await fixture(t), b = await fixture(t, { 'b.txt': 'second\n' });
  await a.choose();
  const { ReviewService } = require('../dist/review');
  const bService = new ReviewService(b.repo, a.storage); await bService.start(); await bService.choose(b.base, '指定提交');
  b.git('switch', '-qc', 'hotfix');
  const h = await host(t, a.storage, [a.root, b.root]);
  const record = h.group(b.root).children[0];
  assert.match(h.app.history.getTreeItem(record).tooltip, /当前在 hotfix，需先切换到 feature/);
  await h.commands.get('codeReview.openReview')(record);
  assert.match(h.errors.at(-1), new RegExp('^ReviewSlate：' + path.basename(b.root) + '：请先切换到分支 feature'));
  assert.equal(h.app.service.repo.root, a.root); assert.equal(h.app.service.view.session.id, a.service.view.session.id);
  assert.equal(b.git('branch', '--show-current'), 'hotfix', 'Git branch is never switched');
});
