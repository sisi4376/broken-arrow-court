import http from 'node:http';
import { readFile, mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store, now, digest } from './db.mjs';
import { SourceClient } from './source.mjs';
import { SyncEngine } from './sync.mjs';
import { Publication } from './publication.mjs';
import { serveStatic } from './static-host.mjs';
import { numericId, normalizeMatch, extractImport, extractProfile, extractMatchDetail, parseMatchReference, mapName, TITLE } from './domain.mjs';
import { dashboard, listMatches, matchDetail, memberStats, unitStats, supplyAnalysis } from './queries.mjs';
import { overallAnalysis, friendAnalysis, deckModel, identifyDeck, specName } from './analysis.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COOKIE = 'court_session';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const assert = (condition, status, message) => { if (!condition) throw new HttpError(status, message); };
const nameInput = (value) => { const s = String(value ?? '').trim(); assert(s.length >= 1 && s.length <= 40, 400, '朋友称呼需为 1 至 40 个字符'); return s; };
const passwordInput = (value) => { assert(typeof value === 'string' && value.length >= 10 && value.length <= 128, 400, '密码需为 10 至 128 个字符'); return value; };
const usernameInput = (value) => { const s = String(value ?? '').trim().toLowerCase(); assert(/^[a-z0-9_.@-]{3,64}$/.test(s), 400, '登录名需为 3 至 64 位字母、数字或 _.@-'); return s; };
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [salt, value] = hash.split(':');
  const derived = await scrypt(String(password ?? ''), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(value, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

async function readBody(req, max = 1024 * 1024) {
  assert(String(req.headers['content-type'] ?? '').startsWith('application/json'), 415, '请求需要 application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert(size <= max, 413, '上传内容过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'JSON 格式无效'); }
}

export function createApplication({ directory = process.env.DATA_DIR || path.join(ROOT, 'data'), sourceOptions, startScheduler = true, shutdownToken = null, staticOutputDirectory } = {}) {
  const store = new Store(directory);
  const source = new SourceClient(store, sourceOptions);
  const engine = new SyncEngine(store, source);
  const staticDirectory = path.resolve(staticOutputDirectory || process.env.STATIC_OUTPUT_DIR || path.join(ROOT, 'site'));
  const publication = new Publication(store, { directory: staticDirectory, remote: process.env.PUBLISH_GIT_REMOTE || '', branch: process.env.PUBLISH_GIT_BRANCH || 'main', intervalMinutes: Number(process.env.PUBLISH_MIN_INTERVAL_MINUTES || 120), enabled: process.env.STATIC_EXPORT_ENABLED !== '0' });
  const limits = new Map();
  let onShutdown = null;
  function rate(req, label, limit = 12) {
    const key = `${req.socket.remoteAddress}:${label}`;
    const entry = limits.get(key) ?? { count: 0, until: Date.now() + 900000 };
    if (entry.until < Date.now()) { entry.count = 0; entry.until = Date.now() + 900000; }
    entry.count++; limits.set(key, entry);
    if (limits.size > 5000) for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
    assert(entry.count <= limit, 429, '请求过于频繁，请稍后重试');
  }
  function session(req) {
    const token = String(req.headers.cookie ?? '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || !/^[\da-f]{64}$/.test(token)) return null;
    return store.get('SELECT u.id,u.member_id,u.username,u.role,m.name,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id JOIN members m ON m.id=u.member_id WHERE s.token_hash=? AND s.expires_at>? AND m.active=1', digest(token), now()) ?? null;
  }
  function setSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    store.run('DELETE FROM sessions WHERE expires_at<?', now());
    store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)', digest(token), userId, csrf, new Date(Date.now() + 7 * 86400000).toISOString());
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.SECURE_COOKIE === '1' ? '; Secure' : ''}`);
    return csrf;
  }
  function json(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body);
  }
  const admin = (user) => assert(user.role === 'admin', 403, '需要管理员权限');
  const own = (user, memberId) => assert(user.role === 'admin' || user.member_id === Number(memberId), 403, '只能管理自己的账号');
  function listMembers() {
    return store.all('SELECT m.*,u.id AS user_id,u.username,u.role FROM members m LEFT JOIN users u ON u.member_id=m.id ORDER BY m.created_at,m.id').map((m) => ({ ...m, accounts: store.all('SELECT a.*,(SELECT COUNT(*) FROM participants p WHERE p.player_id=a.player_id) AS archived_count,(SELECT COUNT(*) FROM account_history_gaps g WHERE g.account_id=a.id) AS history_missing_count FROM accounts a WHERE a.member_id=? ORDER BY a.id', m.id) }));
  }
  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (route === '/readonly') { res.writeHead(302, { Location: '/readonly/' }); res.end(); return; }
      if (route.startsWith('/readonly/')) return await serveStatic(req, res, staticDirectory, route.slice('/readonly/'.length));
      if (!route.startsWith('/api/')) {
        assert(['GET','HEAD'].includes(req.method), 405, '不支持此请求方法');
        const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/analysis.js': ['analysis.js','text/javascript'], '/performance.js': ['performance.js','text/javascript'], '/table-sort.js': ['table-sort.js','text/javascript'], '/style.css': ['style.css','text/css'], '/icons.js': ['icons.js','text/javascript'], '/favicon.svg': ['favicon.svg','image/svg+xml'] };
        const file = files[route]; assert(file, 404, '页面不存在');
        const body = await readFile(path.join(ROOT, 'public', file[0]));
        res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      if (!['GET','HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        const expected = process.env.PUBLIC_ORIGIN || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        assert(!origin || origin === expected, 403, '请求来源不匹配');
        assert(req.headers['sec-fetch-site'] !== 'cross-site', 403, '不允许跨站请求');
      }
      if (route === '/api/health') return json(res, { ok: true, title: TITLE });
      if (route === '/api/service/stop' && req.method === 'POST') {
        const remote = req.socket.remoteAddress;
        assert(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote) && shutdownToken && req.headers['x-service-token'] === shutdownToken, 403, '无效的服务管理请求');
        json(res, { ok: true }); setTimeout(() => onShutdown?.(), 100).unref(); return;
      }
      const user = session(req);
      if (route === '/api/session' && req.method === 'GET') return json(res, { user, setup_required: !store.get('SELECT id FROM users LIMIT 1'), title: TITLE });
      if (route === '/api/invitation' && req.method === 'GET') {
        rate(req, 'invite-check', 60);
        const code = String(url.searchParams.get('code') ?? '').slice(0,100);
        const invite = store.get('SELECT i.member_id,m.name FROM invitations i LEFT JOIN members m ON m.id=i.member_id WHERE i.code_hash=? AND i.used_at IS NULL AND i.expires_at>?', digest(code), now());
        assert(invite, 400, '邀请码无效、已使用或已过期'); return json(res, { name: invite.name ?? null });
      }
      if (route === '/api/register' && req.method === 'POST') {
        rate(req, 'register'); const body = await readBody(req);
        const username = usernameInput(body.username); const password = passwordInput(body.password);
        const name = nameInput(body.name); const hash = await hashPassword(password);
        const id = store.transaction(() => {
          const first = !store.get('SELECT id FROM users LIMIT 1');
          let memberId;
          let invitation;
          if (!first) {
            invitation = store.get('SELECT * FROM invitations WHERE code_hash=? AND used_at IS NULL AND expires_at>?', digest(String(body.invite ?? '')), now());
            assert(invitation, 403, '需要有效的朋友邀请码');
            memberId = invitation.member_id;
            if (memberId) {
              assert(!store.get('SELECT id FROM users WHERE member_id=?', memberId), 409, '该朋友已有登录账号');
              assert(store.get('SELECT active FROM members WHERE id=?', memberId)?.active, 403, '该朋友已停用');
            }
          }
          assert(!store.get('SELECT id FROM users WHERE username=?', username), 409, '此登录名已被使用');
          if (!memberId) memberId = Number(store.run('INSERT INTO members(name,created_at) VALUES(?,?)', name, now()).lastInsertRowid);
          const id = Number(store.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)', memberId, username, hash, first ? 'admin' : 'member', now()).lastInsertRowid);
          if (invitation) store.run('UPDATE invitations SET used_at=? WHERE id=?', now(), invitation.id);
          store.audit(id, 'register', { memberId }); return id;
        });
        setSession(res, id); return json(res, { ok: true }, 201);
      }
      if (route === '/api/login' && req.method === 'POST') {
        rate(req, 'login', 30); const body = await readBody(req);
        const username = usernameInput(body.username);
        assert(typeof body.password === 'string' && body.password.length <= 128, 400, '无效的密码');
        const account = store.get('SELECT u.*,m.active FROM users u JOIN members m ON m.id=u.member_id WHERE username=?', username);
        const good = await verifyPassword(body.password, account?.password_hash ?? '00000000000000000000000000000000:' + '0'.repeat(128));
        assert(account && account.active && good, 401, '登录名或密码错误');
        setSession(res, account.id); return json(res, { ok: true });
      }
      assert(user, 401, '请先登录');
      if (!['GET','HEAD'].includes(req.method)) assert(req.headers['x-csrf-token'] === user.csrf, 403, '登录状态已变化，请刷新页面后重试');
      if (route === '/api/logout' && req.method === 'POST') {
        store.run('DELETE FROM sessions WHERE user_id=? AND csrf=?', user.id, user.csrf);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); return json(res, { ok: true });
      }
      if (route === '/api/password' && req.method === 'POST') {
        rate(req, 'password'); const body = await readBody(req); const password = passwordInput(body.password);
        const current = store.get('SELECT password_hash FROM users WHERE id=?', user.id);
        assert(typeof body.old_password === 'string' && body.old_password.length <= 128, 400, '请输入当前密码');
        assert(await verifyPassword(body.old_password, current.password_hash), 403, '当前密码错误');
        store.run('UPDATE users SET password_hash=? WHERE id=?', await hashPassword(password), user.id);
        store.run('DELETE FROM sessions WHERE user_id=?', user.id); setSession(res, user.id); store.audit(user.id, 'password-change', {}); return json(res, { ok: true });
      }
      const passwordReset = route.match(/^\/api\/users\/(\d+)\/password$/);
      if (passwordReset && req.method === 'POST') {
        admin(user); rate(req, 'admin-password-reset');
        const id = Number(passwordReset[1]);
        assert(id !== user.id, 400, '请通过账号设置修改自己的密码');
        assert(store.get('SELECT id FROM users WHERE id=?', id), 404, '用户不存在');
        const body = await readBody(req); const hash = await hashPassword(passwordInput(body.password));
        store.transaction(() => {
          store.run('UPDATE users SET password_hash=? WHERE id=?', hash, id);
          store.run('DELETE FROM sessions WHERE user_id=?', id);
          store.audit(user.id, 'admin-password-reset', { userId: id });
        }); return json(res, { ok: true });
      }
      if (route === '/api/members' && req.method === 'GET') return json(res, { members: listMembers() });
      if (route === '/api/members' && req.method === 'POST') {
        admin(user); const body = await readBody(req); const name = nameInput(body.name);
        const id = Number(store.run('INSERT INTO members(name,created_at) VALUES(?,?)', name, now()).lastInsertRowid);
        store.audit(user.id, 'member-add', { id, name }); return json(res, { id }, 201);
      }
      let match = route.match(/^\/api\/members\/(\d+)$/);
      if (match && req.method === 'PATCH') {
        const id = Number(match[1]); own(user, id); const body = await readBody(req);
        const m = store.get('SELECT * FROM members WHERE id=?', id); assert(m, 404, '朋友不存在');
        if (body.active !== undefined) { admin(user); assert(id !== user.member_id || body.active, 400, '不能停用自己'); }
        store.transaction(() => {
          store.run('UPDATE members SET name=?,active=? WHERE id=?', body.name === undefined ? m.name : nameInput(body.name), body.active === undefined ? m.active : Number(!!body.active), id);
          if (body.active === false) store.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE member_id=?)', id);
          store.reclassify(); store.audit(user.id, 'member-update', { id, name: body.name, active: body.active });
        }); return json(res, { ok: true });
      }
      if (route === '/api/invitations' && req.method === 'POST') {
        admin(user); const body = await readBody(req); const memberId = body.member_id ? Number(body.member_id) : null;
        if (memberId) { assert(store.get('SELECT id FROM members WHERE id=? AND active=1', memberId), 404, '朋友不存在或已停用'); assert(!store.get('SELECT id FROM users WHERE member_id=?', memberId), 409, '该朋友已有登录账号'); }
        const code = randomBytes(18).toString('base64url'); const expires = new Date(Date.now() + 7 * 86400000).toISOString();
        store.run('INSERT INTO invitations(code_hash,member_id,expires_at,created_by) VALUES(?,?,?,?)', digest(code), memberId, expires, user.id);
        store.audit(user.id, 'invite-create', { memberId }); return json(res, { code, expires_at: expires }, 201);
      }
      if (route === '/api/players/search' && req.method === 'GET') {
        rate(req, 'player-search', 100);
        const q = String(url.searchParams.get('q') ?? '').trim();
        let data = await source.search(q);
        if (!data.players.length && /^[1-9]\d{0,9}$/.test(q)) {
          const profile = await source.profile(q); const info = profile.playerData.info;
          data = { players: [{ ...info, steam_id: info.steamId }], count: 1 };
        }
        return json(res, { ...data, players: data.players.map((p) => ({ ...p, registered: store.get('SELECT a.id,a.member_id,m.name AS member_name FROM accounts a JOIN members m ON m.id=a.member_id WHERE a.player_id=?', String(p.id)) ?? null })) });
      }
      if (route === '/api/accounts' && req.method === 'POST') {
        const body = await readBody(req); const memberId = Number(body.member_id ?? user.member_id); own(user, memberId);
        assert(store.get('SELECT id FROM members WHERE id=? AND active=1', memberId), 404, '朋友不存在或已停用');
        const playerId = numericId(body.player_id);
        assert(playerId.length < 17, 400, '这里需要游戏内玩家 ID；Steam64 ID 请通过搜索转换');
        assert(!store.get('SELECT id FROM accounts WHERE player_id=?', playerId), 409, '此游戏账号已登记，请由管理员调整归属');
        // Register first, so temporary provider failures never prevent adding an account.
        const id = Number(store.run('INSERT INTO accounts(member_id,player_id,name,created_at) VALUES(?,?,?,?)', memberId, playerId, nameInput(body.name ?? `#${playerId}`), now()).lastInsertRowid);
        store.reclassify(); store.audit(user.id, 'account-add', { id, memberId, playerId });
        if (store.settings().sync_enabled) engine.request('incremental'); return json(res, { id }, 201);
      }
      match = route.match(/^\/api\/accounts\/(\d+)$/);
      if (match && req.method === 'PATCH') {
        const id = Number(match[1]); const a = store.get('SELECT * FROM accounts WHERE id=?', id); assert(a,404,'账号不存在'); own(user,a.member_id);
        const body = await readBody(req); let target = a.member_id;
        if (body.member_id !== undefined && Number(body.member_id) !== target) { admin(user); target = Number(body.member_id); assert(store.get('SELECT id FROM members WHERE id=?', target),404,'朋友不存在'); }
        store.transaction(() => {
          store.run('UPDATE accounts SET member_id=?,active=? WHERE id=?', target, body.active === undefined ? a.active : Number(!!body.active), id);
          store.reclassify(); store.audit(user.id, 'account-update', { id, memberId: target, active: body.active });
        }); return json(res, { ok: true });
      }
      match = route.match(/^\/api\/accounts\/(\d+)\/profile$/);
      if (match && req.method === 'GET') {
        const account = store.get('SELECT * FROM accounts WHERE id=?', Number(match[1])); assert(account,404,'账号不存在');
        const profile = store.get('SELECT * FROM profiles WHERE player_id=?', account.player_id);
        return json(res, { account, data: profile ? JSON.parse(profile.data_json) : null, metadata: profile ? JSON.parse(profile.metadata_json) : null, updated_at: profile?.updated_at ?? null });
      }
      if (route === '/api/dashboard' && req.method === 'GET') return json(res, dashboard(store,url.searchParams));
      if (route === '/api/analytics/members' && req.method === 'GET') return json(res, { members: memberStats(store,url.searchParams) });
      if (route === '/api/analytics/supply' && req.method === 'GET') return json(res, supplyAnalysis(store,url.searchParams));
      if (route === '/api/analytics/units' && req.method === 'GET') return json(res, { units: unitStats(store,url.searchParams) });
      if (route === '/api/analytics/overview' && req.method === 'GET') return json(res, overallAnalysis(store,url.searchParams));
      match = route.match(/^\/api\/members\/(\d+)\/analysis$/);
      if (match && req.method === 'GET') { const data=friendAnalysis(store,Number(match[1]),url.searchParams);assert(data,404,'朋友不存在');return json(res,data); }
      match = route.match(/^\/api\/matches\/(\d+)\/players\/([1-9]\d*)\/deck$/);
      if (match && ['PUT','DELETE'].includes(req.method)) {
        const [,matchId,playerId]=match;
        const account=store.get('SELECT * FROM accounts WHERE player_id=?',playerId);assert(account,404,'该游戏账号未登记');own(user,account.member_id);
        assert(store.get('SELECT 1 FROM participants WHERE match_id=? AND player_id=? AND (team_id IS NULL OR team_id!=100)',matchId,playerId),404,'未找到该账号的参战记录');
        if(req.method==='DELETE')store.run('DELETE FROM match_decks WHERE match_id=? AND player_id=?',matchId,playerId);
        else {
          const body=await readBody(req);const specs=deckModel(store).specializations;
          const a=specs.find(s=>s.id===Number(body.spec1)),b=specs.find(s=>s.id===Number(body.spec2));
          assert(a&&b&&a.id!==b.id&&a.countryId===b.countryId,400,'请选择同一国家的两种不同专精');
          store.run('INSERT INTO match_decks(match_id,player_id,spec1,spec2,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(match_id,player_id) DO UPDATE SET spec1=excluded.spec1,spec2=excluded.spec2,updated_by=excluded.updated_by,updated_at=excluded.updated_at',matchId,playerId,Math.min(a.id,b.id),Math.max(a.id,b.id),user.id,now());
        }
        store.audit(user.id,req.method==='DELETE'?'deck-clear':'deck-confirm',{match_id:matchId,player_id:playerId});return json(res,{ok:true});
      }
      if (route === '/api/maps' && req.method === 'GET') return json(res, { maps: store.all('SELECT DISTINCT map_id FROM matches ORDER BY CAST(map_id AS INTEGER)').map(m=>({...m,name:mapName(m.map_id)})), modes: store.all('SELECT DISTINCT mode FROM matches WHERE mode IS NOT NULL ORDER BY mode') });
      if (route === '/api/matches' && req.method === 'GET') { if (url.searchParams.get('scope') === 'all') admin(user); return json(res, listMatches(store,url.searchParams,user.role==='admin')); }
      match = route.match(/^\/api\/matches\/(\d+)$/);
      if (match && req.method === 'GET') {
        const detail = matchDetail(store,match[1]); assert(detail,404,'对局不存在');const model=deckModel(store);
        const overrides=new Map(store.all('SELECT * FROM match_decks WHERE match_id=?',detail.id).map(r=>[r.player_id,r]));
        detail.specializations=model.specializations.map(s=>({...s,display_name:specName(s)}));
        detail.participants=detail.participants.map(p=>({...p,deck:identifyDeck(p.raw,overrides.get(p.player_id),model)}));
        return json(res,detail);
      }
      match = route.match(/^\/api\/matches\/(\d+)\/retry$/);
      if (match && req.method === 'POST') {
        admin(user); const row = store.get('SELECT friend_count FROM matches WHERE id=?',match[1]); assert(row,404,'对局不存在'); assert(row.friend_count>=3,400,'此对局未达到三位朋友条件');
        store.run("UPDATE matches SET detail_state='summary',detail_retry_at=NULL WHERE id=?",match[1]); engine.request(); return json(res,{ok:true});
      }
      if (route === '/api/sync/status' && req.method === 'GET') {
        const s = store.settings();
        const stats = store.get("SELECT COUNT(*) AS candidates,COALESCE(SUM(friend_count>=3),0) AS qualified,COALESCE(SUM(friend_count>=3 AND detail_state='complete'),0) AS complete,COALESCE(SUM(friend_count>=3 AND detail_state='error'),0) AS detail_errors FROM matches");
        const databaseBytes = ['court.sqlite','court.sqlite-wal'].reduce((sum,name) => { try { return sum+statSync(path.join(store.directory,name)).size; } catch { return sum; } },0);
        return json(res,{settings:s,active:engine.current,queued:engine.pending,blocked_until:source.blockedUntil> Date.now()?new Date(source.blockedUntil).toISOString():null,stats:{...stats,units:store.get('SELECT COUNT(*) AS n FROM unit_instances').n,snapshots:store.get('SELECT COUNT(*) AS n FROM source_snapshots').n,database_bytes:databaseBytes},accounts:listMembers().flatMap((m)=>m.accounts.map((a)=>({...a,member_name:m.name}))),runs:store.all('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20'),events:store.all('SELECT * FROM sync_events ORDER BY id DESC LIMIT 100')});
      }
      if (route === '/api/sync/run' && req.method === 'POST') {
        admin(user); const body=await readBody(req); store.setting('sync_enabled',true);
        if (body.kind==='full') { source.blockedUntil = Math.max(source.blockedUntil,0); store.run('UPDATE accounts SET next_retry=NULL'); }
        store.audit(user.id,'sync-request',{kind:body.kind}); return json(res,engine.request(body.kind==='full'?'full':'incremental'),202);
      }
      if (route === '/api/settings' && req.method === 'PATCH') {
        admin(user); const body=await readBody(req);
        if (body.sync_minutes!==undefined) { assert(Number.isInteger(body.sync_minutes)&&body.sync_minutes>=5&&body.sync_minutes<=1440,400,'同步间隔需为 5 至 1440 分钟'); store.setting('sync_minutes',body.sync_minutes); }
        if (body.request_delay_ms!==undefined) { assert(Number.isInteger(body.request_delay_ms)&&body.request_delay_ms>=1000&&body.request_delay_ms<=60000,400,'请求间隔需为 1000 至 60000 毫秒'); store.setting('request_delay_ms',body.request_delay_ms); }
        if (body.sync_enabled!==undefined) { store.setting('sync_enabled',!!body.sync_enabled); if(!body.sync_enabled) engine.pending=null; }
        store.audit(user.id,'settings-update',body); return json(res,{ok:true});
      }
      if (route === '/api/import/match' && req.method === 'POST') {
        admin(user); rate(req, 'match-import', 30);
        const body=await readBody(req); const id=parseMatchReference(body.reference);
        const detail=await source.detail(id); normalizeMatch(id,detail.data);
        const old=store.get('SELECT raw_json FROM matches WHERE id=?',id);
        let result;
        store.transaction(()=>{
          result=store.ingest(id,{...old?JSON.parse(old.raw_json):{},...detail.data});
          store.saveDetail(id,detail);store.reclassify(id);
          store.audit(user.id,'match-fetch-import',{matchId:id,...result});
        });
        if(store.settings().sync_enabled)engine.request();
        return json(res,{id,...result,friend_count:store.get('SELECT friend_count FROM matches WHERE id=?',id).friend_count});
      }
      if (route === '/api/import' && req.method === 'POST') {
        admin(user); const body=await readBody(req,40*1024*1024);
        let payload=body.payload;
        if(typeof payload==='string') {
          if(payload.trim().startsWith('<')) {
            try { const p=extractProfile(payload); payload={...p, ...{playerData:p.playerData}}; }
            catch { const d=extractMatchDetail(payload); assert(body.match_id,400,'导入单场 HTML 时需要填写对局 ID'); payload={matchId:numericId(body.match_id,'对局 ID'),data:d.data,detail:d}; }
          } else { try { payload=JSON.parse(payload); } catch { throw new HttpError(400,'文件不是有效的 JSON'); } }
        }
        const parsed=extractImport(payload);
        assert(parsed.matches.size<=20000,400,'单次最多导入 20000 局');
        for(const [id,data] of parsed.matches) normalizeMatch(id,data);
        for(const p of parsed.profiles) { numericId(p.player_id); assert(p.data?.info&&String(p.data.info.id)===String(p.player_id),400,'玩家档案 ID 不匹配'); }
        const result={added:0,changed:0,profiles:parsed.profiles.length,details:0};
        store.transaction(()=>{
          for(const [id,data] of parsed.matches) { const r=store.ingest(id,data);result.added+=Number(r.added);result.changed+=Number(r.changed); }
          const details=new Map();
          for(const [id,data] of parsed.matches) {
            if(data.Data&&Object.values(data.Data).some(p=>p?.UnitData))details.set(id,{data,metadata:{}});
          }
          const exported=payload.format==='broken-arrow-court-v1'?payload.matches:[];
          for(const m of exported){if(m.detail)details.set(String(m.id),m.detail);}
          if(payload.detail&&payload.matchId)details.set(String(payload.matchId),payload.detail);
          for(const [id,detail] of details){store.saveDetail(id,detail);result.details++;}
          for(const p of parsed.profiles) store.saveProfile(p.player_id,p.data,p.metadata??{});
          store.reclassify();store.audit(user.id,'data-import',result);
        });
        if(store.settings().sync_enabled)engine.request(); return json(res,result);
      }
      if (route === '/api/export' && req.method === 'GET') {
        admin(user); res.setHeader('Content-Disposition',`attachment; filename="court-export-${now().slice(0,10)}.json"`); return json(res,store.exportData());
      }
      if (route === '/api/backup' && req.method === 'POST') {
        admin(user); const file=await store.backup(); store.audit(user.id,'database-backup',{});
        res.writeHead(200,{'Content-Type':'application/vnd.sqlite3','Content-Disposition':`attachment; filename="${path.basename(file)}"`});createReadStream(file).pipe(res);return;
      }
      assert(false,404,'接口不存在');
    } catch(error) {
      if(res.headersSent){res.end();return;}
      const status = error instanceof HttpError ? error.status : error.status===429?429:error.status===403?502:400;
      const message = /UNIQUE constraint/.test(error.message)?'账号或登记信息已存在，请检查重复项':error.message;
      json(res,{error:message},status);
    }
  }
  const server=http.createServer(handler);
  server.requestTimeout=120000;server.headersTimeout=30000;
  if(startScheduler){engine.start();publication.start();}
  return {server,store,source,engine,publication,staticDirectory,setShutdown(fn){onShutdown=fn;},async close(){await publication.stop();await engine.stop();await new Promise((resolve)=>server.close(resolve));store.close();}};
}

