import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { SyncEngine } from '../src/sync.mjs';
import { OfficialSource } from '../src/source-provider.mjs';
import { accountGameCount, accountQueryState, quietMatchAccounts, MATCH_QUERY_QUIET_MS } from '../src/account-query-policy.mjs';

function enabledStore(t) { const s = testStore(t); s.setting('match_query_quiet_enabled', true); return s; }

test('quiet and query skipping default off, so a shared fresh match does not skip any account', async t => {
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);ready(s,101,100);ready(s,102,50);
  const raw=rawMatch([101,102],{EndTime:Math.floor(Date.now()/1000)-60}),calls=[];
  await new SyncEngine(s,{blockedUntil:0,supportsCatalogues:false,
    async matches(id){calls.push(`list:${id}`);return{totalCount:1,matches:[{matchId:'900',data:raw}]};},
    async detail(id){calls.push(`detail:${id}`);return detailFor(raw);}
  }).run();
  assert.deepEqual(calls,['list:101','detail:900','list:102']);
  assert.equal(accountQueryState(s,'101').query_silent,false);
  assert.equal(s.get("SELECT COUNT(*) n FROM settings WHERE key LIKE 'account_query_quiet:%'").n,0);
  assert.equal(s.get("SELECT detail_state FROM matches WHERE id='900'").detail_state,'complete');
});

test('turning the switch off ignores persisted silence immediately and no new silence is recorded', async t => {
  const s=enabledStore(t);member(s,'A',[101]);member(s,'B',[102]);ready(s,101,100);ready(s,102,50);
  const raw=rawMatch([101,102],{EndTime:Math.floor(Date.now()/1000)-60});s.ingest('900',raw,1);s.saveDetail('900',detailFor(raw));
  quietMatchAccounts(s,'900',raw,'101');assert.equal(accountQueryState(s,'102').query_silent,true);
  s.setting('match_query_quiet_enabled',false);
  assert.deepEqual(accountQueryState(s,'102'),{query_silent:false,query_quiet_until:null,query_quiet_match_id:null});
  assert.deepEqual(quietMatchAccounts(s,'901',raw,'101'),[]);
  const calls=[];
  await new SyncEngine(s,{blockedUntil:0,supportsCatalogues:false,async matches(id){calls.push(id);return{totalCount:1,matches:[{matchId:'900',data:raw}]};}}).run();
  assert.deepEqual(calls,['101','102']);
  s.setting('match_query_quiet_enabled',true);assert.equal(accountQueryState(s,'102').query_silent,true);
});

function ready(store, playerId, games = 0) {
  store.saveProfile(String(playerId), { info: { id: Number(playerId) }, statInfo: { fightsCountRt: games } });
  store.run('UPDATE accounts SET history_complete=1,last_full_scan=? WHERE player_id=?', new Date().toISOString(), String(playerId));
}

test('queries descend by locally saved lifetime games and do not fetch statistics for ranking', async t => {
  const s = enabledStore(t); member(s, 'A', [101]); member(s, 'B', [102]); member(s, 'C', [103]);
  ready(s, 101, 400); ready(s, 102, 80); ready(s, 103, 900);
  const queried = [];
  await new SyncEngine(s, { blockedUntil: 0, async matches(id) { queried.push(id); return { totalCount: 0, matches: [] }; } }).run();
  assert.deepEqual(queried, ['103', '101', '102']);
  assert.equal(accountGameCount(s, s.get('SELECT * FROM accounts WHERE player_id=?', '101')), 400);
});

