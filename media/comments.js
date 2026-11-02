(() => {
  const api = acquireVsCodeApi(), byId = id => document.getElementById(id);
  let saved = api.getState() || { drafts: {} };
  if (!saved.drafts || typeof saved.drafts !== 'object') saved = { drafts: {} };
  let model = { cards: [], pending: 0 }, editHost, cardButtons = [];
  const pending = new Map();
  const persist = () => {
    const current = saved.drafts[model.draftKey];
    if (current && model.repositoryKey && model.reviewId) {
      current.repositoryKey = model.repositoryKey; current.reviewId = model.reviewId;
    }
    api.setState(saved);
  };
  const draft = () => saved.drafts[model.draftKey] || { body: '' };
  function stash() {
    if (!model.draftKey) return;
    saved.drafts[model.draftKey] = { ...draft(), body: byId('body').value }; persist();
  }
  function element(tag, value, className) {
    const node = document.createElement(tag); node.textContent = value || '';
    if (className) node.className = className;
    return node;
  }
  function busy() { return [...pending.values()].some(item => item.draftKey === model.draftKey && item.saving); }
  function controls() {
    const editing = draft().edit, editingCard = editing && model.cards.find(card => card.id === editing.id), missingEdit = editing && !editingCard;
    byId('composer').hidden = !model.key || !!(model.overview && !editing);
    byId('save').disabled = busy() || !!missingEdit || !!(model.overview && !editing);
    byId('body').disabled = busy();
    byId('save').textContent = busy() ? '正在保存…' : editing ? '保存修改' : '保存评论';
    byId('cancel').hidden = !editing; byId('cancel').disabled = busy();
    byId('editing-banner').hidden = !editing;
    const editingLabel = editingCard?.targetLabel || draft().editLabel;
    byId('editing-banner').textContent = (missingEdit ? '原评论已不在当前列表，草稿仍保留。可取消编辑后打开原位置查看。' : '正在编辑这条评论') + (editingLabel ? ' · ' + editingLabel : '') + (editing ? '；先保存或取消，再编辑其他评论。' : '');
    byId('selection').hidden = !!editing || model.overview || model.target === 'directory'; byId('selection').disabled = busy();
    byId('anchor').hidden = !!editing;
    byId('quote').hidden = !!editing || !model.quote;
    byId('clear').hidden = !!editing || model.overview || !model.anchor; byId('clear').disabled = busy();
    for (const { node, id, kind } of cardButtons) {
      const blockedEdit = !!editing && kind === 'edit';
      node.disabled = busy() || blockedEdit || [...pending.values()].some(request => request.id === id);
      node.title = blockedEdit ? '请先保存或取消当前编辑' : '';
    }
  }
  function send(action, extra = {}, saving = false) {
    const data = draft();
    const requestId = saving && action === 'add' ? (data.requestId || crypto.randomUUID()) : crypto.randomUUID();
    if (saving && action === 'add') { saved.drafts[model.draftKey] = { ...data, requestId }; persist(); }
    pending.set(requestId, { draftKey: model.draftKey, body: byId('body').value, saving, action, id: extra.id });
    api.postMessage({ action, requestId, key: model.key, ...extra }); controls();
  }
  function render(next) {
    stash(); const previousDraft = model.draftKey; model = next;
    const discarded = new Set(model.discardDraftKeys || []), available = model.reviewIds && new Set(model.reviewIds);
    for (const [key, value] of Object.entries(saved.drafts)) {
      if (discarded.has(key) || (available && value && value.repositoryKey === model.repositoryKey && value.reviewId && !available.has(value.reviewId))) {
        delete saved.drafts[key]; discarded.add(key);
      }
    }
    for (const [id, request] of pending) if (discarded.has(request.draftKey)) pending.delete(id);
    if (discarded.has(previousDraft)) byId('body').value = '';
    const legacy = saved.drafts[model.legacyDraftKey];
    if (model.draftKey && !saved.drafts[model.draftKey] && legacy && (!legacy.edit || model.cards.some(card => card.id === legacy.edit.id))) {
      saved.drafts[model.draftKey] = legacy; delete saved.drafts[model.legacyDraftKey];
    }
    persist();
    if (previousDraft !== model.draftKey) byId('body').value = draft().body || '';
    byId('file').textContent = model.overview ? '待处理评论' : model.file || '先选择文件或目录';
    byId('summary').textContent = '本轮 CR 内 ' + model.pending + ' 条未解决评论';
    byId('error').textContent = model.error || '';
    byId('anchor').textContent = model.anchor || (model.target === 'directory' ? '目录评论 · 针对这个目录及其子目录的整体意见' : '文件评论');
    byId('body').placeholder = model.target === 'directory' ? '写下这个目录整体需要调整的地方…' : '写下这个文件需要调整的地方…';
    byId('quote').textContent = model.quote || '';
    byId('empty').textContent = model.key && !model.cards.length ? (model.overview ? '本轮没有待处理评论。' : model.target === 'directory' ? '本目录还没有直接评论。' : '这个文件还没有评论。') : '';
    const targets = model.overview ? [] : model.targets || [];
    byId('targets-section').hidden = !targets.length;
    byId('targets').replaceChildren();
    for (const target of targets) {
      const button = element('button', '', 'target-link');
      const counts = [target.pending ? target.pending + ' 条未解决' : '', target.resolved ? target.resolved + ' 条已解决' : ''].filter(Boolean).join(' · ');
      button.append(element('span', target.label, 'target-path'), element('span', counts, 'muted'));
      button.onclick = () => { stash(); send('openTarget', { path: target.path, ...(target.target ? { target: target.target } : {}) }); };
      byId('targets').append(button);
    }
    const editing = draft().edit;
    // Keep the active editor node mounted while periodic updates arrive: no focus/caret loss.
    const keepEditor = editing && editHost?.id === editing.id && editHost.draftKey === model.draftKey && model.cards.some(card => card.id === editing.id);
    if (!keepEditor) {
      byId('composer-home').append(byId('composer'));
      byId('cards').replaceChildren(); editHost = undefined;
    } else {
      // Refresh siblings independently so deleting or resolving another comment is visible.
      for (const article of [...byId('cards').children]) if (article !== editHost.article) article.remove();
    }
    cardButtons = [];
    const editingIndex = model.cards.findIndex(card => card.id === editing?.id);
    for (const [index, card] of model.cards.entries()) {
      if (keepEditor && card.id === editing.id) continue;
      const article = document.createElement('article');
      const state = card.resolved ? 'resolved' : card.status === 'Agent 已回复，待复核' ? 'review' : 'open';
      const isEditing = !!editing && editing.id === card.id;
      article.className = 'comment ' + state + (isEditing ? ' editing' : '');
      if (card.targetLabel) article.append(element('div', card.targetLabel, 'comment-target'));
      const heading = element('div', '', 'card-heading');
      heading.append(element('span', card.status, 'status ' + state), element('span', card.location, 'muted')); article.append(heading);
      if (isEditing) {
        article.append(byId('composer')); editHost = { id: card.id, draftKey: model.draftKey, article };
      } else article.append(element('div', card.body, 'body'));
      if (card.quote) article.append(element('pre', card.quote));
      if (card.reply) article.append(element('div', 'Agent 处理说明', 'muted'), element('div', card.reply, 'body'));
      if (!isEditing) {
        const actions = document.createElement('div'); actions.className = 'actions';
        function button(label, onClick, className, kind) {
          const node = element('button', label, className);
          node.onclick = () => { if (!node.disabled) onClick(); };
          cardButtons.push({ node, id: card.id, kind }); actions.append(node);
        }
        button(card.resolved ? '重新打开' : '标为已解决', () => send(card.resolved ? 'reopen' : 'resolve', { id: card.id, revision: card.revision }));
        button('编辑', () => {
          if (busy() || draft().edit) return;
          stash(); const previous = draft();
          saved.drafts[model.draftKey] = { body: card.body, edit: { id: card.id, revision: card.revision }, editLabel: card.targetLabel, beforeEdit: previous.edit ? previous.beforeEdit : previous };
          persist(); byId('body').value = card.body; render(model); byId('body').focus();
        }, undefined, 'edit');
        if (card.canLocate) button('定位代码', () => send('locate', { id: card.id }));
        if (model.overview) button('打开位置', () => { stash(); send('openTarget', { id: card.id }); });
        button('删除', () => send('delete', { id: card.id, revision: card.revision }), 'danger');
        article.append(actions);
      }
      if (keepEditor && index < editingIndex) byId('cards').insertBefore(article, editHost.article);
      else byId('cards').append(article);
    }
    byId('deleted-cards').replaceChildren(); const deleted = model.deleted || [];
    byId('deleted-section').hidden = !deleted.length;
    byId('deleted-summary').textContent = '已删除（' + deleted.length + '）';
    for (const card of deleted) {
      const article = element('article', '', 'deleted'), restore = element('button', '撤销删除');
      restore.onclick = () => { if (!restore.disabled) send('restore', { id: card.id, revision: card.revision }); };
      cardButtons.push({ node: restore, id: card.id, deleted: true });
      article.append(element('div', card.body, 'body'), restore); byId('deleted-cards').append(article);
    }
    controls();
  }
  byId('body').oninput = () => { const data = draft(); if (data.requestId) delete data.requestId; stash(); };
  byId('save').onclick = () => {
    if (!model.key || busy() || byId('save').disabled) return;
    const body = byId('body').value.trim(); if (!body) return;
    stash(); const edit = draft().edit; send(edit ? 'edit' : 'add', { body, ...(edit || {}) }, true);
  };
  byId('cancel').onclick = () => {
    if (busy()) return;
    saved.drafts[model.draftKey] = draft().beforeEdit || { body: '' };
    persist(); byId('body').value = draft().body; render(model);
  };
  byId('selection').onclick = () => send('selection'); byId('clear').onclick = () => send('clear');
  byId('handoff').onclick = () => send('handoff'); byId('pending').onclick = () => send('pending');
  window.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'render') render(data);
    if (data.type === 'ack') {
      const request = pending.get(data.requestId); if (!request) return;
      pending.delete(data.requestId);
      if (!data.error && request.action === 'delete' && request.draftKey === model.draftKey) byId('deleted-section').open = true;
      if (!data.error && request.saving) {
        const stored = saved.drafts[request.draftKey];
        if (stored && stored.body === request.body) {
          saved.drafts[request.draftKey] = request.action === 'edit' ? stored.beforeEdit || { body: '' } : { body: '' }; persist();
          if (model.draftKey === request.draftKey) { byId('body').value = draft().body; render(model); }
        }
      }
      if (data.error && request.draftKey === model.draftKey) byId('error').textContent = data.error;
      controls();
    }
  });
  api.postMessage({ action: 'ready' });
})();
