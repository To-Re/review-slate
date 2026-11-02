import * as vscode from 'vscode';
import * as path from 'node:path';
import { Anchor, anchorFor, locate } from './anchors';
import { baselineOptions } from './baselines';
import { noteStatus, replyMatches, sameTarget } from './comments';
import { GitRepository } from './git';
import { handoffText } from './handoff';
import { HistoryNode, ReviewHistory } from './history';
import { decode, DefaultBase, hash, isCommit, isNotes, LegacyComparison, messageOf, Pair, snapshotId, snapshotText } from './model';
import { CommentPanel, PanelMessage } from './panel';
import { ReviewService, Selection } from './review';
import { filesIn, markRequest, ReviewTree, TreeNode } from './tree';

interface DocumentData { selection: Selection; side: 'left' | 'right'; text: string; full: boolean; root: string; live?: boolean }

export class ReviewExtension implements vscode.Disposable {
  service?: ReviewService;
  readonly tree = new ReviewTree();
  readonly history = new ReviewHistory();
  readonly historyView: vscode.TreeView<HistoryNode>;
  readonly panel: CommentPanel;
  readonly view: vscode.TreeView<TreeNode>;
  private readonly listeners: vscode.Disposable[] = [];
  private readonly documents = new Map<string, DocumentData>();
  private readonly documentChanged = new vscode.EventEmitter<vscode.Uri>();
  private selected?: Selection;
  private overview?: string;
  private anchor?: Anchor;
  private renderedDirty = '';
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private disposed = false;
  private activeTab?: vscode.Tab;
  private activeTabInput?: unknown;
  private activeTabGroup?: vscode.TabGroup;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly ready: Promise<void>;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = new CommentPanel(context.extensionPath, message => {
      void this.enqueue(async () => {
        try { await this.panelAction(message); this.panel.acknowledge(message.requestId); }
        catch (error) { this.panel.acknowledge(message.requestId, messageOf(error)); throw error; }
      });
    });
    this.view = vscode.window.createTreeView('codeReview.files', { treeDataProvider: this.tree, manageCheckboxStateManually: true, showCollapseAll: false });
    this.historyView = vscode.window.createTreeView('codeReview.reviews', { treeDataProvider: this.history });
    this.listeners.push(this.view, this.tree, this.panel, this.historyView, this.history, this.documentChanged,
      vscode.window.registerFileDecorationProvider(this.tree),
      vscode.window.registerWebviewViewProvider('codeReview.comments', this.panel),
      vscode.workspace.registerTextDocumentContentProvider('code-review', {
        onDidChange: this.documentChanged.event,
        provideTextDocumentContent: uri => {
          const entry = this.documents.get(uri.toString());
          if (!entry) throw new Error('请从 ReviewSlate 文件树重新打开 Diff');
          return entry.text;
        }
      }));
    const commands: Record<string, (node?: TreeNode) => Promise<void>> = {
      configure: () => this.configure(), defaultBase: () => this.configure(true), repository: () => this.selectRepository(true),
      copyBase: node => this.copyBase(node),
      expandAll: () => this.tree.expandAll(this.view),
      collapseAll: async () => { await vscode.commands.executeCommand('workbench.actions.treeView.codeReview.files.collapseAll'); },
      refresh: () => this.refresh(), open: node => this.open(node), comment: node => this.open(node),
      commentDirectory: node => this.openDirectory(node),
      since: node => this.open(node, true),
      mark: node => this.mark(node, true), unmark: node => this.mark(node, false),
      commentSelection: () => this.selectCode(), handoff: () => this.handoff(), pending: () => this.showPending()
    };
    for (const [name, handler] of Object.entries(commands)) {
      this.listeners.push(vscode.commands.registerCommand('codeReview.' + name, (node?: TreeNode) => this.enqueue(() => handler(node))));
    }
    this.listeners.push(vscode.commands.registerCommand('codeReview.fromCommit', (sourceControl: unknown, commit: unknown) =>
      this.enqueue(() => this.fromCommit(sourceControl, commit))));
    for (const action of ['openReview', 'deleteReview', 'restoreReview', 'purgeReview'] as const) {
      this.listeners.push(vscode.commands.registerCommand('codeReview.' + action, (node?: HistoryNode) => this.enqueue(async () => {
        if (!this.service || !node?.review) throw new Error('请先选择一条审阅记录');
        if (action === 'purgeReview') { await this.purgeReview(node); return; }
        if (action === 'openReview') await this.service.openReview(node.review.id);
        else await this.service.deleteReview(node.review.id, action === 'deleteReview');
        await this.refresh();
        if (action === 'deleteReview') void vscode.window.showInformationMessage('已归档这条 CR，可在审阅记录的「已归档」中恢复。');
      })));
    }
    this.listeners.push(this.view.onDidChangeCheckboxState(event => {
      void this.enqueue(async () => {
        const folders = event.items.filter(([node]) => node.kind === 'folder');
        const items = event.items.filter(([node]) => !folders.some(([folder]) => node !== folder && node.path?.startsWith((folder.path || '') + '/')));
        for (const [node, state] of items) await this.mark(node, state === vscode.TreeItemCheckboxState.Checked);
      });
    }));
    this.listeners.push(this.view.onDidChangeVisibility(event => { if (event.visible && !this.pending) void this.enqueue(() => this.refresh(), false); }));
    this.listeners.push(this.historyView.onDidChangeVisibility(event => { if (event.visible && !this.pending) void this.enqueue(() => this.refresh(), false); }));
    this.listeners.push(vscode.workspace.onDidSaveTextDocument(() => { if (this.service) void this.enqueue(() => this.refresh(), false); }));
    this.listeners.push(vscode.workspace.onDidChangeTextDocument(() => {
      if (JSON.stringify([...this.dirtyFiles()].sort()) !== this.renderedDirty) this.render();
    }));
    this.listeners.push(vscode.workspace.onDidCloseTextDocument(document => this.documents.delete(document.uri.toString())));
    this.listeners.push(vscode.window.onDidChangeActiveTextEditor(editor => this.activeEditorChanged(editor)));
    const tabs = vscode.window.tabGroups;
    if (tabs) this.listeners.push(
      tabs.onDidChangeTabs(() => this.activeTabChanged()),
      tabs.onDidChangeTabGroups(() => this.activeTabChanged())
    );
    this.timer = setInterval(() => {
      if (!this.pending && (this.view.visible || this.historyView.visible) && this.service) void this.enqueue(() => this.refresh(), false);
    }, 5000);
    this.ready = this.enqueue(() => this.selectRepository(false), false);
  }
  whenIdle(): Promise<void> { return this.tail; }
  private enqueue(action: () => Promise<void>, notify = true): Promise<void> {
    this.pending++;
    const task = this.tail.then(async () => {
      if (this.disposed) return;
      try { await action(); this.render(); }
      catch (error) {
        const text = messageOf(error);
        this.render(text);
        if (notify) void vscode.window.showErrorMessage('ReviewSlate：' + text);
      }
    }).finally(() => { this.pending--; });
    this.tail = task.catch(() => {});
    return task;
  }
  private async repositories(): Promise<GitRepository[]> {
    const folders = new Set((vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath));
    const builtIn = vscode.extensions.getExtension('vscode.git');
    if (builtIn) {
      try {
        const api = (await builtIn.activate()).getAPI(1);
        for (const repository of api.repositories || []) folders.add(repository.rootUri.fsPath);
      } catch { /* workspace-folder discovery remains available */ }
    }
    const result = new Map<string, GitRepository>();
    for (const folder of folders) {
      try { const repo = await GitRepository.open(folder); result.set(repo.root, repo); }
      catch { /* an editor workspace folder can be outside Git */ }
    }
    return [...result.values()];
  }
  private async selectRepository(prompt: boolean): Promise<void> {
    const repositories = await this.repositories();
    if (!repositories.length) {
      this.service = undefined; this.selected = undefined; this.anchor = undefined;
      this.view.message = '请打开包含提交的 Git 仓库'; return;
    }
    const last = this.context.workspaceState.get<string>('selectedRepository');
    const selected = prompt ? await vscode.window.showQuickPick(repositories.map(repo => ({ label: path.basename(repo.root), description: repo.root, repo })), { title: '选择仓库' }) :
      { repo: repositories.find(repo => repo.root === last) || repositories[0] };
    if (!selected) return;
    this.service = new ReviewService(selected.repo, this.context.globalStorageUri.fsPath);
    this.selected = undefined; this.anchor = undefined;
    await this.context.workspaceState.update('selectedRepository', selected.repo.root);
    try {
      await this.service.start(this.context.globalState.get<LegacyComparison>('comparison:' + hash(selected.repo.root)));
    } catch (error) {
      this.service.view.error = messageOf(error); throw error;
    }
  }
  private async refresh(): Promise<void> {
    if (!this.service) { await this.selectRepository(false); return; }
    await this.service.refresh();
    if (this.selected?.session.id !== this.service.view.session?.id) { this.selected = undefined; this.anchor = undefined; }
    if (this.selected && !this.anchor && this.selected.target !== 'directory') {
      const row = this.service.view.files.find(file => file.path === this.selected!.file);
      if (!row?.error) this.selected = row ? this.service.selection(row.path) : await this.service.capture(this.selected.file);
    }
  }
  private entryFor(uri: vscode.Uri): DocumentData | undefined {
    let entry = this.documents.get(uri.toString());
    const input = vscode.window.tabGroups?.activeTabGroup.activeTab?.input;
    if (input && input instanceof vscode.TabInputTextDiff) {
      const original = this.documents.get(input.original.toString());
      if (!original) return;
      if (uri.toString() === input.original.toString()) entry = original;
      else if (uri.toString() === input.modified.toString() && entry) {
        // Editable right panes share a file URI across reviews. The tab's
        // immutable original URI determines which review the user is seeing.
        entry = { ...entry, selection: original.selection, root: original.root, full: original.full && entry.full };
      } else return;
    }
    return entry?.root === this.service?.repo.root && entry?.selection.session.id === this.service?.view.session?.id ? entry : undefined;
  }
  private activeTabChanged(): void {
    const group = vscode.window.tabGroups?.activeTabGroup, tab = group?.activeTab;
    // Pin/dirty/preview changes do not navigate away from a comment draft or
    // the pending overview. Only an actual tab or group switch changes scope.
    if (tab === this.activeTab && tab?.input === this.activeTabInput && group === this.activeTabGroup) return;
    this.activeEditorChanged(vscode.window.activeTextEditor);
  }
  private activeEditorChanged(editor: vscode.TextEditor | undefined): void {
    this.activeTabGroup = vscode.window.tabGroups?.activeTabGroup;
    this.activeTab = this.activeTabGroup?.activeTab;
    this.activeTabInput = this.activeTab?.input;
    const entry = editor && this.entryFor(editor.document.uri);
    void vscode.commands.executeCommand('setContext', 'codeReview.commentable', !!entry?.full);
    if (entry) {
      if (entry.live && this.service?.view.files.some(file => file.path === entry.selection.file && !file.error)) entry.selection = this.service.selection(entry.selection.file);
      if (this.selected?.key !== entry.selection.key) this.anchor = undefined;
      this.selected = entry.selection; this.overview = undefined; this.renderPanel();
    } else {
      const input = vscode.window.tabGroups?.activeTabGroup.activeTab?.input;
      if (editor && input && input instanceof vscode.TabInputTextDiff) {
        this.selected = undefined; this.anchor = undefined; this.overview = undefined;
        this.renderPanel(this.documents.has(input.original.toString()) ? '此 Diff 不属于当前审阅，请从变更文件重新打开。' : undefined);
      }
    }
  }
  private dirtyFiles(): Set<string> {
    const result = new Set<string>(), root = this.service?.repo.root;
    if (!root) return result;
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || !['file', 'vscode-remote'].includes(document.uri.scheme)) continue;
      const relative = path.relative(root, document.uri.fsPath).split(path.sep).join('/');
      if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) && !isNotes(relative)) result.add(relative);
    }
    return result;
  }
  private async pickCommit(service: ReviewService): Promise<DefaultBase | undefined> {
    const items: (vscode.QuickPickItem & { oid?: string })[] = (await service.repo.commits()).map(commit => ({
      label: commit.oid.slice(0, 8) + '  ' + commit.subject, description: commit.date, oid: commit.oid
    }));
    items.push({ label: '输入其他提交 SHA…', alwaysShow: true });
    const commit = await vscode.window.showQuickPick(items, { title: '选择基点提交', placeHolder: '搜索提交说明或 SHA', matchOnDescription: true });
    if (!commit) return;
    const typed = commit.oid || await vscode.window.showInputBox({ title: '输入基点提交 SHA', prompt: '输入完整或简短的 commit SHA' });
    if (!typed) return;
    if (!/^[a-fA-F0-9]{7,64}$/.test(typed.trim())) throw new Error('请输入有效的提交 SHA');
    const ref = await service.repo.resolve(typed.trim());
    return { kind: 'commit', ref, label: ref.slice(0, 10) };
  }
  private async configure(setDefault = false): Promise<void> {
    if (!this.service) await this.selectRepository(false);
    const service = this.service;
    if (!service) return;
    const references = await service.repo.mainReferences(), saved = await service.state.defaultBase();
    const choice = await vscode.window.showQuickPick(baselineOptions(references, saved, setDefault), {
      title: setDefault ? '设置本仓库默认基点' : '选择基点',
      placeHolder: setDefault ? '只设置此仓库的默认来源，当前审阅继续使用已固定的 commit' : '选好后固定不变，右侧始终为当前分支＋工作区'
    });
    if (!choice) return;
    const source = choice.chooseCommit ? await this.pickCommit(service) : choice.source;
    if (!source) return;
    if (setDefault) {
      await service.repo.resolve(source.ref);
      await service.state.setDefaultBase(source);
      void vscode.window.showInformationMessage('已将 ' + source.label + ' 设为本仓库默认基点。当前审阅的 commit 保持固定。');
      return;
    }
    const base = source.kind === 'branch' ? await service.repo.forkPoint(source.ref) : await service.repo.resolve(source.ref);
    await service.choose(base, source.kind === 'branch' ? source.label + ' 的分叉基点' : '指定提交');
    this.selected = undefined; this.anchor = undefined;
  }
  private async fromCommit(sourceControl: unknown, historyItem: unknown): Promise<void> {
    const source = sourceControl as { id?: string; rootUri?: { scheme?: string; fsPath?: string } } | undefined;
    const item = historyItem as { id?: string } | undefined;
    const root = source?.rootUri?.fsPath, commit = item?.id;
    if (source?.id !== 'git' || !root || !path.isAbsolute(root) ||
        !['file', 'vscode-remote'].includes(source.rootUri?.scheme || '') || typeof commit !== 'string' || !isCommit(commit)) {
      throw new Error('请在 Git 图形中右键一个真实提交，再选择“以此提交为基点创建 CR”');
    }
    const selected = await GitRepository.open(root);
    if (!(await this.repositories()).some(repo => repo.root === selected.root)) throw new Error('该提交所属仓库不在当前工作区，请先打开它');
    const base = await selected.resolve(commit);
    const service = this.service?.repo.root === selected.root ? this.service : new ReviewService(selected, this.context.globalStorageUri.fsPath);
    if (service !== this.service) await service.start(this.context.globalState.get<LegacyComparison>('comparison:' + hash(selected.root)));
    await service.choose(base, 'Git 图形选中的提交');
    this.service = service; this.selected = undefined; this.anchor = undefined;
    await this.context.workspaceState.update('selectedRepository', selected.root);
    await vscode.commands.executeCommand('codeReview.files.focus');
  }
  private async purgeReview(node: HistoryNode): Promise<void> {
    const service = this.service, session = node.review;
    if (!service || !session) throw new Error('请先选择一条审阅记录');
    const confirm = await vscode.window.showWarningMessage('永久删除这条 CR？', {
      modal: true,
      detail: '仓库：' + service.repo.root + '\n分支：' + session.branch!.label + '\n固定基点：' + session.base +
        '\n\n将永久清理这轮 CR 保存的已审记录、快照、评论和 Agent 回复，不能恢复。项目代码和其他 CR 保留。'
    }, '永久删除');
    if (confirm !== '永久删除') return;
    const result = await service.purgeReview(session.id);
    const keys = new Set(this.context.workspaceState.get<string[]>('discardedReviewDrafts') || []);
    const targets = new Map(result.targets.map(target => [target.target + ':' + target.path, target]));
    for (const target of result.targets) {
      const pieces = target.path.split('/');
      for (let i = 1; i < pieces.length; i++) {
        const directory = pieces.slice(0, i).join('/');
        targets.set('directory:' + directory, { path: directory, target: 'directory' });
      }
    }
    for (const target of targets.values()) {
      const suffix = (target.target === 'directory' ? '\0directory' : '') + '\0' + target.path;
      keys.add(hash(service.repo.root + '\0' + result.session.id + suffix));
      if (result.session.commentScopes?.length) keys.add(hash(service.repo.root + suffix));
    }
    await this.context.workspaceState.update('discardedReviewDrafts', [...keys]);
    if (this.selected?.session.id === session.id) { this.selected = undefined; this.anchor = undefined; }
    for (const [uri, entry] of this.documents) if (entry.root === service.repo.root && entry.selection.session.id === session.id) this.documents.delete(uri);
    await this.refresh();
    void vscode.window.showInformationMessage('已永久删除这条 CR。');
  }
  private render(error?: string): void {
    const active = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'codeReview.commentable', !!(active && this.entryFor(active.document.uri)?.full));
    const service = this.service;
    const dirty = this.dirtyFiles();
    this.renderedDirty = JSON.stringify([...dirty].sort());
    if (!service) {
      this.tree.render({ files: [], notes: { comments: [], replies: new Map() } });
      this.history.render({ files: [], notes: { comments: [], replies: new Map() } });
      this.historyView.description = undefined;
      this.view.description = undefined; this.view.badge = undefined;
      this.renderPanel(error); return;
    }
    const data = service.view;
    this.tree.render(data, dirty);
    this.history.render(data);
    this.historyView.description = data.branch?.label;
    this.view.description = path.basename(service.repo.root) + (data.branch ? ' · ' + data.branch.label : '');
    const changes = data.files.filter(file => !file.commentOnly), reviewed = changes.filter(file => file.status === 'reviewed' && !file.error && !dirty.has(file.path)).length;
    this.view.message = data.error ? '读取失败，已有数据保留' : data.session ? reviewed + '/' + changes.length + ' 已审 · 保存后的工作区' : undefined;
    this.view.badge = !data.error && changes.length > reviewed ? { value: changes.length - reviewed, tooltip: '待审文件' } : undefined;
    this.renderPanel(error);
  }
  private renderPanel(error?: string): void {
    const data = this.service?.view, selection = this.selected;
    const overview = !!this.overview && this.overview === this.pendingKey();
    const targets = new Map<string, { path: string; target?: 'directory'; label: string; pending: number; resolved: number }>();
    if (!overview && selection?.target === 'directory') for (const comment of data?.notes.comments || []) {
      if (!comment.path.startsWith(selection.file + '/')) continue;
      const key = (comment.target || 'file') + ':' + comment.path;
      const target = targets.get(key) || { path: comment.path, target: comment.target === 'directory' ? 'directory' as const : undefined,
        label: comment.path.slice(selection.file.length + 1) + (comment.target === 'directory' ? '/' : ''), pending: 0, resolved: 0 };
      if (comment.state === 'open') target.pending++; else target.resolved++;
      targets.set(key, target);
    }
    const current = data?.files.find(file => file.path === selection?.file);
    const labels = { file: '文件评论', exact: '原位置', moved: '已跟随行号变化', changed: '相关代码已变化', unavailable: '位置待确认' };
    this.panel.render({
      repositoryKey: this.service ? hash(this.service.repo.root) : undefined,
      reviewId: data?.session?.id, reviewIds: data?.sessions?.filter(session => !data.purgePending?.includes(session.id)).map(session => session.id),
      discardDraftKeys: this.context.workspaceState.get<string[]>('discardedReviewDrafts'),
      key: data?.error ? undefined : overview ? this.overview : selection?.key,
      draftKey: overview ? this.overview : selection?.draftKey, legacyDraftKey: overview ? undefined : selection?.legacyDraftKey,
      overview, targets: [...targets.values()].sort((a, b) => Number(b.pending > 0) - Number(a.pending > 0) || a.label.localeCompare(b.label)),
      file: overview ? '待处理评论' : selection ? selection.file + (selection.target === 'directory' ? '/' : '') : undefined, target: overview ? undefined : selection?.target,
      pending: data?.notes.comments.filter(comment => comment.state === 'open').length || 0,
      error: error || data?.error,
      anchor: this.anchor ? (this.anchor.side === 'left' ? '基点' : '工作区') + '侧 ' + (this.anchor.start + 1) + '–' + (this.anchor.end + 1) + ' 行' : undefined,
      quote: this.anchor?.selected.join('\n'),
      deleted: overview ? [] : (data?.notes.deleted || []).filter(comment => sameTarget(comment, selection?.file, selection?.target)).map(({ id, revision, body }) => ({ id, revision, body })),
      cards: (data?.notes.comments || []).filter(comment => overview ? comment.state === 'open' : sameTarget(comment, selection?.file, selection?.target))
        .sort((a, b) => overview ? a.path.localeCompare(b.path) || (a.target || 'file').localeCompare(b.target || 'file') || a.createdAt.localeCompare(b.createdAt) : 0).map(comment => {
        const row = overview ? data?.files.find(file => file.path === comment.path) : current;
        const location = locate(comment.anchor, row?.error ? undefined : row), reply = data?.notes.replies.get(comment.id);
        return {
          id: comment.id, revision: comment.revision, body: comment.body, status: noteStatus(comment, reply),
          targetLabel: overview ? comment.path + (comment.target === 'directory' ? '/' : '') : undefined,
          resolved: comment.state === 'resolved',
          location: comment.target === 'directory' ? '目录评论' : labels[location.kind] + (location.start !== undefined ? ' · ' + (location.start + 1) + '–' + (location.end! + 1) + ' 行' : ''),
          quote: comment.anchor?.selected.join('\n'),
          reply: reply ? (replyMatches(comment, reply) ? '' : '旧版本回复：\n') + reply.body : undefined,
          canLocate: location.start !== undefined
        };
      })
    });
  }
  private async mark(node: TreeNode | undefined, checked: boolean): Promise<void> {
    const service = this.service;
    if (!service?.view.session) throw new Error('请先选择基点');
    const root: TreeNode = node || { kind: 'folder', id: 'root', label: '', path: '', session: service.view.session.id, children: this.tree.nodes };
    if (!filesIn(root).length) return;
    const request = markRequest(root, checked);
    const guard = (): void => {
      if (!checked) return;
      const dirty = [...this.dirtyFiles()].find(file => request.directory !== undefined ? (!request.directory || file.startsWith(request.directory + '/')) : request.files.some(item => item.path === file));
      if (dirty) throw new Error(dirty + ' 有未保存修改，请先保存并查看最新 Diff，再标记已审');
    };
    guard(); await service.mark(request, guard);
  }
  private document(selection: Selection, snapshot: Pair, side: 'left' | 'right', full: boolean, metadata: boolean): vscode.Uri {
    const root = this.service!.repo.root;
    const identity = hash(root + '\0' + selection.session.id + '\0' + (full ? 'full' : 'since') + '\0' + side);
    const uri = vscode.Uri.from({ scheme: 'code-review', authority: identity, path: '/' + selection.file });
    const previous = this.documents.get(uri.toString()), text = snapshotText(snapshot[side], metadata);
    this.documents.set(uri.toString(), { selection, side, full: full && !metadata, text, root });
    if (previous && previous.text !== text) this.documentChanged.fire(uri);
    return uri;
  }
  private async workingDocument(selection: Selection): Promise<vscode.Uri | undefined> {
    const file = await this.service!.repo.editablePath(selection.file, selection.pair.right);
    if (!file) return;
    const uri = vscode.Uri.file(file);
    this.documents.set(uri.toString(), { selection, side: 'right', full: true, live: true, root: this.service!.repo.root, text: snapshotText(selection.pair.right) });
    return uri;
  }
  private async showDiff(selection: Selection, pair: Pair, title: string, full = true): Promise<void> {
    const metadata = pair.left.mode !== pair.right.mode && pair.left.data.equals(pair.right.data);
    const left = this.document(selection, pair, 'left', full, metadata);
    const right = (full && !metadata ? await this.workingDocument(selection) : undefined) || this.document(selection, pair, 'right', full, metadata);
    await vscode.commands.executeCommand('vscode.diff', left, right, title + ' · ' + selection.file, { preview: true });
    void vscode.commands.executeCommand('setContext', 'codeReview.commentable', full && !metadata);
  }
  private async open(node?: TreeNode, since = false): Promise<void> {
    if (node?.kind === 'folder') { await this.openDirectory(node); return; }
    if (!node?.path || !this.service) { void vscode.window.showInformationMessage('请先点击一个文件'); return; }
    await this.refresh();
    const selected = this.service.selection(node.path);
    this.selected = selected; this.anchor = undefined; this.overview = undefined;
    this.renderPanel(); this.panel.show();
    if (!since) { await this.showDiff(selected, selected.pair, '基点 → 当前工作区'); return; }
    const previous = await this.service.previous(node.path);
    if (!previous) { void vscode.window.showInformationMessage('此文件还没有已审快照'); return; }
    const sides = (['right', 'left'] as const).filter(side => snapshotId(previous[side]) !== snapshotId(selected.pair[side]));
    if (!sides.length) { void vscode.window.showInformationMessage('上次审阅后文件没有变化'); return; }
    const choice = sides.length === 1 ? sides[0] : (await vscode.window.showQuickPick(sides.map(side => ({ label: side === 'right' ? '工作区的变化' : '基点的变化', side })), { title: '查看哪一侧的变化' }))?.side;
    if (choice) await this.showDiff(selected, { left: previous[choice], right: selected.pair[choice] }, '上次已审 → 现在', false);
  }
  private async openDirectory(node?: TreeNode): Promise<void> {
    if (node?.kind !== 'folder' || !node.path || !this.service) throw new Error('请先选择一个目录');
    await this.refresh();
    this.selected = this.service.directorySelection(node.path); this.anchor = undefined; this.overview = undefined;
    this.renderPanel(); this.panel.show();
  }
  private async selectCode(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const entry = editor && this.entryFor(editor.document.uri);
    if (!entry || !entry.full) throw new Error('请在本工具的完整 Diff 中选中代码，再添加评论');
    const selection = editor!.selection;
    if (selection.isEmpty) throw new Error('请先选中代码');
    if (entry.live) {
      if (editor!.document.isDirty) throw new Error('请先保存代码修改，再选中代码添加评论');
      await this.refresh();
      if (!this.entryFor(editor!.document.uri)) throw new Error('基点已改变，请重新打开 Diff 后再评论');
      const current = await this.service!.capture(entry.selection.file);
      const normalize = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      if (editor!.document.isDirty || !await this.service!.repo.editablePath(current.file, current.pair.right) ||
          normalize(editor!.document.getText()) !== normalize(decode(current.pair.right.data))) throw new Error('编辑器与已保存文件不一致，请保存或重新打开 Diff 后再评论');
      entry.selection = current;
    }
    const end = selection.end.line > selection.start.line && selection.end.character === 0 ? selection.end.line - 1 : selection.end.line;
    this.selected = entry.selection; this.overview = undefined;
    this.anchor = anchorFor(entry.selection.pair[entry.side], entry.side, selection.start.line, end);
    this.panel.show(); this.renderPanel();
  }
  private async panelAction(message: PanelMessage): Promise<void> {
    if (message.action === 'handoff') return this.handoff();
    if (message.action === 'pending') return this.showPending();
    if (message.action === 'selection') {
      if (this.selected?.target === 'directory') throw new Error('目录评论不绑定代码行，请先打开需要评论的文件');
      return this.selectCode();
    }
    const overview = !!this.overview && this.overview === this.pendingKey() && message.key === this.overview;
    if (!this.service || (!overview && (!this.selected || message.key !== this.selected.key))) throw new Error('当前评论对象已切换，草稿已保留');
    const service = this.service, selected = this.selected;
    const session = overview ? service.view.session! : selected!.session;
    await service.assertCurrent(session);
    const guard = (): Promise<void> => service.assertCurrent(session);
    if (message.action === 'openTarget') {
      await this.refresh(); await guard();
      const comment = service.view.notes.comments.find(item => message.id ? item.id === message.id : sameTarget(item, message.path, message.target));
      if (!comment || (!overview && (selected?.target !== 'directory' || !comment.path.startsWith(selected.file + '/')))) throw new Error('该评论位置已变化，请刷新后重试');
      const target = comment.target === 'directory' ? 'directory' : undefined;
      const node = this.tree.findTarget(comment.path, target);
      if (!node || node.session !== session.id) throw new Error('该评论位置已变化，请刷新后重试');
      if (comment.target === 'directory') await this.openDirectory(node); else await this.open(node);
      const current = this.tree.findTarget(comment.path, target);
      if (current?.session === session.id) await this.view.reveal(current, { select: true, focus: true });
      return;
    }
    if (overview && ['add', 'clear', 'restore'].includes(message.action)) throw new Error('请先打开具体文件或目录再操作');
    if (message.action === 'delete' || message.action === 'restore') {
      const notes = this.service.view.notes;
      const target = [...notes.comments, ...(notes.deleted || [])].find(item => item.id === message.id && (overview || sameTarget(item, selected?.file, selected?.target)));
      if (!target) throw new Error('评论不存在，请刷新');
      if (message.action === 'delete') await this.service.comments.remove(target.id, message.revision || '', guard);
      else await this.service.comments.restore(target.id, message.revision || '', guard);
      await this.refresh(); return;
    }
    if (message.action === 'clear') { this.anchor = undefined; return; }
    if (message.action === 'add') {
      await this.service.add(selected!, message.body || '', this.anchor, message.requestId);
      this.anchor = undefined; return;
    }
    const comment = this.service.view.notes.comments.find(item => item.id === message.id && (overview || sameTarget(item, selected?.file, selected?.target)));
    if (!comment) throw new Error('评论不存在，请刷新');
    if (message.action === 'locate') {
      await this.refresh();
      const current = this.service.view.files.find(file => file.path === comment.path);
      const position = locate(comment.anchor, current?.error ? undefined : current);
      if (!comment.anchor || position.start === undefined || !current) throw new Error('位置待确认，请结合原片段检查');
      const selected = this.service.selection(comment.path);
      const uri = (comment.anchor.side === 'right' && !this.dirtyFiles().has(selected.file) ? await this.workingDocument(selected) : undefined) || this.document(selected, current, comment.anchor.side, true, false);
      await vscode.window.showTextDocument(uri, { preview: false, selection: new vscode.Range(position.start, 0, position.end! + 1, 0) });
      return;
    }
    await this.service.comments.update(comment.id, message.revision || '', message.action === 'edit' ? { body: message.body || '' } : { state: message.action === 'resolve' ? 'resolved' : 'open' }, guard);
    await this.refresh();
  }
  private async handoff(): Promise<void> {
    if (!this.service) throw new Error('请先打开 Git 仓库');
    await this.refresh();
    const { session, notes } = this.service.view;
    if (!session || !notes.comments.some(comment => comment.state === 'open')) { void vscode.window.showInformationMessage('当前 CR 没有未解决的评论'); return; }
    await this.service.assertCurrent(session);
    await vscode.env.clipboard.writeText(handoffText(this.service.repo.root, vscode.env.remoteName, session));
    void vscode.window.showInformationMessage('已复制，粘贴给你使用的 Agent 即可');
  }
  private async copyBase(node?: TreeNode): Promise<void> {
    const base = node?.base || this.service?.view.session?.base;
    if (!isCommit(base)) throw new Error('请先选择对比起点');
    await vscode.env.clipboard.writeText(base);
    void vscode.window.showInformationMessage('已复制对比起点的完整 commit SHA');
  }
  private async showPending(): Promise<void> {
    if (!this.service) throw new Error('请先打开 Git 仓库');
    await this.refresh();
    const { session } = this.service.view;
    if (!session) throw new Error('请先选择一轮 CR');
    await this.service.assertCurrent(session);
    this.overview = this.pendingKey(); this.selected = undefined; this.anchor = undefined;
    this.renderPanel(); this.panel.show();
  }
  private pendingKey(): string | undefined {
    const session = this.service?.view.session;
    return session ? hash(this.service!.repo.root + '\0' + session.id + '\0pending-comments') : undefined;
  }
  dispose(): void {
    this.disposed = true; clearInterval(this.timer);
    this.listeners.forEach(listener => listener.dispose()); this.documents.clear();
  }
}
export function activate(context: vscode.ExtensionContext): unknown {
  if (!vscode.workspace.isTrusted) return;
  const app = new ReviewExtension(context); context.subscriptions.push(app);
  return context.extensionMode === vscode.ExtensionMode.Test ? app : undefined;
}
export function deactivate(): void {}
