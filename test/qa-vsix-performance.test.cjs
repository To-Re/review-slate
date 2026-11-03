const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

// This is a simulated VS Code host with real Git and disk I/O. It never opens
// an editor. The optional benchmark ends at the vscode.diff API boundary.
const project = path.resolve(__dirname, '..');
const dist = path.resolve(project, process.env.QA_PERF_DIST || 'dist');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const disposable = () => ({ dispose() {} });
const memory = () => { const map = new Map(); return { get: key => map.get(key), update: async (key, value) => map.set(key, value) }; };
let activeHost, observed;
const originals = { execFile: cp.execFile, spawn: cp.spawn };
for (const method of Object.keys(originals)) cp[method] = function (file, args, ...rest) {
  if (file === 'git' && observed) {
    observed.gitProcesses++;
    const operation = args.find(value => ['rev-parse', 'for-each-ref', 'merge-base', 'log', 'ls-tree', 'ls-files', 'cat-file'].includes(value));
    observed.gitOperations[operation || 'other'] = (observed.gitOperations[operation || 'other'] || 0) + 1;
  }
  return originals[method].call(this, file, args, ...rest);
};
class Emitter { listeners = []; event = fn => { this.listeners.push(fn); return disposable(); }; fire(value) { this.listeners.forEach(fn => fn(value)); } dispose() {} }
const mock = {
  EventEmitter: Emitter,
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  ThemeIcon: class { static File = { id: 'file' }; constructor(id) { this.id = id; } }, ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 }, ExtensionMode: { Test: 3 },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath }), from: value => ({ ...value, toString: () => value.scheme + '://' + value.authority + value.path }) },
  extensions: { getExtension: () => undefined }, env: { clipboard: { writeText: async () => {} } },
  workspace: {
    isTrusted: true, get textDocuments() { return activeHost.documents; }, get workspaceFolders() { return [{ uri: { fsPath: activeHost.root } }]; },
    registerTextDocumentContentProvider: (_scheme, provider) => { activeHost.provider = provider; return disposable(); },
    onDidSaveTextDocument: fn => { activeHost.save = fn; return disposable(); }, onDidChangeTextDocument: fn => { activeHost.change = fn; return disposable(); }, onDidCloseTextDocument: disposable
  },
  window: {
    registerFileDecorationProvider: disposable, registerWebviewViewProvider: (_id, panel) => { activeHost.panel = panel; return disposable(); },
    createTreeView: () => ({ ...disposable(), visible: false, selection: [], reveal: async () => {}, onDidChangeCheckboxState: disposable, onDidChangeVisibility: disposable }),
    showQuickPick: async items => items[0], showInputBox: async () => undefined,
    showInformationMessage: async () => {}, showWarningMessage: async () => undefined,
    showErrorMessage: async text => { activeHost.errors.push(text); }, onDidChangeActiveTextEditor: disposable,
    get activeTextEditor() { return undefined; }
  },
  commands: {
    registerCommand: (id, handler) => { activeHost.commands.set(id, handler); return disposable(); },
    executeCommand: async (...args) => {
      if (args[0] === 'vscode.diff') {
        if (observed) observed.diffAt = performance.now();
        activeHost.diffs.push(args);
      }
    }
  }
};
const previous = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? mock : previous.call(this, id, ...args); };
let ReviewExtension;
try { ({ ReviewExtension } = require(path.join(dist, 'extension'))); } finally { Module._load = previous; }

async function fixture(t, count = 3, changed = count) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewslate-qa-'));
  await fs.mkdir(path.join(temp, 'repo'));
  const root = await fs.realpath(path.join(temp, 'repo'));
  const git = (...args) => cp.execFileSync('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  const write = async (name, data) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), data); };
  const names = Array.from({ length: count }, (_, i) => `group-${Math.floor(i / 40)}/file-${String(i).padStart(4, '0')}.txt`);
  git('init', '-q', '-b', 'main'); await write('.gitignore', '/.code-review/\n');
  for (let i = 0; i < names.length; i++) await write(names[i], `base ${i}\n` + 'x'.repeat(2048));
  git('add', '-A'); git('commit', '-qm', 'synthetic base'); const base = git('rev-parse', 'HEAD'); git('switch', '-qc', 'feature');
  for (let i = 0; i < changed; i++) await write(names[i], `changed ${i}\n` + 'y'.repeat(2048));
  const host = { root, names, base, git, write, errors: [], diffs: [], documents: [], commands: new Map() };
  activeHost = host;
  const context = { extensionPath: project, extensionMode: 3, subscriptions: [], globalStorageUri: { fsPath: path.join(temp, 'storage') }, globalState: memory(), workspaceState: memory() };
  const app = new ReviewExtension(context); host.app = app;
  t.after(async () => { app.dispose(); await app.whenIdle(); await fs.rm(temp, { recursive: true, force: true }); });
  await app.ready;
  const originalScan = app.service.repo.scan.bind(app.service.repo);
  app.service.repo.scan = async (...args) => {
    if (observed) observed.scans++;
    if (host.scanStarted) { const notify = host.scanStarted; host.scanStarted = undefined; notify(); }
    return originalScan(...args);
  };
  const originalOpen = app.open.bind(app);
  app.open = async (...args) => { if (observed) observed.handlerAt = performance.now(); return originalOpen(...args); };
  host.command = (name, node) => host.commands.get('codeReview.' + name)(node);
  host.file = (name = names[0]) => app.tree.findTarget(name, 'file');
  return host;
}

