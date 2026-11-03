'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CodexController } = require('../../dist/codex/controller');
const { WorkspaceStore } = require('../../dist/codex/storage');
const compiledUi = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'reviewslate-recovery-ui-'));
require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../../web/codex/store.ts'), path.resolve(__dirname, '../../web/codex/model.ts')], outdir: compiledUi, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
const { Store } = require(path.join(compiledUi, 'store.js'));
const { diffRenderKey, defaultBaseSelection } = require(path.join(compiledUi, 'model.js'));
test.after(() => fs.rm(compiledUi, { recursive: true, force: true }));

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reviewslate-recovery-')));
  const dataRoot = path.join(temp, 'application'), clients = [];
  t.after(async () => { for (const c of clients) await c.controller.close(); await fs.rm(temp, { recursive: true, force: true }); });
  async function client() {
    const controller = new CodexController({ dataRoot }), boot = await controller.bootstrap();
    const c = { controller, boot, view: undefined };
    c.request = (action, payload, extra = {}) => ({ protocol: 1, capability: boot.capability, viewId: boot.viewId,
      workspaceId: c.view?.workspace.id, context: c.view?.context, operationId: randomUUID(), action, payload, ...extra });
    c.send = async request => { const reply = await controller.dispatch(request); if (reply.ok && reply.data?.workspace) c.view = reply.data; return reply; };
    c.call = (action, payload, extra) => c.send(c.request(action, payload, extra));
    clients.push(c); return c;
  }
  async function repository() {
    const root = path.join(temp, 'synthetic'); await fs.mkdir(root);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-qb', 'main'); await fs.writeFile(path.join(root, 'a.txt'), 'before\n'); git('add', '.'); git('commit', '-qm', 'synthetic');
    const base = git('rev-parse', 'HEAD'); await fs.writeFile(path.join(root, 'a.txt'), 'after\n'); return { root, base, git };
  }
  return { temp, dataRoot, client, repository };
}

test('language operation is recoverable before choosing any repository; old retry never rolls back a newer preference', async t => {
  const f = await fixture(t), a = await f.client(), id = randomUUID();
  const original = a.request('preferences', { language: 'zh-CN' }, { operationId: id });
  assert.equal((await a.send(original)).ok, true);
  assert.equal((await a.call('preferences', { language: 'en' })).ok, true);
  const b = await f.client();
  const queried = await b.call('operation', { operationId: id });
  assert.equal(queried.data.status, 'committed'); assert.equal(queried.data.result.data.language, 'en');
  const retried = await b.send({ ...original, capability: b.boot.capability, viewId: b.boot.viewId });
  assert.equal(retried.ok, true); assert.equal(retried.data.language, 'en');
  const wrong = await b.send({ ...original, capability: b.boot.capability, viewId: b.boot.viewId, payload: { language: 'auto' } });
  assert.equal(wrong.ok, false); assert.equal(wrong.error.code, 'INVALID_REQUEST');
  assert.equal((await b.call('operation', { operationId: randomUUID() })).data.status, 'not-found');
});

async function started(t) {
  const f = await fixture(t), repo = await f.repository(), a = await f.client();
  assert.equal((await a.call('openWorkspace', { root: repo.root, initialize: true })).ok, true);
  assert.equal((await a.call('chooseBase', { kind: 'commit', ref: repo.base, label: 'Synthetic', expectedBranch: a.view.branch.key, expectedRevision: a.view.revision })).ok, true);
  return { f, repo, a };
}
const navigation = () => ({ expanded: [], mode: 'full', side: 'right', commentsMode: 'target', filter: '' });
const draft = body => ({ id: randomUUID(), target: { type: 'file', path: 'a.txt' }, body, requestId: randomUUID() });
async function failingReceipt(receipt, action) {
  const original = fs.rename; let count = 0;
  fs.rename = async function (from, to) {
    if (to === receipt && JSON.parse(await fs.readFile(from, 'utf8')).status === 'committed') {
      count++; const error = new Error('Synthetic receipt EIO'); error.code = 'EIO'; throw error;
    }
    return original.apply(this, arguments);
  };
  try { const reply = await action(); assert.equal(count, 2); assert.equal(reply.outcome, 'unknown'); return reply; }
  finally { fs.rename = original; }
}
async function realStore(t, controller) {
  const store = new Store({ context: {}, initialize: async () => {}, bootstrap: async () => ({ protocol: 1, ok: true, outcome: 'read', data: await controller.bootstrap() }), call: request => controller.dispatch(request) });
  t.after(() => clearTimeout(store.saveTimer)); await store.connect(); return store;
}

