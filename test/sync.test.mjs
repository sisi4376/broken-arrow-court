import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,member,rawMatch,detailFor,airUnit } from './helpers.mjs';
import { SyncEngine, SYNC_POLICY } from '../src/sync.mjs';
import { SourceClient,SourceError } from '../src/source.mjs';

test('manual incremental and full runs archive and enrich while automatic sync stays disabled',async t=>{
  for(const kind of ['incremental','full'])await t.test(kind,async t=>{
    const s=testStore(t);member(s,'A',[101]);s.setting('sync_enabled',false);
    const pages=[],details=[],raw=rawMatch();
    const source={blockedUntil:0,async matches(id,offset){pages.push(offset);return{totalCount:25,matches:Array.from({length:Math.min(10,25-offset)},(_,i)=>({matchId:String(5000+offset+i),data:raw}))};},async detail(id){details.push(id);return detailFor(raw);},async units(){return[{id:238}];}};
    const engine=new SyncEngine(s,source);
    engine.request(kind,{manual:true});await engine.active;
    assert.deepEqual(pages,[0,10,20]);assert.equal(details.length,25);
    assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,25);
    assert.equal(s.get("SELECT COUNT(*) n FROM matches WHERE detail_state='complete'").n,25);
    assert.equal(s.get('SELECT status FROM sync_runs').status,'complete');
    assert.equal(s.settings().sync_enabled,false);
    await engine.tick(Date.parse('2026-10-28T04:00:00Z'));
    assert.equal(s.get('SELECT COUNT(*) n FROM sync_runs').n,1);
    assert.deepEqual(pages,[0,10,20]);
  });
});

test('queued manual work runs once while automatic sync is disabled and keeps full priority',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.setting('sync_enabled',false);
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});let calls=0;
  const engine=new SyncEngine(s,{blockedUntil:0,async matches(){if(++calls===1){entered();await gate;}return{totalCount:1,matches:[{matchId:'800',data:rawMatch()}]};}});
  engine.request('incremental',{manual:true});const first=engine.active;await started;
  assert.equal(engine.request('incremental',{manual:true}).queued,true);
  engine.request('full',{manual:true});
  assert.equal(engine.pending,'full');assert.equal(engine.pendingManual,true);
  release();await first;await engine.active;
  assert.deepEqual(s.all('SELECT kind,status FROM sync_runs ORDER BY id').map(row=>({...row})),[{kind:'incremental',status:'complete'},{kind:'full',status:'complete'}]);
  assert.equal(calls,2);assert.equal(s.settings().sync_enabled,false);assert.equal(engine.pending,null);
});

test('stopping the engine still interrupts a manual history scan',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.setting('sync_enabled',false);let calls=0;
  const engine=new SyncEngine(s,{blockedUntil:0,async matches(){calls++;engine.stopped=true;return{totalCount:25,matches:Array.from({length:10},(_,i)=>({matchId:String(6000+i),data:rawMatch()}))};}});
  engine.request('full',{manual:true});await engine.active;
  assert.equal(calls,1);assert.equal(s.get('SELECT status FROM sync_runs').status,'paused');
  assert.equal(s.settings().sync_enabled,false);
});

