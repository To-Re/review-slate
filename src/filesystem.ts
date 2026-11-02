import * as fs from 'node:fs/promises';
import { constants, Stats } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { missing } from './model';

/** Refuse links at every component owned by this store. The supplied root is a trusted, canonical directory. */
export async function directory(root: string, relative = '', create = false): Promise<boolean> {
  let current = root;
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据目录不是普通目录：' + current);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return false;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据目录不是普通目录：' + current);
      }
    }
  }
  return true;
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function fileStat(file: string): Promise<Stats | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('数据文件不是普通文件：' + file);
    return stat;
  } catch (error) { if (missing(error)) return null; throw error; }
}
async function assertUnchanged(file: string, expected: Stats | null): Promise<void> {
  const current = await fileStat(file);
  if (expected ? !current || !sameFile(expected, current) : current) throw new Error('文件正在改变，请稍后重试：' + file);
}
/** Inspect a regular file without following links, then verify both its contents and pathname stayed stable. */
export async function inspectFile<T>(file: string, read: (handle: fs.FileHandle, stat: Stats) => Promise<T>): Promise<{ value: T; stat: Stats }> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('文件类型不正确：' + file);
    const value = await read(handle, before), after = await handle.stat();
    if (!sameFile(before, after)) throw new Error('文件正在改变，请稍后重试：' + file);
    await assertUnchanged(file, before);
    return { value, stat: before };
  } finally { await handle.close(); }
}
/** Generated files may be larger than their replacement; only the bounded prefix is needed to compare them. */
async function readPrefix(file: string, limit: number, full = false): Promise<{ value: Buffer; stat: Stats }> {
  return inspectFile(file, async (handle, before) => {
    if (full && before.size > limit) throw new Error('文件类型不正确或超过大小限制：' + file);
    const length = Math.min(before.size, limit), result = Buffer.alloc(length);
    let offset = 0;
    while (offset < result.length) {
      const read = await handle.read(result, offset, result.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== length) throw new Error('文件正在改变，请稍后重试：' + file);
    return result;
  });
}
export async function readBytes(file: string, limit: number): Promise<Buffer> {
  return (await readPrefix(file, limit, true)).value;
}
export async function readJson<T>(file: string, validate: (value: unknown) => T): Promise<T | undefined> {
  let bytes: Buffer;
  try { bytes = await readBytes(file, 16 * 1024 * 1024); }
  catch (error) {
    if (!missing(error)) throw error;
    try {
      await fs.lstat(file + '.bak');
      throw new Error('主数据缺失但备份仍在，请恢复后继续：' + file);
    } catch (backupError) { if (!missing(backupError)) throw backupError; }
    return undefined;
  }
  try { return validate(JSON.parse(bytes.toString('utf8'))); }
  catch (error) { throw new Error('数据损坏，未覆盖原文件：' + file + '\n' + (error as Error).message); }
}
async function syncDirectory(folder: string): Promise<void> {
  const handle = await fs.open(folder, constants.O_RDONLY);
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  finally { await handle.close(); }
}
export async function atomicWrite(file: string, data: string | Buffer, expected?: Stats | null): Promise<void> {
  // A generated output may not replace a user's link or special file.
  const previous = expected === undefined ? await fileStat(file) : expected;
  await assertUnchanged(file, previous);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await assertUnchanged(file, previous);
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}
/** The caller has validated the current JSON while holding the store lock. */
export async function saveJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n';
  let previous: Buffer | undefined;
  try { previous = await readBytes(file, 16 * 1024 * 1024); } catch (error) { if (!missing(error)) throw error; }
  if (previous?.toString('utf8') === text) return;
  await atomicWrite(file + '.bak', previous || text);
  await atomicWrite(file, text);
}
export async function writeChanged(file: string, text: string, expected?: Stats | null): Promise<void> {
  const bytes = Buffer.from(text);
  let previous: Stats | null = null;
  try {
    const result = await readPrefix(file, bytes.length + 1);
    previous = result.stat;
    if (expected !== undefined && (!expected || !sameFile(expected, previous))) throw new Error('文件正在改变，请稍后重试：' + file);
    if (result.value.equals(bytes)) return;
  }
  catch (error) { if (!missing(error)) throw error; }
  if (expected && !previous) throw new Error('文件正在改变，请稍后重试：' + file);
  await atomicWrite(file, bytes, previous);
}
/** Remove only the file whose ownership was inspected while holding the store lock. */
export async function removeUnchanged(file: string, expected: Stats): Promise<void> {
  await assertUnchanged(file, expected);
  await fs.unlink(file);
}
/** Move one validated store file without replacing another file or following links. */
export async function moveStoredFile(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('数据文件不是普通文件：' + source);
  try { await fs.lstat(destination); throw new Error('目标数据已存在，未覆盖：' + destination); }
  catch (error) { if (!missing(error)) throw error; }
  await fs.rename(source, destination);
  await syncDirectory(path.dirname(destination));
  await syncDirectory(path.dirname(source));
}
const queues = new Map<string, Promise<unknown>>();
export function locked<T>(folder: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(folder) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    // Use the legacy lock directory too: other editor windows may still run the previous extension host.
    const lock = path.join(folder, 'write.lock');
    let acquired = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    if (!acquired) throw new Error('另一个窗口正在写入。若上次进程异常退出，请检查写入锁：' + lock);
    try {
      return await operation();
    } finally { await fs.rmdir(lock); }
  });
  queues.set(folder, work);
  void work.finally(() => { if (queues.get(folder) === work) queues.delete(folder); }).catch(() => {});
  return work;
}
