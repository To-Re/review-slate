const { test } = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const { fixture } = require('./fixtures.cjs');
let picker;
class Picker {
  items = []; selectedItems = []; value = ''; enabled = true; busy = false; disposed = false;
  handlers = new Map();
  on(name, fn) { this.handlers.set(name, fn); return { dispose: () => this.handlers.delete(name) }; }
  onDidHide = fn => this.on('hide', fn);
  onDidChangeValue = fn => this.on('change', fn);
  onDidAccept = fn => this.on('accept', fn);
  show() { this.shown = true; }
  dispose() { this.disposed = true; }
  type(value) { this.value = value; this.selectedItems = []; this.handlers.get('change')?.(value); }
  accept() { this.handlers.get('accept')?.(); }
  hide() { this.handlers.get('hide')?.(); }
}
const previous = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? { window: { createQuickPick: () => picker = new Picker() } } : previous.call(this, id, ...args); };
let pickCommit;
try { ({ pickCommit } = require('../dist/commit-picker')); } finally { Module._load = previous; }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function opened(repo) { const result = pickCommit(repo); while (!picker?.shown) await tick(); return { result, ui: picker }; }

test('完整、短 SHA 可直接选择最近列表以外的提交，取消和错误不改变当前审阅', async t => {
  const f = await fixture(t); await f.choose();
  await f.write('src/a.txt', 'reviewed change\n'); await f.service.refresh(); await f.mark(['src/a.txt']);
  const original = f.service.view.session;
  await f.service.add(f.service.selection('src/a.txt'), 'retain this review');
  const note = f.service.view.notes.comments[0];
  f.git('add', '-A'); f.git('commit', '-qm', 'later');
  const latest = f.git('rev-parse', 'HEAD'), latestInfo = await f.repo.commitInfo(latest);
  const repo = { commits: async () => [latestInfo], resolve: ref => f.repo.resolve(ref) };
  for (const input of [' ' + f.base.toUpperCase() + ' ', f.base.slice(0, 9)]) {
    picker = undefined;
    const { result, ui } = await opened(repo);
    assert.equal(ui.matchOnDetail, true); assert.equal(ui.items[0].detail, latest);
    ui.type(input); assert.equal(ui.items[0].alwaysShow, true); ui.accept();
    assert.equal((await result).ref, f.base); assert.equal(ui.disposed, true);
  }
  picker = undefined;
  const { result, ui } = await opened(repo);
  ui.type('f'.repeat(40)); ui.accept();
  while (ui.busy) await tick();
  assert.equal(ui.disposed, false); assert.equal(ui.value, 'f'.repeat(40)); assert.match(ui.items[0].label, /无法选择/);
  assert.equal(f.service.view.session.id, original.id);
  ui.type('later'); ui.selectedItems = [ui.items.find(i => i.oid === latest)]; ui.accept();
  assert.equal((await result).ref, latest);
  picker = undefined;
  const cancelled = await opened(repo); cancelled.ui.hide(); assert.equal(await cancelled.result, undefined);
  await f.service.refresh();
  assert.equal(f.service.view.session.id, original.id); assert.equal(f.service.view.files.find(x => x.path === 'src/a.txt').status, 'reviewed');
  assert.ok(f.service.view.notes.comments.some(x => x.id === note.id));
});

test('解析期间取消不会稍后选中提交；重复回车只解析一次', async () => {
  let resolveCommit, calls = 0;
  picker = undefined;
  const { result, ui } = await opened({ commits: async () => [], resolve: () => { calls++; return new Promise(resolve => resolveCommit = resolve); } });
  ui.type('a'.repeat(40)); ui.accept(); ui.accept(); assert.equal(calls, 1);
  ui.hide(); assert.equal(await result, undefined);
  resolveCommit('a'.repeat(40)); await tick();
  assert.equal(ui.disposed, true); assert.equal(ui.handlers.size, 0);
});
