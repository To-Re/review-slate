const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { fixture } = require('./fixtures.cjs');
const { handoffText } = require('../dist/handoff');

test('可编辑目标：拒绝过期内容、链接及父目录链接，不读取目标作为工作区', async t => {
  const f = await fixture(t); const original = await f.repo.pair(f.base, 'src/a.txt');
  assert.equal(await f.repo.editablePath('src/a.txt', original.right), path.join(f.root, 'src/a.txt'));
  await f.write('src/a.txt', 'new contents\n');
  assert.equal(await f.repo.editablePath('src/a.txt', original.right), undefined);
  const updated = await f.repo.pair(f.base, 'src/a.txt');
  await fs.rename(path.join(f.root, 'src'), path.join(f.temp, 'outside'));
  await fs.symlink(path.join(f.temp, 'outside'), path.join(f.root, 'src'));
  assert.equal(await f.repo.editablePath('src/a.txt', updated.right), undefined);
  await fs.symlink(path.join(f.temp, 'outside/a.txt'), path.join(f.root, 'link.txt'));
  const link = await f.repo.pair(f.base, 'link.txt');
  assert.equal(await f.repo.editablePath('link.txt', link.right), undefined);
});

test('保存回到基点后：仍可给已打开文件评论，保留保存后的真实片段', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'changed\n'); await f.choose();
  await f.write('src/a.txt', 'alpha\n'); await f.service.refresh(); assert.equal(f.service.view.files.length, 0);
  const current = await f.service.capture('src/a.txt');
  const { anchorFor } = require('../dist/anchors');
  await f.service.add(current, 'still needs attention', anchorFor(current.pair.right, 'right', 0, 0));
  assert.deepEqual(f.service.view.notes.comments[0].anchor.selected, ['alpha']);
  assert.equal(f.service.view.files[0].commentOnly, true);
});

test('标记前出现未保存编辑：最终保护拒绝写已审快照', async t => {
  const f = await fixture(t); await f.write('src/a.txt', 'changed\n'); await f.choose();
  const row = f.service.view.files[0];
  await assert.rejects(f.service.mark({ session: f.service.view.session.id, files: [{ path: row.path, fingerprint: row.fingerprint, checked: true }] }, () => { throw new Error('未保存'); }), /未保存/);
  assert.deepEqual(Object.keys(await f.service.state.records(f.service.view.session)), []);
});

test('Agent 交接：空格和引号路径明确引用，远程路径指明所属文件系统', () => {
  const root = '/work/my project "quoted"';
  const local = handoffText(root), remote = handoffText(root, 'ssh-remote');
  for (const relative of ['', '.code-review/README.md', '.code-review/PENDING.md', '.code-review/comments', '.code-review/replies']) {
    assert.ok(local.includes(JSON.stringify(path.join(root, relative))));
  }
  assert.match(local, /本地文件系统/); assert.match(remote, /远端文件系统/); assert.match(remote, /ssh-remote/);
  assert.match(remote, /路径不存在或项目不匹配/);
});
