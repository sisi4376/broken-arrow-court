import test from 'node:test';
import assert from 'node:assert/strict';
import {testStore,member,rawMatch,detailFor,airUnit} from './helpers.mjs';
import {compileAirUnit,classifyAirLoadout,updateAirCatalogue,AIR_MODEL_VERSION} from '../src/air-superiority.mjs';
import {supplyAnalysis} from '../src/queries.mjs';
import {createPerformance} from '../public/performance.js';
import {LIVE_121_AT} from '../src/match-prices.mjs';

test('actual selected weapons distinguish pure air-to-air, mixed, ground, empty and ammo-free configurations',()=>{
  const unit=compileAirUnit(airUnit());
  const classify=ids=>classifyAirLoadout({OptionIds:ids},unit);
  assert.deepEqual(unit.base_turrets,[1]);
  assert.equal(classify([100,200]).status,'eligible');
  assert.deepEqual(classify([200,100]).option_ids,[100,200]);
  for(const ids of [[101,200],[100,201],[103,200],[102,200],[104,200]])assert.equal(classify(ids).status,'not_eligible',String(ids));
  for(const ids of [[],[100],[100,999],[100,101,200],[100,200,200],null,undefined,'100,200',[100,'200'],[100,-1]])assert.equal(classify(ids).status,'unknown',String(ids));
  assert.equal(classify([100,202]).reason,'replacement_unit');
  assert.equal(classify([101,999]).status,'not_eligible','confirmed ground weapons exclude even partially unknown loadouts');
  assert.equal(classifyAirLoadout({OptionIds:[100,200]},null).reason,'missing_model');
  delete unit.turrets[2];assert.equal(classify([100,200]).reason,'missing_weapon');
});

function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Short',[105]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','900',JSON.stringify({id:900,role:164,hudName:'Multirole'}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','901',JSON.stringify({id:901,role:73,hudName:'Helicopter'}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','902',JSON.stringify({id:902,role:100,hudName:'UAV'}),'now');
  const model={version:AIR_MODEL_VERSION,updated_at:'2026-10-17T00:00:00Z',db_file:'fixture.db',units:{900:compileAirUnit(airUnit())}};
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify(model));
  function game(id,{mode=0,complete=true,ids=[101,102,103],units={}}={}){
    const raw=rawMatch(ids,{Type:mode});s.ingest(id,raw);
    if(complete){const d=detailFor(raw);for(const [id,p]of Object.entries(d.data.Data))p.UnitData=units[id]??{};s.saveDetail(id,d);}
  }
  const unit=(kills,options=[100,200],id=900,extra={})=>({Id:id,OptionIds:options,KilledCount:kills,...extra});
  game('800',{ids:[101,102,103,104,105,999],units:{101:{a:unit(3),ground:unit(90,[100,201])},104:{alt:unit(2,[200,100],900,{WasRefunded:true,DeathTime:2})},102:{b:unit(4)},103:{helo:unit(40,[],901),uav:unit(40,[],902)},105:{short:unit(1)},999:{enemy:unit(999)}}});
  game('801');game('802',{complete:false});
  game('803',{units:{101:{unknown:unit(100,[100,999]),known:unit(9)},102:{mixed:unit(60,[100,201])}}});
  game('804',{mode:1,units:{101:{ranked:unit(100)}}});
  game('899',{ids:[101,990,991],units:{101:{solo:unit(999)}}});
  return {s,game,unit};
}

