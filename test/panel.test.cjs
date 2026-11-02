const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { randomUUID } = require('node:crypto');
function browser() {
  class Element {
    children = []; textContent = ''; value = ''; hidden = false; disabled = false;
    append(...children) {
      for (const child of children) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
        child.parentNode = this; this.children.push(child);
      }
    }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = undefined; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = undefined; }
    insertBefore(child, reference) { child.remove(); const index = this.children.indexOf(reference); assert.notEqual(index, -1); child.parentNode = this; this.children.splice(index, 0, child); }
    focus() {}
    set innerHTML(_) { throw new Error('用户内容禁止 innerHTML'); }
  }
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  let receive, state; const sent = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/comments.js'), 'utf8'), {
    document: { getElementById: get, createElement: () => new Element() }, crypto: { randomUUID },
    window: { addEventListener: (_type, fn) => { receive = fn; } },
    acquireVsCodeApi: () => ({ getState: () => state, setState: value => { state = value; }, postMessage: value => sent.push(value) })
  });
  const render = (key, cards = [], extra = {}) => receive({ data: { type: 'render', key, draftKey: key, file: key, cards, pending: cards.length, ...extra } });
  const ack = (id, error) => receive({ data: { type: 'ack', requestId: id, error } });
  return { get, sent, render, ack, state: () => state };
}
test('视图：周期刷新不解除保存锁，保存失败保留草稿且重试同一个请求', () => {
  const b = browser(); b.render('a'); b.get('body').value = 'comment'; b.get('body').oninput(); b.get('save').onclick();
  const request = b.sent.at(-1), count = b.sent.length; assert.equal(request.action, 'add');
  b.render('a'); b.get('save').onclick(); assert.equal(b.sent.length, count); assert.equal(b.get('save').disabled, true);
  b.ack(request.requestId, 'disk failed'); assert.equal(b.get('body').value, 'comment'); assert.equal(b.get('save').disabled, false);
  b.get('save').onclick(); assert.equal(b.sent.at(-1).requestId, request.requestId);
  b.ack(request.requestId); assert.equal(b.get('body').value, ''); assert.equal(b.state().drafts.a.body, '');
});
test('视图：跨文件回复不清空其他草稿，编辑草稿保留原评论身份', () => {
  const b = browser(); b.render('a'); b.get('body').value = 'A'; b.get('body').oninput(); b.get('save').onclick(); const id = b.sent.at(-1).requestId;
  b.render('b'); b.get('body').value = 'B'; b.get('body').oninput(); b.ack(id); assert.equal(b.get('body').value, 'B');
  b.render('a', [{ id: 'note', revision: 'rev', body: 'original', status: '待处理', location: '文件评论' }]);
  b.get('cards').children[0].children.at(-1).children[1].onclick(); b.get('body').value = 'edited'; b.get('body').oninput();
  b.render('b'); b.render('a', [{ id: 'note', revision: 'rev', body: 'original', status: '待处理', location: '文件评论' }]); assert.equal(b.get('body').value, 'edited');
  b.get('save').onclick(); assert.equal(b.sent.at(-1).action, 'edit'); assert.equal(b.sent.at(-1).id, 'note'); assert.equal(b.sent.at(-1).revision, 'rev');
});
test('视图：用户评论与 Agent 回复只作为文本渲染', () => {
  const b = browser(); const text = '<img src=x onerror=alert(1)>';
  b.render('a', [{ id: 'n', revision: 'r', body: text, reply: text, quote: text, status: '待处理', location: '文件评论' }]);
  assert.equal(b.get('cards').children[0].children[1].textContent, text);
  b.render('overview', [{ id: 'n', revision: 'r', body: text, targetLabel: text, status: '待处理', location: '文件评论' }], { overview: true });
  assert.equal(b.get('cards').children[0].children[0].textContent, text);
});

