import * as vscode from 'vscode';
import { GitRepository } from './git';
import { DefaultBase, messageOf } from './model';

interface CommitItem extends vscode.QuickPickItem { oid?: string }
const shaInput = (value: string): boolean => /^[a-fA-F0-9]{7,64}$/.test(value.trim());

export async function pickCommit(repo: Pick<GitRepository, 'commits' | 'resolve'>): Promise<DefaultBase | undefined> {
  const recent: CommitItem[] = (await repo.commits()).map(commit => ({
    label: commit.oid.slice(0, 8) + '  ' + commit.subject, description: commit.date, detail: commit.oid, oid: commit.oid
  }));
  const picker = vscode.window.createQuickPick<CommitItem>();
  picker.title = '选择基点提交';
  picker.placeholder = '搜索最近 150 条提交，或粘贴完整 / 短 SHA 后回车（不限最近记录）';
  picker.matchOnDescription = true; picker.matchOnDetail = true; picker.items = recent;
  return new Promise(resolve => {
    let finished = false, accepting = false;
    const listeners: vscode.Disposable[] = [];
    const finish = (source?: DefaultBase): void => {
      if (finished) return;
      finished = true;
      for (const listener of listeners) listener.dispose();
      picker.dispose(); resolve(source);
    };
    const showError = (detail: string): void => {
      picker.items = [{ label: '$(warning) 无法选择此提交', detail, alwaysShow: true }, ...recent];
    };
    listeners.push(picker.onDidHide(() => finish()), picker.onDidChangeValue(value => {
      picker.items = shaInput(value) ? [{ label: '$(git-commit) 使用提交 ' + value.trim(),
        description: '回车验证并选择', detail: '在当前仓库直接解析，不受最近 150 条记录限制', oid: value.trim(), alwaysShow: true }, ...recent] : recent;
    }), picker.onDidAccept(() => {
      if (accepting || finished) return;
      const selected = picker.selectedItems[0];
      const value = shaInput(picker.value) ? picker.value.trim().toLowerCase() : picker.items.includes(selected) ? selected?.oid : undefined;
      if (!value) { showError('请选择一条提交，或输入至少 7 位提交 SHA。'); return; }
      accepting = true; picker.busy = true; picker.enabled = false;
      void repo.resolve(value).then(ref => {
        if (!finished) finish({ kind: 'commit', ref, label: ref.slice(0, 10) });
      }, error => {
        if (!finished) showError('请确认仓库与 SHA，且提交已在本地存在；可修改输入后重试。' + messageOf(error));
      }).finally(() => {
        accepting = false;
        if (!finished) { picker.busy = false; picker.enabled = true; }
      });
    }));
    picker.show();
  });
}
