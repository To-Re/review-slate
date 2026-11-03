import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { FolderPickResult, Locale } from './contract';
import { ClientError } from './errors';

interface Selection {
  owner: string; result: FolderPickResult; touched: number; created: number;
  child?: ChildProcess; finished?: Promise<void>; timer?: NodeJS.Timeout;
}
export interface FolderPickerOptions { executable?: string; timeoutMs?: number; leaseMs?: number }
/** Short-lived local UI, deliberately separate from mutation receipts and the review queue. */
export class FolderPicker {
  private readonly selections = new Map<string, Selection>();
  private active?: Selection;
  private closed = false;
  private readonly executable: string;
  constructor(private readonly options: FolderPickerOptions = {}) {
    this.executable = options.executable || process.env.REVIEW_SLATE_FOLDER_PICKER ||
      path.resolve(__dirname, '..', 'native', 'ReviewSlate Folder Picker.app', 'Contents', 'MacOS', 'ReviewSlateFolderPicker');
  }
  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    try {
      const file = await fs.lstat(this.executable);
      return path.isAbsolute(this.executable) && file.isFile() && !file.isSymbolicLink() && !!(file.mode & 0o111) &&
        await fs.realpath(this.executable) === path.resolve(this.executable);
    } catch { return false; }
  }
  private owned(owner: string, requestId: string): Selection | undefined {
    const selection = this.selections.get(requestId);
    if (selection && selection.owner !== owner) throw new ClientError('ACCESS_DENIED', 'This folder selection belongs to another app view.', 'none');
    return selection;
  }
  private prune(): void {
    for (const [id, selection] of this.selections) {
      if (selection !== this.active && (Date.now() - selection.touched > 300_000 || this.selections.size >= 64)) this.selections.delete(id);
    }
  }
  result(owner: string, requestId: string): FolderPickResult {
    const selection = this.owned(owner, requestId);
    if (!selection) return { requestId, status: 'failed', reason: 'expired' };
    selection.touched = Date.now();
    return selection.result;
  }
  async start(owner: string, requestId: string, locale: Locale, initialDirectory?: string): Promise<FolderPickResult> {
    if (this.closed) throw new ClientError('ACCESS_DENIED', 'The plugin connection is closed.', 'reconnect');
    const prior = this.owned(owner, requestId);
    if (prior) return this.result(owner, requestId);
    if (this.active) return { requestId, status: 'failed', reason: 'busy' };
    this.prune();
    // Reserve before any await so distinct views cannot race the availability check.
    const selection: Selection = { owner, result: { requestId, status: 'pending' }, touched: Date.now(), created: Date.now() };
    this.selections.set(requestId, selection); this.active = selection;
    if (!await this.available()) {
      selection.result = { requestId, status: 'failed', reason: 'unavailable' }; this.active = undefined; return selection.result;
    }
    // Do not stat user volumes in the chooser lifecycle. NSOpenPanel handles a stale initial location;
    // the existing openWorkspace operation validates the chosen directory and Git root afterwards.
    const directory = initialDirectory && initialDirectory.length <= 4096 && path.isAbsolute(initialDirectory) && !initialDirectory.includes('\0') ? initialDirectory : undefined;
    if (this.closed || selection.result.status !== 'pending') { this.active = undefined; return selection.result; }
    const timeout = this.options.timeoutMs ?? 120_000, lease = this.options.leaseMs ?? 15_000;
    const args = ['--locale', locale, '--timeout-seconds', String(Math.max(1, Math.ceil(timeout / 1000)))];
    if (directory) args.push('--directory', directory);
    const output: Buffer[] = []; let outputBytes = 0, invalidOutput = false;
    const child = spawn(this.executable, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), LANG: locale === 'zh-CN' ? 'zh_CN.UTF-8' : 'en_US.UTF-8' } });
    selection.child = child;
    child.stdout!.on('data', (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 16_384) { invalidOutput = true; void this.stop(selection, { requestId, status: 'failed', reason: 'invalid-result' }); }
      else output.push(bytes);
    });
    selection.finished = new Promise(resolve => {
      child.once('error', () => { selection.result = { requestId, status: 'failed', reason: 'launch-failed' }; });
      child.once('close', code => {
        clearInterval(selection.timer);
        if (selection.result.status === 'pending') {
          let result: FolderPickResult = { requestId, status: 'failed', reason: 'invalid-result' };
          try {
            const value = JSON.parse(Buffer.concat(output).toString('utf8'));
            if (code !== 0 || invalidOutput || value.version !== 1) throw new Error('Invalid picker result');
            if (value.status === 'cancelled' || value.status === 'timed-out') result = { requestId, status: value.status };
            else if (value.status === 'failed' && value.reason === 'busy') result = { requestId, status: 'failed', reason: 'busy' };
            else if (value.status === 'selected' && typeof value.path === 'string' && value.path.length <= 4096 &&
              !value.path.includes('\0') && path.isAbsolute(value.path)) {
              result = { requestId, status: 'selected', root: value.path };
            }
          } catch { /* A result is not authority to read a file or to open a repository. */ }
          if (selection.result.status === 'pending') selection.result = result;
        }
        if (this.active === selection) this.active = undefined;
        selection.child = undefined; resolve();
      });
    });
    selection.timer = setInterval(() => {
      const now = Date.now();
      if (now - selection.created >= timeout) void this.stop(selection, { requestId, status: 'timed-out' });
      else if (now - selection.touched >= lease) void this.stop(selection, { requestId, status: 'cancelled' });
    }, Math.min(1000, timeout, lease));
    return selection.result;
  }
  private async stop(selection: Selection, result: FolderPickResult): Promise<void> {
    if (selection.result.status === 'pending') selection.result = result;
    clearInterval(selection.timer);
    const child = selection.child;
    if (!child) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => { if (selection.child === child) child.kill('SIGKILL'); }, 1000);
    await selection.finished; clearTimeout(force);
  }
  async cancel(owner: string, requestId: string): Promise<FolderPickResult> {
    const selection = this.owned(owner, requestId);
    if (!selection) {
      this.prune();
      const result: FolderPickResult = { requestId, status: 'cancelled' };
      this.selections.set(requestId, { owner, result, touched: Date.now(), created: Date.now() });
      return result;
    }
    await this.stop(selection, { requestId, status: 'cancelled' }); return selection.result;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.active) await this.stop(this.active, { requestId: this.active.result.requestId, status: 'cancelled' });
    this.selections.clear();
  }
}
