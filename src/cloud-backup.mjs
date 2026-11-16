import { backup, DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, rename, unlink, rm, mkdtemp, open, stat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';

const TAG = /^court-auto-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const NOTES = '自动一致性数据库备份。含密码哈希和会话，必须保持私有。恢复前请核对 manifest.json 中的 SHA-256，解压到全新空数据目录，不要混用 WAL/SHM。';
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function github(args, { proxy = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { windowsHide: true, shell: false, env: {
      ...process.env, GH_PROMPT_DISABLED: '1',
      ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
    } });
    let output = '', diagnostic = '';
    child.stdout.on('data', b => { output += b; });
    // Never forward credential helpers, remote diagnostics or private response bodies to public logs.
    child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-4096); });
    const timer = setTimeout(() => child.kill(), 15 * 60000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 GitHub CLI，请检查安装和登录状态')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else {
        const stage = args[0] === 'release' ? 'release/' + args[1] : args[0];
        const status = diagnostic.match(/HTTP \d{3}/)?.[0] || (diagnostic.includes('unknown flag') ? 'CLI 版本不兼容' : '网络或登录错误');
        reject(new Error(`GitHub 私有备份失败（${stage}，${status}），请检查网络、仓库和 GitHub CLI`));
      }
    });
  });
}

export class CloudBackup {
  constructor(store, { repository = '', intervalHours = 24, retention = 14, proxy = '', runner = github } = {}) {
    if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('私有备份仓库应填写 owner/repo');
    if (proxy) { const url = new URL(proxy); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的备份代理地址'); }
    this.store = store; this.repository = repository; this.proxy = proxy; this.runner = runner;
    this.interval = (Number.isFinite(Number(intervalHours)) ? Math.max(1, Math.min(720, Number(intervalHours) || 24)) : 24) * 3600000;
    this.retention = Math.max(2, Math.min(90, Math.floor(Number(retention) || 14)));
    this.stateFile = path.join(store.directory, 'cloud-backup.json');
  }
  async state() { try { return JSON.parse(await readFile(this.stateFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  async save(value) {
    const temporary = this.stateFile + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(value)); await rename(temporary, this.stateFile);
  }
  async status() {
    const s = await this.state();
    return { enabled: !!this.repository, repository: this.repository || null, active: !!this.active,
      last_success: s.last_success ?? null, snapshot_at: s.snapshot_at ?? null, last_attempt: s.last_attempt ?? null, next_retry: s.next_retry ?? null,
      last_error: s.last_error ?? null, url: s.url ?? null, bytes: s.bytes ?? null, retention: this.retention,
      interval_hours: this.interval / 3600000 };
  }
  async tick({ force = false } = {}) {
    if (!this.repository || this.stopped) return;
    if (this.active) return this.active;
    this.active = this.run(force).finally(() => { this.active = null; });
    return this.active;
  }
  async recover(tag) {
    if (!this.repository || !TAG.test(tag)) throw new Error('无效的自动备份版本');
    const gh = args => this.runner(args, { proxy: this.proxy });
    if (JSON.parse(await gh(['api', `repos/${this.repository}`])).private !== true) throw new Error('备份仓库必须保持私有');
    const text = await gh(['release', 'download', tag, '--repo', this.repository, '--pattern', 'manifest.json', '--output', '-']);
    const manifest = JSON.parse(text);
    if (manifest.format !== 'broken-arrow-court-private-backup-v1' || manifest.database?.file !== 'court.sqlite.gz' || !/^[a-f0-9]{64}$/.test(manifest.database.sha256) || !/^[a-f0-9]{64}$/.test(manifest.database.compressed_sha256)) throw new Error('无法识别的备份清单');
    const state = await this.state();
    await this.save({ ...state, pending: { repository: this.repository, tag, manifest, manifest_size: Buffer.byteLength(text), manifest_sha256: createHash('sha256').update(text).digest('hex') } });
    return this.tick({ force: true });
  }
  verifyAssets(release, pending) {
    const m = pending.manifest;
    const expected = [
      { name: 'court.sqlite.gz', size: m.database.compressed_bytes, digest: m.database.compressed_sha256 },
      { name: 'manifest.json', size: pending.manifest_size, digest: pending.manifest_sha256 },
    ];
    return expected.every(e => release.assets.some(a => a.name === e.name && a.size === e.size && (!a.digest || a.digest === 'sha256:' + e.digest)));
  }
  async complete(pending, gh) {
    const m = pending.manifest, attempt = new Date().toISOString();
    if (JSON.parse(await gh(['api', `repos/${this.repository}`])).private !== true) throw new Error('仓库隐私状态发生变化，备份未完成');
    const repository = JSON.parse(await gh(['repo', 'view', this.repository, '--json', 'isEmpty']));
    if (repository.isEmpty === true) {
      const readme = '# 断剑蘸饭审判法庭 · 私有数据备份\n\n完整数据库自动保存在本仓库 Releases 附件，不提交到 Git 历史。请始终保持仓库 Private，不启用 Pages。\n\n每份备份包含 court.sqlite.gz 与 manifest.json，含密码哈希及会话，请勿公开。恢复前核对清单中压缩包及解压数据库的 SHA-256，再恢复到全新空数据目录，不混用旧 WAL/SHM。环境配置及 GitHub 登录需要另行设置。\n\n本地后台运行时默认每 24 小时备份，成功后保留最近 14 份自动备份；失败 30 分钟后重试。\n';
      await gh(['api', '--method', 'PUT', `repos/${this.repository}/contents/README.md`, '-f', 'message=Initialize private backup repository', '-f', 'content=' + Buffer.from(readme).toString('base64')]);
    }
    await gh(['release', 'edit', pending.tag, '--repo', this.repository, '--draft=false', '--latest=false']);
    const success = { repository: this.repository, last_attempt: attempt, last_success: attempt,
      sha256: m.database.sha256, bytes: m.database.compressed_bytes, tag: pending.tag,
      snapshot_at: m.created_at, url: `https://github.com/${this.repository}/releases/tag/${pending.tag}`, last_error: null, next_retry: null };
    await this.save(success);
    this.store.event(null, 'info', `私有云备份完成：${m.counts.matches} 局，${(success.bytes / 1048576).toFixed(1)} MB`);
    try {
      const releases = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${this.repository}/releases?per_page=100`]));
      const own = releases.flat().filter(r => TAG.test(r.tag_name) && !r.draft && r.body === NOTES).sort((a, b) => b.tag_name.localeCompare(a.tag_name));
      for (const old of own.slice(this.retention)) await gh(['release', 'delete', old.tag_name, '--repo', this.repository, '--yes', '--cleanup-tag']);
    } catch { this.store.event(null, 'warning', '私有云备份已完成，但旧自动备份清理失败，下次重试'); }
    return success;
  }
  async run(force) {
    let state = await this.state(); const at = Date.now();
    if (!force && (state.last_success && at - Date.parse(state.last_success) < this.interval || state.next_retry && Date.parse(state.next_retry) > at)) return;
    const lockFile = path.join(this.store.directory, 'cloud-backup.lock');
    let lock;
    try { lock = await open(lockFile, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try { process.kill(JSON.parse(await readFile(lockFile, 'utf8')).pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) return;
      await unlink(lockFile); lock = await open(lockFile, 'wx');
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
    let directory;
    const gh = args => this.runner(args, { proxy: this.proxy });
    const attempt = new Date().toISOString();
    try {
      await this.save({ ...state, last_attempt: attempt });
      const repo = JSON.parse(await gh(['api', `repos/${this.repository}`]));
      if (repo.private !== true || repo.full_name?.toLowerCase() !== this.repository.toLowerCase()) throw new Error('备份目标不是已确认的私有仓库，已拒绝上传');
      if (state.pending?.repository === this.repository && TAG.test(state.pending.tag)) {
        const release = JSON.parse(await gh(['release', 'view', state.pending.tag, '--repo', this.repository, '--json', 'assets,url,isDraft']));
        if (this.verifyAssets(release, state.pending)) return await this.complete(state.pending, gh);
      }
      directory = await mkdtemp(path.join(this.store.directory, 'cloud-backup-'));
      const file = path.join(directory, 'court.sqlite');
      await backup(this.store.db, file);
      const db = new DatabaseSync(file, { readOnly: true });
      let counts, version;
      try {
        const integrity = db.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库完整性校验失败，未上传备份');
        counts = Object.fromEntries(['users', 'members', 'accounts', 'profiles', 'matches', 'participants', 'unit_instances', 'source_snapshots'].map(table => [table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
        version = db.prepare('PRAGMA user_version').get().user_version;
      } finally { db.close(); }
      const compressed = file + '.gz';
      await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(compressed, { flags: 'wx' }));
      const digest = await sha256(file), compressedDigest = await sha256(compressed), bytes = (await stat(compressed)).size;
      if (bytes > 1900 * 1024 * 1024) throw new Error('备份文件超过单附件安全大小，未上传');
      if (!force && state.sha256 === digest && state.repository === this.repository) {
        await this.save({ ...state, last_attempt: attempt, last_success: attempt, last_error: null, next_retry: null }); return;
      }
      const manifest = { format: 'broken-arrow-court-private-backup-v1', created_at: attempt, schema_version: version,
        database: { file: 'court.sqlite.gz', encoding: 'gzip', bytes: (await stat(file)).size, sha256: digest, compressed_bytes: bytes, compressed_sha256: compressedDigest },
        checks: { sqlite_integrity: 'ok', foreign_keys: 'ok' }, counts,
        excluded: ['.env', 'GitHub credentials', 'runtime files', 'source checkout', 'public website checkout'] };
      const manifestFile = path.join(directory, 'manifest.json');
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
      const tag = 'court-auto-' + attempt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomUUID().slice(0, 8);
      if (JSON.parse(await gh(['api', `repos/${this.repository}`])).private !== true) throw new Error('备份仓库必须保持私有，已拒绝上传');
      await gh(['release', 'create', tag, '--repo', this.repository, '--draft', '--title', `法庭数据备份 ${attempt.slice(0, 10)}`, '--notes', NOTES]);
      const pending = { repository: this.repository, tag, manifest, manifest_size: (await stat(manifestFile)).size, manifest_sha256: await sha256(manifestFile) };
      state = { ...state, pending }; await this.save({ ...state, last_attempt: attempt });
      try { await gh(['release', 'upload', tag, compressed, manifestFile, '--repo', this.repository]); } catch { /* A timed-out upload can already be complete; inspect its actual remote state. */ }
      const release = JSON.parse(await gh(['release', 'view', tag, '--repo', this.repository, '--json', 'assets,url,isDraft']));
      if (!release.isDraft || !this.verifyAssets(release, pending)) throw new Error('远程备份附件核验失败，保留草稿以便排查');
      return await this.complete(pending, gh);
    } catch (error) {
      await this.save({ ...state, last_attempt: attempt, last_error: error.message, next_retry: new Date(Date.now() + 30 * 60000).toISOString() });
      this.store.event(null, 'warning', `私有云备份：${error.message}；30 分钟后重试`);
      throw error;
    } finally {
      if (directory) {
        const parent = await realpath(this.store.directory), target = await realpath(directory);
        if (path.dirname(target) !== parent || !path.basename(target).startsWith('cloud-backup-')) throw new Error('备份临时目录安全检查失败，未清理');
        await rm(target, { recursive: true, force: true });
      }
      await unlink(lockFile).catch(() => {});
    }
  }
  start() {
    const tick = () => { this.tick().catch(() => {}); };
    this.timer = setInterval(tick, 60000); this.timer.unref(); this.initial = setTimeout(tick, 10000); this.initial.unref();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.initial); await this.active?.catch(() => {}); }
}
