import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,member,rawMatch,detailFor,selfDestructionPrices } from './helpers.mjs';
import { selfDestructionStats } from '../src/self-destruction.mjs';
import { auditSelfDestruction,repairSelfDestruction,canImproveDetail } from '../src/self-destruction-audit.mjs';
import { unitFate } from '../public/match-player.js';
import { supplyAnalysis } from '../src/queries.mjs';
import { LIVE_121_AT } from '../src/match-prices.mjs';

function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  const raw=rawMatch(undefined,{Type:0});s.ingest('800',raw);const d=detailFor(raw);
  for(const p of Object.values(d.data.Data))p.Losses=1;
  s.saveDetail('800',d);return {s,d};
}
const model=s=>selfDestructionStats(s,{sql:'m.friend_count>=3',args:[]}).members.get(1);
test('legacy missing lifecycle is unknown, while confirmed events remain visible and are not averaged as zero',t=>{
  const {s,d}=fixture(t);for(const p of Object.values(d.data.Data))for(const u of Object.values(p.UnitData)){delete u.SpawnTime;delete u.DeathTime;}
  Object.values(d.data.Data['101'].UnitData)[0].SelfDestruction=true;s.saveDetail('800',d);
  const m=model(s);assert.equal(m.samples,0);assert.equal(m.total,1);assert.equal(m.ranked,0);assert.equal(m.cases[0].coverage,'partial');assert.equal(m.unknown[0].reason,'missing_lifecycle');
});
test('loss reconciliation and every alternate account determine evidence coverage for the whole person-match',t=>{
  const {s,d}=fixture(t);Object.values(d.data.Data['101'].UnitData)[0].SelfDestruction=true;
  d.data.Data['104'].Losses=4;s.saveDetail('800',d);
  assert.equal(model(s).samples,0);assert.equal(model(s).total,1);assert.equal(model(s).unknown[0].reason,'missing_death_records');
  d.data.Data['104'].Losses=1;s.saveDetail('800',d);assert.equal(model(s).samples,1);assert.equal(model(s).ranked,1);
});
test('a missing flag can use the exact crash sentinel, but ordinary self damage, explicit false, refunds and ambiguous fields cannot',t=>{
  const {s,d}=fixture(t),u=Object.values(d.data.Data['101'].UnitData)[0];
  delete u.DeathTime;u.TotalSelfDamageDealt=-1;d.data.Data['101'].Losses=0;s.saveDetail('800',d);
  assert.equal(model(s).total,1);assert.equal(model(s).compatible,1);assert.equal(model(s).samples,1);
  assert.equal(unitFate({raw:u,death_time:null,refunded:0}),'self-destroyed');
  for(const patch of [{TotalSelfDamageDealt:100},{TotalSelfDamageDealt:-2},{SelfDestruction:false},{WasRefunded:true}]){
    const next={...u,...patch};d.data.Data['101'].UnitData['10101']=next;s.saveDetail('800',d);assert.equal(model(s).total,0);
    assert.notEqual(unitFate({raw:next,death_time:null,refunded:next.WasRefunded?1:0}),'self-destroyed');
  }
});
test('offline audit repairs stale or missing unit indexes from immutable archived detail, with a backup first',async t=>{
  const {s,d}=fixture(t);const u=Object.values(d.data.Data['101'].UnitData)[0];u.SelfDestruction=true;s.saveDetail('800',d);
  s.run("DELETE FROM unit_instances WHERE player_id='101'");
  assert.equal(auditSelfDestruction(s).repairs[0].missing,1);
  const report=await repairSelfDestruction(s,{apply:true});assert.equal(report.repaired,1);assert.equal(report.backup,true);
  assert.equal(JSON.parse(s.get("SELECT raw_json FROM unit_instances WHERE player_id='101'").raw_json).SelfDestruction,true);
  assert.equal(auditSelfDestruction(s).repairs.length,0);
});
test('refresh never replaces archived data with expired or weaker detail and stops on upstream refusal',async t=>{
  const {s,d}=fixture(t);assert.equal(canImproveDetail('800',d,{data:{...d.data,Data:{}}}),false);
  const better=structuredClone(d);Object.values(better.data.Data['101'].UnitData)[0].SelfDestruction=true;
  assert.equal(canImproveDetail('800',d,better),true);
  const report=await repairSelfDestruction(s,{refresh:1,ids:['800'],apply:true,source:{detail:async()=>better}});
  assert.equal(report.repaired,1);assert.equal(model(s).total,1);
  let calls=0;const blocked=await repairSelfDestruction(s,{refresh:5,ids:['800','801'],source:{detail:async()=>{calls++;throw Object.assign(Error('cooldown'),{status:429});}}});
  assert.equal(calls,1);assert.equal(blocked.repaired,0);assert.equal(blocked.fetched[0].status,'unavailable');assert.equal(model(s).total,1);
});

