import test from 'node:test';import assert from 'node:assert/strict';
import {testStore,rawMatch,detailFor,member} from './helpers.mjs';
import {OfficialSource,createSource} from '../src/source-provider.mjs';
import {requestStatistics} from '../src/request-statistics.mjs';
import {requestMonitor} from '../src/request-monitor.mjs';
import {SyncEngine} from '../src/sync.mjs';
test('official provider reads one ID window, reuses archived games and fetches a new raw report only once across accounts',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);s.setting('source_provider','official');member(s,'A',[101]);member(s,'B',[102]);
  const known=rawMatch();s.ingest('800',known,1);s.ingest('800',known,2);
  const calls=[],raw=detailFor(rawMatch()).data;delete raw.Type;
  const source=createSource(s,{fetcher:async url=>{calls.push(url);if(url.endsWith('/last_fights'))return Response.json(['800','900']);if(url.endsWith('fight_900.json'))return Response.json(raw);throw Error('Unexpected URL '+url);}});
  let page=await source.matches('101');assert.equal(page.matches.length,2);assert.equal(page.matches[0].matchId,'900');assert.equal(page.matches[0].data.Type,0);
  await source.matches('101');await source.matches('102');await source.detail('900');assert.equal(calls.length,3);assert(calls.every(u=>!u.includes('batrace')));
  const stats=requestStatistics(s,{provider:'official'});assert.equal(stats.summary.requests,3);assert(stats.summary.bytes>0);
  await assert.rejects(source.search('nickname'),/数字 ID/);await assert.rejects(source.read('/api/units/full?unitid=1'),/目录接口/);assert.equal(calls.length,3);
});

test('official omitted Type is normal, explicit custom and skirmish survive and old local values do not override the raw report',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);
  s.ingest('900',rawMatch(undefined,{Type:1}));
  const source=new OfficialSource(s,{fetcher:async url=>{
    const raw=detailFor(rawMatch()).data;
    if(url.endsWith('fight_900.json'))delete raw.Type;
    else if(url.endsWith('fight_901.json'))raw.Type=1;
    else if(url.endsWith('fight_902.json'))raw.Type=3;
    else throw Error('Unexpected simulated URL');
    return Response.json(raw);
  }});
  const normal=await source.detail('900');assert.equal(normal.data.Type,0);assert.equal(normal.metadata.mode_defaulted,true);assert.equal(normal.metadata.mode_unknown,false);
  const custom=await source.detail('901');assert.equal(custom.data.Type,1);assert.equal(custom.metadata.mode_defaulted,false);
  const skirmish=await source.detail('902');assert.equal(skirmish.data.Type,3);assert.equal(skirmish.metadata.mode_defaulted,false);
});
test('official profile translates lifetime fields, preserves unknown values and uses local unit catalogues without fallback',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);const calls=[];
  const source=new OfficialSource(s,{fetcher:async url=>{calls.push(url);if(url.endsWith('/user/101'))return Response.json({id:101,name:'A',marketId:'market-id',rt:1500});if(url.includes('/statistic/personal/'))return Response.json({updateDate:'2026-10-27T00:00:00Z',statisticByLobbyType:{Rating:{fightsCount:5,winsCount:3,losesCount:2,totalMatchTimeSec:500}},capturedZonesCount:7});if(url.endsWith('/last_fights'))return Response.json(['9','8']);throw Error(url);}});
  const profile=await source.profile('101');assert.equal(profile.playerData.statInfo.fightsCountRt,5);assert.equal(profile.playerData.statInfo.winCountRt,3);assert.equal(profile.playerData.statInfo.fightsCountCt,undefined);assert.equal(profile.playerData.info.rating,1500);assert.deepEqual(await source.units(['1']),[]);assert.equal(calls.length,3);
});
test('official raw report refusal stops both hosts and is never retried through BATrace',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let calls=0;const source=new OfficialSource(s,{fetcher:async()=>{calls++;return new Response('',{status:403});}});
  await assert.rejects(source.detail('900'),/拒绝访问/);await assert.rejects(source.ids('101'),/冷却/);assert.equal(calls,1);
});

test('official synchronization archives full units without fetching the same report again during detail enrichment',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);member(s,'A',[101]);member(s,'B',[102]);
  const now=new Date().toISOString();for(const id of ['101','102'])s.saveProfile(id,{info:{id:Number(id)},statInfo:{updatedAt:now},last_fights_data:[]});
  s.run('UPDATE accounts SET history_complete=1,last_full_scan=?',now);const calls=[],raw=detailFor(rawMatch()).data;
  const source=new OfficialSource(s,{fetcher:async url=>{calls.push(url);if(url.endsWith('/last_fights'))return Response.json(['900']);if(url.endsWith('fight_900.json'))return Response.json(raw);throw Error('Unexpected URL '+url);}});
  await new SyncEngine(s,source).run();assert.equal(calls.length,3);assert.equal(s.get("SELECT detail_state FROM matches WHERE id='900'").detail_state,'complete');assert.equal(s.get('SELECT COUNT(*) n FROM unit_instances').n,4);assert.equal(s.get('SELECT errors FROM sync_runs').errors,0);assert.equal(s.get('SELECT requests FROM sync_runs').requests,3);
});

test('official API and report hosts share the configured request quota and monitoring total',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);s.setting('request_limit_day',2);let sent=0;
  const source=new OfficialSource(s,{fetcher:async url=>{sent++;return Response.json(url.endsWith('/last_fights')?['900']:detailFor(rawMatch()).data);}});
  await source.matches('101');assert.equal(requestMonitor(s,source.base).today,2);
  await assert.rejects(source.ids('102'),/额度已达上限/);assert.equal(sent,2);
});
