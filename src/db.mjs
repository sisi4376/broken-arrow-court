import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { normalizeMatch } from './domain.mjs';

export const now = () => new Date().toISOString();
export const digest = (text) => createHash('sha256').update(text).digest('hex');

export class Store {
  constructor(directory) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true });
    this.file = path.join(this.directory, 'court.sqlite');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 4) throw new Error('数据库版本高于程序支持的版本');
    if (version === 4) return;
    if (version === 3) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE analysis_catalogue(key TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE match_decks(match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,player_id TEXT NOT NULL,spec1 INTEGER NOT NULL,spec2 INTEGER NOT NULL,updated_by INTEGER REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(match_id,player_id));
        PRAGMA user_version=4; COMMIT;`);
      return;
    }
    if (version === 2) {
      this.db.exec(`BEGIN IMMEDIATE;
        UPDATE matches SET mode=CAST(COALESCE(json_extract(raw_json,'$.Type'),json_extract(raw_json,'$.GameType'),json_extract(raw_json,'$.MatchType'),json_extract(raw_json,'$.Mode'),json_extract(raw_json,'$.game_mode'),0) AS TEXT)
        WHERE mode IS NULL AND json_type(raw_json,'$.Data')='object'
          AND (json_type(raw_json,'$.EndTime') IS NOT NULL OR json_type(raw_json,'$.TotalPlayTimeInSec') IS NOT NULL);
        PRAGMA user_version=3; COMMIT;`);
      this.migrate();
      return;
    }
    if (version === 1) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE account_history_gaps(account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, match_id TEXT NOT NULL, first_seen TEXT NOT NULL, last_checked TEXT NOT NULL, PRIMARY KEY(account_id,match_id));
        PRAGMA user_version=2; COMMIT;`);
      this.migrate();
      return;
    }
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE members(id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE users(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL UNIQUE REFERENCES members(id), username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), created_at TEXT NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE invitations(id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, member_id INTEGER REFERENCES members(id), expires_at TEXT NOT NULL, used_at TEXT, created_by INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE accounts(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), player_id TEXT NOT NULL UNIQUE, steam_id TEXT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, backfill_offset INTEGER NOT NULL DEFAULT 0, backfill_total INTEGER, history_complete INTEGER NOT NULL DEFAULT 0, recent_target INTEGER NOT NULL DEFAULT 0, last_recent_sync TEXT, last_profile_sync TEXT, last_full_scan TEXT, last_error TEXT, next_retry TEXT, error_count INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX accounts_steam_id ON accounts(steam_id) WHERE steam_id IS NOT NULL AND steam_id != '';
      CREATE TABLE profiles(player_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE matches(id TEXT PRIMARY KEY, end_time INTEGER, duration REAL, map_id TEXT NOT NULL DEFAULT '', mode TEXT, winner_team INTEGER, victory_level INTEGER, friend_count INTEGER NOT NULL DEFAULT 0, same_team_count INTEGER NOT NULL DEFAULT 0, raw_json TEXT NOT NULL, content_hash TEXT NOT NULL, imported_at TEXT NOT NULL, updated_at TEXT NOT NULL, detail_json TEXT, detail_state TEXT NOT NULL DEFAULT 'summary', detail_error TEXT, detail_retry_at TEXT, detail_attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE participants(match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, player_id TEXT NOT NULL, name TEXT NOT NULL, team_id INTEGER, old_rating REAL, new_rating REAL, rating_delta REAL, destruction REAL, losses REAL, objectives INTEGER, won INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(match_id, player_id));
      CREATE INDEX participants_player ON participants(player_id, match_id);
      CREATE TABLE unit_instances(match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, player_id TEXT NOT NULL, net_id TEXT NOT NULL, unit_id TEXT NOT NULL, spawn_time INTEGER, death_time INTEGER, refunded INTEGER NOT NULL DEFAULT 0, kills INTEGER, damage REAL, damage_received REAL, supply REAL, raw_json TEXT NOT NULL, PRIMARY KEY(match_id,player_id,net_id));
      CREATE INDEX unit_instances_unit ON unit_instances(unit_id,match_id);
      CREATE TABLE unit_catalogue(unit_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX matches_date ON matches(end_time DESC);
      CREATE INDEX matches_qualified ON matches(friend_count, end_time DESC);
      CREATE TABLE account_matches(account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, discovered_at TEXT NOT NULL, PRIMARY KEY(account_id, match_id));
      CREATE TABLE source_snapshots(id INTEGER PRIMARY KEY, source_key TEXT NOT NULL, content_hash TEXT NOT NULL, payload_gzip BLOB NOT NULL, fetched_at TEXT NOT NULL, UNIQUE(source_key, content_hash));
      CREATE INDEX snapshots_key ON source_snapshots(source_key, fetched_at DESC);
      CREATE TABLE sync_runs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, finished_at TEXT, requests INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, message TEXT);
      CREATE TABLE sync_events(id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES sync_runs(id), level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE audit_events(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE VIEW registered_participants AS SELECT p.*, a.id AS account_id, a.member_id, m.name AS member_name FROM participants p JOIN accounts a ON a.player_id=p.player_id JOIN members m ON m.id=a.member_id WHERE a.active=1 AND m.active=1 AND (p.team_id IS NULL OR p.team_id!=100);
      INSERT INTO settings VALUES ('sync_enabled','true'),('sync_minutes','15'),('request_delay_ms','1800'),('backup_days','14');
      PRAGMA user_version=1; COMMIT;`);
    this.migrate();
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    const depth = this.transactionDepth ?? 0;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = depth + 1;
    try { const result = fn(); this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch (error) { this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
    finally { this.transactionDepth = depth; }
  }
  settings() { return Object.fromEntries(this.all('SELECT key,value FROM settings').map((x) => [x.key, JSON.parse(x.value)])); }
  setting(key, value) { this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  audit(user, action, details) { this.run('INSERT INTO audit_events(user_id,action,details,created_at) VALUES(?,?,?,?)', user, action, JSON.stringify(details), now()); }
  event(run, level, message) { this.run('INSERT INTO sync_events(run_id,level,message,created_at) VALUES(?,?,?,?)', run, level, message, now()); }
  snapshot(key, payload) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.run('INSERT OR IGNORE INTO source_snapshots(source_key,content_hash,payload_gzip,fetched_at) VALUES(?,?,?,?)', key, digest(text), gzipSync(text), now());
  }
  readSnapshot(id) {
    const row = this.get('SELECT * FROM source_snapshots WHERE id=?', id);
    return row ? { ...row, payload: gunzipSync(row.payload_gzip).toString('utf8'), payload_gzip: undefined } : null;
  }
  saveProfile(playerId, data, metadata = {}) {
    this.run('INSERT INTO profiles(player_id,data_json,metadata_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET data_json=excluded.data_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at', String(playerId), JSON.stringify(data), JSON.stringify(metadata), now());
    const info = data.info ?? {};
    this.run('UPDATE accounts SET name=?,steam_id=COALESCE(?,steam_id),last_profile_sync=? WHERE player_id=?', info.name ?? `#${playerId}`, info.steamId ?? info.steam_id ?? null, now(), String(playerId));
  }
  ingest(id, raw, accountId = null) {
    const match = normalizeMatch(id, raw);
    const json = JSON.stringify(raw);
    const hash = digest(json);
    const old = this.get('SELECT content_hash,detail_json FROM matches WHERE id=?', match.id);
    const changed = old?.content_hash !== hash;
    this.transaction(() => {
      if (changed) {
        this.snapshot(`match:${id}`, raw);
        this.run(`INSERT INTO matches(id,end_time,duration,map_id,mode,winner_team,victory_level,raw_json,content_hash,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET end_time=excluded.end_time,duration=excluded.duration,map_id=excluded.map_id,mode=excluded.mode,winner_team=excluded.winner_team,victory_level=excluded.victory_level,raw_json=excluded.raw_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
        match.id, match.endTime, match.duration, match.mapId, match.mode === null ? null : String(match.mode), match.winnerTeam, match.victoryLevel, json, hash, now(), now());
        this.run('DELETE FROM participants WHERE match_id=?', match.id);
        const rich = old?.detail_json ? JSON.parse(old.detail_json).data?.Data ?? {} : {};
        for (const p of match.participants) this.run('INSERT INTO participants(match_id,player_id,name,team_id,old_rating,new_rating,rating_delta,destruction,losses,objectives,won,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', match.id,p.playerId,p.name,p.teamId,p.oldRating,p.newRating,p.ratingDelta,p.destruction,p.losses,p.objectives,p.won,JSON.stringify({ ...rich[p.playerId], ...p.raw }));
        this.reclassify(match.id);
      }
      if (accountId !== null) this.run('INSERT OR IGNORE INTO account_matches(account_id,match_id,discovered_at) VALUES(?,?,?)', accountId, match.id, now());
      // A later import or another friend's archive can recover a previously missing match.
      this.run(`INSERT OR IGNORE INTO account_matches(account_id,match_id,discovered_at)
        SELECT g.account_id,g.match_id,? FROM account_history_gaps g JOIN accounts a ON a.id=g.account_id
        WHERE g.match_id=? AND EXISTS(SELECT 1 FROM participants p WHERE p.match_id=g.match_id AND p.player_id=a.player_id)`, now(), match.id);
      this.run('DELETE FROM account_history_gaps WHERE match_id=? AND EXISTS(SELECT 1 FROM account_matches am WHERE am.account_id=account_history_gaps.account_id AND am.match_id=account_history_gaps.match_id)', match.id);
    });
    return { added: !old, changed: !!old && changed };
  }
  saveDetail(id, detail) {
    normalizeMatch(id, detail.data);
    this.transaction(() => {
      this.snapshot(`match-detail:${id}`, detail);
      this.run("UPDATE matches SET detail_json=?,detail_state='complete',detail_error=NULL,detail_retry_at=NULL,updated_at=? WHERE id=?", JSON.stringify(detail), now(), String(id));
      this.run('DELETE FROM unit_instances WHERE match_id=?', String(id));
      for (const [playerId, player] of Object.entries(detail.data.Data)) {
        this.run('UPDATE participants SET raw_json=? WHERE match_id=? AND player_id=?', JSON.stringify(player), String(id), String(player.Id ?? playerId));
        for (const [netId, unit] of Object.entries(player.UnitData ?? {})) {
          this.run('INSERT INTO unit_instances(match_id,player_id,net_id,unit_id,spawn_time,death_time,refunded,kills,damage,damage_received,supply,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', String(id), String(player.Id ?? playerId), String(netId), String(unit.Id ?? ''), unit.SpawnTime ?? null, unit.DeathTime ?? null, Number(!!unit.WasRefunded), unit.KilledCount ?? 0, unit.TotalDamageDealt ?? 0, unit.TotalDamageReceived ?? 0, unit.TotalSupplyPointsConsumed ?? 0, JSON.stringify(unit));
        }
      }
    });
  }
  reclassify(id = null) {
    this.run(`UPDATE matches SET friend_count=(SELECT COUNT(DISTINCT member_id) FROM registered_participants r WHERE r.match_id=matches.id), same_team_count=COALESCE((SELECT MAX(c) FROM (SELECT COUNT(DISTINCT member_id) AS c FROM registered_participants r WHERE r.match_id=matches.id AND r.team_id IS NOT NULL GROUP BY team_id)),0)${id ? ' WHERE id=?' : ''}`, ...(id ? [id] : []));
  }
  exportData() {
    return {
      format: 'broken-arrow-court-v1', exported_at: now(),
      members: this.all('SELECT * FROM members'), accounts: this.all('SELECT * FROM accounts'),
      profiles: this.all('SELECT * FROM profiles').map((p) => ({ player_id: p.player_id, data: JSON.parse(p.data_json), metadata: JSON.parse(p.metadata_json) })),
      matches: this.all('SELECT id,raw_json,detail_json FROM matches ORDER BY end_time').map((m) => ({ id: m.id, raw: JSON.parse(m.raw_json), detail: m.detail_json ? JSON.parse(m.detail_json) : null })),
    };
  }
  async backup() {
    const dir = path.join(this.directory, 'backups');
    mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, `court-${now().replace(/[:.]/g, '-')}.sqlite`);
    await backup(this.db, filename);
    const cutoff = Date.now() - Number(this.settings().backup_days) * 86400000;
    for (const name of readdirSync(dir)) {
      if (/^court-[\dTZ-]+\.sqlite$/.test(name) && statSync(path.join(dir, name)).mtimeMs < cutoff) unlinkSync(path.join(dir, name));
    }
    this.setting('last_backup', now());
    return filename;
  }
  close() { this.db.close(); }
}
