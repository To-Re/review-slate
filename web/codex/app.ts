import type { Anchor, BaseOptions, Comment, Draft, Handoff, Language, Review, Target, WorkspaceView } from '../../src/codex/contract';
import { Bridge } from './bridge';
import { DiffEditor } from './diff';
import { commentPayload, defaultBaseSelection, diffRenderKey, fileIconKind, fileRowTone, FolderPickerSession, repositoryFailureMessage, ReviewTree, targetKey, type TreeNode } from './model';
import { icon, type IconName } from './icons';
import { copyText } from './clipboard';
import { newId, RequestFailure, Store } from './store';
import brandImage from '../../plugins/codex/assets/reviewslate.svg';

const store = new Store(new Bridge(window));
const app = document.querySelector<HTMLElement>('#app')!;
const text = (zh: string, en: string) => store.locale === 'zh-CN' ? zh : en;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (value !== undefined) node.textContent = value; return node;
}
function tr<K extends keyof HTMLElementTagNameMap>(tag: K, zh: string, en: string, className = ''): HTMLElementTagNameMap[K] {
  const node = el(tag, className, text(zh, en)); node.dataset.zh = zh; node.dataset.en = en; return node;
}
function button(zh: string, en: string, action: () => unknown, className = ''): HTMLButtonElement {
  const node = tr('button', zh, en, className); node.type = 'button';
  node.addEventListener('click', () => { void run(action); }); return node;
}
function iconButton(name: IconName, zh: string, en: string, action: () => unknown, className = ''): HTMLButtonElement {
  const node = el('button', `icon-button ${className}`); node.type = 'button';
  node.append(icon(name), tr('span', zh, en)); node.addEventListener('click', () => { void run(action); }); return node;
}
async function run(action: () => unknown): Promise<void> {
  try { await action(); } catch (error) { if (!store.error) store.fail(error); renderStatus(); }
}
function labelled(zh: string, en: string, control: HTMLElement): HTMLLabelElement {
  const label = el('label'); label.append(tr('span', zh, en), control); return label;
}
const top = el('header', 'topbar'), identity = el('div', 'identity'), errorBar = el('div', 'global-error'), workspace = el('main', 'workspace');
const treePane = el('nav', 'tree-pane'), treeHead = el('div', 'pane-head'), treeBody = el('div', 'tree-body'), treeFoot = el('div', 'tree-footer');
treePane.setAttribute('aria-label', 'Review files / 审阅文件'); treePane.append(treeHead, treeBody, treeFoot);
const mainPane = el('section', 'main-pane'), mainHead = el('div', 'main-head'), sources = el('div', 'diff-sources'), diffBody = el('div', 'diff-body');
mainPane.append(mainHead, sources, diffBody);
const commentsPane = el('aside', 'comments-pane'), commentsHead = el('div', 'pane-head'), commentList = el('div', 'pane-body comment-list'), composer = el('div', 'composer');
commentList.tabIndex = -1; commentsPane.append(commentsHead, commentList, composer);
const status = el('footer', 'statusbar'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
errorBar.setAttribute('role', 'alert'); workspace.append(treePane, mainPane, commentsPane); app.append(top, identity, errorBar, workspace, status);
let editor: DiffEditor | undefined, editorKey = '', selection: Anchor | undefined, composing = false, deferredRender = false;
let selectionError = '', notice: [string, string] | undefined, activeDialog: HTMLDialogElement | undefined;
let disposeDialog: (() => void) | undefined;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
let updateDialog: (() => void) | undefined;
let unfinishedOnly = false;
const panelTriggers = new Map<HTMLElement, HTMLElement>();
const inputs = new Map<string, HTMLTextAreaElement>();
let focusActivity = 0;
const movedFocus = (): void => { focusActivity++; };
// Native controls can lose focus immediately when a save disables them. Distinguish that
// involuntary blur from a subsequent user action, including leaving this embedded view.
for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove']) document.addEventListener(event, movedFocus, { capture: true, passive: true });
document.addEventListener('focusin', event => { if (event.target !== document.body && event.target !== document.documentElement) movedFocus(); });
document.addEventListener('visibilitychange', movedFocus);
window.addEventListener('blur', movedFocus);
const emptyFiles: WorkspaceView['files'] = [], emptyComments: Comment[] = [];
let treeModel: ReviewTree | undefined;
function reviewTree(): ReviewTree {
  const files = store.workspace?.files || emptyFiles, comments = store.workspace?.comments || emptyComments;
  if (!treeModel || treeModel.files !== files || treeModel.comments !== comments) treeModel = new ReviewTree(files, comments);
  return treeModel;
}
const toast = (zh: string, en: string): void => { notice = [zh, en]; renderStatus(); };
document.addEventListener('compositionstart', () => { clearTimeout(compositionTimer); composing = true; store.setComposing(true); });
document.addEventListener('compositionend', () => {
  // Let the browser deliver its final input event before persisting or moving the textarea.
  compositionTimer = setTimeout(() => { composing = false; store.setComposing(false); if (deferredRender) { deferredRender = false; render(); } }, 0);
});

const errors: Record<string, [string, string]> = {
  INVALID_REQUEST: ['请求无法处理，请检查输入。', 'This request could not be processed. Check the input.'],
  ACCESS_DENIED: ['无法访问此仓库或保存位置。请在宿主授权范围内检查权限；输入已保留。', 'Repository or storage access was denied. Check host permissions; input is retained.'],
  REPOSITORY_UNAVAILABLE: ['仓库当前不可读。已保留上次结果和输入。', 'The repository is unavailable. Previous results and input are retained.'],
  STALE_CONTEXT: ['分支或审阅记录已改变。当前输入仍属于原记录，请重新连接核对。', 'The branch or review changed. Input still belongs to the original review; reconnect to verify.'],
  CONTENT_CHANGED: ['内容已变化，请刷新并重新核对选区或已审范围。输入已保留。', 'Content changed. Refresh and verify the selection or review scope. Input is retained.'],
  REVISION_CONFLICT: ['另一窗口已更新此记录。输入已保留，请重新连接核对。', 'Another window updated this record. Input is retained; reconnect to verify.'],
  LOCK_BUSY: ['本地保存正在被另一操作使用。请稍后重试。', 'Another operation is using local storage. Retry when it finishes.'],
  STORE_CORRUPT: ['保存资料无法校验。原数据和输入已保留，请检查本地存储。', 'Stored data could not be validated. Original data and input are retained; inspect local storage.'],
  UNSUPPORTED_VERSION: ['保存资料版本不受支持。请使用兼容版本。', 'The stored format is unsupported. Use a compatible version.'],
  IO_FAILED: ['本地读写失败。输入已保留，请修复后重试。', 'Local I/O failed. Input is retained; retry after fixing the issue.'],
  UNSUPPORTED_CONTENT: ['此内容不支持文本选区；可以添加文件意见。', 'Text selection is unavailable for this content. File comments remain available.'],
  UNKNOWN_RESULT: ['结果待确认，请勿重复提交。重新连接后会先查询原操作。', 'The result is unconfirmed. Do not resubmit. Reconnect to inspect the original operation first.'],
  NOT_INITIALIZED: ['请先选择仓库并新建审阅。', 'Choose a repository and create a review first.'],
};
function renderStatus(): void {
  errorBar.replaceChildren();
  if (store.error) {
    const pair = errors[store.error.code] || errors.UNKNOWN_RESULT;
    errorBar.className = 'global-error notice error';
    const recoveryText = store.unknownState === 'pending' ? text('原操作已开始，结果尚未确认。输入保留；核对后仅可使用原操作 ID 继续验证。', 'The original operation began, but its result is unconfirmed. Input is retained; verify it before continuing with the original operation ID.') : text('已确认原操作未开始保存。输入保留，可明确重试；草稿会保留到新视图。', 'The original operation did not begin saving. Input is retained; you can explicitly retry. Drafts will be retained in the new view.');
    errorBar.append(el('span', 'grow', store.retryableUnknown ? recoveryText : text(...pair)), button('重新连接并核对', 'Reconnect and verify', () => store.reconnect()));
    if (store.error.code === 'STALE_CONTEXT' && !store.unknown && store.workspace?.context) {
      errorBar.append(button('保留原 CR 草稿并打开当前分支', 'Retain original review drafts and open current branch', async () => {
        if (await store.retainAndRefresh()) toast('原 CR 草稿已保留，已打开当前分支。', 'Original review drafts retained; current branch opened.');
      }));
    }
    if (store.drafts.length) errorBar.append(button('导出当前草稿…', 'Export current drafts…', exportDraftsDialog));
    if (store.retryableUnknown) errorBar.append(button('核对并继续…', 'Verify and continue…', retryDialog));
    if (store.error.outcome === 'partial') errorBar.append(tr('span', '部分数据已落盘；确认结果前保留输入。', 'Some data was committed; input is retained until the result is verified.'));
  }
  status.replaceChildren();
  const saved = {
    saved: ['导航与草稿已在本地保留', 'Navigation and drafts retained locally'],
    dirty: ['草稿未提交 · 尚未保留，请勿关闭', 'Draft not submitted · Not retained yet; keep this view open'],
    saving: ['正在本地保留…', 'Retaining locally…'],
    failed: ['本地保留失败 · 输入仍在，请勿关闭', 'Local retention failed · Input is still here; keep this view open'],
  }[store.saveState];
  status.append(el('span', store.saveState === 'failed' || store.saveState === 'dirty' ? 'warning' : 'muted', store.workspace?.active?.deletedAt ? text('归档资料只读 · 本次导航仅保留在页面内', 'Archived data is read-only · Navigation is retained only in this view') : store.workspace?.active ? text(saved[0], saved[1]) : text('本地人工审阅', 'Local human review')));
  if (store.saveState === 'failed' && !store.unknown) status.append(button('重试保留', 'Retry retention', () => store.flush()));
  if (notice) status.append(el('span', '', text(...notice)));
  if (store.recoveredHandoff) status.append(button('查看已确认的交接说明', 'View confirmed handoff', recoveredHandoffDialog));
}
function renderTop(): void {
  const view = store.workspace;
  const brand = el('div', 'brand'), mark = el('img', 'brand-mark'); mark.src = brandImage; mark.alt = ''; mark.width = 32; mark.height = 32;
  brand.append(mark, el('h1', '', 'ReviewSlate'));
  const repository = el('button', 'project-switch'); repository.type = 'button'; repository.dataset.focus = 'project-switch';
  const projectName = view?.workspace.name || text('打开仓库', 'Open repository');
  const projectLabel = el('span', 'project-label'); projectLabel.append(tr('span', '当前项目', 'Current project', 'project-caption'), el('strong', '', projectName));
  repository.append(icon('repository'), projectLabel, tr('span', '切换', 'Switch', 'project-action'), icon('chevron', 'down'));
  repository.setAttribute('aria-label', text(`切换项目，当前 ${projectName}`, `Switch project, current ${projectName}`));
  repository.title = view?.workspace.root || text('打开本地 Git 仓库', 'Open a local Git repository');
  repository.addEventListener('click', repositoryDialog);
  function reviewActions(): HTMLElement {
    const actions = el('div', 'review-actions');
    const history = iconButton('history', '审阅记录', 'Reviews', historyDialog); history.disabled = !view;
    const create = iconButton('plus', '新建审阅', 'New review', () => baseDialog(false), view?.active ? 'secondary' : 'primary'); create.disabled = !view || store.busy || !!store.unknown;
    const handoff = iconButton('agent', '交给 Agent', 'Hand off to Agent', handoffDialog, 'tinted'); handoff.disabled = !store.writable;
    actions.append(history, create, handoff); return actions;
  }
  const actions = reviewActions(); actions.classList.add('wide-actions');
  const compact = el('details', 'compact-actions'); compact.append(tr('summary', '审阅操作', 'Review actions'), reviewActions());
  const settings = iconButton('settings', '设置', 'Settings', () => settingsDialog(), 'settings-button'); settings.dataset.focus = 'settings-button';
  top.replaceChildren(brand, repository, el('span', 'grow top-spacer'), actions, compact, settings);
  identity.replaceChildren();
  if (!view) { identity.append(tr('span', '选择本地 Git 仓库开始；无需新增账号或服务。', 'Choose a local Git repository to begin. No additional account or service is required.', 'muted')); return; }
  const branch = el('span', 'identity-item'); branch.append(icon('branch'), tr('span', '分支', 'Branch', 'muted'), el('span', 'path', view.branch.label)); identity.append(branch);
  if (view.active) {
    identity.append(el('span', 'badge', 'CR ' + view.active.id.slice(0, 8)));
    const base = el('span', 'identity-item base-identity'); base.append(tr('span', '固定基点', 'Fixed base', 'muted'), el('span', 'path', view.active.label));
    const details = button(view.active.base.slice(0, 10), view.active.base.slice(0, 10), baseDetails, 'quiet path base-sha'); details.title = view.active.base; details.dataset.focus = 'base-details';
    const copy = iconButton('copy', '复制完整 SHA', 'Copy full SHA', () => copyBase(view.active!.base), 'icon-only quiet'); copy.title = text('复制完整 SHA', 'Copy full SHA');
    copy.dataset.focus = 'copy-base'; base.append(details, copy); identity.append(base);
    if (view.active.deletedAt) identity.append(tr('span', '已归档 · 只读', 'Archived · Read only', 'badge'));
    if (store.stale) identity.append(tr('span', '上次结果 · 需要核对', 'Previous results · Verification required', 'warning'));
    const sum = reviewTree().total, progress = el('div', 'review-progress');
    const bar = el('progress'); bar.max = Math.max(1, sum.total); bar.value = sum.reviewed; bar.setAttribute('aria-label', text('已审进度', 'Review progress'));
    progress.append(el('span', '', text(`已审 ${sum.reviewed}/${sum.total}`, `Reviewed ${sum.reviewed}/${sum.total}`)), bar);
    identity.append(el('span', 'grow'), progress, el('span', `small ${store.saveState === 'failed' || store.saveState === 'dirty' ? 'warning' : 'muted'}`, text(...({ saved: ['本地已保留', 'Retained locally'], dirty: ['尚未保留', 'Not retained yet'], saving: ['正在保留…', 'Retaining…'], failed: ['保留失败', 'Retention failed'] }[store.saveState] as [string, string]))));
  } else identity.append(tr('span', '尚未选择固定基点', 'No fixed base selected', 'muted'));
  if (store.busy || store.refreshing) identity.append(tr('span', '正在更新…', 'Updating…', 'muted'));
}
function panelToggle(pane: HTMLElement, trigger: HTMLElement): void {
  const open = !pane.classList.contains('open'); pane.classList.toggle('open', open);
  if (open) { panelTriggers.set(pane, trigger); const first = pane.querySelector<HTMLElement>('button,input,textarea'); first?.focus(); }
  else trigger.focus();
}
function closePanel(pane: HTMLElement): void {
  const wasOpen = pane.classList.contains('open'); pane.classList.remove('open'); if (!wasOpen) return;
  const previous = panelTriggers.get(pane);
  const trigger = previous?.isConnected ? previous : [...document.querySelectorAll<HTMLElement>('[data-focus]')].find(item => previous?.dataset.focus && item.dataset.focus === previous.dataset.focus);
  trigger?.focus();
}
const treeFilter = el('input'); treeFilter.maxLength = 1000; treeFilter.dataset.focus = 'tree-filter';
treeFilter.addEventListener('input', () => {
  store.navigation.filter = treeFilter.value;
  if (treeFilter.value) store.navigation.expanded = reviewTree().directories;
  store.touch(); renderTreeRows();
});
function renderTree(): void {
  if (treeFilter.value !== store.navigation.filter) treeFilter.value = store.navigation.filter;
  treeFilter.placeholder = text('筛选路径', 'Filter paths'); treeFilter.setAttribute('aria-label', treeFilter.placeholder);
  const sum = reviewTree().total;
  const title = el('div', 'row tree-heading'); title.append(tr('h2', '变更文件', 'Changed files'), el('span', 'badge', String(sum.total)));
  const tools = el('div', 'tree-tools');
  const directories = reviewTree().directories;
  for (const expand of [true, false]) {
    const control = iconButton(expand ? 'expand-all' : 'collapse-all', expand ? '全部展开' : '全部收起', expand ? 'Expand all' : 'Collapse all', () => {
      store.navigation.expanded = expand ? directories : []; store.touch(); renderTreeRows();
    }, 'icon-only quiet');
    control.title = text(expand ? '全部展开' : '全部收起', expand ? 'Expand all' : 'Collapse all');
    control.dataset.focus = expand ? 'expand-all' : 'collapse-all'; control.disabled = !directories.length;
    tools.append(control);
  }
  const refresh = iconButton('refresh', '刷新已保存的工作区', 'Refresh saved workspace', () => store.refresh(), 'icon-only quiet');
  refresh.title = text('刷新已保存的工作区', 'Refresh saved workspace'); refresh.disabled = !store.workspace || store.busy || store.refreshing || !!store.unknown;
  tools.append(refresh, button('关闭', 'Close', () => closePanel(treePane), 'panel-toggle tree-toggle-button')); title.append(tools);
  const filters = el('div', 'tree-filters');
  for (const incomplete of [false, true]) { const tab = button(incomplete ? '未完成' : '全部', incomplete ? 'Unfinished' : 'All', () => { unfinishedOnly = incomplete; renderTree(); }, 'tab'); tab.setAttribute('aria-pressed', String(unfinishedOnly === incomplete)); filters.append(tab); }
  if (!treeHead.contains(treeFilter)) treeHead.replaceChildren(title, treeFilter, filters);
  else { treeHead.firstElementChild?.replaceWith(title); treeHead.lastElementChild?.replaceWith(filters); }
  treeFoot.textContent = text(`已审 ${sum.reviewed} / ${sum.total} · 需复审 ${sum.changed}`, `Reviewed ${sum.reviewed} / ${sum.total} · Re-review ${sum.changed}`);
  renderTreeRows();
}
let renderedTree: ReviewTree | undefined, renderedExpanded: string[] | undefined, treeRowsKey = '', treeSelection = '';
let treeWritable: boolean | undefined;
const treeRows = new Map<string, { row: HTMLElement; label: HTMLButtonElement }>();
let treeChecks: { control: HTMLInputElement; slot: HTMLElement; failed: boolean }[] = [];
function updateTreeControls(): void {
  const selected = targetKey(store.navigation.target);
  if (treeSelection !== selected) {
    const previous = treeRows.get(treeSelection), current = treeRows.get(selected);
    previous?.row.classList.remove('selected'); previous?.label.setAttribute('aria-current', 'false');
    current?.row.classList.add('selected'); current?.label.setAttribute('aria-current', 'true'); treeSelection = selected;
  }
  if (treeWritable !== store.writable) {
    treeWritable = store.writable;
    for (const { control, slot, failed } of treeChecks) { control.disabled = !treeWritable || failed; slot.dataset.disabled = String(control.disabled); }
  }
}
function renderTreeRows(): void {
  const tree = reviewTree(), filter = store.navigation.filter.toLocaleLowerCase();
  const key = JSON.stringify([store.workspace?.workspace.id, store.workspace?.active?.id, filter, unfinishedOnly, store.locale]);
  if (renderedTree === tree && renderedExpanded === store.navigation.expanded && treeRowsKey === key) { updateTreeControls(); return; }
  renderedTree = tree; renderedExpanded = store.navigation.expanded; treeRowsKey = key;
  treeRows.clear(); treeChecks = []; treeSelection = ''; treeWritable = undefined;
  const scroll = treeBody.scrollTop, fragment = document.createDocumentFragment();
  if (!store.workspace?.active) { treeBody.replaceChildren(tr('p', '新建或打开一轮审阅后显示全仓变化。', 'Create or open a review to see all repository changes.', 'muted pane-body')); return; }
  const eligible = tree.eligible(filter, unfinishedOnly), expandedPaths = new Set(store.navigation.expanded);
  function draw(node: TreeNode, depth: number): void {
    if (!eligible.has(node)) return;
    const directory = node.target.type === 'directory', expanded = expandedPaths.has(node.target.path);
    const row = el('div', 'tree-row ' + fileRowTone(node.file) + (targetKey(store.navigation.target) === targetKey(node.target) ? ' selected' : ''));
    row.style.paddingLeft = `${depth * 16 + 4}px`;
    if (directory) {
      const toggle = el('button', 'tree-toggle'); toggle.type = 'button'; toggle.append(icon('chevron', expanded ? 'expanded' : ''));
      toggle.dataset.focus = 'toggle:' + targetKey(node.target);
      toggle.setAttribute('aria-label', text(`${expanded ? '折叠' : '展开'} ${node.target.path}`, `${expanded ? 'Collapse' : 'Expand'} ${node.target.path}`)); toggle.setAttribute('aria-expanded', String(expanded));
      toggle.addEventListener('click', () => {
        store.navigation.expanded = expanded ? store.navigation.expanded.filter(path => path !== node.target.path) : [...store.navigation.expanded, node.target.path];
        store.touch(); renderTreeRows(); treeRows.get(targetKey(node.target))?.row.querySelector<HTMLButtonElement>('.tree-toggle')?.focus({ preventScroll: true });
      }); row.append(toggle);
    } else row.append(el('span', 'tree-spacer'));
    const sum = tree.summary(node.target.path);
    const count = directory ? sum.total : node.file && !node.file.commentOnly ? 1 : 0;
    const reviewed = directory ? sum.reviewed : node.file?.status === 'reviewed' ? count : 0;
    const failed = directory ? !!sum.errors : !!node.file?.error;
    const checkSlot = el(count ? 'label' : 'span', 'tree-check');
    if (count) {
      const check = el('input'); check.type = 'checkbox'; check.checked = reviewed === count; check.indeterminate = !check.checked && reviewed > 0; check.disabled = !store.writable || failed;
      check.dataset.focus = 'review:' + targetKey(node.target); checkSlot.dataset.disabled = String(check.disabled);
      treeChecks.push({ control: check, slot: checkSlot, failed });
      const name = text(`${check.checked ? '取消已审' : '标记已审'}：${node.target.path}，${count} 个变化文件`, `${check.checked ? 'Unmark' : 'Mark reviewed'}: ${node.target.path}, ${count} changed files`); check.setAttribute('aria-label', name); check.title = name;
      checkSlot.title = name;
      check.addEventListener('change', () => {
        const checked = check.checked; check.checked = !checked;
        void run(() => retainCheckboxFocus(check, node.target, () => mark(tree.members(node.target), checked, directory ? node.target.path : undefined)));
      }); checkSlot.append(check);
    }
    row.append(checkSlot);
    const kind = directory ? 'folder' : fileIconKind(node.target.path), typeIcon = icon(kind, `file-icon type-${kind}`);
    const typeLabel = kind === 'test' ? text('测试文件', 'Test file') : directory ? text('目录', 'Directory') : text('文件', 'File');
    const iconWrap = el('span', 'file-icon-slot'); iconWrap.title = typeLabel; iconWrap.append(typeIcon); row.append(iconWrap);
    const label = button(node.name, node.name, async () => { await store.select(node.target); closePanel(treePane); }, 'tree-label');
    label.title = node.target.path + ' · ' + typeLabel; label.dataset.focus = targetKey(node.target); label.dataset.path = node.target.path; label.dataset.targetType = node.target.type;
    label.setAttribute('aria-label', node.name + ' · ' + typeLabel); label.setAttribute('aria-current', targetKey(store.navigation.target) === targetKey(node.target) ? 'true' : 'false'); row.append(label);
    treeRows.set(targetKey(node.target), { row, label });
    if (directory) row.append(el('span', 'tree-status ' + (sum.total && sum.reviewed === sum.total ? 'success' : sum.reviewed ? 'warning' : ''), `${sum.reviewed}/${sum.total}`));
    else {
      const file = node.file;
      const state = el('span', 'tree-status ' + (file?.error ? 'error' : file?.status === 'changed' ? 'warning' : file?.change === 'added' ? 'success' : file?.change === 'deleted' ? 'error' : 'file-modified'), file?.error ? '!' : file?.commentOnly ? 'C' : file?.status === 'changed' ? '↻' : ({ added: 'A', modified: 'M', deleted: 'D' }[file?.change || 'modified']));
      state.title = file?.error ? text('读取失败', 'Read failed') : file?.commentOnly ? text('仅评论对象', 'Comment-only target') : file?.status === 'changed' ? text('内容已变化，需复审', 'Content changed; re-review required') : text('文件变化类型', 'File change type'); row.append(state);
    }
    if (sum.open) { const count = el('span', 'tree-comment'); count.append(icon('comment'), el('span', '', String(sum.open))); count.title = text(`${sum.open} 条未解决意见`, `${sum.open} unresolved comments`); row.append(count); }
    fragment.append(row);
    if (directory && expanded) node.children.forEach(child => draw(child, depth + 1));
  }
  tree.roots.forEach(node => draw(node, 0));
  if (!fragment.childElementCount) fragment.append(tr('p', filter || unfinishedOnly ? '没有匹配的路径。' : '本轮没有变化文件；意见仍可从待处理入口查看。', filter || unfinishedOnly ? 'No matching paths.' : 'No changed files. Comments remain available in Pending.', 'muted pane-body'));
  treeBody.replaceChildren(fragment); treeBody.scrollTop = scroll; updateTreeControls();
}
async function retainCheckboxFocus(control: HTMLInputElement, target: Target, action: () => Promise<void>): Promise<void> {
  const focused = document.activeElement === control, activity = focusActivity;
  const workspaceId = store.workspace?.workspace.id, reviewId = store.workspace?.active?.id, selected = targetKey(store.navigation.target);
  const treeScroll = treeBody.scrollTop, commentsScroll = commentList.scrollTop, diffScroll = store.navigation.scroll;
  try { await action(); }
  finally {
    const active = document.activeElement;
    const lost = !active || active === document.body || active === document.documentElement || !active.isConnected;
    if (focused && lost && activity === focusActivity && !activeDialog && !disposed && document.visibilityState === 'visible' &&
      treeScroll === treeBody.scrollTop && commentsScroll === commentList.scrollTop && diffScroll === store.navigation.scroll &&
      workspaceId === store.workspace?.workspace.id && reviewId === store.workspace?.active?.id && selected === targetKey(store.navigation.target)) {
      const current = treeRows.get(targetKey(target))?.row.querySelector<HTMLInputElement>('input');
      if (current && !current.disabled) current.focus({ preventScroll: true });
    }
  }
}
async function mark(files: WorkspaceView['files'], checked: boolean, directory?: string): Promise<void> {
  await store.mutate('mark', { files: files.map(file => ({ path: file.path, fingerprint: file.fingerprint, checked })), ...(directory ? { directory } : {}) });
  toast('已审状态已保存', 'Review state saved');
}
function renderMain(): void {
  const target = store.navigation.target, view = store.workspace;
  const title = el('div', 'row spread');
  const nav = button('文件', 'Files', () => panelToggle(treePane, nav), 'panel-toggle tree-toggle-button');
  const notes = button('意见', 'Comments', () => panelToggle(commentsPane, notes), 'panel-toggle comments-toggle');
  nav.dataset.focus = 'open-tree'; notes.dataset.focus = 'open-comments';
  title.append(nav, el('h2', 'path grow', target?.path || text('审阅工作区', 'Review workspace')), notes);
  if (target) {
    title.insertBefore(icon(target.type === 'directory' ? 'folder' : fileIconKind(target.path), 'file-icon'), title.querySelector('h2'));
    const tree = reviewTree(), sum = tree.summary(target.path), file = tree.filesByPath.get(target.path);
    const count = target.type === 'directory' ? sum.total : file && !file.commentOnly ? 1 : 0;
    if (count) {
      const checked = target.type === 'directory' ? sum.reviewed === count : file?.status === 'reviewed';
      const review = iconButton('check', checked ? '取消已审' : '标记已审', checked ? 'Unmark reviewed' : 'Mark reviewed', () => mark(tree.members(target), !checked, target.type === 'directory' ? target.path : undefined), checked ? 'reviewed-button' : 'primary');
      review.disabled = !store.writable || (target.type === 'directory' ? !!sum.errors : !!file?.error); title.append(review);
    }
  }
  const actions = el('div', 'row');
  if (target?.type === 'file') {
    for (const mode of ['full', 'since'] as const) {
      const control = button(mode === 'full' ? '完整 Diff' : '上次审阅后的变化', mode === 'full' ? 'Full diff' : 'Since last review', () => store.select(target, mode), 'tab');
      control.setAttribute('aria-pressed', String(store.navigation.mode === mode)); control.disabled = store.busy || !!view?.active?.deletedAt && mode === 'since'; actions.append(control);
    }
    const selected = button('为选区写意见', 'Comment on selection', useSelection); selected.disabled = !selection || !store.writable || store.navigation.mode !== 'full'; selected.dataset.selectionAction = 'true'; actions.append(selected);
  }
  const capability = tr('span', '只读对比', 'Read-only diff', 'readonly-badge'); capability.title = text('显示已保存的工作区；代码保存后刷新查看。当前版本不提供代码编辑。', 'Shows the saved workspace; refresh after saving code. Code editing is unavailable in this version.');
  actions.append(capability); mainHead.replaceChildren(title, actions);
  const fileError = target?.type === 'file' ? reviewTree().filesByPath.get(target.path)?.error : undefined;
  if (fileError) mainHead.append(tr('p', '此文件读取失败，不能标记已审；其他对象仍可查看。', 'This file could not be read and cannot be marked reviewed. Other targets remain available.', 'error'), el('p', 'small error', fileError));
  if (selectionError) mainHead.append(tr('p', '选区需为 1–200 行，且内容与上下文未超限；不支持的内容请使用文件意见。', 'Select 1–200 lines within the content and context limits. Use a file comment for unsupported content.', 'warning small'));
  sources.replaceChildren();
  const sourceLabels = {
    left: store.diff?.archived ? text('归档时已有已审快照 · 基点侧', 'Saved reviewed snapshot · Base side') : store.navigation.mode === 'since' ? text('上次已审快照', 'Last reviewed snapshot') : text('固定基点 ', 'Fixed base ') + (view?.active?.base.slice(0, 12) || ''),
    right: store.diff?.archived ? text('归档时已有已审快照 · 工作区侧', 'Saved reviewed snapshot · Workspace side') : text('已保存的工作区', 'Saved workspace'),
  };
  if (store.diff && target?.type === 'file') {
    sources.append(el('div', '', sourceLabels.left), el('div', '', sourceLabels.right));
  }
  editor?.setLabels(sourceLabels);
  const key = store.diff ? diffRenderKey(view?.workspace.id, view?.active?.id, store.diff) : JSON.stringify(['empty', view?.workspace.id, targetKey(target), store.loadingDiff, view?.active?.id,
    reviewTree().firstTarget, target?.type === 'directory' ? reviewTree().summary(target.path) : undefined, store.locale]);
  if (key === editorKey) return;
  editorKey = key; editor?.destroy(); editor = undefined; selection = undefined; diffBody.replaceChildren();
  if (store.loadingDiff && !store.diff) { diffBody.append(tr('p', '正在读取完整内容…', 'Reading full content…', 'skeleton')); return; }
  if (!view?.active || !target) {
    const empty = el('div', 'empty'); empty.append(icon('diff', 'empty-icon'), tr('h2', view?.active ? '选择文件，开始审阅' : '固定基点，连续审阅', view?.active ? 'Select a file to begin' : 'Fix a base. Keep your review moving.'));
    empty.append(tr('p', view?.active ? '左侧包含整轮变化与保留意见的对象。评论与已审进度分别保存。' : '选择仓库与基点，阅读全仓 Diff，保存意见和已审进度。', view?.active ? 'The tree includes all changes and retained comment targets. Comments and review progress are saved separately.' : 'Choose a repository and base, read the full diff, and retain comments and review progress.', 'muted'));
    if (!view) empty.append(button('选择仓库', 'Choose repository', repositoryDialog, 'primary'));
    else if (!view.active) empty.append(button('新建审阅', 'New review', () => baseDialog(false), 'primary'));
    else {
      const first = reviewTree().firstTarget;
      if (first) {
        const pending = reviewTree().filesByPath.get(first.path)?.status !== 'reviewed';
        empty.append(iconButton('arrow', pending ? '打开首个待审文件' : '打开首个文件', pending ? 'Open first file to review' : 'Open first file', () => store.select(first), 'primary'));
      }
      else empty.append(button('查看待处理意见', 'View pending comments', () => { store.navigation.commentsMode = 'pending'; store.touch(); renderComments(); commentsPane.classList.add('open'); }));
    }
    diffBody.append(empty); return;
  }
  if (target.type === 'directory') {
    const sum = reviewTree().summary(target.path), pane = el('div', 'directory-summary'), stats = el('div', 'stats');
    for (const [value, zh, en] of [[`${sum.reviewed}/${sum.total}`, '已审变化文件', 'Changed files reviewed'], [sum.open, '未解决意见', 'Unresolved comments'], [sum.resolved, '已解决意见', 'Resolved comments']]) {
      const card = el('div', 'stat'); card.append(el('strong', '', String(value)), tr('span', String(zh), String(en), 'muted')); stats.append(card);
    }
    pane.append(tr('h2', '目录概览', 'Directory overview'), stats, tr('p', '统计包含本目录及全部子项；仅评论对象不计入变化文件。', 'Counts include this directory and all descendants. Comment-only targets do not count as changed files.', 'muted'));
    pane.append(button('查看本轮待处理', 'View pending comments', () => { store.navigation.commentsMode = 'pending'; store.touch(); renderComments(); commentsPane.classList.add('open'); })); diffBody.append(pane); return;
  }
  if (!store.diff) { diffBody.append(tr('p', '此对象暂无可读取的 Diff。保留意见仍可访问。', 'No diff is available for this target. Retained comments remain accessible.', 'skeleton')); return; }
  const diff = store.diff;
  if (diff.reason) {
    const empty = el('div', 'empty'); empty.append(tr('p', diff.reason === 'not-reviewed' ? '没有上次已审快照，请查看完整 Diff。' : '上次已审后没有内容变化。', diff.reason === 'not-reviewed' ? 'No reviewed snapshot exists. Open the full diff.' : 'Content has not changed since the last review.'));
    empty.append(button('查看完整 Diff', 'Open full diff', () => store.select(target, 'full'))); diffBody.append(empty); return;
  }
  if (!diff.left.textContent || !diff.right.textContent) {
    const metadata = el('div', 'metadata');
    for (const side of ['left', 'right'] as const) {
      const column = el('div', 'stack'), content = diff[side]; column.append(tr('h3', side === 'left' ? '左侧内容' : '右侧内容', side === 'left' ? 'Left content' : 'Right content'));
      column.append(tr('p', '此内容无法作为普通 UTF-8 文本展示；可添加文件意见。', 'This content cannot be displayed as ordinary UTF-8 text. File comments are available.', 'muted'));
      column.append(el('pre', '', `${text('模式', 'Mode')}: ${content.mode}\n${text('字节', 'Bytes')}: ${content.bytes}\nSHA-256: ${content.hash}`)); if (content.textContent) column.append(el('pre', '', content.text)); metadata.append(column);
    }
    diffBody.append(metadata); return;
  }
  editor = new DiffEditor(diffBody, diff, (anchor, error) => {
    selection = anchor; selectionError = error || '';
    if (anchor) store.navigation.anchor = structuredClone(anchor);
    const control = mainHead.querySelector<HTMLButtonElement>('[data-selection-action]'); if (control) control.disabled = !anchor || !store.writable;
  }, (side, line, scroll) => { store.navigation = { ...store.navigation, side, line, scroll, fingerprint: diff.fingerprint }; store.touch(); }, sourceLabels);
  if (!editor.restore(store.navigation)) toast('原定位对应的内容已变化，已保留文件与草稿，请重新定位。', 'Content at the saved position changed. The file and drafts are retained; select a new position.');
}
function newDraft(target: Target): Draft {
  let draft = store.drafts.find(item => !item.commentId && targetKey(item.target) === targetKey(target));
  if (!draft) {
    store.drafts = store.drafts.filter(item => item.body || item.anchor || item.commentId || store.drafts.some(edit => edit.originalNewDraft === item.id));
    draft = { id: newId(), target: { ...target }, body: '', requestId: newId() }; store.drafts.push(draft);
  }
  return draft;
}
function textarea(draft: Draft): HTMLTextAreaElement {
  let input = inputs.get(draft.id);
  if (!input) {
    input = el('textarea'); input.dataset.focus = draft.id; input.value = draft.body; input.maxLength = 20000;
    input.addEventListener('input', () => { const current = store.drafts.find(item => item.id === draft.id); if (current) { current.body = input!.value; store.touch(); renderStatus(); } }); inputs.set(draft.id, input);
  }
  input.setAttribute('aria-label', text(draft.commentId ? '编辑意见正文' : '新意见正文', draft.commentId ? 'Edit comment' : 'New comment'));
  input.readOnly = !store.workspace?.context;
  input.placeholder = text('写下需要核对或修改的具体问题…', 'Describe what should be checked or changed…'); return input;
}
function draftAnchor(draft: Draft): HTMLElement {
  const wrap = el('div', 'stack');
  if (!draft.anchor) return wrap;
  wrap.append(el('span', 'badge', text(draft.anchor.side === 'left' ? '基点侧' : '工作区侧', draft.anchor.side === 'left' ? 'Base side' : 'Workspace side') + ` · ${draft.anchor.start + 1}–${draft.anchor.end + 1}`), el('pre', 'draft-anchor', draft.anchor.selected.join('\n')));
  if (!draft.commentId) wrap.append(button('改为文件意见', 'Convert to file comment', () => { delete draft.anchor; store.touch(); renderComments(); })); return wrap;
}
function useSelection(): void {
  const target = store.navigation.target; if (!selection || target?.type !== 'file' || !store.writable) return;
  const draft = newDraft(target); draft.anchor = structuredClone(selection); store.navigation.anchor = structuredClone(selection); store.touch(); renderComments(); commentsPane.classList.add('open'); textarea(draft).focus();
}
function startEdit(comment: Comment): void {
  const current = store.drafts.find(draft => draft.commentId);
  if (current && current.commentId !== comment.id) { toast('已有另一条编辑草稿，请先保存或取消。', 'Another edit draft is open. Save or cancel it first.'); return; }
  if (!current) {
    const original = newDraft({ type: comment.target, path: comment.path });
    store.drafts.push({ id: newId(), target: { type: comment.target, path: comment.path }, body: comment.body,
      ...(comment.anchor ? { anchor: structuredClone(comment.anchor) } : {}), commentId: comment.id, commentRevision: comment.revision, commentState: comment.state, requestId: newId(), originalNewDraft: original.id });
    store.touch();
  }
  renderComments(); textarea(store.drafts.find(draft => draft.commentId === comment.id)!).focus();
}
async function submitDraft(draft: Draft): Promise<void> {
  if (!draft.body.trim()) { toast('请输入意见正文。', 'Enter a comment first.'); return; }
  const originalBody = draft.body, originalId = draft.id;
  await store.flush();
  if (!store.writable) return;
  const comment = store.workspace!.comments.find(item => item.id === draft.commentId);
  if (draft.commentId && (!comment || comment.deleted || comment.revision !== draft.commentRevision || comment.state !== draft.commentState)) { toast('原评论已改变，编辑草稿已保留，请先核对。', 'The original comment changed. Your edit draft is retained; verify it before saving.'); return; }
  if (!draft.commentId && draft.target.type === 'file' && !store.workspace!.files.some(file => file.path === draft.target.path)) { toast('原文件对象已不可用，草稿已保留，请先刷新核对。', 'The original file target is unavailable. The draft is retained; refresh and verify it.'); return; }
  await store.mutate(draft.commentId ? 'changeComment' : 'addComment', draft.commentId ? {
    id: draft.commentId, revision: draft.commentRevision, expectedState: draft.commentState, deleted: false, change: 'edit', body: originalBody,
  } : commentPayload({ ...draft, body: originalBody }, store.workspace!.files));
  if (store.drafts.find(item => item.id === originalId)?.body === originalBody) { store.drafts = store.drafts.filter(item => item.id !== originalId); inputs.delete(originalId); }
  else if (!draft.commentId) draft.requestId = newId();
  store.touch(); await store.flush(); renderComments(); toast('评论已保存', 'Comment saved');
}
async function changeComment(comment: Comment, change: 'resolve' | 'reopen' | 'delete' | 'restore'): Promise<void> {
  await store.mutate('changeComment', { id: comment.id, revision: comment.revision, expectedState: comment.state, deleted: comment.deleted, change });
  commentList.focus(); toast('评论状态已保存', 'Comment state saved');
}
let commentsKey: unknown[] = [], commentsWritable: boolean | undefined;
function renderComments(): void {
  const view = store.workspace, target = store.navigation.target, sum = reviewTree().total;
  if (commentsWritable !== store.writable) {
    commentsWritable = store.writable;
    commentsPane.querySelectorAll<HTMLButtonElement>('[data-requires-write]').forEach(control => { control.disabled = !store.writable || control.dataset.blocked === 'true'; });
  }
  const signature = () => [view?.workspace.id, view?.active?.id, !!view?.active?.deletedAt, view?.comments, store.diff?.comments, targetKey(target), store.navigation.commentsMode, store.locale,
    JSON.stringify(store.drafts.map(draft => [draft.id, draft.commentId, draft.commentRevision, draft.commentState, draft.anchor]))];
  const key = signature();
  if (key.every((value, index) => value === commentsKey[index])) return;
  commentsKey = key;
  const scroll = commentList.scrollTop;
  const tabs = el('div', 'row');
  for (const mode of ['target', 'pending'] as const) {
    const tab = button(mode === 'target' ? target?.type === 'directory' ? '当前目录' : '当前文件' : `待处理 ${sum.open}`, mode === 'target' ? target?.type === 'directory' ? 'Directory' : 'Current file' : `Pending ${sum.open}`, () => { store.navigation.commentsMode = mode; store.touch(); renderComments(); }, 'tab');
    tab.setAttribute('aria-pressed', String(store.navigation.commentsMode === mode)); tabs.append(tab);
  }
  tabs.append(button('关闭', 'Close', () => closePanel(commentsPane), 'panel-toggle comments-toggle')); commentsHead.replaceChildren(tabs);
  if (sum.review) commentsHead.append(tr('p', `${sum.review} 条 Agent 回复等待人工复核`, `${sum.review} Agent replies await your verification`, 'small muted'));
  commentList.replaceChildren();
  const comments = (view?.comments || []).filter(comment => store.navigation.commentsMode === 'pending' ? !comment.deleted && comment.state === 'open' : target && comment.target === target.type && comment.path === target.path);
  if (!comments.length) commentList.append(tr('p', '暂无意见。', 'No comments here.', 'muted'));
  for (const comment of comments) {
    const card = el('article', 'comment-card ' + (comment.deleted ? 'is-deleted' : comment.state === 'resolved' ? 'is-resolved' : comment.reply?.matches ? 'is-review' : 'is-pending')), header = el('div', 'row spread');
    const state = comment.deleted ? ['已删除', 'Deleted'] : comment.state === 'resolved' ? ['已解决', 'Resolved'] : comment.reply?.matches ? ['Agent 已回复 · 待复核', 'Agent replied · Verify'] : ['待处理', 'Pending'];
    header.append(el('span', 'badge', text(state[0], state[1])));
    const located = store.diff?.comments.find(item => item.id === comment.id) || comment;
    const location = button(comment.path, comment.path, async () => {
      await store.select({ type: comment.target, path: comment.path }, 'full');
      const fresh = store.diff?.comments.find(item => item.id === comment.id);
      if (comment.anchor && ['exact', 'moved'].includes(fresh?.location?.kind || '') && fresh?.location?.start !== undefined) editor?.locate(comment.anchor.side, fresh.location.start, fresh.location.end);
      else if (comment.anchor) toast('位置待核对，已保留原片段。', 'Location needs verification. The original fragment is retained.');
    }, 'quiet path small'); header.append(location); card.append(header);
    if (comment.anchor) {
      const locations = { exact: ['原位置', 'Original location'], moved: ['已跟随行号变化', 'Located after line movement'], changed: ['相关代码已变化', 'Related code changed'], unavailable: ['位置待确认', 'Location unconfirmed'], file: ['文件意见', 'File comment'] };
      const label = locations[located.location?.kind || 'unavailable']; card.append(el('span', 'small muted', text(label[0], label[1]) + ` · ${text(comment.anchor.side === 'left' ? '左侧' : '右侧', comment.anchor.side === 'left' ? 'Left' : 'Right')} ${comment.anchor.start + 1}–${comment.anchor.end + 1}`));
      const details = el('details'); details.append(tr('summary', '原选区', 'Original selection'), el('pre', '', comment.anchor.selected.join('\n'))); card.append(details);
    }
    const draft = store.drafts.find(item => item.commentId === comment.id);
    if (draft) {
      card.append(textarea(draft));
      const changed = comment.deleted || comment.revision !== draft.commentRevision || comment.state !== draft.commentState;
      if (changed) card.append(tr('p', '原评论版本或状态已改变，草稿保留，保存已停用。', 'The original comment version or state changed. The draft is retained; saving is disabled.', 'warning'));
      const save = button('保存编辑', 'Save edit', () => submitDraft(draft), 'primary'); save.disabled = !store.writable || changed;
      save.dataset.requiresWrite = 'true'; save.dataset.blocked = String(changed);
      card.append(save, button('取消编辑', 'Cancel edit', async () => { store.drafts = store.drafts.filter(item => item.id !== draft.id); inputs.delete(draft.id); store.touch(); await store.flush(); renderComments(); }));
    } else card.append(el('p', 'comment-body', comment.body));
    if (comment.reply) {
      if (comment.reply.matches) card.append(el('div', 'reply', comment.reply.body));
      else { const old = el('details'); old.append(tr('summary', '旧版 Agent 回复 · 与当前意见不匹配', 'Earlier Agent reply · Does not match this revision'), el('div', 'reply', comment.reply.body)); card.append(old); }
    }
    if (!draft) {
      const actions = el('div', 'comment-actions');
      if (comment.deleted) actions.append(button('恢复', 'Restore', () => changeComment(comment, 'restore')));
      else actions.append(button('编辑', 'Edit', () => startEdit(comment)), button(comment.state === 'open' ? '解决' : '重新打开', comment.state === 'open' ? 'Resolve' : 'Reopen', () => changeComment(comment, comment.state === 'open' ? 'resolve' : 'reopen')), button('删除', 'Delete', () => changeComment(comment, 'delete'), 'danger'));
      actions.querySelectorAll('button').forEach(button => { button.disabled = !store.writable; button.dataset.requiresWrite = 'true'; }); card.append(actions);
    }
    commentList.append(card);
  }
  // Orphaned edit drafts remain visible and cannot silently become new comments.
  for (const draft of store.drafts.filter(item => item.commentId && !view?.comments.some(comment => comment.id === item.commentId))) {
    const card = el('article', 'comment-card'); card.append(tr('h3', '原评论不可用 · 编辑草稿已保留', 'Original comment unavailable · Edit draft retained'), el('span', 'path', draft.target.path), textarea(draft)); commentList.append(card);
  }
  composer.replaceChildren();
  if (!target || !view?.active) { composer.append(tr('p', '先选择文件或目录，再添加意见。', 'Select a file or directory to add a comment.', 'muted')); return; }
  if (view.active.deletedAt) { composer.append(tr('p', '归档记录只读；恢复并核对分支后可继续审阅。', 'Archived reviews are read-only. Restore and verify the branch to continue.', 'muted')); return; }
  const draft = newDraft(target); composer.append(tr('h3', target.type === 'directory' ? '目录意见 · 未提交' : draft.anchor ? '选区意见 · 未提交' : '文件意见 · 未提交', target.type === 'directory' ? 'Directory comment · Draft' : draft.anchor ? 'Selection comment · Draft' : 'File comment · Draft'), draftAnchor(draft), textarea(draft));
  const submit = button('保存评论', 'Save comment', () => submitDraft(draft), 'primary'); submit.disabled = !store.writable; submit.dataset.requiresWrite = 'true';
  composer.append(submit);
  if (target.type === 'directory') composer.append(button('查看本轮待处理意见', 'View pending comments in this review', () => { store.navigation.commentsMode = 'pending'; store.touch(); renderComments(); }));
  commentList.scrollTop = scroll;
  commentsKey = signature();
}

interface DialogFrame { node: HTMLDialogElement; body: HTMLDivElement; close: () => void; title: (zh: string, en: string) => void; cancel: () => void }
function dialog(zh: string, en: string): DialogFrame {
  disposeDialog?.(); disposeDialog = undefined;
  activeDialog?.close(); activeDialog?.remove(); updateDialog = undefined;
  const previous = document.activeElement as HTMLElement | null, previousKey = previous?.dataset.focus;
  const node = el('dialog'), head = el('div', 'dialog-head'), body = el('div', 'dialog-body');
  const heading = tr('h2', zh, en); heading.id = 'dialog-heading'; heading.tabIndex = -1; node.setAttribute('aria-labelledby', heading.id);
  const close = () => {
    disposeDialog?.(); disposeDialog = undefined;
    node.close(); node.remove(); activeDialog = undefined; updateDialog = undefined;
    const trigger = previous?.isConnected ? previous : [...document.querySelectorAll<HTMLElement>('[data-focus]')].find(item => item.dataset.focus === previousKey);
    trigger?.focus();
  };
  const frame: DialogFrame = { node, body, close, cancel: close, title: (zh, en) => { heading.dataset.zh = zh; heading.dataset.en = en; heading.textContent = text(zh, en); } };
  head.append(heading, button('关闭', 'Close', close, 'quiet')); node.append(head, body); document.body.append(node); activeDialog = node;
  node.addEventListener('cancel', event => { event.preventDefault(); frame.cancel(); }); node.showModal(); heading.focus(); return frame;
}
function errorSummary(): string { return text(...(errors[store.error?.code || 'UNKNOWN_RESULT'] || errors.UNKNOWN_RESULT)); }
function settingsDialog(frame = dialog('设置', 'Settings')): void {
  const { body } = frame; frame.node.className = 'settings-dialog'; frame.title('设置', 'Settings'); frame.cancel = frame.close;
  body.replaceChildren();
  const appearance = el('section', 'settings-section'), language = el('select'); language.id = 'interface-language';
  for (const [value, zh, en] of [['auto', '跟随宿主', 'Follow host'], ['zh-CN', '简体中文', '简体中文'], ['en', 'English', 'English']]) { const option = tr('option', zh, en); option.value = value; language.append(option); }
  language.setAttribute('aria-label', text('界面语言', 'Interface language'));
  const help = el('p', 'muted small'), feedback = el('p', 'field-feedback'); feedback.setAttribute('role', 'status');
  let languageState: 'idle' | 'saving' | 'saved' | 'error' = 'idle', failureCode: string | undefined;
  appearance.append(tr('h3', '界面', 'Appearance'), labelled('界面语言', 'Interface language', language), help, feedback);
  const repository = el('section', 'settings-section'), repoTitle = el('h3'), summary = el('p', 'path default-base-value');
  const change = button('更改…', 'Change…', () => baseDialog(true, frame, () => settingsDialog(frame)));
  repository.append(repoTitle, tr('p', '新建审阅的默认基点', 'Default base for new reviews', 'setting-label'), summary, change,
    tr('p', '只影响以后新建，不改变当前 CR。', 'Only affects future reviews, not the current review.', 'muted small'));
  body.append(appearance, repository);
  const update = () => {
    language.value = store.bootstrap?.preferences.language || 'auto'; language.disabled = store.preferenceBusy || store.busy || !!store.unknown;
    language.setAttribute('aria-label', text('界面语言', 'Interface language'));
    help.textContent = text(`当前显示：${store.locale === 'zh-CN' ? '简体中文' : 'English'}。适用于所有仓库。`, `Currently displayed: ${store.locale === 'zh-CN' ? '简体中文' : 'English'}. Applies to all repositories.`);
    feedback.className = 'field-feedback ' + (languageState === 'error' ? 'error' : languageState === 'saved' ? 'success' : 'muted');
    feedback.textContent = languageState === 'saving' ? text('正在保存语言偏好…', 'Saving language preference…') : languageState === 'saved' ? text('语言偏好已保存', 'Language preference saved') : languageState === 'error' ? text(...(errors[failureCode || 'IO_FAILED'] || errors.IO_FAILED)) : '';
    repoTitle.textContent = store.workspace ? text('当前仓库 · ', 'Current repository · ') + store.workspace.workspace.name : text('当前仓库', 'Current repository');
    const value = store.workspace?.defaultBase;
    summary.textContent = !store.workspace ? text('先选择仓库后设置默认基点。', 'Choose a repository to configure its default base.') : value ? (value.kind === 'commit' ? text('提交 · ', 'Commit · ') : text('分支共同祖先 · ', 'Branch merge base · ')) + value.ref : text('尚未指定；新建时选择基点。', 'Not configured; choose a base when creating a review.');
    change.disabled = !store.workspace || !store.workspace.workspace.initialized || store.busy || !!store.unknown;
  };
  language.addEventListener('change', () => {
    const requested = language.value as Language; languageState = 'saving'; update();
    void (async () => { try { await store.language(requested); languageState = 'saved'; } catch { languageState = 'error'; failureCode = store.error?.code; } finally { if (body.isConnected) { update(); language.focus(); } } })();
  });
  updateDialog = update; update();
}
function repositoryDialog(): void {
  const frame = dialog(store.workspace ? '切换项目' : '打开项目', store.workspace ? 'Switch project' : 'Open project');
  const { body, close } = frame; frame.node.className = 'repository-dialog';
  const recent = store.bootstrap?.preferences.recent || [], list = el('div', 'recent-list'), input = el('input'), form = el('div', 'repository-form');
  input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 4096; input.id = 'repository-path';
  input.setAttribute('aria-describedby', 'repository-path-help');
  const description = tr('p', '输入本地 Git 仓库目录，也可以使用仓库中的子目录。', 'Enter a local Git repository directory or a subdirectory within it.', 'muted small'); description.id = 'repository-path-help';
  const feedback = el('p', 'field-feedback'); feedback.setAttribute('role', 'status');
  const pickerFeedback = el('p', 'field-feedback'), pickerActions = el('div', 'row folder-picker-actions'); pickerFeedback.setAttribute('role', 'status');
  const pickedPath = el('span', 'path'), pickedSummary = el('p', 'picker-selection'), pickerOpenFeedback = el('p', 'field-feedback');
  pickedSummary.append(tr('span', '已选文件夹', 'Selected folder', 'muted small'), pickedPath); pickedSummary.hidden = true; pickerOpenFeedback.setAttribute('role', 'status');
  let pending = false, pickerOpening = false, pickerOpenError: [string, string] | undefined;
  const showManual = (): void => { form.hidden = false; manual.setAttribute('aria-expanded', 'true'); };
  const open = async (root: string, destination: HTMLElement, viaPicker = false): Promise<void> => {
    if (pending || store.busy || store.unknown) return;
    if (!root.trim()) { destination.replaceChildren(tr('span', '请输入仓库目录。', 'Enter a repository directory.')); input.focus(); return; }
    picker.abandon(); pending = true; pickerOpening = viaPicker; if (viaPicker) pickerOpenError = undefined; update();
    destination.className = 'field-feedback muted'; destination.replaceChildren(tr('span', '正在打开…', 'Opening…'));
    try { await store.open(root); if (!body.isConnected) return; close(); if (!store.workspace?.active) await baseDialog(false); }
    catch (error) {
      if (!body.isConnected) return;
      const failure = error instanceof RequestFailure ? error.failure : undefined;
      const message = repositoryFailureMessage(failure) || errors[failure?.code || 'UNKNOWN_RESULT'] || errors.UNKNOWN_RESULT;
      if (viaPicker) pickerOpenError = message;
      destination.className = 'field-feedback error'; destination.textContent = text(...message);
      if (form.contains(destination)) { showManual(); input.focus(); }
    } finally { pending = false; pickerOpening = false; if (body.isConnected) update(); }
  };
  const picker = new FolderPickerSession((action, requestId) => store.folderPicker(action, requestId), state => {
    if (!body.isConnected) return;
    update();
    if (state.status === 'selected') {
      input.value = state.root; pickedPath.textContent = state.root; pickedPath.title = state.root; pickedSummary.hidden = false;
      if (store.busy || store.unknown) {
        pickerOpenError = ['目录已选中；请先核对当前保存状态，再重新选择项目。', 'Folder selected. Resolve the current save status before choosing the project again.']; update(); return;
      }
      void open(state.root, pickerOpenFeedback, true);
    }
  });
  disposeDialog = () => picker.dispose();
  const choose = iconButton('folder', '选择文件夹…', 'Choose folder…', () => { pickerOpenError = undefined; pickedSummary.hidden = true; return picker.start(); }, 'primary choose-folder');
  const cancelPick = button('取消选择', 'Cancel selection', () => picker.cancel()); cancelPick.hidden = true;
  const manual = button('手动输入路径', 'Enter path manually', () => {
    if (picker.busy) return;
    picker.abandon(); form.hidden = !form.hidden; manual.setAttribute('aria-expanded', String(!form.hidden)); if (!form.hidden) input.focus();
  }, 'manual-path quiet');
  manual.setAttribute('aria-expanded', 'false'); manual.setAttribute('aria-controls', 'repository-form'); form.id = 'repository-form'; form.hidden = true;
  const action = iconButton('arrow', '打开项目', 'Open project', () => open(input.value.trim(), feedback), 'secondary');
  form.append(labelled('仓库目录', 'Repository directory', input), description, feedback, action);
  const failures: Record<string, [string, string]> = {
    unavailable: ['当前环境不支持系统文件夹选择。请手动输入路径。', 'The system folder chooser is unavailable in this environment. Enter a path manually.'],
    busy: ['另一个文件夹选择窗口正在使用中。请完成或关闭后重试，也可手动输入路径。', 'Another folder chooser is already open. Complete or close it and retry, or enter a path manually.'],
    'launch-failed': ['系统文件夹选择器未能启动。请重试，也可手动输入路径。', 'The system folder chooser could not start. Retry or enter a path manually.'],
    'invalid-result': ['文件夹选择结果无法校验，尚未打开仓库。请重试或手动输入路径。', 'The folder selection could not be validated. No repository was opened. Retry or enter a path manually.'],
    expired: ['此次文件夹选择已结束或过期。请重新选择，也可手动输入路径。', 'This folder selection has ended or expired. Choose again or enter a path manually.'],
  };
  function update(): void {
    const state = picker.state, supported = store.bootstrap?.capabilities.folderPicker === true;
    const locked = pending || picker.busy || store.busy || !!store.unknown;
    list.querySelectorAll<HTMLButtonElement>('button').forEach(item => { item.disabled = locked; });
    input.readOnly = pending || picker.busy; action.disabled = locked; manual.disabled = pending || picker.busy;
    choose.disabled = !supported || locked;
    const label = state.status === 'pending' ? ['选择文件夹中…', 'Choosing folder…'] : state.status === 'cancelling' ? ['正在取消…', 'Cancelling…'] : state.status === 'interrupted' && state.cancelling ? ['重试取消', 'Retry cancellation'] : ['failed', 'timed-out', 'interrupted'].includes(state.status) ? ['重试选择文件夹…', 'Retry folder selection…'] : pickerOpenError ? ['重新选择文件夹…', 'Choose another folder…'] : ['选择文件夹…', 'Choose folder…'];
    const caption = choose.querySelector<HTMLElement>('span')!; caption.dataset.zh = label[0]; caption.dataset.en = label[1]; caption.textContent = text(label[0], label[1]);
    cancelPick.hidden = !['pending', 'cancelling', 'interrupted'].includes(state.status); cancelPick.disabled = state.status === 'cancelling';
    input.placeholder = text('输入本地 Git 仓库目录', 'Enter a local Git repository directory');
    pickerOpenFeedback.className = 'field-feedback ' + (pickerOpenError ? 'error' : 'muted');
    pickerOpenFeedback.textContent = pickerOpening ? text('正在打开…', 'Opening…') : pickerOpenError ? text(...pickerOpenError) : '';
    pickerFeedback.className = 'field-feedback ' + (['failed', 'timed-out', 'interrupted'].includes(state.status) ? 'warning' : 'muted');
    pickerFeedback.textContent = !supported ? text(...failures.unavailable) : state.status === 'failed' ? text(...failures[state.reason]) : state.status === 'timed-out' ? text('选择文件夹已超时，尚未打开仓库。请重试或手动输入路径。', 'Folder selection timed out. No repository was opened. Retry or enter a path manually.') : state.status === 'interrupted' ? text(state.cancelling ? '取消操作的连接中断。请重试取消，也可关闭此弹窗或手动输入路径；迟到的选择不会打开仓库。' : '文件夹选择连接中断。请重试核对结果，或取消选择后手动输入路径。', state.cancelling ? 'The connection was interrupted during cancellation. Retry cancellation, close this dialog, or enter a path manually. A late selection will not open a repository.' : 'The folder chooser connection was interrupted. Retry to check the result, or cancel and enter a path manually.') : '';
  }
  if (recent.length) body.append(tr('h3', '最近项目', 'Recent projects'));
  for (const repo of recent) {
    const row = el('div', 'recent-entry'), item = el('button', 'recent-project'), details = el('span', 'recent-project-details'), entryFeedback = el('p', 'field-feedback'); item.type = 'button';
    const current = repo.id === store.workspace?.workspace.id; if (current) item.classList.add('current');
    details.append(el('strong', '', repo.name), el('span', 'path recent-path', repo.root)); item.title = repo.root;
    item.append(icon('repository'), details, current ? tr('span', '当前', 'Current', 'badge') : icon('arrow'));
    item.setAttribute('aria-label', text(`打开项目 ${repo.name}，${repo.root}`, `Open project ${repo.name}, ${repo.root}`));
    entryFeedback.setAttribute('role', 'status'); item.addEventListener('click', () => { void open(repo.root, entryFeedback); });
    row.append(item, entryFeedback); list.append(row);
  }
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); action.click(); } });
  pickerActions.append(choose, cancelPick);
  body.prepend(tr('p', '选择要审阅的 Git 项目文件夹。', 'Choose the Git project folder to review.', 'muted'));
  body.append(list, pickerActions, pickedSummary, pickerOpenFeedback, pickerFeedback, manual, form, tr('p', '打开只读取项目；保存审阅资料会在首次新建时说明。', 'Opening only reads the project. Review storage is explained when you create the first review.', 'muted small dialog-footnote'));
  updateDialog = update; update();
  if (!recent.length) { if (!choose.disabled) choose.focus(); else manual.focus(); }
  else list.querySelector<HTMLButtonElement>('.current')?.focus();
}
function exportDraftsDialog(): void {
  const { body } = dialog('导出当前草稿', 'Export current drafts'), input = el('textarea');
  input.readOnly = true; input.rows = 16;
  input.value = JSON.stringify({ version: 1, workspace: store.workspace?.workspace, review: store.workspace?.active,
    navigation: store.navigation, drafts: store.drafts }, null, 2);
  body.append(tr('p', '原 CR 暂不可写时，可复制完整输入到你选择的本地文件。此操作不表示已保存；确认保留前请勿关闭。', 'If the original review is not writable, copy this complete input to a local file of your choice. This does not confirm a save; keep this view open until retained.', 'muted'), labelled('完整草稿与归属', 'Complete drafts and ownership', input));
  input.focus(); input.select();
}
async function baseDialog(defaultOnly: boolean, existing?: DialogFrame, onReturn?: () => void): Promise<void> {
  if (!store.workspace) return;
  const expectedBranch = store.workspace.branch.key;
  const frame = existing || dialog('新建或接续审阅', 'Create or resume review');
  const { body, close } = frame;
  updateDialog = undefined; body.replaceChildren();
  frame.title(defaultOnly ? `${store.workspace.workspace.name} 的默认基点` : '新建或接续审阅', defaultOnly ? `Default base for ${store.workspace.workspace.name}` : 'Create or resume review');
  if (onReturn) { frame.cancel = onReturn; body.append(button('‹ 返回设置', '‹ Back to settings', onReturn, 'back-button quiet')); }
  const loading = tr('p', '正在读取分支与提交…', 'Reading branches and commits…', 'muted'); body.append(loading);
  let options: BaseOptions;
  try { options = await store.request<BaseOptions>('bases', {}); }
  catch { loading.textContent = errorSummary(); loading.className = 'error'; body.append(button('重试', 'Retry', () => baseDialog(defaultOnly, frame, onReturn))); return; }
  if (!body.isConnected || !loading.isConnected) return; loading.remove();
  const initial = defaultBaseSelection(store.workspace.defaultBase, options);
  const kind = el('select'); for (const [value, zh, en] of [['branch', '分支共同祖先', 'Merge base with branch'], ['commit', '指定提交 SHA', 'Specific commit SHA']]) { const option = tr('option', zh, en); option.value = value; kind.append(option); }
  kind.value = initial.kind;
  const branch = el('select'); for (const entry of options.branches) { const option = el('option', '', entry.name); option.value = entry.ref; branch.append(option); }
  branch.value = initial.branch;
  const commit = el('input'); commit.placeholder = text('输入提交 SHA（由 Git 校验并固定完整 SHA）', 'Commit SHA (validated and fixed to the full SHA)'); commit.spellcheck = false; commit.maxLength = 1024;
  commit.value = initial.commit;
  const commits = el('datalist'); commits.id = 'commit-candidates'; for (const item of options.commits) { const option = el('option'); option.value = item.oid; option.label = item.subject; commits.append(option); } commit.setAttribute('list', commits.id);
  const branchLabel = labelled('来源分支', 'Source branch', branch), commitLabel = labelled('提交 SHA', 'Commit SHA', commit);
  branchLabel.hidden = initial.kind !== 'branch'; commitLabel.hidden = initial.kind !== 'commit';
  kind.addEventListener('change', () => { branchLabel.hidden = kind.value !== 'branch'; commitLabel.hidden = kind.value !== 'commit'; });
  body.append(labelled('基点方式', 'Base type', kind), branchLabel, commitLabel, commits,
    tr('p', defaultOnly ? '只影响之后新建审阅的默认选择，不改变当前 CR。' : '分支方式固定与当前 HEAD 的共同祖先；提交方式固定指定提交。相同分支和基点会接续已有未归档 CR。', defaultOnly ? 'Only affects the default for future reviews; the current review is unchanged.' : 'Branch mode fixes the merge base with the current HEAD. Commit mode fixes the specified commit. An existing active review for the same branch and base is reused.', 'muted'));
  if (!store.workspace.workspace.initialized) body.append(tr('div', '首次启用将在仓库 .reviewslate/codex/ 保存本应用的 CR、已审快照、评论、回执、导航和完整草稿，并追加 /.reviewslate/codex/ 忽略规则。各应用资料独立。', 'First-time setup stores this app’s reviews, reviewed snapshots, comments, replies, navigation and full drafts in .reviewslate/codex/, and adds the /.reviewslate/codex/ ignore rule. App data stays independent.', 'notice'));
  const feedback = el('p', 'field-feedback'); feedback.setAttribute('role', 'status'); body.append(feedback);
  let pending = false;
  const confirm = button(defaultOnly ? '保存默认基点' : store.workspace.workspace.initialized ? '创建或接续' : '启用并新建审阅', defaultOnly ? 'Save default base' : store.workspace.workspace.initialized ? 'Create or resume' : 'Enable and create review', async () => {
    if (pending) return;
    pending = true;
    confirm.disabled = true;
    try {
      const ref = kind.value === 'branch' ? branch.value : commit.value.trim(); if (!ref) { feedback.replaceChildren(tr('span', '请选择基点。', 'Choose a base.')); return; }
      if (!store.workspace!.workspace.initialized) await store.open(store.workspace!.workspace.root, true);
      await store.mutate(defaultOnly ? 'defaultBase' : 'chooseBase', { kind: kind.value, ref, label: kind.value === 'branch' ? branch.selectedOptions[0]?.textContent || ref : ref,
        ...(!defaultOnly ? { expectedBranch } : {}), expectedRevision: store.workspace!.revision });
      if (onReturn) onReturn(); else close();
      toast(defaultOnly ? '默认基点已保存' : '审阅已打开；已有记录的进度与评论保留', defaultOnly ? 'Default base saved' : 'Review opened; progress and comments from existing records are retained');
    } catch { feedback.className = 'field-feedback error'; feedback.textContent = errorSummary(); }
    finally { pending = false; confirm.disabled = false; }
  }, 'primary'); body.append(confirm);
  if (onReturn) body.append(button('取消，返回设置', 'Cancel and return to settings', onReturn));
}
function baseDetails(): void {
  const view = store.workspace; if (!view?.active) return;
  const { body } = dialog('固定基点详情', 'Fixed base details'); body.append(el('p', 'path', view.active.label), el('pre', '', view.active.base));
  if (view.baseCommit) body.append(el('p', '', view.baseCommit.subject), el('p', 'muted', view.baseCommit.date));
  body.append(button('复制完整 SHA', 'Copy full SHA', () => copyBase(view.active!.base, body)));
}
async function copyBase(sha: string, existingBody?: HTMLDivElement): Promise<void> {
  if (await copyText(sha, navigator.clipboard)) { toast('已复制完整 SHA', 'Full SHA copied'); return; }
  const body = existingBody || dialog('复制固定基点', 'Copy fixed base').body;
  let input = body.querySelector<HTMLInputElement>('[data-copy-sha]');
  if (!input) {
    input = el('input', 'path'); input.readOnly = true; input.dataset.copySha = 'true';
    body.append(tr('p', '此宿主未允许自动复制，请从下方选中文本手动复制。', 'This host does not allow automatic copying. Copy the selected text below manually.', 'notice'), labelled('完整 SHA', 'Full SHA', input));
  }
  input.value = sha; input.focus(); input.select();
  toast('完整 SHA 已选中，可手动复制。', 'Full SHA selected for manual copying.');
}
function historyDialog(): void {
  const view = store.workspace; if (!view) return;
  const { body, close } = dialog('审阅历史', 'Review history');
  const groups = [view.reviews.filter(review => !review.deletedAt && review.branch.key === view.branch.key), view.reviews.filter(review => !review.deletedAt && review.branch.key !== view.branch.key), view.reviews.filter(review => !!review.deletedAt)];
  groups.forEach((reviews, group) => {
    body.append(tr('h3', ['当前分支', '其他分支', '已归档'][group], ['Current branch', 'Other branches', 'Archived'][group]));
    if (!reviews.length) body.append(tr('p', '暂无记录', 'No reviews', 'muted'));
    for (const review of reviews) {
      const card = el('div', 'history-card'), actions = el('div', 'row');
      card.append(el('h3', '', 'CR ' + review.id.slice(0, 8)), el('p', 'path', review.branch.label), el('p', 'path', review.label), el('p', 'path muted', review.base));
      if (review.purgePending) card.append(tr('p', '永久删除未完成，需继续清理。', 'Permanent deletion is incomplete. Cleanup must be resumed.', 'warning'));
      if (review.deletedAt && !review.purgePending) actions.append(button('查看归档', 'Inspect archive', async () => { await store.flush(); store.apply(await store.request<WorkspaceView>('inspectReview', { reviewId: review.id })); await store.loadDiff(); close(); }));
      if (!review.purgePending) {
        const open = button(review.deletedAt ? '恢复' : '打开', review.deletedAt ? 'Restore' : 'Open', async () => { await store.mutate(review.deletedAt ? 'restoreReview' : 'openReview', { reviewId: review.id, expectedRevision: store.workspace!.revision }); close(); });
        open.disabled = review.branch.key !== view.branch.key || store.busy; actions.append(open);
        if (!review.deletedAt) actions.append(button('归档', 'Archive', async () => { await store.mutate('archiveReview', { reviewId: review.id, expectedRevision: store.workspace!.revision }); close(); }));
      }
      if (review.branch.key !== view.branch.key) card.append(tr('p', '请先自行切到此分支，再刷新；ReviewSlate 不切换分支。', 'Switch to this branch yourself, then refresh. ReviewSlate does not switch branches.', 'small muted'));
      actions.append(button(review.purgePending ? '继续永久删除…' : '永久删除…', review.purgePending ? 'Continue deletion…' : 'Delete permanently…', () => purgeDialog(review), 'danger')); card.append(actions); body.append(card);
    }
  });
}
function purgeDialog(review: Review): void {
  const { body, close } = dialog('永久删除审阅', 'Permanently delete review');
  body.append(el('p', '', store.workspace!.workspace.name), el('p', 'path', review.branch.label), el('pre', '', review.base), el('p', '', 'CR ' + review.id),
    tr('p', '将永久删除本轮进度、快照、评论、回执、草稿和导航，无法恢复。工作区代码和 Git 元数据不受影响。', 'This permanently removes this review’s progress, snapshots, comments, replies, drafts and navigation. It cannot be undone. Workspace code and Git metadata are unaffected.', 'notice warning'));
  const confirm = el('input'); confirm.placeholder = 'DELETE'; body.append(labelled('输入 DELETE 确认', 'Type DELETE to confirm', confirm));
  const action = button('永久删除', 'Delete permanently', async () => { if (confirm.value !== 'DELETE') return; action.disabled = true; try { await store.mutate('purgeReview', { reviewId: review.id, expectedRevision: store.workspace!.revision }); close(); } finally { action.disabled = confirm.value !== 'DELETE'; } }, 'danger');
  action.disabled = true; confirm.addEventListener('input', () => { action.disabled = confirm.value !== 'DELETE'; }); body.append(action, button('取消', 'Cancel', close));
}
function handoffDialog(): void {
  const view = store.workspace; if (!view?.active) return;
  const sum = reviewTree().total, { body } = dialog('交给 Agent 前确认', 'Confirm Agent handoff');
  body.append(el('p', 'path', `${view.workspace.name} · ${view.branch.label} · CR ${view.active.id}`), el('pre', '', view.active.base),
    tr('p', `拟交接 ${sum.pending} 条待处理意见；${sum.review} 条已有匹配回复，默认不重复处理。`, `${sum.pending} pending comments will be handed off. ${sum.review} comments have matching replies and are excluded by default.`),
    tr('p', '固定说明包含本轮身份、评论 ID 与版本和资料范围。复制后由你在可访问此项目的 Codex 会话发送；复制不会发送消息，也不会解决意见。', 'The fixed handoff includes this review’s identity, comment IDs and revisions, and data scope. After copying, send it yourself in a Codex conversation with access to this project. Copying does not send a message or resolve comments.', 'muted'));
  const versions = el('details'); versions.append(tr('summary', '查看拟交接对象与版本', 'Inspect targets and revisions'));
  for (const comment of view.comments.filter(item => !item.deleted && item.state === 'open' && !item.reply?.matches)) versions.append(el('pre', 'small', `${comment.path}\nID: ${comment.id}\nRevision: ${comment.revision}`));
  body.append(versions);
  const preview = el('textarea'); preview.readOnly = true; preview.hidden = true; preview.setAttribute('aria-label', text('固定交接说明', 'Fixed handoff text')); body.append(preview);
  let batch: Handoff | undefined;
  const action = button('生成并复制固定说明', 'Prepare and copy fixed handoff', async () => {
    action.disabled = true;
    try { await store.flush(); batch ||= await store.request<Handoff>('handoff', {}); preview.value = batch.text; preview.hidden = false; await navigator.clipboard.writeText(batch.text); toast('已复制；请在 Codex 会话发送。', 'Copied. Send it in your Codex conversation.'); }
    catch (error) { if (batch) { preview.hidden = false; preview.select(); toast('复制受限，请从文本框手动复制。尚未发送。', 'Clipboard access is unavailable. Copy from the text box. Nothing has been sent.'); } else throw error; }
    finally { action.disabled = false; }
  }, 'primary'); action.disabled = !sum.pending; body.append(action);
}
function recoveredHandoffDialog(): void {
  const batch = store.recoveredHandoff; if (!batch) return;
  const { body } = dialog('已确认的固定交接说明', 'Confirmed fixed handoff');
  body.append(tr('p', '这是原操作生成的固定批次，以正文内的仓库、CR 和版本为准。尚未发送。', 'This is the fixed batch produced by the original operation. The repository, review and revisions in its text define its scope. It has not been sent.', 'muted'));
  const content = el('textarea'); content.value = batch.text; content.readOnly = true; content.setAttribute('aria-label', text('固定交接说明', 'Fixed handoff text')); body.append(content);
  body.append(button('复制', 'Copy', async () => { try { await navigator.clipboard.writeText(batch.text); toast('已复制；请在 Codex 会话发送。', 'Copied. Send it in your Codex conversation.'); } catch { content.select(); toast('请从文本框手动复制。尚未发送。', 'Copy from the text box. Nothing has been sent.'); } }));
}
function retryDialog(): void {
  const original = store.unknown; if (!original) return;
  const { body, close } = dialog('核对原操作', 'Verify original operation');
  body.append(el('p', 'path', store.workspace?.workspace.name || 'ReviewSlate'), el('pre', '', `CR: ${original.context?.reviewId || '—'}\nOperation: ${original.operationId}`),
    tr('p', store.unknownState === 'pending' ? '此操作可能已保存。继续将保留原操作 ID、原目标和原请求，由本地工具核对结果；不会把未知写入换成一个新请求。页面中的后来输入继续保留。' : '已经确认旧操作没有保存意图。继续会明确重试该动作；草稿保存使用新视图和当前完整输入。', store.unknownState === 'pending' ? 'This operation may already be saved. Continuing keeps its original operation ID, target and request so the local tool can verify it. It will not turn an uncertain write into a new request. Newer input remains retained.' : 'The old operation is confirmed to have no stored intent. Continuing explicitly retries the action; draft retention uses the new view and your current complete input.', 'notice'));
  body.append(button('核对并继续', 'Verify and continue', async () => { await store.retryUnknown(); close(); }, 'primary'), button('取消', 'Cancel', close));
}
let renderedLocale: string | undefined;
function render(): void {
  if (composing) { deferredRender = true; return; }
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusKey = focused?.dataset.focus, from = focused?.selectionStart, to = focused?.selectionEnd;
  document.documentElement.lang = store.locale;
  document.documentElement.dataset.theme = store.bridge.context.theme === 'dark' ? 'dark' : 'light';
  renderTop(); renderTree(); renderMain(); renderComments(); renderStatus(); updateDialog?.();
  if (renderedLocale !== store.locale) {
    renderedLocale = store.locale;
    document.querySelectorAll<HTMLElement>('[data-zh][data-en]').forEach(node => { node.textContent = store.locale === 'zh-CN' ? node.dataset.zh! : node.dataset.en!; });
  }
  if (focusKey && (!focused?.isConnected || document.activeElement !== focused)) {
    const next = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-focus]')].find(node => node.dataset.focus === focusKey);
    if (next) { next.focus({ preventScroll: true }); if (typeof from === 'number' && typeof to === 'number' && 'setSelectionRange' in next) { try { next.setSelectionRange(from, to); } catch {} } }
  }
}
store.onChange = render;
store.bridge.onContext = () => render();
window.addEventListener('beforeunload', event => { if (store.saveState !== 'saved' || store.unknown) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !activeDialog) { if (commentsPane.classList.contains('open')) closePanel(commentsPane); else if (treePane.classList.contains('open')) closePanel(treePane); }
});
treeBody.addEventListener('keydown', event => {
  const current = (event.target as HTMLElement).closest<HTMLButtonElement>('.tree-label');
  if (!current || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const entries = [...treeBody.querySelectorAll<HTMLButtonElement>('.tree-label')], index = entries.indexOf(current);
  if (event.key === 'ArrowDown') entries[Math.min(entries.length - 1, index + 1)]?.focus();
  if (event.key === 'ArrowUp') entries[Math.max(0, index - 1)]?.focus();
  if (event.key === 'Home') entries[0]?.focus();
  if (event.key === 'End') entries.at(-1)?.focus();
  if (event.key === 'ArrowRight' && current.dataset.targetType === 'directory') {
    if (!store.navigation.expanded.includes(current.dataset.path!)) { store.navigation.expanded = [...store.navigation.expanded, current.dataset.path!]; store.touch(); renderTreeRows(); treeRows.get(targetKey({ type: 'directory', path: current.dataset.path! }))?.label.focus(); }
    else entries[index + 1]?.focus();
  }
  if (event.key === 'ArrowLeft') {
    const path = current.dataset.path!;
    const collapse = current.dataset.targetType === 'directory' && store.navigation.expanded.includes(path);
    if (collapse) { store.navigation.expanded = store.navigation.expanded.filter(item => item !== path); store.touch(); renderTreeRows(); }
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path;
    treeRows.get(targetKey({ type: collapse || parent !== path ? 'directory' : current.dataset.targetType as Target['type'], path: collapse ? path : parent }))?.label.focus();
  }
});
// The view owns this timer; it neither starts a watcher nor keeps the stdio process alive.
let refreshTimer: ReturnType<typeof setTimeout>, disposed = false;
async function pollWorkspace(): Promise<void> {
  if (document.visibilityState === 'visible' && store.workspace?.active && !composing && !activeDialog && !store.busy && !store.refreshing && !store.loadingDiff && !store.unknown && !store.stale && store.saveState === 'saved' && Date.now() >= store.nextRefreshAt && !document.activeElement?.matches('textarea,input')) await store.refresh().catch(() => {});
  if (!disposed) refreshTimer = setTimeout(() => { void pollWorkspace(); }, Math.max(5000, store.nextRefreshAt - Date.now()));
}
refreshTimer = setTimeout(() => { void pollWorkspace(); }, 5000);
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(refreshTimer); disposeDialog?.(); disposeDialog = undefined; store.bridge.destroy(); editor?.destroy(); });
render(); void run(() => store.connect());
