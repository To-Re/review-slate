'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../fixtures.cjs');
const { FILE_LIMIT } = require('../../dist/model');

test('batched blobs preserve binary framing, duplicate objects, paths and executable modes', async t => {
  const binary = Buffer.from('header\n0123456789 blob 3\n\0\xff\n', 'latin1');
  const initial = { 'src/a.txt': binary, 'src/b.txt': binary, 'src/line\nname': 'other\n', executable: 'script\n' };
  const f = await fixture(t, initial);
  const calls = [], read = f.repo.read.bind(f.repo);
  f.repo.read = async (...args) => { calls.push(args[0]); return read(...args); };
  for (const file of Object.keys(initial)) await f.write(file, 'new: ' + file);
  await fs.chmod(path.join(f.root, 'executable'), 0o755);
  const files = await f.repo.scan(f.base);
  for (const [name, bytes] of Object.entries(initial)) {
    const row = files.find(file => file.path === name);
    assert.ok(row && !row.error, name); assert.deepEqual(row.left.data, Buffer.from(bytes));
    assert.equal(row.right.data.toString(), 'new: ' + name);
  }
  assert.equal(files.find(file => file.path === 'executable').right.mode, '100755');
  assert.equal(calls.filter(args => args[0] === 'cat-file').length, 2);
  assert.ok(calls.some(args => args[1] === '--batch-check'));
  assert.ok(calls.some(args => args[1] === '--batch'));
});

test('a missing baseline blob stays an error without hiding healthy changes in the same batch', async t => {
  const f = await fixture(t);
  const oid = f.git('rev-parse', f.base + ':src/a.txt');
  await fs.unlink(path.join(f.root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  await f.write('src/a.txt', 'changed missing'); await f.write('src/b.txt', 'changed readable');
  const files = await f.repo.scan(f.base);
  assert.ok(files.find(file => file.path === 'src/a.txt').error);
  const healthy = files.find(file => file.path === 'src/b.txt');
  assert.equal(healthy.error, undefined); assert.equal(healthy.left.data.toString(), 'beta\n');
  assert.equal(healthy.right.data.toString(), 'changed readable');
});

test('large blob batches split below the Git output limit and reject oversized individual baselines', async t => {
  const initial = Object.fromEntries(Array.from({ length: 4 }, (_, i) => ['large-' + i, Buffer.alloc(FILE_LIMIT, 65 + i)]));
  initial.oversized = Buffer.alloc(FILE_LIMIT + 1, 90);
  const f = await fixture(t, initial);
  const calls = [], read = f.repo.read.bind(f.repo);
  f.repo.read = async (...args) => { calls.push(args[0]); return read(...args); };
  for (const file of Object.keys(initial)) await f.write(file, 'small replacement');
  const files = await f.repo.scan(f.base);
  for (let i = 0; i < 4; i++) {
    const row = files.find(file => file.path === 'large-' + i);
    assert.equal(row.error, undefined); assert.deepEqual(row.left.data, initial['large-' + i]);
  }
  assert.match(files.find(file => file.path === 'oversized').error, /5 MiB/);
  assert.equal(calls.filter(args => args[0] === 'cat-file' && args[1] === '--batch').length, 2);
});
