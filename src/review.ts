import { CommentRepository, Notes } from './comments';
import { Anchor } from './anchors';
import { CommitChoice, GitRepository } from './git';
import { absent, checkPath, hash, isNotes, LegacyComparison, messageOf, Pair, pairId, recordId, ReviewBranch, ReviewFile, ReviewRecords, SCAN_LIMIT, Session, snapshotId } from './model';
import { ReviewState } from './state';

export interface ReviewView { session?: Session; branch?: ReviewBranch; sessions?: Session[]; purgePending?: string[]; baseCommit?: CommitChoice; files: ReviewFile[]; notes: Notes; error?: string }
export interface Selection { key: string; draftKey: string; legacyDraftKey?: string; session: Session; file: string; pair: Pair; target?: 'directory' }
export interface MarkRequest { session: string; files: { path: string; fingerprint: string; checked: boolean }[]; directory?: string }
export interface PurgedReview { session: Session; targets: { path: string; target: 'file' | 'directory' }[] }
export class ReviewService {
  readonly state: ReviewState;
  readonly comments: CommentRepository;
  view: ReviewView = { files: [], notes: { comments: [], replies: new Map() } };
  private records: ReviewRecords = Object.create(null);
  private viewRevision = 0;
  constructor(readonly repo: GitRepository, storage: string) {
    this.state = new ReviewState(storage, repo.root); this.comments = new CommentRepository(repo.root);
  }
  async start(legacy?: LegacyComparison): Promise<void> {
    await this.state.resume(this.repo, legacy);
    await this.refresh();
  }
  async choose(base: string, label: string): Promise<void> {
    const branch = await this.repo.branch();
    const commit = await this.repo.resolve(base);
    await this.repo.scan(commit);
    if ((await this.repo.branch()).key !== branch.key) throw new Error('分支已改变，请重新选择基点');
    await this.state.select(commit, label, branch);
    await this.refresh();
  }
  async refresh(): Promise<void> {
    for (;;) {
      const revision = this.viewRevision;
      try {
        const branch = await this.repo.branch(), session = await this.state.active(branch), sessions = await this.state.sessions();
        const purgePending = await this.state.pendingPurges();
        const notes = await this.comments.sync(session, sessions.filter(item => !purgePending.includes(item.id)), async () => {
          if ((await this.repo.branch()).key !== branch.key || JSON.stringify(await this.state.sessions()) !== JSON.stringify(sessions)) {
            throw new Error('分支或 CR 记录已改变，请刷新后继续');
          }
        });
        if (!session) {
          if (revision !== this.viewRevision) continue;
          this.records = Object.create(null); this.view = { branch, sessions, purgePending, files: [], notes };
          this.viewRevision++; return;
        }
        const records = await this.state.records(session);
        const files = await this.repo.scan(session.base, Object.keys(records));
        for (const file of files) {
          const record = Object.hasOwn(records, file.path) ? records[file.path] : undefined;
          if (!file.error && record) file.status = file.fingerprint === recordId(record) ? 'reviewed' : 'changed';
        }
        const visible = new Set(files.map(file => file.path));
        const activePaths = new Set(notes.comments.filter(comment => comment.target !== 'directory').map(comment => comment.path));
        for (const comment of [...notes.comments, ...(notes.deleted || [])]) {
          if (comment.target === 'directory') continue;
          if (visible.has(comment.path)) continue;
          visible.add(comment.path);
          try {
            const pair = await this.repo.pair(session.base, comment.path);
            files.push({ path: comment.path, ...pair, fingerprint: pairId(pair), status: 'pending', commentOnly: true, deletedOnly: !activePaths.has(comment.path) });
          } catch (error) {
            files.push({ path: comment.path, left: absent(), right: absent(), fingerprint: '', status: 'pending', commentOnly: true, error: messageOf(error) });
          }
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        const baseCommit = await this.repo.commitInfo(session.base);
        await this.assertCurrent(session);
        // A targeted read published while this scan was running. Repeat the complete
        // refresh rather than overwrite it or present a mixture as a fresh full scan.
        if (revision !== this.viewRevision) continue;
        this.records = records;
        this.view = { session, branch, sessions, purgePending, baseCommit, files, notes };
        this.viewRevision++; return;
      } catch (error) {
        if (revision !== this.viewRevision) continue;
        this.view = { ...this.view, files: [], error: messageOf(error) };
        this.viewRevision++; throw error;
      }
    }
  }
  selection(file: string): Selection {
    const row = this.view.files.find(item => item.path === file), session = this.view.session;
    if (this.view.error || !row || row.error || !session) throw new Error(row?.error || '请先成功刷新并选择一个文件');
    return this.makeSelection(file, { left: row.left, right: row.right }, session);
  }
  directorySelection(file: string): Selection {
    checkPath(file);
    const session = this.view.session;
    const inTree = this.view.files.some(row => row.path.startsWith(file + '/')) ||
      [...this.view.notes.comments, ...(this.view.notes.deleted || [])].some(comment => comment.target === 'directory' && (comment.path === file || comment.path.startsWith(file + '/')));
    if (this.view.error || !session || isNotes(file) || !inTree) throw new Error('请从审阅树选择一个目录');
    return {
      file, session, target: 'directory', pair: { left: absent(), right: absent() },
      key: hash(this.repo.root + '\0' + session.id + '\0directory\0' + file),
      draftKey: hash(this.repo.root + '\0' + session.id + '\0directory\0' + file),
      legacyDraftKey: session.commentScopes?.length ? hash(this.repo.root + '\0directory\0' + file) : undefined
    };
  }
  private makeSelection(file: string, pair: Pair, session: Session): Selection {
    return {
      session, file, pair,
      key: hash(this.repo.root + '\0' + session.id + '\0' + file + '\0' + pairId(pair)),
      draftKey: hash(this.repo.root + '\0' + session.id + '\0' + file),
      legacyDraftKey: session.commentScopes?.length ? hash(this.repo.root + '\0' + file) : undefined
    };
  }
  async capture(file: string): Promise<Selection> {
    const session = this.view.session;
    if (this.view.error || !session) throw new Error('请先成功刷新并选择基点');
    await this.assertCurrent(session);
    const head = await this.repo.resolve('HEAD'), pair = await this.repo.pair(session.base, file);
    if (head !== await this.repo.resolve('HEAD')) throw new Error('读取时分支发生变化，请刷新');
    await this.assertCurrent(session);
    if (this.view.error || this.view.session?.id !== session.id) throw new Error('审阅视图已改变，请刷新后重新打开');
    return this.makeSelection(file, pair, session);
  }
  /** Refresh the clicked file from disk without claiming that the rest of the tree was rescanned. */
  async openFile(file: string, expectedSession?: string, current: () => boolean = () => true): Promise<Selection | undefined> {
    const previous = this.selection(file);
    if (expectedSession && expectedSession !== previous.session.id) throw new Error('CR 已改变，请从当前文件树重新打开 Diff');
    while (current()) {
      const revision = this.viewRevision;
      try {
        if (this.view.session?.id !== previous.session.id) throw new Error('CR 已改变，请从当前文件树重新打开 Diff');
        const selected = await this.capture(file);
        if (!current()) return;
        // A newer complete/targeted read won publication; this target must be read again.
        if (revision !== this.viewRevision) continue;
        const fingerprint = pairId(selected.pair);
        const record = Object.hasOwn(this.records, file) ? this.records[file] : undefined;
        const changed = snapshotId(selected.pair.left) !== snapshotId(selected.pair.right);
        const activeComment = this.view.notes.comments.some(comment => comment.target !== 'directory' && comment.path === file);
        const retained = activeComment || this.view.notes.deleted?.some(comment => comment.target !== 'directory' && comment.path === file);
        const size = this.view.files.reduce((total, row) => total + (row.path === file || row.commentOnly || row.error ? 0 : row.left.data.length + row.right.data.length), 0) +
          (changed ? selected.pair.left.data.length + selected.pair.right.data.length : 0);
        if (size > SCAN_LIMIT) throw new Error('本次差异超过 80 MiB，请选择更近的基点');
        const files = this.view.files.filter(row => row.path !== file);
        if (changed || retained) files.push({ path: file, ...selected.pair, fingerprint, commentOnly: !changed, deletedOnly: !changed && !activeComment,
          status: record ? (fingerprint === recordId(record) ? 'reviewed' : 'changed') : 'pending' });
        this.view.files = files.sort((a, b) => a.path.localeCompare(b.path));
        this.viewRevision++; return selected;
      } catch (error) {
        if (!current()) return;
        if (revision !== this.viewRevision) continue;
        if (this.view.session?.id === previous.session.id) {
          this.view.files = this.view.files.map(row => row.path === file ? { ...row, error: messageOf(error) } : row);
          this.viewRevision++;
        }
        throw error;
      }
    }
  }
  async mark(request: MarkRequest, beforeWrite?: () => void): Promise<void> {
    await this.refresh();
    const session = this.view.session;
    if (!session || session.id !== request.session) throw new Error('基点已改变，请查看当前差异后再标记');
    if (request.directory !== undefined) {
      const under = (file: string): boolean => !request.directory || file.startsWith(request.directory + '/');
      const current = this.view.files.filter(file => !file.commentOnly && under(file.path)).map(file => file.path).sort();
      const displayed = request.files.map(file => file.path).sort();
      if (JSON.stringify(current) !== JSON.stringify(displayed)) throw new Error('目录文件列表已变化，请先检查新增或删除的文件');
    }
    const updates: { path: string; pair?: Pair }[] = [];
    for (const requested of request.files) {
      const file = this.view.files.find(item => item.path === requested.path);
      if (requested.checked && (!file || file.error || file.commentOnly || file.fingerprint !== requested.fingerprint)) {
        throw new Error(requested.path + ' 已变化或读取失败，请查看最新 Diff');
      }
      updates.push({ path: requested.path, pair: requested.checked ? file : undefined });
    }
    beforeWrite?.();
    await this.assertCurrent(session);
    await this.state.record(session, updates, () => this.assertCurrent(session));
    await this.refresh();
  }
  async previous(file: string): Promise<Pair | undefined> {
    const session = this.view.session, record = Object.hasOwn(this.records, file) ? this.records[file] : undefined;
    if (!session || !record) return undefined;
    return { left: await this.state.snapshot(session, record.left), right: await this.state.snapshot(session, record.right) };
  }
  async add(selection: Selection, body: string, anchor?: Anchor, requestId?: string): Promise<void> {
    await this.assertCurrent(selection.session);
    await this.comments.add(selection.session, selection.file, selection.pair, body, anchor, requestId, selection.target || 'file', () => this.assertCurrent(selection.session));
    await this.refresh();
  }
  async assertCurrent(session: Session): Promise<void> {
    const branch = await this.repo.branch(), active = await this.state.active(branch);
    if (branch.key !== session.branch?.key || active?.id !== session.id) throw new Error('分支或 CR 已改变，草稿已保留，请重新选择审阅对象');
  }
  async openReview(id: string): Promise<void> {
    await this.state.open(id, await this.repo.branch());
    await this.refresh();
  }
  async deleteReview(id: string, deleted: boolean): Promise<void> {
    await this.state.setDeleted(id, deleted);
    await this.refresh();
  }
  async purgeReview(id: string): Promise<PurgedReview> {
    const session = (await this.state.sessions()).find(item => item.id === id);
    if (!session) throw new Error('CR 不存在，请刷新');
    const scopes = new Set([id, ...(session.commentScopes || [])]), targets = new Map<string, PurgedReview['targets'][number]>();
    const add = (file: string, target: 'file' | 'directory' = 'file'): void => { targets.set(target + ':' + file, { path: file, target }); };
    if (!await this.state.isPurged(id)) {
      // Draft cleanup is best effort; broken snapshots must not prevent deleting their explicitly selected CR.
      try { for (const file of Object.keys(await this.state.records(session))) add(file); } catch { /* The scoped purge still validates every owned directory. */ }
    }
    try {
      const notes = await this.comments.load();
      for (const comment of [...notes.comments, ...(notes.deleted || [])]) if (scopes.has(comment.scope)) add(comment.path, comment.target);
    } catch { /* Optional draft targets must not make malformed replies undeletable; purge validates comment ownership itself. */ }
    if (this.view.session?.id === id) for (const file of this.view.files) add(file.path);
    await this.state.purge(id, session => this.comments.purge(session), session => this.comments.invalidateReview(session));
    await this.refresh();
    return { session, targets: [...targets.values()] };
  }
}
