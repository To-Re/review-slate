import { z } from 'zod';
import { checkPath } from '../model';
import { Request } from './contract';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = (max: number) => z.string().max(max).refine(value => !value.includes('\0'));
const relative = bounded(4096).min(1).refine(value => { try { checkPath(value); return true; } catch { return false; } });
const side = z.enum(['left', 'right']);
export const targetSchema = z.object({ type: z.enum(['file', 'directory']), path: relative }).strict();
export const anchorSchema = z.object({
  side, start: z.number().int().min(0), end: z.number().int().min(0), hash: digest,
  selected: z.array(z.string().max(50000)).min(1).max(200),
  before: z.array(z.string().max(24000)).max(3), after: z.array(z.string().max(24000)).max(3)
}).strict().refine(a => a.end >= a.start && a.end - a.start < 200 && a.selected.length === a.end - a.start + 1 &&
  a.selected.join('\n').length <= 50000 && a.before.join('\n').length + a.after.join('\n').length <= 24000);
export const navigationSchema = z.object({
  target: targetSchema.optional(), expanded: z.array(relative).max(10000), mode: z.enum(['full', 'since']), side,
  line: z.number().int().nonnegative().optional(), fingerprint: digest.optional(), anchor: anchorSchema.optional(),
  scroll: z.number().finite().nonnegative().optional(), commentsMode: z.enum(['target', 'pending']), filter: bounded(1000)
}).strict();
export const draftSchema = z.object({
  id: bounded(256).min(1), target: targetSchema, body: z.string().max(20000), anchor: anchorSchema.optional(),
  commentId: uuid.optional(), commentRevision: uuid.optional(), commentState: z.enum(['open', 'resolved']).optional(),
  requestId: uuid, originalNewDraft: bounded(256).optional()
}).strict().refine(d => (!d.commentId && !d.commentRevision && !d.commentState) || !!(d.commentId && d.commentRevision && d.commentState))
  .refine(d => d.target.type !== 'directory' || !d.anchor);
const context = z.object({ workspaceId: digest, epoch: uuid, reviewId: digest, branch: bounded(1024).min(1),
  base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), revision: digest }).strict();
const envelope = { protocol: z.literal(1), capability: digest, viewId: uuid, workspaceId: digest.optional(), context: context.optional(), operationId: uuid.optional() };
const payloadless = z.object({}).strict();
const base = { kind: z.enum(['branch', 'commit']), ref: bounded(1024).min(1), label: bounded(1024).min(1) };
const review = z.object({ reviewId: digest, expectedRevision: digest }).strict();
const variant = <A extends Request['action'], P extends z.ZodType>(action: A, payload: P) => z.object({ ...envelope, action: z.literal(action), payload }).strict();
export const requestSchema = z.discriminatedUnion('action', [
  variant('pickFolder', z.object({ requestId: uuid, locale: z.enum(['zh-CN', 'en']) }).strict()),
  variant('folderPickerResult', z.object({ requestId: uuid }).strict()),
  variant('cancelFolderPicker', z.object({ requestId: uuid }).strict()),
  variant('openWorkspace', z.object({ root: bounded(4096).min(1), initialize: z.boolean() }).strict()),
  variant('preferences', z.object({ language: z.enum(['auto', 'zh-CN', 'en']) }).strict()),
  variant('refresh', payloadless), variant('bases', payloadless),
  variant('diff', z.object({ path: relative, mode: z.enum(['full', 'since']), side, reviewId: digest.optional() }).strict()),
  variant('inspectReview', z.object({ reviewId: digest }).strict()),
  variant('chooseBase', z.object({ ...base, expectedBranch: bounded(1024).min(1), expectedRevision: digest }).strict()),
  variant('defaultBase', z.object({ ...base, expectedRevision: digest }).strict()),
  variant('openReview', review), variant('archiveReview', review), variant('restoreReview', review), variant('purgeReview', review),
  variant('mark', z.object({ files: z.array(z.object({ path: relative, fingerprint: digest, checked: z.boolean() }).strict()).min(1).max(10000), directory: z.union([relative, z.literal('')]).optional() }).strict()),
  variant('addComment', z.object({ target: targetSchema, body: z.string().min(1).max(20000).refine(v => !!v.trim()), fingerprint: digest.optional(), anchor: anchorSchema.optional(), requestId: uuid }).strict()),
  variant('changeComment', z.object({ id: uuid, revision: uuid, expectedState: z.enum(['open', 'resolved']), deleted: z.boolean(),
    change: z.enum(['edit', 'resolve', 'reopen', 'delete', 'restore']), body: z.string().min(1).max(20000).optional() }).strict()),
  variant('saveView', z.object({ reviewId: digest, expectedRevision: z.number().int().nonnegative(), sequence: z.number().int().positive(),
    navigation: navigationSchema, drafts: z.array(draftSchema).max(200), retainInactive: z.boolean().optional() }).strict()),
  variant('handoff', payloadless), variant('operation', z.object({ operationId: uuid }).strict())
]);
export function parseRequest(value: unknown): Request { return requestSchema.parse(value) as Request; }
