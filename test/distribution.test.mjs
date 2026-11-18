import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/db.mjs';
import {RELEASE_POLICY,LOCAL_POLICY} from '../src/distribution.mjs';
import {requestLimits,reserveRequest} from '../src/request-monitor.mjs';
import {syncSchedule,syncIsDue} from '../src/sync-schedule.mjs';
import {SyncEngine} from '../src/sync.mjs';
import {createSource,OfficialSource,sourceProviders} from '../src/source-provider.mjs';
import {createApplication} from '../src/server.mjs';
import {tempDir,testStore,member} from './helpers.mjs';

test('release limits and delay ignore saved overrides; local settings and provider selection remain editable',t=>{
 for(const policy of [RELEASE_POLICY,LOCAL_POLICY]){
  const s=testStore(t,{policy});s.setting('request_limit_minute',900);s.setting('request_limit_hour',9000);s.setting('request_limit_day',90000);s.setting('request_delay_ms',1);s.setting('source_provider','batrace');
  assert.deepEqual(requestLimits(s),policy.fixed?{minute:40,hour:100,day:1000}:{minute:900,hour:9000,day:90000});
  assert.equal(s.settings().request_delay_ms,policy.fixed?2000:1);
  assert.equal(createSource(s) instanceof OfficialSource,policy.fixed);
  assert.equal(sourceProviders(policy).batrace.disabled,policy.fixed);
 }
});

test('release budgets combine both official hosts at each fixed boundary',t=>{
 const at=Date.parse('2026-11-18T18:00:00+08:00');
 for(const [window,count,since]of [['minute',40,at-1000],['hour',100,at-120000],['day',1000,at-7200000]]){
  const s=testStore(t,{policy:RELEASE_POLICY});s.transaction(()=>{for(let i=0;i<count;i++)s.run("INSERT INTO source_requests(base,resource,category,trigger,attempt,started_at,outcome) VALUES(?,?,?,?,?,?,?)",i%2?'https://api.brokenarrowgame.tech':'https://s3.brokenarrowgame.tech','/user/1','test','test',1,since,'complete');});
  const result=reserveRequest(s,'https://api.brokenarrowgame.tech','/user/2',1,at);assert.equal(result.blocked,true,window);assert(result.retryAt>at);
 }
});

test('daily random slots stay within both windows, vary by day/install, survive restart and execute once',t=>{
 const s=testStore(t,{policy:RELEASE_POLICY}),seed=s.settings().release_schedule_seed;
 assert.match(seed,/^[a-f0-9]{64}$/);
 const reopened=new Store(s.directory,{policy:RELEASE_POLICY});assert.equal(reopened.settings().release_schedule_seed,seed);reopened.close();
 const midnight=Date.parse('2026-11-18T00:00:00+08:00'),slots=[];
 let cursor=midnight;
 for(const hour of [2,14]){
  const schedule=syncSchedule(cursor,RELEASE_POLICY,seed),slot=Date.parse(schedule.next_slot_at);slots.push(slot);
  assert(slot>=midnight+hour*3600000&&slot<midnight+(hour+1)*3600000);
  assert(syncIsDue(null,slot+15000,RELEASE_POLICY,seed));
  assert(!syncIsDue(new Date(slot+1000).toISOString(),slot+30000,RELEASE_POLICY,seed));
  cursor=slot+61000;
 }
 assert.equal(new Date(slots[0]).getUTCDate(),18-1); // 02:xx Beijing is previous UTC day.
 assert(new Set(Array.from({length:8},(_,i)=>syncSchedule(midnight,RELEASE_POLICY,seed+i).next_slot_at)).size>1);
 assert(new Set(Array.from({length:8},(_,i)=>Date.parse(syncSchedule(midnight+i*86400000,RELEASE_POLICY,seed).next_slot_at)-i*86400000)).size>1);
 assert(!syncIsDue(null,midnight+4*3600000,RELEASE_POLICY,seed));
});

test('release sync cooldown starts at completion, persists on restart, blocks repeats and leaves local sync unthrottled',async t=>{
 const s=testStore(t,{policy:RELEASE_POLICY}),engine=new SyncEngine(s,{blockedUntil:0});
 let finish;engine.run=()=>new Promise(resolve=>finish=resolve);
 assert.equal(engine.request('incremental',{manual:true}).started,true);
 assert.equal(engine.request('incremental',{manual:true}).started,false);assert.equal(engine.pending,null);
 finish();await engine.active;
 const next=engine.cooldown().next_allowed_at;assert(next>=Date.now()+1799000);
 assert.equal(engine.request('full',{manual:true}).cooldown,true);
 const reopened=new Store(s.directory,{policy:RELEASE_POLICY}),again=new SyncEngine(reopened,{blockedUntil:0});
 assert.equal(again.request('incremental',{manual:true}).cooldown,true);await again.stop();reopened.close();await engine.stop();
 const local=testStore(t,{policy:LOCAL_POLICY}),localEngine=new SyncEngine(local,{blockedUntil:0});local.setting('sync_next_allowed_at',Date.now()+9999999);localEngine.run=async()=>{};
 assert.equal(localEngine.request('incremental',{manual:true}).started,true);await localEngine.active;
 assert.equal(localEngine.request('incremental',{manual:true}).started,true);await localEngine.active;await localEngine.stop();
});

test('release API rejects attempts to change fixed values and reports random schedule and persistent cooldown',async t=>{
 let app;const directory=tempDir(t,()=>app?.close());app=createApplication({directory,policy:RELEASE_POLICY,startScheduler:false,staticOutputDirectory:directory+'/site',sourceOptions:{fetcher:async()=>{throw Error('No upstream traffic');}}});
 app.store.setting('sync_enabled',false);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.server.address().port;let cookie='',csrf='';
 const request=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
 await request('/api/register','POST',{name:'Demo',username:'release-owner',password:'test-release-password'});csrf=(await request('/api/session')).data.user.csrf;
 for(const body of [{request_limit_minute:41},{request_limit_hour:101},{request_limit_day:1001},{request_delay_ms:1000}])assert.equal((await request('/api/settings','PATCH',body)).status,400);
 const status=(await request('/api/sync/status')).data;assert.equal(status.settings.sync_schedule.random,true);assert.equal(status.settings.request_delay_ms,2000);assert.deepEqual(status.request_monitor.limits,{minute:40,hour:100,day:1000});
 app.store.setting('sync_next_allowed_at',Date.now()+1800000);assert.equal((await request('/api/sync/run','POST',{})).status,429);assert.equal((await request('/api/sync/run','POST',{kind:'full'})).status,429);
 assert.equal((await request('/api/source/provider','POST',{provider:'batrace'})).status,400);
});

test('release API and report transport retain the two-second gap across a restarted client',async t=>{
 const s=testStore(t,{policy:RELEASE_POLICY}),calls=[];
 const fetcher=async()=>{calls.push(Date.now());return Response.json({id:101});};
 const first=createSource(s,{fetcher});await first.read('/user/101');
 const restarted=createSource(s,{fetcher});await restarted.reports.read('/fights/fight_1.json');
 assert(calls[1]-calls[0]>=1950);assert.equal(s.get('SELECT COUNT(*) n FROM source_requests').n,2);
});
