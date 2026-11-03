'use strict';
// Real short-lived subprocesses, but synthetic helper executables only: automated tests never open UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { FolderPicker } = require('../../dist/codex/folder-picker');
const { CodexController } = require('../../dist/codex/controller');
const nativeTest = process.platform === 'darwin' ? test : test.skip;
async function fixture(t, script = "setInterval(() => {}, 1000);") {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reviewslate-folder-pick-')));
  const executable = path.join(temp, 'synthetic-helper'), log = path.join(temp, 'started.json');
  await fs.writeFile(executable, '#!' + process.execPath + '\n' +
    `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\n` + script, { mode: 0o700 });
  const disposals = [];
  t.after(async () => { for (const p of disposals) await p.close(); await fs.rm(temp, { recursive: true, force: true }); });
  return { temp, executable, log, disposals };
}
async function until(action, test = value => value.status !== 'pending') {
  for (let i = 0; i < 200; i++) { const value = await action(); if (test(value)) return value; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Synthetic helper did not finish');
}
async function started(log) { return until(async () => { try { return JSON.parse(await fs.readFile(log, 'utf8')); } catch { return undefined; } }, Boolean); }
function stopped(pid) { assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH'); }

nativeTest('folder selection starts quickly, same-ID replay is idempotent, views cannot steal/cancel selections', async t => {
  const f = await fixture(t), p = new FolderPicker({ executable: f.executable }); f.disposals.push(p);
  const id = randomUUID(); assert.equal((await p.start('one', id, 'zh-CN', f.temp)).status, 'pending');
  const spawned = await started(f.log); assert.deepEqual(spawned.args.slice(0, 2), ['--locale', 'zh-CN']);
  assert.equal(spawned.args.at(-1), f.temp);
  assert.equal((await p.start('one', id, 'en')).status, 'pending');
  assert.equal(JSON.parse(await fs.readFile(f.log)).pid, spawned.pid);
  assert.equal((await p.start('two', randomUUID(), 'en')).reason, 'busy');
  assert.throws(() => p.result('two', id), error => error.code === 'ACCESS_DENIED');
  await assert.rejects(p.cancel('two', id), error => error.code === 'ACCESS_DENIED');
  assert.equal((await p.cancel('one', id)).status, 'cancelled'); stopped(spawned.pid);
  assert.equal((await p.start('one', id, 'en')).status, 'cancelled');
  assert.equal((await p.start('two', randomUUID(), 'en')).status, 'pending');
});

nativeTest('cancel before a delayed start prevents the chooser from launching', async t => {
  const f = await fixture(t), p = new FolderPicker({ executable: f.executable }); f.disposals.push(p);
  const id = randomUUID(); assert.equal((await p.cancel('one', id)).status, 'cancelled');
  assert.equal((await p.start('one', id, 'en')).status, 'cancelled');
  await assert.rejects(fs.stat(f.log), { code: 'ENOENT' });
  await assert.rejects(p.start('two', id, 'en'), error => error.code === 'ACCESS_DENIED');
});

nativeTest('selection results and cancellation never wait for I/O on user volumes', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.executable, '#!' + process.execPath + '\nconsole.log(' + JSON.stringify(JSON.stringify({ version: 1, status: 'selected', path: f.temp })) + ');\n', { mode: 0o700 });
  const p = new FolderPicker({ executable: f.executable }); f.disposals.push(p);
  const id = randomUUID(), original = fs.stat; let calls = 0;
  fs.stat = async function(file) { if (file === f.temp) { calls++; return new Promise(() => {}); } return original.apply(this, arguments); };
  try {
    await p.start('one', id, 'en', f.temp);
    assert.equal((await until(() => p.result('one', id))).status, 'selected');
    await p.cancel('one', id); await p.close(); assert.equal(calls, 0);
  } finally { fs.stat = original; }
});

nativeTest('timeout and lost-view lease terminate the helper, release the slot, and allow another selection', async t => {
  for (const mode of ['timeout', 'lease']) {
    const f = await fixture(t), p = new FolderPicker({ executable: f.executable, timeoutMs: mode === 'timeout' ? 1200 : 10_000, leaseMs: mode === 'lease' ? 1200 : 10_000 }); f.disposals.push(p);
    const id = randomUUID(); await p.start('one', id, 'en'); const spawned = await started(f.log);
    if (mode === 'lease') await new Promise(r => setTimeout(r, 2500));
    const result = await until(() => p.result('one', id));
    assert.equal(result.status, mode === 'timeout' ? 'timed-out' : 'cancelled');
    await p.cancel('one', id); stopped(spawned.pid);
    assert.equal((await p.start('one', randomUUID(), 'en')).status, 'pending');
  }
});