test('视图：Agent 回复、未解决和已解决呈现独立状态标签', () => {
  const b = browser();
  b.render('a', [
    { status: '待处理', body: 'open' },
    { status: 'Agent 已回复，待复核', body: 'review' },
    { status: '已解决', resolved: true, body: 'done' }
  ]);
  const cards = b.get('cards').children;
  assert.deepEqual(cards.map(card => card.className), ['comment open', 'comment review', 'comment resolved']);
  assert.deepEqual(cards.map(card => card.children[0].children[0].textContent), ['待处理', 'Agent 已回复，待复核', '已解决']);
});

test('视图：每条评论可单独删除，等待回执防止重复，失败保留编辑草稿并可撤销', () => {
  const b = browser(), card = { id: 'one', revision: 'rev', body: 'original', status: '待处理' };
  b.render('a', [card]); b.get('body').value = 'draft'; b.get('body').oninput();
  const actions = b.get('cards').children[0].children.at(-1).children, remove = actions.find(node => node.textContent === '删除');
  remove.onclick(); const request = b.sent.at(-1), count = b.sent.length;
  assert.equal(request.action, 'delete'); assert.equal(request.id, 'one'); assert.equal(request.revision, 'rev');
  remove.onclick(); assert.equal(b.sent.length, count);
  b.ack(request.requestId, 'failed'); assert.equal(b.get('body').value, 'draft'); assert.equal(remove.disabled, false);
  remove.onclick(); b.ack(b.sent.at(-1).requestId); b.render('a', [], { deleted: [card] });
  assert.equal(b.get('deleted-section').hidden, false); assert.equal(b.get('deleted-section').open, true); assert.equal(b.get('body').value, 'draft');
  b.get('deleted-cards').children[0].children.at(-1).onclick(); assert.equal(b.sent.at(-1).action, 'restore'); assert.equal(b.sent.at(-1).id, 'one');
});


test('视图：旧评论在原卡片内编辑，周期刷新不拆卸输入框，取消恢复新评论草稿', () => {
  const b = browser(), card = { id: 'old', revision: 'version', body: 'old body', status: '待处理' };
  b.render('a', [card]); b.get('body').value = 'new comment draft'; b.get('body').oninput();
  b.get('cards').children[0].children.at(-1).children.find(node => node.textContent === '编辑').onclick();
  const article = b.get('cards').children[0];
  assert.equal(b.get('composer').parentNode, article); assert.match(article.className, /editing/);
  assert.equal(b.get('editing-banner').hidden, false); assert.equal(b.get('save').textContent, '保存修改');
  b.get('body').value = 'edited body'; b.get('body').oninput(); b.get('body').selectionStart = 3;
  b.render('a', [card]); assert.equal(b.get('composer').parentNode, article); assert.equal(b.get('body').selectionStart, 3);
  b.get('cancel').onclick(); assert.equal(b.get('composer').parentNode, b.get('composer-home'));
  assert.equal(b.get('body').value, 'new comment draft'); assert.equal(b.get('save').textContent, '保存评论');
});
test('视图：保存旧评论只发送 edit，原评论消失时不退化成新增', () => {
  const b = browser(), card = { id: 'old', revision: 'version', body: 'old body', status: '待处理' };
  b.render('a', [card]); b.get('cards').children[0].children.at(-1).children.find(node => node.textContent === '编辑').onclick();
  b.get('body').value = 'edited'; b.get('body').oninput(); b.get('save').onclick();
  const request = b.sent.at(-1); assert.equal(request.action, 'edit'); assert.equal(request.id, 'old'); assert.equal(request.revision, 'version');
  b.ack(request.requestId, 'revision changed'); b.render('a', []);
  const count = b.sent.length; b.get('save').onclick(); assert.equal(b.sent.length, count); assert.equal(b.get('save').disabled, true);
  assert.equal(b.get('body').value, 'edited');
});

