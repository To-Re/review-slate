const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { fixture } = require('./fixtures.cjs');
const { ReviewService } = require('../dist/review'), { hash } = require('../dist/model');
const { handoffText } = require('../dist/handoff');

async function populated(t) {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'reviewed content');
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'feature');
  await f.service.refresh(); await f.mark(['src/a.txt']); await f.service.add(f.service.selection('src/a.txt'), 'first branch feedback');
  return f;
}
test('同基点不同分支独立 CR、评论、目录和文件草稿；恢复分支最后使用的基点', async t => {
  const f = await populated(t), first = f.service.view.session;
  const draft = f.service.selection('src/a.txt').draftKey, directoryDraft = f.service.directorySelection('src').draftKey;
  f.git('switch', '-qc', 'other'); await f.service.refresh();
  assert.equal(f.service.view.session, undefined); assert.equal(f.service.view.notes.comments.length, 0);
  await f.choose(); const other = f.service.view.session;
  assert.notEqual(first.id, other.id); assert.equal(f.service.view.files[0].status, 'pending');
  assert.notEqual(f.service.selection('src/a.txt').draftKey, draft); assert.notEqual(f.service.directorySelection('src').draftKey, directoryDraft);
  await f.service.add(f.service.selection('src/a.txt'), 'other branch feedback');
  const otherPending = await fs.readFile(f.service.comments.pendingFile(other), 'utf8');
  assert.match(otherPending, /other branch feedback/); assert.doesNotMatch(otherPending, /first branch feedback/);
  await assert.rejects(f.service.openReview(first.id), /先切换到分支/); assert.equal(f.git('branch', '--show-current'), 'other');
  f.git('switch', '-q', 'feature'); await f.service.refresh(); assert.equal(f.service.view.session.id, first.id);
  assert.equal(f.service.view.files[0].status, 'reviewed'); assert.equal(f.service.selection('src/a.txt').draftKey, draft);
  await f.service.choose('HEAD', 'second base'); const second = f.service.view.session;
  assert.equal(f.service.view.notes.comments.length, 0);
  f.git('switch', '-q', 'other'); await f.service.refresh(); assert.equal(f.service.view.session.id, other.id);
  f.git('switch', '-q', 'feature'); await f.service.refresh(); assert.equal(f.service.view.session.id, second.id);
  await f.service.openReview(first.id); assert.equal(f.service.view.notes.comments[0].body, 'first branch feedback');
  assert.equal((await f.service.state.sessions()).length, 3);
});
test('删除 CR 保留所有原数据，重开后仍删除，可恢复旧进度；其他 CR 和交接清单不受影响', async t => {
  const f = await populated(t), first = f.service.view.session, note = f.service.view.notes.comments[0];
  const stateFile = path.join(f.service.state.location(first), 'state.json'), commentFile = path.join(f.service.comments.folder, 'comments', note.id + '.json');
  const state = await fs.readFile(stateFile), comment = await fs.readFile(commentFile);
  await f.service.choose('HEAD', 'other base'); const second = f.service.view.session;
  await f.service.deleteReview(first.id, true);
  assert.equal(f.service.view.session.id, second.id);
  assert.deepEqual(await fs.readFile(stateFile), state); assert.deepEqual(await fs.readFile(commentFile), comment);
  assert.equal(JSON.parse(await fs.readFile(f.service.comments.reviewFile(first))).deleted, true);
  assert.doesNotMatch(await fs.readFile(f.service.comments.pendingFile(first), 'utf8'), /first branch feedback/);
  const fresh = new ReviewService(f.repo, f.storage); await fresh.start();
  assert.ok(fresh.view.sessions.find(s => s.id === first.id).deletedAt);
  await assert.rejects(fresh.openReview(first.id), /已删除/);
  await fresh.deleteReview(first.id, false); assert.equal(fresh.view.session.id, second.id);
  await fresh.openReview(first.id); assert.equal(fresh.view.files[0].status, 'reviewed'); assert.deepEqual(fresh.view.notes.comments, [note]);
  await fresh.deleteReview(first.id, true); assert.equal(fresh.view.session, undefined); assert.equal(fresh.view.notes.comments.length, 0);
  await fresh.start(); assert.equal(fresh.view.session, undefined);
  assert.doesNotMatch(await fs.readFile(path.join(fresh.comments.folder, 'PENDING.md'), 'utf8'), /first branch feedback/);
});
test('删除后同分支同基点可新建干净 CR，恢复冲突保留双方数据；删除新 CR 后可恢复旧 CR', async t => {
  const f = await populated(t), first = f.service.view.session;
  await f.service.deleteReview(first.id, true); await f.choose(); const second = f.service.view.session;
  assert.notEqual(second.id, first.id); assert.equal(f.service.view.files[0].status, 'pending'); assert.equal(f.service.view.notes.comments.length, 0);
  await assert.rejects(f.service.deleteReview(first.id, false), /相同基点的新 CR/);
  assert.ok((await f.service.state.sessions()).find(s => s.id === first.id).deletedAt);
  await f.service.deleteReview(second.id, true); await f.service.deleteReview(first.id, false); await f.service.openReview(first.id);
  assert.equal(f.service.view.files[0].status, 'reviewed'); assert.equal(f.service.view.notes.comments[0].body, 'first branch feedback');
});
test('Agent 交接固定到本轮路径，切换 CR 不重写已交接的另一轮内容', async t => {
  const f = await populated(t), first = f.service.view.session, pending = f.service.comments.pendingFile(first);
  const text = handoffText(f.root, 'ssh-remote', first), content = await fs.readFile(pending);
  assert.ok(text.includes(JSON.stringify(pending))); assert.ok(text.includes(JSON.stringify(f.service.comments.reviewFile(first))));
  assert.ok(text.includes('所属分支：feature')); assert.ok(text.includes('固定基点：' + f.base));
  await f.service.choose('HEAD', 'next'); assert.deepEqual(await fs.readFile(pending), content);
  await f.service.deleteReview(first.id, true); assert.match(await fs.readFile(pending, 'utf8'), /已删除，禁止处理/);
});
test('旧页面在分支改变后不能误标记或保存评论；扫描途中切分支也失败', async t => {
  const f = await populated(t), first = f.service.view.session, selected = f.service.selection('src/a.txt');
  const request = { session: first.id, files: [{ path: selected.file, fingerprint: f.service.view.files[0].fingerprint, checked: true }] };
  f.git('switch', '-qc', 'other');
  await assert.rejects(f.service.add(selected, 'wrong branch'), /分支或 CR 已改变/);
  await assert.rejects(f.service.mark(request), /已改变/);
  f.git('switch', '-q', 'feature'); await f.service.refresh();
  const scan = f.repo.scan.bind(f.repo);
  f.repo.scan = async (...args) => { const result = await scan(...args); f.git('switch', '-q', 'other'); return result; };
  await assert.rejects(f.service.refresh(), /分支或 CR 已改变/); assert.ok(f.service.view.error);
  assert.equal((await f.service.comments.load()).comments.length, 1);
});
test('等待评论写锁期间切分支，锁释放后再次核对归属，不写入错误 CR', async t => {
  const f = await populated(t), selected = f.service.selection('src/a.txt'), lock = path.join(f.service.comments.folder, 'write.lock');
  await fs.mkdir(lock); const add = f.service.add(selected, 'stale queued comment');
  const rejected = assert.rejects(add, /分支或 CR 已改变/);
  await new Promise(resolve => setTimeout(resolve, 120)); f.git('switch', '-qc', 'other'); await fs.rmdir(lock); await rejected;
  assert.equal((await f.service.comments.load()).comments.length, 1);
});
test('等待评论锁的旧刷新不能覆盖另一窗口刚删除的 CR 清单', async t => {
  const f = await populated(t), first = f.service.view.session, lock = path.join(f.service.comments.folder, 'write.lock');
  await fs.mkdir(lock);
  const refresh = f.service.refresh(), rejected = assert.rejects(refresh, /CR 记录已改变/);
  await new Promise(resolve => setTimeout(resolve, 120));
  await f.service.state.setDeleted(first.id, true); await fs.rmdir(lock); await rejected;
  await f.service.refresh();
  assert.equal(f.service.view.session, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.service.comments.reviewFile(first))).deleted, true);
  assert.doesNotMatch(await fs.readFile(f.service.comments.pendingFile(first), 'utf8'), /first branch feedback/);
});
test('v2 目录迁移：当前记录归当前分支，其余未分配，原目录与评论字节保持不变', async t => {
  const f = await populated(t), current = f.service.view.session;
  const note = f.service.view.notes.comments[0], commentFile = path.join(f.service.comments.folder, 'comments', note.id + '.json');
  const original = await fs.readFile(commentFile), location = f.service.state.location(current), state = await fs.readFile(path.join(location, 'state.json'));
  const older = { id: hash('older review'), base: f.git('rev-parse', 'HEAD'), label: 'older', createdAt: '2020-01-01' };
  const old = { version: 2, active: current.id, sessions: [current, older] };
  const folder = f.service.state.repositoryDirectory, legacy = JSON.stringify(old);
  await fs.writeFile(path.join(folder, 'sessions.json'), legacy);
  await fs.unlink(path.join(folder, 'reviews.json')); await fs.unlink(path.join(folder, 'reviews.json.bak'));
  const fresh = new ReviewService(f.repo, f.storage); await fresh.start();
  assert.equal(fresh.view.session.branch.key, 'refs/heads/feature'); assert.notEqual(fresh.view.session.id, current.id);
  assert.deepEqual(fresh.view.session.commentScopes, [current.id]); assert.equal(fresh.view.files[0].status, 'reviewed');
  assert.deepEqual(fresh.view.notes.comments, [note]); assert.deepEqual(await fs.readFile(commentFile), original);
  assert.deepEqual(await fs.readFile(path.join(location, 'state.json')), state); assert.equal(await fs.readFile(path.join(folder, 'sessions.json'), 'utf8'), legacy);
  const unassigned = fresh.view.sessions.find(s => s.branch.key.startsWith('legacy:')); assert.ok(unassigned);
  await fresh.openReview(unassigned.id); assert.equal(fresh.view.session.branch.label, 'feature');
  await fresh.deleteReview(fresh.view.session.id, true); await fresh.start(); assert.equal(fresh.view.session, undefined);
  f.git('switch', '-qc', 'other'); await fresh.start(); assert.equal(fresh.view.session, undefined);
});
test('游离 HEAD 以提交区分身份；普通分支新增提交保持同一 CR', async t => {
  const f = await populated(t), first = f.service.view.session, head = f.git('rev-parse', 'HEAD');
  f.git('switch', '--detach', '-q', head); await f.service.refresh(); assert.equal(f.service.view.session, undefined);
  await f.choose(); const detached = f.service.view.session; assert.equal(detached.branch.key, 'detached:' + head);
  f.git('switch', '-q', 'feature'); await f.service.refresh(); assert.equal(f.service.view.session.id, first.id);
  f.git('commit', '--allow-empty', '-qm', 'another commit'); await f.service.refresh(); assert.equal(f.service.view.session.id, first.id);
  assert.equal(f.service.view.files[0].status, 'reviewed');
  f.git('switch', '--detach', '-q', head); await f.service.refresh(); assert.equal(f.service.view.session.id, detached.id);
});