async function measure(host, action) {
  const metric = { gitProcesses: 0, gitOperations: {}, scans: 0 };
  observed = metric; const started = performance.now();
  try { await action(); await host.app.whenIdle(); }
  finally { observed = undefined; }
  metric.totalMs = performance.now() - started;
  if (metric.handlerAt !== undefined) metric.queueWaitMs = metric.handlerAt - started;
  if (metric.diffAt !== undefined) {
    metric.toDiffRequestMs = metric.diffAt - started;
    metric.handlerToDiffRequestMs = metric.diffAt - metric.handlerAt;
  }
  delete metric.handlerAt; delete metric.diffAt;
  assert.deepEqual(host.errors, []);
  return metric;
}

test('QA：Diff 直接点击读取当前磁盘，陈旧内容、分支和目录成员不能被误标已审', async t => {
  const h = await fixture(t); await h.command('configure');
  const oldNode = h.file();
  await h.write(h.names[0], 'new disk version\n');
  await h.command('open', oldNode);
  assert.equal(h.app.selected.pair.right.data.toString(), 'new disk version\n');
  await h.command('mark', oldNode); assert.match(h.errors.pop(), /变化|失败/);
  assert.notEqual(h.app.service.view.files.find(f => f.path === h.names[0]).status, 'reviewed');
  await h.command('refresh');
  const folder = h.app.tree.findTarget('group-0', 'directory');
  await h.write('group-0/new.txt', 'new unseen member\n');
  await h.command('mark', folder); assert.match(h.errors.pop(), /目录文件列表已变化/);
  assert.ok(h.app.service.view.files.every(f => f.status !== 'reviewed'));
  const stale = h.file(); h.git('switch', '-qc', 'other');
  const count = h.diffs.length;
  await h.command('open', stale); assert.equal(h.diffs.length, count); assert.ok(h.errors.pop());
  await h.command('mark', stale); assert.ok(h.errors.pop());
  assert.deepEqual(h.errors, []);
});

test('QA：连续保存后打开 Diff，最终内容和未保存保护保持正确', async t => {
  const h = await fixture(t); await h.command('configure');
  await h.command('mark', h.file()); assert.equal(h.app.service.view.files[0].status, 'reviewed');
  await h.write(h.names[0], 'saved newest\n');
  const document = { uri: mock.Uri.file(path.join(h.root, h.names[0])), isDirty: false };
  for (let i = 0; i < 8; i++) h.save(document);
  await h.command('open', h.file()); await h.app.whenIdle();
  assert.equal(h.app.selected.pair.right.data.toString(), 'saved newest\n');
  assert.equal(h.app.service.view.files.find(f => f.path === h.names[0]).status, 'changed');
  document.isDirty = true; h.documents.push(document); h.change({ document });
  await h.command('mark', h.file()); assert.match(h.errors.pop(), /未保存/);
  assert.equal(h.app.service.view.files.find(f => f.path === h.names[0]).status, 'changed');
  assert.deepEqual(h.errors, []);
});

test('QA：80 MiB 全仓预算拒绝后保留原进度，移除超限输入可恢复', async t => {
  const h = await fixture(t, 1); await h.command('configure'); await h.command('mark', h.file());
  const session = h.app.service.view.session.id;
  const chunk = Buffer.alloc(5 * 1024 * 1024, 65);
  for (let i = 0; i < 17; i++) await h.write(`large/part-${i}.txt`, chunk);
  await h.command('refresh'); assert.match(h.errors.pop(), /80 MiB/);
  assert.equal(h.app.service.view.session.id, session);
  assert.match(h.app.service.view.error, /80 MiB/);
  await fs.rm(path.join(h.root, 'large'), { recursive: true });
  await h.command('refresh'); assert.equal(h.app.service.view.error, undefined);
  assert.equal(h.app.service.view.files[0].status, 'reviewed');
  assert.equal(h.app.service.view.session.id, session); assert.deepEqual(h.errors, []);
});

