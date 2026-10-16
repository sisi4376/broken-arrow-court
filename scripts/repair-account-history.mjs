import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { Store, now } from '../src/db.mjs';
import { SourceClient } from '../src/source.mjs';
import { SyncEngine } from '../src/sync.mjs';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const ids = process.argv.slice(2);
if (!ids.length || !ids.every(id => /^[1-9]\d{0,19}$/.test(id))) throw new Error('Usage: node scripts/repair-account-history.mjs PLAYER_ID ... (stop the service first)');
const directory = path.resolve(process.env.DATA_DIR || 'data');
// Do not compete with the scheduler or migrate a live service's database.
try {
  const lock = JSON.parse(await readFile(path.join(directory, 'service.lock'), 'utf8'));
  try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') throw new Error('服务锁尚未清理，请先正常停止服务'); throw error; }
  throw new Error('请先停止后台服务再修复历史');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const lockPath = path.join(directory, 'service.lock');
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, operation: 'history-repair' }), { flag: 'wx' });
process.on('exit', () => {
  try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath); } catch {}
});

await mkdir(path.join(directory, 'backups'), { recursive: true });
const original = new DatabaseSync(path.join(directory, 'court.sqlite'), { readOnly: true });
const backupFile = path.join(directory, 'backups', `before-history-repair-${now().replace(/[:.]/g, '-')}.sqlite`);
try { await backup(original, backupFile); } finally { original.close(); }
console.log(JSON.stringify({ backup: backupFile }));

const store = new Store(directory);
const source = new SourceClient(store);
const engine = new SyncEngine(store, source);
const previousSync = store.settings().sync_enabled;
let runId;
const counts = { requests: 0, imported: 0, changed: 0, errors: 0 };
try {
  const accounts = ids.map(id => {
    const account = store.get('SELECT * FROM accounts WHERE player_id=?', id);
    if (!account) throw new Error(`未登记的账号 ${id}`);
    return account;
  });
  store.setting('sync_enabled', true);
  runId = Number(store.run("INSERT INTO sync_runs(kind,started_at) VALUES('full',?)", now()).lastInsertRowid);
  const log = (level, message) => { store.event(runId, level, message); console.log(JSON.stringify({ level, message })); };
  source.onRequest = () => { counts.requests++; };
  engine.current = { phase: 'backfill', ...counts };
  for (const account of accounts) {
    log('info', `${account.name}：开始核对已保存响应并重新扫描历史索引`);
    try {
      // Earlier failed imports can have useful bodies in saved source responses.
      const snapshots = store.all("SELECT payload_gzip FROM source_snapshots WHERE source_key LIKE ? ORDER BY id", `/api/players/matches?stbid=${account.player_id}&%`);
      for (const snapshot of snapshots) {
        const payload = JSON.parse(gunzipSync(snapshot.payload_gzip).toString('utf8'));
        for (const item of payload.matches ?? []) {
          if (!store.get('SELECT 1 FROM matches WHERE id=?', String(item.matchId))) engine.ingest(item.matchId, item.data, account.id, counts, log);
        }
      }
      const profile = await source.profile(account.player_id);
      if (String(profile.playerData.info.id) !== account.player_id) throw new Error('玩家 ID 不匹配');
      store.saveProfile(account.player_id, profile.playerData, profile.metadata);
      for (const [id, raw] of Object.entries(profile.matchMap)) {
        if (!store.get('SELECT 1 FROM matches WHERE id=?', id)) engine.ingest(id, raw, account.id, counts, log);
      }
      store.run('UPDATE accounts SET history_complete=0,backfill_offset=0 WHERE id=?', account.id);
      await engine.recent(store.get('SELECT * FROM accounts WHERE id=?', account.id), counts, log);
      await engine.backfill(store.get('SELECT * FROM accounts WHERE id=?', account.id), counts, log);
      if (!store.get('SELECT history_complete FROM accounts WHERE id=?', account.id).history_complete) throw new Error('扫描尚未完成，保留进度');
      store.run('UPDATE accounts SET last_error=NULL,error_count=0,next_retry=NULL WHERE id=?', account.id);
      console.log(JSON.stringify({ result: store.get('SELECT a.name,a.history_complete,a.last_error,(SELECT COUNT(*) FROM account_matches am WHERE am.account_id=a.id) AS archived,(SELECT COUNT(*) FROM account_history_gaps g WHERE g.account_id=a.id) AS missing FROM accounts a WHERE a.id=?', account.id) }));
    } catch (error) {
      counts.errors++;
      store.run('UPDATE accounts SET last_error=?,error_count=error_count+1,next_retry=? WHERE id=?', error.message, new Date(Date.now()+300000).toISOString(), account.id);
      log('error', `${account.name}：${error.message}`);
      if ([403,429].includes(error.status)) break;
    }
  }
  store.reclassify();
  const message = `定向历史修复：新增 ${counts.imported} 局，${counts.errors} 项错误；缺失 ID 保留待复查`;
  store.run('UPDATE sync_runs SET status=?,finished_at=?,requests=?,imported=?,changed=?,errors=?,message=? WHERE id=?', counts.errors?'partial':'complete', now(), counts.requests, counts.imported, counts.changed, counts.errors, message, runId);
  log('info', message);
  if (counts.errors) process.exitCode = 1;
} finally {
  store.setting('sync_enabled', previousSync);
  store.close();
}
