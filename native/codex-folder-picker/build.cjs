'use strict';
// Build only. No implicit launch, installation, automation, or network access.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const version = require('../../plugins/codex/plugin.json').version;
if (process.platform !== 'darwin') throw new Error('The folder picker requires the macOS SDK.');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid helper version.');
const output = path.join(root, 'artifacts/codex-native/ReviewSlate Folder Picker.app');
fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.realpathSync(path.dirname(output)) !== path.dirname(output) ||
    (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())) throw new Error('Invalid native build directory.');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'Contents/MacOS'), { recursive: true });
fs.writeFileSync(path.join(output, 'Contents/Info.plist'), fs.readFileSync(path.join(__dirname, 'Info.plist'), 'utf8').replaceAll('@VERSION@', version));
execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-O2', '-arch', 'arm64', '-mmacosx-version-min=13.0',
  '-fdebug-prefix-map=' + root + '=.', '-ffile-prefix-map=' + root + '=.', '-framework', 'AppKit',
  'native/codex-folder-picker/main.m', '-o', path.relative(root, path.join(output, 'Contents/MacOS/ReviewSlateFolderPicker'))],
  { cwd: root, stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'org.reviewslate.folderpicker', output], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], { stdio: 'inherit' });
process.stdout.write('Built artifacts/codex-native/ReviewSlate Folder Picker.app (arm64, macOS 13+); not launched.\n');
