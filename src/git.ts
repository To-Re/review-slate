import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { absent, checkPath, decode, editableText, FILE_LIMIT, isCommit, isNotes, messageOf, missing, Pair, pairId, ReviewBranch, ReviewFile, SCAN_LIMIT, Snapshot, snapshotId } from './model';

interface TreeEntry { mode: string; oid: string }
export interface Reference { name: string; ref: string; remote: boolean }
export interface MainReferences { branches: Reference[]; preferred?: Reference; localMain?: Reference; remoteMain?: Reference }
export interface CommitChoice { oid: string; subject: string; date: string }
const allowed = new Set(['rev-parse', 'for-each-ref', 'merge-base', 'log', 'ls-tree', 'ls-files', 'cat-file']);
const nul = (bytes: Buffer): string[] => decode(bytes).split('\0').filter(Boolean);

export class GitRepository {
  private readonly treeCache = new Map<string, Map<string, TreeEntry>>();
  private readonly objectCache = new Map<string, Buffer>();
  private objectBytes = 0;
  private readonly unchanged = new Map<string, string>();
  private readonly commitCache = new Map<string, CommitChoice>();
  private constructor(readonly root: string) {}
  static async open(folder: string): Promise<GitRepository> {
    const probe = new GitRepository(folder);
    const root = decode(await probe.read(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
    return new GitRepository(await fs.realpath(root));
  }
  private read(args: string[]): Promise<Buffer> {
    if (!allowed.has(args[0])) throw new Error('不允许的 Git 操作');
    return new Promise((resolve, reject) => execFile('git', [
      '--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.filemode=true', '-c', 'core.quotePath=false', ...args
    ], {
      cwd: this.root, encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
      // Git 2.39.5 supports the environment guard, but not the newer CLI flag.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }
    }, (error, out, err) => {
      if (error) reject(new Error('Git 读取失败：' + (err.toString('utf8').trim().slice(0, 600) || error.message)));
      else resolve(out);
    }));
  }
  async resolve(reference: string): Promise<string> {
    if (!reference.trim() || reference.length > 1024 || reference.includes('\0')) throw new Error('请输入有效提交');
    const oid = decode(await this.read(['rev-parse', '--verify', '--end-of-options', reference + '^{commit}'])).trim();
    if (!isCommit(oid)) throw new Error('无法解析提交');
    return oid;
  }
  async branch(): Promise<ReviewBranch> {
    const ref = decode(await this.read(['rev-parse', '--symbolic-full-name', 'HEAD'])).trim();
    if (ref.startsWith('refs/heads/') && !/[\0\r\n]/.test(ref)) return { key: ref, label: ref.slice('refs/heads/'.length) };
    if (ref !== 'HEAD') throw new Error('无法确定当前分支，请刷新后重试');
    const oid = await this.resolve('HEAD');
    return { key: 'detached:' + oid, label: '游离 HEAD · ' + oid.slice(0, 8) };
  }
  async mainReferences(): Promise<MainReferences> {
    const lines = decode(await this.read(['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes'])).split('\n').filter(Boolean);
    const branches: Reference[] = [];
    const defaults = new Map<string, string>();
    for (const line of lines) {
      const [ref, symbolic] = line.split('\0');
      if (symbolic) {
        defaults.set(ref, symbolic);
      } else branches.push({ ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), remote: ref.startsWith('refs/remotes/') });
    }
    const find = (candidates: (string | undefined)[]): Reference | undefined => candidates.map(ref => branches.find(branch => branch.ref === ref)).find(Boolean);
    const remoteMain = find([
      defaults.get('refs/remotes/upstream/HEAD'), defaults.get('refs/remotes/origin/HEAD'),
      'refs/remotes/upstream/main', 'refs/remotes/upstream/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master',
      'refs/remotes/upstream/trunk', 'refs/remotes/origin/trunk'
    ]);
    const localMain = find(['refs/heads/main', 'refs/heads/master', 'refs/heads/trunk', remoteMain ? remoteMain.ref.replace(/^refs\/remotes\/[^/]+\//, 'refs/heads/') : undefined]);
    return { branches, localMain, remoteMain, preferred: remoteMain || localMain };
  }
  async forkPoint(reference: string, target = 'HEAD'): Promise<string> {
    const base = await this.resolve(reference), head = await this.resolve(target);
    const oid = decode(await this.read(['merge-base', base, head])).trim();
    if (!isCommit(oid)) throw new Error('没有找到共同祖先，请选择一个提交');
    return oid;
  }
  async commits(): Promise<CommitChoice[]> {
    const parts = decode(await this.read(['log', '--branches', '--remotes', '--tags', '-n', '150', '--no-show-signature', '-z', '--format=%H%x00%s%x00%cs', 'HEAD', '--'])).split('\0');
    if (parts.at(-1) === '') parts.pop();
    if (parts.length % 3) throw new Error('提交记录格式错误');
    const result: CommitChoice[] = [];
    for (let index = 0; index < parts.length; index += 3) {
      if (!isCommit(parts[index])) throw new Error('提交 ID 格式错误');
      result.push({ oid: parts[index], subject: parts[index + 1], date: parts[index + 2] });
    }
    return result;
  }
  async commitInfo(oid: string): Promise<CommitChoice> {
    if (!isCommit(oid)) throw new Error('对比起点必须是完整提交 SHA');
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const [id, subject, date] = decode(await this.read(['log', '-1', '--no-show-signature', '--format=%H%x00%s%x00%cs', oid, '--'])).trimEnd().split('\0');
    if (id !== oid || subject === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('无法读取对比起点的提交说明');
    const commit = { oid, subject: subject || '无提交说明', date };
    this.commitCache.clear(); this.commitCache.set(oid, commit); return commit;
  }
  private async tree(base: string): Promise<Map<string, TreeEntry>> {
    if (!isCommit(base)) throw new Error('基点必须是完整提交 SHA');
    const cached = this.treeCache.get(base);
    if (cached) return cached;
    const result = new Map<string, TreeEntry>();
    for (const entry of nul(await this.read(['ls-tree', '-rz', '--full-tree', base]))) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('Git 文件树格式错误');
      const [mode, , oid] = entry.slice(0, tab).split(' '), name = entry.slice(tab + 1);
      checkPath(name); result.set(name, { mode, oid });
    }
    this.treeCache.clear(); this.treeCache.set(base, result);
    return result;
  }
  private async object(entry?: TreeEntry): Promise<Snapshot> {
    if (!entry) return absent();
    if (!['100644', '100755', '120000'].includes(entry.mode)) throw new Error('子模块请单独打开为仓库后审阅');
    let data = this.objectCache.get(entry.oid);
    if (!data) {
      const size = Number(decode(await this.read(['cat-file', '-s', entry.oid])).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT) throw new Error('文件超过 5 MiB，无法保存快照');
      data = await this.read(['cat-file', 'blob', entry.oid]);
      if (data.length !== size) throw new Error('Git 对象长度不一致');
      this.objectCache.set(entry.oid, data); this.objectBytes += data.length;
      while (this.objectBytes > 20 * 1024 * 1024 || this.objectCache.size > 1000) {
        const first = this.objectCache.keys().next().value!;
        this.objectBytes -= this.objectCache.get(first)!.length; this.objectCache.delete(first);
      }
    }
    return { mode: entry.mode as Snapshot['mode'], data };
  }
  /** null means an unchanged baseline file; links are represented by link text only. */
  private async working(name: string, baseline?: TreeEntry): Promise<Snapshot | null> {
    checkPath(name);
    let parent = this.root;
    for (const part of name.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      try {
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return absent();
      } catch (error) { if (missing(error)) return absent(); throw error; }
    }
    const file = path.join(this.root, ...name.split('/'));
    let initial;
    try { initial = await fs.lstat(file); } catch (error) { if (missing(error)) return absent(); throw error; }
    if (initial.isDirectory()) return absent();
    if (initial.isSymbolicLink()) {
      const data = await fs.readlink(file, { encoding: 'buffer' }), after = await fs.lstat(file);
      if (!after.isSymbolicLink() || after.ino !== initial.ino || after.ctimeMs !== initial.ctimeMs) throw new Error('读取时链接发生变化，请刷新');
      if (data.length > FILE_LIMIT) throw new Error('链接文本过长');
      return { mode: '120000', data };
    }
    if (!initial.isFile()) throw new Error('特殊文件无法审阅');
    const mode = initial.mode & 0o100 ? '100755' : '100644';
    const signature = [baseline?.oid, baseline?.mode, initial.dev, initial.ino, initial.size, initial.mtimeMs, initial.ctimeMs, initial.mode].join(':');
    if (baseline?.mode === mode && this.unchanged.get(name) === signature) return null;
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || initial.ino !== before.ino || initial.dev !== before.dev) throw new Error('读取时文件类型发生变化');
      const oversized = before.size > FILE_LIMIT;
      if (oversized && (!baseline || baseline.mode !== mode)) throw new Error('文件超过 5 MiB，无法保存快照');
      const digest = baseline ? createHash(baseline.oid.length === 64 ? 'sha256' : 'sha1').update('blob ' + before.size + '\0') : undefined;
      const chunks: Buffer[] = [], chunk = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset <= before.size) {
        const count = (await handle.read(chunk, 0, chunk.length, offset)).bytesRead;
        if (!count) break;
        offset += count; digest?.update(chunk.subarray(0, count));
        if (!oversized) chunks.push(Buffer.from(chunk.subarray(0, count)));
      }
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode) throw new Error('读取时文件发生变化，请刷新');
      if (baseline?.mode === mode && digest?.digest('hex') === baseline.oid) { this.unchanged.set(name, signature); return null; }
      if (oversized) throw new Error('文件超过 5 MiB，无法保存快照');
      return { mode, data: Buffer.concat(chunks) };
    } finally { await handle.close(); }
  }
  async pair(base: string, name: string): Promise<Pair> {
    const entry = (await this.tree(base)).get(name);
    return { left: await this.object(entry), right: (await this.working(name))! };
  }
  /** Only hand regular UTF-8 files to the native editor; never expose link targets. */
  async editablePath(name: string, expected: Snapshot): Promise<string | undefined> {
    if (!editableText(expected)) return;
    const current = (await this.working(name))!;
    if (!editableText(current) || snapshotId(current) !== snapshotId(expected)) return;
    return path.join(this.root, ...name.split('/'));
  }
  async scan(base: string, extraPaths: string[] = []): Promise<ReviewFile[]> {
    const head = await this.resolve('HEAD');
    const index = new Map<string, string>();
    for (const entry of nul(await this.read(['ls-files', '--stage', '-z']))) {
      const tab = entry.indexOf('\t'), [mode, , stage] = entry.slice(0, tab).split(' ');
      if (tab < 0 || stage !== '0') throw new Error('请先解决合并冲突，再继续审阅');
      index.set(entry.slice(tab + 1), mode);
    }
    const tree = await this.tree(base);
    const paths = new Set([...tree.keys(), ...index.keys(), ...nul(await this.read(['ls-files', '--others', '--exclude-standard', '-z'])), ...extraPaths]);
    const result: ReviewFile[] = [];
    let size = 0;
    for (const name of [...paths].sort()) {
      if (isNotes(name)) continue;
      checkPath(name);
      try {
        const entry = tree.get(name);
        if (entry?.mode === '160000' || index.get(name) === '160000') throw new Error('子模块请单独打开为仓库后审阅');
        const right = await this.working(name, entry);
        if (!right) continue;
        const left = await this.object(entry);
        if (snapshotId(left) === snapshotId(right)) continue;
        size += left.data.length + right.data.length;
        if (size > SCAN_LIMIT) throw new Error('本次差异超过 80 MiB，请选择更近的基点');
        result.push({ path: name, left, right, fingerprint: pairId({ left, right }), status: 'pending', commentOnly: false });
      } catch (error) {
        if (size > SCAN_LIMIT) throw error;
        result.push({ path: name, left: absent(), right: absent(), fingerprint: '', status: 'pending', commentOnly: false, error: messageOf(error) });
      }
    }
    if (head !== await this.resolve('HEAD')) throw new Error('扫描时分支发生变化，请刷新');
    return result;
  }
}
