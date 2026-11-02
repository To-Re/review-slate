const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture, env } = require('./fixtures.cjs');
const { GitRepository } = require('../dist/git'), { ReviewService } = require('../dist/review'), { ReviewState } = require('../dist/state');
const { hash, snapshotId, legacyScope, FILE_LIMIT } = require('../dist/model');

test('包含分支提交、暂存、未暂存和新增文件，排除忽略与评论目录', async t => {
  const f = await fixture(t);
  await f.write('src/a.txt', 'committed'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'branch');
  await f.write('src/b.txt', 'staged'); f.git('add', 'src/b.txt'); await f.write('src/b.txt', 'working');
  await f.write('new.txt', 'new'); await f.write('.gitignore', '*.ignored\n'); await f.write('x.ignored', 'skip');
  await f.choose();
  assert.deepEqual(f.service.view.files.map(x => x.path).sort(), ['.gitignore', 'new.txt', 'src/a.txt', 'src/b.txt']);
  assert.equal(f.service.selection('src/b.txt').pair.right.data.toString(), 'working');
  await f.service.add(f.service.selection('src/a.txt'), 'comment');
  assert.ok(!f.service.view.files.some(x => x.path.startsWith('.code-review')));
});
for (const main of [true, false]) test((main ? '主干基点' : '指定提交') + '：stage、commit、主干移动和重开后进度不变', async t => {
  const f = await fixture(t); await f.service.choose(main ? await f.repo.forkPoint('main') : f.base, 'base');
  await f.write('src/a.txt', 'reviewed'); await f.service.refresh(); await f.mark(['src/a.txt']);
  const session = f.service.view.session, fingerprint = f.service.view.files[0].fingerprint;
  f.git('add', 'src/a.txt'); await f.service.refresh(); assert.equal(f.service.view.files[0].status, 'reviewed');
  f.git('commit', '-qm', 'reviewed bytes'); f.git('update-ref', 'refs/heads/main', f.git('rev-parse', 'HEAD'));
  await f.service.refresh(); assert.equal(f.service.view.files[0].fingerprint, fingerprint);
  const reopened = new ReviewService(await GitRepository.open(f.root), f.storage); await reopened.start();
  assert.deepEqual(reopened.view.session, session); assert.equal(reopened.view.session.base, f.base); assert.equal(reopened.view.files[0].status, 'reviewed');
});
test('独立新进程恢复基点、勾选、快照和评论，包含提交后的状态', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'reviewed'); await f.service.refresh(); await f.mark(['src/a.txt']);
  await f.service.add(f.service.selection('src/a.txt'), '恢复后仍有这条意见'); const comment = f.service.view.notes.comments[0];
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'after review');
  const script = "const {GitRepository}=require('./dist/git');const {ReviewService}=require('./dist/review');(async()=>{const s=new ReviewService(await GitRepository.open(process.argv[1]),process.argv[2]);await s.start();process.stdout.write(JSON.stringify({base:s.view.session.base,status:s.view.files[0].status,comment:s.view.notes.comments[0],snapshot:(await s.previous('src/a.txt')).right.data.toString()}))})().catch(e=>{console.error(e);process.exit(1)})";
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script, f.root, f.storage], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }));
  assert.equal(result.base, f.base); assert.equal(result.status, 'reviewed'); assert.deepEqual(result.comment, comment); assert.equal(result.snapshot, 'reviewed');
});
test('只改变对应文件状态，原内容恢复后重新匹配已审快照', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.write('src/b.txt', 'b2'); await f.service.refresh(); await f.mark(['src/a.txt', 'src/b.txt']);
  await f.write('src/a.txt', 'a3'); await f.service.refresh(); assert.deepEqual(f.service.view.files.map(x => x.status), ['changed', 'reviewed']);
  assert.equal((await f.service.previous('src/a.txt')).right.data.toString(), 'a2');
  await f.write('src/a.txt', 'a2'); await f.service.refresh(); assert.ok(f.service.view.files.every(x => x.status === 'reviewed'));
});
test('切走到其他分支再切回：固定起点、已审快照和文件/目录评论完整恢复', async t => {
  const f = await fixture(t); await f.choose();
  await f.write('src/a.txt', 'feature content'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'feature work');
  await f.service.refresh(); await f.mark(['src/a.txt']);
  await f.service.add(f.service.selection('src/a.txt'), 'file feedback');
  await f.service.add(f.service.directorySelection('src'), 'directory feedback');
  const original = f.service.view.session, notes = f.service.view.notes.comments;
  f.git('switch', '-qc', 'another', f.base); await f.write('src/a.txt', 'another content'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'other work');
  await f.service.refresh(); assert.equal(f.service.view.session, undefined); assert.equal(f.service.view.notes.comments.length, 0);
  await f.choose(); assert.notEqual(f.service.view.session.id, original.id); assert.equal(f.service.view.files[0].status, 'pending');
  await f.mark(['src/a.txt']); await f.service.add(f.service.selection('src/a.txt'), 'other branch feedback');
  f.git('switch', '-q', 'feature'); await f.service.refresh();
  assert.equal(f.service.view.files.find(x => x.path === 'src/a.txt').status, 'reviewed'); assert.deepEqual(f.service.view.notes.comments, notes);
  const reopened = new ReviewService(await GitRepository.open(f.root), f.storage); await reopened.start();
  assert.deepEqual(reopened.view.session, original); assert.equal(reopened.view.files.find(x => x.path === 'src/a.txt').status, 'reviewed'); assert.deepEqual(reopened.view.notes.comments, notes);
});
test('切换基点隔离评论，再回来恢复进度和评论', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.mark(['src/a.txt']); await f.service.add(f.service.selection('src/a.txt'), 'keep');
  const id = f.service.view.session.id;
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'next'); await f.service.choose(f.git('rev-parse', 'HEAD'), 'next');
  assert.equal(f.service.view.files.length, 0); assert.equal(f.service.view.notes.comments.length, 0);
  await f.choose(); assert.equal(f.service.view.session.id, id); assert.equal(f.service.view.files[0].status, 'reviewed');
});
test('旧版数据兼容恢复，迁移不改原状态、快照或评论字节', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'old reviewed'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'old');
  const legacy = { mode: 'branch', base: 'main', target: 'HEAD', mergeBase: true }, scope = legacyScope(legacy);
  const pair = await f.repo.pair(f.base, 'src/a.txt'), folder = path.join(f.storage, hash(f.root), scope);
  await fs.mkdir(path.join(folder, 'blobs'), { recursive: true });
  for (const side of [pair.left, pair.right]) await fs.writeFile(path.join(folder, 'blobs', snapshotId(side)), side.data);
  const data = JSON.stringify({ version: 1, records: { 'src/a.txt': { left: { mode: pair.left.mode, hash: snapshotId(pair.left) }, right: { mode: pair.right.mode, hash: snapshotId(pair.right) }, reviewedAt: '2026-10-29T00:00:00Z' } } });
  await fs.writeFile(path.join(folder, 'state.json'), data);
  await f.service.comments.add({ id: scope, base: f.base, label: 'legacy', createdAt: '' }, 'src/a.txt', pair, 'old note');
  const file = path.join(f.root, '.code-review/comments', (await f.service.comments.load()).comments[0].id + '.json');
  const c = JSON.parse(await fs.readFile(file, 'utf8')); c.comparison = legacy; await fs.writeFile(file, JSON.stringify(c));
  const original = await fs.readFile(file); await f.service.start(legacy);
  assert.ok(f.service.view.session.commentScopes.includes(scope)); assert.equal(f.service.view.session.base, f.base); assert.equal(f.service.view.files[0].status, 'reviewed');
  assert.equal(await fs.readFile(path.join(folder, 'state.json'), 'utf8'), data); assert.deepEqual(await fs.readFile(file), original);
  await f.choose(); assert.ok(f.service.view.session.commentScopes.includes(scope));
});
test('旧版 HEAD 工作区配置升级时固定，提交后不丢差异', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'pending');
  await f.service.start({ mode: 'worktree', base: 'HEAD', target: 'HEAD', mergeBase: false });
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'commit'); await f.service.refresh();
  assert.equal(f.service.view.session.base, f.base); assert.equal(f.service.view.files.length, 1);
});
test('陈旧勾选和目录新增文件不能认证未看过的内容', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh();
  const request = { session: f.service.view.session.id, directory: 'src', files: f.service.view.files.map(x => ({ path: x.path, fingerprint: x.fingerprint, checked: true })) };
  await f.write('src/b.txt', 'b2'); await assert.rejects(f.service.mark(request), /列表已变化/);
  await f.write('src/a.txt', 'a3'); delete request.directory; await assert.rejects(f.service.mark(request), /已变化/);
  assert.equal(Object.keys(await f.service.state.records(f.service.view.session)).length, 0);
});
test('并发实例更新不同文件不丢记录，取消标记只影响一个文件', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.write('src/b.txt', 'b2'); await f.service.refresh();
  const state2 = new ReviewState(f.storage, f.root);
  await Promise.all(f.service.view.files.map((file, i) => (i ? state2 : f.service.state).record(f.service.view.session, [{ path: file.path, pair: file }])));
  await f.service.refresh(); assert.ok(f.service.view.files.every(x => x.status === 'reviewed'));
  await f.mark(['src/a.txt'], false); assert.deepEqual(f.service.view.files.map(x => x.status), ['pending', 'reviewed']);
});
test('状态和快照损坏显式失败，不覆盖为一份空进度', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.mark(['src/a.txt']);
  const folder = f.service.state.location(f.service.view.session), file = path.join(folder, 'state.json'), original = await fs.readFile(file);
  await fs.writeFile(file, '{invalid'); await assert.rejects(f.service.refresh(), /数据损坏/);
  assert.equal(f.service.view.files.length, 0); assert.ok(f.service.view.error); assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
  await fs.writeFile(file, original); const records = JSON.parse(original).records;
  await fs.writeFile(path.join(folder, 'blobs', records['src/a.txt'].right.hash), 'broken');
  await assert.rejects(f.service.refresh(), /校验失败/); assert.deepEqual(await fs.readFile(file), original); assert.ok((await fs.stat(file + '.bak')).isFile());
});
test('损坏基点配置不可被新选择覆盖，主文件缺失时保留备份', async t => {
  const f = await fixture(t); await f.choose(); const file = path.join(f.storage, hash(f.root), 'reviews.json');
  await fs.writeFile(file, '{broken'); await assert.rejects(f.service.choose(f.base, 'new'), /数据损坏/); assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  await fs.unlink(file); await assert.rejects(f.service.start(), /备份仍在/);
});
test('权限、空文件、删除、类型变化分别识别', async t => {
  const f = await fixture(t); await f.choose(); await fs.chmod(path.join(f.root, 'src/a.txt'), 0o755); await fs.unlink(path.join(f.root, 'src/b.txt')); await f.write('empty', ''); await f.service.refresh();
  assert.equal(f.service.view.files.find(x => x.path === 'src/a.txt').right.mode, '100755'); assert.equal(f.service.view.files.find(x => x.path === 'src/b.txt').right.mode, '000000'); assert.equal(f.service.view.files.find(x => x.path === 'empty').right.mode, '100644');
  await f.mark(['src/a.txt']); await fs.chmod(path.join(f.root, 'src/a.txt'), 0o644); await f.write('src/a.txt', 'modified'); await f.service.refresh();
  assert.equal(f.service.view.files.find(x => x.path === 'src/a.txt').status, 'changed');
});
test('不读取叶子或父目录符号链接的目标内容', async t => {
  const f = await fixture(t); const outside = path.join(f.temp, 'secret'); await fs.writeFile(outside, 'PRIVATE-CONTENT'); await f.choose();
  await fs.unlink(path.join(f.root, 'src/a.txt')); await fs.symlink(outside, path.join(f.root, 'src/a.txt')); await f.service.refresh();
  const row = f.service.view.files.find(x => x.path === 'src/a.txt'); assert.equal(row.right.mode, '120000'); assert.equal(row.right.data.toString(), outside);
  await fs.rm(path.join(f.root, 'src'), { recursive: true }); await fs.symlink(f.temp, path.join(f.root, 'src')); await f.service.refresh();
  assert.equal(f.service.view.files.find(x => x.path === 'src/b.txt').right.mode, '000000');
});
test('大文件未变化可跳过，变化时明确失败，二进制按内容审阅', async t => {
  const f = await fixture(t, { big: Buffer.alloc(FILE_LIMIT + 1, 65), binary: Buffer.from([0, 1, 2]) }); await f.choose(); assert.equal(f.service.view.files.length, 0);
  await f.write('big', Buffer.alloc(FILE_LIMIT + 1, 66)); await f.write('binary', Buffer.from([0, 2, 3])); await f.service.refresh();
  assert.match(f.service.view.files.find(x => x.path === 'big').error, /5 MiB/); assert.ok(!f.service.view.files.find(x => x.path === 'binary').error);
  await assert.rejects(f.mark(['big']), /读取失败/); await f.mark(['binary']);
});
test('特殊文件名和对象键安全，改名后原评论仍可访问', async t => {
  const f = await fixture(t); await f.choose(); const names = ['__proto__', '含 空格.txt', 'tab\tname', 'line\nname'];
  for (const name of names) await f.write(name, 'test'); await f.service.refresh(); await f.mark(names); await f.service.add(f.service.selection('__proto__'), 'original path');
  await fs.rename(path.join(f.root, '__proto__'), path.join(f.root, 'renamed')); await f.service.refresh();
  assert.ok(f.service.view.files.find(x => x.path === '__proto__').commentOnly); assert.equal(f.service.view.files.find(x => x.path === 'renamed').status, 'pending');
});
test('新子模块与合并冲突不能显示为已完成', async t => {
  const f = await fixture(t); await f.choose(); f.git('update-index', '--add', '--cacheinfo', '160000,' + f.base + ',module'); await f.service.refresh();
  assert.match(f.service.view.files.find(x => x.path === 'module').error, /子模块/); f.git('update-index', '--force-remove', 'module');
  await f.write('src/a.txt', 'feature'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'feature');
  f.git('switch', '-q', 'main'); await f.write('src/a.txt', 'main'); f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'main'); f.git('switch', '-q', 'feature');
  assert.throws(() => f.git('merge', '--no-commit', 'main')); await assert.rejects(f.service.refresh(), /合并冲突/);
});
test('不触发 clean、textconv 或 external diff', async t => {
  const f = await fixture(t); const marker = path.join(f.temp, 'executed');
  f.git('config', 'filter.trap.clean', 'touch ' + marker); f.git('config', 'diff.trap.textconv', 'touch ' + marker); f.git('config', 'diff.external', 'touch ' + marker);
  await f.write('.gitattributes', '*.txt filter=trap diff=trap'); await f.write('src/a.txt', 'raw bytes'); await f.choose();
  assert.equal(f.service.selection('src/a.txt').pair.right.data.toString(), 'raw bytes'); await f.mark(['src/a.txt']); await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
test('识别远端默认主干，排除私有快照，参数不能作为 Git 选项', async t => {
  const f = await fixture(t); assert.equal((await f.repo.mainReferences()).preferred.ref, 'refs/heads/main');
  f.git('update-ref', 'refs/remotes/origin/develop', f.base); f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  assert.equal((await f.repo.mainReferences()).preferred.ref, 'refs/remotes/origin/develop');
  await f.write('hidden', 'snapshot'); f.git('add', 'hidden'); f.git('commit', '-qm', 'private'); const hidden = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/incremental-diff/test', hidden); f.git('reset', '--hard', f.base);
  assert.ok(!(await f.repo.commits()).some(x => x.oid === hidden)); await assert.rejects(f.repo.resolve('--help')); await assert.rejects(f.repo.resolve('HEAD\0bad'));
});
test('linked worktree 可用，扫描和标记不修改 Git 元数据', async t => {
  const f = await fixture(t), linked = path.join(f.temp, 'linked'); f.git('worktree', 'add', '-qb', 'linked', linked);
  await fs.writeFile(path.join(linked, 'src/a.txt'), 'linked');
  async function treeHash(dir, prefix = '', result = {}) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name), name = prefix + item.name;
      if (item.isDirectory()) await treeHash(file, name + '/', result); else result[name] = hash(await fs.readFile(file));
    } return result;
  }
  const before = await treeHash(path.join(f.root, '.git')), s = new ReviewService(await GitRepository.open(linked), f.storage);
  await s.start(); await s.choose(f.base, 'linked'); const row = s.view.files[0];
  await s.mark({ session: s.view.session.id, files: [{ path: row.path, fingerprint: row.fingerprint, checked: true }] });
  assert.deepEqual(await treeHash(path.join(f.root, '.git')), before);
});
test('升级期间遵守旧版写入锁，不与尚未重载的窗口同时覆盖数据', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'reviewed'); await f.service.refresh(); await f.mark(['src/a.txt']);
  const session = f.service.view.session, folder = f.service.state.location(session), lock = path.join(folder, 'write.lock');
  await fs.mkdir(lock); let finished = false;
  const update = f.service.state.record(session, [{ path: 'src/a.txt' }]).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(finished, false); assert.ok((await f.service.state.records(session))['src/a.txt']);
  await fs.rmdir(lock); await update; assert.equal(Object.keys(await f.service.state.records(session)).length, 0);
});

