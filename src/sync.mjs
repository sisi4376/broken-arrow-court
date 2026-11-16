import { now } from './db.mjs';
import { updateAirCatalogue } from './air-superiority.mjs';
import { updateUnitLoadouts } from './unit-loadout-catalogue.mjs';
import { updateUnitLoadoutHistory } from './unit-loadout-history.mjs';
import { syncIsDue } from './sync-schedule.mjs';
import { withRequestContext } from './request-monitor.mjs';
import { profileCalibration } from './profile-stats.mjs';
import { accountGameCount, accountQueryState, quietMatchAccounts, MATCH_QUERY_QUIET_MS } from './account-query-policy.mjs';

export const SYNC_POLICY = Object.freeze({ backfillPages:20, detailLimit:50, personalDetailLimit:10 });

export class SyncEngine {
  constructor(store, source, { onIdle = () => {} } = {}) {
    this.store = store;
    this.source = source;
    this.active = null;
    this.pending = null;
    this.stopped = false;
    this.current = null;
    this.onIdle = onIdle;
    store.run("UPDATE sync_runs SET status='interrupted',finished_at=?,message='服务重启，下次从已保存进度继续' WHERE status='running'", now());
  }
  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.store.event(null, 'error', e.message)), 15000);
    this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 1500).unref();
  }
  async tick(at=Date.now()) {
    if (this.active || this.stopped) return;
    const s = this.store.settings();
    if (!this.backingUp && this.store.get('SELECT id FROM users LIMIT 1') && (!s.last_backup || Date.now() - Date.parse(s.last_backup) >= 86400000)) {
      this.backingUp = this.store.backup().catch((e) => this.store.event(null, 'error', `自动备份失败：${e.message}`)).finally(() => { this.backingUp = null; });
      await this.backingUp;
    }
    if (!s.sync_enabled || !this.store.get('SELECT id FROM accounts WHERE active=1 LIMIT 1')) return;
    if (at < this.source.blockedUntil) return;
    if (syncIsDue(s.last_sync_started,at)) this.request('incremental', { scheduled:true });
  }
  request(kind = 'incremental', { scheduled=false, manual=false, requestId=null } = {}) {
    if (this.stopped) return { started: false, message: '同步服务已停止' };
    if (this.active) { this.pendingManual = manual || Boolean(this.pending && this.pendingManual); this.pendingScheduled = this.pending ? this.pendingScheduled && scheduled : scheduled; this.pending = this.pending === 'full' || kind === 'full' ? 'full' : 'incremental'; return { started: false, queued: true }; }
    this.active = this.run(kind, { scheduled, manual, requestId }).catch((error) => this.store.event(null, 'error', error.message)).finally(async () => {
      this.active = null; this.current = null;
      if (this.pending && !this.stopped) {
        const next = this.pending, nextScheduled = this.pendingScheduled, nextManual = this.pendingManual;
        this.pending = null; this.pendingManual = false;
        if (nextManual || this.store.settings().sync_enabled) { this.request(next, { scheduled:nextScheduled, manual:nextManual }); return; }
      }
      if (!this.stopped) {
        try { await this.onIdle(); }
        catch (error) { this.store.event(null, 'warning', `同步后发布检查失败：${error.message}`); }
      }
    });
    return { started: true };
  }
  allowed() { return !this.stopped && (this.current?.manual || this.store.settings().sync_enabled); }
  async run(kind = 'incremental', { scheduled=false, manual=false, requestId=null } = {}) {
    const runId = this.store.transaction(() => {
      const id = Number(this.store.run('INSERT INTO sync_runs(kind,started_at) VALUES(?,?)', kind, now()).lastInsertRowid);
      if (requestId) this.store.setting(`remote_update:${requestId}`, { run_id: id });
      return id;
    });
    return withRequestContext({run_id:runId,trigger:requestId?'群友请求更新':scheduled?'自动同步':kind==='full'?'手动历史复查':'手动同步'},async()=>{
    this.store.setting('last_sync_started', now());
    const counts = { requests: 0, imported: 0, changed: 0, errors: 0 };
    this.current = { id: runId, kind, manual, phase: 'accounts', account: null, ...counts };
    this.source.onRequest = (resource,record) => { if(record&&record.run_id!==runId)return; counts.requests++; if (this.current) Object.assign(this.current, counts); };
    const log = (level, message) => this.store.event(runId, level, message);
    log('info', kind === 'full' ? '开始全量回溯，已有档案保留' : '开始增量同步');
    let status = 'complete';
    try {
      const accounts = this.store.all('SELECT a.* FROM accounts a JOIN members m ON m.id=a.member_id WHERE a.active=1 AND m.active=1 ORDER BY a.last_recent_sync ASC,a.id')
        .map(account => ({ ...account, query_games: accountGameCount(this.store, account) }))
        .sort((a, b) => b.query_games - a.query_games);
      for (const original of accounts) {
        if (!this.allowed()) break;
        let account = this.store.get('SELECT * FROM accounts WHERE id=?', original.id);
        // Re-read immediately before each account: an earlier account may have
        // discovered a shared match and silenced this one during the same run.
        const quiet = accountQueryState(this.store, account.player_id);
        if (quiet.query_silent) {
          log('info', `${account.name}：对局 ${quiet.query_quiet_match_id} 结束后静默，跳过查询至 ${new Date(quiet.query_quiet_until).toISOString()}`);
          continue;
        }
        if (kind !== 'full' && account.next_retry && Date.parse(account.next_retry) > Date.now()) continue;
        const pollKey = `source_poll:${this.source.base ?? 'default'}:${account.player_id}`;
        const poll = this.store.settings()[pollKey] ?? {};
        if(kind==='full')this.store.run('UPDATE accounts SET backfill_offset=0,history_complete=0 WHERE id=?',account.id);
        // A previously completed archive never restarts an old historical scan
        // automatically, including a cursor left by an older weekly rescan.
        else if(account.last_full_scan&&!account.history_complete)this.store.run('UPDATE accounts SET history_complete=1 WHERE id=?',account.id);
        account=this.store.get('SELECT * FROM accounts WHERE id=?',account.id);
        this.current.account = account.name;
        const boundaryKey = `recent_boundary:${this.source.base ?? 'default'}:${account.player_id}`;
        const context = { pages:new Map(),recentOnly:kind!=='full'&&!!account.last_full_scan,resumeOffset:Number(this.store.settings()[`recent_resume:${account.id}`])||0 };
        let boundary = this.store.settings()[boundaryKey];
        // Migrate only a completed check. An interrupted check's head is not
        // evidence that the older pages between it and the archive were saved.
        if (!Array.isArray(boundary) && original.history_complete && !context.resumeOffset) {
          try { boundary = JSON.parse(poll.head)[1]; } catch { /* No previous successful head. */ }
        }
        context.boundary = new Set(context.recentOnly && Array.isArray(boundary) ? boundary.map(String).filter(id=>this.store.get('SELECT 1 FROM account_matches WHERE account_id=? AND match_id=?',account.id,id)) : []);
        try {
          if (!this.allowed()) break;
          const head = await this.recent(account, counts, log, context);
          if (!this.allowed()) break;
          if(!accountQueryState(this.store,account.player_id).query_silent&&(kind==='full'||!account.last_full_scan))await this.backfill(this.store.get('SELECT * FROM accounts WHERE id=?', account.id), counts, log, context, kind === 'full' ? 200 : SYNC_POLICY.backfillPages);
          const calibrationKey=`profile_calibration_retry:${this.source.base??'default'}:${account.player_id}`;
          if(this.allowed()&&!accountQueryState(this.store,account.player_id).query_silent&&!context.profile&&typeof this.source.profile==='function'&&profileCalibration(this.store,account.player_id).due&&(this.store.settings()[calibrationKey]??0)<=Date.now()){
            try{
              const profile=await this.source.profile(account.player_id);
              if(String(profile.playerData.info.id)!==account.player_id||!profile.playerData.statInfo||typeof profile.playerData.statInfo!=='object'||Array.isArray(profile.playerData.statInfo))throw new Error('生涯校准返回的账号或累计统计不完整');
              this.store.saveProfile(account.player_id,profile.playerData,profile.metadata);
              this.store.setting(calibrationKey,null);
              log('info',`${account.name}：生涯数据已校准，日常由本地对局更新，下次在 ${profileCalibration(this.store,account.player_id).days} 天后校准`);
            }catch(error){
              this.store.setting(calibrationKey,Date.now()+Math.max(error.retryAfter??0,3600000));
              if(error.status===429||error.status===403)throw error;
              counts.errors++;log('warning',`${account.name} 生涯校准：${error.message}`);
            }
          }
          // Advance the stopping boundary only after the entire gap is closed.
          // Keep it unchanged across pauses, errors and incomplete catch-ups.
          if (context.headIds && this.store.get('SELECT history_complete FROM accounts WHERE id=?',account.id).history_complete) this.store.setting(boundaryKey,context.headIds);
          this.store.run('UPDATE accounts SET last_error=NULL,error_count=0,next_retry=NULL WHERE id=?', account.id);
          if (this.allowed()) this.store.setting(pollKey, {head});
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
    });
  }
  ingest(id, data, accountId, counts, log) {
    let result;
    try { result = this.store.ingest(id, data, accountId); counts.imported += Number(result.added); counts.changed += Number(result.changed); }
    catch (error) { counts.errors++; log('error', `对局 ${id} 解析失败：${error.message}`); throw error; }
    if (this.current) Object.assign(this.current, counts);
    return result;
  }
  async ingestDiscovered(item, account, counts, log) {
    const result = this.ingest(item.matchId, item.data, account.id, counts, log);
    const saved = this.store.get('SELECT detail_state,detail_retry_at,end_time FROM matches WHERE id=?', String(item.matchId));
    const freshPending = saved.detail_state !== 'complete' && saved.end_time * 1000 + MATCH_QUERY_QUIET_MS > Date.now()
      && (!saved.detail_retry_at || Date.parse(saved.detail_retry_at) <= Date.now());
    if ((!result.added && !freshPending) || typeof this.source.detail !== 'function' || !this.allowed()) return;
    const phase = this.current?.phase;
    if (this.current) { this.current.phase = 'details'; this.current.match = String(item.matchId); }
    try {
      // OfficialSource reuses the report just read for this list. BATrace fetches
      // its detail now, before another account can send a redundant list query.
      const friendCount = this.store.get('SELECT friend_count FROM matches WHERE id=?', String(item.matchId)).friend_count;
      const detail = await this.source.detail(String(item.matchId), { minDelay: friendCount >= 3 ? 0 : 5000 });
      this.store.saveDetail(String(item.matchId), detail);
      const silenced = quietMatchAccounts(this.store, item.matchId, detail.data, account.player_id);
      log('info', `对局 ${item.matchId}：新对局完整玩家与单位实例已立即归档${silenced.length ? `，${silenced.length} 个登记账号静默至对局结束后 45 分钟` : ''}`);
    } catch (error) {
      const row = this.store.get('SELECT detail_attempts FROM matches WHERE id=?', String(item.matchId));
      const delay = Math.max(error.retryAfter ?? 0, Math.min(7 * 86400000, 3600000 * (2 ** Math.min(row.detail_attempts, 8))));
      this.store.run("UPDATE matches SET detail_state='error',detail_error=?,detail_attempts=detail_attempts+1,detail_retry_at=? WHERE id=?", error.message, new Date(Date.now()+delay).toISOString(), String(item.matchId));
      if (error.status === 429 || error.status === 403) throw error;
      counts.errors++; log('warning', `对局 ${item.matchId} 详情：${error.message}`);
    } finally {
      if (this.current) { this.current.phase = phase; this.current.match = null; Object.assign(this.current, counts); }
    }
  }
  async historyPage(account, offset, counts, log, context) {
    if (context.pages?.has(offset)) return context.pages.get(offset);
    const data = await this.source.matches(account.player_id, offset);
    const span = Math.max(0, Math.min(10, data.totalCount - offset));
    let matches = data.matches;
    const knownRecent=context.recentOnly&&matches.length>0&&matches.every(m=>this.store.get('SELECT 1 FROM account_matches WHERE account_id=? AND match_id=?',account.id,String(m.matchId)));
    if (matches.length < span && !knownRecent) {
      // totalCount counts historical IDs, including matches whose data has expired.
      // Verify the actual ID window and repeat the page before recording gaps.
      if (!context.ids) {
        if (!this.source.profile) throw new Error('历史回溯遇到空页或短页，无法核对历史索引，保留进度等待重试');
        const profile = context.profile ?? await this.source.profile(account.player_id);
        if (String(profile.playerData.info.id) !== account.player_id) throw new Error('返回的玩家 ID 与登记账号不一致');
        const ids = profile.playerData.last_fights_data;
        if (!Array.isArray(ids) || ids.length !== data.totalCount || new Set(ids.map(String)).size !== ids.length || !ids.every(id => /^[1-9]\d{0,19}$/.test(String(id)))) throw new Error('历史索引与分页总数不一致，保留进度等待重试');
        context.ids = ids.map(String);
        context.profile = profile;
        this.store.saveProfile(account.player_id, profile.playerData, profile.metadata);
        log('info', `${account.name}：为核验缺失分页读取历史索引`);
      }
      if (context.ids.length !== data.totalCount) throw new Error('历史分页在同步期间发生变化，保留进度等待重试');
      const expected = context.ids.slice(offset, offset + span);
      const confirmed = await this.source.matches(account.player_id, offset,{force:true});
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
    for (const m of matches) await this.ingestDiscovered(m, account, counts, log);
    // Advance by the requested ID window, not the number of surviving match bodies.
    const result = { totalCount: data.totalCount, matches, next: offset + span, allKnown };
    context.pages?.set(offset, result);
    return result;
  }
  async recent(account, counts, log, context = { pages:new Map() }) {
    this.current.phase = 'recent';
    let offset = 0;
    let head;
    for (let page = 0; page < 200 && this.allowed(); page++) {
      const data = await this.historyPage(account, offset, counts, log, context);
      if (offset === 0) {
        context.headIds = data.matches.map(m=>String(m.matchId));
        head = JSON.stringify([data.totalCount, context.headIds]);
      }
      // A mixed page can already reconnect to the last completed check. Save
      // every returned match on it, but do not fetch another all-old page.
      // Arbitrarily imported matches must not become an early stopping point.
      const reachedKnown = context.boundary?.size
        ? data.matches.some(m=>context.boundary.has(String(m.matchId)))
        : data.allKnown && offset >= (context.resumeOffset ?? 0);
      this.store.run('UPDATE accounts SET backfill_total=?,recent_target=?,last_recent_sync=? WHERE id=?', data.totalCount, data.totalCount, now(), account.id);
      offset = data.next;
      if (account.history_complete) {
        const finished = reachedKnown || offset >= data.totalCount;
        this.store.run('UPDATE accounts SET history_complete=?,backfill_offset=? WHERE id=?', Number(finished), finished ? data.totalCount : offset, account.id);
        this.store.setting(`recent_resume:${account.id}`,finished?null:offset);
      }
      if (!account.history_complete || reachedKnown || offset >= data.totalCount || accountQueryState(this.store,account.player_id).query_silent) break;
    }
    log('info', `${account.name}：近期列表已同步，上游当前列出 ${this.store.get('SELECT backfill_total FROM accounts WHERE id=?', account.id).backfill_total} 局`);
    return head;
  }
  async backfill(account, counts, log, context = { pages:new Map() }, pageLimit = SYNC_POLICY.backfillPages) {
    if (account.history_complete) return;
    this.current.phase = 'backfill';
    // An overlap tolerates new matches being inserted at the head between resumptions.
    let offset = Math.max(0, account.backfill_offset - 10);
    for (let page = 0; page < pageLimit && this.allowed() && !accountQueryState(this.store,account.player_id).query_silent; page++) {
      const data = await this.historyPage(account, offset, counts, log, context);
      const next = data.next;
      const complete = next >= data.totalCount;
      this.store.run('UPDATE accounts SET backfill_offset=?,backfill_total=?,history_complete=?,last_full_scan=CASE WHEN ? THEN ? ELSE last_full_scan END WHERE id=?', next, data.totalCount, Number(complete), Number(complete), now(), account.id);
      if (complete) {
        const missing = this.store.get('SELECT COUNT(*) AS n FROM account_history_gaps WHERE account_id=?', account.id).n;
        log(missing ? 'warning' : 'info', missing ? `${account.name}：历史索引已扫描（${data.totalCount} 条），${missing} 条比赛数据上游暂未返回，已保留缺失 ID；仅手动复查` : `${account.name}：当前可查询历史已回溯完成（${data.totalCount} 局）`);
        break;
      }
      if (next <= offset) throw new Error('历史分页没有前进，保留已导入数据');
      offset = next;
    }
  }
  async enrich(counts, log) {
    this.current.phase = 'details'; this.current.account = null;
    let personal=0;
    const matches = typeof this.source.detail==='function'?this.store.all("SELECT m.id,m.friend_count,m.detail_attempts FROM matches m WHERE (m.friend_count>=3 OR EXISTS(SELECT 1 FROM registered_participants r WHERE r.match_id=m.id)) AND m.detail_state!='complete' AND (m.detail_retry_at IS NULL OR m.detail_retry_at<=?) ORDER BY (m.friend_count>=3) DESC,m.end_time DESC LIMIT ?", now(), SYNC_POLICY.detailLimit).filter(m=>m.friend_count>=3||++personal<=SYNC_POLICY.personalDetailLimit):[];
    for (const match of matches) {
      if (!this.allowed()) break;
      this.current.match = match.id;
      try {
        const detail = await this.source.detail(match.id,{minDelay:match.friend_count>=3?0:5000});
        this.store.saveDetail(match.id, detail);
        quietMatchAccounts(this.store,match.id,detail.data);
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
    for (let i = 0; i < missing.length && this.allowed() && this.source.supportsCatalogues!==false; i += 50) {
      try {
        const units = await this.source.units(missing.slice(i, i + 50).map((x) => x.unit_id));
        for (const unit of units) this.store.run('INSERT INTO unit_catalogue(unit_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(unit_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at', String(unit.id ?? unit.Id), JSON.stringify(unit), now());
      } catch (error) { counts.errors++; log('warning', `单位资料：${error.message}`); break; }
    }
    if(this.allowed()&&Date.now()>=this.source.blockedUntil&&this.source.read&&this.source.supportsCatalogues!==false){
      this.current.phase='air-loadouts';
      try {
        const result=await updateAirCatalogue(this.store,this.source,{allowed:()=>this.allowed()});
        if(result.updated)log('info',`空优挂载目录已更新 ${result.updated} 种飞机，当前 ${result.total} 种`);
      }catch(error){counts.errors++;log('warning',`空优挂载目录：${error.message}`);}
      if(this.allowed()&&Date.now()>=this.source.blockedUntil){
        this.current.phase='unit-loadouts';
        try{const result=await updateUnitLoadouts(this.store,this.source,{allowed:()=>this.allowed()});if(result.updated)log('info',`单位挂载目录已更新 ${result.updated} 种`);const history=await updateUnitLoadoutHistory(this.store,this.source,{allowed:()=>this.allowed()});if(history.updated)log('info',`历史挂载目录已补齐 ${history.updated} 项`);}
        catch(error){counts.errors++;log('warning',`单位挂载目录：${error.message}`);}
      }
    }
  }
  async stop() { this.stopped = true; this.pending = null; clearInterval(this.timer); if (this.active) await this.active; if (this.backingUp) await this.backingUp; }
}
