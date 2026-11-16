import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePatch121,matchPriceCatalogue,LIVE_121_AT,PRE_121_DB} from '../src/match-prices.mjs';
import {resolveUnitLoadout,publicUnitLoadout,LOADOUT_VERSION} from '../src/unit-loadouts.mjs';
import {updateUnitLoadouts} from '../src/unit-loadout-catalogue.mjs';
import {matchDetail} from '../src/queries.mjs';
import {publicMatch} from '../src/static-export.mjs';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';

const baseline=()=>({version:LOADOUT_VERSION,db_file:PRE_121_DB,version_name:'1.2.0_od',valid_until:LIVE_121_AT,
  units:{135:{id:135,base_cost:30,slots:[{id:720,name:'小队配置',options:[{id:3054,name:'标准',key:'Regular',cost:0},{id:3055,name:'狙击',key:'Stand-Off',cost:20}]}]},
    395:{id:395,base_cost:200,slots:[]},57:{id:57,base_cost:60,slots:[]}}});
const history=()=>{const old=baseline();return {price_catalogues:[old,compilePatch121(old)]};};

test('identical IDs use different equipped prices on either side of the live deployment, with frozen old values',()=>{
  const h=history(),original=JSON.stringify(h.price_catalogues[0]);
  for(const [start,end,expected]of [[LIVE_121_AT-3600,LIVE_121_AT,50],[LIVE_121_AT,LIVE_121_AT+3600,40]]){
    const c=matchPriceCatalogue(h,{start,end}),r=resolveUnitLoadout([3055],baseline().units[135],{unit_id:135,price_catalogue:c});
    assert.equal(r.cost,expected);assert.equal(r.price_version,expected===50?'1.2.0_od':'1.2.1');
    assert.equal(publicUnitLoadout(r).cost,expected);
  }
  assert.equal(JSON.stringify(h.price_catalogues[0]),original);
  assert.equal(h.price_catalogues[1].valid_until,undefined);
  assert.equal(h.price_catalogues[1].units[395].base_cost,180);
  assert.throws(()=>compilePatch121({...baseline(),db_file:'future.db'}),/1.2.0_od/);
  const bad=baseline();bad.units[135].base_cost=40;assert.throws(()=>compilePatch121(bad),/旧版基价/);
});

test('maintenance-spanning, missing, contradictory or overlapping version evidence never borrows a current price',()=>{
  const h=history();for(const interval of [{start:LIVE_121_AT-10,end:LIVE_121_AT+10},{start:null,end:LIVE_121_AT+10},{start:LIVE_121_AT+20,end:LIVE_121_AT+10}]){
    const c=matchPriceCatalogue(h,interval);assert.equal(c,null);
    const r=resolveUnitLoadout([3054],baseline().units[135],{unit_id:135,price_catalogue:c});assert.equal(r.cost,null);assert.equal(r.base_cost,null);assert(r.issues.includes('match_version_unknown'));
  }
  assert.equal(matchPriceCatalogue({},{start:1,end:2}),undefined);
  h.price_catalogues.push({...h.price_catalogues[1]});assert.equal(matchPriceCatalogue(h,{start:LIVE_121_AT+1,end:LIVE_121_AT+2}),null);
});

test('missing new IDs, changed slots and pending prices cannot resolve through an otherwise compatible old catalogue',()=>{
  const h=history(),c=h.price_catalogues[1];
  const pending=resolveUnitLoadout([],baseline().units[57],{unit_id:57,price_catalogue:c,history:h});
  assert.equal(pending.cost,null);assert.equal(pending.base_cost,null);assert(pending.issues.includes('version_catalogue_pending'));
  const unknown=resolveUnitLoadout([999],baseline().units[135],{unit_id:135,price_catalogue:c,history:{catalogues:[{units:{135:{id:135,base_cost:999,slots:[{id:1,options:[{id:999,cost:0}]}]}}}]}});
  assert.equal(unknown.cost,null);assert.equal(unknown.options[0].cost,null);
});

test('queries and public snapshots bind prices to match start/end rather than import date or current unit catalogue',t=>{
  const s=testStore(t);member(s,'A',[101]);const old=baseline(),h=history();
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadouts',JSON.stringify(old),'now');
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadout_history',JSON.stringify(h),'now');
  for(const [i,end,expected]of [[1,LIVE_121_AT-1,50],[2,LIVE_121_AT+7200,40]]){
    const raw=rawMatch(undefined,{EndTime:end});s.ingest(String(i),raw);const d=detailFor(raw);
    for(const p of Object.values(d.data.Data))for(const u of Object.values(p.UnitData)){u.Id=135;u.OptionIds=[3055];}
    s.saveDetail(String(i),d);const m=matchDetail(s,i);assert.equal(m.units[0].loadout.cost,expected);
    assert.equal(publicMatch(m).units[0].loadout.cost,expected);
  }
  s.run("UPDATE analysis_catalogue SET data_json=? WHERE key='unit_loadouts'",JSON.stringify({units:{135:{...old.units[135],base_cost:999}},db_file:'future.db'}));
  assert.equal(matchDetail(s,1).units[0].loadout.cost,50);assert.equal(matchDetail(s,2).units[0].loadout.cost,40);
});

test('catalogue refresh archives the previous full release and fills only the exact new release while keeping old match prices',async t=>{
  const s=testStore(t);member(s,'A',[101]);const raw=rawMatch();s.ingest('800',raw);const d=detailFor(raw);
  for(const p of Object.values(d.data.Data))for(const u of Object.values(p.UnitData)){u.Id=135;u.OptionIds=[3054];}s.saveDetail('800',d);
  const old=baseline();s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadouts',JSON.stringify(old),'now');
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadout_history',JSON.stringify(history()),'now');
  const source={async read(url){if(url==='/api/dek/db-version')return {dbFileName:'new.db',versionName:'1.2.1'};return {unit:{id:135,cost:40,modifications:[{id:720,name:'小队配置',options:[{id:3054,name:'标准',cost:0},{id:3055,name:'狙击',cost:0}]}]}};}};
  await updateUnitLoadouts(s,source,{force:true});
  const h=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);
  assert.equal(h.catalogues.find(c=>c.db_file===PRE_121_DB).units[135].base_cost,30);
  assert.equal(h.price_catalogues[0].units[135].base_cost,30);
  assert.equal(h.price_catalogues[1].units[135].base_cost,40);assert.equal(h.price_catalogues[1].units[135].price_source,'catalogue');
  const snapshot=JSON.stringify(h.price_catalogues);
  source.read=async url=>url==='/api/dek/db-version'?{dbFileName:'future.db',versionName:'1.2.2'}:{unit:{id:135,cost:999,modifications:[]}};
  await updateUnitLoadouts(s,source,{force:true});
  const after=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);
  assert.equal(JSON.stringify(after.price_catalogues),snapshot);
});