test('personal kills merge alts once per match, retain zero-use games and exclude incomplete or unknown evidence',t=>{
  const {s}=fixture(t),data=supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=2'));
  const board=data.charges.find(c=>c.id==='air_superiority');
  assert.equal(board.group,'mitigation');assert.equal(board.title,'空优立功榜');
  assert.deepEqual(board.rows.map(r=>[r.name,r.air_superiority_kills,r.avg_air_superiority_kills,r.sample_count]),[['A',5,2.5,2],['B',4,4/3,3],['C',0,0,3]]);
  const a=board.rows[0];assert.equal(a.air_superiority_excluded,1);assert.equal(a.air_superiority_units.length,1);
  assert.equal(a.air_superiority_units[0].kills,5);assert.equal(a.air_superiority_units[0].deployments,2);
  const unknown=supplyAnalysis(s,new URLSearchParams('q=803&supply_min_games=1')).members.find(r=>r.name==='A');
  assert.equal(unknown.air_superiority_kills,null);assert.equal(unknown.air_superiority_matches,0);assert.equal(unknown.air_superiority_excluded,1);
  assert.equal(supplyAnalysis(s,new URLSearchParams('mode=1&supply_min_games=1')).charges.find(c=>c.id==='air_superiority').rows[0].air_superiority_kills,100);
  assert.equal(supplyAnalysis(s,new URLSearchParams('q=802&supply_min_games=1')).charges.find(c=>c.id==='air_superiority').rows.length,0);
  assert.equal(supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=4')).charges.find(c=>c.id==='air_superiority').rows.length,0);
});

test('invalid personal kills and missing catalogue roles never enter the air leaderboard as zero',t=>{
  const {s,game,unit}=fixture(t);
  for(const [id,u]of [['810',unit(-1)],['811',unit(5,[100,200],9999)],['812',unit(5,null)]]){
    game(id,{units:{101:{a:u}}});
    const a=supplyAnalysis(s,new URLSearchParams(`q=${id}&supply_min_games=1`)).members.find(r=>r.name==='A');
    assert.equal(a.air_superiority_kills,null,id);assert.equal(a.air_superiority_excluded,1,id);
  }
});

test('same option IDs use the match release weapons and never share cached classifications across releases',t=>{
  const{s,unit}=fixture(t),old=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'").data_json),next=structuredClone(old);
  next.db_file='next.db';next.units[900].modifications[0].options.find(o=>o.id===100).slots={1:3};
  old.catalogues=[{...structuredClone(old),version_name:'old',valid_until:LIVE_121_AT},{...next,version_name:'1.2.1',valid_from:LIVE_121_AT}];
  s.run("UPDATE analysis_catalogue SET data_json=? WHERE key='air_superiority_model'",JSON.stringify(old));
  for(const[id,end]of [['820',LIVE_121_AT-3600],['821',LIVE_121_AT+7200]]){
    const raw=rawMatch([101,102,103],{Type:0,EndTime:end});s.ingest(id,raw);const detail=detailFor(raw);
    for(const p of Object.values(detail.data.Data))p.UnitData={};detail.data.Data['101'].UnitData.a=unit(7);s.saveDetail(id,detail);
  }
  const a=supplyAnalysis(s,new URLSearchParams('q=82&supply_min_games=1')).members.find(m=>m.name==='A');
  assert.equal(a.air_superiority_matches,2);assert.equal(a.air_superiority_kills,7);assert.equal(a.air_superiority_units[0].catalogue_version,'old');
  const after=supplyAnalysis(s,new URLSearchParams('q=821&supply_min_games=1')).members.find(m=>m.name==='A');assert.equal(after.air_superiority_kills,0);
  s.run("UPDATE matches SET end_time=?,duration=? WHERE id='821'",LIVE_121_AT+100,200);
  assert.equal(supplyAnalysis(s,new URLSearchParams('q=821&supply_min_games=1')).members.find(m=>m.name==='A').air_superiority_matches,0);
});

test('air evidence is escaped, shows actual option IDs, and does not change sentencing boards',t=>{
  const{s}=fixture(t),data=supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=2'));
  const air=data.charges.find(c=>c.id==='air_superiority');air.rows[0].air_superiority_units[0].loadout[0]='<script>bad</script>';
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const ui=createPerformance({S:{supplyMin:2},esc,fmt:n=>String(n),icon:()=>'',empty:()=>''});
  const html=ui.supplyView(data);
  assert(html.includes('空优立功榜'));assert(html.includes('累计空优机击杀 5'));assert(html.includes('OptionIds: 100, 200'));
  assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert.equal(data.charges.filter(c=>c.group==='sentencing').length,7);
});

test('catalogue refresh is persisted, resumes after a pause, handles new planes and respects version changes',async t=>{
  const s=testStore(t);for(const id of [900,901])s.run('INSERT INTO unit_catalogue VALUES(?,?,?)',String(id),JSON.stringify({id,role:164}),'now');
  const calls=[];let allowed=true,version='one.db';
  const source={async read(p){calls.push(p);if(p==='/api/dek/db-version')return {dbFileName:version,versionId:version};return {unit:airUnit(Number(new URL(p,'https://example.test').searchParams.get('unitid')))};}};
  await updateAirCatalogue(s,source,{allowed:()=>allowed,onProgress:()=>{allowed=false;}});
  let model=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'").data_json);assert.equal(Object.keys(model.units).length,1);
  allowed=true;await updateAirCatalogue(s,source);model=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'").data_json);assert.equal(Object.keys(model.units).length,2);
  const n=calls.length;await updateAirCatalogue(s,source);assert.equal(calls.length,n);
  version='two.db';await updateAirCatalogue(s,source,{force:true});model=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'").data_json);assert.equal(model.db_file,'two.db');assert.equal(Object.keys(model.units).length,2);
  assert(calls.some(p=>p.includes('db_file=two.db')));
});

test('catalogue failures retain previously saved models and throttle subsequent retries',async t=>{
  const s=testStore(t);for(const id of [900,901])s.run('INSERT INTO unit_catalogue VALUES(?,?,?)',String(id),JSON.stringify({id,role:164}),'now');
  let calls=0;const source={async read(p){calls++;if(p==='/api/dek/db-version')return {dbFileName:'one.db'};if(p.includes('unitid=900'))return {unit:airUnit(900)};throw Object.assign(new Error('rate limited'),{status:429});}};
  await assert.rejects(updateAirCatalogue(s,source),/rate limited/);
  const model=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'").data_json);assert(model.units[900]);assert(!model.units[901]);
  const n=calls;await updateAirCatalogue(s,source);assert.equal(calls,n);
});
