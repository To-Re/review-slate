import type { Bootstrap, DiffView, Draft, Failure, FolderPickResult, Handoff, Language, Navigation, Preferences, Reply, Request, ViewState, WorkspaceView } from '../../src/codex/contract';
import { Bridge, UnknownResult } from './bridge';
import { equalData, localeFor, refreshDelay, targetKey } from './model';

type Action = Request['action'];
export const newId = (): string => crypto.randomUUID();
export const emptyNavigation = (): Navigation => ({ expanded: [], mode: 'full', side: 'right', commentsMode: 'target', filter: '' });
const reads = new Set<Action>(['refresh', 'bases', 'diff', 'inspectReview', 'operation', 'pickFolder', 'folderPickerResult', 'cancelFolderPicker']);
export class RequestFailure extends Error { constructor(readonly failure: Failure) { super(failure.code); } }

export class Store {
  bootstrap?: Bootstrap;
  workspace?: WorkspaceView;
  diff?: DiffView;
  navigation: Navigation = emptyNavigation();
  drafts: Draft[] = [];
  viewRevision = 0;
  sequence = 0;
  savedSequence = 0;
  generation = 0;
  busy = false;
  refreshing = false;
  nextRefreshAt = 0;
  preferenceBusy = false;
  loadingDiff = false;
  stale = false;
  error?: Failure;
  unknown?: Request;
  retryableUnknown = false;
  unknownState?: 'pending' | 'not-found';
  recoveredHandoff?: Handoff;
  saveState: 'saved' | 'dirty' | 'saving' | 'failed' = 'saved';
  onChange: () => void = () => {};
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private refreshTask?: Promise<void>;
  private diffTask?: { key: string; promise: Promise<void> };
  private diffSequence = 0;
  private workspaceGeneration = 0;
  private composing = false;
  private compositionWaiters: (() => void)[] = [];
  private cache = new Map<string, { navigation: Navigation; drafts: Draft[]; revision: number; sequence: number; saved: number }>();
  constructor(readonly bridge: Bridge) {}
  get locale() { return localeFor(this.bootstrap?.preferences.language || 'auto', this.bridge.context.locale); }
  get writable() { return !!this.workspace?.context && !this.workspace.active?.deletedAt && !this.workspace.active?.purgePending && !this.stale && !this.unknown && !this.busy; }
  changed(): void { this.onChange(); }
  async connect(): Promise<void> {
    await this.bridge.initialize();
    this.bootstrap = this.unwrap(await this.bridge.bootstrap());
    this.changed();
  }
  private unwrap<T>(reply: Reply<T>): T {
    if (!reply.ok || reply.outcome === 'unknown' || reply.outcome === 'partial' || reply.data === undefined) {
      throw new RequestFailure(reply.error || { code: 'UNKNOWN_RESULT', message: '', outcome: 'unknown', retry: 'reconnect' });
    }
    return reply.data;
  }
  async request<T>(action: Action, payload: unknown, operationId?: string, reportError = true): Promise<T> {
    if (!this.bootstrap) throw new Error('NOT_INITIALIZED');
    const request = { protocol: 1, capability: this.bootstrap.capability, viewId: this.bootstrap.viewId,
      workspaceId: this.workspace?.workspace.id, context: this.workspace?.context, action, payload,
      ...(!reads.has(action) ? { operationId: operationId || newId() } : {}),
    } as Request;
    try {
      const reply = await this.bridge.call<T>(request);
      if (['unknown', 'partial'].includes(reply.outcome) && request.operationId) this.unknown = request;
      return this.unwrap(reply);
    } catch (error) {
      if (error instanceof UnknownResult && request.operationId) this.unknown = request;
      if (reportError) this.fail(error); throw error;
    }
  }
  folderPicker(action: 'pickFolder' | 'folderPickerResult' | 'cancelFolderPicker', requestId: string): Promise<FolderPickResult> {
    // Selection has no business mutation and must never put review saves into unknown/partial state.
    return this.request<FolderPickResult>(action, action === 'pickFolder' ? { requestId, locale: this.locale } : { requestId }, undefined, false);
  }
  fail(error: unknown): void {
    this.error = error instanceof RequestFailure ? error.failure : { code: 'UNKNOWN_RESULT', message: '', outcome: 'unknown', retry: 'reconnect' };
    if (['STALE_CONTEXT', 'CONTENT_CHANGED', 'REPOSITORY_UNAVAILABLE', 'ACCESS_DENIED', 'STORE_CORRUPT'].includes(this.error.code)) this.stale = true;
    this.changed();
  }
  private key(view = this.workspace): string { return view?.active ? `${view.workspace.id}:${view.active.id}` : ''; }
  private remember(): void {
    const key = this.key();
    if (key) this.cache.set(key, { navigation: structuredClone(this.navigation), drafts: structuredClone(this.drafts), revision: this.viewRevision, sequence: this.sequence, saved: this.savedSequence });
  }
  apply(view: WorkspaceView): void {
    const before = this.key(), after = this.key(view);
    if (before !== after) {
      this.remember();
      const cached = this.cache.get(after), recovery = view.recovery;
      this.navigation = structuredClone(cached?.navigation || recovery?.navigation || emptyNavigation());
      this.drafts = structuredClone(cached?.drafts || recovery?.drafts || []);
      this.viewRevision = cached?.revision ?? (recovery && recovery.viewId === this.bootstrap?.viewId ? recovery.revision : 0);
      this.sequence = cached?.sequence ?? recovery?.sequence ?? 1;
      this.savedSequence = cached?.saved ?? (recovery?.viewId === this.bootstrap?.viewId ? this.sequence : -1);
      this.saveState = !view.context || this.sequence === this.savedSequence ? 'saved' : 'dirty';
      this.diff = undefined; this.generation++;
    }
    // A new context still comes from the fresh response, while unchanged lists keep their render index.
    if (before === after && this.workspace?.workspace.id === view.workspace.id) {
      if (equalData(this.workspace.files, view.files)) view.files = this.workspace.files;
      if (equalData(this.workspace.comments, view.comments)) view.comments = this.workspace.comments;
    }
    this.workspace = view; this.stale = false; this.error = undefined;
    if (!view.context) this.saveState = 'saved';
    this.changed();
    if (this.savedSequence !== this.sequence && view.context && !this.unknown && !this.composing) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => { void this.flush().catch(() => {}); }, 550);
    }
  }
  async open(root: string, initialize = false): Promise<void> {
    await this.flush();
    if (this.busy || this.unknown) return;
    this.busy = true; this.workspaceGeneration++; this.changed();
    try {
      let view: WorkspaceView;
      try { view = await this.request<WorkspaceView>('openWorkspace', { root, initialize }, undefined, false); }
      catch (error) {
        // A rejected candidate is a dialog error, not evidence that the current repository is stale.
        // Old-CR flush errors remain global; uncertain writes and connection failures still guard it.
        const candidateRejected = !initialize && root !== this.workspace?.workspace.root &&
          error instanceof RequestFailure && error.failure.outcome === 'rejected' && error.failure.retry !== 'reconnect' && !this.unknown;
        if (!candidateRejected) this.fail(error);
        throw error;
      }
      // Keep the original in-flight Diff alive until a new workspace has actually been adopted.
      this.generation++; this.loadingDiff = false;
      this.apply(view); this.rememberRecent(view);
      await this.loadDiff();
    } finally { this.busy = false; this.changed(); }
  }
  private rememberRecent(view: WorkspaceView): void {
    if (!this.bootstrap) return;
    const repository = view.workspace;
    this.bootstrap.preferences = { ...this.bootstrap.preferences, lastWorkspaceId: repository.id,
      recent: [{ id: repository.id, name: repository.name, root: repository.root, lastOpened: new Date().toISOString() },
        ...this.bootstrap.preferences.recent.filter(item => item.id !== repository.id)].slice(0, 20) };
  }
  async mutate(action: Action, payload: unknown): Promise<void> {
    await this.flush();
    if (this.busy || this.unknown) return;
    this.busy = true; this.workspaceGeneration++; this.generation++; this.changed();
    try { this.apply(await this.request<WorkspaceView>(action, payload)); await this.loadDiff(); }
    finally { this.busy = false; this.changed(); }
  }
  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    if (!this.workspace || this.busy || this.unknown) return Promise.resolve();
    this.refreshTask = this.refreshWorkspace().finally(() => { this.refreshTask = undefined; });
    return this.refreshTask;
  }
  private async refreshWorkspace(): Promise<void> {
    const original = this.workspace!, workspaceGeneration = this.workspaceGeneration, started = Date.now();
    let adopted = original;
    this.refreshing = true; this.changed();
    try {
      await this.flush();
      if (this.workspace !== original || this.workspaceGeneration !== workspaceGeneration || this.busy || this.unknown) return;
      const view = await this.request<WorkspaceView>(original.active?.deletedAt ? 'inspectReview' : 'refresh', original.active?.deletedAt ? { reviewId: original.active.id } : {}, undefined, false);
      // Navigation may continue during a scan. A business switch or write supersedes its result.
      if (this.workspace !== original || this.workspaceGeneration !== workspaceGeneration || this.busy || this.unknown) return;
      // Refresh never silently binds this window's input to another active CR.
      if (original.active && view.active?.id !== original.active.id) throw new RequestFailure({ code: 'STALE_CONTEXT', message: '', outcome: 'rejected', retry: 'refresh' });
      this.apply(view); adopted = this.workspace!; await this.loadDiff();
    } catch (error) {
      if (this.workspace === adopted && this.workspaceGeneration === workspaceGeneration && !this.busy) { this.stale = true; this.fail(error); throw error; }
    } finally {
      this.refreshing = false; this.nextRefreshAt = Date.now() + refreshDelay(Date.now() - started); this.changed();
    }
  }
  async select(target: Navigation['target'], mode = this.navigation.mode): Promise<void> {
    await this.flush();
    if (this.busy || this.unknown) return;
    this.generation++; this.diff = undefined;
    this.navigation = { ...this.navigation, target, mode, line: undefined, fingerprint: undefined, anchor: undefined, scroll: undefined };
    this.touch(); this.changed(); await this.loadDiff();
  }
  loadDiff(): Promise<void> {
    if (this.navigation.target?.type !== 'file' || !this.workspace?.active) { this.diff = undefined; this.loadingDiff = false; this.changed(); return Promise.resolve(); }
    const key = JSON.stringify([this.generation, this.workspace.workspace.id, this.workspace.active.id, this.workspace.context?.revision, this.navigation.target.path, this.navigation.mode, this.navigation.mode === 'since' ? 'right' : this.navigation.side]);
    if (this.diffTask?.key === key) return this.diffTask.promise;
    const promise = this.readDiff().finally(() => { if (this.diffTask?.promise === promise) this.diffTask = undefined; });
    this.diffTask = { key, promise }; return promise;
  }
  private async readDiff(): Promise<void> {
    const generation = this.generation, sequence = ++this.diffSequence, target = targetKey(this.navigation.target), mode = this.navigation.mode;
    const context = this.workspace!.context;
    let refreshChangedFile = false;
    this.loadingDiff = true; this.changed();
    try {
      const diff = await this.request<DiffView>('diff', { path: this.navigation.target!.path, mode, side: mode === 'since' ? 'right' : this.navigation.side,
        ...(this.workspace!.active!.deletedAt ? { reviewId: this.workspace!.active!.id } : {}) }, undefined, false);
      if (generation !== this.generation || sequence !== this.diffSequence || targetKey(this.navigation.target) !== target || this.navigation.mode !== mode) return;
      if (this.diff && equalData(this.diff.comments, diff.comments)) diff.comments = this.diff.comments;
      this.diff = diff;
      // A scan can adopt a newer projection while this exact-file read is in flight.
      if (diff.context && this.workspace && this.workspace.context === context) this.workspace.context = diff.context;
      const row = this.workspace?.files.find(file => file.path === diff.target.path);
      if (!diff.archived && row && row.fingerprint !== diff.fingerprint) {
        this.stale = true;
        this.error = { code: 'CONTENT_CHANGED', message: '', outcome: 'rejected', retry: 'refresh' };
        refreshChangedFile = !this.refreshing;
      }
    } catch (error) {
      if (generation === this.generation && sequence === this.diffSequence) { this.stale = true; this.fail(error); throw error; }
    } finally { if (generation === this.generation && sequence === this.diffSequence) { this.loadingDiff = false; this.changed(); } }
    // Show the fresh file immediately. Only a detected change needs a new whole-workspace projection.
    // A second change during that refresh stays explicitly stale instead of starting a scan loop.
    if (refreshChangedFile && generation === this.generation && sequence === this.diffSequence && !this.busy && !this.unknown) void this.refresh().catch(() => {});
  }
  touch(): void {
    if (!this.workspace?.context) return;
    this.sequence++; this.saveState = 'dirty';
    clearTimeout(this.saveTimer);
    if (this.workspace?.context && !this.unknown && !this.composing) this.saveTimer = setTimeout(() => { void this.flush().catch(() => {}); }, 550);
  }
  setComposing(value: boolean): void {
    this.composing = value; clearTimeout(this.saveTimer);
    if (!value) {
      this.compositionWaiters.splice(0).forEach(resolve => resolve());
      if (this.sequence !== this.savedSequence && !this.unknown) this.saveTimer = setTimeout(() => { void this.flush().catch(() => {}); }, 550);
    }
  }
  async flush(retainInactive = false): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.composing) await new Promise<void>(resolve => this.compositionWaiters.push(resolve));
    if (this.saving) await this.saving;
    if (!this.workspace?.context || !this.workspace.active || this.sequence === this.savedSequence) return;
    if (this.unknown) throw new UnknownResult();
    this.saving = this.saveLoop(retainInactive);
    try { await this.saving; } finally { this.saving = undefined; }
  }
  private async saveLoop(retainInactive = false): Promise<void> {
    while (this.savedSequence !== this.sequence) {
      if (this.composing) await new Promise<void>(resolve => this.compositionWaiters.push(resolve));
      const sequence = this.sequence;
      this.saveState = 'saving'; this.changed();
      try {
        const view = await this.request<ViewState>('saveView', { reviewId: this.workspace!.active!.id,
          expectedRevision: this.viewRevision, sequence, navigation: structuredClone(this.navigation), drafts: structuredClone(this.drafts),
          ...(retainInactive ? { retainInactive: true } : {}) });
        this.viewRevision = view.revision; this.savedSequence = sequence;
      } catch (error) { this.saveState = 'failed'; this.changed(); throw error; }
    }
    this.saveState = 'saved'; this.remember(); this.changed();
  }
  /** Explicit recovery only: preserve the original CR's input before entering the actual active branch/review. */
  async retainAndRefresh(): Promise<boolean> {
    if (!this.workspace?.context || !this.bootstrap || this.busy || this.unknown) return false;
    this.busy = true; this.workspaceGeneration++; this.generation++; this.changed();
    try {
      // A failed reconnect may already have issued a new capability. Bind the repository without applying its new CR.
      await this.request<WorkspaceView>('openWorkspace', { root: this.workspace.workspace.root, initialize: false });
      this.workspace.context = { ...this.workspace.context, epoch: this.bootstrap.epoch };
      await this.flush(true);
      const view = await this.request<WorkspaceView>('refresh', {});
      this.apply(view); await this.loadDiff(); return true;
    } catch (error) { this.fail(error); throw error; }
    finally { this.busy = false; this.changed(); }
  }
  async language(language: Language): Promise<void> {
    if (this.busy || this.preferenceBusy || this.unknown) return;
    this.preferenceBusy = true; this.changed();
    try {
      const preferences = await this.request<Preferences>('preferences', { language });
      this.bootstrap!.preferences = preferences;
    } finally { this.preferenceBusy = false; this.changed(); }
  }
  private acceptOperation(request: Request, data: unknown): void {
    if (request.action === 'preferences') this.bootstrap!.preferences = data as Preferences;
    else if (request.action === 'saveView') { /* The receipt belongs to the old view slot. Keep the current buffer and CAS. */ }
    else if (request.action === 'handoff') this.recoveredHandoff = data as Handoff;
    else {
      const view = data as WorkspaceView;
      if (!view?.workspace || !Array.isArray(view.files)) throw new UnknownResult();
      const canChangeReview = ['openWorkspace', 'chooseBase', 'openReview', 'archiveReview', 'restoreReview', 'purgeReview'].includes(request.action);
      if (!canChangeReview && this.workspace?.active?.id !== view.active?.id) throw new RequestFailure({ code: 'STALE_CONTEXT', message: '', outcome: 'rejected', retry: 'refresh' });
      this.apply(view);
      if (request.action === 'openWorkspace') this.rememberRecent(view);
      if (request.action === 'addComment') {
        const draft = this.drafts.find(item => item.requestId === request.payload.requestId);
        if (draft?.body === request.payload.body) this.drafts = this.drafts.filter(item => item !== draft);
        else if (draft) draft.requestId = newId();
      }
      if (request.action === 'changeComment' && request.payload.change === 'edit') {
        const draft = this.drafts.find(item => item.commentId === request.payload.id), comment = view.comments.find(item => item.id === request.payload.id);
        if (draft?.body === request.payload.body) this.drafts = this.drafts.filter(item => item !== draft);
        else if (draft && comment) { draft.commentRevision = comment.revision; draft.commentState = comment.state; }
      }
    }
  }
  private async rebindWorkspace(): Promise<void> {
    const before = this.workspace;
    if (!before) return;
    const view = await this.request<WorkspaceView>('openWorkspace', { root: before.workspace.root, initialize: false });
    if (before.active?.deletedAt) {
      this.apply(await this.request<WorkspaceView>('inspectReview', { reviewId: before.active.id })); return;
    }
    if (before.active && (view.workspace.id !== before.workspace.id || view.active?.id !== before.active.id ||
      view.active.base !== before.active.base || view.branch.key !== before.branch.key || !view.context)) {
      throw new RequestFailure({ code: 'STALE_CONTEXT', message: '', outcome: 'rejected', retry: 'refresh' });
    }
    this.apply(view);
  }
  async reconnect(): Promise<void> {
    const pending = this.unknown, oldLanguage = this.bootstrap?.preferences.language;
    this.generation++; this.workspaceGeneration++; this.busy = true; this.retryableUnknown = false; this.unknownState = undefined; this.changed();
    try {
      this.bootstrap = this.unwrap(await this.bridge.bootstrap());
      if (pending?.action === 'preferences' && oldLanguage) this.bootstrap.preferences.language = oldLanguage;
      this.remember();
      for (const cached of this.cache.values()) { cached.revision = 0; cached.saved = -1; }
      this.viewRevision = 0; this.savedSequence = -1;
      let rejected: Failure | undefined;
      // Query before opening any repository. No mutation is automatically replayed.
      if (pending?.operationId) {
        const result = await this.request<{ status: 'committed' | 'rejected' | 'pending' | 'not-found'; result?: Reply }>('operation', { operationId: pending.operationId });
        if (result.status === 'pending') {
          this.unknownState = 'pending'; this.retryableUnknown = true;
          throw new UnknownResult();
        }
        if (result.status === 'not-found') {
          await this.rebindWorkspace(); this.unknown = pending; this.retryableUnknown = true; this.unknownState = 'not-found';
          throw new RequestFailure({ code: 'UNKNOWN_RESULT', message: '', outcome: 'rejected', retry: 'same-operation' });
        }
        if (!result.result) throw new UnknownResult();
        if (result.status === 'rejected' || !result.result.ok) rejected = result.result.error || { code: 'IO_FAILED', message: '', outcome: 'rejected', retry: 'same-operation' };
        else this.acceptOperation(pending, this.unwrap(result.result));
        this.unknown = undefined;
      }
      await this.rebindWorkspace();
      this.stale = false; this.error = undefined;
      await this.flush(); await this.loadDiff();
      if (rejected) throw new RequestFailure(rejected);
    } catch (error) { this.fail(error); throw error; }
    finally { this.busy = false; this.changed(); }
  }
  async retryUnknown(): Promise<void> {
    if (!this.unknown || !this.retryableUnknown || !this.bootstrap || this.busy) return;
    const original = this.unknown;
    if (original.action === 'saveView' && this.unknownState === 'not-found') {
      // The old intent provably never existed. Explicitly retain the current buffer in the new view.
      this.unknown = undefined; this.retryableUnknown = false; this.unknownState = undefined;
      this.savedSequence = -1; this.error = undefined; await this.flush(); return;
    }
    const request = { ...original, capability: this.bootstrap.capability, viewId: this.bootstrap.viewId,
      context: original.context ? { ...original.context, epoch: this.bootstrap.epoch } : undefined,
    } as Request;
    this.generation++; this.workspaceGeneration++; this.busy = true; this.retryableUnknown = false; this.changed();
    try {
      const reply = await this.bridge.call(request);
      if (!reply.ok && reply.outcome === 'rejected') this.unknown = undefined;
      const data = this.unwrap(reply); this.acceptOperation(request, data); this.unknown = undefined; this.unknownState = undefined;
      // A pending lookup returns before reconnect can rebind. Verify the original CR against the new process
      // before saving newer input; changing only the retried request's epoch leaves the page context stale.
      await this.rebindWorkspace();
      this.error = undefined; this.stale = false;
      this.touch();
      await this.flush(); await this.loadDiff();
    } catch (error) { this.fail(error); throw error; }
    finally { this.busy = false; this.changed(); }
  }
}
