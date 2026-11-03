'use strict';
// Independent performance/correctness regression: synthetic Git and public controller.
// Counts scans rather than setting machine-dependent duration thresholds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const runtime = process.env.REVIEW_SLATE_QA_DIST || path.resolve(__dirname, '../../dist');
const { CodexController } = require(path.join(runtime, 'codex/controller'));
const reads = new Set(['refresh', 'diff', 'bases', 'inspectReview', 'operation']);
const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Synthetic QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
const file = n => `idl/synthetic/service_${String(n).padStart(4, '0')}.thrift`;
const code = (n, value) => `namespace go synthetic.service${n}\nstruct Value${n} {\n  1: string ${value};\n}\n`;
const nav = { target: { type: 'file', path: file(0) }, expanded: ['idl', 'idl/synthetic'], mode: 'full', side: 'right', line: 1, commentsMode: 'target', filter: '' };

async function fixture(t, count = 96, changes = 48) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewslate-performance-qa-'));
  const root = path.join(await fs.realpath(temp), 'synthetic-repo'), dataRoot = path.join(temp, 'data'), controllers = [];
  await fs.mkdir(root);
  t.after(async () => { for (const c of controllers) await c.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const write = async (name, bytes) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), bytes); };
  const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'gc.auto', '0'); git('config', 'maintenance.auto', 'false'); await write('.gitignore', '/.reviewslate/codex/\n');
  for (let n = 0; n < count; n++) await write(file(n), code(n, 'baseline'));
  git('add', '-A'); git('commit', '-qm', 'Synthetic baseline'); const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'feature/performance');
  for (let n = 0; n < changes; n++) await write(file(n), code(n, 'modified'));
  async function client(initialize = false) {
    const controller = new CodexController({ dataRoot }); controllers.push(controller);
    const bootstrap = await controller.bootstrap(), c = { controller, bootstrap, view: undefined };
    c.request = (action, payload = {}, override = {}) => ({ protocol: 1, capability: bootstrap.capability, viewId: bootstrap.viewId,
      workspaceId: c.view?.workspace.id, context: c.view?.context, action, payload,
      ...(!reads.has(action) ? { operationId: randomUUID() } : {}), ...override });
    c.send = async request => { const reply = await controller.dispatch(request); if (reply.ok && reply.data?.workspace) c.view = reply.data; return reply; };
    c.call = (action, payload = {}, override = {}) => c.send(c.request(action, payload, override));
    c.ok = async (action, payload = {}, override = {}) => { const reply = await c.call(action, payload, override); assert.equal(reply.ok, true, `${action}: ${JSON.stringify(reply.error)}`); return reply.data; };
    await c.ok('openWorkspace', { root, initialize });
    c.choose = ref => c.ok('chooseBase', { kind: 'commit', ref, label: 'Synthetic baseline', expectedBranch: c.view.branch.key, expectedRevision: c.view.revision });
    c.mark = names => c.ok('mark', { files: names.map(name => ({ path: name, fingerprint: c.view.files.find(f => f.path === name).fingerprint, checked: true })) });
    c.draft = (body, revision = 0, extra = {}) => ({ reviewId: c.view.active.id, expectedRevision: revision, sequence: revision + 1,
      navigation: nav, drafts: [{ id: randomUUID(), target: nav.target, body, requestId: randomUUID() }], ...extra });
    return c;
  }
  const c = await client(true); await c.choose(base); assert.equal(c.view.files.length, changes);
  const workspace = c.controller.workspaces.get(c.view.workspace.id);
  let scans = 0; const originalScan = workspace.repo.scan.bind(workspace.repo);
  workspace.repo.scan = async (...args) => { scans++; return originalScan(...args); };
  return { root, base, git, write, client, c, scans: () => scans, resetScans: () => { scans = 0; } };
}

