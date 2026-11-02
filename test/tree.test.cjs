const { test } = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const mock = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { static File = { id: 'file' }; constructor(id, color) { this.id = id; this.color = color; } },
  TreeItem: class { constructor(label, collapsed) { this.label = label; this.collapsibleState = collapsed; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
  Uri: { from: o => ({ ...o, toString: () => o.scheme + '://' + o.authority + o.path }) }
};
const previous = Module._load; Module._load = function(id, ...args) { return id === 'vscode' ? mock : previous.call(this, id, ...args); };
let ReviewTree; try { ({ ReviewTree } = require('../dist/tree')); } finally { Module._load = previous; }
function fixture() {
  const tree = new ReviewTree(), snapshot = { mode: '100644', data: Buffer.from('code') };
  const files = ['src/a.go', 'src/nested/b.go', 'src/nested/c_test.go'].map(path => ({ path, status: 'pending', left: snapshot, right: snapshot, fingerprint: path, commentOnly: false }));
  const view = { files, session: { id: 'session', base: 'a'.repeat(40), label: 'main 的分叉基点' }, notes: { comments: [], replies: new Map() } };
  const render = (dirty = new Set()) => {
    tree.render(view, dirty); const node = tree.nodes.find(node => node.kind === 'folder');
    const item = tree.getTreeItem(node), nested = tree.getTreeItem(node.children.find(child => child.kind === 'folder'));
    return { item, nested, decoration: tree.provideFileDecoration(item.resourceUri) };
  };
  return { tree, files, view, render };
}
test('目录状态：未审→部分已审→全部已审，折叠父目录也反映深层进度', () => {
  const f = fixture(); let v = f.render(); assert.equal(v.item.description, '未审 0/3'); assert.equal(v.item.checkboxState.state, 0);
  f.files[1].status = 'reviewed'; v = f.render();
  assert.equal(v.item.description, '部分已审 1/3'); assert.equal(v.nested.description, '部分已审 1/2');
  assert.equal(v.decoration.badge, '◐'); assert.equal(v.decoration.color.id, 'codeReview.changedForeground');
  f.files.forEach(file => file.status = 'reviewed'); v = f.render();
  assert.equal(v.item.description, '已审完 3/3'); assert.equal(v.item.checkboxState.state, 1);
  assert.equal(v.decoration.badge, '✓'); assert.equal(v.decoration.color.id, 'codeReview.addedForeground');
});
test('目录状态：已审文件变化、未保存或读取失败时，不再显示已审完', () => {
  const f = fixture(); f.files.forEach(file => file.status = 'reviewed');
  let v = f.render(new Set(['src/nested/b.go'])); assert.equal(v.item.description, '部分已审 2/3'); assert.equal(v.item.checkboxState, undefined);
  f.files[1].status = 'changed'; v = f.render(); assert.equal(v.item.description, '部分已审 2/3'); assert.equal(v.item.checkboxState.state, 0);
  f.files[1].error = 'failed'; v = f.render(); assert.equal(v.decoration.badge, '!'); assert.equal(v.item.checkboxState, undefined);
  f.files[1].error = undefined; f.files.forEach(file => file.status = 'pending'); v = f.render(); assert.equal(v.item.description, '未审 0/3');
});

test('目录评论：评论数传播到父目录，不混入文件计数，无 Diff 与仅已删除评论也保留入口', () => {
  const tree = new ReviewTree(), session = { id: 'session', base: 'a'.repeat(40), label: 'main' };
  const directory = { path: 'src/nested', target: 'directory', state: 'open' };
  const view = { session, files: [], notes: { comments: [directory], replies: new Map() } };
  tree.render(view); let parent = tree.nodes.find(n => n.path === 'src'), folder = parent.children[0], item = tree.getTreeItem(folder);
  assert.equal(item.description, '仅评论 · 1 评论'); assert.equal(item.checkboxState, undefined);
  assert.equal(item.command.command, 'codeReview.commentDirectory'); assert.equal(tree.getTreeItem(parent).description, '仅评论 · 1 评论');
  directory.state = 'resolved'; tree.render(view);
  assert.equal(tree.getTreeItem(tree.findTarget('src', 'directory')).description, '仅评论 · 1 已解决评论');
  assert.equal(tree.getTreeItem(tree.findTarget('src/nested', 'directory')).description, '仅评论 · 1 已解决评论');
  view.notes.comments = []; view.notes.deleted = [directory]; tree.render(view);
  folder = tree.nodes.find(n => n.path === 'src').children[0]; assert.equal(folder.kind, 'folder'); assert.equal(tree.getTreeItem(folder).command.command, 'codeReview.commentDirectory');
  assert.equal(tree.getTreeItem(folder).description, '仅评论'); assert.equal(tree.getTreeItem(tree.nodes.find(n => n.path === 'src')).description, '仅评论');
});

function deepTree() {
  const tree = new ReviewTree(), snapshot = { mode: '100644', data: Buffer.from('code') };
  const files = ['src/a/b/c/d/e/f/g/file.ts', 'src/other/test.ts', 'docs/readme.md', 'root.txt'].map(path => ({ path, status: 'pending', left: snapshot, right: snapshot, fingerprint: path }));
  const view = { files, session: { id: 'deep-session', base: 'a'.repeat(40), label: 'main' }, notes: { comments: [{ path: 'old/only-comment', target: 'directory', state: 'open' }], replies: new Map() } };
  const all = () => {
    const result = [], remaining = [...tree.nodes];
    while (remaining.length) { const node = remaining.shift(); result.push(node); remaining.unshift(...(node.children || [])); }
    return result;
  };
  tree.render(view);
  return { tree, view, all };
}

test('展开所有目录超过三层，支持仅评论目录，保留选择、复选框和评论入口', async () => {
  const f = deepTree(), original = f.all(), folders = original.filter(node => node.kind === 'folder');
  const selected = original.find(node => node.path === 'src/other/test.ts'), calls = [], expanded = new Set();
  await f.tree.expandAll({ selection: [selected], reveal: async (node, options) => {
    assert.equal(options.select, false); assert.equal(options.focus, false);
    if (options.expand) {
      assert.equal(options.expand, true);
      expanded.add(node.path);
      for (let parent = f.tree.getParent(node); parent; parent = f.tree.getParent(parent)) expanded.add(parent.path);
    }
    calls.push(node);
  } });
  assert.deepEqual([...expanded].sort(), folders.map(node => node.path).sort());
  assert.ok(expanded.has('src/a/b/c/d/e/f/g'));
  assert.equal(calls.at(-1), selected);
  assert.equal(f.tree.getParent(selected).path, 'src/other');
  assert.equal(f.tree.getParent(original.find(node => node.path === 'root.txt')), undefined);
  const file = f.tree.getTreeItem(selected); assert.equal(file.checkboxState, 0); assert.equal(file.command.command, 'codeReview.open');
  const directory = f.tree.getTreeItem(folders.find(node => node.path === 'old/only-comment'));
  assert.equal(directory.checkboxState, undefined); assert.equal(directory.command.command, 'codeReview.commentDirectory');
});

test('展开期间后台刷新使用当前节点；稳定 ID 让后续手动折叠在普通刷新中保留', async () => {
  const f = deepTree(), before = f.all(), ids = new Map(before.map(node => [node.path, f.tree.getTreeItem(node).id]));
  const state = new Map(), calls = [];
  await f.tree.expandAll({ selection: [], reveal: async (node, options) => {
    assert.ok(f.all().includes(node));
    if (node.kind === 'folder') state.set(f.tree.getTreeItem(node).id, !!options.expand);
    calls.push(node.id);
    f.tree.render(f.view);
  } });
  const collapsed = f.all().find(node => node.path === 'src/a/b/c');
  state.set(f.tree.getTreeItem(collapsed).id, false);
  const count = calls.length; f.tree.render(f.view);
  for (const node of f.all()) assert.equal(f.tree.getTreeItem(node).id, ids.get(node.path));
  assert.equal(state.get(f.tree.getTreeItem(collapsed).id), false); assert.equal(calls.length, count);
  const oldFile = before.find(node => node.path === 'src/other/test.ts');
  assert.equal(f.tree.getParent(oldFile), f.all().find(node => node.path === 'src/other'));
});

test('展开期间切换 CR 立即停止，旧节点不能指向新 CR 的同名目录；空树不触发 reveal', async () => {
  const f = deepTree(), oldFile = f.all().find(node => node.path === 'src/other/test.ts'), calls = [];
  await f.tree.expandAll({ selection: [], reveal: async node => {
    calls.push(node); f.view.session = { ...f.view.session, id: 'another-session' }; f.tree.render(f.view);
  } });
  assert.equal(calls.length, 1); assert.equal(f.tree.getParent(oldFile), undefined);
  f.tree.render({ files: [], notes: { comments: [], replies: new Map() } });
  await f.tree.expandAll({ selection: [], reveal: async () => assert.fail('empty tree') });
});

test('父目录聚合本目录、后代目录、文件与代码行评论，未解决与已解决分开且不改变进度', () => {
  const f = fixture(); f.files[1].status = 'reviewed';
  f.view.notes.comments = [
    { path: 'src', target: 'directory', state: 'open' },
    { path: 'src/nested', target: 'directory', state: 'open' },
    { path: 'src/a.go', state: 'open' },
    { path: 'src/nested/b.go', state: 'open', anchor: { line: 10 } },
    { path: 'src/nested', target: 'directory', state: 'resolved' },
    { path: 'src/nested/c_test.go', state: 'resolved' }
  ];
  f.view.notes.deleted = [{ path: 'src/nested', target: 'directory', state: 'open' }];
  const v = f.render();
  assert.equal(v.item.description, '部分已审 1/3 · 4 评论'); assert.equal(v.nested.description, '部分已审 1/2 · 2 评论');
  assert.match(v.item.tooltip, /未解决评论：4（本目录 1，子项 3）/);
  assert.match(v.item.tooltip, /已解决评论：2（本目录 0，子项 2）/);
  assert.match(v.nested.tooltip, /未解决评论：2（本目录 1，子项 1）/);
  assert.match(v.nested.tooltip, /已解决评论：2（本目录 1，子项 1）/);
  assert.equal(v.item.checkboxState.state, 0); assert.equal(v.decoration.color.id, 'codeReview.changedForeground');
  assert.equal(f.tree.getTreeItem(f.tree.findTarget('src/a.go')).description, '1 评论');
  assert.equal(f.tree.getTreeItem(f.tree.findTarget('src/nested/c_test.go')).description, '测试 · 1 已解决评论');
});

test('深层评论传播到所有祖先，目录路径边界与同名文件互不混淆', () => {
  const f = deepTree(), snapshot = f.view.files[0].left;
  f.view.files.push(...['src/x', 'src/x/file.ts', 'src/xx/file.ts'].map(path => ({ path, status: 'pending', left: snapshot, right: snapshot, fingerprint: path })));
  f.view.notes.comments = [
    { path: 'src/a/b/c/d/e/f/g/file.ts', state: 'open' },
    { path: 'src/x', state: 'open' },
    { path: 'src/x', target: 'directory', state: 'resolved' },
    { path: 'src/x/file.ts', state: 'open' },
    { path: 'src/xx/file.ts', state: 'open' },
    { path: 'src/xx/file.ts', state: 'open' }
  ];
  f.tree.render(f.view);
  for (const path of ['src/a', 'src/a/b', 'src/a/b/c', 'src/a/b/c/d', 'src/a/b/c/d/e', 'src/a/b/c/d/e/f', 'src/a/b/c/d/e/f/g']) {
    assert.equal(f.tree.getTreeItem(f.tree.findTarget(path, 'directory')).description, '未审 0/1 · 1 评论');
  }
  const directory = f.tree.findTarget('src/x', 'directory'), file = f.tree.findTarget('src/x');
  assert.equal(directory.kind, 'folder'); assert.equal(file.kind, 'file'); assert.notEqual(directory, file);
  const item = f.tree.getTreeItem(directory);
  assert.equal(item.description, '未审 0/1 · 1 评论');
  assert.match(item.tooltip, /未解决评论：1（本目录 0，子项 1）/);
  assert.match(item.tooltip, /已解决评论：1（本目录 1，子项 0）/);
  assert.equal(f.tree.getTreeItem(f.tree.findTarget('src/xx', 'directory')).description, '未审 0/1 · 2 评论');
  assert.match(f.tree.getTreeItem(f.tree.findTarget('src', 'directory')).description, / · 5 评论$/);
});

test('解决和删除评论即时重算，换 CR 不残留评论计数；目标查询只返回本次刷新节点', () => {
  const f = fixture(); f.files.forEach(file => file.status = 'reviewed');
  const comment = { path: 'src/nested/b.go', state: 'open' }; f.view.notes.comments = [comment];
  assert.equal(f.render().item.description, '已审完 3/3 · 1 评论');
  const previous = f.tree.findTarget(comment.path); comment.state = 'resolved';
  const resolved = f.render(); assert.equal(resolved.item.description, '已审完 3/3 · 1 已解决评论');
  assert.equal(resolved.item.checkboxState.state, 1); assert.equal(resolved.decoration.color.id, 'codeReview.addedForeground');
  assert.notEqual(f.tree.findTarget(comment.path), previous);
  f.view.notes.comments = []; f.view.notes.deleted = [comment]; assert.equal(f.render().item.description, '已审完 3/3');
  f.view.notes.comments = [comment]; f.view.notes.deleted = []; f.render();
  f.view.session = { ...f.view.session, id: 'another-cr' }; f.view.notes.comments = [];
  assert.equal(f.render().item.description, '已审完 3/3'); assert.equal(f.tree.findTarget(comment.path).session, 'another-cr');
  f.view.files = f.view.files.filter(file => file.path !== comment.path); f.tree.render(f.view);
  assert.equal(f.tree.findTarget(comment.path), undefined);
  f.tree.render({ files: [], notes: { comments: [], replies: new Map() } });
  assert.equal(f.tree.findTarget('src', 'directory'), undefined);
});
