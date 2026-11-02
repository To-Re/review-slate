const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures.cjs');
const { CommentRepository, noteStatus } = require('../dist/comments');
const { anchorFor, locate } = require('../dist/anchors');
const { snapshotId } = require('../dist/model');
const snap = text => ({ mode: '100644', data: Buffer.from(text) });

test('未保存评论前项目没有数据目录', async t => {
  const f = await fixture(t); await f.choose(); await f.service.refresh();
  await assert.rejects(fs.stat(path.join(f.root, '.code-review')), { code: 'ENOENT' });
});
test('多文件、多意见、待处理清单与并发写入均可恢复', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.write('src/b.txt', 'b2'); await f.service.refresh();
  await f.service.add(f.service.selection('src/a.txt'), 'first');
  const another = new CommentRepository(f.root), s = f.service.view.session;
  await Promise.all([f.service.comments.add(s, 'src/a.txt', f.service.selection('src/a.txt').pair, 'second'),
    another.add(s, 'src/b.txt', f.service.selection('src/b.txt').pair, 'third')]);
  const notes = await another.load(); assert.equal(notes.comments.length, 3); assert.equal(new Set(notes.comments.map(x => x.id)).size, 3);
  const pending = await fs.readFile(path.join(f.root, '.code-review/PENDING.md'), 'utf8');
  for (const c of notes.comments) { assert.ok(pending.includes(c.id)); assert.ok(pending.includes(c.body)); }
});
test('同一保存请求重试不会生成重复评论，ID 相同但内容不同拒绝覆盖', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh();
  const id = randomUUID(), pair = f.service.selection('src/a.txt').pair, s = f.service.view.session;
  await f.service.comments.add(s, 'src/a.txt', pair, 'comment', undefined, id);
  await f.service.comments.add(s, 'src/a.txt', pair, 'comment', undefined, id);
  assert.equal((await f.service.comments.load()).comments.length, 1);
  await assert.rejects(f.service.comments.add(s, 'src/a.txt', pair, 'different', undefined, id), /重复请求/);
});
test('Agent 回复待复核，编辑正文和重新打开使旧回复失效', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.service.add(f.service.selection('src/a.txt'), 'check');
  let note = f.service.view.notes.comments[0];
  const reply = { version: 1, commentId: note.id, commentRevision: note.revision, body: '已修改并验证', updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(f.root, '.code-review/replies', note.id + '.json'), JSON.stringify(reply));
  await f.service.refresh(); assert.equal(noteStatus(note, reply), 'Agent 已回复，待复核'); assert.equal(f.service.view.notes.comments[0].state, 'open');
  await f.service.comments.update(note.id, note.revision, { body: 'additional requirement' }); note = (await f.service.comments.load()).comments[0];
  assert.equal(noteStatus(note, reply), '待处理'); const revision = note.revision;
  await f.service.comments.update(note.id, revision, { state: 'resolved' }); note = (await f.service.comments.load()).comments[0]; assert.equal(noteStatus(note, reply), '已解决');
  await f.service.comments.update(note.id, note.revision, { state: 'open' }); note = (await f.service.comments.load()).comments[0]; assert.notEqual(note.revision, revision);
  await assert.rejects(f.service.comments.update(note.id, revision, { body: 'stale' }), /其他窗口/);
});
test('评论损坏不被忽略或覆盖，JSON 更新保留有效备份', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.service.add(f.service.selection('src/a.txt'), 'original');
  let c = f.service.view.notes.comments[0], file = path.join(f.root, '.code-review/comments', c.id + '.json');
  await f.service.comments.update(c.id, c.revision, { body: 'new' });
  assert.equal(JSON.parse(await fs.readFile(file + '.bak', 'utf8')).body, 'original');
  await fs.writeFile(file, '{bad'); await assert.rejects(f.service.comments.load(), /数据损坏/); assert.equal(await fs.readFile(file, 'utf8'), '{bad');
});
test('现有非工具目录和符号链接不覆盖、不越界读取', async t => {
  const f = await fixture(t); const folder = path.join(f.root, '.code-review');
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'other.txt'), 'keep');
  await assert.rejects(f.service.comments.load(), /缺少工具标识/); assert.equal(await fs.readFile(path.join(folder, 'other.txt'), 'utf8'), 'keep');
  await fs.rm(folder, { recursive: true }); const outside = path.join(f.temp, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, folder);
  await assert.rejects(f.service.comments.load(), /不是普通目录/); assert.deepEqual(await fs.readdir(outside), []);
});
test('评论文件和回执中的符号链接不会读取目标', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.service.add(f.service.selection('src/a.txt'), 'note');
  const c = f.service.view.notes.comments[0], noteFile = path.join(f.root, '.code-review/comments', c.id + '.json'), outside = path.join(f.temp, 'target');
  await fs.writeFile(outside, await fs.readFile(noteFile)); await fs.unlink(noteFile); await fs.symlink(outside, noteFile);
  await assert.rejects(f.service.comments.load()); await fs.unlink(noteFile); await fs.copyFile(outside, noteFile);
  await fs.symlink(outside, path.join(f.root, '.code-review/replies', c.id + '.json')); await assert.rejects(f.service.comments.load());
});
test('空内容、危险路径、超长正文不会写评论', async t => {
  const f = await fixture(t); await f.choose(); const s = f.service.view.session, pair = { left: snap('a'), right: snap('b') };
  for (const [name, text] of [['../escape', 'bad'], ['ok', ''], ['ok', 'x'.repeat(20001)]]) await assert.rejects(f.service.comments.add(s, name, pair, text));
  await assert.rejects(fs.stat(path.join(f.root, '.code-review')), { code: 'ENOENT' });
});
test('锚点：原位置与前置行插入后的唯一位置', () => {
  const original = snap('before1\nbefore2\nbefore3\nselected line\nafter1\nafter2\nafter3');
  const a = anchorFor(original, 'right', 3, 3);
  assert.equal(locate(a, { left: original, right: original }).kind, 'exact');
  const moved = locate(a, { left: original, right: snap('inserted\n' + original.data.toString()) });
  assert.deepEqual(moved, { kind: 'moved', start: 4, end: 4 });
  assert.deepEqual(locate(undefined), { kind: 'file' });
});
test('锚点：代码改变、整段删除、重复上下文不会沿用旧行号', () => {
  const text = 'b1\nb2\nb3\nselected\nx1\nx2\nx3', original = snap(text), a = anchorFor(original, 'right', 3, 3);
  assert.equal(locate(a, { left: original, right: snap(text.replace('selected', 'modified')) }).kind, 'changed');
  assert.equal(locate(a, { left: original, right: snap(text.replace('selected\n', '')) }).kind, 'unavailable');
  assert.equal(locate(a, { left: original, right: snap(text + '\n' + text) }).kind, 'unavailable');
});
test('锚点：左右侧独立，短空片段和非文本不会猜测位置', () => {
  const left = snap('left code longer than 16'), right = snap('right code longer than 16'), a = anchorFor(left, 'left', 0, 0);
  assert.equal(locate(a, { left, right }).kind, 'exact');
  assert.equal(locate(a, { left: right, right: left }).kind, 'unavailable');
  const blank = anchorFor(snap(''), 'right', 0, 0);
  assert.equal(locate(blank, { left, right: snap('\n') }).kind, 'unavailable');
  assert.throws(() => anchorFor({ mode: '100644', data: Buffer.from([0, 1]) }, 'right', 0, 0), /二进制/);
  assert.throws(() => anchorFor(snap(Array(202).fill('line').join('\n')), 'right', 0, 200), /200/);
});
test('保存锚点后原片段保留，文件删除后仍能读取原评论', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'b1\nb2\nb3\ntarget\na1\na2\na3'); await f.service.refresh();
  const selection = f.service.selection('src/a.txt'), anchor = anchorFor(selection.pair.right, 'right', 3, 3);
  await f.service.add(selection, 'code comment', anchor); await fs.unlink(path.join(f.root, 'src/a.txt')); await f.service.refresh();
  assert.deepEqual(f.service.view.notes.comments[0].anchor.selected, ['target']);
  assert.equal(f.service.view.notes.comments[0].anchor.hash, snapshotId(selection.pair.right));
  assert.ok(f.service.view.files.some(file => file.path === 'src/a.txt'));
});