test('sync notifies publication only after the last queued round becomes idle',async t=>{
  const s=testStore(t);let notifications=0;const rounds=[];
  const engine=new SyncEngine(s,{}, {onIdle:()=>{assert.equal(engine.active,null);assert.equal(engine.current,null);notifications++;}});
  engine.run=()=>new Promise(resolve=>rounds.push(resolve));
  engine.request();const first=engine.active;engine.request('full');
  rounds[0]();await first;assert.equal(notifications,0);assert.equal(rounds.length,2);
  const second=engine.active;rounds[1]();await second;assert.equal(notifications,1);
  engine.onIdle=()=>{throw Error('Publication unavailable');};engine.request();rounds[2]();await engine.active;
  assert.match(s.get("SELECT message FROM sync_events ORDER BY id DESC LIMIT 1").message,/同步后发布检查失败/);
  engine.request();const last=engine.active;const stopping=engine.stop();rounds[3]();await last;await stopping;
  assert.equal(notifications,1);
});

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
test('qualifying and registered personal games are enriched, unrelated games are excluded and all instances are saved',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);const raw=rawMatch(),solo=rawMatch([101,201,202,203]);s.ingest('800',raw);s.ingest('801',solo);s.ingest('802',rawMatch([201,202,203,204]));const requests=[];
  const engine=new SyncEngine(s,{blockedUntil:0,async matches(){return{matches:[],totalCount:0};},async detail(id,options){requests.push(id);assert.equal(options.minDelay,id==='801'?5000:0);return detailFor(id==='801'?solo:raw);},async units(){return[{id:238,name:'T-90M'}];}});
  await engine.run();assert.deepEqual(requests,['800','801']);assert.equal(s.get('SELECT detail_state FROM matches WHERE id=?','801').detail_state,'complete');assert.equal(s.get('SELECT COUNT(*) AS n FROM unit_instances').n,8);assert.equal(s.get('SELECT friend_count FROM matches WHERE id=?','801').friend_count,1);
});

test('sync automatically persists the actual-loadout catalogue after discovering a new aircraft',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  const raw=rawMatch(),detail=detailFor(raw),calls=[];
  for(const p of Object.values(detail.data.Data))for(const u of Object.values(p.UnitData)){u.Id=900;u.OptionIds=[100,200];}
  s.ingest('800',raw);
  const source={blockedUntil:0,async matches(){return{matches:[],totalCount:0};},async detail(){return detail;},async units(){return[{id:900,role:164}];},
    async read(url){calls.push(url);return url==='/api/dek/db-version'?{dbFileName:'test.db',versionId:'v1'}:{unit:airUnit()};}};
  const engine=new SyncEngine(s,source);await engine.run();
  const model=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'").data_json);
  assert.equal(model.db_file,'test.db');assert.equal(model.units['900'].modifications[0].options[0].id,100);
  assert.deepEqual(calls,['/api/dek/db-version','/api/units/full?unitid=900&db_file=test.db','/api/dek/db-version','/api/units/full?unitid=900&db_file=test.db']);
  assert(JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadouts'").data_json).units['900']);
  assert.equal(s.get('SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1').status,'complete');
  await engine.run();assert.equal(calls.length,4);
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

test('recent and backfill share pages and one freshly fetched profile, while sparse pages still get verified',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.run('UPDATE accounts SET last_profile_sync=NULL');
  const ids=Array.from({length:25},(_,i)=>String(4000+i)),calls=[];let profiles=0;
  const source={blockedUntil:0,async profile(){profiles++;return{playerData:{info:{id:101},last_fights_data:ids},matchMap:{}};},
    async matches(id,offset){calls.push(offset);return{totalCount:25,matches:ids.slice(offset,offset+10).filter(id=>id!=='4015').map(id=>({matchId:id,data:rawMatch()}))};}};
  await new SyncEngine(s,source).run();
  assert.deepEqual(calls,[0,10,10,20]);assert.equal(profiles,1);
  assert.equal(s.get('SELECT COUNT(*) n FROM account_history_gaps').n,1);
  assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,24);
});

