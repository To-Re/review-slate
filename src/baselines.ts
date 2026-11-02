import { MainReferences, Reference } from './git';
import { DefaultBase } from './model';

export interface BaseOption { label: string; description?: string; source?: DefaultBase; chooseCommit?: boolean }
const branchSource = (reference: Reference): DefaultBase => ({ kind: 'branch', ref: reference.ref, label: reference.name });
export function baselineOptions(references: MainReferences, saved?: DefaultBase, allBranches = false): BaseOption[] {
  const preferred = saved || (references.preferred && branchSource(references.preferred));
  const candidates = allBranches ? references.branches : [references.localMain, references.remoteMain].filter((item): item is Reference => !!item);
  const sources = candidates.map(branchSource);
  if (preferred && !sources.some(source => source.kind === preferred.kind && source.ref === preferred.ref)) sources.unshift(preferred);
  sources.sort((a, b) => Number(b.kind === preferred?.kind && b.ref === preferred.ref) - Number(a.kind === preferred?.kind && a.ref === preferred.ref));
  const items: BaseOption[] = sources.map(source => {
    const local = source.ref.startsWith('refs/heads/');
    const prefix = source.kind === 'commit' ? '指定提交' : allBranches ? (local ? '本地分支' : '远端分支') :
      source.ref === references.localMain?.ref ? '本地主分支' : source.ref === references.remoteMain?.ref ? '远端主分支' : (local ? '本地分支' : '远端分支');
    const active = source.kind === preferred?.kind && source.ref === preferred.ref;
    return {
      label: prefix + ' · ' + (source.kind === 'commit' ? source.ref.slice(0, 10) : source.label),
      description: active ? (saved ? '本仓库默认' : '自动默认') : undefined,
      source
    };
  });
  items.push({ label: '选择一个提交…', description: '搜索提交记录或输入 SHA', chooseCommit: true });
  return items;
}
