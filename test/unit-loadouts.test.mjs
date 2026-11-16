import test from 'node:test';
import assert from 'node:assert/strict';
import {compileUnitLoadout,resolveUnitLoadout,publicUnitLoadout} from '../src/unit-loadouts.mjs';
import {updateUnitLoadouts} from '../src/unit-loadout-catalogue.mjs';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
import {matchDetail} from '../src/queries.mjs';
import {publicMatch} from '../src/static-export.mjs';

const unit=()=>({id:238,cost:100,modifications:[{id:1,name:'Armor',uiName:'CUSTOM_ARMOR',options:[{id:11,name:'Base',cost:0},{id:12,name:'Extra armor',uiName:'CUSTOM_EXTRA',cost:25}]},{id:2,name:'Weapon',options:[{id:21,name:'None',cost:-5},{id:22,name:'Missile',cost:30}]}]});
test('loadout price uses only actual selected options including zero/negative costs, translated names and slot order',()=>{
  const u=unit(),c=compileUnitLoadout(u,{custom_armor:'装甲',custom_extra:'附加装甲'}),original=JSON.stringify(c);
  const r=resolveUnitLoadout([21,12],c,{db_file:'v1.db'});
  assert.equal(r.cost,120);assert.equal(r.base_cost,100);assert.equal(r.status,'complete');
  assert.deepEqual(r.options.map(o=>[o.slot,o.name,o.cost]),[['装甲','附加装甲',25],['Weapon','None',-5]]);
  assert.equal(resolveUnitLoadout([11,22],c).cost,130);assert.equal(JSON.stringify(c),original);
});
test('missing/unknown/duplicate/conflicting selections and missing costs never get an invented equipped price',()=>{
  const c=compileUnitLoadout(unit());
  for(const ids of [null,undefined,[12],[12,12,21],[11,12,21],[12,21,999],['12',21]])assert.equal(resolveUnitLoadout(ids,c).cost,null,JSON.stringify(ids));
  assert.equal(resolveUnitLoadout([],compileUnitLoadout({id:1,cost:55,modifications:[]})).cost,55);
  assert.equal(resolveUnitLoadout([12,21],null).cost,null);
  const bad=unit();bad.modifications[0].options[1].cost=null;assert.equal(resolveUnitLoadout([12,21],compileUnitLoadout(bad)).cost,null);
  bad.cost=null;assert.equal(resolveUnitLoadout([],compileUnitLoadout(bad)).cost,null);
  assert.equal(resolveUnitLoadout([999],c).options[0].name,'挂载 #999');
});
test('public loadouts expose only selected display fields, with identical price and names',()=>{
  const r=resolveUnitLoadout([12,21],compileUnitLoadout(unit()));r.private='SECRET';r.options[0].token='SECRET';
  const projected=publicUnitLoadout(r);assert.equal(projected.cost,r.cost);assert.equal(projected.options[0].name,r.options[0].name);assert(!JSON.stringify(projected).includes('SECRET'));
  assert.equal(publicUnitLoadout(null),null);assert.equal(publicUnitLoadout({...r,cost:Infinity}).cost,null);
});
test('catalogue update is resumable, reuses same-version source snapshots, persists names and projects match details',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);const raw=rawMatch();s.ingest('800',raw);
  const d=detailFor(raw);for(const p of Object.values(d.data.Data))for(const u of Object.values(p.UnitData))u.OptionIds=[12,21];s.saveDetail('800',d);
  s.snapshot('/api/units/full?unitid=238&db_file=v1.db',{unit:unit()});const calls=[];
  const source={async read(url){calls.push(url);if(url==='/api/dek/db-version')return {dbFileName:'v1.db'};throw Error('unexpected fetch');}};
  await updateUnitLoadouts(s,source,{translations:{custom_extra:'附加装甲'}});assert.deepEqual(calls,['/api/dek/db-version']);
  await updateUnitLoadouts(s,source);assert.equal(calls.length,1);
  const m=matchDetail(s,'800'),p=publicMatch(m);assert.equal(m.units[0].loadout.cost,120);assert.equal(p.units[0].loadout.cost,120);assert.equal(p.units[0].loadout.options[0].name,'附加装甲');
  assert(!JSON.stringify(p).includes('translations'));
});

test('upstream cooldown blocks requests but does not block offline enrichment from known snapshots',async t=>{
  const s=testStore(t);
  member(s,'A',[101]);const raw=rawMatch();s.ingest('800',raw);s.saveDetail('800',detailFor(raw));
  const model={version:'unit-loadouts-v1',db_file:'v1.db',units:{},last_error_at:new Date().toISOString()};
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadouts',JSON.stringify(model),'now');
  s.snapshot('/api/units/full?unitid=238&db_file=v1.db',{unit:unit()});
  const source={async read(){throw Error('cooldown must not request');}};
  assert.equal((await updateUnitLoadouts(s,source)).updated,0);
  assert.equal((await updateUnitLoadouts(s,source,{cachedOnly:true})).updated,1);
  const saved=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadouts'").data_json);assert(saved.last_error_at);assert(saved.units[238]);
});
