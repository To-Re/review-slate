// Exercises the relocatable release artifact, without installing it or opening an app.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const source = path.resolve(__dirname, '../artifacts/codex-build/reviewslate');
const actions = { openWorkspace: 'reviewslate_workspace_open', chooseBase: 'reviewslate_review_change', addComment: 'reviewslate_comment_change', mark: 'reviewslate_mark', preferences: 'reviewslate_preferences', refresh: 'reviewslate_read' };
const readActions = new Set(['refresh']);
const sha = data => createHash('sha256').update(data).digest('hex');
async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.runtime.platform, 'darwin-arm64', 'A packaged runtime is required.');
  for (const [file, expected] of Object.entries(manifest.files)) {
    const actual = await fs.readFile(path.join(source, file));
    assert.equal(actual.length, expected.bytes, file); assert.equal(sha(actual), expected.sha256, file);
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewslate-package-'));
  const relocated = path.join(temp, 'relocated plugin');
  const repo = path.join(temp, 'synthetic repository');
  const appData = path.join(temp, 'app data');
  const clients = [];
  try {
    await fs.cp(source, relocated, { recursive: true });
    const picker = path.join(relocated, 'native/ReviewSlate Folder Picker.app');
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', picker], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal((await fs.stat(path.join(picker, 'Contents/MacOS/ReviewSlateFolderPicker'))).mode & 0o111, 0o111);
    const pickerInfo = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(picker, 'Contents/Info.plist')], { encoding: 'utf8' }));
    assert.equal(pickerInfo.CFBundleIdentifier, 'org.reviewslate.folderpicker');
    assert.equal(pickerInfo.CFBundleShortVersionString, manifest.version);
    await fs.mkdir(repo);
    const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Package Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Package Test', GIT_COMMITTER_EMAIL: 'test@example.invalid'
    } }).trim();
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'example.ts'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-qm', 'Synthetic baseline'); const base = git('rev-parse', 'HEAD');
    git('switch', '-qc', 'feature/review'); await fs.writeFile(path.join(repo, 'example.ts'), 'export const value = 2;\n');
    async function connect() {
      const transport = new StdioClientTransport({ command: path.join(relocated, 'bin/launch.sh'), args: [], cwd: relocated,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', REVIEW_SLATE_DATA_DIR: appData }, stderr: 'pipe' });
      const client = new Client({ name: 'reviewslate-package-check', version: '1.0.0' }); clients.push(client);
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 12);
      assert.ok(tools.some(tool => tool.name === 'reviewslate_folder_pick'));
      assert.deepEqual(tools.find(t => t.name === 'reviewslate_open')._meta.ui.visibility, ['model', 'app']);
      for (const tool of tools.filter(t => t.name !== 'reviewslate_open')) assert.deepEqual(tool._meta.ui.visibility, ['app']);
      const resource = await client.readResource({ uri: 'ui://reviewslate/workspace.html' });
      const html = resource.contents[0].text;
      assert.match(html, /Content-Security-Policy/); assert.match(html, /connect-src 'none'/);
      assert.doesNotMatch(html, /<script[^>]+src=/);
      const bootstrapResult = await client.callTool({ name: 'reviewslate_bootstrap', arguments: {} });
      assert.equal(bootstrapResult._meta.reviewslate.ok, true);
      assert.equal(bootstrapResult.structuredContent, undefined);
      const bootstrap = bootstrapResult._meta.reviewslate.data;
      assert.equal(bootstrap.capabilities.folderPicker, true, 'The relocated package must find its folder picker.');
      assert.equal(JSON.stringify(bootstrapResult.content).includes(bootstrap.capability), false);
      const context = { client, bootstrap, view: undefined };
      context.call = async (action, payload) => {
        const result = await client.callTool({ name: actions[action], arguments: { request: {
          protocol: 1, capability: bootstrap.capability, viewId: bootstrap.viewId,
          ...(context.view ? { workspaceId: context.view.workspace.id, context: context.view.context } : {}),
          ...(readActions.has(action) ? {} : { operationId: randomUUID() }), action, payload
        } } });
        const reply = result._meta.reviewslate; assert.equal(reply.ok, true, JSON.stringify(reply.error));
        if (reply.data?.workspace) context.view = reply.data;
        return reply.data;
      };
      return context;
    }
    const first = await connect();
    await first.call('openWorkspace', { root: repo, initialize: true });
    await first.call('chooseBase', { kind: 'commit', ref: base, label: 'Synthetic baseline', expectedBranch: first.view.branch.key, expectedRevision: first.view.revision });
    const reviewId = first.view.active.id;
    await first.call('addComment', { target: { type: 'file', path: 'example.ts' }, body: 'Synthetic packaged review comment', fingerprint: first.view.files.find(f => f.path === 'example.ts').fingerprint, requestId: randomUUID() });
    await first.call('mark', { files: [{ path: 'example.ts', fingerprint: first.view.files.find(f => f.path === 'example.ts').fingerprint, checked: true }] });
    await first.call('preferences', { language: 'en' }); await first.client.close();
    const second = await connect(); assert.equal(second.bootstrap.preferences.language, 'en');
    await second.call('openWorkspace', { root: repo, initialize: false });
    assert.equal(second.view.active.id, reviewId);
    assert.equal(second.view.comments[0].body, 'Synthetic packaged review comment');
    assert.equal(second.view.files.find(f => f.path === 'example.ts').status, 'reviewed');
    assert.equal(await fs.stat(path.join(repo, '.code-review')).then(() => true, () => false), false);
    await second.client.close();
    console.log('Packaged runtime/UI integrity, relocated launch, app-only metadata, real Git review, comments, progress, language and process restart: passed.');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