test('scheduled checks ignore legacy idle delays after restart and retain error cooldowns',async t=>{
  const s=testStore(t);member(s,'A',[101]);let id='800',requests=0;
  const source={base:'https://source.example',blockedUntil:0,async matches(){requests++;return{totalCount:1,matches:[{matchId:id,data:rawMatch()}]};}};
  const key='source_poll:https://source.example:101';
  await new SyncEngine(s,source).run('incremental',{scheduled:true});assert.equal(requests,1);
  s.setting(key,{...s.settings()[key],idle_rounds:6,next_check:Date.now()+2*3600000});
  const engine=new SyncEngine(s,source);await engine.run('incremental',{scheduled:true});assert.equal(requests,2);
  assert.deepEqual(s.settings()[key],{head:JSON.stringify([1,['800']])});
  s.run('UPDATE accounts SET next_retry=?',new Date(Date.now()+3600000).toISOString());
  await engine.run('incremental',{scheduled:true});assert.equal(requests,2);
  s.run('UPDATE accounts SET next_retry=NULL');
  id='801';await engine.run('incremental',{scheduled:true});assert.equal(requests,3);
  assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,2);
});

test('completed old archives never rescan automatically, including an interrupted old rescan',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch(),1);
  s.saveProfile('101',{info:{id:101},statInfo:{}});
  s.run("UPDATE accounts SET history_complete=0,backfill_offset=40,backfill_total=100,last_full_scan='2020-01-01T00:00:00Z',last_profile_sync='2020-01-01T00:00:00Z'");
  const calls=[];let profiles=0;
  const source={blockedUntil:0,async matches(id,offset){calls.push(offset);return{totalCount:100,matches:[{matchId:'800',data:rawMatch()}]};},async profile(){profiles++;throw Error('unchanged accounts need no profile');}};
  await new SyncEngine(s,source).run();
  assert.deepEqual(calls,[0]);assert.equal(profiles,0);assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert.equal(s.get('SELECT last_full_scan FROM accounts').last_full_scan,'2020-01-01T00:00:00Z');
  assert.equal(s.get('SELECT errors FROM sync_runs').errors,0);
});

test('unchanged accounts are checked at all 25 ten-minute slots across engine restarts',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch(),1);
  s.run("UPDATE accounts SET history_complete=1,last_full_scan='2020-01-01T00:00:00Z'");
  const start=Date.now();let at=start,calls=0;
  t.mock.method(Date,'now',()=>at);
  const key='source_poll:https://idle.example:101';
  s.setting(key,{head:JSON.stringify([1,['800']]),idle_rounds:6,next_check:0});
  const source={base:'https://idle.example',blockedUntil:0,async matches(){calls++;return{totalCount:1,matches:[{matchId:'800',data:rawMatch()}]};}};
  for(let slot=0;slot<25;slot++){
    at=start+slot*10*60000;
    await new SyncEngine(s,source).run('incremental',{scheduled:true});
  }
  assert.equal(calls,25);assert.deepEqual(s.settings()[key],{head:JSON.stringify([1,['800']])});
});

test('recent sync imports several pages of new games then stops at known games without old backfill',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch(),1);
  s.run("UPDATE accounts SET history_complete=1,last_full_scan='2020-01-01T00:00:00Z'");
  const ids=[...Array.from({length:23},(_,i)=>String(1000+i)),'800',...Array.from({length:76},(_,i)=>String(2000+i))],calls=[];
  for(const id of ids.slice(24))s.ingest(id,rawMatch(),1);
  const source={blockedUntil:0,async matches(id,offset){calls.push(offset);return{totalCount:100,matches:ids.slice(offset,offset+10).map(matchId=>({matchId,data:rawMatch()}))};}};
  await new SyncEngine(s,source).run();
  assert.deepEqual(calls,[0,10,20,30]);
  assert.equal(s.get("SELECT COUNT(*) n FROM matches WHERE id BETWEEN '1000' AND '1022'").n,23);
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert.equal(s.get('SELECT imported FROM sync_runs').imported,23);
});

