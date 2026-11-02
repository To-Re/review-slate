const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./fixtures.cjs');
const { anchorFor } = require('../dist/anchors');
const { writeChanged, readBytes } = require('../dist/filesystem');

const large = 'x'.repeat(17 * 1024 * 1024);
const legacyPending = (id, tail = '') => '# 待处理审阅意见\n\n## ' + id + '\n\n> ' + large + '\n' + tail;
const modernPending = (id, tail = '') => '# 待处理审阅意见\n\nCR：' + id + '\n\n> ' + large + '\n' + tail;
async function populated(t) {
  const f = await fixture(t); await f.write('src/a.txt', 'changed\n'); await f.choose();
  await f.service.add(f.service.selection('src/a.txt'), 'preserved original');
  return { ...f, session: f.service.view.session, note: f.service.view.notes.comments[0], pending: path.join(f.service.comments.folder, 'PENDING.md') };
}
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }

test('850 条合法长正文及选区的清单受总预算控制，全部 ID 和全文引用保留，重复刷新可恢复', async t => {
  const f = await fixture(t);
  await f.write('src/a.txt', ['前'.repeat(512), '码'.repeat(512), '后'.repeat(512)].join('\n')); await f.choose();
  const selection = f.service.selection('src/a.txt'), anchor = anchorFor(selection.pair.right, 'right', 1, 1);
  await f.service.add(selection, '文'.repeat(512) + 'x'.repeat(19488), anchor);
  const seed = f.service.view.notes.comments[0], ids = [seed.id], folder = f.service.comments.folder;
  for (let i = 1; i < 850; i++) {
    const id = randomUUID(); ids.push(id);
    await fs.writeFile(path.join(folder, 'comments', id + '.json'), JSON.stringify({ ...seed, id, revision: randomUUID() }));
  }
  const reply = { version: 1, commentId: seed.id, commentRevision: seed.revision, body: '答'.repeat(50000), updatedAt: '2026-01-01' };
  const replyFile = path.join(folder, 'replies', seed.id + '.json'); await fs.writeFile(replyFile, JSON.stringify(reply));
  const source = await fs.readFile(path.join(folder, 'comments', seed.id + '.json')), replyBytes = await fs.readFile(replyFile);
  await f.service.refresh(); await f.service.refresh();
  const pending = await fs.readFile(f.service.comments.pendingFile(f.service.view.session), 'utf8');
  assert.ok(Buffer.byteLength(pending) <= 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(pending) > 3 * 1024 * 1024, 'exercise the total summary budget');
  assert.equal((pending.match(/^## /gm) || []).length, 850);
  for (const id of ids) assert.ok(pending.includes('.code-review/comments/' + id + '.json'));
  assert.ok(pending.includes('.code-review/replies/' + seed.id + '.json'));
  assert.match(pending, /预算不足时省略摘要/); assert.doesNotMatch(pending, /\uFFFD/);
  assert.ok(!pending.includes(seed.body)); assert.ok(!pending.includes(reply.body));
  assert.deepEqual(await fs.readFile(path.join(folder, 'comments', seed.id + '.json')), source);
  assert.deepEqual(await fs.readFile(replyFile), replyBytes);
  assert.equal(f.service.view.notes.comments.length, 850);
  assert.deepEqual(await fs.readFile(path.join(folder, 'PENDING.md')), Buffer.from(pending));
});

test('超过 16 MiB 的旧根清单和 CR 清单可以刷新替换，JSON 读取上限保持', async t => {
  const f = await populated(t), scoped = f.service.comments.pendingFile(f.session);
  for (const file of [f.pending, scoped]) await fs.writeFile(file, modernPending(f.session.id));
  await assert.rejects(readBytes(f.pending, 16 * 1024 * 1024), /超过大小限制/);
  await f.service.refresh(); await f.service.refresh();
  for (const file of [f.pending, scoped]) {
    assert.ok((await fs.stat(file)).size < 4 * 1024 * 1024);
    assert.match(await fs.readFile(file, 'utf8'), /preserved original/);
  }
});

test('旧大清单及其备份、临时副本可永久清理，其他 CR 的大副本和评论保留', async t => {
  const f = await populated(t), folder = f.service.comments.folder;
  f.git('switch', '-qc', 'other'); await f.service.refresh(); await f.choose();
  await f.service.add(f.service.selection('src/a.txt'), 'other CR original');
  const other = f.service.view.session, otherNote = f.service.view.notes.comments[0];
  const otherFile = path.join(folder, 'comments', otherNote.id + '.json'), otherBytes = await fs.readFile(otherFile);
  const ownedBackup = f.pending + '.bak', otherTemp = f.pending + '.' + randomUUID() + '.tmp';
  await fs.writeFile(f.pending, modernPending(other.id, 'CR：' + f.session.id + '\n## ' + f.note.id + '\n'));
  await fs.writeFile(ownedBackup, modernPending(f.session.id));
  const otherPending = modernPending(other.id, 'CR：' + f.session.id + '\n'); await fs.writeFile(otherTemp, otherPending);
  await fs.writeFile(f.service.comments.pendingFile(f.session), modernPending(f.session.id));
  await f.service.purgeReview(f.session.id);
  await absent(ownedBackup); await absent(path.dirname(f.service.comments.pendingFile(f.session)));
  assert.equal(await fs.readFile(otherTemp, 'utf8'), otherPending);
  assert.deepEqual(await fs.readFile(otherFile), otherBytes);
  assert.equal(f.service.view.session.id, other.id);
  assert.match(await fs.readFile(f.pending, 'utf8'), new RegExp('CR：' + other.id));
});

test('永久删除当前 CR 能恢复旧大根清单，第一阶段失败仍保留原文与可重试状态', async t => {
  const f = await populated(t), scoped = f.service.comments.pendingFile(f.session), originalRename = fs.rename;
  await fs.writeFile(f.pending, modernPending(f.session.id)); await fs.writeFile(scoped, modernPending(f.session.id));
  fs.rename = async (from, to) => { if (to === scoped) throw new Error('injected pending replacement failure'); return originalRename(from, to); };
  try { await assert.rejects(f.service.purgeReview(f.session.id), /injected pending/); } finally { fs.rename = originalRename; }
  assert.equal(await f.service.state.isPurged(f.session.id), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.service.comments.folder, 'comments', f.note.id + '.json'))).body, f.note.body);
  assert.match(await fs.readFile(f.pending, 'utf8'), /永久删除，禁止处理/);
  assert.ok((await fs.stat(scoped)).size > 16 * 1024 * 1024);
  await f.service.purgeReview(f.session.id);
  await absent(path.dirname(scoped)); assert.equal(f.service.view.sessions.length, 0);
});

