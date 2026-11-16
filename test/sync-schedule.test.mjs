import test from 'node:test';
import assert from 'node:assert/strict';
import {syncSchedule,syncIsDue} from '../src/sync-schedule.mjs';
import {SyncEngine} from '../src/sync.mjs';
import {testStore,member} from './helpers.mjs';
import {Store} from '../src/db.mjs';
const time=s=>Date.parse(`2026-10-${s}+08:00`);

test('Beijing daytime runs occur only at 06:00, 12:00 and 18:00 with ten-minute evenings',()=>{
  for(const [stamp,minutes,next]of [
    ['22T00:59:59',10,'2026-10-22T06:00:00+08:00'],
    ['22T01:00:00',null,'2026-10-22T06:00:00+08:00'],
    ['22T06:00:00',null,'2026-10-22T12:00:00+08:00'],
    ['22T12:00:00',null,'2026-10-22T18:00:00+08:00'],
    ['22T18:00:00',null,'2026-10-22T20:00:00+08:00'],
    ['22T19:59:59',null,'2026-10-22T20:00:00+08:00'],
    ['22T20:00:00',10,'2026-10-22T20:10:00+08:00'],
    ['22T23:59:59',10,'2026-10-23T00:00:00+08:00'],
  ]){const s=syncSchedule(time(stamp));assert.equal(s.current_minutes,minutes);assert.equal(Date.parse(s.next_slot_at),Date.parse(next));}
  for(const stamp of ['22T01:00:00','22T05:59:59','22T06:01:00','22T10:00:00','22T12:01:00','22T19:00:00'])assert(!syncIsDue(null,time(stamp)),stamp);
  for(const hour of ['06','12','18']){
    assert(syncIsDue(null,time(`22T${hour}:00:00`)));
    assert(syncIsDue(null,time(`22T${hour}:00:59`)));
    assert(!syncIsDue(`2026-10-22T${hour}:00:04+08:00`,time(`22T${hour}:00:59`)));
  }
  assert(syncIsDue('2026-10-22T19:55:00+08:00',time('22T20:00:00')));
  assert(!syncIsDue('2026-10-22T20:00:04+08:00',time('22T20:09:59')));
  assert(syncIsDue(null,time('22T20:31:00')));
});

test('a full day produces exactly three daytime checks and thirty evening checks without replay',()=>{
  const start=time('22T00:00:00'),runs=[];let last=null;
  for(let at=start;at<start+86400000;at+=15000){
    if(syncIsDue(last,at)){runs.push(at);last=new Date(at).toISOString();}
  }
  assert.equal(runs.length,33);
  assert.deepEqual(runs.filter(at=>{const hour=new Date(at+8*3600000).getUTCHours();return hour>=1&&hour<20;}).map(at=>new Date(at+8*3600000).toISOString().slice(11,16)),['06:00','12:00','18:00']);
  assert(!syncIsDue('2026-10-21T18:00:00+08:00',time('22T10:30:00')));
});

test('automatic tick uses one current slot, skips active paused and cooled-down work, and does not replay missed slots',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.setting('sync_minutes',5);
  const source={blockedUntil:0},engine=new SyncEngine(s,source),calls=[];engine.request=kind=>calls.push(kind);
  s.setting('last_sync_started','2026-10-22T02:00:00+08:00');
  await engine.tick(time('22T02:59:59'));assert.equal(calls.length,0);
  await engine.tick(time('22T20:31:00'));assert.deepEqual(calls,['incremental']);
  s.setting('last_sync_started','2026-10-22T20:31:00+08:00');
  await engine.tick(time('22T20:39:59'));assert.equal(calls.length,1);
  engine.active=Promise.resolve();await engine.tick(time('22T21:00:00'));assert.equal(calls.length,1);engine.active=null;
  s.setting('sync_enabled',false);await engine.tick(time('22T21:00:00'));assert.equal(calls.length,1);s.setting('sync_enabled',true);
  source.blockedUntil=time('22T21:01:00');await engine.tick(time('22T21:00:00'));assert.equal(calls.length,1);
  source.blockedUntil=0;await engine.tick(time('22T21:00:00'));assert.equal(calls.length,2);
});

test('persisted crawl pause survives reopening and never resumes at later schedule slots',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.setting('sync_enabled',false);
  const reopened=new Store(s.directory);let calls=0;
  const source={blockedUntil:0,matches:async()=>{calls++;throw Error('Unexpected upstream request');}};
  const engine=new SyncEngine(reopened,source);engine.request=()=>{calls++;};
  try{
    assert.equal(reopened.settings().sync_enabled,false);
    for(const stamp of ['22T19:59:59','22T20:00:00','23T00:10:00','23T12:00:00'])await engine.tick(time(stamp));
    assert.equal(calls,0);assert.equal(reopened.settings().sync_enabled,false);
  }finally{await engine.stop();reopened.close();}
});