test('incremental history has a bounded budget and resumes without skipping the next page',async t=>{
  const s=testStore(t);member(s,'A',[101]);const calls=[],total=235;
  const source={blockedUntil:0,async matches(id,offset){calls.push(offset);return{totalCount:total,matches:Array.from({length:Math.min(10,total-offset)},(_,i)=>({matchId:String(5000+offset+i),data:rawMatch()}))};}};
  const engine=new SyncEngine(s,source);await engine.run();
  assert.equal(calls.length,SYNC_POLICY.backfillPages);assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,0);
  assert.equal(s.get('SELECT backfill_offset FROM accounts').backfill_offset,200);
  await engine.run('incremental',{scheduled:true});
  assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,total);assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert(calls.includes(200));assert(calls.includes(230));
});

test('personal details have a small per-round budget and complete reports are never re-fetched',async t=>{
  const s=testStore(t);member(s,'A',[101]);const raw=rawMatch([101,201,202,203]);
  for(let i=0;i<15;i++)s.ingest(String(6000+i),raw);
  const calls=[],source={blockedUntil:0,async matches(){return{totalCount:0,matches:[]};},async detail(id){calls.push(id);return detailFor(raw);},async units(){return[{id:238}];}};
  const engine=new SyncEngine(s,source);await engine.run();assert.equal(calls.length,SYNC_POLICY.personalDetailLimit);
  await engine.run();assert.equal(calls.length,15);assert.equal(new Set(calls).size,15);
});

test('old accounts stop on the page that reconnects to the previous completed check',async t=>{
  for (const added of [0,1,9,10,11,19,23]) {
    const s=testStore(t);member(s,'A',[101]);
    const old=Array.from({length:100},(_,i)=>String(8000+i));
    for(const id of old)s.ingest(id,rawMatch(),1);
    s.run("UPDATE accounts SET history_complete=1,last_full_scan='2020-01-01T00:00:00Z'");
    // Exercise migration from the existing saved poll, with no new checkpoint yet.
    s.setting('source_poll:default:101',{head:JSON.stringify([100,old.slice(0,10)])});
    const ids=[...Array.from({length:added},(_,i)=>String(9000+i)),...old],calls=[];
    const source={blockedUntil:0,async matches(id,offset){calls.push(offset);return{totalCount:ids.length,matches:ids.slice(offset,offset+10).map(matchId=>({matchId,data:rawMatch()}))};}};
    await new SyncEngine(s,source).run();
    assert.equal(calls.length,Math.floor(added/10)+1,`${added} new matches`);
    assert.equal(s.get('SELECT imported FROM sync_runs').imported,added);
    assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
    assert.deepEqual(s.settings()['recent_boundary:default:101'],ids.slice(0,10));
  }
});

test('an incidental known match does not stop catch-up before the saved boundary',async t=>{
  const s=testStore(t);member(s,'A',[101]);
  const old=Array.from({length:30},(_,i)=>String(8000+i));
  for(const id of old)s.ingest(id,rawMatch(),1);
  s.run("UPDATE accounts SET history_complete=1,last_full_scan='2020-01-01T00:00:00Z'");
  s.setting('recent_boundary:default:101',old.slice(0,10));
  const fresh=Array.from({length:15},(_,i)=>String(9000+i));
  for(const id of fresh.slice(0,10))s.ingest(id,rawMatch(),1);
  const ids=[...fresh,...old],calls=[];
  const source={blockedUntil:0,async matches(id,offset){calls.push(offset);return{totalCount:ids.length,matches:ids.slice(offset,offset+10).map(matchId=>({matchId,data:rawMatch()}))};}};
  await new SyncEngine(s,source).run();
  assert.deepEqual(calls,[0,10]);
  assert.equal(s.get('SELECT imported FROM sync_runs').imported,5);
});

