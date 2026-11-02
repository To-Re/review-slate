import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { atomicWrite, directory, locked, readBytes, readJson, saveJson } from './filesystem';
import { checkPath, DefaultBase, FILE_LIMIT, hash, isCommit, isHash, isMode, LegacyComparison, legacyScope, missing, Pair, ReviewBranch, ReviewedFile, ReviewRecords, Session, Snapshot, SnapshotRef, snapshotId } from './model';
import { GitRepository } from './git';

interface LegacyCatalog { version: 2; active: string; sessions: Session[] }
interface Catalog { version: 3 | 4; activeByBranch: Record<string, string>; sessions: Session[]; purged?: Record<string, string[]> }
function validateDefault(value: unknown): DefaultBase {
  const data = value as { version: number; source: DefaultBase }, source = data?.source;
  if (!data || data.version !== 1 || !source || typeof source.label !== 'string' || typeof source.ref !== 'string' ||
      !(source.kind === 'commit' ? isCommit(source.ref) : source.kind === 'branch' && /^refs\/(heads|remotes)\/[^\0\r\n]+$/.test(source.ref))) throw new Error('仓库默认基点设置损坏');
  return source;
}
function validateLegacyCatalog(value: unknown): LegacyCatalog {
  const data = value as LegacyCatalog;
  if (!data || data.version !== 2 || !isHash(data.active) || !Array.isArray(data.sessions) || !data.sessions.length) throw new Error('审阅基点记录格式错误');
  const ids = new Set<string>();
  for (const item of data.sessions) {
    if (!item || !isHash(item.id) || !isCommit(item.base) || typeof item.label !== 'string' || typeof item.createdAt !== 'string' || ids.has(item.id)) throw new Error('审阅会话损坏');
    ids.add(item.id);
  }
  if (!ids.has(data.active)) throw new Error('当前审阅会话缺失');
  return data;
}
function validBranch(branch: ReviewBranch | undefined): boolean {
  return !!branch && typeof branch.label === 'string' && !!branch.label &&
    typeof branch.key === 'string' && /^(?:refs\/heads\/[^\0\r\n]+|detached:[a-f0-9]{40,64}|legacy:[a-f0-9]{64})$/.test(branch.key);
}
function validateCatalog(value: unknown): Catalog {
  const data = value as Catalog;
  if (!data || ![3, 4].includes(data.version) || !Array.isArray(data.sessions) || !data.activeByBranch || typeof data.activeByBranch !== 'object' || Array.isArray(data.activeByBranch)) throw new Error('CR 管理记录格式错误');
  const ids = new Set<string>(), pairs = new Set<string>(), aliases = new Set<string>();
  for (const item of data.sessions) {
    if (!item || !isHash(item.id) || !isCommit(item.base) || !validBranch(item.branch) || typeof item.label !== 'string' || typeof item.createdAt !== 'string' || ids.has(item.id) ||
        (item.deletedAt !== undefined && typeof item.deletedAt !== 'string') || (item.lastUsedAt !== undefined && typeof item.lastUsedAt !== 'string') ||
        (item.commentScopes !== undefined && (!Array.isArray(item.commentScopes) || item.commentScopes.some(id => !isHash(id) || aliases.has(id))))) throw new Error('CR 记录损坏');
    ids.add(item.id); item.commentScopes?.forEach(id => aliases.add(id));
    const pair = item.branch!.key + '\0' + item.base;
    if (!item.deletedAt && pairs.has(pair)) throw new Error('同一分支和基点存在重复 CR');
    if (!item.deletedAt) pairs.add(pair);
  }
  for (const [branch, id] of Object.entries(data.activeByBranch)) if (!data.sessions.some(item => item.id === id && item.branch!.key === branch && !item.deletedAt)) throw new Error('当前分支的 CR 记录缺失');
  if (data.sessions.some(item => item.commentScopes?.some(alias => ids.has(alias))) ||
      data.sessions.some(item => new Set(item.commentScopes).size !== (item.commentScopes?.length || 0))) throw new Error('旧版评论归属冲突');
  if (data.purged !== undefined && (!data.purged || typeof data.purged !== 'object' || Array.isArray(data.purged) ||
      Object.entries(data.purged).some(([id, scopes]) => !isHash(id) || !Array.isArray(scopes) || !scopes.includes(id) || scopes.some(scope => !isHash(scope)) ||
        data.sessions.some(session => session.id === id ? !session.deletedAt : [session.id, ...(session.commentScopes || [])].some(scope => scopes.includes(scope)))))) {
    throw new Error('永久删除记录损坏');
  }
  return data;
}
function validateRecords(value: unknown): ReviewRecords {
  const data = value as { version: number; records: ReviewRecords };
  if (!data || data.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) throw new Error('审阅进度格式错误');
  const result: ReviewRecords = Object.create(null);
  for (const [name, record] of Object.entries(data.records)) {
    checkPath(name);
    if (!record || typeof record.reviewedAt !== 'string' || ![record.left, record.right].every(ref => ref && isHash(ref.hash) && isMode(ref.mode))) throw new Error('文件审阅记录损坏');
    result[name] = record;
  }
  return result;
}
export class ReviewState {
  readonly repositoryDirectory: string;
  private repo?: GitRepository;
  constructor(readonly storageRoot: string, readonly repositoryRoot: string) {
    this.repositoryDirectory = path.join(storageRoot, hash(repositoryRoot));
  }
  private async prepare(): Promise<void> {
    await fs.mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    await directory(this.storageRoot, hash(this.repositoryRoot), true);
  }
  private catalogFile(): string { return path.join(this.repositoryDirectory, 'reviews.json'); }
  async defaultBase(): Promise<DefaultBase | undefined> {
    if (!await directory(this.storageRoot, hash(this.repositoryRoot))) return undefined;
    return readJson(path.join(this.repositoryDirectory, 'default-base.json'), validateDefault);
  }
  async setDefaultBase(source: DefaultBase): Promise<void> {
    validateDefault({ version: 1, source });
    await this.prepare();
    await locked(this.repositoryDirectory, async () => {
      await this.defaultBase();
      await saveJson(path.join(this.repositoryDirectory, 'default-base.json'), { version: 1, source });
    });
  }
  private async catalog(): Promise<Catalog | undefined> {
    if (!await directory(this.storageRoot, hash(this.repositoryRoot))) return undefined;
    return readJson(this.catalogFile(), validateCatalog);
  }
  async active(branch?: ReviewBranch): Promise<Session | undefined> {
    branch ||= await (this.repo ||= await GitRepository.open(this.repositoryRoot)).branch();
    const catalog = await this.catalog(), id = catalog?.activeByBranch[branch.key];
    return catalog?.sessions.find(session => session.id === id && !session.deletedAt);
  }
  async sessions(): Promise<Session[]> { return (await this.catalog())?.sessions || []; }
  async isPurged(id: string): Promise<boolean> {
    return Object.values((await this.catalog())?.purged || {}).some(scopes => scopes.includes(id));
  }
  async pendingPurges(): Promise<string[]> {
    const catalog = await this.catalog();
    return catalog?.sessions.filter(session => catalog.purged?.[session.id]).map(session => session.id) || [];
  }
  private async assertRetained(id: string): Promise<void> {
    if (await this.isPurged(id)) throw new Error('这条 CR 已永久删除，不能恢复或写入');
  }
  async resume(repo: GitRepository, legacy?: LegacyComparison): Promise<Session | undefined> {
    this.repo = repo;
    const branch = await repo.branch();
    if (await this.catalog()) return this.active(branch);
    await this.prepare();
    await locked(this.repositoryDirectory, async () => {
      if (await this.catalog()) return;
      let old = await readJson(path.join(this.repositoryDirectory, 'sessions.json'), validateLegacyCatalog);
      if (!old && legacy) {
        const base = legacy.mergeBase ? await repo.forkPoint(legacy.base, legacy.mode === 'fixed' ? legacy.target : 'HEAD') : await repo.resolve(legacy.base);
        const session: Session = { id: legacyScope(legacy), base, label: '从旧版恢复', createdAt: new Date().toISOString() };
        old = { version: 2, active: session.id, sessions: [session] };
      }
      if (!old) return;
      const sessions: Session[] = [];
      for (const previous of old.sessions) {
        const owner = previous.id === old.active ? branch : { key: 'legacy:' + previous.id, label: '旧版未分配' };
        const session: Session = { ...previous, id: hash('code-review-v3-migration\0' + previous.id), branch: owner, commentScopes: [previous.id] };
        const copy = async (): Promise<void> => {
          const records = await this.records(previous);
          await directory(this.storageRoot, this.relative(session) + '/blobs', true);
          for (const record of Object.values(records)) for (const ref of [record.left, record.right]) {
            const snapshot = await this.snapshot(previous, ref);
            await atomicWrite(path.join(this.location(session), 'blobs', ref.hash), snapshot.data);
          }
          await saveJson(path.join(this.location(session), 'state.json'), { version: 1, records });
        };
        if (await directory(this.storageRoot, this.relative(previous))) await locked(this.location(previous), copy);
        else await copy();
        sessions.push(session);
      }
      const active = sessions.find(s => s.commentScopes?.includes(old!.active))!;
      await saveJson(this.catalogFile(), { version: 3, activeByBranch: { [branch.key]: active.id }, sessions });
    });
    return this.active(branch);
  }
  async select(base: string, label: string, branch?: ReviewBranch): Promise<Session> {
    if (!isCommit(base)) throw new Error('请先选择一个有效提交');
    const repo = this.repo ||= await GitRepository.open(this.repositoryRoot);
    if (!await this.catalog()) await this.resume(repo);
    branch ||= await repo.branch();
    if (!validBranch(branch) || branch.key.startsWith('legacy:')) throw new Error('当前分支无效');
    await this.prepare();
    return locked(this.repositoryDirectory, async () => {
      const catalog = await this.catalog() || { version: 3 as const, activeByBranch: {}, sessions: [] };
      let session = catalog.sessions.find(s => s.base === base && s.branch!.key === branch!.key && !s.deletedAt);
      if (!session) {
        session = { id: hash('code-review-v3\0' + this.repositoryRoot + '\0' + branch!.key + '\0' + base + '\0' + randomUUID()), base, label, branch, createdAt: new Date().toISOString() };
        catalog.sessions.push(session);
      }
      await this.records(session);
      session.lastUsedAt = new Date().toISOString(); catalog.activeByBranch[branch!.key] = session.id;
      await saveJson(this.catalogFile(), catalog); return session;
    });
  }
  async open(id: string, branch: ReviewBranch): Promise<void> {
    await locked(this.repositoryDirectory, async () => {
      const catalog = await this.catalog(), session = catalog?.sessions.find(s => s.id === id && !s.deletedAt);
      if (!catalog || !session) throw new Error('这条 CR 已删除或不存在，请刷新');
      if (session.branch!.key.startsWith('legacy:')) {
        if (catalog.sessions.some(s => !s.deletedAt && s.base === session.base && s.branch!.key === branch.key)) throw new Error('当前分支已有相同基点的 CR，旧版记录仍保留');
        session.branch = branch;
      }
      if (session.branch!.key !== branch.key) throw new Error('请先切换到分支 ' + session.branch!.label + '，这里不会自动切换 Git 分支');
      await this.records(session);
      session.lastUsedAt = new Date().toISOString(); catalog.activeByBranch[branch.key] = session.id;
      await saveJson(this.catalogFile(), catalog);
    });
  }
  async setDeleted(id: string, deleted: boolean): Promise<Session> {
    await this.prepare();
    return locked(this.repositoryDirectory, async () => {
      await this.assertRetained(id);
      const catalog = await this.catalog(), session = catalog?.sessions.find(s => s.id === id);
      if (!catalog || !session) throw new Error('CR 不存在，请刷新');
      if (deleted) {
        session.deletedAt ||= new Date().toISOString();
        if (catalog.activeByBranch[session.branch!.key] === id) delete catalog.activeByBranch[session.branch!.key];
      } else {
        if (catalog.sessions.some(s => s.id !== id && !s.deletedAt && s.branch!.key === session.branch!.key && s.base === session.base)) throw new Error('此分支已有相同基点的新 CR，请先删除新记录再恢复旧记录');
        delete session.deletedAt;
      }
      await saveJson(this.catalogFile(), catalog); return session;
    });
  }
  /** The UI confirms first. A content-free marker makes interrupted deletion retryable and blocks stale writers. */
  async purge(id: string, cleanComments: (session: Session) => Promise<void>, invalidate?: (session: Session) => Promise<void>): Promise<void> {
    if (!isHash(id)) throw new Error('无效审阅标识');
    await this.prepare();
    await locked(this.repositoryDirectory, async () => {
      const catalog = await this.catalog(), session = catalog?.sessions.find(item => item.id === id);
      if (!catalog) throw new Error('CR 不存在，请刷新');
      if (!session) {
        if (catalog.purged?.[id]) return;
        throw new Error('CR 不存在，请刷新');
      }
      const scopes = [id, ...(session.commentScopes || [])];
      session.deletedAt ||= new Date().toISOString();
      if (catalog.activeByBranch[session.branch!.key] === id) delete catalog.activeByBranch[session.branch!.key];
      // Block old extension hosts first, but keep this stage recoverable if the handoff cannot be invalidated.
      await saveJson(this.catalogFile(), catalog);
      await invalidate?.(session);
      // v3 hosts do not understand permanent deletion. Reject their writes once content removal can begin.
      catalog.version = 4;
      (catalog.purged ||= Object.create(null))[id] = scopes;
      validateCatalog(catalog);
      await saveJson(this.catalogFile(), catalog);
      await cleanComments(session);
      for (const scope of scopes) {
        const relative = hash(this.repositoryRoot) + '/' + scope;
        if (!await directory(this.storageRoot, relative)) continue;
        const folder = path.join(this.storageRoot, relative);
        await locked(folder, async () => {
          await directory(this.storageRoot, relative);
          for (const entry of await fs.readdir(folder)) if (entry !== 'write.lock') {
            await fs.rm(path.join(folder, entry), { recursive: true, force: true });
          }
        });
        await fs.rmdir(folder);
      }
      // v2 migration preserved old copies. Scrub both catalogs so an old backup cannot restore this CR.
      for (const name of ['sessions.json', 'sessions.json.bak']) {
        const file = path.join(this.repositoryDirectory, name);
        let old: LegacyCatalog;
        try { old = validateLegacyCatalog(JSON.parse((await readBytes(file, 16 * 1024 * 1024)).toString('utf8'))); }
        catch (error) { if (missing(error)) continue; throw error; }
        old.sessions = old.sessions.filter(item => !scopes.includes(item.id));
        if (!old.sessions.length) await fs.unlink(file);
        else {
          if (scopes.includes(old.active)) old.active = old.sessions[0].id;
          await atomicWrite(file, JSON.stringify(old, null, 2) + '\n');
        }
      }
      catalog.sessions = catalog.sessions.filter(item => item.id !== id);
      const text = JSON.stringify(catalog, null, 2) + '\n';
      // Unlike ordinary edits, a permanent deletion must not leave the removed record in the previous-version backup.
      await atomicWrite(this.catalogFile() + '.bak', text);
      await atomicWrite(this.catalogFile(), text);
    });
  }
  private relative(session: Session): string {
    if (!isHash(session.id)) throw new Error('无效审阅标识');
    return hash(this.repositoryRoot) + '/' + session.id;
  }
  location(session: Session): string { return path.join(this.storageRoot, this.relative(session)); }
  async records(session: Session): Promise<ReviewRecords> {
    if (!await directory(this.storageRoot, this.relative(session))) return Object.create(null);
    const records = await readJson(path.join(this.location(session), 'state.json'), validateRecords) || Object.create(null);
    const checked = new Set<string>();
    for (const record of Object.values(records) as ReviewedFile[]) {
      for (const reference of [record.left, record.right]) {
        if (checked.has(reference.mode + reference.hash)) continue;
        await this.snapshot(session, reference); checked.add(reference.mode + reference.hash);
      }
    }
    return records;
  }
  async snapshot(session: Session, ref: SnapshotRef): Promise<Snapshot> {
    if (!isMode(ref.mode) || !isHash(ref.hash)) throw new Error('快照信息损坏');
    await directory(this.storageRoot, this.relative(session) + '/blobs');
    const data = await readBytes(path.join(this.location(session), 'blobs', ref.hash), FILE_LIMIT);
    const result = { mode: ref.mode, data };
    if (snapshotId(result) !== ref.hash) throw new Error('审阅快照校验失败；原数据已保留');
    return result;
  }
  async record(session: Session, changes: { path: string; pair?: Pair }[], beforeWrite?: () => Promise<void>): Promise<void> {
    if (!changes.length) return;
    await this.prepare();
    await locked(this.repositoryDirectory, async () => {
      await this.assertRetained(session.id);
      await directory(this.storageRoot, this.relative(session) + '/blobs', true);
      const folder = this.location(session);
      await locked(folder, async () => {
        await beforeWrite?.();
        const records = await this.records(session);
        for (const change of changes) {
          checkPath(change.path);
          if (!change.pair) { delete records[change.path]; continue; }
          const refs: SnapshotRef[] = [];
          for (const snapshot of [change.pair.left, change.pair.right]) {
            if (snapshot.data.length > FILE_LIMIT || !isMode(snapshot.mode)) throw new Error('文件无法保存为快照');
            const ref = { mode: snapshot.mode, hash: snapshotId(snapshot) };
            await atomicWrite(path.join(folder, 'blobs', ref.hash), snapshot.data);
            refs.push(ref);
          }
          records[change.path] = { left: refs[0], right: refs[1], reviewedAt: new Date().toISOString() };
        }
        await saveJson(path.join(folder, 'state.json'), { version: 1, records });
      });
    });
  }
}
