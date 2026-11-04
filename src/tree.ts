import * as vscode from 'vscode';
import { ReviewFile } from './model';
import { MarkRequest, ReviewView } from './review';

export type TreeFilter = 'all' | 'unreviewed' | 'comments';
export const treeFilterLabels: Record<TreeFilter, string> = { all: '全部', unreviewed: '未审核', comments: '有评论' };
export function treeFilter(value: unknown): TreeFilter { return value === 'unreviewed' || value === 'comments' ? value : 'all'; }

export interface TreeNode {
  kind: 'base' | 'file' | 'folder' | 'message';
  id: string; label: string; path?: string; row?: ReviewFile; children?: TreeNode[];
  session?: string; tooltip?: string; retry?: boolean;
  base?: string; detail?: string;
}
export function filesIn(node: TreeNode): ReviewFile[] {
  return node.row ? (node.row.commentOnly ? [] : [node.row]) : (node.children || []).flatMap(filesIn);
}
export function markRequest(node: TreeNode, checked: boolean): MarkRequest {
  if (!node.session) throw new Error('请先选择基点');
  return {
    session: node.session,
    files: filesIn(node).map(row => ({ path: row.path, fingerprint: row.fingerprint, checked })),
    ...(node.kind === 'folder' ? { directory: node.path || '' } : {})
  };
}
export function isTestFile(file: string): boolean {
  const name = file.split('/').at(-1)!;
  return /(?:^test[_-]|(?:[._-](?:test|tests|spec))(?:\.[^.]+)?$)/i.test(name) || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(file);
}
function fileDetails(row: ReviewFile, dirty: boolean) {
  const test = isTestFile(row.path);
  const label = row.error ? '读取失败' : dirty ? '未保存' : row.commentOnly ? (row.deletedOnly ? '已删除评论' : '保留的评论') : { pending: '待审', reviewed: '已审', changed: '需复审' }[row.status];
  const change = row.left.mode === '000000' ? '新增' : row.right.mode === '000000' ? '删除' : '修改';
  const tooltip = row.path + '\n' + (row.commentOnly ? '' : change + ' · ') + label + (test ? ' · 测试文件' : '') + '\n' + (row.error || row.left.mode + ' → ' + row.right.mode);
  const color = row.error ? 'error' : dirty || row.status === 'changed' ? 'changed' : row.commentOnly ? 'comment' : change === '新增' ? 'added' : change === '删除' ? 'deleted' : 'modified';
  const badge = row.error || dirty || row.status === 'changed' ? '!' : test ? 'T' : row.commentOnly ? 'C' : change === '新增' ? 'A' : change === '删除' ? 'D' : 'M';
  return { test, label, change, tooltip, color, badge };
}
const resource = (file: string, session: string): vscode.Uri => vscode.Uri.from({ scheme: 'code-review-tree', authority: session, path: '/' + file });
interface CommentCounts { open: number; resolved: number }
interface DirectoryCommentCounts extends CommentCounts { ownOpen: number; ownResolved: number }
const commentLabel = (counts?: CommentCounts): string => counts?.open ? counts.open + ' 评论' : counts?.resolved ? counts.resolved + ' 已解决评论' : '';
export class ReviewTree implements vscode.TreeDataProvider<TreeNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly decorations = new Map<string, vscode.FileDecoration>();
  private dirty = new Set<string>();
  nodes: TreeNode[] = [];
  private readonly comments = new Map<string, CommentCounts>();
  private readonly directoryComments = new Map<string, DirectoryCommentCounts>();
  private readonly nodeIndex = new Map<string, TreeNode>();
  private readonly allNodeIndex = new Map<string, TreeNode>();
  private filter: TreeFilter = 'all';
  private session?: string;
  render(view: ReviewView, dirty = new Set<string>(), filter: TreeFilter = 'all'): void {
    this.session = view.session?.id;
    this.filter = filter;
    this.dirty = dirty;
    this.allNodeIndex.clear();
    this.decorations.clear();
    this.comments.clear(); this.directoryComments.clear();
    for (const comment of view.notes.comments) {
      const key = (comment.target || 'file') + ':' + comment.path;
      const direct = this.comments.get(key) || { open: 0, resolved: 0 };
      direct[comment.state]++; this.comments.set(key, direct);
      const pieces = comment.path.split('/'), directory = comment.target === 'directory';
      // Add a file comment only to its parent directories, never to a same-named directory.
      // Splitting by path components also keeps src/x separate from src/xx.
      for (let depth = 0; depth < pieces.length + Number(directory); depth++) {
        const ancestor = pieces.slice(0, depth).join('/');
        const counts = this.directoryComments.get(ancestor) || { open: 0, resolved: 0, ownOpen: 0, ownResolved: 0 };
        counts[comment.state]++;
        if (directory && depth === pieces.length) counts[comment.state === 'open' ? 'ownOpen' : 'ownResolved']++;
        this.directoryComments.set(ancestor, counts);
      }
    }
    if (view.error) {
      this.nodes = [{ kind: 'message', id: 'error', label: '读取失败，点击重试', tooltip: view.error, retry: true }];
    } else if (!view.session) this.nodes = [];
    else {
      const session = view.session;
      const root: TreeNode = { kind: 'folder', id: 'root', label: '变更文件', path: '', children: [], session: session.id };
      const ensureFolder = (pieces: string[]): TreeNode => {
        let parent = root, prefix = '';
        for (const name of pieces) {
          prefix += (prefix ? '/' : '') + name;
          let folder = parent.children!.find(item => item.kind === 'folder' && item.path === prefix);
          if (!folder) { folder = { kind: 'folder', id: 'dir:' + prefix, label: name, path: prefix, children: [], session: session.id }; parent.children!.push(folder); }
          parent = folder;
        }
        return parent;
      };
      for (const row of view.files) {
        const details = fileDetails(row, dirty.has(row.path));
        this.decorations.set(resource(row.path, session.id).toString(), {
          color: new vscode.ThemeColor('codeReview.' + details.color + 'Foreground'),
          badge: details.badge, tooltip: details.tooltip, propagate: false
        });
        const pieces = row.path.split('/');
        const parent = ensureFolder(pieces.slice(0, -1));
        parent.children!.push({ kind: 'file', id: 'file:' + row.path, label: pieces.at(-1)!, path: row.path, row, session: session.id });
      }
      for (const comment of [...view.notes.comments, ...(view.notes.deleted || [])]) if (comment.target === 'directory') ensureFolder(comment.path.split('/'));
      const sort = (node: TreeNode): void => {
        node.children?.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.label.localeCompare(b.label));
        node.children?.forEach(sort);
        if (node.kind === 'folder') {
          const details = this.directoryDetails(node);
          this.decorations.set(resource((node.path || '') + '/', session.id).toString(), {
            color: new vscode.ThemeColor('codeReview.' + details.color + 'Foreground'),
            badge: details.badge, tooltip: details.tooltip, propagate: false
          });
        }
      };
      sort(root);
      this.nodes = [
        { kind: 'base', id: 'base', base: session.base,
          label: '对比起点：' + session.label.replace(' 的分叉基点', ' 的分叉提交'),
          detail: (view.baseCommit?.subject || '固定提交') + ' · ' + session.base.slice(0, 8),
          tooltip: '从这次提交开始，对比当前分支和工作区的全部变化。\n来源：' + session.label + '\n提交说明：' + (view.baseCommit?.subject || '') +
            '\n提交日期：' + (view.baseCommit?.date || '') + '\n完整 SHA：' + session.base + '\n点击更换；旁边的复制按钮可复制完整 SHA。' },
        ...(root.children!.length ? root.children! : [{ kind: 'message' as const, id: 'empty', label: '与基点相比没有改动' }])
      ];
    }
    const index = (nodes: TreeNode[], target: Map<string, TreeNode>): void => {
      target.clear();
      const remaining = [...nodes].reverse();
      while (remaining.length) {
        const node = remaining.pop()!;
        target.set(node.id, node);
        if (node.children) remaining.push(...[...node.children].reverse());
      }
    };
    index(this.nodes, this.allNodeIndex);
    if (filter !== 'all' && view.session && !view.error) {
      const visible = (node: TreeNode): TreeNode[] => {
        if (node.kind === 'base') return [node];
        if (node.row) {
          const row = node.row;
          const matches = filter === 'comments' ? this.comments.has('file:' + row.path) :
            !row.commentOnly && (row.status !== 'reviewed' || !!row.error || dirty.has(row.path));
          return matches ? [node] : [];
        }
        const children = (node.children || []).flatMap(visible);
        return children.length || (filter === 'comments' && this.comments.has('directory:' + node.path)) ? [{ ...node, children }] : [];
      };
      this.nodes = this.nodes.flatMap(visible);
      if (!this.nodes.some(node => node.kind === 'file' || node.kind === 'folder')) this.nodes.push({
        kind: 'message', id: 'filter-empty', label: filter === 'unreviewed' ? '没有未审核文件' : '暂无带评论的文件或目录', tooltip: '点击显示全部'
      });
    }
    index(this.nodes, this.nodeIndex);
    this.changed.fire(); this.decorationsChanged.fire(undefined);
  }
  private directoryDetails(node: TreeNode) {
    const completeNode = this.allNodeIndex.get(node.id);
    const rows = filesIn(completeNode && completeNode.session === node.session ? completeNode : node), total = rows.length;
    const reviewed = rows.filter(row => row.status === 'reviewed' && !row.error && !this.dirty.has(row.path)).length;
    const failed = rows.some(row => row.error), unsaved = rows.some(row => this.dirty.has(row.path));
    const complete = total > 0 && reviewed === total;
    const label = !total ? '仅评论' : complete ? '已审完' : reviewed ? '部分已审' : '未审';
    const comments = this.directoryComments.get(node.path || ''), comment = commentLabel(comments);
    const description = label + (total ? ' ' + reviewed + '/' + total : '') + (comment ? ' · ' + comment : '');
    const commentTooltip = !comments ? '' :
      (comments.open ? '\n未解决评论：' + comments.open + '（本目录 ' + comments.ownOpen + '，子项 ' + (comments.open - comments.ownOpen) + '）' : '') +
      (comments.resolved ? '\n已解决评论：' + comments.resolved + '（本目录 ' + comments.ownResolved + '，子项 ' + (comments.resolved - comments.ownResolved) + '）' : '');
    const color = failed ? 'error' : reviewed && !complete ? 'changed' : complete ? 'added' : !total ? 'comment' : 'folder';
    const badge = failed ? '!' : complete ? '✓' : reviewed ? '◐' : undefined;
    const action = complete ? '点击取消此目录的已审标记' : reviewed ? '部分文件已审，点击标记整个目录为已审' : '点击标记整个目录为已审';
    return { total, complete, failed, unsaved, description, color, badge, action,
      tooltip: (node.path || node.label) + '\n' + description + commentTooltip + '\n点击目录名称查看本目录与子项评论，箭头展开子目录。' +
        (this.filter !== 'all' ? '\n进度与评论数包含隐藏项；筛选时请切换到全部后批量标记' : failed ? '\n存在读取失败，不能标记已审' : unsaved ? '\n存在未保存修改，保存后才能标记已审' : total ? '\n' + action : '') };
  }
  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.nodes;
    return node.session === this.session ? this.nodeIndex.get(node.id)?.children || [] : [];
  }
  findTarget(path: string, target?: 'directory', includeHidden = false): TreeNode | undefined {
    const node = (includeHidden ? this.allNodeIndex : this.nodeIndex).get((target === 'directory' ? 'dir:' : 'file:') + path);
    return node?.session === this.session ? node : undefined;
  }
  getParent(node: TreeNode): TreeNode | undefined {
    if (node.session !== this.session || !node.path || !this.nodeIndex.has(node.id)) return undefined;
    const slash = node.path.lastIndexOf('/');
    return slash < 0 ? undefined : this.nodeIndex.get('dir:' + node.path.slice(0, slash));
  }
  async expandAll(view: Pick<vscode.TreeView<TreeNode>, 'reveal' | 'selection'>): Promise<void> {
    const session = this.session;
    const folders = [...this.nodeIndex.values()].filter(node => node.kind === 'folder');
    if (!session || !folders.length) return;
    const anchor = view.selection[0] || this.nodes[0];
    // reveal only supports three recursive levels. Reveal each directory instead, while keeping
    // stable item IDs so ordinary refreshes preserve the user's later expand/collapse choices.
    for (const folder of folders) {
      if (this.session !== session) return;
      const current = this.nodeIndex.get(folder.id);
      if (!current || current.session !== session) continue;
      try { await view.reveal(current, { expand: true, select: false, focus: false }); }
      catch (error) {
        if (this.session !== session) return;
        if (this.nodeIndex.has(folder.id)) throw error;
      }
    }
    if (this.session !== session) return;
    const current = anchor && this.nodeIndex.get(anchor.id);
    if (current && current.session === anchor.session) await view.reveal(current, { select: false, focus: false });
  }
  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === 'folder' ? (node.path?.includes('/') ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded) : vscode.TreeItemCollapsibleState.None);
    item.id = node.id; item.tooltip = node.tooltip || node.path || node.label;
    if (node.kind === 'base') {
      item.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('codeReview.commentForeground'));
      item.contextValue = 'comparisonBase'; item.description = node.detail;
      item.command = { command: 'codeReview.configure', title: '更换基点' };
    } else if (node.kind === 'folder') {
      const details = this.directoryDetails(node);
      item.contextValue = 'reviewDirectory'; item.description = details.description; item.tooltip = details.tooltip;
      item.command = { command: 'codeReview.commentDirectory', title: '评论此目录', arguments: [node] };
      item.resourceUri = resource((node.path || '') + '/', node.session || 'files');
      item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('codeReview.' + details.color + 'Foreground'));
      item.accessibilityInformation = { label: node.label + '，' + details.description };
      if (this.filter === 'all' && details.total && !details.failed && !details.unsaved) item.checkboxState = {
        state: details.complete ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: details.action,
        accessibilityInformation: { label: details.description + '，' + details.action }
      };
    } else if (node.row) {
      const row = node.row;
      const dirty = this.dirty.has(row.path), { test, label, change, tooltip } = fileDetails(row, dirty);
      item.contextValue = row.commentOnly ? 'commentFile' : 'reviewFile';
      const comment = commentLabel(this.comments.get('file:' + row.path));
      item.description = [test ? '测试' : '', label === '待审' || label === '已审' ? '' : label, comment].filter(Boolean).join(' · ');
      item.tooltip = tooltip;
      item.resourceUri = resource(row.path, node.session || 'files');
      item.iconPath = vscode.ThemeIcon.File;
      if (!row.error && !row.commentOnly && !dirty) item.checkboxState = row.status === 'reviewed' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      item.accessibilityInformation = { label: node.label + '，' + change + '，' + label + (test ? '，测试文件' : '') + (comment ? '，' + comment : '') };
      item.command = { command: 'codeReview.open', title: '打开 Diff 与评论', arguments: [node] };
    } else if (node.id === 'filter-empty') {
      item.command = { command: 'codeReview.clearFilter', title: '显示全部' };
    } else if (node.retry) {
      item.iconPath = new vscode.ThemeIcon('error');
      item.command = { command: 'codeReview.refresh', title: '重试' };
    }
    return item;
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined { return this.decorations.get(uri.toString()); }
  dispose(): void { this.changed.dispose(); this.decorationsChanged.dispose(); }
}