test('视图：编辑期间删除、恢复与解决其他评论立即更新，编辑输入框保持原位', () => {
  const b = browser(), first = { id: 'first', revision: '1', body: 'first', status: '待处理' }, editing = { id: 'editing', revision: '2', body: 'editing', status: '待处理' }, last = { id: 'last', revision: '3', body: 'last', status: '待处理' };
  b.render('a', [first, editing, last]);
  b.get('cards').children[1].children.at(-1).children.find(node => node.textContent === '编辑').onclick();
  const article = b.get('composer').parentNode;
  b.get('body').value = 'unsaved edit'; b.get('body').oninput(); b.get('body').selectionStart = 4;
  b.get('cards').children[0].children.at(-1).children.find(node => node.textContent === '删除').onclick();
  const deletion = b.sent.at(-1);
  b.render('a', [editing, last], { deleted: [first] }); b.ack(deletion.requestId);
  assert.equal(b.get('cards').children.length, 2); assert.equal(b.get('cards').children[0], article);
  b.render('a', [first, editing, { ...last, resolved: true, status: '已解决' }]);
  assert.equal(b.get('cards').children.length, 3); assert.equal(b.get('cards').children[1], article);
  assert.equal(b.get('cards').children[2].children[0].children[0].textContent, '已解决');
  assert.equal(b.get('composer').parentNode, article); assert.equal(b.get('body').value, 'unsaved edit'); assert.equal(b.get('body').selectionStart, 4);
});

test('视图：目录评论明确范围，隐藏代码选区按钮，文件与目录草稿独立保留', () => {
  const b = browser(); b.render('directory:src', [], { target: 'directory', file: 'src/' });
  assert.match(b.get('anchor').textContent, /目录评论/); assert.match(b.get('body').placeholder, /目录整体/); assert.equal(b.get('selection').hidden, true);
  b.get('body').value = 'directory draft'; b.get('body').oninput();
  b.render('file:src'); assert.equal(b.get('body').value, ''); assert.equal(b.get('selection').hidden, false);
  b.get('body').value = 'file draft'; b.get('body').oninput();
  b.render('directory:src', [], { target: 'directory', file: 'src/' }); assert.equal(b.get('body').value, 'directory draft');
});

test('视图：同路径不同 CR 草稿隔离，旧版草稿只接续一次，其他 CR 不认领旧评论编辑', () => {
  const b = browser(); b.render('old-file'); b.get('body').value = 'old draft'; b.get('body').oninput();
  b.render('cr-one:file', [], { legacyDraftKey: 'old-file', file: 'src/a.txt' }); assert.equal(b.get('body').value, 'old draft');
  b.render('cr-two:file', [], { legacyDraftKey: 'old-file', file: 'src/a.txt' }); assert.equal(b.get('body').value, '');
  b.get('body').value = 'second draft'; b.get('body').oninput();
  b.render('cr-one:file', [], { file: 'src/a.txt' }); assert.equal(b.get('body').value, 'old draft');
  const card = { id: 'old-note', revision: 'r', body: 'original' };
  b.render('old-edit', [card]); b.get('cards').children[0].children.at(-1).children.find(n => n.textContent === '编辑').onclick();
  b.get('body').value = 'unsaved edit'; b.get('body').oninput();
  b.render('wrong-cr', [], { legacyDraftKey: 'old-edit' }); assert.equal(b.get('body').value, '');
  b.render('correct-cr', [card], { legacyDraftKey: 'old-edit' }); assert.equal(b.get('body').value, 'unsaved edit');
});