test('archives a new report before the next account and skips all its registered participants across restarts and manual/full runs', async t => {
  const s = enabledStore(t); member(s, 'A', [101]); member(s, 'B', [102]); member(s, 'C', [103]);
  ready(s, 101, 900); ready(s, 102, 500); ready(s, 103, 100);
  s.run('UPDATE profiles SET updated_at=? WHERE player_id=?', new Date(Date.now()-11*86400000).toISOString(), '101');
  const start = Math.floor(Date.now() / 1000) * 1000; let at = start;
  t.mock.method(Date, 'now', () => at);
  const raw = rawMatch([101, 102, 201], { EndTime: (start - 10 * 60000) / 1000 });
  const trace = [];
  const source = { blockedUntil: 0, supportsCatalogues: false,
    async matches(id) { trace.push(`list:${id}`); return { totalCount: 1, matches: [{ matchId: '900', data: raw }] }; },
    async detail(id) { trace.push(`detail:${id}`); return detailFor(raw); },
    async profile() { throw Error('Quiet account must not calibrate its profile'); }
  };
  await new SyncEngine(s, source).run();
  assert.deepEqual(trace, ['list:101', 'detail:900', 'list:103']);
  const until = start + 35 * 60000;
  assert.equal(accountQueryState(s, '101').query_quiet_until, until);
  assert.equal(accountQueryState(s, '102').query_quiet_until, until);
  assert.equal(accountQueryState(s, '103').query_silent, false);
  assert.equal(s.get('SELECT detail_state FROM matches WHERE id=?', '900').detail_state, 'complete');
  trace.length = 0; s.setting('sync_enabled', false);
  await new SyncEngine(s, source).run('full', { manual: true });
  assert.deepEqual(trace, ['list:103']);
  assert.equal(s.settings().sync_enabled, false);
  at = until; trace.length = 0;
  await new SyncEngine(s, source).run('incremental', { manual: true });
  assert.deepEqual(trace, ['list:101', 'list:102', 'list:103']);
  assert.equal(accountQueryState(s, '101').query_silent, false);
});

test('a newly downloaded match at least 45 minutes old does not silence anyone', async t => {
  const s = enabledStore(t); member(s, 'A', [101]); member(s, 'B', [102]); ready(s, 101, 100); ready(s, 102, 50);
  const at = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, 'now', () => at);
  const raw = rawMatch([101, 102], { EndTime: (at - MATCH_QUERY_QUIET_MS) / 1000 }), calls = [];
  await new SyncEngine(s, { blockedUntil: 0, supportsCatalogues: false,
    async matches(id) { calls.push(`list:${id}`); return { totalCount: 1, matches: [{ matchId: '900', data: raw }] }; },
    async detail(id) { calls.push(`detail:${id}`); return detailFor(raw); }
  }).run();
  assert.deepEqual(calls, ['list:101', 'detail:900', 'list:102']);
  assert.equal(accountQueryState(s, '101').query_silent, false);
  assert.equal(accountQueryState(s, '102').query_silent, false);
});

test('quiet deadlines use the match end, never shorten, include both teams and exclude spectators and unrelated alternate accounts', t => {
  const s = enabledStore(t); member(s, 'A', [101, 105]); member(s, 'B', [102]); member(s, 'Observer', [104]);
  const at = Math.floor(Date.now() / 1000) * 1000;
  const raw = rawMatch([101, 102, 104], { EndTime: (at - 5 * 60000) / 1000 });
  raw.Data['102'].TeamId = 1; raw.Data['104'].TeamId = 100;
  assert.deepEqual(quietMatchAccounts(s, '900', raw, '101', at), ['101', '102']);
  const until = at + 40 * 60000;
  quietMatchAccounts(s, '901', { ...raw, EndTime: (at - 20 * 60000) / 1000 }, '101', at);
  assert.equal(accountQueryState(s, '101', at).query_quiet_until, until);
  assert.equal(accountQueryState(s, '104', at).query_silent, false);
  assert.equal(accountQueryState(s, '105', at).query_silent, false);
  assert.equal(accountQueryState(s, '101', until).query_silent, false);
  assert.deepEqual(quietMatchAccounts(s, '902', { ...raw, EndTime: (at + 60000) / 1000 }, '101', at), []);
  assert.deepEqual(quietMatchAccounts(s, '903', { ...raw, EndTime: undefined }, '101', at), []);
});

