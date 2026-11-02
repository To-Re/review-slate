const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { GitRepository } = require('../dist/git'), { ReviewService } = require('../dist/review');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
async function fixture(t, initial = { 'src/a.txt': 'alpha\n', 'src/b.txt': 'beta\n' }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-rewrite-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'), storage = path.join(temp, 'storage'); await fs.mkdir(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '/.code-review/\n');
  for (const [name, text] of Object.entries(initial)) await write(name, text);
  git('add', '-A'); git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD'); git('switch', '-qc', 'feature');
  const repo = await GitRepository.open(root), service = new ReviewService(repo, storage); await service.start();
  const choose = () => service.choose(base, '指定提交');
  const mark = (names, checked = true, directory) => service.mark({ session: service.view.session.id, directory, files: service.view.files.filter(file => names.includes(file.path)).map(file => ({ path: file.path, fingerprint: file.fingerprint, checked })) });
  return { temp, root: repo.root, storage, git, write, base, repo, service, choose, mark };
}
module.exports = { fixture, env };
