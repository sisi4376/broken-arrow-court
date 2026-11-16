import test from 'node:test';
import assert from 'node:assert/strict';
import {testStore} from './helpers.mjs';
import {SourceClient} from '../src/source.mjs';
import {updateAirCatalogue} from '../src/air-superiority.mjs';
import {updateUnitLoadouts} from '../src/unit-loadout-catalogue.mjs';
import {member,rawMatch,detailFor} from './helpers.mjs';

test('catalogue TTL survives new clients, expires by successful check time, and is isolated by provider',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let requests=0;
  const options={base:'https://one.example',fetcher:async()=>{requests++;return Response.json({dbFileName:'v1.db'});}};
  const first=new SourceClient(s,options);
  await first.read('/api/dek/db-version');
  await new SourceClient(s,options).read('/api/dek/db-version');assert.equal(requests,1);
  s.run('UPDATE source_cache SET checked_at=0');
  await new SourceClient(s,options).read('/api/dek/db-version');
  await new SourceClient(s,options).read('/api/dek/db-version');assert.equal(requests,2);
  assert(s.get('SELECT checked_at FROM source_cache').checked_at>Date.now()-1000);
  await new SourceClient(s,{...options,base:'https://two.example'}).read('/api/dek/db-version');assert.equal(requests,3);
  await new SourceClient(s,options).read('/api/dek/db-version',{force:true});assert.equal(requests,4);
  // Identical source snapshots keep their original archival date; cache freshness is independent.
  assert.equal(s.get('SELECT COUNT(*) n FROM source_snapshots').n,1);
});

test('parallel readers coalesce and aircraft and unit catalogues reuse one versioned response',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let requests=0;
  const source=new SourceClient(s,{fetcher:async()=>{requests++;return Response.json({unit:{id:900}});}});
  const url='/api/units/full?unitid=900&db_file=v1.db';
  const [a,b]=await Promise.all([source.read(url),source.read(url)]);
  a.unit.id=1;assert.equal(b.unit.id,900);assert.equal(requests,1);
  assert.equal((await new SourceClient(s,{fetcher:()=>{throw Error('unexpected request');}}).read(url)).unit.id,900);
  await source.read('/api/units/full?unitid=900&db_file=v2.db');assert.equal(requests,2);
});

test('head pages have a persistent two-minute cache, older pages and explicit verification remain fresh',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let requests=0;
  const source=new SourceClient(s,{fetcher:async()=>{requests++;return Response.json({matches:[],totalCount:0});}});
  await source.matches('101');await new SourceClient(s,{fetcher:source.fetcher}).matches('101');assert.equal(requests,1);
  s.run('UPDATE source_cache SET checked_at=?',Date.now()-120001);
  await source.matches('101');assert.equal(requests,2);
  await source.matches('101',0,{force:true});assert.equal(requests,3);
  await source.matches('101',10);await source.matches('101',10);assert.equal(requests,5);
  await source.read('/api/dek/db-version');await source.read('/api/dek/db-version');assert.equal(requests,7);
  assert.equal(s.get('SELECT COUNT(*) n FROM source_cache').n,1);
  source.fetcher=async()=>{requests++;return new Response('',{status:404});};
  await assert.rejects(source.read('/missing'));await assert.rejects(source.read('/missing'));assert.equal(requests,9);
});

test('provider cooldown survives restart, honors longer Retry-After, and does not block other providers',async t=>{
  const s=testStore(t);s.setting('request_delay_ms',0);let requests=0;
  const options={base:'https://one.example',fetcher:async()=>{requests++;return new Response('',{status:429,headers:{'retry-after':'7200'}});}};
  const alreadyOpen=new SourceClient(s,options);
  await assert.rejects(new SourceClient(s,options).matches('101'),/限流/);
  const restored=new SourceClient(s,options);
  assert(restored.blockedUntil>Date.now()+7100000);
  await assert.rejects(restored.matches('101'),/冷却/);assert.equal(requests,1);
  await assert.rejects(alreadyOpen.matches('101'),/冷却/);assert.equal(requests,1);
  assert.equal(new SourceClient(s,{...options,base:'https://two.example'}).blockedUntil,0);
});

test('failed version discovery is cooled down for both catalogue importers',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch());s.saveDetail('800',detailFor(rawMatch()));
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,role:164}),'now');
  let requests=0;const source={async read(){requests++;throw Error('version unavailable');}};
  for(const [update,key] of [[updateAirCatalogue,'air_superiority_model'],[updateUnitLoadouts,'unit_loadouts']]){
    await assert.rejects(update(s,source),/version unavailable/);
    const before=requests;await update(s,source);assert.equal(requests,before);
    assert(JSON.parse(s.get('SELECT data_json FROM analysis_catalogue WHERE key=?',key).data_json).last_error_at);
  }
});
