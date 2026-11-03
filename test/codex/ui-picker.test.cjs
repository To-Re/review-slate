const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewslate-ui-picker-'));
buildSync({ entryPoints: ['web/codex/model.ts', 'web/codex/store.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: compiled, logLevel: 'silent' });
const { FolderPickerSession, directoryPaths, buildTree, fileRowTone, repositoryFailureMessage } = require(path.join(compiled, 'model.js'));
const { Store } = require(path.join(compiled, 'store.js'));
test.after(() => fs.rmSync(compiled, { recursive: true, force: true }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(handler) {
  const calls = [], states = [], scheduled = new Map(); let timer = 0, id = 0;
  const session = new FolderPickerSession(async (action, requestId) => { calls.push({ action, requestId }); return handler(action, requestId); },
    state => states.push(structuredClone(state)), callback => { scheduled.set(++timer, callback); return timer; }, key => scheduled.delete(key), () => `request-${++id}`);
  return { session, calls, states, scheduled, async poll() { const [key, callback] = scheduled.entries().next().value; scheduled.delete(key); callback(); await new Promise(resolve => setImmediate(resolve)); } };
}
test('chooser starts only explicitly, deduplicates clicks, and polls serially until selection', async () => {
  const start = deferred(), poll = deferred();
  const f = fixture((action, requestId) => action === 'pickFolder' ? start.promise : poll.promise);
  assert.equal(f.calls.length, 0); const starting = f.session.start(); await f.session.start();
  assert.equal(f.calls.length, 1); assert.equal(f.session.busy, true); assert.equal(f.scheduled.size, 0);
  start.resolve({ status: 'pending', requestId: 'request-1' }); await starting;
  assert.equal(f.scheduled.size, 1); await f.poll(); assert.equal(f.calls.length, 2); assert.equal(f.scheduled.size, 0);
  await f.session.start(); assert.equal(f.calls.length, 2);
  poll.resolve({ status: 'selected', requestId: 'request-1', root: '/synthetic/project' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.state.status, 'selected'); assert.equal(f.session.state.root, '/synthetic/project'); assert.equal(f.scheduled.size, 0);
});
test('cancelling invalidates an in-flight selected response and stops subsequent polling', async () => {
  const poll = deferred();
  const f = fixture((action, requestId) => action === 'pickFolder' ? { status: 'pending', requestId } : action === 'folderPickerResult' ? poll.promise : { status: 'selected', requestId, root: '/synthetic/late' });
  await f.session.start(); await f.poll(); await f.session.cancel();
  poll.resolve({ status: 'selected', requestId: 'request-1', root: '/synthetic/late' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.state.status, 'cancelled'); assert.equal(f.scheduled.size, 0); assert.equal(f.states.some(state => state.status === 'selected'), false);
});
test('close/pagehide cancellation and manual navigation ignore responses from the old chooser', async () => {
  for (const action of ['dispose', 'abandon']) {
    const start = deferred(); const f = fixture((operation, requestId) => operation === 'pickFolder' ? start.promise : { status: 'cancelled', requestId });
    const opening = f.session.start(); f.session[action]();
    start.resolve({ status: 'selected', requestId: 'request-1', root: '/synthetic/late' }); await opening;
    assert.equal(f.session.state.status, 'idle'); assert.equal(f.states.some(state => state.status === 'selected'), false);
    assert.equal(f.calls.at(-1).action, 'cancelFolderPicker'); assert.equal(f.scheduled.size, 0);
    if (action === 'dispose') { await f.session.start(); assert.equal(f.calls.length, 2); }
  }
});
test('transport interruption is paused, explicit retry uses the same request ID', async () => {
  let tries = 0;
  const f = fixture((action, requestId) => { if (++tries === 1) throw new Error('UNKNOWN_RESULT'); return { status: 'cancelled', requestId }; });
  await f.session.start(); assert.equal(f.session.state.status, 'interrupted'); assert.equal(f.scheduled.size, 0);
  await f.session.start(); assert.deepEqual(f.calls.map(item => item.requestId), ['request-1', 'request-1']); assert.equal(f.session.state.status, 'cancelled');
});
test('interrupted cancellation can only resume cancellation, never reopen a late selection', async () => {
  let cancels = 0;
  const f = fixture((action, requestId) => {
    if (action === 'pickFolder') return { status: 'pending', requestId };
    if (++cancels === 1) throw new Error('UNKNOWN_RESULT');
    return { status: 'selected', requestId, root: '/synthetic/late' };
  });
  await f.session.start(); await f.session.cancel(); assert.equal(f.session.state.status, 'interrupted'); assert.equal(f.session.state.cancelling, true);
  await f.session.start(); assert.equal(f.calls.at(-1).action, 'cancelFolderPicker'); assert.equal(f.session.state.status, 'cancelled');
  assert.equal(f.states.some(state => state.status === 'selected'), false);
});
test('terminal picker failures retry with a fresh ID and mismatched replies never select a folder', async () => {
  for (const failure of [{ status: 'timed-out' }, ...['unavailable', 'busy', 'launch-failed', 'invalid-result', 'expired'].map(reason => ({ status: 'failed', reason }))]) {
    const f = fixture((action, requestId) => ({ ...failure, requestId }));
    await f.session.start(); assert.deepEqual(f.session.state, { ...failure, requestId: 'request-1' }); assert.equal(f.scheduled.size, 0);
    await f.session.start(); assert.equal(f.calls.at(-1).requestId, 'request-2');
  }
  const f = fixture((action, requestId) => action === 'pickFolder' ? { status: 'selected', requestId: 'other', root: '/synthetic/wrong' } : { status: 'cancelled', requestId });
  await f.session.start(); assert.equal(f.session.state.status, 'failed'); assert.equal(f.session.state.reason, 'invalid-result'); assert.equal(f.calls.at(-1).action, 'cancelFolderPicker');
});
test('picker RPC rejection leaves all review, draft, recent and save-error state untouched', async () => {
  const calls = [], store = new Store({ context: {}, call: async request => { calls.push(structuredClone(request)); throw new Error('UNKNOWN_RESULT'); } });
  store.bootstrap = { capability: 'capability', viewId: 'view', preferences: { language: 'en', recent: [{ id: 'old', root: '/synthetic/old' }] } };
  store.workspace = { workspace: { id: 'old' }, context: { reviewId: 'old-review' } }; store.drafts = [{ body: 'keep this draft' }];
  store.error = { code: 'STALE_CONTEXT' }; store.unknown = { action: 'saveView', operationId: 'original-save' }; store.stale = true;
  const before = structuredClone({ workspace: store.workspace, drafts: store.drafts, preferences: store.bootstrap.preferences, error: store.error, unknown: store.unknown, stale: store.stale });
  for (const action of ['pickFolder', 'folderPickerResult', 'cancelFolderPicker']) await assert.rejects(store.folderPicker(action, 'request-id'));
  assert.deepEqual({ workspace: store.workspace, drafts: store.drafts, preferences: store.bootstrap.preferences, error: store.error, unknown: store.unknown, stale: store.stale }, before);
  assert.equal(calls.every(call => !('operationId' in call)), true); assert.equal(calls[0].payload.locale, 'en');
});
test('expand-all covers nested and comment-only directories without modifying review objects or drafts', () => {
  const files = [{ path: 'src/deep/value.ts', status: 'reviewed' }, { path: 'test/value_test.ts', status: 'changed' }];
  const comments = [{ path: 'notes/nested', target: 'directory' }];
  const navigation = { target: { type: 'file', path: 'src/deep/value.ts' }, expanded: ['src'], anchor: { side: 'left', start: 2 } }, drafts = [{ body: 'keep' }];
  const before = structuredClone({ files, comments, target: navigation.target, anchor: navigation.anchor, drafts });
  navigation.expanded = directoryPaths(buildTree(files, comments)); assert.deepEqual(navigation.expanded, ['notes', 'notes/nested', 'src', 'src/deep', 'test']);
  navigation.expanded = []; assert.deepEqual({ files, comments, target: navigation.target, anchor: navigation.anchor, drafts }, before);
});
test('test-file row decoration yields to re-review and read failures', () => {
  assert.equal(fileRowTone({ path: 'value_test.ts', status: 'pending' }), 'test-file');
  assert.equal(fileRowTone({ path: 'value_test.ts', status: 'changed' }), 'needs-review');
  assert.equal(fileRowTone({ path: 'value_test.ts', status: 'changed', error: 'read failed' }), 'read-error');
});
test('repository failures only claim a non-Git folder when the actual failure establishes it', () => {
  assert.match(repositoryFailureMessage({ code: 'REPOSITORY_UNAVAILABLE', message: 'fatal: not a git repository' })[1], /not a Git repository/);
  assert.match(repositoryFailureMessage({ code: 'REPOSITORY_UNAVAILABLE', message: 'ENOENT' })[1], /no longer exists/);
  assert.match(repositoryFailureMessage({ code: 'ACCESS_DENIED', message: '' })[1], /permissions/);
  assert.doesNotMatch(repositoryFailureMessage({ code: 'REPOSITORY_UNAVAILABLE', message: 'Git 读取失败' })[1], /not a Git/);
  assert.equal(repositoryFailureMessage({ code: 'STALE_CONTEXT', message: '' }), undefined);
});
