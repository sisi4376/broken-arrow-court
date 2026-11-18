import { access, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { githubRepository, updateDeploymentEnv, runCommand } from './github-deploy.mjs';
import { syncSchedule } from './sync-schedule.mjs';
import { requestMonitor } from './request-monitor.mjs';
import { requestStatistics } from './request-statistics.mjs';
import { localStorage } from './local-storage.mjs';
import { SOURCE_PROVIDERS } from './source-provider.mjs';
import {BUILD_POLICY,effectiveSettings} from './distribution.mjs';

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

export async function desktopStatus(root, { checkTools = false, run = runCommand, fetcher = fetch, statistics={},storage=false } = {}) {
  const env = parseEnv(await optional(path.join(root, '.env')));
  const data = path.resolve(root, env.DATA_DIR || 'data'), site = path.resolve(root, env.STATIC_OUTPUT_DIR || 'site');
  const state = json(await optional(path.join(data, 'service.json')));
  const publication = json(await optional(path.join(data, 'publication.json')));
  const manifest = json(await optional(path.join(site, 'manifest.json')));
  const url = localUrl(state.url) || `http://127.0.0.1:${/^\d{1,5}$/.test(env.PORT || '') ? env.PORT : '4317'}`;
  let running = false;
  if (localUrl(state.url)) try { running = (await fetcher(url + '/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  let friends = 0, matches = 0, databaseIssue = null, db, lastSync = null, syncEnabled = null, traffic = null,provider='official',scheduleSeed='';
  try {
    db = new DatabaseSync(path.join(data, 'court.sqlite'), { readOnly: true });
    friends = db.prepare('SELECT COUNT(*) n FROM members WHERE active=1').get().n;
    matches = db.prepare('SELECT COUNT(*) n FROM matches WHERE friend_count>=3').get().n;
    lastSync = db.prepare('SELECT status,started_at,finished_at FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get()??null;
    const setting=db.prepare("SELECT value FROM settings WHERE key='sync_enabled'").get();
    syncEnabled=setting?json(setting.value,false)===true:false;
    const savedProvider=json(db.prepare("SELECT value FROM settings WHERE key='source_provider'").get()?.value??'"official"','official');
    provider=SOURCE_PROVIDERS[savedProvider]&&!SOURCE_PROVIDERS[savedProvider].disabled?savedProvider:'official';
    scheduleSeed=json(db.prepare("SELECT value FROM settings WHERE key='release_schedule_seed'").get()?.value??'""','');
    const reader={policy:BUILD_POLICY,get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),settings:()=>effectiveSettings(Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key LIKE 'request_limit_%'").all().map(row=>[row.key,json(row.value)])),BUILD_POLICY)};
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_requests'").get()){
      const m=requestMonitor(reader,SOURCE_PROVIDERS[provider].base);
      const query=requestStatistics(reader,statistics),today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),current=requestStatistics(reader,{from:today,to:today});
      traffic={today:current.summary.requests,total:m.statistics.summary.requests,bytes_today:current.summary.bytes,unknown_bytes_today:current.summary.unknown_bytes_requests,bytes_total:m.statistics.summary.bytes,pending_today:current.summary.pending,monitored_since:m.monitored_since,daily:query.rows,statistics:query,lifetime:m.statistics.summary};
    }
  } catch (e) { databaseIssue = e.message; } finally { db?.close(); }
  let repository = '';
  try { if (env.PUBLISH_GIT_REMOTE) repository = githubRepository(env.PUBLISH_GIT_REMOTE); } catch {}
  const result = {
    project: root, data_directory: data, static_directory: site, service_running: running, local_url: url,
    repository, public_url: repository ? `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/` : '',
    interval_minutes: Number(env.PUBLISH_MIN_INTERVAL_MINUTES) || 120,
    friends, matches, database_issue: databaseIssue,
    edition:BUILD_POLICY.edition,last_sync:lastSync,sync_schedule:syncSchedule(Date.now(),BUILD_POLICY,scheduleSeed),sync_enabled:syncEnabled,request_monitor:traffic,
    source_provider:provider,source_providers:SOURCE_PROVIDERS,
    exported_at: manifest.published_at || publication.exported_at || null,
    pushed_at: publication.last_push || null, revision: manifest.revision || null,
    pushed_revision: publication.pushed_revision || null,
  };
  if(storage)result.storage=await localStorage(root,{data,site});
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

export async function saveSourceProvider(root,provider,{fetcher=fetch}={}){
  if(!Object.hasOwn(SOURCE_PROVIDERS,provider))throw Error('请选择官方上游');
  if(SOURCE_PROVIDERS[provider].disabled)throw Error('BATrace 数据源暂时冻结，请使用官方上游');
  const env=parseEnv(await optional(path.join(root,'.env'))),data=path.resolve(root,env.DATA_DIR||'data'),state=json(await optional(path.join(data,'service.json'))),url=localUrl(state.url);
  let running=false;if(url)try{running=(await fetcher(url+'/api/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{}
  if(running){const response=await fetcher(url+'/api/service/source',{method:'POST',headers:{'Content-Type':'application/json','X-Service-Token':state.shutdown_token},body:JSON.stringify({provider}),signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('数据源切换失败，请等待当前请求结束或重启后台后重试');}
  else{const file=path.join(data,'court.sqlite');await access(file);const db=new DatabaseSync(file);try{db.exec('PRAGMA busy_timeout=5000');db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('source_provider',JSON.stringify(provider));}finally{db.close();}}
  return {provider,label:SOURCE_PROVIDERS[provider].label};
}

export async function saveAutoSync(root, enabled, {fetcher=fetch}={}) {
  if(typeof enabled!=='boolean')throw new Error('自动同步必须为开启或关闭');
  const env=parseEnv(await optional(path.join(root,'.env'))),data=path.resolve(root,env.DATA_DIR||'data');
  const state=json(await optional(path.join(data,'service.json'))),url=localUrl(state.url);
  let running=false;
  if(url)try{running=(await fetcher(url+'/api/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{}
  if(running){
    const response=await fetcher(url+'/api/service/sync',{method:'POST',headers:{'Content-Type':'application/json','X-Service-Token':state.shutdown_token},body:JSON.stringify({enabled}),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('自动同步设置保存失败，请重启后台后重试');
  }else{
    // Open only an existing archive; changing this option must not create a database.
    const file=path.join(data,'court.sqlite');await access(file);
    const db=new DatabaseSync(file);
    try{
      db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE;');
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('sync_enabled',JSON.stringify(enabled));
      db.prepare('INSERT INTO audit_events(user_id,action,details,created_at) VALUES(NULL,?,?,?)').run('sync-local',JSON.stringify({sync_enabled:enabled}),new Date().toISOString());
      db.exec('COMMIT;');
    }finally{db.close();}
  }
  return {sync_enabled:enabled};
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