test('QA-PERF-01：单文件 Diff 和草稿保存不扫描全仓，仍读取最新内容并恢复草稿', async t => {
  const env = await fixture(t), c = env.c;
  await env.write(file(0), code(0, 'newvalue'));
  const diff = await c.ok('diff', { path: file(0), mode: 'full', side: 'right' });
  assert.match(diff.right.text, /newvalue/); assert.match(diff.left.text, /baseline/);
  assert.equal(env.scans(), 0, 'opening one diff must not scan all files');
  const saved = await c.ok('saveView', c.draft('Synthetic draft after external edit'));
  assert.equal(saved.revision, 1); assert.equal(env.scans(), 0, 'saving a draft must not scan all files');
  const restarted = await env.client();
  assert.equal(restarted.view.recovery.drafts[0].body, 'Synthetic draft after external edit');
  assert.equal(restarted.view.recovery.navigation.target.path, file(0));
});

test('QA-PERF-02：轻量 Diff/草稿仍拒绝旧分支；仅显式 retainInactive 保留原 CR 草稿', async t => {
  const env = await fixture(t, 8, 2), c = env.c, context = c.view.context;
  const reviewId = c.view.active.id;
  const initial = c.draft('Synthetic retained draft'); await c.ok('saveView', initial);
  env.git('switch', '-qc', 'feature/other'); env.resetScans();
  const diff = await c.call('diff', { path: file(0), mode: 'full', side: 'right' }); assert.equal(diff.ok, false); assert.equal(diff.error.code, 'STALE_CONTEXT');
  const rejected = await c.call('saveView', c.draft('must not replace saved draft', 1)); assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'STALE_CONTEXT');
  const retained = await c.ok('saveView', c.draft('Synthetic explicit inactive retention', 1, { retainInactive: true }), { context });
  assert.equal(retained.reviewId, reviewId); assert.equal(env.scans(), 0, 'branch checks must remain independent of repository scan');
  env.git('switch', 'feature/performance');
  const restarted = await env.client(); assert.equal(restarted.view.active.id, reviewId); assert.equal(restarted.view.recovery.drafts[0].body, 'Synthetic explicit inactive retention');
});

test('QA-PERF-03：批量对象读取保持文件对应关系，stage/commit 保留已审，后续变更触发复审', async t => {
  const env = await fixture(t, 320, 300), c = env.c;
  const selected = [file(0), file(149), file(299)];
  for (const [index, name] of [[0, file(0)], [149, file(149)], [299, file(299)]]) {
    const diff = await c.ok('diff', { path: name, mode: 'full', side: 'right' });
    assert.equal(diff.left.text, code(index, 'baseline')); assert.equal(diff.right.text, code(index, 'modified'));
  }
  await c.mark(selected); env.git('add', '-A'); env.git('commit', '-qm', 'Synthetic stage and commit'); await c.ok('refresh');
  for (const name of selected) assert.equal(c.view.files.find(f => f.path === name).status, 'reviewed');
  const stale = c.request('mark', { files: [{ path: file(0), fingerprint: c.view.files.find(f => f.path === file(0)).fingerprint, checked: true }] });
  env.git('update-index', '--assume-unchanged', file(0)); await env.write(file(0), code(0, 'newvalue')); await env.write(file(319), code(319, 'hiddenxx'));
  const rejected = await c.send(stale); assert.equal(rejected.ok, false, 'stale file fingerprint must not be accepted');
  await c.ok('refresh'); assert.equal(c.view.files.find(f => f.path === file(0)).status, 'changed');
  assert.equal(c.view.files.find(f => f.path === file(319)).status, 'pending');
  const since = await c.ok('diff', { path: file(0), mode: 'since', side: 'right' }); assert.equal(since.left.text, code(0, 'modified')); assert.equal(since.right.text, code(0, 'newvalue'));
});

