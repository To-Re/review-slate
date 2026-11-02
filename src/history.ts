import * as vscode from 'vscode';
import { Session } from './model';
import { ReviewView } from './review';

export interface HistoryNode { id: string; review?: Session; children?: HistoryNode[]; purgePending?: boolean }
export class ReviewHistory implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  nodes: HistoryNode[] = [];
  private active?: string;
  render(view: ReviewView): void {
    this.active = view.session?.id;
    const sessions = [...(view.sessions || [])].sort((a, b) => Number(b.id === this.active) - Number(a.id === this.active) ||
      (b.lastUsedAt || b.createdAt).localeCompare(a.lastUsedAt || a.createdAt) || a.id.localeCompare(b.id));
    const pending = new Set(view.purgePending || []);
    const node = (review: Session): HistoryNode => ({ id: review.id, review, purgePending: pending.has(review.id) });
    this.nodes = sessions.filter(s => !s.deletedAt).map(node);
    const deleted = sessions.filter(s => s.deletedAt && !pending.has(s.id)).map(node);
    if (deleted.length) this.nodes.push({ id: 'deleted', children: deleted });
    const incomplete = sessions.filter(s => pending.has(s.id)).map(node);
    if (incomplete.length) this.nodes.push({ id: 'purge-pending', children: incomplete });
    this.changed.fire();
  }
  getChildren(node?: HistoryNode): HistoryNode[] { return node?.children || (node ? [] : [{ id: 'new-review' }, ...this.nodes]); }
  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.id === 'new-review') {
      const item = new vscode.TreeItem('新建审阅…', vscode.TreeItemCollapsibleState.None);
      item.id = node.id; item.iconPath = new vscode.ThemeIcon('add', new vscode.ThemeColor('codeReview.commentForeground'));
      item.tooltip = '选择一个基点；不同基点的进度和评论分别保存。';
      item.command = { command: 'codeReview.newReview', title: '新建审阅' };
      return item;
    }
    const review = node.review;
    if (!review) {
      const item = new vscode.TreeItem(node.id === 'purge-pending' ? '删除未完成 · 可重试' : '已归档 · 可恢复', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id; item.description = String(node.children?.length || 0); item.iconPath = new vscode.ThemeIcon('archive');
      return item;
    }
    const current = review.id === this.active;
    const item = new vscode.TreeItem(review.branch!.label + ' · ' + review.base.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    item.id = review.id;
    item.description = (node.purgePending ? '删除未完成 · ' : current ? '当前 · ' : '') + review.label;
    item.tooltip = '分支：' + review.branch!.label + '\n基点：' + review.label + '\n完整 SHA：' + review.base +
      '\n创建时间：' + review.createdAt + (node.purgePending ? '\n永久删除尚未完成，不能恢复。右键“永久删除”重试清理。' : review.deletedAt ? '\n已归档，可恢复；右键可永久删除。' :
        review.branch!.key.startsWith('legacy:') ? '\n旧版未记录所属分支；打开后归入当前分支。' : '\n只打开此分支的记录，不会切换 Git 分支。');
    item.iconPath = new vscode.ThemeIcon(review.deletedAt ? 'archive' : current ? 'pass-filled' : 'git-branch',
      new vscode.ThemeColor('codeReview.' + (current ? 'added' : 'comment') + 'Foreground'));
    item.contextValue = node.purgePending ? 'purgePendingReview' : review.deletedAt ? 'deletedReview' : 'savedReview';
    if (!review.deletedAt) item.command = { command: 'codeReview.openReview', title: '打开审阅记录', arguments: [node] };
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}
