import type { Anchor, BaseOptions, Comment, DiffView, Draft, Failure, FileRow, FolderPickResult, Language, Locale, Request, Target, WorkspaceView } from '../../src/codex/contract';

export function repositoryFailureMessage(failure?: Failure): [string, string] | undefined {
  if (failure?.code === 'ACCESS_DENIED') return ['无法访问这个项目文件夹。请检查文件夹权限，或重新选择。', 'This project folder cannot be accessed. Check its permissions or choose another folder.'];
  if (failure?.code !== 'REPOSITORY_UNAVAILABLE') return undefined;
  if (/not a git repository|不是.*仓库/i.test(failure.message)) return ['这个文件夹不是 Git 仓库，请重新选择项目文件夹。', 'This folder is not a Git repository. Choose another project folder.'];
  if (/ENOENT|no such file or directory/i.test(failure.message)) return ['这个文件夹已不存在。请重新选择项目文件夹。', 'This folder no longer exists. Choose another project folder.'];
  return ['无法打开这个项目，请确认文件夹仍存在且可以访问，或重新选择。', 'This project could not be opened. Check that the folder still exists and is accessible, or choose another folder.'];
}

export type FolderPickerState = FolderPickResult | { status: 'idle' } | { status: 'cancelling'; requestId: string } | { status: 'interrupted'; requestId: string; cancelling: boolean };
type FolderPickerCall = (action: 'pickFolder' | 'folderPickerResult' | 'cancelFolderPicker', requestId: string) => Promise<FolderPickResult>;
/** An ephemeral chooser. Late responses cannot open a project after cancellation or a newer action. */
export class FolderPickerSession {
  state: FolderPickerState = { status: 'idle' };
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private call: FolderPickerCall, private changed: (state: FolderPickerState) => void,
    private schedule = (callback: () => void) => setTimeout(callback, 500), private unschedule = clearTimeout,
    private uuid = () => crypto.randomUUID()) {}
  get busy(): boolean { return this.state.status === 'pending' || this.state.status === 'cancelling'; }
  private set(state: FolderPickerState): void { this.state = state; this.changed(state); }
  private invalidate(): number { if (this.timer !== undefined) this.unschedule(this.timer); this.timer = undefined; return ++this.generation; }
  private current(generation: number): boolean { return !this.disposed && this.generation === generation; }
  async start(): Promise<void> {
    if (this.disposed || this.busy) return;
    if (this.state.status === 'interrupted' && this.state.cancelling) { await this.cancel(); return; }
    const requestId = this.state.status === 'interrupted' ? this.state.requestId : this.uuid();
    const generation = this.invalidate(); this.set({ status: 'pending', requestId });
    await this.query('pickFolder', requestId, generation);
  }
  private async query(action: 'pickFolder' | 'folderPickerResult', requestId: string, generation: number): Promise<void> {
    try {
      const result = await this.call(action, requestId);
      if (!this.current(generation)) return;
      if (result.requestId !== requestId) {
        this.set({ status: 'failed', reason: 'invalid-result', requestId });
        void this.call('cancelFolderPicker', requestId).catch(() => {}); return;
      }
      this.set(result);
      if (result.status === 'pending' && this.current(generation)) this.timer = this.schedule(() => { this.timer = undefined; void this.query('folderPickerResult', requestId, generation); });
    } catch {
      if (this.current(generation)) this.set({ status: 'interrupted', requestId, cancelling: false });
    }
  }
  async cancel(): Promise<void> {
    if (this.disposed || !('requestId' in this.state) || this.state.status === 'cancelling') return;
    const requestId = this.state.requestId, generation = this.invalidate(); this.set({ status: 'cancelling', requestId });
    try {
      await this.call('cancelFolderPicker', requestId);
      // A selection that raced with cancellation is intentionally ignored.
      if (this.current(generation)) this.set({ status: 'cancelled', requestId });
    } catch { if (this.current(generation)) this.set({ status: 'interrupted', requestId, cancelling: true }); }
  }
  abandon(): void {
    const old = this.state; this.invalidate(); this.set({ status: 'idle' });
    if ('requestId' in old && ['pending', 'cancelling', 'interrupted'].includes(old.status)) void this.call('cancelFolderPicker', old.requestId).catch(() => {});
  }
  dispose(): void { this.disposed = true; this.abandon(); }
}

