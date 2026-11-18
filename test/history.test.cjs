const { test } = require('node:test'), assert = require('node:assert/strict');
const Module = require('node:module');

const disposable = () => ({ dispose() {} });
const mock = {
  EventEmitter: class { event = disposable; fire() {} dispose() {} },
  ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }
};
function load() {
  delete require.cache[require.resolve('../dist/history')];
  const previous = Module._load;
  Module._load = function (id, ...args) { return id === 'vscode' ? mock : previous.call(this, id, ...args); };
  try { return require('../dist/history'); } finally { Module._load = previous; }
}
const branch = name => ({ key: 'refs/heads/' + name, label: name });
const session = (char, name, extra = {}) => ({ id: char.repeat(64), base: 'b'.repeat(40), label: '合成基点 ' + char, branch: branch(name), createdAt: '2026-11-0' + (extra.day || 1), ...extra });
const notes = { comments: [], replies: new Map() };

test('单仓库保持平铺列表，节点 ID 不变但记录所属仓库', () => {
  const { ReviewHistory } = load(), history = new ReviewHistory();
  const current = session('a', 'feature'), archived = session('b', 'feature', { deletedAt: '2026-11-03' });
  history.render({ session: current, branch: branch('feature'), sessions: [archived, current], files: [], notes }, '/work/api', []);
  assert.deepEqual(history.nodes.map(node => node.id), [current.id, 'deleted']);
  assert.equal(history.nodes[0].root, '/work/api');
  assert.equal(history.nodes[1].children[0].root, '/work/api');
  assert.equal(history.getTreeItem(history.nodes[0]).contextValue, 'savedReview');
  assert.equal(history.getTreeItem(history.getChildren()[0]).description, undefined);
  assert.match(history.getTreeItem(history.nodes[0]).description, /^当前 · /);
});

test('多仓库按仓库分组，同时列出其他仓库的未归档 CR，状态与重名可辨认', () => {
  const { ReviewHistory } = load(), history = new ReviewHistory();
  const current = session('a', 'feature'), archived = session('b', 'feature', { deletedAt: '2026-11-03' });
  const rpcActive = session('c', 'feature', { day: 1 }), rpcElsewhere = session('d', 'hotfix', { day: 5 }), rpcArchived = session('e', 'feature', { deletedAt: '2026-11-04' });
  history.render({ session: current, branch: branch('feature'), sessions: [current, archived], files: [], notes }, '/work/api', [
    { root: '/work/rpc', branch: branch('feature'), active: rpcActive.id, sessions: [rpcElsewhere, rpcActive, rpcArchived] },
    { root: '/backup/api', sessions: [], loading: true },
    { root: '/work/docs', sessions: [], error: '合成读取错误' }
  ]);
  assert.deepEqual(history.nodes.map(node => node.repository.root), ['/backup/api', '/work/api', '/work/docs', '/work/rpc']);
  const item = root => history.getTreeItem(history.nodes.find(node => node.repository.root === root));
  assert.equal(item('/work/api').contextValue, 'currentReviewRepository'); assert.equal(item('/work/api').collapsibleState, 2);
  assert.equal(item('/work/api').description, '当前仓库 · feature · work');
  assert.equal(item('/backup/api').description, '读取中… · backup'); assert.equal(item('/backup/api').collapsibleState, 0);
  assert.equal(item('/work/docs').description, '读取失败'); assert.match(item('/work/docs').tooltip, /合成读取错误/);
  assert.equal(item('/work/rpc').contextValue, 'reviewRepository'); assert.equal(item('/work/rpc').description, 'feature');
  const own = history.nodes.find(node => node.repository.root === '/work/api').children;
  assert.deepEqual(own.map(node => node.review?.id || node.id), [current.id, 'deleted']);
  assert.ok(own.every(node => node.id !== current.id), 'grouped IDs are scoped by repository');
  assert.equal(history.getTreeItem(own[0]).contextValue, 'savedReview'); assert.equal(own[0].root, '/work/api');
  const rpc = history.nodes.find(node => node.repository.root === '/work/rpc').children;
  assert.deepEqual(rpc.map(node => node.review.id), [rpcActive.id, rpcElsewhere.id], 'branch-active first, archived hidden');
  const elsewhere = history.getTreeItem(rpc[1]);
  assert.equal(elsewhere.contextValue, 'otherRepositoryReview'); assert.equal(elsewhere.command.arguments[0].root, '/work/rpc');
  assert.doesNotMatch(elsewhere.description, /当前/); assert.match(elsewhere.tooltip, /当前在 feature，需先切换到 hotfix/);
  assert.doesNotMatch(history.getTreeItem(rpc[0]).tooltip, /需先切换/);
  const legacy = { ...session('9', 'feature'), branch: { key: 'legacy:' + '9'.repeat(64), label: '旧版未分配' } };
  history.render({ session: current, branch: branch('feature'), sessions: [current], files: [], notes }, '/work/api', [
    { root: '/work/rpc', branch: branch('hotfix'), sessions: [legacy] }]);
  const legacyItem = history.getTreeItem(history.nodes.find(node => node.repository.root === '/work/rpc').children[0]);
  assert.match(legacyItem.tooltip, /打开后归入该仓库当前分支 hotfix/); assert.doesNotMatch(legacyItem.tooltip, /需先切换/);
  history.render({ files: [], notes }, '/work/api', [{ root: '/work/rpc', branch: branch('hotfix'), sessions: [] }]);
  assert.match(history.getTreeItem(history.nodes.find(node => node.repository.root === '/work/api')).description, /^当前仓库 · 读取中…/,
    'a repository whose first read has not finished is not shown as empty');
  assert.equal(history.getTreeItem(history.getChildren()[0]).description, 'api');
  const ids = history.nodes.flatMap(node => [node.id, ...node.children.flatMap(child => [child.id, ...(child.children || []).map(leaf => leaf.id)])]);
  assert.equal(new Set(ids).size, ids.length);
});

test('其他仓库与当前仓库的 CR 同 ID 时节点仍唯一，空仓库不可展开', () => {
  const { ReviewHistory } = load(), history = new ReviewHistory();
  const shared = session('f', 'feature');
  history.render({ session: shared, branch: branch('feature'), sessions: [shared], files: [], notes }, '/work/one', [
    { root: '/work/two', branch: branch('feature'), active: shared.id, sessions: [shared] },
    { root: '/work/three', branch: branch('main'), sessions: [] }
  ]);
  const ids = history.nodes.flatMap(node => [node.id, ...node.children.map(child => child.id)]);
  assert.equal(new Set(ids).size, ids.length);
  const empty = history.getTreeItem(history.nodes.find(node => node.repository.root === '/work/three'));
  assert.equal(empty.collapsibleState, 0); assert.equal(empty.description, 'main · 暂无审阅');
  const two = history.nodes.find(node => node.repository.root === '/work/two').children[0];
  assert.doesNotMatch(history.getTreeItem(two).description, /当前/, 'only the record shown in the file tree is marked current');
});