test('CR-01: two receipt failures followed by reconnect preserve the original pending view owner', async t => {
  const { f, repo, a } = await started(t);
  const save = a.request('saveView', { reviewId: a.view.active.id, expectedRevision: 0, sequence: 1, navigation: navigation(), drafts: [draft('Original durable input')] });
  await failingReceipt(path.join(repo.root, '.reviewslate/codex/operations', save.operationId + '.json'), () => a.send(save));
  const b = await f.client(); assert.equal((await b.call('operation', { operationId: save.operationId })).data.status, 'pending');
  const retry = await b.send({ ...save, capability: b.boot.capability, viewId: b.boot.viewId, context: { ...save.context, epoch: b.boot.epoch } });
  assert.equal(retry.ok, true, JSON.stringify(retry.error)); assert.equal(retry.data.viewId, a.boot.viewId);
  assert.equal(retry.data.drafts[0].body, 'Original durable input');
  const index = JSON.parse(await fs.readFile(path.join(f.dataRoot, 'operations', save.operationId + '.json'), 'utf8'));
  assert.equal(index.viewId, a.boot.viewId); assert.equal(index.status, 'committed');
  assert.equal((await b.call('operation', { operationId: save.operationId })).data.status, 'committed');
  await assert.rejects(fs.lstat(path.join(repo.root, '.reviewslate/codex/views', a.view.active.id, b.boot.viewId)), { code: 'ENOENT' });
});

async function pendingAfterRestart(t) {
  const { f, repo, a } = await started(t); let live = a.controller;
  const store = new Store({ context: {}, initialize: async () => {}, bootstrap: async () => ({ protocol: 1, ok: true, outcome: 'read', data: await live.bootstrap() }), call: request => live.dispatch(request) });
  t.after(() => clearTimeout(store.saveTimer)); await store.connect(); await store.open(repo.root); await store.flush();
  const oldEpoch = store.bootstrap.epoch, oldViewId = store.bootstrap.viewId, oldReview = store.workspace.active.id;
  store.drafts = [draft('Original pending input')]; store.touch();
  const originalRename = fs.rename; let failures = 0;
  fs.rename = async function (from, to) {
    if (to.startsWith(path.join(repo.root, '.reviewslate/codex/operations/'))) {
      const value = JSON.parse(await fs.readFile(from, 'utf8'));
      if (value.action === 'saveView' && value.status === 'committed') { failures++; throw new Error('Synthetic committed EIO'); }
    }
    return originalRename.apply(this, arguments);
  };
  try { await assert.rejects(store.flush(), error => error.failure?.outcome === 'unknown'); }
  finally { fs.rename = originalRename; }
  assert.equal(failures, 2); const operationId = store.unknown.operationId;
  store.drafts[0].body = 'Newer input while result was unknown'; store.touch();
  await live.close(); const next = await f.client(); live = next.controller;
  await assert.rejects(store.reconnect()); assert.equal(store.unknownState, 'pending'); assert.notEqual(store.bootstrap.epoch, oldEpoch);
  return { f, repo, store, next, oldEpoch, oldViewId, oldReview, operationId };
}

test('restart recovery verifies the CR under the new controller epoch before retaining later input', async t => {
  const { repo, store, oldEpoch, oldViewId, oldReview, operationId } = await pendingAfterRestart(t);
  await store.retryUnknown();
  assert.equal(store.unknown, undefined); assert.equal(store.stale, false); assert.equal(store.saveState, 'saved');
  assert.equal(store.savedSequence, store.sequence); assert.equal(store.workspace.context.epoch, store.bootstrap.epoch);
  assert.notEqual(store.workspace.context.epoch, oldEpoch); assert.equal(store.workspace.active.id, oldReview);
  const disk = new WorkspaceStore(repo.root);
  assert.equal((await disk.readView(oldReview, oldViewId)).drafts[0].body, 'Original pending input');
  assert.equal((await disk.readView(oldReview, store.bootstrap.viewId)).drafts[0].body, 'Newer input while result was unknown');
  assert.equal((await store.request('operation', { operationId })).status, 'committed');
});

