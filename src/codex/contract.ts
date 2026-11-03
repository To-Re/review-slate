/** Shared, serializable Codex protocol. No Node or host imports: also consumed by the UI. */
export const PROTOCOL_VERSION = 1 as const;
export const UI_RESOURCE = 'ui://reviewslate/workspace.html';
export const META_KEY = 'reviewslate';
export type Language = 'auto' | 'zh-CN' | 'en';
export type Locale = 'zh-CN' | 'en';
export type Side = 'left' | 'right';
export type Target = { type: 'file' | 'directory'; path: string };
export interface Context {
  workspaceId: string;
  epoch: string;
  reviewId: string;
  branch: string;
  base: string;
  revision: string;
}
export interface Review {
  id: string; base: string; label: string; branch: { key: string; label: string };
  createdAt: string; lastUsedAt?: string; deletedAt?: string; purgePending: boolean;
}
export interface FileRow {
  path: string; fingerprint: string; status: 'pending' | 'reviewed' | 'changed';
  change: 'added' | 'modified' | 'deleted'; commentOnly: boolean; deletedOnly: boolean;
  error?: string; leftMode: string; rightMode: string; leftBytes: number; rightBytes: number;
}
export interface Anchor {
  side: Side; start: number; end: number; hash: string; selected: string[]; before: string[]; after: string[];
}
export interface Comment {
  id: string; revision: string; path: string; target: 'file' | 'directory'; body: string;
  state: 'open' | 'resolved'; createdAt: string; updatedAt: string; anchor?: Anchor;
  reply?: { body: string; updatedAt: string; matches: boolean };
  location?: { kind: 'file' | 'exact' | 'moved' | 'changed' | 'unavailable'; start?: number; end?: number };
  deleted: boolean;
}
export interface Navigation {
  target?: Target; expanded: string[]; mode: 'full' | 'since'; side: Side;
  line?: number; fingerprint?: string; anchor?: Anchor; scroll?: number;
  commentsMode: 'target' | 'pending'; filter: string;
}
export interface Draft {
  id: string; target: Target; body: string; anchor?: Anchor;
  commentId?: string; commentRevision?: string; commentState?: 'open' | 'resolved';
  requestId: string; originalNewDraft?: string;
}
export interface ViewState {
  version: 1; viewId: string; reviewId: string; revision: number; sequence: number;
  navigation: Navigation; drafts: Draft[]; updatedAt: string;
}
export interface WorkspaceView {
  workspace: { id: string; name: string; root: string; initialized: boolean };
  branch: { key: string; label: string };
  reviews: Review[]; active?: Review; context?: Context; revision: string;
  files: FileRow[]; comments: Comment[];
  defaultBase?: { kind: 'branch' | 'commit'; ref: string; label: string };
  baseCommit?: { oid: string; subject: string; date: string };
  error?: string;
  recovery?: ViewState;
  capabilities: { editCode: false; editReason: 'safe-save-unverified' };
}
export interface DiffView {
  target: Target; fingerprint: string; mode: 'full' | 'since'; side: Side;
  left: { text: string; mode: string; hash: string; bytes: number; textContent: boolean };
  right: { text: string; mode: string; hash: string; bytes: number; textContent: boolean };
  comments: Comment[]; context?: Context; archived?: boolean; reason?: 'not-reviewed' | 'unchanged';
}
export interface Preferences {
  language: Language;
  recent: { id: string; name: string; root: string; lastOpened: string }[];
  lastWorkspaceId?: string;
}
export interface Bootstrap {
  protocol: 1; epoch: string; capability: string; viewId: string; preferences: Preferences;
  capabilities: { editCode: false; editReason: 'safe-save-unverified'; roots: false; folderPicker: boolean };
}
/** Ephemeral UI selection. It never opens a repository or commits review data. */
export type FolderPickResult = { requestId: string } & (
  | { status: 'pending' | 'cancelled' | 'timed-out' }
  | { status: 'selected'; root: string }
  | { status: 'failed'; reason: 'unavailable' | 'busy' | 'launch-failed' | 'invalid-result' | 'expired' }
);
export interface BaseOptions {
  branches: { ref: string; name: string; remote: boolean }[];
  preferred?: string;
  commits: { oid: string; subject: string; date: string }[];
}
export interface Handoff {
  batchId: string; text: string; pendingCount: number; reviewCount: number;
  comments: { id: string; revision: string; path: string }[];
}
export type FailureCode = 'INVALID_REQUEST' | 'ACCESS_DENIED' | 'REPOSITORY_UNAVAILABLE' | 'STALE_CONTEXT' |
  'CONTENT_CHANGED' | 'REVISION_CONFLICT' | 'LOCK_BUSY' | 'STORE_CORRUPT' | 'UNSUPPORTED_VERSION' |
  'IO_FAILED' | 'UNSUPPORTED_CONTENT' | 'UNKNOWN_RESULT' | 'NOT_INITIALIZED';
