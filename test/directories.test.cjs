const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const { fixture, env } = require('./fixtures.cjs');
const { sameTarget, CommentRepository } = require('../dist/comments');
const { anchorFor } = require('../dist/anchors');

test('目录评论保留范围和绝对路径，不改变文件审阅进度；提交和新进程恢复后仍在', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh(); await f.mark(['src/a.txt']);
  const selection = f.service.directorySelection('src');
  assert.notEqual(selection.draftKey, f.service.selection('src/a.txt').draftKey);
  await f.service.add(selection, '这个模块需要统一错误处理');
  const note = f.service.view.notes.comments[0];
  assert.equal(note.target, 'directory'); assert.equal(note.path, 'src'); assert.equal(note.anchor, undefined);
  assert.equal(f.service.view.files[0].status, 'reviewed'); assert.equal(f.service.view.files.length, 1);
  const pending = await fs.readFile(path.join(f.root, '.code-review/PENDING.md'), 'utf8');
  assert.ok(pending.includes('目录："src/"')); assert.ok(pending.includes(JSON.stringify(path.join(f.root, 'src')))); assert.ok(pending.includes('该目录及其子目录'));
  const guide = await fs.readFile(path.join(f.root, '.code-review/README.md'), 'utf8'); assert.ok(guide.includes('target 为 directory'));
  f.git('add', 'src/a.txt'); f.git('commit', '-qm', 'after review');
  const script = `(async()=>{const {GitRepository}=require('./dist/git'); const {ReviewService}=require('./dist/review');const s=new ReviewService(await GitRepository.open(process.argv[1]),process.argv[2]);await s.start();console.log(JSON.stringify({notes:s.view.notes.comments,files:s.view.files,selection:s.directorySelection('src')}));})().catch(e=>{console.error(e);process.exit(1)});`;
  const restored = JSON.parse(execFileSync(process.execPath, ['-e', script, f.root, f.storage], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }));
  assert.equal(restored.notes[0].id, note.id); assert.equal(restored.selection.target, 'directory'); assert.equal(restored.files[0].status, 'reviewed');
  await f.service.choose('HEAD', 'new base'); assert.equal(f.service.view.files.length, 0); assert.equal(f.service.view.notes.comments.length, 0);
  await f.choose(); assert.equal(f.service.directorySelection('src').target, 'directory'); assert.equal(f.service.view.notes.comments[0].id, note.id);
});

test('目录评论可编辑、删除与恢复；目录变成同名文件后两者身份仍独立', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh();
  await f.service.add(f.service.directorySelection('src'), 'directory note');
  let note = f.service.view.notes.comments[0];
  await f.service.comments.update(note.id, note.revision, { body: 'edited directory' }); note = (await f.service.comments.load()).comments[0];
  assert.equal(note.target, 'directory');
  await f.service.comments.remove(note.id, note.revision); await f.service.refresh();
  assert.equal(f.service.directorySelection('src').target, 'directory');
  const again = new CommentRepository(f.root); await again.restore(note.id, note.revision); await f.service.refresh();
  await fs.rm(path.join(f.root, 'src'), { recursive: true }); await f.write('src', 'now a file'); await f.service.refresh();
  await f.service.add(f.service.selection('src'), 'file note');
  const notes = f.service.view.notes.comments;
  assert.equal(notes.filter(c => sameTarget(c, 'src', 'directory')).length, 1);
  assert.equal(notes.filter(c => sameTarget(c, 'src', 'file')).length, 1);
  assert.notEqual(f.service.directorySelection('src').draftKey, f.service.selection('src').draftKey);
  assert.equal(notes.find(c => c.id === note.id).body, 'edited directory');
});

test('目录评论拒绝代码行锚点、危险路径与跨类型的重复请求', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh();
  for (const name of ['../src', '.code-review', '.git', 'missing']) assert.throws(() => f.service.directorySelection(name));
  const directory = f.service.directorySelection('src'), file = f.service.selection('src/a.txt');
  await assert.rejects(f.service.add(directory, 'bad', anchorFor(file.pair.right, 'right', 0, 0)), /不能绑定代码行/);
  const id = randomUUID(); await f.service.add(directory, 'note', undefined, id);
  await assert.rejects(f.service.comments.add(directory.session, 'src', directory.pair, 'note', undefined, id), /重复请求/);
  assert.equal((await f.service.comments.load()).comments.length, 1);
});
