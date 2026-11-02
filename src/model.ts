import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const FILE_LIMIT = 5 * 1024 * 1024;
export const SCAN_LIMIT = 80 * 1024 * 1024;
export const NOTES_FOLDER = '.code-review';
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isCommit = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '');
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const decode = (data: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);

export type FileMode = '000000' | '100644' | '100755' | '120000';
export interface Snapshot { mode: FileMode; data: Buffer }
export interface Pair { left: Snapshot; right: Snapshot }
export interface SnapshotRef { mode: FileMode; hash: string }
export interface ReviewedFile { left: SnapshotRef; right: SnapshotRef; reviewedAt: string }
export type ReviewRecords = Record<string, ReviewedFile>;
export type ReviewStatus = 'pending' | 'reviewed' | 'changed';
export interface ReviewFile extends Pair {
  path: string;
  fingerprint: string;
  status: ReviewStatus;
  commentOnly: boolean;
  deletedOnly?: boolean;
  error?: string;
}
export interface ReviewBranch { key: string; label: string }
export interface Session {
  id: string; base: string; label: string; createdAt: string;
  branch?: ReviewBranch; commentScopes?: string[]; deletedAt?: string; lastUsedAt?: string;
}
export interface DefaultBase { kind: 'branch' | 'commit'; ref: string; label: string }
export interface LegacyComparison { mode: 'fixed' | 'branch' | 'worktree'; base: string; target: string; mergeBase: boolean; reviewId?: string }
export const absent = (): Snapshot => ({ mode: '000000', data: Buffer.alloc(0) });
export const snapshotId = (snapshot: Snapshot): string => hash(Buffer.concat([Buffer.from(snapshot.mode + '\0'), snapshot.data]));
export const pairId = (pair: Pair): string => hash(snapshotId(pair.left) + snapshotId(pair.right));
export const recordId = (record: ReviewedFile): string => hash(record.left.hash + record.right.hash);
export const isMode = (mode: unknown): mode is FileMode => ['000000', '100644', '100755', '120000'].includes(String(mode));

export function checkPath(file: string): void {
  if (!file || file.includes('\0') || file.includes('\\') || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) ||
      file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('不支持的仓库路径：' + JSON.stringify(file));
  }
}
export function isNotes(file: string): boolean { return file === NOTES_FOLDER || file.startsWith(NOTES_FOLDER + '/'); }
export function legacyScope(comparison: LegacyComparison): string {
  if (!comparison || !['fixed', 'branch', 'worktree'].includes(comparison.mode) ||
      typeof comparison.base !== 'string' || typeof comparison.target !== 'string' || typeof comparison.mergeBase !== 'boolean') {
    throw new Error('旧版比较配置损坏；原数据已保留');
  }
  if (comparison.reviewId !== undefined && !isHash(comparison.reviewId)) throw new Error('旧版审阅标识损坏');
  return comparison.reviewId || hash(JSON.stringify(comparison));
}
export function comparisonFor(session: Session): LegacyComparison {
  return { mode: 'worktree', base: session.base, target: 'HEAD', mergeBase: false, reviewId: session.id };
}
export function snapshotText(snapshot: Snapshot, metadataOnly = false): string {
  const metadata = '类型/权限：' + snapshot.mode + '\n字节数：' + snapshot.data.length + '\n内容 SHA-256：' + hash(snapshot.data) + '\n';
  if (metadataOnly) return metadata;
  if (snapshot.mode === '000000') return '';
  if (snapshot.mode === '120000') return metadata + '\n符号链接目标（仅链接文本）：\n' + snapshot.data.toString('utf8');
  try {
    const text = decode(snapshot.data);
    return text.includes('\0') ? metadata + '\n二进制文件，请核对内容指纹。\n' : text;
  } catch { return metadata + '\n非 UTF-8 文件，请核对内容指纹。\n'; }
}

export function editableText(snapshot: Snapshot): boolean {
  if (!['100644', '100755'].includes(snapshot.mode)) return false;
  try { return !decode(snapshot.data).includes('\0'); } catch { return false; }
}
