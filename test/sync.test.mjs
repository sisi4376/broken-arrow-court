import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,member,rawMatch,detailFor } from './helpers.mjs';
import { SyncEngine } from '../src/sync.mjs';
import { SourceClient,SourceError } from '../src/source.mjs';

test('backfill imports beyond 100 when the upstream offers more, persists progress, and does not delete old records',async t=>{
  const s=testStore(t);member(s,'A',[101]);let total=125;const calls=[];
  const source={blockedUntil:0,async matches(id,offset){calls.push(offset);return{totalCount:total,matches:Array.from({length:Math.max(0,Math.min(10,total-offset))},(_,i)=>({matchId:String(1000+offset+i),data:rawMatch()}))};},async units(){return[];}};
  const engine=new SyncEngine(s,source);await engine.run('incremental');
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,125);assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);assert(calls.includes(120));
  total=100;await engine.run('full');assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,125);
});
test('unexpected empty pages and transport failures never mark history complete or lose imported rows',async t=>{
  const s=testStore(t);member(s,'A',[101]);let fail=true;
  const source={blockedUntil:0,async matches(id,offset){if(offset>=10&&fail)throw new SourceError('offline');return{totalCount:25,matches:Array.from({length:Math.min(10,25-offset)},(_,i)=>({matchId:String(1000+offset+i),data:rawMatch()}))};},async units(){return[];}};
  const engine=new SyncEngine(s,source);await engine.run();assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,0);assert.equal(s.get('SELECT backfill_offset FROM accounts').backfill_offset,10);assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,10);
  fail=false;await engine.run('full');assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,25);
});
test('only qualifying matches are enriched and all unit instances are saved',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);const raw=rawMatch();s.ingest('800',raw);s.ingest('801',rawMatch([101,201,202,203]));const requests=[];
  const engine=new SyncEngine(s,{blockedUntil:0,async matches(){return{matches:[],totalCount:0};},async detail(id){requests.push(id);return detailFor(raw);},async units(){return[{id:238,name:'T-90M'}];}});
  await engine.run();assert.deepEqual(requests,['800']);assert.equal(s.get('SELECT detail_state FROM matches WHERE id=?','800').detail_state,'complete');assert.equal(s.get('SELECT COUNT(*) AS n FROM unit_instances').n,4);
});

test('negative AI participant IDs do not interrupt history backfill and never count as friends',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  const raw=rawMatch();raw.Data['-2']={Id:-2,Name:'Bot 0',TeamId:1};
  const source={blockedUntil:0,async matches(id,offset){return{totalCount:21,matches:Array.from({length:Math.max(0,Math.min(10,21-offset))},(_,i)=>({matchId:String(1000+offset+i),data:raw}))};},async detail(){return detailFor(raw);},async units(){return[];}};
  await new SyncEngine(s,source).run();
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,21);
  assert.equal(s.get("SELECT COUNT(*) AS n FROM accounts WHERE history_complete=1").n,3);
  assert.equal(s.get('SELECT MIN(friend_count) AS n FROM matches').n,3);
  assert.equal(s.get("SELECT COUNT(*) AS n FROM participants WHERE player_id='-2'").n,21);
  assert.equal(s.get("SELECT COUNT(*) AS n FROM matches WHERE detail_state='complete'").n,21);
});
test('429 cools down the whole source client without retrying around provider access controls',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let calls=0;const source=new SourceClient(s,{fetcher:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'120'}});}});
  await assert.rejects(source.matches('101'),/限流/);assert.equal(calls,1);assert(source.blockedUntil>Date.now()+100000);
  await assert.rejects(source.matches('101'),/冷却/);assert.equal(calls,1);
});

test('pausing after a newly discovered recent page persists a resumable history gap',async t=>{
  const s=testStore(t);member(s,'A',[101]);
  s.run('UPDATE accounts SET history_complete=1,last_full_scan=?,last_profile_sync=?',new Date().toISOString(),new Date().toISOString());
  s.ingest('900',rawMatch(),1);
  let pause=true;
  const source={blockedUntil:0,async matches(id,offset){
    if(pause){pause=false;s.setting('sync_enabled',false);}
    return{totalCount:31,matches:Array.from({length:Math.min(10,31-offset)},(_,i)=>({matchId:offset+i===30?'900':String(1000+offset+i),data:rawMatch()}))};
  },async units(){return[];}};
  const engine=new SyncEngine(s,source);await engine.run();
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,0);
  assert.equal(s.get('SELECT backfill_offset FROM accounts').backfill_offset,10);
  s.setting('sync_enabled',true);await engine.run();
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,31);
});

test('sparse historical ID pages are verified, scanned past empty pages, and missing data stays visible',async t=>{
  const s=testStore(t);member(s,'A',[101]);
  const ids=Array.from({length:35},(_,i)=>String(2000+i));
  const missing=new Set(ids.slice(12,30));const calls=[];
  const source={blockedUntil:0,async profile(){return{playerData:{info:{id:101,name:'A'},last_fights_data:ids},matchMap:{},metadata:{}};},
    async matches(id,offset){calls.push(offset);return{totalCount:ids.length,matches:ids.slice(offset,offset+10).filter(id=>!missing.has(id)).map(id=>({matchId:id,data:rawMatch()}))};},async units(){return[];}};
  const engine=new SyncEngine(s,source);await engine.run();
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,17);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_history_gaps').n,18);
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert.equal(s.get('SELECT last_error FROM accounts').last_error,null);
  assert(calls.includes(20));assert(calls.includes(30));assert(!calls.includes(12));
  assert.equal(s.get("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").status,'complete');
  assert(s.get("SELECT 1 FROM sync_events WHERE level='warning' AND message LIKE '%18 条比赛数据%'") );
  missing.clear();await engine.run('full');
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,35);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_history_gaps').n,0);
});

test('an unverified empty page or a mismatched historical index remains an error',async t=>{
  const s=testStore(t);member(s,'A',[101]);
  let invalid=false;
  const source={blockedUntil:0,async profile(){return{playerData:{info:{id:101},last_fights_data:invalid?['900']:undefined},matchMap:{}};},
    async matches(id,offset){return{totalCount:20,matches:offset===0?Array.from({length:10},(_,i)=>({matchId:String(2000+i),data:rawMatch()})):[]};},async units(){return[];}};
  const engine=new SyncEngine(s,source);await engine.run();
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,0);
  assert.match(s.get('SELECT last_error FROM accounts').last_error,/历史索引/);
  invalid=true;await engine.run('full');
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,0);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_history_gaps').n,0);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,10);
});

test('a transient empty page is re-read before recording missing IDs',async t=>{
  const s=testStore(t);member(s,'A',[101]);const ids=Array.from({length:20},(_,i)=>String(3000+i));let empty=true;
  const source={blockedUntil:0,async profile(){return{playerData:{info:{id:101},last_fights_data:ids},matchMap:{}};},
    async matches(id,offset){if(offset===10&&empty){empty=false;return{totalCount:20,matches:[]};}return{totalCount:20,matches:ids.slice(offset,offset+10).map(id=>({matchId:id,data:rawMatch()}))};},async units(){return[];}};
  await new SyncEngine(s,source).run();
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,20);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_history_gaps').n,0);
});

test('an import recovers a missing match for all affected accounts without changing friend qualification',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);
  s.run("INSERT INTO account_history_gaps VALUES(1,'800','before','before'),(2,'800','before','before')");
  s.ingest('800',rawMatch());
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_history_gaps').n,0);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_matches').n,2);
  assert.equal(s.get('SELECT friend_count FROM matches').friend_count,2);
});
