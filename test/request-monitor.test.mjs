import test from 'node:test';
import assert from 'node:assert/strict';
import {testStore} from './helpers.mjs';
import {Store} from '../src/db.mjs';
import {SourceClient} from '../src/source.mjs';
import {requestMonitor,reserveRequest,finishRequest,sourceDayStart,withRequestContext} from '../src/request-monitor.mjs';

test('network attempts persist before sending, retries and failures count, cache hits do not',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let sent=0;
  const source=new SourceClient(s,{base:'https://audit.example',fetcher:async()=>{
    const row=s.get('SELECT * FROM source_requests ORDER BY id DESC LIMIT 1');
    assert.equal(row.outcome,'pending');assert.equal(row.finished_at,null);
    assert.equal(s.get('SELECT COUNT(*) n FROM source_requests').n,++sent);
    return sent===1?new Response('',{status:500}):Response.json({dbFileName:'v1.db'});
  }});
  await withRequestContext({run_id:42,trigger:'自动同步'},()=>source.read('/api/dek/db-version'));
  await new SourceClient(s,{base:source.base,fetcher:()=>{throw Error('cache must prevent network');}}).read('/api/dek/db-version');
  const m=requestMonitor(s,source.base);
  assert.equal(m.total,2);assert.equal(m.today,2);assert.equal(m.errors_today,1);assert.equal(m.retries_today,1);
  assert.deepEqual(m.recent.map(r=>r.status),[200,500]);assert(m.recent.every(r=>r.run_id===42&&r.finished_at!==null));
  assert.equal(m.repeated[0].requests,2);
});

test('shared persistent limits block independent clients and survive restart without sending',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);s.setting('request_limit_minute',2);let sent=0;
  const options={base:'https://audit.example',fetcher:async()=>{sent++;return Response.json({});}};
  const reopened=new Store(s.directory,{policy:s.policy});
  try {
  const a=new SourceClient(s,options),b=new SourceClient(reopened,options);
  await Promise.all([a.read('/first'),b.read('/second')]);
  await assert.rejects(a.read('/blocked'),/额度已达上限/);
  await assert.rejects(new SourceClient(reopened,options).read('/after-restart'),/冷却/);
  assert.equal(sent,2);const m=requestMonitor(s,options.base);
  assert.equal(m.total,2);assert.equal(m.blocked_today,1);assert(m.latest_block.retry_at>Date.now());
  } finally { reopened.close(); }
});

test('rolling minute/hour and UTC+8 daily windows count unfinished attempts conservatively',t=>{
  const s=testStore(t),base='https://audit.example',at=Date.parse('2026-10-27T23:59:59+08:00');
  s.setting('request_limit_day',1);
  assert(reserveRequest(s,base,'/first',1,at).id);
  assert(reserveRequest(s,base,'/blocked',1,at+1).blocked);
  const next=at+2000,m=requestMonitor(s,base,next);
  assert.equal(m.today,0);assert.equal(m.hour,1);assert.equal(m.minute,1);assert.equal(m.total,1);
  assert.equal(new Date(sourceDayStart(next)).toISOString(),'2026-10-27T16:00:00.000Z');
  assert(reserveRequest(s,base,'/new-day',1,next).id);
  s.setting('request_limit_day',1000);
  s.setting('request_limit_hour',2);
  assert(reserveRequest(s,base,'/hour-blocked',1,next+1).blocked);
  assert(reserveRequest(s,base,'/later',1,next+3600001).id);
});

test('redirects cannot hide additional network requests and logging failure prevents transmission',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let sent=0;
  const source=new SourceClient(s,{fetcher:async(url,options)=>{
    sent++;assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{location:'https://elsewhere.example'}});
  }});
  await assert.rejects(source.read('/redirect'),/302/);assert.equal(sent,1);
  assert.equal(requestMonitor(s,source.base).recent[0].status,302);
  s.db.exec('DROP TABLE source_requests');
  await assert.rejects(source.read('/cannot-record'),/no such table/);assert.equal(sent,1);
});

test('requests outside a sync context are recorded separately',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);
  const source=new SourceClient(s,{fetcher:async()=>Response.json({players:[]})});
  await source.search('person');const m=requestMonitor(s,source.base);
  assert.equal(m.total,1);assert.equal(m.recent[0].run_id,null);assert.equal(m.recent[0].category,'玩家搜索');
});

test('daily request counts and response sizes split at Beijing midnight, retain empty days and isolate providers',t=>{
  const s=testStore(t),base='https://daily.example',at=Date.parse('2026-10-27T00:00:10+08:00');
  const older=reserveRequest(s,base,'/old',1,at-31*86400000);finishRequest(s,older.id,{status:200,bytes:300});
  const yesterday=reserveRequest(s,base,'/yesterday',1,at-11000);finishRequest(s,yesterday.id,{status:200,bytes:1024});
  const today=reserveRequest(s,base,'/today',1,at-5000);finishRequest(s,today.id,{status:200,bytes:2048});
  const retry=reserveRequest(s,base,'/today',2,at-4000);finishRequest(s,retry.id,{status:500,bytes:128,error:'server error'});
  reserveRequest(s,base,'/unfinished',1,at-3000);
  const unrelated=reserveRequest(s,'https://other.example','/other',1,at);finishRequest(s,unrelated.id,{status:200,bytes:999999});
  const m=requestMonitor(s,base,at);
  assert.equal(m.daily.length,30);assert.equal(m.today,3);assert.equal(m.bytes_today,2176);assert.equal(m.bytes_total,3500);
  assert.deepEqual(m.daily[0],{date:'2026-10-27',requests:3,bytes:2176,errors:1,pending:1});
  assert.deepEqual(m.daily[1],{date:'2026-10-26',requests:1,bytes:1024,errors:0,pending:0});
  assert.deepEqual(m.daily[2],{date:'2026-10-25',requests:0,bytes:0,errors:0,pending:0});
  assert.equal(m.total,5);assert.equal(m.daily.reduce((n,d)=>n+d.requests,0),4);
});
