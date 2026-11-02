import * as vscode from 'vscode';
import * as path from 'node:path';

export interface SettingNode { id: string; label: string; description: string; tooltip: string; command: string; icon: string }
export class ReviewSettings implements vscode.TreeDataProvider<SettingNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  nodes: SettingNode[] = [];
  render(root?: string, defaultLabel = '自动选择主分支'): void {
    this.nodes = [
      { id: 'repository', label: '仓库', description: root ? path.basename(root) : '选择仓库…',
        tooltip: root ? root + '\n点击切换仓库，各仓库的设置和记录独立保存。' : '选择当前工作区中的 Git 仓库', command: 'codeReview.repository', icon: 'repo' },
      { id: 'default-base', label: '默认基点', description: defaultLabel,
        tooltip: '点击设置本仓库新建审阅时优先选择的基点；不会改变已有审阅。', command: 'codeReview.defaultBase', icon: 'settings-gear' }
    ];
    this.changed.fire();
  }
  getChildren(node?: SettingNode): SettingNode[] { return node ? [] : this.nodes; }
  getTreeItem(node: SettingNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id; item.description = node.description; item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon, new vscode.ThemeColor('codeReview.commentForeground'));
    item.command = { command: node.command, title: node.label };
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}
