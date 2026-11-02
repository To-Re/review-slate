const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { fixture } = require('./fixtures.cjs');
const { ReviewService } = require('../dist/review'), { CommentRepository } = require('../dist/comments');
const { hash } = require('../dist/model');

async function populated(t) {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'reviewed content');
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'feature change'); await f.service.refresh();
  await f.mark(['src/a.txt']); await f.service.add(f.service.selection('src/a.txt'), 'first comment');
  return f;
}
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
async function files(root) {
  const result = new Map();
  async function walk(folder, prefix = '') {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(folder, item.name);
      if (item.isDirectory()) await walk(file, name + '/');
      else result.set(name, await fs.readFile(file));
    }
  }
  await walk(root); return result;
}
test('永久删除只清理目标 CR 的状态、快照、评论备份、恢复区、回复和交接；其他 CR 与 Git 保持', async t => {
  const f = await populated(t), first = f.service.view.session, firstNote = f.service.view.notes.comments[0];
  const selected = f.service.selection('src/a.txt');
  await f.service.comments.update(firstNote.id, firstNote.revision, { body: 'edited first comment' }); await f.service.refresh();
  await f.service.add(f.service.directorySelection('src'), 'directory comment');
  const notes = f.service.view.notes.comments, fileNote = notes.find(n => n.target !== 'directory'), directoryNote = notes.find(n => n.target === 'directory');
  const replyFile = path.join(f.service.comments.folder, 'replies', fileNote.id + '.json');
  const reply = { version: 1, commentId: fileNote.id, commentRevision: fileNote.revision, body: 'agent reply', updatedAt: '2026-01-01' };
  await fs.writeFile(replyFile, JSON.stringify(reply)); await fs.writeFile(replyFile + '.bak', JSON.stringify(reply));
  await f.service.comments.remove(directoryNote.id, directoryNote.revision); await f.service.refresh();
  const tempComment = path.join(f.service.comments.folder, 'comments', fileNote.id + '.json.00000000-0000-0000-0000-000000000000.tmp');
  await fs.writeFile(tempComment, JSON.stringify(fileNote));
  await f.service.choose('HEAD', 'second'); const second = f.service.view.session;
  await f.service.add(await f.service.capture('src/a.txt'), 'other review'); await f.service.deleteReview(first.id, true);
  const otherNote = f.service.view.notes.comments[0], otherComment = path.join(f.service.comments.folder, 'comments', otherNote.id + '.json');
  const otherBytes = await fs.readFile(otherComment), pending = await fs.readFile(f.service.comments.pendingFile(second));
  const rootPending = await fs.readFile(path.join(f.service.comments.folder, 'PENDING.md')), gitBefore = await files(path.join(f.root, '.git'));
  const removed = await f.service.purgeReview(first.id);
  assert.equal(removed.session.id, first.id); assert.ok(removed.targets.some(t => t.path === 'src' && t.target === 'directory'));
  assert.ok(removed.targets.some(t => t.path === 'src/a.txt' && t.target === 'file'));
  assert.equal(f.service.view.session.id, second.id); assert.equal(f.service.view.sessions.length, 1);
  await absent(f.service.state.location(first)); await absent(path.dirname(f.service.comments.pendingFile(first))); await absent(tempComment);
  for (const id of [fileNote.id, directoryNote.id]) for (const folder of ['comments', 'deleted', 'replies']) for (const suffix of ['.json', '.json.bak']) await absent(path.join(f.service.comments.folder, folder, id + suffix));
  assert.deepEqual(await fs.readFile(otherComment), otherBytes); assert.deepEqual(await fs.readFile(f.service.comments.pendingFile(second)), pending);
  assert.deepEqual(await fs.readFile(path.join(f.service.comments.folder, 'PENDING.md')), rootPending); assert.deepEqual(await files(path.join(f.root, '.git')), gitBefore);
  assert.equal(await fs.readFile(path.join(f.root, 'src/a.txt'), 'utf8'), 'reviewed content');
  await assert.rejects(f.service.add(selected, 'stale'), /CR 已改变/);
  await assert.rejects(f.service.deleteReview(first.id, false), /永久删除/);
  const reopened = new ReviewService(f.repo, f.storage); await reopened.start(); assert.deepEqual(reopened.view.notes.comments.map(c => c.id), [otherNote.id]);
  await f.choose(); assert.notEqual(f.service.view.session.id, first.id); assert.equal(f.service.view.files[0].status, 'pending'); assert.equal(f.service.view.notes.comments.length, 0);
});
test('删除当前 CR 后重开保持为空，旧状态和评论写入不能复活，评论请求 ID 也不能复用', async t => {
  const f = await populated(t), session = f.service.view.session, selection = f.service.selection('src/a.txt'), note = f.service.view.notes.comments[0];
  const stale = new ReviewService(f.repo, f.storage); await stale.start();
  await f.service.purgeReview(session.id); assert.equal(f.service.view.session, undefined); assert.equal(f.service.view.sessions.length, 0);
  assert.doesNotMatch(await fs.readFile(path.join(f.service.comments.folder, 'PENDING.md'), 'utf8'), /first comment|reviewed content/);
  await assert.rejects(stale.add(selection, 'stale window'), /CR 已改变/);
  await assert.rejects(stale.state.record(session, [{ path: selection.file, pair: selection.pair }]), /永久删除/);
  await assert.rejects(new CommentRepository(f.root).add(session, selection.file, selection.pair, 'stale repository'), /永久删除/);
  await stale.start(); assert.equal(stale.view.session, undefined); await f.choose();
  await assert.rejects(f.service.add(f.service.selection('src/a.txt'), 'reuse request', undefined, note.id), /永久删除/);
  for (const name of ['reviews.json', 'reviews.json.bak']) {
    const data = JSON.parse(await fs.readFile(path.join(f.service.state.repositoryDirectory, name)));
    assert.ok(data.sessions.every(s => s.id !== session.id));
  }
  await absent(f.service.state.location(session));
});
test('永久删除迁移 CR 同时移除旧别名数据与旧目录备份，未分配的其他旧 CR 保留', async t => {
  const f = await populated(t), old = f.service.view.session, note = f.service.view.notes.comments[0], folder = f.service.state.repositoryDirectory;
  const other = { id: hash('another old CR'), base: f.git('rev-parse', 'HEAD'), label: 'other legacy', createdAt: '2020-01-01' };
  const legacy = JSON.stringify({ version: 2, active: old.id, sessions: [old, other] });
  for (const name of ['sessions.json', 'sessions.json.bak']) await fs.writeFile(path.join(folder, name), legacy);
  for (const name of ['reviews.json', 'reviews.json.bak']) await fs.unlink(path.join(folder, name));
  const migrated = new ReviewService(f.repo, f.storage); await migrated.start(); const current = migrated.view.session;
  assert.deepEqual(current.commentScopes, [old.id]); await migrated.purgeReview(current.id);
  await absent(migrated.state.location(current)); await absent(migrated.state.location(old));
  await absent(path.join(migrated.comments.folder, 'comments', note.id + '.json'));
  await absent(path.dirname(migrated.comments.pendingFile(old)));
  for (const name of ['sessions.json', 'sessions.json.bak']) {
    const data = JSON.parse(await fs.readFile(path.join(folder, name))); assert.deepEqual(data.sessions.map(s => s.id), [other.id]); assert.equal(data.active, other.id);
  }
  const reopened = new ReviewService(f.repo, f.storage); await reopened.start(); assert.equal(reopened.view.session, undefined); assert.equal(reopened.view.sessions.length, 1);
});
test('永久删除中途失败留下可重试入口与无正文删除标记，不能恢复或写入，重试完成全部清理', async t => {
  const f = await populated(t), session = f.service.view.session, note = f.service.view.notes.comments[0];
  const replyFile = path.join(f.service.comments.folder, 'replies', note.id + '.json');
  await fs.writeFile(replyFile, JSON.stringify({ version: 1, commentId: note.id, commentRevision: note.revision, body: 'reply', updatedAt: '2026-01-01' }));
  const originalUnlink = fs.unlink; let failed = false;
  fs.unlink = async file => { if (file === replyFile && !failed) { failed = true; throw new Error('injected unlink failure'); } return originalUnlink(file); };
  try { await assert.rejects(f.service.purgeReview(session.id), /injected unlink/); } finally { fs.unlink = originalUnlink; }
  assert.ok((await f.service.state.sessions()).find(s => s.id === session.id).deletedAt);
  assert.equal(JSON.parse(await fs.readFile(f.service.comments.reviewFile(session))).deleted, true);
  assert.equal(JSON.parse(await fs.readFile(f.service.comments.reviewFile(session))).purged, true);
  assert.match(await fs.readFile(f.service.comments.pendingFile(session), 'utf8'), /永久删除，禁止处理/);
  assert.doesNotMatch(await fs.readFile(f.service.comments.pendingFile(session), 'utf8'), /first comment/);
  await assert.rejects(f.service.deleteReview(session.id, false), /永久删除/);
  await assert.rejects(f.service.state.record(session, [{ path: 'src/a.txt' }]), /永久删除/);
  const journal = await fs.readFile(path.join(f.service.comments.folder, 'purged.json'), 'utf8'); assert.doesNotMatch(journal, /first comment|reviewed content|reply/);
  const reopened = new ReviewService(f.repo, f.storage); await reopened.start(); assert.equal(reopened.view.notes.comments.length, 0); assert.deepEqual(reopened.view.purgePending, [session.id]);
  await reopened.purgeReview(session.id); await absent(replyFile); await absent(reopened.state.location(session)); assert.equal(reopened.view.sessions.length, 0); assert.deepEqual(reopened.view.purgePending, []);
});
test('交接失效失败时尚未删除原文和快照；删除日志写入失败后交接已禁止处理且可以重试', async t => {
  const f = await populated(t), session = f.service.view.session, note = f.service.view.notes.comments[0];
  const original = fs.rename, metadata = f.service.comments.reviewFile(session), journal = path.join(f.service.comments.folder, 'purged.json');
  let blocked = metadata;
  fs.rename = async (from, to) => { if (to === blocked) throw new Error('injected rename failure'); return original(from, to); };
  try {
    await assert.rejects(f.service.purgeReview(session.id), /injected rename/);
    assert.equal(await f.service.state.isPurged(session.id), false);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.service.state.repositoryDirectory, 'reviews.json'))).version, 3);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.service.comments.folder, 'comments', note.id + '.json'))).body, 'first comment');
    assert.ok((await fs.readdir(path.join(f.service.state.location(session), 'blobs'))).length);
    blocked = journal;
    await assert.rejects(f.service.purgeReview(session.id), /injected rename/);
    assert.equal(await f.service.state.isPurged(session.id), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.service.state.repositoryDirectory, 'reviews.json'))).version, 4);
    assert.equal(JSON.parse(await fs.readFile(metadata)).deleted, true);
    assert.doesNotMatch(await fs.readFile(f.service.comments.pendingFile(session), 'utf8'), /first comment/);
  } finally { fs.rename = original; }
  await f.service.purgeReview(session.id); assert.equal(f.service.view.sessions.length, 0);
});
test('v3 记录正常接续，仅首次永久删除升级 v4，之后选择和标记不降级', async t => {
  const f = await populated(t), first = f.service.view.session, catalog = path.join(f.service.state.repositoryDirectory, 'reviews.json');
  assert.equal(JSON.parse(await fs.readFile(catalog)).version, 3);
  const reopened = new ReviewService(f.repo, f.storage); await reopened.start(); assert.equal(reopened.view.session.id, first.id);
  assert.equal(reopened.view.files[0].status, 'reviewed'); assert.equal(JSON.parse(await fs.readFile(catalog)).version, 3);
  await reopened.purgeReview(first.id); assert.equal(JSON.parse(await fs.readFile(catalog)).version, 4);
  await reopened.choose(f.base, 'new review'); const current = reopened.view.session;
  await reopened.mark({ session: current.id, files: reopened.view.files.map(file => ({ path: file.path, fingerprint: file.fingerprint, checked: true })) });
  assert.equal(JSON.parse(await fs.readFile(catalog)).version, 4); assert.equal(reopened.view.files[0].status, 'reviewed');
  await reopened.deleteReview(current.id, true); await reopened.deleteReview(current.id, false); await reopened.openReview(current.id);
  assert.equal(JSON.parse(await fs.readFile(catalog)).version, 4);
  const latest = new ReviewService(f.repo, f.storage); await latest.start(); assert.equal(latest.view.session.id, current.id); assert.equal(latest.view.files[0].status, 'reviewed');
});
test('永久删除拒绝外部目录链接，不读取或删除链接目标，修复链接后可重试', async t => {
  const f = await populated(t), session = f.service.view.session, exported = path.dirname(f.service.comments.pendingFile(session));
  const outside = path.join(f.temp, 'outside'), kept = path.join(outside, 'keep'); await fs.mkdir(outside); await fs.writeFile(kept, 'external content');
  await fs.rm(exported, { recursive: true }); await fs.symlink(outside, exported);
  await assert.rejects(f.service.purgeReview(session.id), /不是普通目录/); assert.equal(await fs.readFile(kept, 'utf8'), 'external content');
  await fs.unlink(exported); await f.service.purgeReview(session.id); assert.equal(await fs.readFile(kept, 'utf8'), 'external content');
});
test('已审快照缺失或损坏仍能永久删除该 CR，其他 CR 快照和评论保持', async t => {
  for (const corrupt of [false, true]) {
    const f = await populated(t), first = f.service.view.session, records = await f.service.state.records(first);
    f.git('switch', '-qc', 'other'); await f.service.refresh(); await f.choose(); await f.mark(['src/a.txt']);
    await f.service.add(f.service.selection('src/a.txt'), 'other branch note'); const other = f.service.view.session;
    const before = await files(f.service.state.location(other)), note = f.service.view.notes.comments[0];
    const blob = path.join(f.service.state.location(first), 'blobs', records['src/a.txt'].right.hash);
    if (corrupt) await fs.writeFile(blob, 'corrupt'); else await fs.unlink(blob);
    await assert.rejects(f.service.state.records(first));
    await f.service.purgeReview(first.id); await absent(f.service.state.location(first));
    assert.equal(f.service.view.session.id, other.id); assert.equal(f.service.view.files[0].status, 'reviewed');
    assert.deepEqual(await files(f.service.state.location(other)), before); assert.deepEqual(f.service.view.notes.comments, [note]);
  }
});
test('损坏的 Agent 回复不阻止删除，评论归属损坏仍阻止正文清理', async t => {
  const f = await populated(t), session = f.service.view.session, note = f.service.view.notes.comments[0];
  const reply = path.join(f.service.comments.folder, 'replies', note.id + '.json'); await fs.writeFile(reply, '{');
  await f.service.purgeReview(session.id); await absent(reply); assert.equal(f.service.view.sessions.length, 0);
  const g = await populated(t), current = g.service.view.session, comment = g.service.view.notes.comments[0];
  const file = path.join(g.service.comments.folder, 'comments', comment.id + '.json');
  await fs.writeFile(file, JSON.stringify({ ...comment, scope: hash('different scope') }));
  await assert.rejects(g.service.purgeReview(current.id), /来源信息损坏/);
  assert.equal(JSON.parse(await fs.readFile(file)).body, 'first comment');
  assert.equal(JSON.parse(await fs.readFile(g.service.comments.reviewFile(current))).deleted, true);
});