export function diffRenderKey(workspaceId: string | undefined, reviewId: string | undefined, diff: DiffView): string {
  return JSON.stringify([workspaceId, reviewId, diff.target.path, diff.fingerprint, diff.mode, diff.side, !!diff.archived,
    diff.left.hash, diff.right.hash, diff.reason || null]);
}
export function defaultBaseSelection(saved: WorkspaceView['defaultBase'], options: BaseOptions) {
  return { kind: saved?.kind || 'branch',
    branch: saved?.kind === 'branch' ? saved.ref : options.preferred || options.branches[0]?.ref || '',
    commit: saved?.kind === 'commit' ? saved.ref : '' };
}

export function localeFor(language: Language, hostLocale?: string): Locale {
  return language === 'auto' ? (/^zh(?:-|$)/i.test(hostLocale || '') ? 'zh-CN' : 'en') : language;
}
export function targetKey(target?: Target): string { return target ? `${target.type}:${target.path}` : ''; }
export function fileIconKind(path: string): 'test' | 'code' | 'markdown' | 'file' {
  const name = path.split('/').at(-1) || path;
  // Mirrors the editor client's test-file recognition; decoration does not classify review scope.
  if (/(?:^test[_-]|(?:[._-](?:test|tests|spec))(?:\.[^.]+)?$)/i.test(name) || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(path)) return 'test';
  if (/\.[cm]?[jt]sx?$/i.test(name)) return 'code';
  if (/\.(md|mdx|markdown)$/i.test(name)) return 'markdown';
  return 'file';
}
export function fileRowTone(file?: FileRow): string {
  return file?.error ? 'read-error' : file?.status === 'changed' ? 'needs-review' : file && fileIconKind(file.path) === 'test' ? 'test-file' : '';
}
export function firstReviewTarget(files: FileRow[]): Target | undefined {
  const candidates = files.filter(file => !file.commentOnly && !file.error);
  const file = candidates.find(file => file.status !== 'reviewed') || candidates[0];
  return file ? { type: 'file', path: file.path } : undefined;
}
export function commentPayload(draft: Draft, files: FileRow[]): Extract<Request, { action: 'addComment' }>['payload'] {
  const file = files.find(item => item.path === draft.target.path);
  if (draft.target.type === 'file' && !file) throw new Error('CONTENT_CHANGED');
  return { target: draft.target, body: draft.body, requestId: draft.requestId,
    ...(draft.anchor ? { anchor: draft.anchor } : {}),
    ...(draft.target.type === 'file' ? { fingerprint: file!.fingerprint } : {}) };
}
export function under(path: string, directory: string): boolean { return path === directory || path.startsWith(directory + '/'); }
export function summarize(files: FileRow[], comments: Comment[], directory?: string) {
  const members = files.filter(file => !file.commentOnly && (!directory || under(file.path, directory)));
  const notes = comments.filter(comment => !comment.deleted && (!directory || under(comment.path, directory)));
  return {
    total: members.length, reviewed: members.filter(file => file.status === 'reviewed').length,
    changed: members.filter(file => file.status === 'changed').length,
    open: notes.filter(comment => comment.state === 'open').length,
    resolved: notes.filter(comment => comment.state === 'resolved').length,
    pending: notes.filter(comment => comment.state === 'open' && !comment.reply?.matches).length,
    review: notes.filter(comment => comment.state === 'open' && comment.reply?.matches).length,
  };
}
export type TreeSummary = ReturnType<typeof summarize> & { errors: number };
const emptySummary = (): TreeSummary => ({ total: 0, reviewed: 0, changed: 0, open: 0, resolved: 0, pending: 0, review: 0, errors: 0 });
/** Index each path and its ancestors once; drawing a row never scans the full workspace. */
export class ReviewTree {
  readonly roots: TreeNode[];
  readonly directories: string[];
  readonly firstTarget?: Target;
  readonly total = emptySummary();
  readonly filesByPath = new Map<string, FileRow>();
  private summaries = new Map<string, TreeSummary>();
  constructor(readonly files: FileRow[], readonly comments: Comment[]) {
    this.roots = buildTree(files, comments);
    this.directories = directoryPaths(this.roots);
    this.firstTarget = firstReviewTarget(files);
    const ancestors = (path: string, add: (summary: TreeSummary) => void): void => {
      add(this.total);
      for (let current = path; current; current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '') {
        let summary = this.summaries.get(current);
        if (!summary) this.summaries.set(current, summary = emptySummary());
        add(summary);
      }
    };
    for (const file of files) {
      this.filesByPath.set(file.path, file);
      if (!file.commentOnly) ancestors(file.path, summary => {
        summary.total++; if (file.status === 'reviewed') summary.reviewed++;
        if (file.status === 'changed') summary.changed++; if (file.error) summary.errors++;
      });
    }
    for (const comment of comments) if (!comment.deleted) ancestors(comment.path, summary => {
      if (comment.state === 'resolved') summary.resolved++;
      else { summary.open++; if (comment.reply?.matches) summary.review++; else summary.pending++; }
    });
  }
  summary(path: string): TreeSummary { return this.summaries.get(path) || emptySummary(); }
  members(target: Target): FileRow[] {
    const file = this.filesByPath.get(target.path);
    return target.type === 'file' ? file && !file.commentOnly ? [file] : [] : this.files.filter(file => !file.commentOnly && under(file.path, target.path));
  }
  /** Postorder filtering visits each node once, including collapsed descendants. */
  eligible(filter: string, unfinishedOnly: boolean): Set<TreeNode> {
    const matches = new Set<TreeNode>(), query = filter.toLocaleLowerCase();
    const visit = (node: TreeNode): void => {
      node.children.forEach(visit);
      const unfinished = !unfinishedOnly || !!node.file && (node.file.status !== 'reviewed' || node.file.commentOnly) || this.summary(node.target.path).open > 0;
      if ((!query || node.target.path.toLocaleLowerCase().includes(query)) && unfinished || node.children.some(child => matches.has(child))) matches.add(node);
    };
    this.roots.forEach(visit); return matches;
  }
}

