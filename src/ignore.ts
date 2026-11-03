import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { readBytes } from './filesystem';
import { decode, missing } from './model';

function hasRule(bytes: Buffer, folder: string): boolean {
  // A later negation can override an earlier rule. Append our root-only rule last in that case.
  for (const line of decode(bytes).replace(/^\uFEFF/, '').split(/\r?\n/).reverse()) {
    if (line.startsWith('!')) return false;
    // Git ignores trailing ASCII spaces, but tabs and other whitespace remain part of the pattern.
    if ([folder, '/' + folder, folder + '/', '/' + folder + '/'].includes(line.replace(/ +$/, ''))) return true;
  }
  return false;
}
/** Called under the comments-store lock. Append only; never replace the user's existing rules. */
export async function ensureNotesIgnored(root: string, folder = '.code-review'): Promise<void> {
  if (!folder || folder.split('/').some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..')) throw new Error('无效的数据目录');
  const rule = '/' + folder + '/';
  const file = path.join(root, '.gitignore');
  let original: Buffer;
  try { original = await readBytes(file, 1024 * 1024); }
  catch (error) { if (!missing(error)) throw error; original = Buffer.alloc(0); }
  if (hasRule(original, folder)) return;
  const newline = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const addition = (original.length && original.at(-1) !== 10 ? newline : '') + rule + newline;
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !(await readBytes(file, 1024 * 1024)).equals(original) || (await fs.lstat(file)).ino !== stat.ino) {
      throw new Error('.gitignore 正在改变，原规则未覆盖，请重试');
    }
    await handle.writeFile(addition); await handle.sync();
    if ((await fs.lstat(file)).ino !== stat.ino || !hasRule(await readBytes(file, 1024 * 1024), folder)) {
      throw new Error('.gitignore 已被其他程序替换，请刷新后重试');
    }
  } finally { await handle.close(); }
}