test('缺失 promisor 对象时拒绝懒加载，不补对象或修改 Git 元数据', async t => {
  const f = await fixture(t);
  const oid = f.git('rev-parse', f.base + ':src/a.txt');
  f.git('config', 'remote.origin.url', 'https://example.invalid/never-fetch.git');
  f.git('config', 'remote.origin.promisor', 'true');
  const object = path.join(f.root, '.git/objects', oid.slice(0, 2), oid.slice(2));
  await fs.unlink(object); await f.write('src/a.txt', 'modified\n');
  const metadata = async () => {
    const result = {};
    for (const name of await fs.readdir(path.join(f.root, '.git'), { recursive: true })) {
      const file = path.join(f.root, '.git', name), stat = await fs.lstat(file);
      if (stat.isFile()) result[name] = hash(await fs.readFile(file));
    }
    return result;
  };
  const before = await metadata(), trace = path.join(f.temp, 'git-trace.json');
  const script = "const {GitRepository}=require('./dist/git');(async()=>{const r=await GitRepository.open(process.argv[1]);const files=await r.scan(process.argv[2]);process.stdout.write(JSON.stringify(files.map(f=>({path:f.path,error:!!f.error}))))})().catch(e=>{console.error(e);process.exit(1)})";
  const files = JSON.parse(execFileSync(process.execPath, ['-e', script, f.root, f.base], { cwd: path.resolve(__dirname, '..'), env: { ...env, GIT_TRACE2_EVENT: trace }, encoding: 'utf8' }));
  assert.ok(files.find(file => file.path === 'src/a.txt').error);
  const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!events.some(event => event.event === 'child_start' && event.argv?.some(arg => arg === 'fetch' || /^remote-|^git-remote-/.test(arg))));
  assert.deepEqual(await metadata(), before);
  await assert.rejects(fs.stat(object), { code: 'ENOENT' });
});
