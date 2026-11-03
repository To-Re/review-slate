const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const spec = require('./codex-runtime.json');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'artifacts', 'codex-runtime');
const source = path.join(cache, `node-v${spec.version}-${spec.platform}`);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

async function prepare() {
  fs.mkdirSync(cache, { recursive: true });
  if (fs.realpathSync(cache) !== cache) throw new Error('Runtime cache must not contain symbolic links.');
  const archive = path.join(cache, spec.archive);
  if (fs.existsSync(archive) && (fs.lstatSync(archive).isSymbolicLink() || sha(fs.readFileSync(archive)) !== spec.sha256)) {
    throw new Error('Existing runtime archive does not match the pinned checksum. Remove only that build artifact and retry.');
  }
  if (!fs.existsSync(archive)) {
    const temp = `${archive}.${process.pid}.tmp`;
    try {
      const response = await new Promise((resolve, reject) => {
        const req = https.get(spec.url, { timeout: 60000 }, res => {
          if (res.statusCode !== 200) { res.resume(); reject(new Error(`Runtime download returned ${res.statusCode}`)); return; }
          resolve(res);
        });
        req.on('timeout', () => req.destroy(new Error('Runtime download timed out.')));
        req.on('error', reject);
      });
      await pipeline(response, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (sha(fs.readFileSync(temp)) !== spec.sha256) throw new Error('Official runtime checksum mismatch.');
      fs.renameSync(temp, archive);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  if (fs.existsSync(source)) {
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Runtime output must not be a symbolic link.');
    fs.rmSync(source, { recursive: true });
  }
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', cache,
    `node-v${spec.version}-${spec.platform}/bin/node`, `node-v${spec.version}-${spec.platform}/LICENSE`], { stdio: 'inherit' });
  const binary = path.join(source, 'bin', 'node');
  if (fs.lstatSync(binary).isSymbolicLink() || fs.realpathSync(binary) !== binary) throw new Error('Unexpected runtime path.');
  console.log(`Prepared official Node.js ${spec.version} (${spec.platform}); checksum verified.`);
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
