import { ACTION_TO_TOOL, META_KEY } from '../../src/codex/contract';
import type { Bootstrap, Reply, Request } from '../../src/codex/contract';
declare const __REVIEW_SLATE_VERSION__: string;

export interface HostContext { locale?: string; theme?: string; styles?: { variables?: Record<string, string> } }
interface Surface {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
export class UnknownResult extends Error {
  constructor() { super('UNKNOWN_RESULT'); }
}
/** Only the embedding parent may resolve requests. RPC IDs never serve as mutation IDs. */
export class Bridge {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  context: HostContext = {};
  onContext?: (context: HostContext) => void;
  private receive = (event: MessageEvent): void => {
    if (event.source !== this.surface.parent || !event.data || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (message.method === 'ui/notifications/host-context-changed') {
      this.context = { ...this.context, ...message.params };
      this.onContext?.(this.context);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request || (!('result' in message) && !('error' in message))) return;
    clearTimeout(request.timer); this.pending.delete(message.id);
    if (message.error) request.reject(new UnknownResult()); else request.resolve(message.result);
  };
  constructor(private surface: Surface, private timeout = 30_000) { surface.addEventListener('message', this.receive); }
  rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new UnknownResult()); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.surface.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new UnknownResult()); }
    });
  }
  async initialize(): Promise<void> {
    const result = await this.rpc('ui/initialize', {
      protocolVersion: '2026-01-26', appInfo: { name: 'ReviewSlate', version: typeof __REVIEW_SLATE_VERSION__ === 'string' ? __REVIEW_SLATE_VERSION__ : 'development' }, appCapabilities: {},
    }) as { hostContext?: HostContext };
    this.context = result?.hostContext || {};
    this.surface.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
    this.onContext?.(this.context);
  }
  private async tool<T>(name: string, args: unknown): Promise<Reply<T>> {
    const result = await this.rpc('tools/call', { name, arguments: args }) as { _meta?: Record<string, unknown> };
    const reply = result?._meta?.[META_KEY] as Reply<T> | undefined;
    if (!reply || reply.protocol !== 1 || typeof reply.ok !== 'boolean' || typeof reply.outcome !== 'string') throw new UnknownResult();
    return reply;
  }
  bootstrap(): Promise<Reply<Bootstrap>> { return this.tool('reviewslate_bootstrap', {}); }
  call<T>(request: Request): Promise<Reply<T>> { return this.tool(ACTION_TO_TOOL[request.action], { request }); }
  destroy(): void {
    this.surface.removeEventListener('message', this.receive);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new UnknownResult()); }
    this.pending.clear();
  }
}