test('QA：慢文件点击不会抢回随后点击的文件或待处理概览', async t => {
  const h = await fixture(t); await h.command('configure');
  const posts = []; let receive;
  h.panel.resolveWebviewView({ show() {}, webview: {
    onDidReceiveMessage: handler => { receive = handler; return disposable(); },
    postMessage: async message => { posts.push(message); return true; }
  } });
  receive({ action: 'ready' }); await h.app.whenIdle();
  const original = h.app.service.repo.editablePath.bind(h.app.service.repo);
  async function delayedOpen(nextAction) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    let hold = true;
    h.app.service.repo.editablePath = async (...args) => {
      if (hold && args[0] === h.names[0]) { hold = false; entered(); await paused; }
      return original(...args);
    };
    const pending = h.command('open', h.file()); await started;
    const next = nextAction();
    // Releasing from a timer also lets the serial baseline finish, while the
    // concurrent implementation can complete the newer request first.
    const timer = setTimeout(release, 150);
    try { await Promise.all([pending, next]); await h.app.whenIdle(); }
    finally { clearTimeout(timer); release(); h.app.service.repo.editablePath = original; }
  }
  await delayedOpen(() => h.command('open', h.file(h.names[1])));
  assert.equal(h.app.selected.file, h.names[1]);
  assert.match(h.diffs.at(-1)[3], new RegExp(h.names[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  assert.equal(posts.findLast(message => message.type === 'render').file, h.names[1]);
  await delayedOpen(() => h.command('commentDirectory', h.app.tree.findTarget('group-0', 'directory')));
  assert.equal(h.app.selected.target, 'directory');
  assert.equal(posts.findLast(message => message.type === 'render').file, 'group-0/');
  await delayedOpen(() => h.command('pending'));
  assert.equal(h.app.selected, undefined);
  assert.equal(h.app.overview, h.app.pendingKey());
  assert.equal(posts.findLast(message => message.type === 'render').overview, true);
  await delayedOpen(() => { receive({ action: 'pending', requestId: 'qa-navigation-pending' }); return h.app.whenIdle(); });
  assert.equal(h.app.selected, undefined);
  assert.equal(posts.findLast(message => message.type === 'render').overview, true);
  assert.deepEqual(h.errors, []);
});

test('QA 性能采样：选择基点到树、空闲及刷新期间点击、标记与保存突发', { skip: !process.env.RUN_VSIX_BENCHMARK }, async t => {
  const samples = [], count = Number(process.env.QA_PERF_FILES || 800), changed = Number(process.env.QA_PERF_CHANGED || count), rounds = Number(process.env.QA_PERF_ROUNDS || 3);
  assert.ok(Number.isSafeInteger(count) && count >= 2 && Number.isSafeInteger(changed) && changed >= 2 && changed <= count);
  for (let round = 0; round < rounds; round++) {
    const h = await fixture(t, count, changed);
    const row = { round: round + 1 };
    row.chooseToTree = await measure(h, () => h.command('configure'));
    assert.equal(h.app.service.view.files.length, changed); assert.ok(h.file());
    row.idleOpen = await measure(h, () => h.command('open', h.file()));
    assert.equal(h.diffs.length, 1);
    row.switchOpen = await measure(h, () => h.command('open', h.file(h.names[1])));
    row.refresh = await measure(h, () => h.command('refresh'));
    const started = new Promise(resolve => { h.scanStarted = resolve; });
    h.save({ uri: mock.Uri.file(path.join(h.root, h.names[0])) });
    await started;
    row.openDuringRefresh = await measure(h, () => h.command('open', h.file()));
    if (!process.env.QA_PERF_PRIMARY_ONLY) {
      row.singleMark = await measure(h, () => h.command('mark', h.file()));
      assert.equal(h.app.service.view.files.find(f => f.path === h.names[0]).status, 'reviewed');
      row.directoryMark = await measure(h, () => h.command('mark', h.app.tree.findTarget('group-0', 'directory')));
      const document = { uri: mock.Uri.file(path.join(h.root, h.names[0])) };
      row.saveBurst = await measure(h, async () => { for (let i = 0; i < 8; i++) h.save(document); });
    }
    samples.push(row); h.app.dispose();
    console.log('QA performance round ' + (round + 1) + ': ' + JSON.stringify(row));
  }
  const fingerprints = {};
  for (const file of ['extension.js', 'git.js', 'review.js']) fingerprints[file] = createHash('sha256').update(await fs.readFile(path.join(dist, file))).digest('hex');
  const report = { date: new Date().toISOString(), label: process.env.QA_PERF_LABEL || 'working-tree', environment: { platform: os.platform(), architecture: os.arch(), node: process.version, git: cp.execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() }, workload: { files: count, changedFiles: changed, approximateBytesPerSide: 2058, rounds, folderFiles: 40, primaryOnly: !!process.env.QA_PERF_PRIMARY_ONLY }, boundary: 'Real Git and disk; simulated VS Code; toDiffRequest excludes native editor rendering. openDuringRefresh starts after scan enters; its Git count covers only the remaining background work plus open.', fingerprints, samples };
  const output = process.env.QA_PERF_OUTPUT || 'artifacts/vsix-performance/candidate.json';
  await fs.mkdir(path.dirname(path.resolve(project, output)), { recursive: true }); await fs.writeFile(path.resolve(project, output), JSON.stringify(report, null, 2) + '\n');
});
