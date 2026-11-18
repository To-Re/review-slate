import * as vscode from 'vscode';
import * as path from 'node:path';
import { hash, ReviewBranch, Session } from './model';
import { ReviewView } from './review';

/** Read-only summary of another workspace repository's saved CRs. */
export interface RepositoryReviews { root: string; branch?: ReviewBranch; active?: string; sessions: Session[]; error?: string; loading?: boolean }
export interface RepositoryGroup extends RepositoryReviews { current: boolean; name: string; parent?: string }
export interface HistoryNode {
  id: string; review?: Session; children?: HistoryNode[]; purgePending?: boolean;
  /** Repository that owned this node when the grouped tree was rendered. */
  root?: string; repository?: RepositoryGroup; checkedOut?: ReviewBranch;
}
const recent = (active?: string) => (a: Session, b: Session): number => Number(b.id === active) - Number(a.id === active) ||
  (b.lastUsedAt || b.createdAt).localeCompare(a.lastUsedAt || a.createdAt) || a.id.localeCompare(b.id);

export class ReviewHistory implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  nodes: HistoryNode[] = [];
  private active?: string;
  private root?: string;
  private grouped = false;
  /** Renders a flat list for one repository, or one group per repository when others are supplied. */
  render(view: ReviewView, root?: string, others: RepositoryReviews[] = []): void {
    this.active = view.session?.id;
    const grouped = !!root && others.length > 0;
    this.root = root; this.grouped = grouped;
    const sessions = [...(view.sessions || [])].sort(recent(this.active));
    const pending = new Set(view.purgePending || []);
    // Tree item IDs must be unique across groups; migrated legacy IDs are not scoped by repository.
    // Every node records its repository so a stale node cannot act on another repository.
    const node = (review: Session): HistoryNode => ({ id: grouped ? hash(root!) + ':' + review.id : review.id, review, purgePending: pending.has(review.id), root });
    const own: HistoryNode[] = sessions.filter(s => !s.deletedAt).map(node);
    const deleted = sessions.filter(s => s.deletedAt && !pending.has(s.id)).map(node);
    if (deleted.length) own.push({ id: 'deleted', children: deleted });
    const incomplete = sessions.filter(s => pending.has(s.id)).map(node);
    if (incomplete.length) own.push({ id: 'purge-pending', children: incomplete });
    if (!grouped) { this.nodes = own; this.changed.fire(); return; }
    const summaries: (RepositoryReviews & { current: boolean })[] = [
      { root: root!, branch: view.branch, active: view.session?.id, sessions: view.sessions || [], error: view.error, loading: !view.branch && !view.error, current: true },
      ...others.filter(other => other.root !== root).map(other => ({ ...other, current: false }))
    ];
    const names = new Map<string, number>();
    for (const summary of summaries) names.set(path.basename(summary.root), (names.get(path.basename(summary.root)) || 0) + 1);
    this.nodes = summaries.map(summary => {
      const name = path.basename(summary.root);
      const repository: RepositoryGroup = { ...summary, name, parent: (names.get(name) || 0) > 1 ? path.basename(path.dirname(summary.root)) : undefined };
      const children = summary.current ? own : summary.sessions.filter(s => !s.deletedAt).sort(recent(summary.active)).map(review =>
        ({ id: hash(summary.root) + ':' + review.id, review, root: summary.root, checkedOut: summary.branch }));
      return { id: 'repository:' + hash(summary.root), repository, children };
    }).sort((a, b) => a.repository!.name.localeCompare(b.repository!.name) || a.repository!.root.localeCompare(b.repository!.root));
    this.changed.fire();
  }
  getChildren(node?: HistoryNode): HistoryNode[] { return node?.children || (node ? [] : [{ id: 'new-review' }, ...this.nodes]); }
  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.id === 'new-review') {
      const item = new vscode.TreeItem('新建审阅…', vscode.TreeItemCollapsibleState.None);
      item.id = node.id; item.iconPath = new vscode.ThemeIcon('add', new vscode.ThemeColor('codeReview.commentForeground'));
      item.description = this.grouped ? path.basename(this.root!) : undefined;
      item.tooltip = (this.grouped ? '在当前仓库 ' + path.basename(this.root!) + ' 新建。' : '') + '选择一个基点；不同基点的进度和评论分别保存。';
      item.command = { command: 'codeReview.newReview', title: '新建审阅' };
      return item;
    }
    if (node.repository) return this.repositoryItem(node, node.repository);
    const review = node.review;
    if (!review) {
      const item = new vscode.TreeItem(node.id === 'purge-pending' ? '删除未完成 · 可重试' : '已归档 · 可恢复', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id; item.description = String(node.children?.length || 0); item.iconPath = new vscode.ThemeIcon('archive');
      return item;
    }
    const other = !!node.root && node.root !== this.root;
    const current = !other && review.id === this.active;
    const item = new vscode.TreeItem(review.branch!.label + ' · ' + review.base.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = (node.purgePending ? '删除未完成 · ' : current ? '当前 · ' : '') + review.label;
    const details = '分支：' + review.branch!.label + '\n基点：' + review.label + '\n完整 SHA：' + review.base + '\n创建时间：' + review.createdAt;
    if (other) {
      const legacy = review.branch!.key.startsWith('legacy:'), elsewhere = node.checkedOut && !legacy && node.checkedOut.key !== review.branch!.key;
      item.tooltip = '仓库：' + node.root + '\n' + details + '\n点击切换到此仓库并打开这条 CR，不会切换 Git 分支。' +
        (legacy ? '\n旧版未记录所属分支；打开后归入该仓库当前分支' + (node.checkedOut ? ' ' + node.checkedOut.label : '') + '。' :
          elsewhere ? '\n该仓库当前在 ' + node.checkedOut!.label + '，需先切换到 ' + review.branch!.label + '。' : '');
      item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('codeReview.commentForeground'));
      item.contextValue = 'otherRepositoryReview';
      item.command = { command: 'codeReview.openReview', title: '打开审阅记录', arguments: [node] };
      return item;
    }
    item.tooltip = details + (node.purgePending ? '\n永久删除尚未完成，不能恢复。右键“永久删除”重试清理。' : review.deletedAt ? '\n已归档，可恢复；右键可永久删除。' :
      review.branch!.key.startsWith('legacy:') ? '\n旧版未记录所属分支；打开后归入当前分支。' : '\n只打开此分支的记录，不会切换 Git 分支。');
    item.iconPath = new vscode.ThemeIcon(review.deletedAt ? 'archive' : current ? 'pass-filled' : 'git-branch',
      new vscode.ThemeColor('codeReview.' + (current ? 'added' : 'comment') + 'Foreground'));
    item.contextValue = node.purgePending ? 'purgePendingReview' : review.deletedAt ? 'deletedReview' : 'savedReview';
    if (!review.deletedAt) item.command = { command: 'codeReview.openReview', title: '打开审阅记录', arguments: [node] };
    return item;
  }
  private repositoryItem(node: HistoryNode, repository: RepositoryGroup): vscode.TreeItem {
    const children = node.children?.length || 0, reviews = node.children?.filter(child => child.review).length || 0;
    const item = new vscode.TreeItem(repository.name, children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    const state = repository.loading ? '读取中…' : repository.error ? '读取失败' : [repository.branch?.label, reviews ? undefined : '暂无审阅'].filter(Boolean).join(' · ');
    item.description = [repository.current ? '当前仓库' : undefined, state || undefined, repository.parent].filter(Boolean).join(' · ');
    item.tooltip = repository.root + '\n' + (repository.current ? '正在查看此仓库的 CR。' :
      '点击其中的记录可切换到此仓库并打开；右侧按钮切换到此仓库，打开当前分支的 CR。') + (repository.error ? '\n读取失败：' + repository.error : '');
    item.iconPath = new vscode.ThemeIcon('repo', repository.current ? new vscode.ThemeColor('codeReview.addedForeground') : undefined);
    item.contextValue = repository.current ? 'currentReviewRepository' : 'reviewRepository';
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}