async function main() {
  const directory=path.resolve(process.env.DATA_DIR||path.join(ROOT,'data'));
  await mkdir(directory,{recursive:true});
  const lockPath=path.join(directory,'service.lock');
  try { const previous=JSON.parse(await readFile(lockPath,'utf8')); try{process.kill(previous.pid,0);throw new Error(`服务可能已运行（PID ${previous.pid}），请使用 Start.ps1 查看地址`);}catch(error){if(error.code!=='ESRCH')throw error;} await unlink(lockPath); } catch(error){if(error.code!=='ENOENT')throw error;}
  const lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.close();
  const shutdownToken=randomBytes(32).toString('hex');
  const app=createApplication({directory,shutdownToken});
  let port=Number(process.env.PORT||4317);const host=process.env.HOST||'127.0.0.1';
  for(let attempt=0;;attempt++){
    try {await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,host,()=>{app.server.removeListener('error',reject);resolve();});});break;}
    catch(error){if(error.code==='EADDRINUSE'&&attempt<10){port++;continue;}await unlink(lockPath).catch(()=>{});throw error;}
  }
  const record={pid:process.pid,port,host,url:`http://127.0.0.1:${port}`,started_at:now(),shutdown_token:shutdownToken};
  await writeFile(path.join(directory,'service.json'),JSON.stringify(record,null,2));
  console.log(`${TITLE}\nLocal: ${record.url}\nDatabase: ${app.store.file}`);
  let closing=false;
  const shutdown=async()=>{if(closing)return;closing=true;await app.close();await unlink(lockPath).catch(()=>{});await unlink(path.join(directory,'service.json')).catch(()=>{});process.exit(0);};
  app.setShutdown(shutdown);process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch((error)=>{console.error(error.message);process.exit(1);});
