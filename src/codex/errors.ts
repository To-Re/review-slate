import { Failure, FailureCode } from './contract';
export class ClientError extends Error {
  constructor(readonly code: FailureCode, message: string, readonly retry: Failure['retry'] = 'refresh') { super(message); }
}
export function failureOf(error: unknown): Failure {
  if (error instanceof ClientError) {
    const detail = error as ClientError & { partial?: boolean; uncertain?: boolean; committedParts?: string[] };
    return { code: error.code, message: error.message, retry: error.retry,
      outcome: detail.partial ? 'partial' : detail.uncertain || error.code === 'UNKNOWN_RESULT' ? 'unknown' : 'rejected',
      ...(detail.committedParts ? { committedParts: detail.committedParts } : {}) };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code: FailureCode = /ZodError/.test((error as Error)?.name || '') ? 'INVALID_REQUEST' :
    /EACCES|EPERM|权限|permission denied/i.test(message) ? 'ACCESS_DENIED' :
    /另一个窗口|写入锁|正在写入/.test(message) ? 'LOCK_BUSY' :
    /损坏|格式错误|快照校验|备份仍在|工具标识|属于其他工具/.test(message) ? 'STORE_CORRUPT' :
    /分支.*改变|CR.*改变|基点已改变|请先切换/.test(message) ? 'STALE_CONTEXT' :
    /其他窗口修改|重复请求/.test(message) ? 'REVISION_CONFLICT' :
    /文件.*变化|内容.*变化/.test(message) ? 'CONTENT_CHANGED' :
    /超过|不支持|只能|二进制|非 UTF-8/.test(message) ? 'UNSUPPORTED_CONTENT' :
    /Git 读取失败|不是.*仓库|ENOENT/.test(message) ? 'REPOSITORY_UNAVAILABLE' : 'IO_FAILED';
  return { code, message: message.slice(0, 1200), outcome: 'rejected', retry: code === 'STORE_CORRUPT' ? 'repair' : code === 'INVALID_REQUEST' ? 'none' : 'refresh' };
}