for (const change of ['branch', 'active-review']) test(`restart recovery never transfers later input after ${change} changes`, async t => {
  const { repo, store, next, oldReview } = await pendingAfterRestart(t);
  if (change === 'branch') repo.git('switch', '-qc', 'other');
  else {
    repo.git('add', 'a.txt'); repo.git('commit', '-qm', 'Synthetic other base');
    await next.call('openWorkspace', { root: repo.root, initialize: false });
    assert.equal((await next.call('chooseBase', { kind: 'commit', ref: repo.git('rev-parse', 'HEAD'), label: 'Other base', expectedBranch: next.view.branch.key, expectedRevision: next.view.revision })).ok, true);
  }
  await assert.rejects(store.retryUnknown(), error => error.failure?.code === 'STALE_CONTEXT');
  assert.equal(store.workspace.active.id, oldReview); assert.equal(store.drafts[0].body, 'Newer input while result was unknown');
  assert.equal(store.unknown, undefined); assert.equal(store.stale, true); assert.notEqual(store.savedSequence, store.sequence);
  const disk = new WorkspaceStore(repo.root);
  assert.equal(await disk.readView(oldReview, store.bootstrap.viewId), undefined);
  assert.equal(await store.retainAndRefresh(), true);
  assert.equal((await disk.readView(oldReview, store.bootstrap.viewId)).drafts[0].body, 'Newer input while result was unknown');
  assert.notEqual(store.workspace.active?.id, oldReview); assert.equal(store.drafts.length, 0);
});

test('security: pending receipt reads and retries reject a replaced operations parent without changing outside bytes', async t => {
  const { f, repo, a } = await started(t);
  const request = a.request('addComment', { target: { type: 'file', path: 'a.txt' }, body: 'Synthetic saved opinion', requestId: randomUUID(), fingerprint: a.view.files.find(file => file.path === 'a.txt').fingerprint });
  const folder = path.join(repo.root, '.reviewslate/codex/operations'), outside = path.join(f.temp, 'outside');
  await failingReceipt(path.join(folder, request.operationId + '.json'), () => a.send(request));
  await fs.cp(folder, outside, { recursive: true }); await fs.rename(folder, folder + '-original'); await fs.symlink(outside, folder);
  const snapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(outside)).sort().map(async name => [name, (await fs.readFile(path.join(outside, name))).toString('base64')])));
  const before = await snapshot();
  assert.equal((await a.call('operation', { operationId: request.operationId })).ok, false);
  assert.equal((await a.send(request)).ok, false); assert.deepEqual(await snapshot(), before);
  await fs.unlink(folder); await fs.rename(folder + '-original', folder);
  const retry = await a.send(request); assert.equal(retry.ok, true, JSON.stringify(retry.error));
  assert.equal(retry.data.comments.filter(item => item.body === 'Synthetic saved opinion').length, 1);
});

