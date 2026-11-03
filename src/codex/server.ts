import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CodexController, ControllerOptions } from './controller';
import { ACTION_TO_TOOL, META_KEY, Reply, UI_RESOURCE } from './contract';
import { requestSchema } from './validation';
import { failureOf } from './errors';

export interface ServerOptions extends ControllerOptions { version?: string; uiFile?: string }
const response = (reply: Reply) => ({
  content: [{ type: 'text' as const, text: reply.ok ? 'ReviewSlate workspace response.' : 'ReviewSlate could not complete this workspace action.' }],
  ...(reply.ok ? {} : { isError: true }), _meta: { [META_KEY]: reply }
});
export function createCodexServer(options: ServerOptions = {}): { server: McpServer; controller: CodexController } {
  const controller = new CodexController(options);
  const server = new McpServer({ name: 'reviewslate', version: options.version || '0.1.0' });
  const uiFile = options.uiFile || process.env.REVIEW_SLATE_UI_FILE || path.resolve(__dirname, '..', 'ui', 'workspace.html');
  server.registerResource('ReviewSlate workspace', UI_RESOURCE, { mimeType: 'text/html;profile=mcp-app' }, async () => {
    const stat = await fs.lstat(uiFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) throw new Error('Invalid ReviewSlate UI resource');
    return { contents: [{ uri: UI_RESOURCE, mimeType: 'text/html;profile=mcp-app', text: await fs.readFile(uiFile, 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } } }] };
  });
  server.registerTool('reviewslate_open', {
    title: 'ReviewSlate', description: 'Open the local ReviewSlate human Git review workspace. Repository access happens only after selection inside the app.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: UI_RESOURCE, visibility: ['model', 'app'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] } }
  }, async () => ({ content: [{ type: 'text', text: 'Open ReviewSlate to choose a repository and continue your review.' }] }));
  server.registerTool('reviewslate_bootstrap', {
    title: 'Connect ReviewSlate workspace', description: 'Initialize this app instance. Does not open repositories.', inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } }
  }, async () => {
    try { return response({ protocol: 1, ok: true, outcome: 'read', data: await controller.bootstrap() }); }
    catch (error) { const failure = failureOf(error); return response({ protocol: 1, ok: false, outcome: failure.outcome, error: failure }); }
  });
  for (const name of new Set(Object.values(ACTION_TO_TOOL))) {
    server.registerTool(name, {
      title: name.replaceAll('_', ' '), description: name === 'reviewslate_folder_pick' ? 'App-only local folder chooser. Start only after a user click; selection does not open a repository. Poll or cancel using the same selection ID.' : 'App-only ReviewSlate action. Requires a capability from the current app instance and an explicitly selected repository.',
      inputSchema: z.object({ request: requestSchema }).strict(),
      annotations: { readOnlyHint: name === 'reviewslate_read', destructiveHint: name === 'reviewslate_review_purge', openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } }
    }, async ({ request }) => {
      if (ACTION_TO_TOOL[request.action] !== name) return response({ protocol: 1, ok: false, outcome: 'rejected',
        error: { code: 'INVALID_REQUEST', message: 'This action does not belong to this tool.', outcome: 'rejected', retry: 'none' } });
      return response(await controller.dispatch(request));
    });
  }
  return { server, controller };
}

async function main(): Promise<void> {
  let version = process.env.REVIEW_SLATE_VERSION || '0.1.0';
  if (!process.env.REVIEW_SLATE_VERSION) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '..', 'plugin.json'), 'utf8')) as { version?: unknown };
      if (typeof manifest.version === 'string') version = manifest.version;
    } catch { /* Source-tree tests have no packaged manifest. */ }
  }
  const { server, controller } = createCodexServer({ version });
  const transport = new StdioServerTransport();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await controller.close();
    await server.close();
  };
  process.stdin.once('end', () => { void stop(); });
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
  await server.connect(transport);
}
if (require.main === module) void main().catch(() => { process.stderr.write('ReviewSlate startup failed. Check the plugin package and local permissions.\n'); process.exitCode = 1; });
