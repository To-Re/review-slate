const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', `review-slate-${version}.vsix`);
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '--out', output], {
  cwd: root,
  stdio: 'inherit'
});