export interface Failure {
  code: FailureCode; message: string; outcome: 'rejected' | 'partial' | 'unknown';
  retry: 'refresh' | 'same-operation' | 'reconnect' | 'repair' | 'none'; committedParts?: string[];
}
export interface Reply<T = ResponseData> {
  protocol: 1; ok: boolean; operationId?: string; outcome: 'read' | 'committed' | 'rejected' | 'partial' | 'unknown';
  data?: T; error?: Failure;
}
export type ResponseData = Bootstrap | WorkspaceView | DiffView | BaseOptions | ViewState | Preferences | Handoff | FolderPickResult |
  { operationId: string; status: 'committed' | 'pending' | 'rejected' | 'not-found'; result?: Reply };
export interface Envelope {
  protocol: 1; capability: string; viewId: string; workspaceId?: string; context?: Context; operationId?: string;
}
export type Request = Envelope & (
  | { action: 'pickFolder'; payload: { requestId: string; locale: Locale } }
  | { action: 'folderPickerResult' | 'cancelFolderPicker'; payload: { requestId: string } }
  | { action: 'openWorkspace'; payload: { root: string; initialize: boolean } }
  | { action: 'preferences'; payload: { language: Language } }
  | { action: 'refresh'; payload: Record<string, never> }
  | { action: 'bases'; payload: Record<string, never> }
  | { action: 'diff'; payload: { path: string; mode: 'full' | 'since'; side: Side; reviewId?: string } }
  | { action: 'inspectReview'; payload: { reviewId: string } }
  | { action: 'chooseBase'; payload: { kind: 'branch' | 'commit'; ref: string; label: string; expectedBranch: string; expectedRevision: string } }
  | { action: 'defaultBase'; payload: { kind: 'branch' | 'commit'; ref: string; label: string; expectedRevision: string } }
  | { action: 'openReview' | 'archiveReview' | 'restoreReview' | 'purgeReview'; payload: { reviewId: string; expectedRevision: string } }
  | { action: 'mark'; payload: { files: { path: string; fingerprint: string; checked: boolean }[]; directory?: string } }
  | { action: 'addComment'; payload: { target: Target; body: string; fingerprint?: string; anchor?: Anchor; requestId: string } }
  | { action: 'changeComment'; payload: { id: string; revision: string; expectedState: 'open' | 'resolved'; deleted: boolean; change: 'edit' | 'resolve' | 'reopen' | 'delete' | 'restore'; body?: string } }
  | { action: 'saveView'; payload: { reviewId: string; expectedRevision: number; sequence: number; navigation: Navigation; drafts: Draft[]; retainInactive?: boolean } }
  | { action: 'handoff'; payload: Record<string, never> }
  | { action: 'operation'; payload: { operationId: string } }
);
export const ACTION_TO_TOOL = {
  pickFolder: 'reviewslate_folder_pick', folderPickerResult: 'reviewslate_folder_pick', cancelFolderPicker: 'reviewslate_folder_pick',
  openWorkspace: 'reviewslate_workspace_open', preferences: 'reviewslate_preferences',
  refresh: 'reviewslate_read', bases: 'reviewslate_read', diff: 'reviewslate_read', inspectReview: 'reviewslate_read', operation: 'reviewslate_read',
  chooseBase: 'reviewslate_review_change', defaultBase: 'reviewslate_review_change', openReview: 'reviewslate_review_change',
  archiveReview: 'reviewslate_review_change', restoreReview: 'reviewslate_review_change', purgeReview: 'reviewslate_review_purge',
  mark: 'reviewslate_mark', addComment: 'reviewslate_comment_change', changeComment: 'reviewslate_comment_change',
  saveView: 'reviewslate_view_save', handoff: 'reviewslate_handoff_prepare'
} as const;