test('QA-PERF-04：另一客户端切换 CR 后拒绝旧 Diff/草稿，原草稿仍可重开', async t => {
  const env = await fixture(t, 8, 2), c = env.c;
  await c.ok('saveView', c.draft('Synthetic original CR draft'));
  const oldReview = c.view.active.id;
  env.git('add', '-A'); env.git('commit', '-qm', 'Synthetic new baseline');
  const other = await env.client(); await other.choose(env.git('rev-parse', 'HEAD'));
  const diff = await c.call('diff', { path: file(0), mode: 'full', side: 'right' }); assert.equal(diff.ok, false); assert.equal(diff.error.code, 'STALE_CONTEXT');
  const save = await c.call('saveView', c.draft('must not overwrite after CR switch', 1)); assert.equal(save.ok, false); assert.equal(save.error.code, 'STALE_CONTEXT');
  await other.ok('openReview', { reviewId: oldReview, expectedRevision: other.view.revision });
  const restarted = await env.client(); assert.equal(restarted.view.active.id, oldReview); assert.equal(restarted.view.recovery.drafts[0].body, 'Synthetic original CR draft');
});

test('QA-PERF-05：刷新扫描未完成时仍可保存草稿并读取目标 Diff，扫描返回后保持完整列表', async t => {
  const env = await fixture(t, 96, 48), c = env.c;
  const repository = c.controller.workspaces.get(c.view.workspace.id).repo;
  const original = repository.scan.bind(repository);
  let startScan, releaseScan;
  const started = new Promise(resolve => { startScan = resolve; });
  const gate = new Promise(resolve => { releaseScan = resolve; });
  repository.scan = async (...args) => { startScan(); await gate; return original(...args); };
  const refresh = c.ok('refresh'); await started;
  let timer;
  try {
    const diff = await Promise.race([
      (async () => { await c.ok('saveView', c.draft('Synthetic draft while refresh is pending')); return c.ok('diff', { path: file(0), mode: 'full', side: 'right' }); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diff waited for the gated full refresh')), 1500); })
    ]);
    assert.equal(diff.left.text, code(0, 'baseline')); assert.equal(diff.right.text, code(0, 'modified'));
  } finally { clearTimeout(timer); releaseScan(); await refresh; }
  assert.equal(c.view.files.length, 48);
});

test('QA-PERF-06：草稿旁路刷新队列后仍按 view revision 串行提交，失败不会覆盖胜出内容', async t => {
  const env = await fixture(t, 8, 2), c = env.c;
  const a = c.request('saveView', c.draft('Synthetic concurrent draft A'));
  const b = c.request('saveView', c.draft('Synthetic concurrent draft B'));
  const replies = await Promise.all([c.send(a), c.send(b)]);
  assert.equal(replies.filter(r => r.ok).length, 1);
  const failed = replies.find(r => !r.ok); assert.equal(failed.error.code, 'REVISION_CONFLICT');
  const committed = replies.find(r => r.ok).data;
  const reopened = await env.client(); assert.equal(reopened.view.recovery.drafts[0].body, committed.drafts[0].body); assert.equal(reopened.view.recovery.revision, 1);
  const winner = replies[0].ok ? a : b;
  const retried = await c.send(winner); assert.equal(retried.ok, true); assert.equal(retried.data.revision, 1);
});

test('QA-PERF-07：目标内容读取中途切分支时，轻量 Diff 末尾重新验证归属', async t => {
  const env = await fixture(t, 8, 2), c = env.c;
  const repository = c.controller.workspaces.get(c.view.workspace.id).repo;
  const originalPair = repository.pair.bind(repository);
  let startPair, releasePair;
  const started = new Promise(resolve => { startPair = resolve; });
  const gate = new Promise(resolve => { releasePair = resolve; });
  repository.pair = async (...args) => { const pair = await originalPair(...args); startPair(); await gate; return pair; };
  const pending = c.call('diff', { path: file(0), mode: 'full', side: 'right' }); await started;
  try { env.git('switch', '-qc', 'feature/during-diff'); } finally { releasePair(); }
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'STALE_CONTEXT');
});