test('a paused catch-up retains its boundary across restart and new head insertions',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('8000',rawMatch(),1);
  s.run("UPDATE accounts SET history_complete=1,last_full_scan='2020-01-01T00:00:00Z'");
  s.setting('recent_boundary:default:101',['8000']);
  let ids=[...Array.from({length:23},(_,i)=>String(9000+i)),'8000'],pause=true;
  const calls=[],source={blockedUntil:0,async matches(id,offset){
    calls.push(offset);if(pause){pause=false;s.setting('sync_enabled',false);}
    return{totalCount:ids.length,matches:ids.slice(offset,offset+10).map(matchId=>({matchId,data:rawMatch()}))};
  }};
  await new SyncEngine(s,source).run();
  assert.deepEqual(s.settings()['recent_boundary:default:101'],['8000']);
  ids=['9999',...ids];calls.length=0;s.setting('sync_enabled',true);
  await new SyncEngine(s,source).run();
  assert.deepEqual(calls,[0,10,20]);
  assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,25);
  assert.equal(s.get('SELECT history_complete FROM accounts').history_complete,1);
  assert.deepEqual(s.settings()['recent_boundary:default:101'],ids.slice(0,10));
});

test('a profile fetched to verify a short recent page is reused without another calibration request',async t=>{
  const s=testStore(t);member(s,'A',[101]);
  const ids=Array.from({length:10},(_,i)=>String(9000+i));
  for(const id of ids.slice(1))s.ingest(id,rawMatch(),1);
  s.run("UPDATE accounts SET history_complete=1,last_full_scan='2020-01-01T00:00:00Z',last_profile_sync='2020-01-01T00:00:00Z'");
  const calls=[],source={blockedUntil:0,
    async profile(){calls.push('profile');return{playerData:{info:{id:101},last_fights_data:ids},matchMap:{}};},
    async matches(id,offset,{force=false}={}){calls.push(force?'confirm':'page');return{totalCount:10,matches:ids.slice(0,9).map(matchId=>({matchId,data:rawMatch()}))};}
  };
  await new SyncEngine(s,source).run();
  assert.deepEqual(calls,['page','profile','confirm']);
  assert.equal(s.get('SELECT imported FROM sync_runs').imported,1);
  assert.equal(s.get('SELECT errors FROM sync_runs').errors,0);
});

test('lifetime calibration runs only after seven to ten days and manual full history does not bypass its period',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch(),1);
  s.run('UPDATE accounts SET history_complete=1,last_full_scan=?',new Date().toISOString());
  s.saveProfile('101',{info:{id:101},last_fights_data:['800'],statInfo:{fightsCountRt:1}});
  let profiles=0;
  const source={blockedUntil:0,async matches(){return{totalCount:1,matches:[{matchId:'800',data:rawMatch()}]};},async profile(){profiles++;return{playerData:{info:{id:101},last_fights_data:['800'],statInfo:{fightsCountRt:1}},metadata:{},matchMap:{}};}};
  const engine=new SyncEngine(s,source);
  s.run('UPDATE profiles SET updated_at=?',new Date(Date.now()-7*86400000).toISOString());
  await engine.run();await engine.run('full');assert.equal(profiles,0);
  s.run('UPDATE profiles SET updated_at=?',new Date(Date.now()-8*86400000-1000).toISOString());
  await engine.run();assert.equal(profiles,1);
  await engine.run();assert.equal(profiles,1);
});

test('failed lifetime calibration keeps the baseline and waits an hour before another attempt',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch(),1);
  s.run('UPDATE accounts SET history_complete=1,last_full_scan=?',new Date().toISOString());
  s.saveProfile('101',{info:{id:101},statInfo:{fightsCountRt:100}});
  s.run('UPDATE profiles SET updated_at=?',new Date(Date.now()-11*86400000).toISOString());
  let profiles=0;
  const source={blockedUntil:0,async matches(){return{totalCount:1,matches:[{matchId:'800',data:rawMatch()}]};},async profile(){profiles++;throw Error('offline');}};
  await new SyncEngine(s,source).run();await new SyncEngine(s,source).run();
  assert.equal(profiles,1);assert.equal(JSON.parse(s.get('SELECT data_json FROM profiles').data_json).statInfo.fightsCountRt,100);
  assert(s.settings()['profile_calibration_retry:default:101']>Date.now()+3500000);
});
