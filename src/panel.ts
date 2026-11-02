import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface CommentCard { id: string; revision: string; body: string; status: string; resolved: boolean; location: string; quote?: string; reply?: string; canLocate: boolean; targetLabel?: string }
export interface CommentTarget { path: string; target?: 'directory'; label: string; pending: number; resolved: number }
export interface PanelModel { key?: string; draftKey?: string; legacyDraftKey?: string; repositoryKey?: string; reviewId?: string; reviewIds?: string[]; discardDraftKeys?: string[]; file?: string; target?: 'directory'; anchor?: string; quote?: string; cards: CommentCard[]; deleted?: { id: string; revision: string; body: string }[]; pending: number; error?: string; overview?: boolean; targets?: CommentTarget[] }
export interface PanelMessage {
  action: 'add' | 'edit' | 'resolve' | 'reopen' | 'delete' | 'restore' | 'locate' | 'selection' | 'clear' | 'handoff' | 'pending' | 'openTarget';
  key?: string; id?: string; revision?: string; body?: string; requestId: string; path?: string; target?: 'directory';
}
export class CommentPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private listener?: vscode.Disposable;
  private model: PanelModel = { cards: [], pending: 0 };
  constructor(private readonly extensionPath: string, private readonly receive: (message: PanelMessage) => void) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.listener?.dispose(); this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.listener = view.webview.onDidReceiveMessage(value => {
      if (!value || typeof value !== 'object') return;
      if (value.action === 'ready') { this.render(this.model); return; }
      if (!['add', 'edit', 'resolve', 'reopen', 'delete', 'restore', 'locate', 'selection', 'clear', 'handoff', 'pending', 'openTarget'].includes(value.action)) return;
      if (typeof value.requestId !== 'string' || value.requestId.length > 100) return;
      if (value.body !== undefined && (typeof value.body !== 'string' || value.body.length > 20000)) return;
      if (['key', 'id', 'revision', 'path'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1024))) return;
      if (value.target !== undefined && value.target !== 'directory') return;
      this.receive(value as PanelMessage);
    });
    const nonce = randomBytes(24).toString('base64');
    const css = fs.readFileSync(path.join(this.extensionPath, 'media/comments.css'), 'utf8');
    const script = fs.readFileSync(path.join(this.extensionPath, 'media/comments.js'), 'utf8');
    view.webview.html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce + '\'; style-src \'nonce-' + nonce + '\'">' +
      '<style nonce="' + nonce + '">' + css + '</style></head><body>' +
      '<header><button id="handoff">交给 Agent</button><button id="pending">待处理评论</button></header>' +
      '<h3 id="file">先选择文件或目录</h3><p id="summary" class="muted"></p><p id="error" role="alert"></p>' +
      '<section id="targets-section" hidden><h4>子目录与文件的评论</h4><div id="targets"></div></section>' +
      '<div id="composer-home"><section id="composer" hidden><div id="editing-banner" hidden>正在编辑这条评论</div><div id="anchor" class="muted"></div><pre id="quote" hidden></pre>' +
      '<textarea id="body" maxlength="20000" aria-label="评论内容" placeholder="写下这个文件需要调整的地方…"></textarea>' +
      '<div class="actions"><button id="save" class="primary">保存评论</button><button id="selection">评论所选内容</button><button id="clear" hidden>改为文件评论</button><button id="cancel" hidden>取消编辑</button></div></section></div>' +
      '<p id="empty" class="muted"></p><main id="cards"></main><details id="deleted-section" hidden><summary id="deleted-summary">已删除</summary><div id="deleted-cards"></div></details><script nonce="' + nonce + '">' + script + '</script></body></html>';
  }
  render(model: PanelModel): void { this.model = model; void this.view?.webview.postMessage({ type: 'render', ...model }); }
  acknowledge(requestId: string, error?: string): void { void this.view?.webview.postMessage({ type: 'ack', requestId, error }); }
  show(): void { this.view?.show(true); }
  dispose(): void { this.listener?.dispose(); this.view = undefined; }
}
