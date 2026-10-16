import { now } from './db.mjs';

export class SyncEngine {
  constructor(store, source) {
    this.store = store;
    this.source = source;
    this.active = null;
    this.pending = null;
    this.stopped = false;
    this.current = null;
    store.run("UPDATE sync_runs SET status='interrupted',finished_at=?,message='服务重启，下次从已保存进度继续' WHERE status='running'", now());
  }
  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.store.event(null, 'error', e.message)), 15000);
    this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 1500).unref();
  }
  async tick() {
    if (this.active || this.stopped) return;
    const s = this.store.settings();
    if (!this.backingUp && this.store.get('SELECT id FROM users LIMIT 1') && (!s.last_backup || Date.now() - Date.parse(s.last_backup) >= 86400000)) {
      this.backingUp = this.store.backup().catch((e) => this.store.event(null, 'error', `自动备份失败：${e.message}`)).finally(() => { this.backingUp = null; });
      await this.backingUp;
    }
    if (!s.sync_enabled || !this.store.get('SELECT id FROM accounts WHERE active=1 LIMIT 1')) return;
    const last = Date.parse(s.last_sync_started ?? '') || 0;
    if (Date.now() - last >= Number(s.sync_minutes) * 60000) this.request('incremental');
  }
  request(kind = 'incremental') {
    if (this.stopped) return { started: false, message: '同步服务已停止' };
    if (this.active) { this.pending = this.pending === 'full' || kind === 'full' ? 'full' : 'incremental'; return { started: false, queued: true }; }
    this.active = this.run(kind).catch((error) => this.store.event(null, 'error', error.message)).finally(() => {
      this.active = null; this.current = null;
      if (this.pending && !this.stopped && this.store.settings().sync_enabled) { const next = this.pending; this.pending = null; this.request(next); }
    });
    return { started: true };
  }
  allowed() { return !this.stopped && this.store.settings().sync_enabled; }
  async run(kind = 'incremental') {
    const runId = Number(this.store.run('INSERT INTO sync_runs(kind,started_at) VALUES(?,?)', kind, now()).lastInsertRowid);
    this.store.setting('last_sync_started', now());
    const counts = { requests: 0, imported: 0, changed: 0, errors: 0 };
    this.current = { id: runId, kind, phase: 'accounts', account: null, ...counts };
    this.source.onRequest = () => { counts.requests++; if (this.current) Object.assign(this.current, counts); };
    const log = (level, message) => this.store.event(runId, level, message);
    log('info', kind === 'full' ? '开始全量回溯，已有档案保留' : '开始增量同步');
    let status = 'complete';
    try {
      const accounts = this.store.all('SELECT a.* FROM accounts a JOIN members m ON m.id=a.member_id WHERE a.active=1 AND m.active=1 ORDER BY a.last_recent_sync ASC,a.id');
      for (const original of accounts) {
        if (!this.allowed()) break;
        const account = this.store.get('SELECT * FROM accounts WHERE id=?', original.id);
        if (kind !== 'full' && account.next_retry && Date.parse(account.next_retry) > Date.now()) continue;
        this.current.account = account.name;
        try {
          if (!account.last_profile_sync || Date.now() - Date.parse(account.last_profile_sync) > 6 * 3600000 || kind === 'full') {
            try {
              const profile = await this.source.profile(account.player_id);
              if (String(profile.playerData.info.id) !== account.player_id) throw new Error('返回的玩家 ID 与登记账号不一致');
              this.store.saveProfile(account.player_id, profile.playerData, profile.metadata);
              for (const [id, data] of Object.entries(profile.matchMap)) this.ingest(id, data, account.id, counts, log);
              log('info', `${account.name}：已保存生涯统计与公开档案`);
            } catch (error) { counts.errors++; log('warning', `${account.name} 档案：${error.message}`); if (error.status === 429 || error.status === 403) throw error; }
          }
          if (!this.allowed()) break;
          await this.recent(account, counts, log);
          if (!this.allowed()) break;
          const updated = this.store.get('SELECT * FROM accounts WHERE id=?', account.id);
          const rescan = kind === 'full' || !updated.last_full_scan || Date.now() - Date.parse(updated.last_full_scan) > 7 * 86400000;
          if (rescan && updated.history_complete) this.store.run('UPDATE accounts SET backfill_offset=0,history_complete=0 WHERE id=?', account.id);
          await this.backfill(this.store.get('SELECT * FROM accounts WHERE id=?', account.id), counts, log);
          this.store.run('UPDATE accounts SET last_error=NULL,error_count=0,next_retry=NULL WHERE id=?', account.id);
        } catch (error) {
          counts.errors++;
          const failures = account.error_count + 1;
          const retry = Math.max(error.retryAfter ?? 0, Math.min(6 * 3600000, 60000 * (2 ** Math.min(failures, 8))));
          this.store.run('UPDATE accounts SET last_error=?,error_count=?,next_retry=? WHERE id=?', error.message, failures, new Date(Date.now() + retry).toISOString(), account.id);
          log('error', `${account.name}：${error.message}`);
          if (error.status === 429 || error.status === 403) break;
        }
      }
      this.store.reclassify();
      if (this.allowed() && Date.now() >= this.source.blockedUntil) await this.enrich(counts, log);
      if (!this.allowed()) status = 'paused';
      else if (counts.errors) status = 'partial';
      this.store.setting('last_sync_finished', now());
    } catch (error) { counts.errors++; status = 'failed'; log('error', error.message); }
    finally {
      this.source.onRequest = null;
      const message = `新增 ${counts.imported} 局，更新 ${counts.changed} 局，${counts.errors} 项错误`;
      this.store.run('UPDATE sync_runs SET status=?,finished_at=?,requests=?,imported=?,changed=?,errors=?,message=? WHERE id=?', status, now(), counts.requests, counts.imported, counts.changed, counts.errors, message, runId);
      log(status === 'failed' ? 'error' : 'info', message);
    }
  }
  ingest(id, data, accountId, counts, log) {
    try { const result = this.store.ingest(id, data, accountId); counts.imported += Number(result.added); counts.changed += Number(result.changed); }
    catch (error) { counts.errors++; log('error', `对局 ${id} 解析失败：${error.message}`); throw error; }
    if (this.current) Object.assign(this.current, counts);
  }
  async historyPage(account, offset, counts, log, context) {
    const data = await this.source.matches(account.player_id, offset);
    const span = Math.max(0, Math.min(10, data.totalCount - offset));
    let matches = data.matches;
    if (matches.length < span) {
      // totalCount counts historical IDs, including matches whose data has expired.
      // Verify the actual ID window and repeat the page before recording gaps.
      if (!context.ids) {
        if (!this.source.profile) throw new Error('历史回溯遇到空页或短页，无法核对历史索引，保留进度等待重试');
        const profile = await this.source.profile(account.player_id);
        if (String(profile.playerData.info.id) !== account.player_id) throw new Error('返回的玩家 ID 与登记账号不一致');
        const ids = profile.playerData.last_fights_data;
        if (!Array.isArray(ids) || ids.length !== data.totalCount || new Set(ids.map(String)).size !== ids.length || !ids.every(id => /^[1-9]\d{0,19}$/.test(String(id)))) throw new Error('历史索引与分页总数不一致，保留进度等待重试');
        context.ids = ids.map(String);
        this.store.saveProfile(account.player_id, profile.playerData, profile.metadata);
      }
      if (context.ids.length !== data.totalCount) throw new Error('历史分页在同步期间发生变化，保留进度等待重试');
      const expected = context.ids.slice(offset, offset + span);
      const confirmed = await this.source.matches(account.player_id, offset);
      matches = [...new Map([...matches, ...confirmed.matches].map(m => [String(m.matchId), m])).values()];
      if (confirmed.totalCount !== data.totalCount || !matches.every(m => expected.includes(String(m.matchId)))) throw new Error('历史索引与分页位置不一致，保留进度等待重试');
      const returned = new Set(matches.map(m => String(m.matchId)));
      for (const id of expected) {
        if (returned.has(id)) continue;
        const local = this.store.get('SELECT m.raw_json FROM matches m JOIN participants p ON p.match_id=m.id WHERE m.id=? AND p.player_id=?', id, account.player_id);
        if (local) this.ingest(id, JSON.parse(local.raw_json), account.id, counts, log);
        else this.store.run('INSERT INTO account_history_gaps(account_id,match_id,first_seen,last_checked) VALUES(?,?,?,?) ON CONFLICT(account_id,match_id) DO UPDATE SET last_checked=excluded.last_checked', account.id, id, now(), now());
      }
    }
    const allKnown = matches.length > 0 && matches.every(m => this.store.get('SELECT 1 FROM account_matches WHERE account_id=? AND match_id=?', account.id, String(m.matchId)));
    for (const m of matches) this.ingest(m.matchId, m.data, account.id, counts, log);
    // Advance by the requested ID window, not the number of surviving match bodies.
    return { totalCount: data.totalCount, matches, next: offset + span, allKnown };
  }
  async recent(account, counts, log) {
    this.current.phase = 'recent';
    let offset = 0;
    const context = {};
    for (let page = 0; page < 200 && this.allowed(); page++) {
      const data = await this.historyPage(account, offset, counts, log, context);
      const allKnown = data.allKnown;
      this.store.run('UPDATE accounts SET backfill_total=?,recent_target=?,last_recent_sync=? WHERE id=?', data.totalCount, data.totalCount, now(), account.id);
      offset = data.next;
      if (account.history_complete) {
        const finished = allKnown || offset >= data.totalCount;
        this.store.run('UPDATE accounts SET history_complete=?,backfill_offset=? WHERE id=?', Number(finished), finished ? data.totalCount : offset, account.id);
      }
      if (!account.history_complete || allKnown || offset >= data.totalCount) break;
    }
    log('info', `${account.name}：近期列表已同步，上游当前列出 ${this.store.get('SELECT backfill_total FROM accounts WHERE id=?', account.id).backfill_total} 局`);
  }
  async backfill(account, counts, log) {
    if (account.history_complete) return;
    this.current.phase = 'backfill';
    // An overlap tolerates new matches being inserted at the head between resumptions.
    let offset = Math.max(0, account.backfill_offset - 10);
    const context = {};
    for (let page = 0; page < 200 && this.allowed(); page++) {
      const data = await this.historyPage(account, offset, counts, log, context);
      const next = data.next;
      const complete = next >= data.totalCount;
      this.store.run('UPDATE accounts SET backfill_offset=?,backfill_total=?,history_complete=?,last_full_scan=CASE WHEN ? THEN ? ELSE last_full_scan END WHERE id=?', next, data.totalCount, Number(complete), Number(complete), now(), account.id);
      if (complete) {
        const missing = this.store.get('SELECT COUNT(*) AS n FROM account_history_gaps WHERE account_id=?', account.id).n;
        log(missing ? 'warning' : 'info', missing ? `${account.name}：历史索引已扫描（${data.totalCount} 条），${missing} 条比赛数据上游暂未返回，已保留缺失 ID；后续定期复查` : `${account.name}：当前可查询历史已回溯完成（${data.totalCount} 局）`);
        break;
      }
      if (next <= offset) throw new Error('历史分页没有前进，保留已导入数据');
      offset = next;
    }
  }
  async enrich(counts, log) {
    this.current.phase = 'details'; this.current.account = null;
    const matches = this.store.all("SELECT id,detail_attempts FROM matches WHERE friend_count>=3 AND detail_state!='complete' AND (detail_retry_at IS NULL OR detail_retry_at<=?) ORDER BY end_time DESC LIMIT 250", now());
    for (const match of matches) {
      if (!this.allowed()) break;
      this.current.match = match.id;
      try {
        const detail = await this.source.detail(match.id);
        this.store.saveDetail(match.id, detail);
        log('info', `对局 ${match.id}：完整玩家与单位实例已归档`);
      } catch (error) {
        counts.errors++;
        const delay = Math.max(error.retryAfter ?? 0, Math.min(7 * 86400000, 3600000 * (2 ** Math.min(match.detail_attempts, 8))));
        this.store.run("UPDATE matches SET detail_state='error',detail_error=?,detail_attempts=detail_attempts+1,detail_retry_at=? WHERE id=?", error.message, new Date(Date.now() + delay).toISOString(), match.id);
        log('warning', `对局 ${match.id} 详情：${error.message}`);
        if (error.status === 429 || error.status === 403) return;
      }
    }
    this.current.phase = 'units'; this.current.match = null;
    const missing = this.store.all('SELECT DISTINCT u.unit_id FROM unit_instances u LEFT JOIN unit_catalogue c ON c.unit_id=u.unit_id WHERE c.unit_id IS NULL AND u.unit_id!=? LIMIT 500', '');
    for (let i = 0; i < missing.length && this.allowed(); i += 50) {
      try {
        const units = await this.source.units(missing.slice(i, i + 50).map((x) => x.unit_id));
        for (const unit of units) this.store.run('INSERT INTO unit_catalogue(unit_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(unit_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at', String(unit.id ?? unit.Id), JSON.stringify(unit), now());
      } catch (error) { counts.errors++; log('warning', `单位资料：${error.message}`); break; }
    }
  }
  async stop() { this.stopped = true; this.pending = null; clearInterval(this.timer); if (this.active) await this.active; if (this.backingUp) await this.backingUp; }
}
