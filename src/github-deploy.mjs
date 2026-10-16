import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';

export function githubRepository(value) {
  const match = String(value).match(/^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1].split('/').some(p => p === '.' || p === '..')) throw new Error('Repository must be OWNER/NAME or a credential-free GitHub URL.');
  return match[1];
}

export function updateDeploymentEnv(content, values) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const pending = new Set(Object.keys(values));
  const blocks = [];
  let continuation = [], quote = null;
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (quote) {
      continuation.push(line);
      if (line.includes(quote)) { blocks.push(continuation.join(newline)); continuation = []; quote = null; }
      continue;
    }
    const value = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/)?.[1];
    if (value && ['"', "'", '`'].includes(value[0]) && !value.slice(1).includes(value[0])) {
      quote = value[0]; continuation = [line];
    } else blocks.push(line);
  }
  if (quote) throw new Error('Unclosed multiline value in .env; fix it before deployment.');
  const encode = value => {
    value = String(value);
    for (const candidate of [value, ...["'", '"', '`'].filter(q => !value.includes(q)).map(q => q + value + q)]) {
      if (parseEnv('VALUE=' + candidate).VALUE === value) return candidate;
    }
    throw new Error('Cannot safely encode a publication setting in .env; configure it manually.');
  };
  const lines = blocks.filter(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!Object.hasOwn(values, key)) return true;
    if (!pending.has(key)) return false;
    pending.delete(key); return true;
  }).map(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    return Object.hasOwn(values, key) ? `${key}=${encode(values[key])}` : line;
  });
  while (lines.at(-1) === '') lines.pop();
  return [...lines, ...[...pending].map(key => `${key}=${encode(values[key])}`), ''].join(newline);
}

export function runCommand(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

export async function deployGitHubPages(options, { run = runCommand, exportSite, publishSite, log = () => {} } = {}) {
  const { root, allowPublicData, createPublicRepository = false } = options;
  if (!allowPublicData) throw new Error('Pass --allow-public-data only after agreeing to publish the exported friend aliases, game accounts and match data.');
  const envFile = path.join(root, '.env');
  const original = await readFile(envFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const env = parseEnv(original);
  const repo = githubRepository(options.repository || env.PUBLISH_GIT_REMOTE || '');
  const remote = env.PUBLISH_GIT_REMOTE || `https://github.com/${repo}.git`;
  if (githubRepository(remote).toLowerCase() !== repo.toLowerCase()) throw new Error('The configured publication repository differs. Existing configuration was not replaced.');
  if (env.PUBLISH_GIT_BRANCH && env.PUBLISH_GIT_BRANCH !== 'main') throw new Error('This helper supports main only; existing branch configuration was not replaced.');
  const directory = path.resolve(root, env.STATIC_OUTPUT_DIR || 'site');
  const dataDirectory = path.resolve(root, env.DATA_DIR || 'data');
  const next = updateDeploymentEnv(original, {
    STATIC_EXPORT_ENABLED: '1', STATIC_OUTPUT_DIR: env.STATIC_OUTPUT_DIR || './site',
    PUBLISH_GIT_REMOTE: remote, PUBLISH_GIT_BRANCH: 'main', PUBLISH_MIN_INTERVAL_MINUTES: env.PUBLISH_MIN_INTERVAL_MINUTES || '120',
  });
  async function checked(command, args) {
    const result = await run(command, args, { cwd: root });
    if (result.code !== 0) throw new Error(`${command} failed: ${result.stderr || 'check installation, login and network access'}`);
    return result.stdout;
  }
  async function api(route, fields = null, missing = false) {
    const args = ['api', ...(fields ? ['--method', 'POST'] : []), route, ...Object.entries(fields || {}).flatMap(([k, v]) => ['-f', `${k}=${v}`])];
    const r = await run('gh', args, { cwd: root });
    if (r.code !== 0) {
      if (missing && /HTTP 404/.test(r.stderr)) return null;
      throw new Error(`GitHub API failed: ${r.stderr || route}`);
    }
    return JSON.parse(r.stdout);
  }
  log('Checking Git, GitHub CLI and login...');
  await checked('git', ['--version']); await checked('gh', ['--version']);
  await checked('gh', ['auth', 'status', '--hostname', 'github.com']);
  const top = await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { cwd: root });
  const ownRepository = top.code === 0 && path.resolve(top.stdout) === directory;
  let origin = null;
  if (ownRepository) {
    const existing = await run('git', ['-C', directory, 'remote', 'get-url', 'origin'], { cwd: root });
    if (existing.code === 0) origin = existing.stdout;
    if (origin && origin !== remote) throw new Error('The generated site already points to another remote URL; nothing was changed.');
  }
  let repository = await api(`repos/${repo}`, null, true);
  if (!repository && !createPublicRepository) throw new Error('Repository not found. Use --create-public-repository to create a dedicated PUBLIC repository, or create an empty repository yourself.');
  if (repository?.private) throw new Error('Repository is private. This helper never changes visibility; use a dedicated public repository for free Pages, or configure your paid plan manually.');
  if (repository && !(ownRepository && origin)) {
    const contents = await api(`repos/${repo}/contents`, null, true);
    if (contents) throw new Error('Existing remote repository is not empty. Refusing to publish over an unrelated repository.');
  }
  let pages = repository ? await api(`repos/${repo}/pages`, null, true) : null;
  if (pages && (pages.build_type !== 'legacy' || pages.source?.branch !== 'main' || pages.source?.path !== '/')) throw new Error('Existing Pages configuration is different. It was not overwritten.');
  log('Exporting only the sanitized read-only site...');
  await exportSite({ directory, dataDirectory });
  if (!repository) {
    log(`Creating public repository ${repo}...`);
    await checked('gh', ['repo', 'create', repo, '--public', '--description', 'Read-only static snapshots for Broken Arrow friends match analysis']);
  }
  if (!ownRepository) await checked('git', ['-C', directory, 'init', '-b', 'main']);
  // Scope GitHub CLI credentials to the generated repository, never global Git config.
  await checked('git', ['-C', directory, 'config', '--local', '--replace-all', 'credential.https://github.com.helper', '']);
  await checked('git', ['-C', directory, 'config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential']);
  log('Pushing the generated snapshot...');
  const publication = await publishSite({ directory, dataDirectory, remote, branch: 'main' });
  if (!pages) pages = await api(`repos/${repo}/pages`, { 'source[branch]': 'main', 'source[path]': '/' });
  if ((await readFile(envFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })) !== original) throw new Error('The .env file changed during deployment. Site was published, but automatic publication configuration was not overwritten; rerun after reviewing it.');
  const temporary = envFile + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, next, { mode: 0o600 }); await rename(temporary, envFile); }
  finally { await unlink(temporary).catch(() => {}); }
  return { url: pages.html_url, status: pages.status || 'pending', repository: repo, revision: publication.revision };
}
