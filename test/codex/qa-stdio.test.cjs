'use strict';
// Real MCP stdio child processes, synthetic repositories and isolated application data.
// A discarded reply models client-side loss; it is not a physical disk/power failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const runtimeRoot = process.env.REVIEW_SLATE_QA_DIST || path.resolve(__dirname, '../../dist');
const { ACTION_TO_TOOL } = require(path.join(runtimeRoot, 'codex/contract'));
const serverFile = path.join(runtimeRoot, 'codex/server.js');
const readActions = new Set(['refresh', 'bases', 'diff', 'inspectReview', 'operation']);

async function setup(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewslate-stdio-qa-'));
  const root = path.join(temp, 'synthetic-repo'), dataRoot = path.join(temp, 'application-data');
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'Synthetic QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(root, 'sample.txt'), 'synthetic baseline\n');
  git('add', '-A'); git('commit', '-qm', 'synthetic base'); const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'feature'); await fs.writeFile(path.join(root, 'sample.txt'), 'synthetic changed content\n');
  const processes = [];
  t.after(async () => { for (const p of processes) await p.stop(); await fs.rm(temp, { recursive: true, force: true }); });
  async function connect() {
    const child = spawn(process.execPath, [serverFile], { cwd: temp,
      env: { ...env, REVIEW_SLATE_DATA_DIR: dataRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); let serial = 0, stderr = '', protocolError;
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { protocolError = 'Non-JSON stdout'; return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    });
    child.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
    const c = { child, view: undefined, bootstrap: undefined,
      rpc(method, params) {
        const id = ++serial;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic MCP timeout: ' + method + '; ' + stderr)); }, 15000);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      },
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
        child.stdin.end();
        let timer;
        const outcome = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 4000); })]);
        clearTimeout(timer);
        if (outcome) { reader.close(); return outcome; }
        child.kill('SIGKILL'); await exited; reader.close();
        return { code: null, signal: 'SIGKILL' };
      },
    };
    processes.push(c);
    await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reviewslate-synthetic-qa', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    c.tool = (name, args) => c.rpc('tools/call', { name, arguments: args });
    const boot = await c.tool('reviewslate_bootstrap', {}); assert.equal(boot._meta.reviewslate.ok, true);
    c.bootstrap = boot._meta.reviewslate.data;
    c.request = (action, payload = {}, override = {}) => ({ protocol: 1, action, payload,
      capability: c.bootstrap.capability, viewId: c.bootstrap.viewId,
      workspaceId: c.view?.workspace.id, context: c.view?.context,
      ...(!readActions.has(action) ? { operationId: randomUUID() } : {}), ...override });
    c.send = async request => {
      const raw = await c.tool(ACTION_TO_TOOL[request.action], { request });
      const reply = raw?._meta?.reviewslate;
      assert.ok(reply, 'missing component-only reply');
      if (reply.ok && reply.data?.workspace) c.view = reply.data;
      return { raw, reply };
    };
    c.call = (action, payload, override) => c.send(c.request(action, payload, override));
    c.ok = async (action, payload, override) => {
      const { reply } = await c.call(action, payload, override);
      assert.equal(reply.ok, true, action + ': ' + JSON.stringify(reply.error)); return reply.data;
    };
    c.open = (initialize = false) => c.ok('openWorkspace', { root, initialize });
    c.choose = () => c.ok('chooseBase', { kind: 'commit', ref: base, label: 'Synthetic base', expectedBranch: c.view.branch.key, expectedRevision: c.view.revision });
    c.assertProtocol = () => { assert.equal(protocolError, undefined); assert.equal(stderr, ''); };
    return c;
  }
  return { root, dataRoot, base, connect };
}

