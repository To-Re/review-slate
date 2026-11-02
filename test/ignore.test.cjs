const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { fixture } = require('./fixtures.cjs');

test('首次保存评论创建根忽略规则，评论和 Agent 清单不出现在 Git 未跟踪列表，重复刷新不重复追加', async t => {
  const f = await fixture(t), file = path.join(f.root, '.gitignore'); await fs.unlink(file);
  await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh();
  await f.service.add(f.service.selection('src/a.txt'), 'local review');
  assert.equal(await fs.readFile(file, 'utf8'), '/.code-review/\n');
  assert.equal(f.git('check-ignore', '.code-review/comments', '.code-review/PENDING.md').split('\n').length, 2);
  assert.ok(!f.git('ls-files', '--others', '--exclude-standard').includes('.code-review'));
  await f.service.refresh(); assert.equal(await fs.readFile(file, 'utf8'), '/.code-review/\n');
  assert.equal(f.service.view.notes.comments[0].body, 'local review');
});
test('升级已有评论时补忽略规则，保留 BOM、CRLF、原规则与无末尾换行；后置反选规则不覆盖 CR 忽略', async t => {
  const f = await fixture(t); await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh();
  await f.service.add(f.service.selection('src/a.txt'), 'keep'); const file = path.join(f.root, '.gitignore');
  const old = '\ufeff# custom rules\r\nnode_modules/\r\n.code-review/\r\n!/.code-review/';
  await fs.writeFile(file, old); await f.service.refresh();
  assert.equal(await fs.readFile(file, 'utf8'), old + '\r\n/.code-review/\r\n');
  assert.equal(f.git('check-ignore', '.code-review/PENDING.md'), '.code-review/PENDING.md');
  await f.service.refresh(); assert.equal(await fs.readFile(file, 'utf8'), old + '\r\n/.code-review/\r\n');
});
test('已有忽略规则保持字节和文件权限不变；没有评论时不修改仓库', async t => {
  const f = await fixture(t), file = path.join(f.root, '.gitignore');
  const old = '# existing\n.code-review/\n/output\n'; await fs.writeFile(file, old); await fs.chmod(file, 0o644);
  await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh(); await f.service.add(f.service.selection('src/a.txt'), 'note');
  assert.equal(await fs.readFile(file, 'utf8'), old); assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  const second = await fixture(t); await fs.unlink(path.join(second.root, '.gitignore')); await second.choose(); await second.service.refresh();
  await assert.rejects(fs.stat(path.join(second.root, '.gitignore')), { code: 'ENOENT' });
});
test('拒绝链接、特殊文件与非法编码的 gitignore，不写链接目标或误报评论保存成功', async t => {
  const f = await fixture(t), file = path.join(f.root, '.gitignore'), outside = path.join(f.temp, 'outside');
  await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh(); const selection = f.service.selection('src/a.txt');
  await fs.writeFile(outside, 'preserve'); await fs.unlink(file); await fs.symlink(outside, file);
  await assert.rejects(f.service.add(selection, 'blocked')); assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
  await fs.unlink(file); await fs.mkdir(file); await assert.rejects(f.service.add(selection, 'blocked'));
  await fs.rmdir(file); await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0])); await assert.rejects(f.service.add(selection, 'blocked'));
  assert.equal((await f.service.comments.load()).comments.length, 0);
});
test('仅忽略规则尾随的普通空格，制表符和不换行空格不被误认为有效规则', async t => {
  for (const suffix of ['  ', '\t', '\u00a0']) {
    const f = await fixture(t), file = path.join(f.root, '.gitignore'), original = '.code-review/' + suffix + '\n';
    await fs.writeFile(file, original); await f.choose(); await f.write('src/a.txt', 'changed'); await f.service.refresh();
    await f.service.add(f.service.selection('src/a.txt'), 'note');
    assert.equal(await fs.readFile(file, 'utf8'), original + (suffix === '  ' ? '' : '/.code-review/\n'));
    assert.equal(f.git('check-ignore', '.code-review/PENDING.md'), '.code-review/PENDING.md');
    const saved = await fs.readFile(file); await f.service.refresh(); assert.deepEqual(await fs.readFile(file), saved);
  }
});