test('score ranking uses the full historical loadout value rather than unit count, merges alts and includes zero-self games',t=>{
  const {s,d}=fixture(t);selfDestructionPrices(s);
  const history=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);
  history.price_catalogues[0].units[900]={id:900,base_cost:500,slots:[],catalogue:{hudName:'Fixture fighter'}};
  s.run("UPDATE analysis_catalogue SET data_json=? WHERE key='unit_loadout_history'",JSON.stringify(history));
  for(const id of ['101','104'])Object.values(d.data.Data[id].UnitData)[0].SelfDestruction=true;
  Object.assign(Object.values(d.data.Data['102'].UnitData)[0],{Id:900,OptionIds:[],SelfDestruction:true});s.saveDetail('800',d);
  const zero=structuredClone(d);for(const p of Object.values(zero.data.Data))for(const u of Object.values(p.UnitData))delete u.SelfDestruction;
  s.ingest('801',zero.data);s.saveDetail('801',zero);
  const result=supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=1'));
  const board=result.charges.find(c=>c.id==='self_destruction');
  assert.equal(board.key,'avg_self_destruction_score');assert.deepEqual(board.rows.map(r=>r.name),['B','A','C']);
  const b=board.rows[0],a=board.rows[1];assert.equal(b.self_destructions,1);assert.equal(a.self_destructions,2);
  assert.equal(b.avg_self_destruction_score,250);assert.equal(a.avg_self_destruction_score,110);assert.equal(a.sample_count,2);
  const units=a.self_destruction_cases[0].units;assert.equal(units.length,2);assert.deepEqual(units.map(u=>u.player_id),['101','104']);
  assert(units.every(u=>u.score===110&&u.loadout.options.some(o=>o.name==='主炮')));
});

test('a single unknown historical price excludes the whole personal game from score averages, without dropping known units or using the current price',t=>{
  const {s,d}=fixture(t);selfDestructionPrices(s);
  for(const id of ['101','104'])Object.values(d.data.Data[id].UnitData)[0].SelfDestruction=true;
  Object.values(d.data.Data['101'].UnitData)[0].OptionIds=[999];s.saveDetail('800',d);
  const m=model(s);assert.equal(m.samples,1);assert.equal(m.total,2);assert.equal(m.score_samples,0);assert.equal(m.unpriced,1);assert.equal(m.score,110);
  assert.equal(m.cases[0].score,null);assert.equal(m.cases[0].known_score,110);assert.equal(m.unknown[0].reason,'missing_unit_price');
  assert.equal(m.cases[0].units.find(u=>u.player_id==='101').score,null);
  const history=JSON.parse(s.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json),old=history.price_catalogues[0];
  old.valid_until=LIVE_121_AT;
  history.price_catalogues.push({...structuredClone(old),version_name:'next',valid_until:undefined,valid_from:LIVE_121_AT,
    units:{238:{...old.units[238],base_cost:200}}});
  s.run("UPDATE analysis_catalogue SET data_json=? WHERE key='unit_loadout_history'",JSON.stringify(history));
  Object.values(d.data.Data['101'].UnitData)[0].OptionIds=[560,1634];d.data.EndTime=LIVE_121_AT+3600;d.data.StartTime=LIVE_121_AT+1;s.ingest('800',d.data);s.saveDetail('800',d);
  assert.equal(model(s).cases[0].score,420);assert.equal(model(s).score_samples,1);
  d.data.StartTime=LIVE_121_AT-1;s.saveDetail('800',d);assert.equal(model(s).cases[0].score,null);assert.equal(model(s).unpriced,2);
});