test('视图：永久删除清理本轮草稿与旧键，不清理其他 CR、归档记录或其他仓库', () => {
  const b = browser(), scope = (reviewId, reviewIds = ['first', 'second', 'archived']) => ({ repositoryKey: 'repo', reviewId, reviewIds });
  b.render('first:file', [], scope('first')); b.get('body').value = 'remove me'; b.get('body').oninput();
  b.render('second:file', [], scope('second')); b.get('body').value = 'keep second'; b.get('body').oninput();
  b.render('archived:file', [], scope('archived')); b.get('body').value = 'keep archived'; b.get('body').oninput();
  b.render('elsewhere:file', [], { repositoryKey: 'elsewhere', reviewId: 'elsewhere', reviewIds: ['elsewhere'] });
  b.get('body').value = 'keep another repo'; b.get('body').oninput();
  b.render('legacy'); b.get('body').value = 'old unsaved content'; b.get('body').oninput();
  b.render('first:file', [], scope('first')); b.get('save').onclick(); const staleRequest = b.sent.at(-1).requestId;
  b.render(undefined, [], { repositoryKey: 'repo', reviewIds: ['second', 'archived'], discardDraftKeys: ['legacy'] });
  assert.equal(b.state().drafts['first:file'], undefined); assert.equal(b.state().drafts.legacy, undefined);
  assert.equal(b.get('body').value, ''); assert.equal(b.get('composer').hidden, true);
  assert.equal(b.state().drafts['second:file'].body, 'keep second'); assert.equal(b.state().drafts['archived:file'].body, 'keep archived');
  assert.equal(b.state().drafts['elsewhere:file'].body, 'keep another repo');
  b.ack(staleRequest); assert.equal(b.state().drafts['first:file'], undefined);
  b.render('new:file', [], { ...scope('new', ['second', 'archived', 'new']), legacyDraftKey: 'legacy' });
  assert.equal(b.get('body').value, '');
});

test('视图：子项评论入口显示状态与纯文本位置，跳转保留目录草稿', () => {
  const b = browser(), label = 'nested/<img src=x onerror=alert(1)>/';
  const targets = [
    { path: 'src/nested', target: 'directory', label, pending: 2, resolved: 1 },
    { path: 'src/a.txt', label: 'a.txt', pending: 0, resolved: 3 }
  ];
  const extra = { target: 'directory', file: 'src/', targets };
  b.render('directory:src', [], extra);
  assert.equal(b.get('targets-section').hidden, false);
  const buttons = b.get('targets').children;
  assert.equal(buttons[0].children[0].textContent, label);
  assert.equal(buttons[0].children[1].textContent, '2 条未解决 · 1 条已解决');
  assert.equal(buttons[1].children[1].textContent, '3 条已解决');
  b.get('body').value = 'directory draft'; b.get('body').oninput(); buttons[0].onclick();
  const request = b.sent.at(-1);
  assert.equal(request.action, 'openTarget'); assert.equal(request.path, 'src/nested'); assert.equal(request.target, 'directory'); assert.equal(request.key, 'directory:src');
  b.render('directory:src/nested', [], { target: 'directory' }); b.ack(request.requestId);
  b.render('directory:src', [], extra); assert.equal(b.get('body').value, 'directory draft');
  b.get('targets').children[1].onclick(); assert.equal(b.sent.at(-1).target, undefined);
  b.render('file:src/a.txt'); assert.equal(b.get('targets-section').hidden, true);
});