test('无 CR 头部的旧大清单按完整评论 ID 集合确认归属，包括超长行之后的标题', async t => {
  const f = await populated(t);
  const backup = f.pending + '.bak', old = legacyPending(f.note.id, '## ' + f.note.id + '\n');
  await fs.writeFile(f.pending, old); await fs.writeFile(backup, old);
  await f.service.purgeReview(f.session.id); await absent(backup);
  assert.equal(f.service.view.sessions.length, 0);
});

test('旧大清单后部混入其他 CR 时拒绝破坏性阶段，不以首条评论误判归属', async t => {
  const f = await populated(t);
  f.git('switch', '-qc', 'other'); await f.service.refresh(); await f.choose();
  await f.service.add(f.service.selection('src/a.txt'), 'other CR original');
  const other = f.service.view.notes.comments[0], old = legacyPending(f.note.id, '## ' + other.id + '\n');
  await fs.writeFile(f.pending, old);
  await assert.rejects(f.service.purgeReview(f.session.id), /不同 CR/);
  assert.equal(await f.service.state.isPurged(f.session.id), false);
  assert.equal(await fs.readFile(f.pending, 'utf8'), old);
  for (const note of [f.note, other]) assert.equal(JSON.parse(await fs.readFile(path.join(f.service.comments.folder, 'comments', note.id + '.json'))).body, note.body);
});

test('超长或损坏 CR 头部不会退回按正文评论 ID 猜测归属', async t => {
  const f = await populated(t), old = '# 待处理审阅意见\n\nCR：' + 'a'.repeat(5000) + '\n## ' + f.note.id + '\n';
  await fs.writeFile(f.pending, old);
  await assert.rejects(f.service.purgeReview(f.session.id), /CR 标识无效/);
  assert.equal(await f.service.state.isPurged(f.session.id), false);
  assert.equal(await fs.readFile(f.pending, 'utf8'), old);
});

test('大文件恢复拒绝链接、目录和 FIFO，不进入永久删除阶段', async t => {
  const f = await populated(t), outside = path.join(f.temp, 'external-pending');
  await fs.writeFile(outside, modernPending(f.session.id));
  for (const kind of ['link', 'directory', 'fifo']) {
    await fs.rm(f.pending, { recursive: true, force: true });
    if (kind === 'link') await fs.symlink(outside, f.pending);
    else if (kind === 'directory') await fs.mkdir(f.pending);
    else execFileSync('mkfifo', [f.pending]);
    await assert.rejects(writeChanged(f.pending, 'replacement'));
    await assert.rejects(f.service.purgeReview(f.session.id));
    assert.equal(await f.service.state.isPurged(f.session.id), false);
  }
  assert.equal(await fs.readFile(outside, 'utf8'), modernPending(f.session.id));
});

test('大清单前缀读取时被修改或更换文件均报并发错误，保留竞争写入', async t => {
  const f = await populated(t), originalOpen = fs.open;
  for (const replace of [false, true]) {
    await fs.writeFile(f.pending, modernPending(f.session.id));
    let injected = false;
    fs.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (file === f.pending) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          if (!injected) {
            injected = true;
            if (replace) {
              const replacement = path.join(f.temp, 'replacement'); await fs.writeFile(replacement, 'concurrent replacement'); await fs.rename(replacement, f.pending);
            } else await fs.appendFile(f.pending, 'concurrent append');
          }
          return result;
        };
      }
      return handle;
    };
    try { await assert.rejects(f.service.purgeReview(f.session.id), /文件正在改变/); } finally { fs.open = originalOpen; }
    assert.equal(await f.service.state.isPurged(f.session.id), false);
    assert.ok((await fs.readFile(f.pending, 'utf8')).includes('concurrent'));
  }
});

test('比较后原子替换前的并发写入不会被覆盖，临时输出会清理', async t => {
  const f = await populated(t), originalOpen = fs.open;
  await fs.writeFile(f.pending, modernPending(f.session.id));
  let injected = false;
  fs.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (typeof file === 'string' && file.startsWith(f.pending + '.') && file.endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        if (!injected) { injected = true; await fs.writeFile(f.pending, 'concurrent saved output'); }
      };
    }
    return handle;
  };
  try { await assert.rejects(writeChanged(f.pending, 'replacement'), /文件正在改变/); } finally { fs.open = originalOpen; }
  assert.equal(await fs.readFile(f.pending, 'utf8'), 'concurrent saved output');
  assert.equal((await fs.readdir(path.dirname(f.pending))).filter(name => /^PENDING\.md.*\.tmp$/.test(name)).length, 0);
});
