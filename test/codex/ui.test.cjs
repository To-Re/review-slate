const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewslate-ui-'));
buildSync({ entryPoints: ['web/codex/model.ts', 'web/codex/clipboard.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: compiled, logLevel: 'silent' });
// Share a module graph, as the app bundle does, so UnknownResult has one class identity.
buildSync({ stdin: { contents: "export { Store } from './web/codex/store'; export { Bridge, UnknownResult } from './web/codex/bridge';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(compiled, 'store-bridge.js'), logLevel: 'silent' });
buildSync({ entryPoints: ['src/codex/validation.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(compiled, 'validation.cjs'), logLevel: 'silent' });
const { parseRequest } = require(path.join(compiled, 'validation.cjs'));
const { Store, Bridge, UnknownResult } = require(path.join(compiled, 'store-bridge.js'));
const { copyText } = require(path.join(compiled, 'clipboard.js'));
const { fileIconKind, firstReviewTarget } = require(path.join(compiled, 'model.js'));
const { localeFor, selectionAnchor, summarize, buildTree, commentPayload } = require(path.join(compiled, 'model.js'));
test.after(() => fs.rmSync(compiled, { recursive: true, force: true }));
const ok = data => ({ protocol: 1, ok: true, outcome: 'committed', data });
const boot = (viewId = 'new-view') => ({ protocol: 1, epoch: 'epoch', capability: 'token', viewId, preferences: { language: 'auto', recent: [] }, capabilities: { editCode: false, editReason: 'safe-save-unverified', roots: false } });
const context = { workspaceId: 'workspace', epoch: 'epoch', reviewId: 'review', branch: 'main', base: 'base', revision: 'r1' };
const review = { id: 'review', base: 'base', label: 'main', branch: { key: 'main', label: 'main' }, createdAt: '', purgePending: false };
const workspace = () => structuredClone({ workspace: { id: 'workspace', name: 'sample', root: '/synthetic/sample', initialized: true }, branch: review.branch, active: review, reviews: [review], context, revision: 'r1', files: [], comments: [], capabilities: { editCode: false, editReason: 'safe-save-unverified' } });
const navigation = () => ({ expanded: ['src'], mode: 'full', side: 'right', commentsMode: 'target', filter: '' });
const source = (text = 'first\r\nsecond\r\nthird') => ({ text, mode: '100644', hash: 'a'.repeat(64), bytes: text.length, textContent: true });
const diff = path => ({ target: { type: 'file', path }, fingerprint: path, mode: 'full', side: 'right', left: source(), right: source(), comments: [], context });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(handler = async request => ok({ ...request.payload, revision: 1 })) {
  const calls = [], bridge = { context: {}, initialize: async () => {}, bootstrap: async () => ok(boot()), call: async request => { calls.push(structuredClone(request)); return handler(request); } };
  const store = new Store(bridge); store.bootstrap = boot(); store.apply(workspace()); store.savedSequence = store.sequence;
  return { store, calls, bridge };
}

test('locale follows host zh variants only; explicit preference wins', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-Hant-TW', 'ZH-hk']) assert.equal(localeFor('auto', locale), 'zh-CN');
  for (const locale of [undefined, '', 'en-US', 'fr', 'zho']) assert.equal(localeFor('auto', locale), 'en');
  assert.equal(localeFor('en', 'zh-CN'), 'en'); assert.equal(localeFor('zh-CN', 'en'), 'zh-CN');
});
test('tree icons use the existing test-file naming rules without changing review membership', () => {
  for (const name of ['test_helper.ts', 'src/value.test.ts', 'src/value.spec.js', 'tests/example.json', 'src/__tests__/example.ts']) assert.equal(fileIconKind(name), 'test');
  assert.equal(fileIconKind('src/value.ts'), 'code'); assert.equal(fileIconKind('README.md'), 'markdown'); assert.equal(fileIconKind('package.json'), 'file');
  assert.equal(fileIconKind('src/testimony.ts'), 'code');
});
test('empty-state action chooses a readable pending file and never mutates review flags', () => {
  const files = [{ path: 'notes.ts', commentOnly: true, status: 'pending' }, { path: 'failed.ts', error: 'read failed', status: 'pending' }, { path: 'done.ts', status: 'reviewed' }, { path: 'pending.ts', status: 'changed' }];
  const original = structuredClone(files); assert.deepEqual(firstReviewTarget(files), { type: 'file', path: 'pending.ts' }); assert.deepEqual(files, original);
  assert.deepEqual(firstReviewTarget(files.slice(0, 3)), { type: 'file', path: 'done.ts' }); assert.equal(firstReviewTarget([]), undefined);
});
test('clipboard refusal returns a manual-copy outcome without throwing a business error', async () => {
  const sha = 'a'.repeat(40), values = [];
  assert.equal(await copyText(sha, undefined), false);
  assert.equal(await copyText(sha, { writeText: async () => { throw new Error('NotAllowedError'); } }), false);
  assert.equal(await copyText(sha, { writeText: async value => { values.push(value); } }), true); assert.deepEqual(values, [sha]);
});
test('selection carries exact zero-based side, source hash and bounded original context', () => {
  const value = selectionAnchor(diff('sample.ts'), 'left', 1, 1);
  assert.deepEqual(value, { side: 'left', start: 1, end: 1, hash: 'a'.repeat(64), selected: ['second'], before: ['first'], after: ['third'] });
  assert.throws(() => selectionAnchor({ ...diff('x'), mode: 'since' }, 'right', 0, 0), /UNSUPPORTED_CONTENT/);
  assert.throws(() => selectionAnchor(diff('x'), 'right', -1, 0), /SELECTION_LIMIT/);
  assert.throws(() => selectionAnchor({ ...diff('x'), right: source('one\rtwo') }, 'right', 0, 0), /UNSUPPORTED_CONTENT/);
});
test('tree keeps comment-only targets and aggregation excludes them from review denominator', () => {
  const files = [{ path: 'src/a.ts', status: 'reviewed', commentOnly: false }, { path: 'src/deep/b.ts', status: 'changed', commentOnly: false }, { path: 'src/old.ts', status: 'pending', commentOnly: true }];
  const comments = [{ id: '1', path: 'src/deep', target: 'directory', state: 'open', deleted: false }, { id: '2', path: 'gone/file.ts', target: 'file', state: 'open', deleted: false, reply: { matches: true } }, { id: '3', path: 'src/a.ts', target: 'file', state: 'resolved', deleted: false }];
  assert.deepEqual(summarize(files, comments, 'src'), { total: 2, reviewed: 1, changed: 1, open: 1, resolved: 1, pending: 1, review: 0 });
  const tree = buildTree(files, comments); assert.equal(tree.find(n => n.name === 'gone').children[0].target.path, 'gone/file.ts');
});
test('ordinary file comments and selection comments carry only their exact target fingerprint', () => {
  const draft = { id: 'draft', target: { type: 'file', path: 'src/a.ts' }, body: 'review this file', requestId: crypto.randomUUID() };
  const files = [{ path: 'src/other.ts', fingerprint: 'b'.repeat(64) }, { path: 'src/a.ts', fingerprint: 'a'.repeat(64) }];
  assert.equal(commentPayload(draft, files).fingerprint, 'a'.repeat(64));
  const anchor = selectionAnchor(diff('src/a.ts'), 'left', 0, 1);
  assert.deepEqual(commentPayload({ ...draft, anchor }, files).anchor, anchor);
  assert.equal('fingerprint' in commentPayload({ ...draft, target: { type: 'directory', path: 'src' } }, files), false);
  assert.throws(() => commentPayload(draft, files.slice(0, 1)), /CONTENT_CHANGED/);
});
test('new view restores full drafts but saves with revision zero and its own view ID', async () => {
  const { store, calls } = fixture(); store.workspace = undefined;
  const anchor = selectionAnchor(diff('src/a.ts'), 'left', 1, 1);
  const drafts = [{ id: 'draft', target: { type: 'file', path: 'src/a.ts' }, body: 'kept', requestId: 'request', anchor }, { id: 'edit', target: { type: 'file', path: 'src/a.ts' }, body: 'edited', commentId: 'comment', commentRevision: 'v1', commentState: 'open', requestId: 'edit-request', originalNewDraft: 'draft' }];
  store.apply({ ...workspace(), recovery: { version: 1, viewId: 'old-view', reviewId: 'review', revision: 9, sequence: 12, navigation: navigation(), drafts, updatedAt: '' } });
  await store.flush(); const saved = calls.find(call => call.action === 'saveView');
  assert.equal(saved.viewId, 'new-view'); assert.equal(saved.payload.expectedRevision, 0); assert.deepEqual(saved.payload.drafts, drafts); assert.equal(store.savedSequence, 12);
});
test('first empty view retention follows the real request schema and starts at positive sequence', async () => {
  const { store, calls } = fixture();
  store.bootstrap = { ...boot(), viewId: crypto.randomUUID(), epoch: crypto.randomUUID(), capability: 'a'.repeat(64) };
  store.workspace.context = { ...context, workspaceId: 'b'.repeat(64), epoch: store.bootstrap.epoch, reviewId: 'c'.repeat(64), base: 'd'.repeat(40), revision: 'e'.repeat(64) };
  store.workspace.workspace.id = 'b'.repeat(64); store.workspace.active.id = 'c'.repeat(64); store.savedSequence = -1;
  await store.flush(); const request = calls.at(-1); assert.equal(request.payload.sequence, 1); assert.doesNotThrow(() => parseRequest(request));
});
test('save acknowledgment never clears input typed during the request; flush waits for newest sequence', async () => {
  const gate = deferred(); let count = 0;
  const { store, calls } = fixture(async request => { if (++count === 1) return gate.promise; return ok({ ...request.payload, revision: count }); });
  store.drafts = [{ id: 'd', target: { type: 'file', path: 'x' }, body: 'first', requestId: 'q' }]; store.touch();
  const saving = store.flush(); store.drafts[0].body = 'second'; store.touch(); gate.resolve(ok({ revision: 1 })); await saving;
  assert.equal(calls.length, 2); assert.equal(calls[0].payload.drafts[0].body, 'first'); assert.equal(calls[1].payload.drafts[0].body, 'second');
  assert.equal(calls[1].payload.expectedRevision, 1); assert.equal(store.saveState, 'saved'); assert.equal(store.drafts[0].body, 'second');
});
test('IME composition defers retention until the complete input is available', async () => {
  const { store, calls } = fixture(); store.drafts = [{ id: 'd', target: { type: 'file', path: 'x' }, body: 'zhong', requestId: 'q' }];
  store.setComposing(true); store.touch(); const saving = store.flush(); await Promise.resolve(); assert.equal(calls.length, 0);
  store.drafts[0].body = '中文输入'; store.touch(); store.setComposing(false); await saving;
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.drafts[0].body, '中文输入'); assert.equal(store.saveState, 'saved');
});
test('failed draft retention blocks object switch and preserves original target and full text', async () => {
  const { store } = fixture(async () => ({ protocol: 1, ok: false, outcome: 'rejected', error: { code: 'IO_FAILED', message: '', outcome: 'rejected', retry: 'same-operation' } }));
  store.navigation.target = { type: 'file', path: 'before.ts' }; store.drafts = [{ id: 'd', target: store.navigation.target, body: 'never lose', requestId: 'q' }]; store.touch();
  await assert.rejects(store.select({ type: 'file', path: 'after.ts' })); assert.equal(store.navigation.target.path, 'before.ts'); assert.equal(store.drafts[0].body, 'never lose'); assert.equal(store.saveState, 'failed');
});
test('stale diff successes and failures cannot replace or invalidate the newer target', async () => {
  for (const oldFails of [false, true]) {
    const old = deferred();
    const { store } = fixture(async request => request.action === 'diff' && request.payload.path === 'old.ts' ? old.promise : request.action === 'diff' ? ok(diff('new.ts')) : ok({ revision: 1 }));
    store.navigation.target = { type: 'file', path: 'old.ts' };
    const first = store.loadDiff(); const second = store.select({ type: 'file', path: 'new.ts' }); await second;
    if (oldFails) old.resolve({ protocol: 1, ok: false, outcome: 'rejected', error: { code: 'CONTENT_CHANGED', message: '', outcome: 'rejected', retry: 'refresh' } }); else old.resolve(ok(diff('old.ts')));
    await first; assert.equal(store.diff.target.path, 'new.ts'); assert.equal(store.stale, false); assert.equal(store.error, undefined); await store.flush();
  }
});
test('language preference failure leaves language, target, selection and both drafts unchanged', async () => {
  const { store } = fixture(async () => ({ protocol: 1, ok: false, outcome: 'rejected', error: { code: 'IO_FAILED', message: '', outcome: 'rejected', retry: 'same-operation' } }));
  store.bootstrap.preferences.language = 'en'; store.navigation = { ...navigation(), target: { type: 'file', path: 'src/a.ts' }, anchor: selectionAnchor(diff('x'), 'left', 0, 1) };
  store.drafts = [{ id: 'n', body: '中文输入', target: store.navigation.target, requestId: 'n' }, { id: 'e', body: 'editing', target: store.navigation.target, commentId: 'c', requestId: 'e' }];
  const before = structuredClone({ navigation: store.navigation, drafts: store.drafts }); await assert.rejects(store.language('zh-CN'));
  assert.equal(store.locale, 'en'); assert.deepEqual({ navigation: store.navigation, drafts: store.drafts }, before);
});
test('successful repository switches update recent repositories immediately; failures add nothing', async () => {
  const { store } = fixture(async request => {
    if (request.action === 'saveView') return ok({ revision: 1 });
    if (request.payload.root === '/synthetic/denied') return { protocol: 1, ok: false, outcome: 'rejected', error: { code: 'ACCESS_DENIED', message: '', outcome: 'rejected', retry: 'none' } };
    const name = request.payload.root.split('/').at(-1); return ok({ ...workspace(), workspace: { id: name, name, root: request.payload.root, initialized: true } });
  });
  await store.open('/synthetic/a'); await store.open('/synthetic/b');
  assert.deepEqual(store.bootstrap.preferences.recent.map(item => item.root), ['/synthetic/b', '/synthetic/a']);
  await store.open(store.bootstrap.preferences.recent[1].root); assert.equal(store.workspace.workspace.name, 'a');
  await assert.rejects(store.open('/synthetic/denied')); assert.deepEqual(store.bootstrap.preferences.recent.map(item => item.name), ['a', 'b']);
});
test('a rejected candidate cannot overwrite a pre-existing current-review failure', async () => {
  const candidateFailure = { code: 'REPOSITORY_UNAVAILABLE', message: 'not a git repository', outcome: 'rejected', retry: 'refresh' };
  const { store } = fixture(async () => ({ protocol: 1, ok: false, outcome: 'rejected', error: candidateFailure }));
  const previous = { code: 'CONTENT_CHANGED', message: 'Current file changed', outcome: 'rejected', retry: 'refresh' };
  store.error = previous; store.stale = true; const priorView = store.workspace;
  await assert.rejects(store.open('/synthetic/not-git'), error => error.failure === candidateFailure);
  assert.equal(store.error, previous); assert.equal(store.stale, true); assert.equal(store.workspace, priorView); assert.equal(store.writable, false);
});
test('a rejected candidate preserves the original in-flight Diff result or error and clears its loading state', async () => {
  for (const failedDiff of [false, true]) {
    const gate = deferred(), failure = { code: 'CONTENT_CHANGED', message: 'Original file changed', outcome: 'rejected', retry: 'refresh' };
    const { store } = fixture(async request => request.action === 'diff' ? gate.promise :
      { protocol: 1, ok: false, outcome: 'rejected', error: { code: 'REPOSITORY_UNAVAILABLE', message: 'not a git repository', outcome: 'rejected', retry: 'refresh' } });
    store.navigation.target = { type: 'file', path: 'original.ts' };
    const reading = store.loadDiff(); assert.equal(store.loadingDiff, true);
    await assert.rejects(store.open('/synthetic/not-git'));
    gate.resolve(failedDiff ? { protocol: 1, ok: false, outcome: 'rejected', error: failure } : ok(diff('original.ts')));
    if (failedDiff) { await assert.rejects(reading); assert.equal(store.error, failure); assert.equal(store.stale, true); }
    else { await reading; assert.equal(store.diff.target.path, 'original.ts'); assert.equal(store.error, undefined); assert.equal(store.writable, true); }
    assert.equal(store.loadingDiff, false);
  }
});
test('successful workspace adoption invalidates the previous in-flight Diff even when the new workspace has no target', async () => {
  const gate = deferred();
  const { store } = fixture(async request => request.action === 'diff' ? gate.promise : ok({ ...workspace(), workspace: { id: 'new', name: 'new', root: '/synthetic/new', initialized: true }, active: undefined, context: undefined }));
  store.navigation.target = { type: 'file', path: 'original.ts' }; const reading = store.loadDiff();
  await store.open('/synthetic/new'); assert.equal(store.loadingDiff, false); assert.equal(store.diff, undefined);
  gate.resolve(ok(diff('original.ts'))); await reading;
  assert.equal(store.workspace.workspace.id, 'new'); assert.equal(store.diff, undefined); assert.equal(store.loadingDiff, false);
});
test('old-review flush failure blocks candidate opening and remains a global save failure', async () => {
  const failure = { code: 'IO_FAILED', message: 'Old draft was not saved', outcome: 'rejected', retry: 'same-operation' };
  const { store, calls } = fixture(async () => ({ protocol: 1, ok: false, outcome: 'rejected', error: failure }));
  store.drafts = [{ id: 'old', target: { type: 'file', path: 'before.ts' }, body: 'Unsaved old input', requestId: 'old' }]; store.touch();
  await assert.rejects(store.open('/synthetic/next'), error => error.failure === failure);
  assert.deepEqual(calls.map(call => call.action), ['saveView']); assert.equal(store.error, failure); assert.equal(store.saveState, 'failed');
  assert.equal(store.workspace.workspace.root, '/synthetic/sample'); assert.equal(store.drafts[0].body, 'Unsaved old input');
});
test('candidate partial, unknown, lost responses and reconnect failures still guard the current review', async () => {
  for (const outcome of ['partial', 'unknown', 'lost', 'reconnect']) {
    const { store } = fixture(async () => {
      if (outcome === 'lost') throw new UnknownResult();
      const result = outcome === 'reconnect' ? 'rejected' : outcome;
      return { protocol: 1, ok: false, outcome: result, error: { code: outcome === 'reconnect' ? 'ACCESS_DENIED' : 'IO_FAILED', message: '', outcome: result, retry: 'reconnect' } };
    });
    const before = store.workspace; await assert.rejects(store.open('/synthetic/next'));
    assert.equal(store.workspace, before); assert.ok(store.error); assert.equal(store.writable, false);
    if (outcome === 'reconnect') assert.equal(store.stale, true); else assert.equal(store.unknown.action, 'openWorkspace');
  }
});
test('reopening the current root or initializing storage still reports a rejected failure globally', async () => {
  for (const [root, initialize] of [['/synthetic/sample', false], ['/synthetic/next', true]]) {
    const failure = { code: 'ACCESS_DENIED', message: '', outcome: 'rejected', retry: 'none' };
    const { store } = fixture(async () => ({ protocol: 1, ok: false, outcome: 'rejected', error: failure }));
    await assert.rejects(store.open(root, initialize)); assert.equal(store.error, failure); assert.equal(store.stale, true); assert.equal(store.writable, false);
  }
});
test('refresh never rebinds existing drafts to another active CR', async () => {
  const { store } = fixture(async () => ok({ ...workspace(), active: { ...review, id: 'other' } }));
  store.drafts = [{ id: 'd', body: 'original', target: { type: 'file', path: 'a.ts' }, requestId: 'q' }];
  await assert.rejects(store.refresh(), /STALE_CONTEXT/); assert.equal(store.workspace.active.id, 'review'); assert.equal(store.drafts[0].body, 'original'); assert.equal(store.stale, true);
});
test('uncertain operation is queried on reconnect and never automatically replayed', async () => {
  const { store, calls, bridge } = fixture(async request => request.action === 'openWorkspace' ? ok(workspace()) : request.action === 'operation' ? ok({ operationId: 'op', status: 'committed', result: ok(workspace()) }) : ok({ revision: 1 }));
  bridge.bootstrap = async () => ok(boot('reconnected-view'));
  store.unknown = { protocol: 1, capability: 'old', viewId: 'old', workspaceId: 'workspace', context, operationId: 'op', action: 'addComment', payload: { target: { type: 'file', path: 'x' }, body: 'retained', requestId: 'q' } };
  store.drafts = [{ id: 'd', target: { type: 'file', path: 'x' }, body: 'newer input', requestId: 'q' }];
  await store.reconnect(); assert.deepEqual(calls.map(call => call.action), ['operation', 'openWorkspace', 'saveView']); assert.equal(store.drafts[0].body, 'newer input'); assert.notEqual(store.drafts[0].requestId, 'q'); assert.equal(store.unknown, undefined);
});
test('not-found uncertain operation remains blocked and never resubmits mutation', async () => {
  const { store, calls } = fixture(async request => request.action === 'openWorkspace' ? ok(workspace()) : ok({ status: 'not-found' }));
  store.unknown = { action: 'mark', operationId: 'uncertain' };
  await assert.rejects(store.reconnect()); assert.equal(store.unknown.operationId, 'uncertain'); assert.equal(store.retryableUnknown, true); assert.deepEqual(calls.map(call => call.action), ['operation', 'openWorkspace']);
});
test('confirmed preference result applies only after operation lookup, with no repository required', async () => {
  const { store, calls } = fixture(async request => request.action === 'operation' ? ok({ status: 'committed', result: ok({ language: 'zh-CN', recent: [] }) }) : ok({ revision: 1 }));
  store.workspace = undefined; store.bootstrap.preferences.language = 'en'; store.unknown = { action: 'preferences', operationId: 'preference-op', payload: { language: 'zh-CN' } };
  await store.reconnect(); assert.equal(store.locale, 'zh-CN'); assert.deepEqual(calls.map(call => call.action), ['operation']);
});
test('not-found mutation is replayed only by explicit action with the original operation ID', async () => {
  const { store, calls } = fixture(async request => request.action === 'operation' ? ok({ status: 'not-found' }) : request.action === 'saveView' ? ok({ revision: 1 }) : ok(workspace()));
  const payload = { files: [{ path: 'x', fingerprint: 'f', checked: true }] };
  store.unknown = { protocol: 1, capability: 'old', viewId: 'old-view', workspaceId: 'workspace', context, action: 'mark', operationId: 'same-operation', payload };
  await assert.rejects(store.reconnect()); assert.equal(calls.some(call => call.action === 'mark'), false);
  await store.retryUnknown(); const write = calls.find(call => call.action === 'mark'); assert.equal(write.operationId, 'same-operation'); assert.deepEqual(write.payload, payload); assert.equal(store.unknown, undefined);
});
test('not-found save explicitly retains the latest buffer in a new view operation', async () => {
  const { store, calls } = fixture(async request => request.action === 'operation' ? ok({ status: 'not-found' }) : request.action === 'openWorkspace' ? ok(workspace()) : ok({ revision: 1 }));
  store.unknown = { protocol: 1, action: 'saveView', operationId: 'old-save', context, payload: { expectedRevision: 7, sequence: 8, reviewId: 'review', navigation: navigation(), drafts: [] } };
  store.drafts = [{ id: 'd', target: { type: 'file', path: 'a.ts' }, body: 'newest text', requestId: 'request' }];
  await assert.rejects(store.reconnect()); await store.retryUnknown(); const write = calls.find(call => call.action === 'saveView');
  assert.notEqual(write.operationId, 'old-save'); assert.equal(write.payload.expectedRevision, 0); assert.equal(write.payload.drafts[0].body, 'newest text');
});
test('pending save retries the original payload, then retains newer input under the new view CAS', async () => {
  const { store, calls, bridge } = fixture(async request => request.action === 'operation' ? ok({ status: 'pending' }) : request.action === 'openWorkspace' ? ok({ ...workspace(), context: { ...context, epoch: 'restarted-epoch' } }) : ok({ revision: request.operationId === 'old-save' ? 99 : 1, sequence: 99, drafts: [] }));
  bridge.bootstrap = async () => ok({ ...boot('reconnected-view'), epoch: 'restarted-epoch' });
  const payload = { expectedRevision: 7, sequence: 8, reviewId: 'review', navigation: navigation(), drafts: [] };
  store.unknown = { protocol: 1, action: 'saveView', operationId: 'old-save', context, payload };
  store.drafts = [{ id: 'd', target: { type: 'file', path: 'a.ts' }, body: 'newer text', requestId: 'request' }];
  await assert.rejects(store.reconnect()); assert.equal(store.unknownState, 'pending'); await store.retryUnknown();
  const writes = calls.filter(call => call.action === 'saveView'); assert.equal(writes.length, 2); assert.equal(writes[0].operationId, 'old-save'); assert.deepEqual(writes[0].payload, payload);
  assert.equal(writes[1].payload.expectedRevision, 0); assert.equal(writes[1].payload.drafts[0].body, 'newer text'); assert.equal(store.drafts[0].body, 'newer text'); assert.equal(store.viewRevision, 1);
  assert.equal(writes[1].context.epoch, 'restarted-epoch');
});
test('bridge accepts only parent replies, emits standard initialization and reads component meta', async () => {
  const sent = []; let receive;
  const surface = { parent: { postMessage: message => sent.push(message) }, addEventListener: (_type, listener) => { receive = listener; }, removeEventListener: () => {} };
  const bridge = new Bridge(surface, 100);
  const initialized = bridge.initialize();
  assert.equal(sent[0].params.protocolVersion, '2026-01-26');
  assert.equal(sent[0].params.appInfo.version, 'development');
  receive({ source: {}, data: { jsonrpc: '2.0', id: sent[0].id, result: { hostContext: { locale: 'bad' } } } });
  receive({ source: surface.parent, data: { jsonrpc: '2.0', id: sent[0].id, result: { hostContext: { locale: 'zh-CN' } } } }); await initialized;
  assert.equal(bridge.context.locale, 'zh-CN'); assert.equal(sent[1].method, 'ui/notifications/initialized');
  const result = bridge.bootstrap(); const request = sent.at(-1); assert.equal(request.params.name, 'reviewslate_bootstrap');
  receive({ source: surface.parent, data: { jsonrpc: '2.0', id: request.id, result: { _meta: { reviewslate: ok(boot()) } } } }); assert.equal((await result).data.capability, 'token'); bridge.destroy();
});
test('bridge timeout is unknown and does not resend', async () => {
  const sent = [], surface = { parent: { postMessage: message => sent.push(message) }, addEventListener() {}, removeEventListener() {} };
  const bridge = new Bridge(surface, 5); await assert.rejects(bridge.bootstrap(), /UNKNOWN_RESULT/); assert.equal(sent.length, 1); bridge.destroy();
});