test('AC-11/12/15/17：真实 stdio 声明、组件资料边界、EOF 退出及丢响应后的新进程恢复', async t => {
  const env = await setup(t), first = await env.connect();
  const tools = (await first.rpc('tools/list', {})).tools;
  const open = tools.find(tool => tool.name === 'reviewslate_open'); assert.ok(open);
  for (const tool of tools.filter(tool => tool.name !== 'reviewslate_open')) assert.deepEqual(tool._meta.ui.visibility, ['app']);
  await first.open(true); await first.choose();
  const comment = 'Synthetic private component opinion ' + randomUUID();
  const added = await first.call('addComment', { target: { type: 'file', path: 'sample.txt' }, body: comment, requestId: randomUUID(), fingerprint: first.view.files.find(file => file.path === 'sample.txt').fingerprint });
  assert.equal(added.reply.ok, true);
  const modelFields = JSON.stringify({ content: added.raw.content, structuredContent: added.raw.structuredContent });
  assert.equal(modelFields.includes(comment), false); assert.equal(modelFields.includes(added.reply.data.workspace.root), false);
  assert.ok(added.reply.data.comments.some(item => item.body === comment));
  const navigation = { target: { type: 'file', path: 'sample.txt' }, expanded: [], mode: 'full', side: 'right', line: 0, commentsMode: 'target', filter: '' };
  const draft = { id: randomUUID(), target: navigation.target, body: 'Synthetic recovered draft', requestId: randomUUID() };
  const saveId = randomUUID(), preferenceId = randomUUID();
  // The process writes normally; the test deliberately discards the returned application results.
  await first.call('saveView', { reviewId: first.view.active.id, expectedRevision: 0, sequence: 1, navigation, drafts: [draft] }, { operationId: saveId });
  await first.call('preferences', { language: 'zh-CN' }, { operationId: preferenceId });
  const priorId = first.view.active.id; first.assertProtocol();
  assert.deepEqual(await first.stop(), { code: 0, signal: null });
  const second = await env.connect(); assert.equal(second.bootstrap.preferences.language, 'zh-CN');
  assert.notEqual(second.bootstrap.epoch, first.bootstrap.epoch); assert.notEqual(second.bootstrap.viewId, first.bootstrap.viewId);
  const preference = await second.ok('operation', { operationId: preferenceId }); assert.equal(preference.status, 'committed');
  const saved = await second.ok('operation', { operationId: saveId }); assert.equal(saved.status, 'committed');
  await second.open();
  assert.equal(second.view.active.id, priorId); assert.deepEqual(second.view.recovery.drafts, [draft]);
  assert.deepEqual(second.view.recovery.navigation, navigation); assert.deepEqual(second.view.comments.map(item => item.body), [comment]);
  second.assertProtocol(); assert.deepEqual(await second.stop(), { code: 0, signal: null });
});

test('AC-11：两个真实 stdio 进程竞争相同评论版本，只有一个成功且不丢失最终结果', async t => {
  const env = await setup(t), one = await env.connect();
  await one.open(true); await one.choose();
  await one.ok('addComment', { target: { type: 'file', path: 'sample.txt' }, body: 'Synthetic original', requestId: randomUUID(), fingerprint: one.view.files.find(file => file.path === 'sample.txt').fingerprint });
  const two = await env.connect(); await two.open();
  const comment = one.view.comments[0];
  const payload = body => ({ id: comment.id, revision: comment.revision, expectedState: 'open', deleted: false, change: 'edit', body });
  const results = await Promise.all([one.call('changeComment', payload('Synthetic writer one')), two.call('changeComment', payload('Synthetic writer two'))]);
  assert.equal(results.filter(result => result.reply.ok).length, 1);
  assert.equal(results.filter(result => !result.reply.ok).length, 1);
  await one.ok('refresh', {}); await two.ok('refresh', {});
  assert.equal(one.view.comments.length, 1); assert.equal(one.view.comments[0].id, comment.id);
  assert.ok(['Synthetic writer one', 'Synthetic writer two'].includes(one.view.comments[0].body));
  assert.deepEqual(one.view.comments, two.view.comments);
  one.assertProtocol(); two.assertProtocol();
});
