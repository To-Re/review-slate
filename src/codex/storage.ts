import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { directory, locked, readJson, saveJson, atomicWrite } from '../filesystem';
import { hash, missing } from '../model';
import { ensureNotesIgnored } from '../ignore';
import { Failure, Preferences, Request, ViewState } from './contract';
import { navigationSchema, draftSchema } from './validation';
import { ClientError } from './errors';

export const CODEX_FOLDER = '.reviewslate/codex';
interface Marker { owner: 'reviewslate.codex'; version: 1; repository: string; ready: boolean }
const defaultPreferences = (): Preferences => ({ language: 'auto', recent: [] });
const isUuid = (id: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
async function saveBoundedJson(file: string, value: unknown): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n', 'utf8') > 16 * 1024 * 1024) {
    throw new ClientError('UNSUPPORTED_CONTENT', 'This saved state exceeds the local JSON size limit. The previous copy was kept.', 'none');
  }
  await saveJson(file, value);
}
function validatePreferences(value: unknown): Preferences {
  const p = value as Preferences & { version: number };
  if (!p || p.version !== 1 || !['auto', 'zh-CN', 'en'].includes(p.language) || !Array.isArray(p.recent) || p.recent.length > 20 ||
    p.recent.some(r => !r || !/^[a-f0-9]{64}$/.test(r.id) || typeof r.root !== 'string' || !path.isAbsolute(r.root) || typeof r.name !== 'string' || typeof r.lastOpened !== 'string') ||
    (p.lastWorkspaceId !== undefined && !/^[a-f0-9]{64}$/.test(p.lastWorkspaceId))) throw new ClientError('STORE_CORRUPT', 'Application preferences are invalid; original data was kept.', 'repair');
  return { language: p.language, recent: p.recent, ...(p.lastWorkspaceId ? { lastWorkspaceId: p.lastWorkspaceId } : {}) };
}
/** Resolve system aliases in the existing parent, but never follow a link at the owned root. */
export async function privateRoot(requested: string, create: boolean): Promise<string | undefined> {
  const root = path.resolve(requested), suffix: string[] = [];
  let ancestor = root;
  for (;;) {
    try {
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ClientError('ACCESS_DENIED', 'Data storage must use ordinary directories.', 'repair');
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return undefined;
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  ancestor = await fs.realpath(ancestor);
  await directory(ancestor, suffix.join('/'), create);
  return path.join(ancestor, ...suffix);
}
export class Registry {
  constructor(readonly root: string) {}
  async read(): Promise<Preferences> {
    const root = await privateRoot(this.root, false);
    return root ? await readJson(path.join(root, 'registry.json'), validatePreferences) || defaultPreferences() : defaultPreferences();
  }
  async update(change: (current: Preferences) => Preferences, operationId?: string): Promise<Preferences> {
    const root = (await privateRoot(this.root, true))!;
    return locked(root, async () => {
      const document = await this.document(), current = document ? validatePreferences(document) : defaultPreferences();
      if (operationId && document?.operations[operationId]) return current;
      const next = change(current), operations = { ...(document?.operations || {}) };
      if (operationId) operations[operationId] = true;
      await saveBoundedJson(path.join(root, 'registry.json'), { version: 1, ...next, operations }); return next;
    });
  }
  private async document(): Promise<(Preferences & { version: 1; operations: Record<string, true> }) | undefined> {
    const root = await privateRoot(this.root, false);
    if (!root) return undefined;
    return readJson(path.join(root, 'registry.json'), value => {
      const p = validatePreferences(value), operations = (value as { operations?: Record<string, true> }).operations || {};
      if (typeof operations !== 'object' || Array.isArray(operations) || Object.entries(operations).some(([id, flag]) => !isUuid(id) || flag !== true)) {
        throw new ClientError('STORE_CORRUPT', 'Application operation markers are invalid.', 'repair');
      }
      return { version: 1, ...p, operations };
    });
  }
  async committed(id: string): Promise<boolean> { return !!(await this.document())?.operations[id]; }
  async operation(id: string): Promise<ApplicationOperation | undefined> {
    const root = await privateRoot(this.root, false);
    if (!root || !await directory(root, 'operations')) return undefined;
    return readJson(path.join(root, 'operations', id + '.json'), value => {
      const op = value as ApplicationOperation;
      if (!op || op.version !== 1 || op.id !== id || !/^[a-f0-9]{64}$/.test(op.hash) || !['pending', 'committed', 'rejected'].includes(op.status) ||
        (op.root !== undefined && !path.isAbsolute(op.root))) throw new ClientError('STORE_CORRUPT', 'Application operation routing is invalid.', 'repair');
      return op;
    });
  }
  async record(next: ApplicationOperation): Promise<ApplicationOperation> {
    const root = (await privateRoot(this.root, true))!;
    await directory(root, 'operations', true);
    return locked(path.join(root, 'operations'), async () => {
      const old = await this.operation(next.id);
      if (old && old.hash !== next.hash) throw new ClientError('INVALID_REQUEST', 'The same operation ID cannot be reused for different input.', 'none');
      if (old?.status === 'committed' || old?.status === 'rejected') return old;
      // Retrying a pending intent must never transfer ownership to the reconnecting view.
      const value = old ? { ...old, status: next.status, ...(next.failure ? { failure: next.failure } : {}) } : next;
      await saveBoundedJson(path.join(root, 'operations', next.id + '.json'), value); return value;
    });
  }
}
/** Routing and commit markers never contain comments, code, or draft text. */
export interface ApplicationOperation {
  version: 1; id: string; hash: string; action: Request['action']; status: 'pending' | 'committed' | 'rejected';
  root?: string; reviewId?: string; viewId: string; failure?: Failure;
}
export function validateView(value: unknown): ViewState {
  const v = value as ViewState;
  if (!v || v.version !== 1 || !isUuid(v.viewId) || !/^[a-f0-9]{64}$/.test(v.reviewId) || !Number.isSafeInteger(v.revision) || v.revision < 1 ||
    !Number.isSafeInteger(v.sequence) || v.sequence < 1 || typeof v.updatedAt !== 'string' || !Array.isArray(v.drafts) || v.drafts.length > 200) {
    throw new ClientError('STORE_CORRUPT', 'Saved view data is invalid; original data was kept.', 'repair');
  }
  navigationSchema.parse(v.navigation); v.drafts.forEach(draft => draftSchema.parse(draft));
  return v;
}
export class WorkspaceStore {
  readonly id: string;
  readonly root: string;
  constructor(readonly repository: string) { this.id = hash(repository); this.root = path.join(repository, CODEX_FOLDER); }
  async marker(): Promise<Marker | undefined> {
    if (!await directory(this.repository, CODEX_FOLDER)) return undefined;
    return readJson(path.join(this.root, 'project.json'), value => {
      const m = value as Marker;
      if (!m || m.owner !== 'reviewslate.codex' || m.version !== 1 || m.repository !== this.id || typeof m.ready !== 'boolean') {
        throw new ClientError('STORE_CORRUPT', 'ReviewSlate data belongs to another location, application, or unsupported version.', 'repair');
      }
      return m;
    });
  }
  async initialize(initializeNotes: () => Promise<void>): Promise<void> {
    await directory(this.repository, CODEX_FOLDER, true);
    await locked(this.root, async () => {
      let marker = await this.marker();
      if (!marker) {
        if ((await fs.readdir(this.root)).some(name => name !== 'write.lock')) throw new ClientError('STORE_CORRUPT', 'The storage folder is not empty and has no ownership marker.', 'repair');
        marker = { owner: 'reviewslate.codex', version: 1, repository: this.id, ready: false };
        await saveJson(path.join(this.root, 'project.json'), marker);
      }
      if (marker.ready) return;
      await directory(this.repository, CODEX_FOLDER + '/engine', true);
      await directory(this.repository, CODEX_FOLDER + '/operations', true);
      await initializeNotes();
      await ensureNotesIgnored(this.repository, CODEX_FOLDER);
      await saveJson(path.join(this.root, 'project.json'), { ...marker, ready: true });
    });
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (!(await this.marker())?.ready) throw new ClientError('NOT_INITIALIZED', 'Enable ReviewSlate for this repository before saving.', 'none');
    return locked(this.root, operation);
  }
  async readView(reviewId: string, viewId: string): Promise<ViewState | undefined> {
    const relative = `views/${reviewId}/${viewId}`;
    if (!await directory(this.root, relative)) return undefined;
    const value = await readJson(path.join(this.root, relative, 'view.json'), validateView);
    if (value && (value.viewId !== viewId || value.reviewId !== reviewId)) throw new ClientError('STORE_CORRUPT', 'Saved view ownership does not match its path.', 'repair');
    return value;
  }
  async latestView(reviewId: string): Promise<ViewState | undefined> {
    if (!await directory(this.root, 'views/' + reviewId)) return undefined;
    const states: ViewState[] = [];
    for (const name of await fs.readdir(path.join(this.root, 'views', reviewId))) {
      if (!isUuid(name)) continue;
      const state = await this.readView(reviewId, name); if (state) states.push(state);
    }
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }
  async saveView(next: ViewState, expectedRevision: number): Promise<ViewState> {
    const old = await this.readView(next.reviewId, next.viewId);
    const same = old && old.sequence === next.sequence && JSON.stringify(old.navigation) === JSON.stringify(next.navigation) && JSON.stringify(old.drafts) === JSON.stringify(next.drafts);
    if (same) return old;
    if ((old?.revision || 0) !== expectedRevision || next.sequence <= (old?.sequence || 0)) throw new ClientError('REVISION_CONFLICT', 'The saved draft changed. Keep this input and reload the saved copy.');
    const value = validateView({ ...next, revision: expectedRevision + 1 });
    // Check serialized UTF-8 bytes, not JS character counts; a valid set of Unicode anchors can exceed the reader limit.
    if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n', 'utf8') > 16 * 1024 * 1024) {
      throw new ClientError('UNSUPPORTED_CONTENT', 'The combined draft state is too large. The previous saved copy was kept.', 'none');
    }
    await directory(this.root, `views/${next.reviewId}/${next.viewId}`, true);
    await saveJson(path.join(this.root, 'views', next.reviewId, next.viewId, 'view.json'), value);
    return value;
  }
  async purgeAuxiliary(reviewId: string): Promise<void> {
    for (const folder of ['views', 'handoffs']) {
      if (await directory(this.root, folder + '/' + reviewId)) await fs.rm(path.join(this.root, folder, reviewId), { recursive: true });
    }
    // Operation receipts contain no comment/code payload. Retain them as duplicate-request tombstones.
  }
  async writeImmutable(relative: string, value: unknown): Promise<void> {
    await directory(this.root, path.posix.dirname(relative), true);
    const file = path.join(this.root, relative);
    try { await fs.lstat(file); throw new ClientError('REVISION_CONFLICT', 'An immutable handoff already exists.'); }
    catch (error) { if (!missing(error)) throw error; }
    await atomicWrite(file, JSON.stringify(value, null, 2) + '\n', null);
  }
}