/** Refreshes remain live, with breathing room after an expensive scan instead of interval catch-up. */
export function refreshDelay(elapsed: number): number { return Math.max(5000, Math.min(60000, elapsed * 2)); }

/** JSON-shaped protocol data only. Preserve references when fresh data has identical values. */
export function equalData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalData(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalData(a[key], b[key]));
}
export function selectionAnchor(diff: DiffView, side: 'left' | 'right', start: number, end: number): Anchor {
  const source = diff[side];
  if (diff.mode !== 'full' || !source.textContent || !['100644', '100755'].includes(source.mode) || /\r(?!\n)/.test(source.text)) throw new Error('UNSUPPORTED_CONTENT');
  const lines = source.text.split(/\r?\n/);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= lines.length || end - start >= 200) throw new Error('SELECTION_LIMIT');
  const selected = lines.slice(start, end + 1), before = lines.slice(Math.max(0, start - 3), start), after = lines.slice(end + 1, end + 4);
  if (selected.join('\n').length > 50000 || before.join('\n').length + after.join('\n').length > 24000) throw new Error('SELECTION_LIMIT');
  return { side, start, end, hash: source.hash, selected, before, after };
}
export interface TreeNode { name: string; target: Target; children: TreeNode[]; file?: FileRow }
export function directoryPaths(tree: TreeNode[]): string[] {
  return tree.flatMap(node => node.target.type === 'directory' ? [node.target.path, ...directoryPaths(node.children)] : []);
}
export function buildTree(files: FileRow[], comments: Comment[]): TreeNode[] {
  const roots: TreeNode[] = [], nodes = new Map<string, TreeNode>();
  const add = (target: Target, file?: FileRow): void => {
    const parts = target.path.split('/');
    let siblings = roots;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/');
      const type = index === parts.length - 1 ? target.type : 'directory';
      const key = targetKey({ type, path });
      let node = nodes.get(key);
      if (!node) { node = { name: parts[index], target: { type, path }, children: [] }; nodes.set(key, node); siblings.push(node); }
      if (file && index === parts.length - 1) node.file = file;
      siblings = node.children;
    }
  };
  files.forEach(file => add({ type: 'file', path: file.path }, file));
  comments.forEach(comment => add({ type: comment.target, path: comment.path }));
  const sort = (nodes: TreeNode[]): void => { nodes.sort((a, b) => Number(b.target.type === 'directory') - Number(a.target.type === 'directory') || a.name.localeCompare(b.name)); nodes.forEach(node => sort(node.children)); };
  sort(roots); return roots;
}
