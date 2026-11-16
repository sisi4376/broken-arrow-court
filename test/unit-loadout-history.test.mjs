import test from 'node:test';
import assert from 'node:assert/strict';
import {compileUnitLoadout,resolveUnitLoadout,publicUnitLoadout} from '../src/unit-loadouts.mjs';
import {compileGameSupplements,updateUnitLoadoutHistory} from '../src/unit-loadout-history.mjs';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
import {matchDetail} from '../src/queries.mjs';
import {publicMatch} from '../src/static-export.mjs';

const unit=(options=[{id:11,name:'Base',cost:0}],cost=100)=>compileUnitLoadout({id:238,cost,modifications:[{id:1,name:'Armor',options}]});
const historical=(u,name='old')=>({name,db_file:name+'.db',units:{238:u}});
test('removed IDs resolve only through a complete historical layout, not by borrowing an option from another unit',()=>{
  const u=unit(),old=unit([{id:12,name:'Old APS',cost:50}]),original=JSON.stringify(old);
  const r=resolveUnitLoadout([12],u,{history:{catalogues:[historical(old)]}});
  assert.equal(r.resolution,'complete');assert.equal(r.cost,150);assert.equal(r.basis,'historical');assert.equal(r.options[0].name,'Old APS');
  assert.equal(JSON.stringify(old),original);
  assert.equal(resolveUnitLoadout([12],u,{history:{catalogues:[{units:{999:old}}]}}).resolution,'unknown');
  assert.equal(resolveUnitLoadout([12],u,{history:{catalogues:[{...historical(old),experimental:true}]}}).resolution,'unknown');
  assert.equal(resolveUnitLoadout([11],u,{history:{catalogues:[historical(old)]}}).basis,'current');
});
test('newly introduced slots do not get guessed defaults; an old no-slot layout can match an empty actual record',()=>{
  const empty=compileUnitLoadout({id:238,cost:80,modifications:[]}),u=unit();
  assert.equal(resolveUnitLoadout([],u).cost,null);
  const r=resolveUnitLoadout([],u,{history:{catalogues:[historical(empty)]}});
  assert.equal(r.cost,80);assert.deepEqual(r.options,[]);assert.equal(r.basis,'historical');
  assert.equal(resolveUnitLoadout(null,u,{history:{catalogues:[historical(empty)]}}).resolution,'unknown');
});
test('matching historical names can resolve while differing patch prices remain explicitly ambiguous',()=>{
  const first=unit([{id:12,name:'Old APS',cost:50}],100),second=unit([{id:12,name:'Old APS',cost:70}],120);
  const r=resolveUnitLoadout([12],unit(),{history:{catalogues:[historical(first),historical(second,'older')]}});
  assert.equal(r.resolution,'complete');assert.equal(r.status,'unknown');assert.equal(r.cost,null);assert.equal(r.base_cost,null);
  assert.deepEqual(r.issues,['ambiguous_price']);assert.equal(r.options[0].name,'Old APS');assert.equal(r.options[0].cost,null);assert.equal(r.db_file,null);
  const disagree=unit([{id:12,name:'A different weapon',cost:50}]);
  assert(resolveUnitLoadout([12],unit(),{history:{catalogues:[historical(first),historical(disagree)]}}).issues.includes('ambiguous_history'));
});
test('game-extracted missing options require the exact unit and slot join and retain supplement provenance',()=>{
  const tables={Units:[{Id:238}],Modifications:[{Id:1,UnitId:238,Name:'Armor'}],Options:[{Id:12,ModificationId:1,Name:'Empty',UIName:'Custom_Empty',Cost:0}]};
  const unknown=new Map([['238',new Set([12])]]),supplements=compileGameSupplements(tables,{238:unit()},unknown,{}, {ref:'pinned-source'});
  assert.equal(supplements.length,1);assert.equal(supplements[0].source_ref,'pinned-source');
  const r=resolveUnitLoadout([12],unit(),{history:{supplements}});assert.equal(r.cost,100);assert.equal(r.basis,'supplement');assert.equal(r.options[0].source,'game_extract');
  tables.Modifications[0].UnitId=999;assert.deepEqual(compileGameSupplements(tables,{238:unit()},unknown),[]);
  assert.equal(resolveUnitLoadout([12],unit(),{history:{supplements:[{...supplements[0],slot_id:99}]}}).cost,null);
});
test('public projection preserves safe historical diagnoses and readable literal UI labels without leaking raw sources',()=>{
  const u=compileUnitLoadout({id:238,cost:100,modifications:[{id:1,name:'InternalSlot',options:[{id:12,name:'InternalWingName',uiName:'2x GBU-56 LJDAM 2000lb',cost:50}]}]});
  assert.equal(u.slots[0].options[0].name,'2x GBU-56 LJDAM 2000lb');
  const r=resolveUnitLoadout([12],unit(),{history:{catalogues:[historical(u)]}});r.secret='SECRET';r.options[0].secret='SECRET';
  const p=publicUnitLoadout(r);assert.equal(p.basis,'historical');assert.equal(p.resolution,'complete');assert.equal(p.catalogue_versions[0].name,'old');assert(!JSON.stringify(p).includes('SECRET'));assert(!JSON.stringify(p).includes('InternalWingName'));
});
test('history importer resumes from cached unordered batches, skips PTE, retains public parity and does not mark partial scans complete',async t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);const raw=rawMatch();s.ingest('800',raw);const d=detailFor(raw);
  for(const p of Object.values(d.data.Data))for(const u of Object.values(p.UnitData))u.OptionIds=[12];s.saveDetail('800',d);
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadouts',JSON.stringify({units:{238:unit()},db_file:'current.db'}),'now');
  const versions={versions:[{isPublic:true,versionName:'old',dbFileName:'old.db'},{isPublic:true,versionName:'other',dbFileName:'other.db'},{isPublic:true,versionName:'2.0 PTE',dbFileName:'test.db'}]};
  s.snapshot('/api/dek/available-versions',versions);
  s.snapshot('/api/dek/units/batch-modifications?unit_ids=999,238&db_file=old.db',{modifications:{238:[{id:1,name:'Armor',options:[{id:12,name:'Old APS',cost:50}]}]}});
  s.snapshot('/api/dek/units/batch?unit_ids=999,238&db_file=old.db',{units:[{id:238,cost:100}]});
  const calls=[],source={async read(url){calls.push(url);if(url==='/api/dek/available-versions')return versions;if(url.includes('batch-modifications'))return {modifications:{238:[{id:1,name:'Armor',options:[{id:12,name:'Old APS',cost:50}]}]}};return {units:[{id:238,cost:100}]};}};
  await updateUnitLoadoutHistory(s,source,{cachedOnly:true});assert.equal(calls.length,0);
  let history=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);assert.deepEqual(history.covered_units,[]);
  await updateUnitLoadoutHistory(s,source);assert.equal(calls.length,3);assert(!calls.some(url=>url.includes('test.db')));
  history=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);assert.deepEqual(history.covered_units,['238']);
  await updateUnitLoadoutHistory(s,source);assert.equal(calls.length,3);
  const m=matchDetail(s,'800'),pub=publicMatch(m);assert.equal(m.units[0].loadout.options[0].name,'Old APS');assert.equal(pub.units[0].loadout.basis,'historical');assert.equal(pub.units[0].loadout.cost,150);
});

test('history version failures persist cooldown without discarding already archived catalogues',async t=>{
  const s=testStore(t);member(s,'A',[101]);const raw=rawMatch();s.ingest('800',raw);const d=detailFor(raw);
  for(const p of Object.values(d.data.Data))for(const u of Object.values(p.UnitData))u.OptionIds=[12];s.saveDetail('800',d);
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadouts',JSON.stringify({units:{238:unit()},db_file:'current.db'}),'now');
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_loadout_history',JSON.stringify({catalogues:[historical(unit())],supplements:[]}), 'now');
  let calls=0;const source={async read(){calls++;throw Error('upstream cooldown');}};
  await assert.rejects(updateUnitLoadoutHistory(s,source),/cooldown/);
  const saved=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);assert(saved.last_error_at);assert.equal(saved.catalogues.length,1);
  assert.equal((await updateUnitLoadoutHistory(s,source)).updated,0);assert.equal(calls,1);
});