nativeTest('controller close terminates an active helper and cancellation never writes recent projects or operation receipts', async t => {
  const f = await fixture(t), dataRoot = path.join(f.temp, 'application');
  const c = new CodexController({ dataRoot, folderPicker: { executable: f.executable } }); f.disposals.push(c);
  const boot = await c.bootstrap(); assert.equal(boot.capabilities.folderPicker, true);
  const id = randomUUID(), request = action => ({ protocol: 1, action, payload: action === 'pickFolder' ? { requestId: id, locale: 'en' } : { requestId: id }, capability: boot.capability, viewId: boot.viewId });
  assert.equal((await c.dispatch(request('pickFolder'))).outcome, 'read'); const spawned = await started(f.log);
  assert.equal((await c.dispatch(request('cancelFolderPicker'))).data.status, 'cancelled'); stopped(spawned.pid);
  assert.deepEqual((await c.bootstrap()).preferences.recent, []);
  await assert.rejects(fs.stat(dataRoot), { code: 'ENOENT' });
  const next = request('pickFolder'); next.payload.requestId = randomUUID(); await fs.unlink(f.log);
  await c.dispatch(next); const restarted = await started(f.log); await c.close(); stopped(restarted.pid);
});

nativeTest('selected subdirectory remains inert until existing openWorkspace validates and opens its Git root', async t => {
  const f = await fixture(t), repo = path.join(f.temp, 'synthetic-git'), sub = path.join(repo, 'nested'); await fs.mkdir(sub, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
  git('init', '-qb', 'main'); await fs.writeFile(path.join(repo, 'sample.txt'), 'synthetic\n'); git('add', '.'); git('commit', '-qm', 'synthetic');
  await fs.writeFile(f.executable, '#!' + process.execPath + '\nconsole.log(' + JSON.stringify(JSON.stringify({ version: 1, status: 'selected', path: sub })) + ');\n', { mode: 0o700 });
  const c = new CodexController({ dataRoot: path.join(f.temp, 'application'), folderPicker: { executable: f.executable } }); f.disposals.push(c);
  const boot = await c.bootstrap(), id = randomUUID();
  const req = (action, payload) => ({ protocol: 1, action, payload, capability: boot.capability, viewId: boot.viewId });
  await c.dispatch(req('pickFolder', { requestId: id, locale: 'en' }));
  const selected = await until(async () => (await c.dispatch(req('folderPickerResult', { requestId: id }))).data);
  assert.deepEqual(selected, { requestId: id, status: 'selected', root: sub });
  assert.deepEqual((await c.bootstrap()).preferences.recent, []);
  const opened = await c.dispatch({ ...req('openWorkspace', { root: selected.root, initialize: false }), operationId: randomUUID() });
  assert.equal(opened.ok, true, JSON.stringify(opened.error)); assert.equal(opened.data.workspace.root, repo);
  assert.equal((await c.bootstrap()).preferences.recent.length, 1);
  await assert.rejects(fs.stat(path.join(repo, '.reviewslate')), { code: 'ENOENT' });
  // An invalid helper can return a file path; the chooser never treats it as repository authority.
  const wrongPath = path.join(repo, 'sample.txt');
  await fs.writeFile(f.executable, '#!' + process.execPath + '\nconsole.log(' + JSON.stringify(JSON.stringify({ version: 1, status: 'selected', path: wrongPath })) + ');\n', { mode: 0o700 });
  const second = randomUUID(); await c.dispatch(req('pickFolder', { requestId: second, locale: 'en' }));
  assert.equal((await until(async () => (await c.dispatch(req('folderPickerResult', { requestId: second }))).data)).root, wrongPath);
  const rejected = await c.dispatch({ ...req('openWorkspace', { root: wrongPath, initialize: false }), operationId: randomUUID() });
  assert.equal(rejected.ok, false); assert.equal((await c.bootstrap()).preferences.recent.length, 1);
  const same = await c.dispatch({ ...req('refresh', {}), workspaceId: opened.data.workspace.id });
  assert.equal(same.data.workspace.root, repo);
});

nativeTest('authenticated chooser polling and cancellation bypass another view’s slow business queue', async t => {
  const f = await fixture(t), c = new CodexController({ dataRoot: path.join(f.temp, 'application'), folderPicker: { executable: f.executable, leaseMs: 1000, timeoutMs: 10_000 } }); f.disposals.push(c);
  const a = await c.bootstrap(), b = await c.bootstrap(), id = randomUUID();
  const req = (boot, action, payload) => ({ protocol: 1, capability: boot.capability, viewId: boot.viewId, action, payload });
  await c.dispatch(req(a, 'pickFolder', { requestId: id, locale: 'en' })); const spawned = await started(f.log);
  const original = c.registry.update.bind(c.registry); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  c.registry.update = async (...args) => { entered(); await gate; return original(...args); };
  const business = c.dispatch({ ...req(b, 'preferences', { language: 'zh-CN' }), operationId: randomUUID() }); await waiting;
  const safety = setTimeout(release, 5000);
  try {
    for (let i = 0; i < 20; i++) {
      const result = await c.dispatch(req(a, 'folderPickerResult', { requestId: id })); assert.equal(result.data.status, 'pending');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await c.dispatch(req(a, 'cancelFolderPicker', { requestId: id }))).data.status, 'cancelled'); stopped(spawned.pid);
  } finally { clearTimeout(safety); release(); await business; c.registry.update = original; }
});