test('CR-02: explicit recovery retains dirty original-CR drafts after external branch and active-CR switches', async t => {
  const { f, repo, a } = await started(t), store = await realStore(t, a.controller);
  await store.open(repo.root); await store.flush(); const original = store.workspace.active.id;
  store.drafts = [draft('Dirty old branch input')]; store.touch(); repo.git('switch', '-qc', 'other');
  await assert.rejects(store.refresh(), error => error.failure?.code === 'STALE_CONTEXT');
  await assert.rejects(store.reconnect(), error => error.failure?.code === 'STALE_CONTEXT');
  await assert.rejects(store.open(repo.root), error => error.failure?.code === 'STALE_CONTEXT');
  await store.retainAndRefresh(); assert.equal(store.workspace.branch.key, 'refs/heads/other'); assert.equal(store.workspace.active, undefined); assert.equal(store.drafts.length, 0);
  const disk = new WorkspaceStore(repo.root); assert.equal((await disk.latestView(original)).drafts[0].body, 'Dirty old branch input');
  repo.git('switch', 'main'); await store.open(repo.root); assert.equal(store.drafts[0].body, 'Dirty old branch input'); await store.flush();
  store.drafts[0].body = 'Dirty original CR input'; store.touch();
  repo.git('add', 'a.txt'); repo.git('commit', '-qm', 'Synthetic second base'); const nextBase = repo.git('rev-parse', 'HEAD');
  const other = await f.client(); await other.call('openWorkspace', { root: repo.root, initialize: false });
  assert.equal((await other.call('chooseBase', { kind: 'commit', ref: nextBase, label: 'Second', expectedBranch: other.view.branch.key, expectedRevision: other.view.revision })).ok, true);
  const nextReview = other.view.active.id;
  await assert.rejects(store.refresh(), error => error.failure?.code === 'STALE_CONTEXT'); await store.retainAndRefresh();
  assert.equal(store.workspace.active.id, nextReview); assert.equal(store.drafts.length, 0); assert.equal(store.workspace.comments.length, 0);
  assert.equal((await disk.latestView(original)).drafts[0].body, 'Dirty original CR input');
  await store.mutate('openReview', { reviewId: original, expectedRevision: store.workspace.revision });
  assert.equal(store.drafts[0].body, 'Dirty original CR input');
});

test('CR-02: archived original review rejects retention and keeps unsaved input with its old ownership', async t => {
  const { f, repo, a } = await started(t), store = await realStore(t, a.controller);
  await store.open(repo.root); await store.flush(); const original = store.workspace.active.id;
  store.drafts = [draft('Must remain available for explicit export')]; store.touch();
  // This case requires an unpersisted draft. Hold the debounce while the other client archives;
  // under full-suite load, its Git reads can exceed 550 ms and legitimately let autosave win.
  clearTimeout(store.saveTimer);
  const other = await f.client(); await other.call('openWorkspace', { root: repo.root, initialize: false });
  assert.equal((await other.call('archiveReview', { reviewId: original, expectedRevision: other.view.revision })).ok, true);
  assert.notEqual(store.sequence, store.savedSequence);
  assert.equal((await new WorkspaceStore(repo.root).latestView(original)).drafts.length, 0);
  await assert.rejects(store.retainAndRefresh(), error => error.failure?.code === 'STALE_CONTEXT');
  assert.equal(store.workspace.active.id, original); assert.equal(store.drafts[0].body, 'Must remain available for explicit export');
  assert.equal(store.saveState, 'failed'); assert.notEqual(store.sequence, store.savedSequence);
  assert.equal((await new WorkspaceStore(repo.root).latestView(original)).drafts.length, 0);
});

test('CR-02: a draft saved before external archive stays with that review while refresh may continue', async t => {
  const { f, repo, a } = await started(t), store = await realStore(t, a.controller);
  await store.open(repo.root); await store.flush(); const original = store.workspace.active.id;
  store.drafts = [draft('Already durable before archive')]; store.touch(); await store.flush();
  assert.equal(store.sequence, store.savedSequence);
  const disk = new WorkspaceStore(repo.root), saved = await disk.latestView(original);
  assert.equal(saved.drafts[0].body, 'Already durable before archive');
  const other = await f.client(); await other.call('openWorkspace', { root: repo.root, initialize: false });
  assert.equal((await other.call('archiveReview', { reviewId: original, expectedRevision: other.view.revision })).ok, true);
  assert.equal(await store.retainAndRefresh(), true);
  assert.equal(store.workspace.active, undefined); assert.deepEqual(store.drafts, []);
  assert.deepEqual(await disk.latestView(original), saved);
  assert.ok(store.workspace.reviews.some(review => review.id === original && review.deletedAt));
});

