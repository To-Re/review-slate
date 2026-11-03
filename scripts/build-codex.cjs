const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const runtime = require('./codex-runtime.json');
const root = path.resolve(__dirname, '..');
const manifest = require('../plugins/codex/plugin.json');
const packageRuntime = process.argv.includes('--package');
const output = path.join(root, 'artifacts', 'codex-build', 'reviewslate');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');

function write(file, content) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Package must not contain symbolic links.');
    return entry.isDirectory() ? files(file) : [file];
  });
}
function licenses(inputs) {
  const seen = new Map();
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory.startsWith(root + path.sep)) {
      const packageFile = path.join(directory, 'package.json');
      if (fs.existsSync(packageFile)) {
        const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        if (!pkg.name) { directory = path.dirname(directory); continue; }
        if (!seen.has(pkg.name)) {
          const texts = fs.readdirSync(directory).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)([.-]|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
          if (!texts.length) throw new Error(`Bundled dependency lacks a license file: ${pkg.name}`);
          for (const name of texts) write(`licenses/${pkg.name.replace(/[^a-zA-Z0-9.-]/g, '_')}/${name}`, fs.readFileSync(path.join(directory, name)));
          seen.set(pkg.name, { version: pkg.version, license: pkg.license || 'SEE LICENSE FILES' });
        }
        break;
      }
      directory = path.dirname(directory);
    }
  }
  return Object.fromEntries([...seen].sort(([a], [b]) => a.localeCompare(b)));
}
async function build() {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Invalid package version.');
  if (packageRuntime) execFileSync(process.execPath, [path.join(root, 'native/codex-folder-picker/build.cjs')], { cwd: root, stdio: 'inherit' });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Build directory must not contain symbolic links.');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Build output must not be a symbolic link.');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const [server, ui] = await Promise.all([
    esbuild.build({ absWorkingDir: root, entryPoints: ['src/codex/server.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: path.join(output, 'server/index.cjs'), metafile: true, sourcemap: false, legalComments: 'inline' }),
    esbuild.build({ absWorkingDir: root, entryPoints: ['web/codex/app.ts'], bundle: true, platform: 'browser', target: ['safari16', 'chrome110'], format: 'iife', loader: { '.svg': 'dataurl' }, define: { __REVIEW_SLATE_VERSION__: JSON.stringify(manifest.version) }, write: false, metafile: true, sourcemap: false, legalComments: 'inline' })
  ]);
  const js = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(root, 'web/codex/workspace.css'), 'utf8');
  let html = fs.readFileSync(path.join(root, 'web/codex/index.html'), 'utf8');
  const scriptHash = crypto.createHash('sha256').update(js).digest('base64');
  html = html.replace(/<link\b[^>]*href=["']\.\/?workspace\.css["'][^>]*>/, () => `<style>${css}</style>`)
    .replace(/<script\b[^>]*src=["']\.\/?app\.ts["'][^>]*><\/script>/, () => `<script>${js}</script>`)
    .replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  if (/<script[^>]+src=|<link[^>]+stylesheet/.test(html)) throw new Error('UI still has external script or stylesheet references.');
  html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">`);
  write('ui/workspace.html', html);
  for (const file of ['plugin.json', 'mcp.json', 'bin/launch.sh']) write(file, fs.readFileSync(path.join(root, 'plugins/codex', file)));
  for (const file of ['composer-icon.png', 'logo.png', 'reviewslate.svg']) write(`assets/${file}`, fs.readFileSync(path.join(root, 'plugins/codex/assets', file)));
  fs.chmodSync(path.join(output, 'bin/launch.sh'), 0o755);
  write('LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));
  const inputs = [...new Set([...Object.keys(server.metafile.inputs), ...Object.keys(ui.metafile.inputs)])].sort();
  if (inputs.some(input => /(?:^|\/)vscode(?:\/|$)/.test(input))) throw new Error('Codex bundle must not depend on VS Code.');
  const dependencies = licenses(inputs);
  if (packageRuntime) {
    const cache = path.join(root, 'artifacts', 'codex-runtime');
    const archive = path.join(cache, runtime.archive);
    const source = path.join(cache, `node-v${runtime.version}-${runtime.platform}`);
    if (!fs.existsSync(archive) || sha(fs.readFileSync(archive)) !== runtime.sha256) throw new Error('Run npm run prepare:codex-runtime first; pinned runtime archive required.');
    const binary = path.join(source, 'bin/node');
    if (!fs.existsSync(binary) || fs.realpathSync(binary) !== binary) throw new Error('Prepared runtime is missing or symlinked.');
    const expectedBinary = execFileSync('/usr/bin/tar', ['-xOzf', archive, `node-v${runtime.version}-${runtime.platform}/bin/node`], { maxBuffer: 200 * 1024 * 1024 });
    if (sha(expectedBinary) !== sha(fs.readFileSync(binary))) throw new Error('Prepared runtime no longer matches its archive.');
    write('runtime/darwin-arm64/node', expectedBinary);
    fs.chmodSync(path.join(output, 'runtime/darwin-arm64/node'), 0o755);
    write('licenses/node/LICENSE', execFileSync('/usr/bin/tar', ['-xOzf', archive, `node-v${runtime.version}-${runtime.platform}/LICENSE`], { maxBuffer: 5 * 1024 * 1024 }));
    const helper = path.join(root, 'artifacts/codex-native/ReviewSlate Folder Picker.app');
    if (!fs.existsSync(helper) || fs.realpathSync(helper) !== helper) throw new Error('Native folder picker is missing or symlinked.');
    for (const file of files(helper)) {
      const target = path.join('native/ReviewSlate Folder Picker.app', path.relative(helper, file));
      write(target, fs.readFileSync(file));
      fs.chmodSync(path.join(output, target), fs.statSync(file).mode & 0o777);
    }
  }
  const inputFiles = [...inputs.filter(input => !input.includes('node_modules/')), 'web/codex/index.html', 'web/codex/workspace.css', 'plugins/codex/plugin.json', 'plugins/codex/mcp.json', 'plugins/codex/bin/launch.sh', 'plugins/codex/assets/composer-icon.png', 'plugins/codex/assets/logo.png', 'plugins/codex/assets/reviewslate.svg', 'package-lock.json', 'scripts/build-codex.cjs', 'scripts/codex-runtime.json'];
  if (packageRuntime) inputFiles.push(...files(path.join(root, 'native/codex-folder-picker')).map(relative));
  const sources = Object.fromEntries([...new Set(inputFiles)].sort().map(file => [relative(path.resolve(root, file)), sha(fs.readFileSync(path.resolve(root, file)))]));
  const assets = Object.fromEntries(files(output).sort().map(file => [path.relative(output, file).split(path.sep).join('/'), { bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }]));
  write('build-manifest.json', JSON.stringify({ name: manifest.name, version: manifest.version, platform: 'darwin-arm64', runtime: packageRuntime ? runtime : null, dependencies, sourceHashes: sources, files: assets, unpackedBytes: Object.values(assets).reduce((n, item) => n + item.bytes, 0) }, null, 2) + '\n');
  if (packageRuntime) {
    const archive = path.join(root, 'artifacts', `reviewslate-codex-${manifest.version}-darwin-arm64.zip`);
    fs.rmSync(archive, { force: true });
    execFileSync('/usr/bin/zip', ['-qr', archive, 'reviewslate'], { cwd: path.dirname(output), stdio: 'inherit' });
    console.log(`Packaged ${path.basename(archive)} (${fs.statSync(archive).size} bytes).`);
  } else console.log('Built Codex UI/server. Development bundle has no bundled runtime.');
  console.log(`Output: ${relative(output)}`);
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
