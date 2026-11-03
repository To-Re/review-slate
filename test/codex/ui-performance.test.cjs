const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { buildSync } = require('esbuild');
const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewslate-ui-performance-'));
buildSync({ entryPoints: ['web/codex/model.ts', 'web/codex/store.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: compiled, logLevel: 'silent' });
const { ReviewTree, summarize, refreshDelay } = require(path.join(compiled, 'model.js'));
const { Store } = require(path.join(compiled, 'store.js'));
test.after(() => fs.rmSync(compiled, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const ok = data => ({ protocol: 1, ok: true, outcome: 'read', data });
const boot = () => ({ capability: 'synthetic', viewId: 'view', epoch: 'epoch', preferences: { language: 'en', recent: [] } });
const row = (name, overrides = {}) => ({ path: name, fingerprint: name, status: 'pending', change: 'modified', commentOnly: false, deletedOnly: false, leftMode: '100644', rightMode: '100644', leftBytes: 3, rightBytes: 3, ...overrides });
const context = { workspaceId: 'workspace', epoch: 'epoch', reviewId: 'review', branch: 'main', base: 'base', revision: 'one' };
const source = { text: 'sample', mode: '100644', hash: 'sample', bytes: 6, textContent: true };
const diff = (name, overrides = {}) => ({ target: { type: 'file', path: name }, fingerprint: name, mode: 'full', side: 'right', context: { ...context }, comments: [], left: source, right: source, ...overrides });
const workspace = (files = [row('src/a.ts'), row('src/b.ts')], comments = []) => ({ workspace: { id: 'workspace', name: 'sample', root: '/synthetic/sample', initialized: true }, active: { id: 'review', base: 'base', label: 'main', branch: { key: 'main', label: 'main' } }, branch: { key: 'main', label: 'main' }, context: { ...context }, revision: 'one', files, comments, reviews: [] });
function fixture(handler) {
  const calls = [], store = new Store({ context: {}, call: async request => { calls.push(structuredClone(request)); return handler(request); } });
  store.bootstrap = boot(); store.apply(workspace()); store.savedSequence = store.sequence; store.saveState = 'saved';
  return { store, calls };
}

test('tree index matches review, error and comment counts without including deleted/comment-only objects in the denominator', () => {
  const files = [row('src/a.ts', { status: 'reviewed' }), row('src/deep/b.ts', { status: 'changed', error: 'synthetic read error' }), row('src/old.ts', { commentOnly: true }), row('src2/c.ts')];
  const comments = [
    { id: 'one', path: 'src/deep', target: 'directory', state: 'open', deleted: false },
    { id: 'two', path: 'src/a.ts', target: 'file', state: 'resolved', deleted: false },
    { id: 'three', path: 'src/a.ts', target: 'file', state: 'open', deleted: true },
    { id: 'four', path: 'notes/only.ts', target: 'file', state: 'open', deleted: false, reply: { matches: true } },
  ];
  const tree = new ReviewTree(files, comments);
  for (const name of ['src', 'src/deep', 'src/a.ts', 'src/old.ts', 'src2', 'notes', 'notes/only.ts']) {
    const { errors, ...summary } = tree.summary(name);
    assert.deepEqual(summary, summarize(files, comments, name));
    assert.equal(errors, name === 'src' || name === 'src/deep' ? 1 : 0);
  }
  assert.deepEqual(tree.members({ type: 'directory', path: 'src' }), files.slice(0, 2));
  assert.deepEqual(tree.members({ type: 'file', path: 'src/old.ts' }), []);
  const matches = [...tree.eligible('b.ts', true)].map(node => node.target.path).sort();
  assert.deepEqual(matches, ['src', 'src/deep', 'src/deep/b.ts']);
  assert.equal([...tree.eligible('', true)].some(node => node.target.path === 'src/a.ts'), false);
  assert.equal([...tree.eligible('', true)].some(node => node.target.path === 'notes/only.ts'), true);
});

test('51,000 changed files are indexed and filtered with bounded path visits', t => {
  let visits = 0;
  const count = 51000, files = Array.from({ length: count }, (_, index) => {
    const value = row(`idl/group-${index % 100}/value-${index}.thrift`, { status: index % 3 === 0 ? 'reviewed' : 'pending' });
    const name = value.path; Object.defineProperty(value, 'path', { enumerable: true, get() { visits++; return name; } }); return value;
  });
  const started = performance.now(), tree = new ReviewTree(files, []), indexed = performance.now();
  const visible = tree.eligible('value-50999.thrift', true);
  assert.equal(tree.total.total, count); assert.equal(tree.total.reviewed, 17000);
  assert.equal(visible.size, 3); assert.equal(tree.summary('idl/group-99').total, 510);
  assert.ok(visits < count * 15, `Expected linear file access, got ${visits} visits for ${count} files`);
  t.diagnostic(JSON.stringify({ files: count, indexMs: +(indexed - started).toFixed(2), filterMs: +(performance.now() - indexed).toFixed(2), pathVisits: visits }));
});

test('fresh identical projections retain render lists, but file and comment updates invalidate their data', () => {
  const { store } = fixture(() => {}), original = store.workspace;
  store.apply(structuredClone(original));
  assert.equal(store.workspace.files, original.files); assert.equal(store.workspace.comments, original.comments);
  const updated = structuredClone(store.workspace); updated.files[0].status = 'reviewed'; updated.comments.push({ id: 'comment', body: 'synthetic', deleted: false }); updated.context.revision = 'two';
  store.apply(updated);
  assert.notEqual(store.workspace.files, original.files); assert.notEqual(store.workspace.comments, original.comments); assert.equal(store.workspace.context.revision, 'two');
});

test('refresh coalesces concurrent callers and never drops a file selection or dirty draft during a slow scan', async () => {
  const scan = deferred(); let revision = 0;
  const { store, calls } = fixture(request => request.action === 'refresh' ? scan.promise : request.action === 'saveView' ? ok({ revision: ++revision }) : ok(diff(request.payload.path)));
  const first = store.refresh(); assert.equal(store.refresh(), first); await tick();
  assert.equal(store.refreshing, true); assert.equal(store.busy, false);
  store.drafts = [{ id: 'draft', requestId: 'request', target: { type: 'file', path: 'src/a.ts' }, body: 'Retain this input' }]; store.touch();
  await store.select({ type: 'file', path: 'src/b.ts' });
  assert.equal(store.diff.target.path, 'src/b.ts'); assert.equal(store.drafts[0].body, 'Retain this input');
  assert.equal(calls.findIndex(call => call.action === 'saveView') < calls.findIndex(call => call.action === 'diff'), true);
  scan.resolve(ok(workspace())); await first; await store.flush();
  assert.equal(store.navigation.target.path, 'src/b.ts'); assert.equal(store.diff.target.path, 'src/b.ts');
  assert.equal(store.drafts[0].body, 'Retain this input'); assert.equal(store.refreshing, false); assert.equal(store.saveState, 'saved');
  assert.equal(calls.filter(call => call.action === 'refresh').length, 1);
});

test('same in-flight Diff is read once, and its older context cannot overwrite an adopted projection', async () => {
  const read = deferred(), { store, calls } = fixture(() => read.promise);
  store.navigation.target = { type: 'file', path: 'src/a.ts' };
  const first = store.loadDiff(); assert.equal(store.loadDiff(), first);
  const updated = workspace(); updated.context.revision = 'new-projection'; store.apply(updated);
  read.resolve(ok(diff('src/a.ts'))); await first;
  assert.equal(store.workspace.context.revision, 'new-projection'); assert.equal(store.diff.target.path, 'src/a.ts');
  assert.equal(calls.length, 1); assert.equal(store.loadingDiff, false);
});

test('late refresh success or failure cannot overwrite a newer workspace or its errors', async () => {
  for (const failed of [false, true]) {
    const scan = deferred(), { store } = fixture(request => request.action === 'refresh' ? scan.promise : ok({ revision: 1 }));
    const reading = store.refresh(); await tick();
    const replacement = workspace(); replacement.workspace.id = 'other'; replacement.active.id = 'other-review'; store.apply(replacement);
    const currentError = { code: 'IO_FAILED' }; store.error = currentError;
    scan.resolve(failed ? { protocol: 1, ok: false, outcome: 'rejected', error: { code: 'STALE_CONTEXT' } } : ok(workspace()));
    await reading; await store.flush();
    assert.equal(store.workspace, replacement); assert.equal(store.error, currentError); assert.equal(store.refreshing, false);
  }
});

test('a failed mutation supersedes an older scan even when it keeps the same workspace', async () => {
  const scan = deferred(), failure = { code: 'REVISION_CONFLICT', outcome: 'rejected', retry: 'refresh', message: 'synthetic conflict' };
  const { store } = fixture(request => request.action === 'refresh' ? scan.promise : { protocol: 1, ok: false, outcome: 'rejected', error: failure });
  const reading = store.refresh(); await tick(); const original = store.workspace;
  await assert.rejects(store.mutate('mark', { files: [] }));
  scan.resolve(ok(workspace())); await reading;
  assert.equal(store.workspace, original); assert.equal(store.error, failure);
});

test('a new projection rereads the selected Diff instead of reusing an older in-flight version', async () => {
  const older = deferred(), refreshed = workspace(); refreshed.context.revision = 'new-projection';
  const { store, calls } = fixture(request => request.action === 'refresh' ? ok(refreshed) : request.context.revision === 'one' ? older.promise : ok(diff('src/a.ts', { context: request.context, right: { ...source, hash: 'new-snapshot' } })));
  store.navigation.target = { type: 'file', path: 'src/a.ts' }; const previous = store.loadDiff();
  await store.refresh(); assert.equal(store.diff.right.hash, 'new-snapshot'); assert.equal(store.loadingDiff, false);
  older.resolve({ protocol: 1, ok: false, outcome: 'rejected', error: { code: 'CONTENT_CHANGED' } }); await previous;
  assert.equal(store.diff.right.hash, 'new-snapshot'); assert.equal(store.workspace.context.revision, 'new-projection');
  assert.equal(store.stale, false); assert.equal(calls.filter(call => call.action === 'diff').length, 2);
});

test('changed file is shown immediately, guarded until one fresh projection completes, with drafts retained', async () => {
  const scan = deferred(); let revision = 0;
  const { store, calls } = fixture(request => request.action === 'refresh' ? scan.promise : request.action === 'saveView' ? ok({ revision: ++revision }) : ok(diff('src/a.ts', { fingerprint: 'new-content', context: request.context })));
  store.drafts = [{ id: 'draft', requestId: 'request', target: { type: 'file', path: 'src/a.ts' }, body: 'Keep draft' }];
  store.navigation.target = { type: 'file', path: 'src/a.ts' }; await store.loadDiff(); await tick();
  assert.equal(store.diff.fingerprint, 'new-content'); assert.equal(store.writable, false); assert.equal(store.error.code, 'CONTENT_CHANGED');
  const refreshed = workspace(); refreshed.files[0].fingerprint = 'new-content'; refreshed.context.revision = 'fresh';
  scan.resolve(ok(refreshed)); await store.refresh();
  assert.equal(store.writable, true); assert.equal(store.error, undefined); assert.equal(store.workspace.context.revision, 'fresh');
  assert.equal(store.drafts[0].body, 'Keep draft'); assert.equal(calls.filter(call => call.action === 'refresh').length, 1);
});

test('continuing content churn during refresh stays guarded without a refresh loop', async () => {
  const { store, calls } = fixture(request => request.action === 'refresh' ? ok(workspace()) : ok(diff('src/a.ts', { fingerprint: 'new-content' })));
  store.navigation.target = { type: 'file', path: 'src/a.ts' }; await store.refresh(); await tick();
  assert.equal(store.stale, true); assert.equal(store.error.code, 'CONTENT_CHANGED'); assert.equal(calls.filter(call => call.action === 'refresh').length, 1);
});

test('refresh completion schedules breathing room while keeping a bounded content-check interval', () => {
  assert.equal(refreshDelay(20), 5000); assert.equal(refreshDelay(10000), 20000); assert.equal(refreshDelay(45000), 60000);
});

// DOM contract harness: exercises the actual app render functions without an editor window or host UI.
// The Diff widget is replaced with a read-only stub; this is not a browser/CodeMirror layout test.
function appHarness() {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.className = ''; this.scrollTop = 0; this.replacements = 0; this.listeners = new Map(); this.value = ''; }
    get classList() { return { contains: name => this.className.split(' ').includes(name), add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); }, toggle: (name, yes = !this.classList.contains(name)) => { this.classList[yes ? 'add' : 'remove'](name); return yes; } }; }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
    get isConnected() { return this === document.documentElement || !!this.parent?.isConnected; }
    get disabled() { return !!this._disabled; }
    set disabled(value) { this._disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; }
    set textContent(value) { this.text = value; this.children.forEach(child => { child.parent = undefined; }); this.children = []; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { if (child.tagName === '#fragment') { this.append(...child.children); continue; } child.remove(); child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; } }
    replaceChildren(...children) { this.replacements++; this.children.forEach(child => { child.parent = undefined; }); this.children = []; this.append(...children); }
    replaceWith(next) { const parent = this.parent, index = parent.children.indexOf(this); next.remove(); parent.children[index] = next; next.parent = parent; this.parent = undefined; }
    insertBefore(child, before) { child.remove(); const index = this.children.indexOf(before); child.parent = this; this.children.splice(index < 0 ? this.children.length : index, 0, child); }
    setAttribute(name, value) { this.attributes[name] = value; if (name === 'class') this.className = value; if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, action) { this.listeners.set(name, action); }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    matches(selector) { return selector.split(',').some(part => part.startsWith('.') ? this.classList.contains(part.slice(1)) : part.startsWith('#') ? this.id === part.slice(1) : part.startsWith('[') ? [...part.matchAll(/\[([^\]]+)\]/g)].every(([, name]) => name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset : name in this.attributes) : this.tagName === part); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    focus() { if (this.disabled || document.activeElement === this) return; document.activeElement = this; document.dispatchEvent({ type: 'focusin', target: this }); }
    click() {
      if (this.disabled) return;
      if (this.tagName === 'label') { this.querySelector('input')?.click(); return; }
      this.focus(); this.listeners.get('click')?.({ target: this });
      if (this.tagName === 'input' && this.type === 'checkbox') { this.checked = !this.checked; this.listeners.get('change')?.({ target: this }); }
    }
  }
  const html = new Element('html'), body = new Element('body'), app = new Element('div'); app.id = 'app';
  const events = new Map(), windowEvents = new Map();
  document = { documentElement: html, body, activeElement: null, visibilityState: 'visible', createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createDocumentFragment: () => new Element('#fragment'),
    addEventListener(name, listener) { events.set(name, [...(events.get(name) || []), listener]); }, dispatchEvent(event) { for (const listener of events.get(event.type) || []) listener(event); },
    querySelector: selector => html.querySelector(selector), querySelectorAll: selector => html.querySelectorAll(selector) };
  html.append(body); body.append(app);
  const timers = new Map(); let nextTimer = 0;
  const window = { parent: { postMessage() {} }, addEventListener(name, listener) { windowEvents.set(name, [...(windowEvents.get(name) || []), listener]); },
    dispatchEvent(event) { for (const listener of windowEvents.get(event.type) || []) listener(event); }, removeEventListener() {} };
  const sourceCode = fs.readFileSync('web/codex/app.ts', 'utf8').replace("import { DiffEditor } from './diff';", 'class DiffEditor { constructor() {} setLabels() {} restore() { return true; } destroy() {} }');
  const bundle = buildSync({ stdin: { contents: sourceCode + '\nexport { store, render, treeBody, treeRows, renderTreeRows };', resolveDir: path.resolve('web/codex'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.svg': 'text' }, logLevel: 'silent' }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(bundle, { document, window, module, exports: module.exports, structuredClone, crypto, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id) });
  return { ...module.exports, document, window };
}

test('actual tree render retains 5,000 row nodes, focus and scroll on selection, saves and an unchanged refresh', async t => {
  const { store, render, treeBody, treeRows, document } = appHarness();
  store.bootstrap = boot(); store.bridge.call = async request => request.action === 'saveView' ? ok({ revision: 1 }) : ok(diff(request.payload.path));
  const files = Array.from({ length: 5000 }, (_, index) => row(`src/file-${index}.ts`));
  store.apply(workspace(files)); store.navigation.expanded = ['src']; render();
  const original = treeRows.get('file:src/file-4999.ts'), before = treeBody.replacements;
  original.label.focus(); treeBody.scrollTop = 9876;
  const started = performance.now(); await store.select({ type: 'file', path: 'src/file-4999.ts' }); await store.flush();
  store.busy = true; store.changed(); assert.equal(original.row.querySelector('input').disabled, true);
  store.busy = false; store.changed(); assert.equal(original.row.querySelector('input').disabled, false);
  store.apply(structuredClone(store.workspace));
  assert.equal(treeBody.replacements, before); assert.equal(treeRows.get('file:src/file-4999.ts').row, original.row);
  assert.equal(original.row.classList.contains('selected'), true); assert.equal(document.activeElement, original.label); assert.equal(treeBody.scrollTop, 9876);
  const elapsed = performance.now() - started;
  const updated = structuredClone(store.workspace); updated.files[4999].status = 'reviewed'; store.apply(updated);
  assert.equal(treeBody.replacements, before + 1); assert.equal(treeBody.scrollTop, 9876);
  assert.equal(treeRows.get('file:src/file-4999.ts').row.querySelector('input').checked, true);
  assert.equal(treeRows.get('directory:src').row.querySelector('input').indeterminate, true);
  store.bootstrap.preferences.language = 'zh-CN'; render();
  assert.match(treeRows.get('file:src/file-4999.ts').row.querySelector('input').getAttribute('aria-label'), /取消已审/);
  store.navigation.filter = 'file-4999.ts'; render(); assert.equal(treeRows.size, 2);
  store.navigation.expanded = []; render(); assert.equal(treeRows.size, 1);
  t.diagnostic(JSON.stringify({ renderedFiles: 5000, selectionSaveAndRefreshMs: +elapsed.toFixed(2), rowRebuildsForSelectionAndSave: 0 }));
});

test('directory arrow, native checkbox label and directory name remain independent and keep keyboard focus', async () => {
  const { store, render, treeBody, treeRows, document } = appHarness(), calls = []; let revision = 0;
  store.bootstrap = boot();
  store.bridge.call = async request => {
    calls.push(structuredClone(request));
    if (request.action === 'saveView') return ok({ revision: ++revision });
    if (request.action === 'mark') {
      const view = structuredClone(store.workspace);
      for (const item of request.payload.files) view.files.find(file => file.path === item.path).status = item.checked ? 'reviewed' : 'pending';
      return ok(view);
    }
    return ok(diff(request.payload.path));
  };
  store.apply(workspace([row('src/a.ts'), row('src/deep/b.ts')]));
  store.navigation.target = { type: 'file', path: 'src/a.ts' };
  store.drafts = [{ id: 'draft', requestId: 'request', target: { type: 'file', path: 'src/a.ts' }, body: 'Keep this draft' }]; render();
  const directory = () => treeRows.get('directory:src'), marks = () => calls.filter(call => call.action === 'mark');
  const originalTarget = structuredClone(store.navigation.target);

  // Native button activation on its own padding target, not on the small SVG.
  directory().row.querySelector('.tree-toggle').click();
  assert.deepEqual(Array.from(store.navigation.expanded), ['src']); assert.equal(marks().length, 0);
  assert.deepEqual(store.navigation.target, originalTarget); assert.equal(store.drafts[0].body, 'Keep this draft');
  assert.equal(document.activeElement, directory().row.querySelector('.tree-toggle'));
  assert.equal(document.activeElement.getAttribute('aria-expanded'), 'true');
  document.activeElement.click();
  assert.equal(store.navigation.expanded.length, 0); assert.equal(document.activeElement.getAttribute('aria-expanded'), 'false');

  directory().label.focus();
  treeBody.listeners.get('keydown')({ target: directory().label, key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(Array.from(store.navigation.expanded), ['src']); assert.equal(document.activeElement, directory().label);
  treeBody.listeners.get('keydown')({ target: directory().label, key: 'ArrowLeft', preventDefault() {} });
  assert.equal(store.navigation.expanded.length, 0); assert.equal(document.activeElement, directory().label); assert.equal(marks().length, 0);

  const slot = directory().row.querySelector('.tree-check');
  assert.equal(slot.tagName, 'label'); assert.equal(slot.listeners.has('click'), false);
  slot.click(); await tick();
  assert.equal(marks().length, 1); assert.equal(marks()[0].payload.directory, 'src'); assert.equal(marks()[0].payload.files.length, 2);
  assert.equal(store.navigation.expanded.length, 0); assert.deepEqual(store.navigation.target, originalTarget);
  assert.equal(document.activeElement, directory().row.querySelector('input'));
  assert.equal(document.activeElement.checked, true);

  directory().label.click(); await tick();
  assert.equal(store.navigation.target.type, 'directory'); assert.equal(store.navigation.target.path, 'src');
  assert.equal(store.navigation.expanded.length, 0); assert.equal(marks().length, 1);
  assert.equal(store.drafts.find(draft => draft.id === 'draft').body, 'Keep this draft');
  store.busy = true; store.changed();
  const disabled = directory().row.querySelector('.tree-check'); assert.equal(disabled.dataset.disabled, 'true');
  disabled.click(); await tick(); assert.equal(marks().length, 1);
});

test('native disabled blur restores the originating checkbox after confirmation or a retryable failure', async () => {
  for (const failed of [false, true]) {
    const { store, render, treeRows, document } = appHarness(), saving = deferred(); let revision = 0;
    store.bootstrap = boot(); store.bridge.call = async request => request.action === 'mark' ? saving.promise : request.action === 'saveView' ? ok({ revision: ++revision }) : ok(diff(request.payload.path));
    store.apply(workspace()); store.navigation.expanded = ['src']; store.navigation.target = { type: 'file', path: 'src/a.ts' }; render();
    const original = treeRows.get('file:src/a.ts').row.querySelector('input'); original.click(); await tick();
    assert.equal(original.disabled, true); assert.equal(document.activeElement, document.body, 'Harness must model the native disable-induced blur');
    const updated = structuredClone(store.workspace); updated.files[0].status = 'reviewed';
    saving.resolve(failed ? { protocol: 1, ok: false, outcome: 'rejected', error: { code: 'IO_FAILED', message: 'synthetic save failure', outcome: 'rejected', retry: 'same-operation' } } : ok(updated));
    await tick();
    const current = treeRows.get('file:src/a.ts').row.querySelector('input');
    assert.equal(current.disabled, false); assert.equal(document.activeElement, current);
    assert.equal(current.checked, !failed);
  }
});

test('pending checkbox save never takes focus back after other interaction or changed review context', async () => {
  for (const intent of ['input', 'pointerdown', 'keydown', 'wheel', 'scroll', 'leave-view', 'hidden', 'selection', 'stale']) {
    const { store, render, treeRows, treeBody, document, window } = appHarness(), saving = deferred(); let revision = 0;
    store.bootstrap = boot(); store.bridge.call = async request => request.action === 'mark' ? saving.promise : request.action === 'saveView' ? ok({ revision: ++revision }) : ok(diff(request.payload.path));
    store.apply(workspace()); store.navigation.expanded = ['src']; store.navigation.target = { type: 'file', path: 'src/a.ts' }; render();
    treeRows.get('file:src/a.ts').row.querySelector('input').click(); await tick();
    assert.equal(document.activeElement, document.body);
    if (intent === 'input') { const input = document.createElement('input'); document.body.append(input); input.focus(); }
    if (['pointerdown', 'keydown', 'wheel'].includes(intent)) document.dispatchEvent({ type: intent, key: 'Tab', target: document.body });
    if (intent === 'scroll') treeBody.scrollTop = 100;
    if (intent === 'leave-view') window.dispatchEvent({ type: 'blur' });
    if (intent === 'hidden') { document.visibilityState = 'hidden'; document.dispatchEvent({ type: 'visibilitychange' }); }
    if (intent === 'selection') store.navigation.target = { type: 'directory', path: 'src' };
    const before = document.activeElement, updated = structuredClone(store.workspace); updated.files[0].status = 'reviewed';
    saving.resolve(intent === 'stale' ? { protocol: 1, ok: false, outcome: 'rejected', error: { code: 'STALE_CONTEXT', message: 'synthetic stale review', outcome: 'rejected', retry: 'refresh' } } : ok(updated));
    await tick(); assert.equal(document.activeElement, before, intent);
    if (intent === 'stale') assert.equal(treeRows.get('file:src/a.ts').row.querySelector('input').disabled, true);
  }
});