test('删除指定评论：移出待处理清单，其他评论、已审记录与回复保留，重建后可撤销', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.mark(['src/a.txt']);
  const selected = f.service.selection('src/a.txt'); await f.service.add(selected, 'delete this'); await f.service.add(selected, 'keep this');
  const note = f.service.view.notes.comments.find(c => c.body === 'delete this'), session = f.service.view.session;
  const records = await f.service.state.records(session);
  const reply = { version: 1, commentId: note.id, commentRevision: note.revision, body: 'response', updatedAt: new Date().toISOString() };
  const replyFile = path.join(f.root, '.code-review/replies', note.id + '.json'); await fs.writeFile(replyFile, JSON.stringify(reply));
  const repository = f.service.comments;
  await repository.remove(note.id, note.revision); await repository.remove(note.id, note.revision);
  const fresh = new CommentRepository(f.root), data = await fresh.load();
  assert.deepEqual(data.comments.map(c => c.body), ['keep this']); assert.deepEqual(data.deleted, [note]);
  assert.ok(!(await fs.readFile(path.join(f.root, '.code-review/PENDING.md'), 'utf8')).includes(note.id));
  assert.deepEqual(JSON.parse(await fs.readFile(replyFile, 'utf8')), reply);
  assert.deepEqual(await f.service.state.records(session), records);
  await assert.rejects(repository.add(session, selected.file, selected.pair, note.body, undefined, note.id), /已删除/);
  await fresh.restore(note.id, note.revision); await fresh.restore(note.id, note.revision);
  const restored = await fresh.load(); assert.equal(restored.comments.length, 2); assert.equal(restored.deleted.length, 0);
  assert.deepEqual(restored.comments.find(c => c.id === note.id), note); assert.deepEqual(restored.replies.get(note.id), reply);
  assert.ok((await fs.readFile(path.join(f.root, '.code-review/PENDING.md'), 'utf8')).includes(note.id));
});
test('删除和撤销检查版本；已解决评论可删除；删除后无差异文件仍提供恢复入口', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.service.add(f.service.selection('src/a.txt'), 'original');
  let note = f.service.view.notes.comments[0]; const oldRevision = note.revision;
  await f.service.comments.update(note.id, note.revision, { body: 'edited', state: 'resolved' }); note = (await f.service.comments.load()).comments[0];
  await assert.rejects(f.service.comments.remove(note.id, oldRevision), /其他窗口/);
  await f.service.comments.remove(note.id, note.revision); await f.write('src/a.txt', 'alpha\n'); await f.service.refresh();
  assert.equal(f.service.view.files[0].deletedOnly, true); assert.equal(f.service.view.files[0].commentOnly, true);
  await assert.rejects(f.service.comments.restore(note.id, oldRevision), /其他窗口/);
  await f.service.comments.restore(note.id, note.revision); assert.equal((await f.service.comments.load()).comments[0].state, 'resolved');
});
test('删除失败不丢评论：拒绝链接恢复区，发布失败后可重试或撤销', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'a2'); await f.service.refresh(); await f.service.add(f.service.selection('src/a.txt'), 'keep safe');
  const note = f.service.view.notes.comments[0], folder = path.join(f.root, '.code-review');
  const outside = path.join(f.temp, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(folder, 'deleted'));
  await assert.rejects(f.service.comments.remove(note.id, note.revision), /不是普通目录/);
  assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'comments', note.id + '.json'))).body, 'keep safe');
  assert.deepEqual(await fs.readdir(outside), []); await fs.unlink(path.join(folder, 'deleted'));
  await fs.unlink(path.join(folder, 'PENDING.md')); await fs.symlink(path.join(outside, 'pending'), path.join(folder, 'PENDING.md'));
  await assert.rejects(f.service.comments.remove(note.id, note.revision));
  assert.equal((await new CommentRepository(f.root).load()).deleted[0].body, 'keep safe');
  await fs.unlink(path.join(folder, 'PENDING.md')); await f.service.comments.remove(note.id, note.revision); await f.service.comments.restore(note.id, note.revision);
  assert.equal((await f.service.comments.load()).comments[0].body, 'keep safe');
});
