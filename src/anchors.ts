import { decode, Pair, Snapshot, snapshotId } from './model';

export interface Anchor {
  side: 'left' | 'right'; start: number; end: number; hash: string;
  selected: string[]; before: string[]; after: string[];
}
export interface Location {
  kind: 'file' | 'exact' | 'moved' | 'changed' | 'unavailable';
  start?: number; end?: number;
}
function linesOf(snapshot: Snapshot): string[] {
  if (!['100644', '100755'].includes(snapshot.mode)) throw new Error('此文件只能使用文件评论');
  const text = decode(snapshot.data);
  if (text.includes('\0')) throw new Error('二进制文件请使用文件评论');
  return text.split(/\r?\n/);
}
export function anchorFor(snapshot: Snapshot, side: 'left' | 'right', start: number, end: number): Anchor {
  const lines = linesOf(snapshot);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= lines.length || end - start >= 200) throw new Error('请选择 1 到 200 行代码');
  const selected = lines.slice(start, end + 1), before = lines.slice(Math.max(0, start - 3), start), after = lines.slice(end + 1, end + 4);
  if (selected.join('\n').length > 50000 || before.join('\n').length + after.join('\n').length > 24000) throw new Error('选区或上下文过长，请使用文件评论');
  return { side, start, end, hash: snapshotId(snapshot), selected, before, after };
}
function at(lines: string[], fragment: string[], offset: number): boolean {
  return offset >= 0 && offset + fragment.length <= lines.length && fragment.every((line, index) => lines[offset + index] === line);
}
function matches(lines: string[], fragment: string[]): number[] {
  const result = [];
  for (let offset = 0; offset <= lines.length - fragment.length; offset++) {
    if (at(lines, fragment, offset)) result.push(offset);
    if (result.length > 2000) break;
  }
  return result;
}
export function locate(anchor?: Anchor, current?: Pair): Location {
  if (!anchor) return { kind: 'file' };
  if (!current) return { kind: 'unavailable' };
  const snapshot = current[anchor.side];
  if (snapshotId(snapshot) === anchor.hash) return { kind: 'exact', start: anchor.start, end: anchor.end };
  let lines: string[];
  try { lines = linesOf(snapshot); } catch { return { kind: 'unavailable' }; }
  if (!(anchor.before.join('').trim() || anchor.after.join('').trim()) && anchor.selected.join('\n').trim().length < 16) return { kind: 'unavailable' };
  const candidates = matches(lines, anchor.selected).filter(start =>
    at(lines, anchor.before, start - anchor.before.length) && at(lines, anchor.after, start + anchor.selected.length));
  if (candidates.length === 1) return { kind: 'moved', start: candidates[0], end: candidates[0] + anchor.selected.length - 1 };
  if (candidates.length > 1 || !anchor.before.length || !anchor.after.length) return { kind: 'unavailable' };
  const left = matches(lines, anchor.before), right = matches(lines, anchor.after);
  if (left.length === 1 && right.length === 1) {
    const start = left[0] + anchor.before.length, end = right[0] - 1;
    if (end >= start && end - start < 1000) return { kind: 'changed', start, end };
  }
  return { kind: 'unavailable' };
}