test('rejected non-Git candidate stays local and the original review remains writable with its drafts', async t => {
  const { f, repo, a } = await started(t), store = await realStore(t, a.controller);
  await store.open(repo.root); await store.flush();
  const original = store.workspace.active.id, previousWorkspace = store.workspace, recent = structuredClone(store.bootstrap.preferences.recent);
  store.drafts = [draft('Original review input before choosing a project')]; store.touch();
  const candidate = path.join(f.temp, 'not-a-repository'); await fs.mkdir(candidate);
  await assert.rejects(store.open(candidate), error => error.failure?.code === 'REPOSITORY_UNAVAILABLE' && error.failure?.outcome === 'rejected');
  assert.equal(store.workspace, previousWorkspace); assert.equal(store.workspace.active.id, original);
  assert.equal(store.error, undefined); assert.equal(store.stale, false); assert.equal(store.unknown, undefined); assert.equal(store.writable, true);
  assert.deepEqual(store.bootstrap.preferences.recent, recent); assert.equal(store.drafts[0].body, 'Original review input before choosing a project');
  store.drafts[0].body = 'Continue reviewing after closing the project chooser'; store.touch(); await store.flush();
  const saved = await new WorkspaceStore(repo.root).readView(original, store.bootstrap.viewId);
  assert.equal(saved.drafts[0].body, 'Continue reviewing after closing the project chooser');
  await assert.rejects(fs.stat(path.join(candidate, '.reviewslate')), { code: 'ENOENT' });
});

test('CR-03: displayed incremental identity changes after another client marks the current bytes reviewed', async t => {
  const { f, repo, a } = await started(t);
  const mark = async c => c.call('mark', { files: [{ path: 'a.txt', fingerprint: c.view.files.find(file => file.path === 'a.txt').fingerprint, checked: true }] });
  assert.equal((await mark(a)).ok, true); await fs.writeFile(path.join(repo.root, 'a.txt'), 'latest\n'); await a.call('refresh', {});
  const before = (await a.call('diff', { path: 'a.txt', mode: 'since', side: 'right' })).data;
  const other = await f.client(); await other.call('openWorkspace', { root: repo.root, initialize: false }); assert.equal((await mark(other)).ok, true);
  const after = (await a.call('diff', { path: 'a.txt', mode: 'since', side: 'right' })).data;
  assert.equal(before.fingerprint, after.fingerprint); assert.notEqual(before.left.hash, after.left.hash); assert.equal(after.reason, 'unchanged');
  assert.notEqual(diffRenderKey(a.view.workspace.id, a.view.active.id, before), diffRenderKey(a.view.workspace.id, a.view.active.id, after));
});

test('CR-04: persisted commit default initializes the next chooser after reopening without changing current CR', async t => {
  const { f, repo, a } = await started(t), current = a.view.active.id;
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'next\n'); repo.git('add', 'a.txt'); repo.git('commit', '-qm', 'Synthetic default base');
  const next = repo.git('rev-parse', 'HEAD'); await a.call('refresh', {});
  assert.equal((await a.call('defaultBase', { kind: 'commit', ref: next.slice(0, 12), label: 'Default', expectedRevision: a.view.revision })).ok, true);
  assert.equal(a.view.active.id, current);
  for (const client of [a, await f.client()]) {
    await client.call('openWorkspace', { root: repo.root, initialize: false });
    const options = (await client.call('bases', {})).data, selected = defaultBaseSelection(client.view.defaultBase, options);
    assert.equal(selected.kind, 'commit'); assert.equal(selected.commit, next); assert.equal(client.view.active.id, current);
  }
});

