import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, realpath, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { exportStatic, siteInventory, withSiteLock, STATIC_SOURCES, SOURCE_ROOT } from './static-export.mjs';
import { verifyPagesDeployment } from './pages-deployment.mjs';

function git(directory, args, accepted = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: directory, windowsHide: true, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const timeout = setTimeout(() => child.kill(), 120000);
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('close', code => { clearTimeout(timeout); accepted.includes(code) ? resolve({ code, output: output.trim() }) : reject(new Error(`Git 操作失败（${code}）：请检查本机 Git 凭据、独立仓库与分支状态`)); });
  });
}
function validateRemote(remote, branch) {
  let valid = /^git@(github\.com|gitlab\.com):[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote);
  try { const url = new URL(remote); valid ||= url.protocol === 'https:' && ['github.com', 'gitlab.com'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(url.pathname); } catch {}
  if (!valid) throw new Error('发布远程仓库必须是 GitHub / GitLab 的 HTTPS 或 SSH 地址，且不能包含凭据');
  if (!/^[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) throw new Error('无效的发布分支');
}
export async function pushStatic(directory, { remote, branch = 'main', gitRunner = git }) {
  validateRemote(remote, branch);
  await siteInventory(directory);
  return withSiteLock(directory, () => commitAndPush(directory, { remote, branch, gitRunner }));
}
async function commitAndPush(directory, { remote, branch, gitRunner }) {
  const inventory = await siteInventory(directory);
  if (await realpath(inventory.root) !== inventory.root) throw new Error('发布目录不能通过符号链接指向其他目录');
  let repositoryRoot;
  try { repositoryRoot = (await gitRunner(inventory.root, ['rev-parse', '--show-toplevel'])).output; } catch {}
  if (!repositoryRoot || path.resolve(repositoryRoot) !== inventory.root) {
    // Always create a separate repository, never stage the private source checkout.
    await gitRunner(inventory.root, ['init', '-b', branch]);
  }
  const existing = await gitRunner(inventory.root, ['remote', 'get-url', 'origin'], [0, 2, 128]);
  if (existing.code === 0 && existing.output !== remote) throw new Error('发布目录已关联其他远程仓库，未更改');
  if (existing.code !== 0) await gitRunner(inventory.root, ['remote', 'add', 'origin', remote]);
  const pushUrl = await gitRunner(inventory.root, ['remote', 'get-url', '--push', 'origin']);
  if (pushUrl.output && pushUrl.output !== remote) throw new Error('发布仓库的推送地址与指定地址不一致，未提交');
  const staged = await gitRunner(inventory.root, ['diff', '--cached', '--name-only']);
  if (staged.output) throw new Error('发布仓库已有暂存修改，请先处理后再自动发布');
  const tracked = (await gitRunner(inventory.root, ['ls-files', '-z'])).output.split('\0').filter(Boolean);
  const managed = new Set(inventory.files);
  if (tracked.some(file => !managed.has(file) && !/^(?:assets\/[a-f0-9]{64}\/[a-zA-Z0-9._-]+|matches\/[1-9]\d*-[a-f0-9]{64}\.json|data\/[a-f0-9]{64}\.(?:json|sqlite(?:\.gz)?))$/.test(file))) throw new Error('发布仓库含有不受管文件，拒绝自动提交');
  for (let i = 0; i < inventory.files.length; i += 100) await gitRunner(inventory.root, ['add', '--', ...inventory.files.slice(i, i + 100)]);
  const removed = tracked.filter(file => !managed.has(file));
  for (let i = 0; i < removed.length; i += 100) await gitRunner(inventory.root, ['add', '-u', '--', ...removed.slice(i, i + 100)]);
  const diff = await gitRunner(inventory.root, ['diff', '--cached', '--quiet'], [0, 1]);
  if (diff.code === 1) await gitRunner(inventory.root, ['-c', 'user.name=BrokenArrowCourt', '-c', 'user.email=broken-arrow-court@users.noreply.github.com', 'commit', '-m', `Update court snapshot ${inventory.marker.revision.slice(0, 12)}`]);
  await gitRunner(inventory.root, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const commit = (await gitRunner(inventory.root, ['rev-parse','HEAD'])).output;
  return { pushed: true, revision: inventory.marker.revision, commit };
}
export class Publication {
  constructor(store, { directory, remote = '', branch = 'main', intervalMinutes = 120, enabled = true, isSyncActive = () => false, push = pushStatic, verifyDeployment = verifyPagesDeployment } = {}) {
    this.store = store; this.directory = directory; this.remote = remote; this.branch = branch; this.enabled = enabled;
    this.isSyncActive = isSyncActive; this.push = push; this.verifyDeployment = verifyDeployment;
    this.interval = (Number.isFinite(intervalMinutes) ? Math.max(5, intervalMinutes) : 120) * 60000; this.stateFile = path.join(store.directory, 'publication.json');
  }
  async status() {
    let state = {}; try { state = JSON.parse(await readFile(this.stateFile, 'utf8')); } catch {}
    const verified = state.deployed_revision && state.deployed_revision === state.revision;
    return { configured: Boolean(this.remote), active: Boolean(this.active), queued: Boolean(this.manualPending || this.changePending), phase:this.operation?.phase ?? state.deployment_status, status: state.last_error && !this.active ? 'failed' : this.operation?.status ?? (verified?'complete':state.last_push?(state.pushed_revision===state.revision?'uploaded':'pending'):'idle'), last_push: state.last_push ?? null, deployed_at:state.deployed_at??null, finished_at: this.operation?.finished_at ?? null, last_error: this.operation?.error ?? state.last_error ?? null };
  }
  async tick({ forcePush = false, dataChanged = false } = {}) {
    if (forcePush && !this.manualRunning) this.manualPending = true;
    if (dataChanged && this.enabled) this.changePending = true;
    if ((!this.enabled && !this.manualPending) || this.stopped || this.active || this.isSyncActive()) return;
    const manual = Boolean(this.manualPending); this.manualPending = false; this.changePending = false; this.manualRunning = manual;
    this.operation = { status: 'running' };
    this.active = this.run({ forcePush: manual }).then(result => {
      this.operation = { status: result?.publication_status ?? 'complete', finished_at: new Date().toISOString() };
    }).catch(e => {
      this.operation = { status: 'failed', error: e.message, finished_at: new Date().toISOString() };
      try { this.store.event(null, 'warning', `只读发布：${e.message}`); } catch { /* Status remains visible even if logging is locked. */ }
    }).finally(() => {
      this.active = null; this.manualRunning = false;
      if ((this.manualPending || this.changePending) && !this.stopped) this.tick();
    });
    await this.active;
  }
  async run({ forcePush = false } = {}) {
    if (!forcePush && this.isSyncActive()) return { deferred: true, reason: 'sync-active' };
    let state = {}; try { state = JSON.parse(await readFile(this.stateFile, 'utf8')); } catch {}
    // Capture before export: a round finishing during export must be checked again.
    const syncId = this.store.get('SELECT MAX(id) id FROM sync_runs WHERE finished_at IS NOT NULL')?.id ?? 0;
    const syncFinished = syncId > (Number(state.published_sync_id) || 0);
    const files = [];
    for (const file of [...Object.values(STATIC_SOURCES), 'readonly/index.html', 'src/static-export.mjs', 'src/publication.mjs']) { const info = await stat(path.join(SOURCE_ROOT, file)); files.push([file, info.mtimeMs, info.size]); }
    try{
      const icons=path.join(SOURCE_ROOT,'public','unit-icons');
      for(const name of (await readdir(icons)).filter(n=>/^[A-Za-z0-9_-]{1,160}\.png$/.test(n)).sort()){
        const info=await stat(path.join(icons,name));files.push(['public/unit-icons/'+name,info.mtimeMs,info.size]);
      }
    }catch(e){if(e.code!=='ENOENT')throw e;}
    const dataFingerprint = createHash('sha256').update(JSON.stringify([
      this.store.all('SELECT id,name,active FROM members ORDER BY id'),
      this.store.all('SELECT id,member_id,player_id,name,active FROM accounts ORDER BY id'),
      this.store.all('SELECT id,updated_at,friend_count,same_team_count,detail_state FROM matches ORDER BY id'),
      this.store.all('SELECT key,updated_at FROM analysis_catalogue ORDER BY key'),
      this.store.all('SELECT match_id,player_id,spec1,spec2 FROM match_decks ORDER BY match_id,player_id'),
      this.store.get('SELECT COUNT(*) n,MAX(updated_at) updated FROM unit_catalogue'),
      { court_mode: this.store.settings().court_mode === true },
      { update_relay_url: process.env.UPDATE_RELAY_URL || '' },
      { update_ntfy_url: process.env.UPDATE_NTFY_URL || '', update_ntfy_topic: process.env.UPDATE_NTFY_TOPIC || '' },
    ])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([dataFingerprint, files])).digest('hex');
    let result;
    try {
      if (state.source_fingerprint === fingerprint && (await siteInventory(this.directory)).marker.revision === state.revision) result = { changed: false, revision: state.revision, directory: this.directory };
    } catch {}
    result ??= await exportStatic(this.store, { directory: this.directory });
    if (result.changed) this.store.event(null, 'info', `只读静态档案已更新：${result.matches} 局，版本 ${result.revision.slice(0, 12)}`);
    state = { ...state, source_fingerprint: fingerprint, data_fingerprint: dataFingerprint, revision: result.revision, exported_at: result.published_at ?? state.exported_at };
    // Compare with the last successful push, so failed or deferred data stays due across restarts.
    const due = syncFinished || state.pushed_data_fingerprint !== dataFingerprint || !state.last_push || Date.now() - Date.parse(state.last_push) >= this.interval;
    if (this.remote && state.pushed_revision !== result.revision && (forcePush || (due && (!state.next_retry || Date.parse(state.next_retry) <= Date.now())))) {
      let pushed;
      try { pushed = await this.push(result.directory, { remote: this.remote, branch: this.branch }); }
      catch (error) { await this.saveState({ ...state, last_error: error.message, next_retry: new Date(Date.now() + 15 * 60000).toISOString() }); throw error; }
      state = { ...state, last_push: new Date().toISOString(), pushed_revision: pushed.revision, pushed_commit:pushed.commit??null, deployment_status:'deploying', next_retry: null, last_error: null };
      this.store.event(null, 'info', `只读站点更新已提交远程仓库：${result.revision.slice(0, 12)}`);
    }
    if (state.pushed_revision === result.revision) { state.published_sync_id = syncId; state.pushed_data_fingerprint = dataFingerprint; }
    await this.saveState(state);
    if(this.remote && state.pushed_revision===result.revision && (forcePush||state.deployed_revision!==result.revision)) {
      if(!forcePush&&state.next_retry&&Date.parse(state.next_retry)>Date.now())return {...result,publication_status:'failed'};
      try {
        const deployment=await this.verifyDeployment({remote:this.remote,directory:this.directory,revision:result.revision,commit:state.pushed_commit,
          stopped:()=>this.stopped,onProgress:phase=>{if(this.operation)this.operation.phase=phase;}});
        if(deployment.status!=='complete') { await this.saveState({...state,deployment_status:'uploaded'});return {...result,publication_status:'uploaded'}; }
        state={...state,deployment_status:'complete',deployed_revision:result.revision,deployed_commit:deployment.commit??state.pushed_commit,deployed_at:deployment.verified_at??new Date().toISOString(),last_error:null,next_retry:null};
        await this.saveState(state);
      }catch(error){await this.saveState({...state,deployment_status:'failed',last_error:error.message,next_retry:new Date(Date.now()+15*60000).toISOString()});throw error;}
    }
    return this.remote && state.deployed_revision!==result.revision ? {...result,publication_status:'pending'} : result;
  }
  async saveState(state) {
    await writeFile(this.stateFile + '.tmp', JSON.stringify(state));
    await rename(this.stateFile + '.tmp', this.stateFile);
  }
  start() { this.timer = setInterval(() => this.tick(), 60000); this.timer.unref(); setTimeout(() => this.tick(), 1000).unref(); }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.active; }
}