nativeTest('malformed, oversized, relative and missing helper results fail without opening a repository', async t => {
  const scripts = ["console.log('not-json');", "console.log('x'.repeat(20000));", "console.log(JSON.stringify({version:1,status:'selected',path:'relative-folder'}));"];
  for (const script of scripts) {
    const f = await fixture(t, script), p = new FolderPicker({ executable: f.executable }); f.disposals.push(p);
    const id = randomUUID(); await p.start('one', id, 'en');
    assert.equal((await until(() => p.result('one', id))).reason, 'invalid-result');
  }
  const f = await fixture(t), missing = new FolderPicker({ executable: path.join(f.temp, 'missing') }); f.disposals.push(missing);
  assert.equal(await missing.available(), false);
  assert.equal((await missing.start('one', randomUUID(), 'en')).reason, 'unavailable');
  const link = path.join(f.temp, 'link'); await fs.symlink(f.executable, link);
  assert.equal(await new FolderPicker({ executable: link }).available(), false);
});

nativeTest('UI chooser timeout leaves review drafts, error state and unknown mutation ownership unchanged', async t => {
  const f = await fixture(t), out = path.join(f.temp, 'ui');
  require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../../web/codex/store.ts')], outdir: out, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
  const { Store } = require(path.join(out, 'store.js'));
  let called;
  const store = new Store({ context: {}, call: async request => { called = request; throw new Error('Synthetic lost UI response'); } });
  store.bootstrap = { capability: 'synthetic', viewId: randomUUID(), preferences: { language: 'en', recent: [] } };
  store.drafts = [{ body: 'Existing review draft' }]; store.error = { code: 'CONTENT_CHANGED' }; store.unknown = { operationId: 'existing-save' };
  await assert.rejects(store.folderPicker('pickFolder', randomUUID()));
  assert.equal(called.operationId, undefined); assert.equal(store.unknown.operationId, 'existing-save');
  assert.equal(store.error.code, 'CONTENT_CHANGED'); assert.equal(store.drafts[0].body, 'Existing review draft');
});

nativeTest('real MCP stdio keeps picker paths app-only and EOF reaps an active helper', async t => {
  const f = await fixture(t), child = spawn(process.execPath, [path.resolve(__dirname, '../../dist/codex/server.js')], {
    env: { ...process.env, REVIEW_SLATE_DATA_DIR: path.join(f.temp, 'application'), REVIEW_SLATE_FOLDER_PICKER: f.executable }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const reader = require('node:readline').createInterface({ input: child.stdout }), pending = new Map(); let next = 0;
  reader.on('line', line => { const reply = JSON.parse(line), entry = pending.get(reply.id); if (entry) { clearTimeout(entry.timer); pending.delete(reply.id); reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.result); } });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic stdio timeout')); }, 5000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-picker', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const declaration = (await rpc('tools/list', {})).tools.find(tool => tool.name === 'reviewslate_folder_pick');
  assert.deepEqual(declaration._meta.ui.visibility, ['app']);
  const boot = (await rpc('tools/call', { name: 'reviewslate_bootstrap', arguments: {} }))._meta.reviewslate.data;
  const response = await rpc('tools/call', { name: 'reviewslate_folder_pick', arguments: { request: {
    protocol: 1, capability: boot.capability, viewId: boot.viewId, action: 'pickFolder', payload: { requestId: randomUUID(), locale: 'en' }
  } } });
  assert.equal(response._meta.reviewslate.data.status, 'pending'); assert.equal(response.structuredContent, undefined);
  assert.equal(JSON.stringify(response.content).includes(f.temp), false);
  const spawned = await started(f.log); child.stdin.end();
  let timer;
  const ended = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 5000); })]);
  clearTimeout(timer); assert.deepEqual(ended, { code: 0, signal: null }); stopped(spawned.pid); reader.close();
});