test('lost open acknowledgement binds a new capability without an old workspace ID; saved views retain their original owner', async t => {
  const f = await fixture(t), repo = await f.repository(), a = await f.client(), openId = randomUUID();
  assert.equal((await a.call('openWorkspace', { root: repo.root, initialize: true }, { operationId: openId })).ok, true);
  assert.equal((await a.call('defaultBase', { kind: 'commit', ref: repo.base.slice(0, 12), label: 'Synthetic', expectedRevision: a.view.revision })).ok, true);
  assert.equal(a.view.defaultBase.ref, repo.base);
  assert.equal((await a.call('chooseBase', { kind: 'commit', ref: repo.base, label: 'Synthetic', expectedBranch: a.view.branch.key, expectedRevision: a.view.revision })).ok, true);
  const save = a.request('saveView', { reviewId: a.view.active.id, expectedRevision: 0, sequence: 1,
    navigation: { target: { type: 'file', path: 'a.txt' }, expanded: [], mode: 'full', side: 'right', commentsMode: 'target', filter: '' },
    drafts: [{ id: randomUUID(), target: { type: 'file', path: 'a.txt' }, body: 'durable synthetic draft', requestId: randomUUID() }] });
  assert.equal((await a.send(save)).ok, true);
  const b = await f.client(), opened = await b.call('operation', { operationId: openId });
  assert.equal(opened.data.status, 'committed'); b.view = opened.data.result.data;
  assert.equal((await b.call('refresh', {})).ok, true);
  const saved = await b.call('operation', { operationId: save.operationId });
  assert.equal(saved.data.status, 'committed'); assert.equal(saved.data.result.data.viewId, a.boot.viewId);
  // Model a lost acknowledgement with its application index still pending; the domain receipt is authoritative.
  const index = path.join(f.dataRoot, 'operations', save.operationId + '.json');
  const record = JSON.parse(await fs.readFile(index, 'utf8')); record.status = 'pending'; await fs.writeFile(index, JSON.stringify(record));
  const recovered = await b.call('operation', { operationId: save.operationId });
  assert.equal(recovered.data.status, 'committed');
  const retry = await b.send({ ...save, capability: b.boot.capability, viewId: b.boot.viewId, context: { ...save.context, epoch: b.boot.epoch } });
  assert.equal(retry.ok, true); assert.equal(retry.data.viewId, a.boot.viewId);
  const slot = path.join(repo.root, '.reviewslate/codex/views', a.view.active.id, b.boot.viewId);
  await assert.rejects(fs.lstat(slot), { code: 'ENOENT' });
});

test('preference commit is confirmed even when the final acknowledgement receipt fails', async t => {
  const f = await fixture(t), a = await f.client(), id = randomUUID(), originalRename = fs.rename;
  let fail = true;
  fs.rename = async function (from, to) {
    if (fail && to === path.join(f.dataRoot, 'operations', id + '.json')) {
      const value = JSON.parse(await fs.readFile(from, 'utf8'));
      if (value.status === 'committed') { fail = false; const error = new Error('synthetic EIO'); error.code = 'EIO'; throw error; }
    }
    return originalRename.apply(this, arguments);
  };
  let reply;
  try { reply = await a.call('preferences', { language: 'zh-CN' }, { operationId: id }); }
  finally { fs.rename = originalRename; }
  assert.equal(reply.ok, false); assert.equal(reply.outcome, 'partial');
  const b = await f.client(); assert.equal(b.boot.preferences.language, 'zh-CN');
  const query = await b.call('operation', { operationId: id });
  assert.equal(query.data.status, 'committed'); assert.equal(query.data.result.data.language, 'zh-CN');
});

test('combined Unicode drafts cannot create an unreadable JSON state or overwrite the prior copy', async t => {
  const f = await fixture(t), repo = await f.repository(), c = await f.client();
  assert.equal((await c.call('openWorkspace', { root: repo.root, initialize: true })).ok, true);
  assert.equal((await c.call('chooseBase', { kind: 'commit', ref: repo.base, label: 'Synthetic', expectedBranch: c.view.branch.key, expectedRevision: c.view.revision })).ok, true);
  const store = new WorkspaceStore(await fs.realpath(repo.root));
  const state = { version: 1, viewId: c.boot.viewId, reviewId: c.view.active.id, revision: 1, sequence: 1, updatedAt: new Date().toISOString(),
    navigation: { expanded: [], mode: 'full', side: 'right', commentsMode: 'target', filter: '' }, drafts: [] };
  await store.saveView(state, 0);
  const anchor = { side: 'right', start: 0, end: 0, hash: 'a'.repeat(64), selected: ['\u4e2d'.repeat(50000)], before: [], after: [] };
  const drafts = Array.from({ length: 120 }, () => ({ id: randomUUID(), requestId: randomUUID(), target: { type: 'file', path: 'a.txt' }, body: 'Synthetic', anchor }));
  await assert.rejects(store.saveView({ ...state, revision: 2, sequence: 2, drafts }, 1), error => error.code === 'UNSUPPORTED_CONTENT');
  assert.deepEqual(await store.readView(state.reviewId, state.viewId), state);
});