test('a failure to download detail retains retry state and does not silence accounts', async t => {
  const s = enabledStore(t); member(s, 'A', [101]); member(s, 'B', [102]); ready(s, 101, 100); ready(s, 102, 50);
  const raw = rawMatch([101, 102], { EndTime: Math.floor(Date.now() / 1000) - 60 });
  const queried = []; let details = 0;
  await new SyncEngine(s, { blockedUntil: 0, supportsCatalogues: false,
    async matches(id) { queried.push(id); return { totalCount: 1, matches: [{ matchId: '900', data: raw }] }; },
    async detail() { details++; throw Error('temporary offline'); }
  }).run();
  assert.deepEqual(queried, ['101', '102']); assert.equal(details, 1);
  assert.equal(s.get('SELECT detail_state FROM matches').detail_state, 'error');
  assert.equal(accountQueryState(s, '101').query_silent, false);
});

test('official shared fresh match needs one index plus one report and skips the second account without another report download', async t => {
  const s = enabledStore(t); s.setting('request_delay_ms', 0); member(s, 'A', [101]); member(s, 'B', [102]);
  ready(s, 101, 100); ready(s, 102, 50);
  const raw = detailFor(rawMatch([101, 102], { EndTime: Math.floor(Date.now() / 1000) - 60 })).data, calls = [];
  const source = new OfficialSource(s, { fetcher: async url => {
    calls.push(url);
    if (url.endsWith('/last_fights')) return Response.json(['900']);
    if (url.endsWith('fight_900.json')) return Response.json(raw);
    throw Error(`Unexpected simulated request: ${url}`);
  } });
  await new SyncEngine(s, source).run();
  assert.equal(calls.length, 2); assert(calls[0].includes('/user/101/last_fights')); assert(calls[1].endsWith('fight_900.json'));
  assert.equal(s.get('SELECT requests FROM sync_runs').requests, 2);
  assert.equal(s.get('SELECT detail_state FROM matches').detail_state, 'complete');
  assert.equal(accountQueryState(s, '102').query_silent, true);
});

test('silencing during catch-up saves the gap and resumes it after the deadline without losing older new games', async t => {
  const s = enabledStore(t); member(s, 'A', [101]); ready(s, 101, 100);
  const start = Math.floor(Date.now()/1000)*1000; let at = start;
  t.mock.method(Date, 'now', () => at);
  const old = rawMatch([101, 201]); s.ingest('800', old, 1); s.saveDetail('800', detailFor(old));
  s.setting('recent_boundary:default:101', ['800']);
  const ids = [...Array.from({length:23},(_,i)=>String(1000+i)), '800'], pages = [], details = [];
  const fresh = rawMatch([101,201], {EndTime:(start-60000)/1000});
  const dataFor = id => id === '1000' ? fresh : old;
  const source = {blockedUntil:0,supportsCatalogues:false,
    async matches(id,offset){pages.push(offset);return{totalCount:ids.length,matches:ids.slice(offset,offset+10).map(matchId=>({matchId,data:dataFor(matchId)}))};},
    async detail(id){details.push(id);return detailFor(dataFor(id));}
  };
  await new SyncEngine(s,source).run();
  assert.deepEqual(pages,[0]); assert.equal(details.length,10);
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,0);
  assert.deepEqual(s.settings()['recent_boundary:default:101'],['800']);
  at=start+44*60000; pages.length=0;
  await new SyncEngine(s,source).run();
  assert.deepEqual(pages,[0,10,20]);
  assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,24);
  assert.equal(s.get("SELECT COUNT(*) n FROM matches WHERE detail_state='complete'").n,24);
  assert.equal(details.length,23); assert.equal(new Set(details).size,23);
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
});

test('a recently discovered summary is downloaded immediately even when it survived an earlier interruption', async t => {
  const s=enabledStore(t);member(s,'A',[101]);member(s,'B',[102]);ready(s,101,100);ready(s,102,50);
  const raw=rawMatch([101,102],{EndTime:Math.floor(Date.now()/1000)-60});s.ingest('900',raw,1);
  const calls=[];
  await new SyncEngine(s,{blockedUntil:0,supportsCatalogues:false,
    async matches(id){calls.push(`list:${id}`);return{totalCount:1,matches:[{matchId:'900',data:raw}]};},
    async detail(id){calls.push(`detail:${id}`);return detailFor(raw);}
  }).run();
  assert.deepEqual(calls,['list:101','detail:900']);assert.equal(accountQueryState(s,'102').query_silent,true);
});
