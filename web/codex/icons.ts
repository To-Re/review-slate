export type IconName = 'repository' | 'folder' | 'file' | 'code' | 'test' | 'markdown' | 'settings' | 'refresh' | 'history' | 'plus' | 'chevron' | 'comment' | 'copy' | 'branch' | 'diff' | 'check' | 'arrow' | 'agent' | 'expand-all' | 'collapse-all';
const paths: Record<IconName, string[]> = {
  repository: ['M4 3h13v17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M5 3v13M2 16h15M8 7h5M8 10h5'],
  folder: ['M2 6h7l2 2h11v12H2Z', 'M2 6V4h7l2 2h9v2'],
  file: ['M5 2h9l5 5v15H5Z', 'M14 2v6h5M8 12h8M8 16h6'],
  code: ['M8 6 2 12l6 6M16 6l6 6-6 6M14 3l-4 18'],
  test: ['M9 2h6M10 2v7l-6 10a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L14 9V2M8 15h8', 'M10 18h.01M14 19h.01'],
  markdown: ['M2 4h20v16H2Z', 'M5 16V8l4 5 4-5v8M18 8v8l-2-2M18 16l2-2'],
  settings: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  refresh: ['M20 7a9 9 0 1 0 1 9M20 2v6h-6'],
  history: ['M3 11a9 9 0 1 1 2 7M3 4v7h7M12 6v6l4 2'],
  plus: ['M12 5v14M5 12h14'], chevron: ['M8 4l8 8-8 8'],
  comment: ['M3 3h18v14H8l-5 4Z', 'M7 7h10M7 11h7'],
  copy: ['M8 8h13v13H8Z', 'M16 8V3H3v13h5'],
  branch: ['M6 6v12M18 6v3a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3', 'M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z'],
  diff: ['M3 3h18v18H3ZM12 3v18M6 9h3M6 13h3M15 12h3M16.5 10.5v3'],
  check: ['M4 12l5 5L20 6'], arrow: ['M4 12h16M14 6l6 6-6 6'],
  agent: ['M12 2v3M5 5h14v14H5ZM2 9v6M22 9v6M9 10h.01M15 10h.01M9 15h6'],
  'expand-all': ['M5 3h14M5 21h14M8 10l4-4 4 4M8 14l4 4 4-4'],
  'collapse-all': ['M5 3h14M5 21h14M8 6l4 4 4-4M8 18l4-4 4 4'],
};
/** Local, decorative SVGs. Accessible names belong to their labelled controls. */
export function icon(name: IconName, className = ''): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('class', `icon ${className}`);
  node.setAttribute('aria-hidden', 'true'); node.setAttribute('focusable', 'false');
  node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '1.7');
  node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round');
  paths[name].forEach(d => { const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', d); node.append(path); });
  return node;
}
