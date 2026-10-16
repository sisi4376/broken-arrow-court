import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { githubRepository, updateDeploymentEnv, runCommand } from './github-deploy.mjs';

async function optional(file, fallback = '') {
  try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function json(text, fallback = {}) { try { return JSON.parse(text); } catch { return fallback; } }
function localUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password) return u.origin;
  } catch {}
  return null;
}

export async function desktopStatus(root, { checkTools = false, run = runCommand, fetcher = fetch } = {}) {
  const env = parseEnv(await optional(path.join(root, '.env')));
  const data = path.resolve(root, env.DATA_DIR || 'data'), site = path.resolve(root, env.STATIC_OUTPUT_DIR || 'site');
  const state = json(await optional(path.join(data, 'service.json')));
  const publication = json(await optional(path.join(data, 'publication.json')));
  const manifest = json(await optional(path.join(site, 'manifest.json')));
  const url = localUrl(state.url) || `http://127.0.0.1:${/^\d{1,5}$/.test(env.PORT || '') ? env.PORT : '4317'}`;
  let running = false;
  if (localUrl(state.url)) try { running = (await fetcher(url + '/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  let friends = 0, matches = 0, databaseIssue = null, db;
  try {
    db = new DatabaseSync(path.join(data, 'court.sqlite'), { readOnly: true });
    friends = db.prepare('SELECT COUNT(*) n FROM members WHERE active=1').get().n;
    matches = db.prepare('SELECT COUNT(*) n FROM matches WHERE friend_count>=3').get().n;
  } catch (e) { databaseIssue = e.message; } finally { db?.close(); }
  let repository = '';
  try { if (env.PUBLISH_GIT_REMOTE) repository = githubRepository(env.PUBLISH_GIT_REMOTE); } catch {}
  const result = {
    project: root, data_directory: data, static_directory: site, service_running: running, local_url: url,
    repository, public_url: repository ? `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/` : '',
    interval_minutes: Number(env.PUBLISH_MIN_INTERVAL_MINUTES) || 120,
    friends, matches, database_issue: databaseIssue,
    exported_at: manifest.published_at || publication.exported_at || null,
    pushed_at: publication.last_push || null, revision: manifest.revision || null,
    pushed_revision: publication.pushed_revision || null,
  };
  if (checkTools) {
    const safeRun = async (command, args) => { try { return await run(command, args, { cwd: root }); } catch { return { code: -1, stdout: '', stderr: '' }; } };
    const git = await safeRun('git', ['--version']), gh = await safeRun('gh', ['--version']);
    const auth = gh.code === 0 ? await safeRun('gh', ['auth', 'status', '--hostname', 'github.com']) : { code: -1 };
    result.git_available = git.code === 0; result.gh_available = gh.code === 0; result.github_signed_in = auth.code === 0;
    result.github_account = auth.code === 0 ? (auth.stdout + '\n' + auth.stderr).match(/account\s+([^\s(]+)/)?.[1] || '' : '';
    if (repository && auth.code === 0) {
      const pages = await safeRun('gh', ['api', `repos/${repository}/pages`]);
      const p = json(pages.stdout);
      result.pages_status = pages.code === 0 ? p.status || 'pending' : 'not_available';
      try { const u = new URL(p.html_url); if (u.protocol === 'https:' && !u.username && !u.password) result.public_url = u.href; } catch {}
    }
  }
  return result;
}

export async function savePublicationInterval(root, minutes) {
  const interval = Number(minutes);
  if (!Number.isInteger(interval) || interval < 5 || interval > 10080) throw new Error('自动发布间隔必须是 5 至 10080 的整数分钟');
  const file = path.join(root, '.env'), original = await optional(file);
  const content = updateDeploymentEnv(original, { PUBLISH_MIN_INTERVAL_MINUTES: String(interval) });
  if (content !== original) {
    if (await optional(file) !== original) throw new Error('配置文件同时被修改，未覆盖，请重新检查后再保存');
    const temp = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, content, { mode: 0o600 }); await rename(temp, file); }
    finally { await unlink(temp).catch(() => {}); }
  }
  return { interval_minutes: interval, restart_required: true };
}
