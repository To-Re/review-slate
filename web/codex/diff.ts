import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { MergeView } from '@codemirror/merge';
import type { Anchor, DiffView, Navigation, Side } from '../../src/codex/contract';
import { selectionAnchor } from './model';

export class DiffEditor {
  merge: MergeView;
  private labelConfig = { left: new Compartment(), right: new Compartment() };
  private labels: Record<Side, string>;
  constructor(parent: HTMLElement, readonly data: DiffView, readonly onSelection: (anchor?: Anchor, error?: string) => void,
    onPosition: (side: Side, line: number, scroll: number) => void, labels: Record<Side, string>) {
    this.labels = labels;
    const extensions = (side: Side) => [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), drawSelection(),
      keymap.of(defaultKeymap), this.labelConfig[side].of(EditorView.contentAttributes.of({ 'aria-label': labels[side], tabindex: '0' })),
      EditorView.updateListener.of(update => {
        if (update.selectionSet) {
          const selection = update.state.selection.main;
          if (selection.empty) { onSelection(undefined); return; }
          const start = update.state.doc.lineAt(selection.from).number - 1;
          const last = selection.to > selection.from && update.state.doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to;
          const end = update.state.doc.lineAt(last).number - 1;
          try { onSelection(selectionAnchor(data, side, start, end)); } catch (error) { onSelection(undefined, (error as Error).message); }
          onPosition(side, start, update.view.scrollDOM.scrollTop);
        }
      }), EditorView.domEventHandlers({ scroll: (_event, view) => {
        onPosition(side, view.state.doc.lineAt(view.state.selection.main.head).number - 1, view.scrollDOM.scrollTop);
      } }),
      EditorView.theme({ '&': { height: '100%', fontSize: '12px' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '1.8' }, '.cm-content': { minWidth: 'max-content' }, '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--border)' } }),
    ];
    this.merge = new MergeView({ parent, a: { doc: data.left.text, extensions: extensions('left') },
      b: { doc: data.right.text, extensions: extensions('right') }, highlightChanges: true, gutter: true,
      collapseUnchanged: undefined });
  }
  setLabels(labels: Record<Side, string>): void {
    for (const side of ['left', 'right'] as const) {
      if (this.labels[side] === labels[side]) continue;
      const view = side === 'left' ? this.merge.a : this.merge.b;
      view.dispatch({ effects: this.labelConfig[side].reconfigure(EditorView.contentAttributes.of({ 'aria-label': labels[side], tabindex: '0' })) });
    }
    this.labels = labels;
  }
  restore(navigation: Navigation): boolean {
    if (navigation.anchor && navigation.anchor.hash === this.data[navigation.anchor.side].hash) {
      this.locate(navigation.anchor.side, navigation.anchor.start, navigation.anchor.end, false);
      const selected = navigation.anchor.side === 'left' ? this.merge.a : this.merge.b;
      if (navigation.scroll !== undefined) selected.scrollDOM.scrollTop = navigation.scroll;
      return true;
    }
    if (navigation.line === undefined) return true;
    if (navigation.fingerprint !== this.data.fingerprint) return false;
    this.locate(navigation.side, navigation.line, navigation.line, false);
    const view = navigation.side === 'left' ? this.merge.a : this.merge.b;
    if (navigation.scroll !== undefined) view.scrollDOM.scrollTop = navigation.scroll;
    return true;
  }
  locate(side: Side, start: number, end = start, focus = true): void {
    const view = side === 'left' ? this.merge.a : this.merge.b;
    if (start < 0 || end >= view.state.doc.lines) return;
    view.dispatch({ selection: { anchor: view.state.doc.line(start + 1).from, head: view.state.doc.line(end + 1).to }, effects: EditorView.scrollIntoView(view.state.doc.line(start + 1).from, { y: 'center' }) });
    if (focus) view.focus();
  }
  destroy(): void { this.merge.destroy(); }
}