test('视图：待处理评论概览可原卡片编辑，隐藏新增，保存失败与跨视图仍保留草稿', () => {
  const b = browser(), card = { id: 'n', revision: 'r', body: 'original', status: '待处理', targetLabel: 'src/nested/a.txt', canLocate: true };
  const overview = { overview: true };
  b.render('overview:one', [card], overview);
  assert.equal(b.get('file').textContent, '待处理评论'); assert.equal(b.get('composer').hidden, true);
  assert.equal(b.get('cards').children[0].children[0].textContent, card.targetLabel);
  const count = b.sent.length; b.get('body').value = 'must not add'; b.get('save').onclick(); assert.equal(b.sent.length, count);
  b.get('cards').children[0].children.at(-1).children.find(n => n.textContent === '编辑').onclick();
  assert.equal(b.get('composer').hidden, false); assert.match(b.get('editing-banner').textContent, /src\/nested\/a.txt/);
  assert.equal(b.get('save').textContent, '保存修改'); assert.equal(b.get('selection').hidden, true);
  const article = b.get('composer').parentNode;
  b.get('body').value = 'edited'; b.get('body').oninput(); b.get('body').selectionStart = 3;
  b.render('overview:one', [card], overview);
  assert.equal(b.get('composer').parentNode, article); assert.equal(b.get('body').selectionStart, 3);
  b.get('save').onclick(); const save = b.sent.at(-1); assert.equal(save.action, 'edit'); assert.equal(save.id, 'n'); assert.equal(save.revision, 'r');
  b.ack(save.requestId, 'disk failed'); assert.equal(b.get('body').value, 'edited');
  b.render('file:a'); b.get('body').value = 'file draft'; b.get('body').oninput();
  b.render('overview:two', [card], overview); assert.equal(b.get('composer').hidden, true);
  b.render('overview:one', [card], overview); assert.equal(b.get('body').value, 'edited'); assert.equal(b.get('composer').hidden, false);
  b.get('save').onclick(); b.ack(b.sent.at(-1).requestId); assert.equal(b.get('composer').hidden, true);
  b.get('cards').children[0].children.at(-1).children.find(n => n.textContent === '编辑').onclick(); b.get('cancel').onclick();
  assert.equal(b.get('composer').hidden, true); assert.equal(b.get('composer').parentNode, b.get('composer-home'));
  b.render('file:a'); assert.equal(b.get('body').value, 'file draft');
});

test('视图：概览可逐条解决、删除和打开位置，更新后移除卡片并保留其他编辑', () => {
  const b = browser(), first = { id: 'a', revision: '1', body: 'one', status: '待处理', targetLabel: 'a.txt', canLocate: true };
  const second = { id: 'b', revision: '2', body: 'two', status: 'Agent 已回复，待复核', targetLabel: 'src/' };
  const overview = { overview: true }, buttons = index => b.get('cards').children[index].children.at(-1).children;
  b.render('overview', [first, second], overview);
  buttons(0).find(n => n.textContent === '定位代码').onclick(); assert.equal(b.sent.at(-1).action, 'locate'); b.ack(b.sent.at(-1).requestId);
  buttons(1).find(n => n.textContent === '打开位置').onclick(); assert.equal(b.sent.at(-1).action, 'openTarget'); assert.equal(b.sent.at(-1).id, 'b'); assert.equal(b.sent.at(-1).path, undefined); b.ack(b.sent.at(-1).requestId);
  buttons(1).find(n => n.textContent === '编辑').onclick(); const article = b.get('composer').parentNode;
  b.get('body').value = 'second draft'; b.get('body').oninput();
  buttons(0).find(n => n.textContent === '标为已解决').onclick(); const resolve = b.sent.at(-1);
  assert.equal(resolve.action, 'resolve'); assert.equal(resolve.id, 'a'); assert.equal(resolve.revision, '1');
  b.render('overview', [second], overview); b.ack(resolve.requestId);
  assert.equal(b.get('cards').children.length, 1); assert.equal(b.get('cards').children[0], article); assert.equal(b.get('body').value, 'second draft');
  b.get('cancel').onclick(); buttons(0).find(n => n.textContent === '删除').onclick(); const deletion = b.sent.at(-1);
  assert.equal(deletion.action, 'delete'); assert.equal(deletion.id, 'b'); assert.equal(deletion.revision, '2');
  b.render('overview', [], overview); b.ack(deletion.requestId);
  assert.equal(b.get('cards').children.length, 0); assert.equal(b.get('empty').textContent, '本轮没有待处理评论。'); assert.equal(b.get('composer').hidden, true);
});

test('视图：概览中正编辑的评论移出清单时保留草稿与取消入口，不能误新增', () => {
  const b = browser(), card = { id: 'a', revision: '1', body: 'body', status: '待处理', targetLabel: 'src/a.txt' };
  b.render('overview', [card], { overview: true });
  b.get('cards').children[0].children.at(-1).children.find(n => n.textContent === '编辑').onclick();
  b.get('body').value = 'unsaved edit'; b.get('body').oninput();
  b.render('overview', [], { overview: true });
  assert.equal(b.get('composer').hidden, false); assert.equal(b.get('body').value, 'unsaved edit'); assert.equal(b.get('save').disabled, true);
  assert.match(b.get('editing-banner').textContent, /src\/a.txt/);
  const count = b.sent.length; b.get('save').onclick(); assert.equal(b.sent.length, count);
  b.get('cancel').onclick(); assert.equal(b.get('composer').hidden, true);
});

test('视图：编辑 A 时禁用 B 的编辑，旧按钮与周期刷新都不能覆盖未保存草稿', () => {
  for (const overview of [true, false]) {
    const b = browser(), first = { id: 'a', revision: '1', body: 'original A', status: '待处理', targetLabel: 'a.txt' };
    const second = { id: 'b', revision: '2', body: 'original B', status: '待处理', targetLabel: 'b.txt' };
    const extra = { overview }, render = () => b.render('same-view', [first, second], extra);
    const button = (index, text) => b.get('cards').children[index].children.at(-1).children.find(n => n.textContent === text);
    render(); const staleEditB = button(1, '编辑'); button(0, '编辑').onclick();
    b.get('body').value = 'unsaved A'; b.get('body').oninput();
    assert.equal(button(1, '编辑').disabled, true); assert.match(button(1, '编辑').title, /先保存或取消/);
    assert.match(b.get('editing-banner').textContent, /先保存或取消/);
    assert.equal(button(1, '标为已解决').disabled, false); assert.equal(button(1, '删除').disabled, false);
    if (overview) assert.equal(button(1, '打开位置').disabled, false);
    button(1, '编辑').onclick(); staleEditB.onclick();
    assert.equal(b.state().drafts['same-view'].edit.id, 'a'); assert.equal(b.get('body').value, 'unsaved A');
    render(); assert.equal(button(1, '编辑').disabled, true); assert.equal(b.get('body').value, 'unsaved A');
    b.render('other-view'); render(); assert.equal(b.get('body').value, 'unsaved A'); assert.equal(button(1, '编辑').disabled, true);
    b.get('save').onclick(); const saved = b.sent.at(-1);
    assert.equal(saved.id, 'a'); assert.equal(saved.body, 'unsaved A'); b.ack(saved.requestId);
    assert.equal(button(1, '编辑').disabled, false); button(1, '编辑').onclick();
    assert.equal(b.state().drafts['same-view'].edit.id, 'b'); assert.equal(b.get('body').value, 'original B');
    b.get('cancel').onclick(); assert.equal(button(0, '编辑').disabled, false);
  }
});

test('评论面板消息契约：子项跳转限制路径类型、长度与目标类型', () => {
  const { CommentPanel } = require('../dist/panel');
  const messages = []; let receive, html;
  const panel = new CommentPanel(path.resolve(__dirname, '..'), value => messages.push(value));
  panel.resolveWebviewView({ show() {}, webview: {
    set options(value) { assert.deepEqual(value.localResourceRoots, []); },
    set html(value) { html = value; },
    onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; }, postMessage: async () => true
  } });
  const base = { action: 'openTarget', key: 'directory', requestId: 'request' };
  for (const extra of [{ path: [] }, { path: 'a'.repeat(1025) }, { target: 'file' }, { target: true }]) receive({ ...base, ...extra });
  assert.equal(messages.length, 0);
  receive({ ...base, path: 'src/nested', target: 'directory' }); receive({ ...base, id: 'comment-id' });
  assert.equal(messages.length, 2); assert.match(html, /待处理评论/); assert.match(html, /targets-section/); assert.match(html, /default-src 'none'/);
  panel.dispose();
});
