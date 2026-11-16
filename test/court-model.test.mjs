import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor, airUnit } from './helpers.mjs';
import { contextualEvidence } from '../src/court-model.mjs';
import { compileAirUnit } from '../src/air-superiority.mjs';
import { contextZhanfanAnalysis as zhanfanAnalysis, contextZhanfanComparison as zhanfanComparison, zhanfanAnalysis as defaultAnalysis, legacyZhanfanAnalysis, ZHANFAN_CONTEXT_MODEL as MODEL, calibratedScore, sentenceMonths } from '../src/zhanfan.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

const values = {destruction:4000,losses:4000,damage:1000,objectives:0,friendly_fire:0,supplied:0,received:0,consumed:1000};
const units = (heavy=0,air=0) => ({heavy:{known:true,kills:heavy},air:{known:true,kills:air}});
const person = (key,v={},e=units()) => ({key,values:{...values,...v},unit_evidence:e});
function evidence(v={},e=units(),peers=[person('B'),person('C')]) {
  const g=person('A',v,e);return contextualEvidence(g,[g,...peers],MODEL);
}
function fixture(t) {
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','900',JSON.stringify({id:900,role:15}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','901',JSON.stringify({id:901,role:164}),'now');
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify({units:{901:compileAirUnit(airUnit(901))}}));
  return s;
}
const mapping={destruction:'DestructionScore',losses:'LossesScore',damage:'DamageDealt',objectives:'ObjectivesCaptured',friendly_fire:'DamageFriendlyFireDealt',supplied:'SupplyPointsConsumedByAllies',received:'SupplyPointsConsumedFromAllies',consumed:'SupplyPointsConsumed'};
function game(s,id,{ids=[101,102,103,201],teams={},player={},unitData={},winner=-1,map=4,mode=0,complete=true,duration=1800}={}) {
  const raw=rawMatch(ids,{WinnerTeam:winner,MapId:map,Type:mode,TotalPlayTimeInSec:duration});
  for(const p of Object.values(raw.Data))p.TeamId=teams[p.Id]??(p.Id===201?1:0);
  s.ingest(String(id),raw);const detail=detailFor(raw);
  for(const [id,p]of Object.entries(detail.data.Data)){
    for(const [key,field]of Object.entries(mapping))p[field]=values[key];
    Object.assign(p,player[id]);p.UnitData=unitData[id]??{};
  }
  if(complete)s.saveDetail(String(id),detail);return detail;
}
const report=(s,q='court_min_games=1')=>zhanfanAnalysis(s,new URLSearchParams(q)).members.find(r=>r.member_id===1);
const weak={DestructionScore:0,LossesScore:10000,DamageDealt:0,ObjectivesCaptured:0,SupplyPointsConsumedFromAllies:10000,SupplyPointsConsumed:10000};

test('v4 uses direct scores with a zero-evidence prior, transparent fixed weights and unchanged sentencing',()=>{
  assert.equal(MODEL.version,'zhanfan-v4-context');
  assert.equal(MODEL.dimensions.reduce((n,d)=>n+d.weight,0),100);
  assert.equal(MODEL.dimensions.reduce((n,d)=>n+d.weight*d.prior/100,0),12.5);
  for(let i=0;i<=100;i++)assert.equal(calibratedScore(i,MODEL),i);
  assert.equal(sentenceMonths(25),0);assert.equal(sentenceMonths(85),240);
  assert.equal(MODEL.dimensions.find(d=>d.key==='victory').weight,25);
});

test('zero captures, no supply donations and ordinary shared supply are not standalone offences',()=>{
  const healthy=evidence({received:10000,consumed:10000,losses:20000});
  assert.equal(healthy.evidence.combat,1);assert.equal(healthy.evidence.deficit,0);
  for(const p of Object.values(healthy.penalties))assert.equal(p,0);
  const weakNoSupply=evidence({destruction:0,damage:0});
  assert.equal(weakNoSupply.penalties.dependency,0);assert(weakNoSupply.penalties.pressure>0);
  const normal=evidence({destruction:0,damage:0,received:3500,consumed:10000});
  assert.equal(normal.penalties.dependency,0);
});

test('objectives mitigate an output gap with a fixed cap, never grant one-capture or mass-capture immunity',()=>{
  const v={destruction:0,damage:0,losses:10000,received:10000,consumed:10000};
  const base=evidence(v),once=evidence({...v,objectives:1}),many=evidence({...v,objectives:100});
  assert.equal(once.evidence.objectives,.5);assert(once.evidence.objective_relief>0);
  for(const key of ['pressure','exchange','dependency']){
    assert(once.penalties[key]<base.penalties[key]);assert(many.penalties[key]>0);
    assert(many.penalties[key]>=base.penalties[key]*.5-1e-10);
  }
  assert.equal(many.evidence.objective_relief,100*base.evidence.deficit*.5);
});

test('specialist actual kills mitigate without inferred roles, stacking, or treating unknown evidence as zero',()=>{
  const v={destruction:0,damage:0};
  const base=evidence(v),heavy=evidence(v,units(9)),air=evidence(v,units(0,9)),both=evidence(v,units(9,9));
  assert(heavy.penalties.pressure<base.penalties.pressure);assert(heavy.penalties.pressure>0);
  assert.equal(heavy.penalties.pressure,air.penalties.pressure);assert.equal(both.penalties.pressure,heavy.penalties.pressure);
  assert.equal(evidence(v,units(0,0)).support.credit,0);
  const unknown=units();unknown.heavy.known=false;
  const unavailable=evidence(v,units(9),[person('B',{},unknown),person('C')]);
  assert.equal(unavailable.penalties.pressure,base.penalties.pressure);assert.equal(unavailable.evidence.unavailable_specialists,1);
  assert(unavailable.evidence.specialist_values.every(e=>e.kind!=='heavy'));
});

test('net teammate supply requires excess dependency AND a contribution gap, never mixes currencies',()=>{
  const v={destruction:0,damage:0,received:8000,consumed:10000};
  const food=evidence(v),offset=evidence({...v,supplied:8000}),less=evidence({...v,received:5000});
  assert(food.penalties.dependency>less.penalties.dependency);assert.equal(offset.penalties.dependency,0);
  assert.equal(food.food.net_received,8000);assert.equal(food.food.share,.8);
  assert.equal(food.penalties.dependency,100*((.8-.35)/.65)*food.evidence.deficit);
  assert.equal(evidence({...v,destruction:4000,damage:1000}).penalties.dependency,0);
  const donation=evidence({destruction:0,damage:0,supplied:50000});
  assert.equal(donation.penalties.pressure,evidence({destruction:0,damage:0}).penalties.pressure);
});

test('better measurable combat cannot worsen behaviour penalties and negative exchange or friendly fire cannot help',()=>{
  let previous=null;
  for(let x=0;x<=8000;x+=100){
    const result=evidence({destruction:x,damage:x/4,losses:10000,received:10000,consumed:10000,objectives:1});
    for(const p of Object.values(result.penalties))assert(Number.isFinite(p)&&p>=0&&p<=100);
    if(previous)for(const key of ['pressure','exchange','dependency'])assert(result.penalties[key]<=previous.penalties[key]+1e-10);
    previous=result;
  }
  assert(evidence({destruction:0,damage:0,losses:20000}).penalties.exchange>evidence({destruction:0,damage:0,losses:1000}).penalties.exchange);
  assert(evidence({friendly_fire:100}).penalties.discipline>evidence({friendly_fire:1}).penalties.discipline);
});

test('default standings produce actual terms for sustained imbalance and personal views exactly match the standings',t=>{
  const s=fixture(t);for(let i=0;i<40;i++)game(s,800+i,{player:{101:weak},winner:1});
  const r=report(s);assert(r.eligible);assert(r.score>25);assert(r.sentence_months>0);
  assert.equal(r.sentence_months,sentenceMonths(r.score));assert.equal(r.rank,1);
  assert.equal(r.context.imbalanced_matches,40);assert.equal(r.freeloading.penalized_matches,40);
  assert.equal(r.context.risk_examples.length,3);assert(r.context.risk_examples.every(e=>e.values.received===10000));
  const data=zhanfanAnalysis(s,new URLSearchParams('mode=0'));
  assert.deepEqual(friendAnalysis(s,1,new URLSearchParams('mode=0')).court.report,defaultAnalysis(s,new URLSearchParams('mode=0')).members.find(r=>r.member_id===1));
  const c=zhanfanComparison(s,new URLSearchParams('mode=0'));
  assert.equal(c.kind,'court-model-comparison');assert.deepEqual(c.current,data);
  assert.deepEqual(c.previous,legacyZhanfanAnalysis(s,new URLSearchParams('mode=0')));
  assert.equal(c.members.find(r=>r.member_id===1).delta_months,r.sentence_months-c.previous.members.find(r=>r.member_id===1).sentence_months);
});

test('normal games dilute repeated incidents instead of accumulating years and new empty friends never change scores',t=>{
  const s=fixture(t);for(let i=0;i<10;i++)game(s,800+i,{player:{101:weak},winner:1});
  const repeated=report(s);for(let i=0;i<30;i++)game(s,900+i,{winner:0});
  const mixed=report(s);assert(mixed.score<repeated.score);assert(mixed.sentence_months<repeated.sentence_months);
  member(s,'New empty friend');assert.deepEqual(report(s),mixed);
  const empty=zhanfanAnalysis(s).members.find(r=>r.name==='Empty');assert.equal(empty.score,null);assert.equal(empty.sentence_months,null);
  assert(empty.components.every(c=>c.penalty===null));
});

test('known win outcomes have independent shrinkage, important effect, and cannot erase severe personal imbalance',t=>{
  const s=fixture(t);for(let i=0;i<40;i++){
    game(s,800+i,{player:{101:weak},winner:0,map:4});
    game(s,900+i,{player:{101:weak},winner:1,map:28});
  }
  const wins=report(s,'map=4'),losses=report(s,'map=28');
  assert(wins.score>25);assert(wins.sentence_months>0);assert(losses.score>wins.score);
  assert.equal(wins.components.find(c=>c.key==='victory').penalty,10);
  assert.equal(losses.components.find(c=>c.key==='victory').penalty,90);
  assert.deepEqual(wins.components.filter(c=>c.key!=='victory'),losses.components.filter(c=>c.key!=='victory'));
  game(s,1000,{player:{101:weak},winner:999,map:12});
  const unknown=report(s,'map=12');assert.equal(unknown.win_rate,null);assert.equal(unknown.components.find(c=>c.key==='victory').penalty,50);
  assert.equal(unknown.outcome_matches,0);
});

test('filters, enemy independence, alt merging, explicit invalid values, uninformative matches and minimum games remain safe',t=>{
  const s=fixture(t);game(s,800,{player:{101:weak}});const before=report(s);
  game(s,800,{player:{101:weak,201:{DestructionScore:99999999,DamageDealt:99999999}}});assert.deepEqual(report(s),before);
  const half=Object.fromEntries(Object.entries(weak).map(([k,v])=>[k,v/2]));
  game(s,800,{ids:[101,104,102,103,201],player:{101:half,104:half}});assert.deepEqual(report(s),before);
  game(s,801,{ids:[101,104,102,103],teams:{104:1}});assert.equal(report(s).skipped.ambiguous_team,1);
  const d=game(s,802);d.data.Data['101'].SupplyPointsConsumedFromAllies=null;s.saveDetail('802',d);
  assert.equal(report(s).skipped.invalid_data,1);
  game(s,803,{complete:false});game(s,804,{duration:0});
  game(s,805,{map:28,mode:1});assert.equal(report(s,'mode=1').scored_matches,1);assert.equal(report(s,'map=28').scored_matches,1);
  assert.equal(report(s,'q=800').scored_matches,1);assert.equal(report(s,'q=800&court_min_games=5').eligible,false);
  const zero={DestructionScore:0,DamageDealt:0,ObjectivesCaptured:0};
  game(s,806,{player:{101:zero,102:zero,103:zero,201:zero}});assert.equal(report(s).skipped.no_activity,1);
});

test('actual air options and personal heavy ownership affect relief; bombs and unknown roles do not create credits',t=>{
  const s=fixture(t),plane=options=>({Id:901,KilledCount:10,OptionIds:options});
  game(s,800,{player:{101:weak},unitData:{101:{a:plane([100,200])}}});
  const air=report(s);assert.equal(air.context.specialist_relief_matches,1);assert.equal(air.context.relief_examples.length,1);
  game(s,800,{player:{101:weak},unitData:{101:{a:plane([101,200])}}});
  const bomb=report(s);assert.equal(bomb.context.specialist_relief_matches,0);assert(bomb.score>air.score);
  game(s,800,{player:{101:weak},unitData:{102:{h:{Id:900,KilledCount:10}}}});
  assert.equal(report(s).context.specialist_relief_matches,0);
  game(s,800,{player:{101:weak},unitData:{101:{h:{Id:900,KilledCount:10}},102:{unknown:{Id:99999,KilledCount:10}}}});
  assert.equal(report(s).context.specialist_relief_matches,0);
});

test('donations cannot offset food dependence in another game and omitted protobuf zero stays zero',t=>{
  const s=fixture(t);const d=game(s,800,{player:{101:weak}});
  delete d.data.Data['101'].DamageFriendlyFireDealt;s.saveDetail('800',d);
  const first=report(s);assert.equal(first.scored_matches,1);assert(first.freeloading.penalized_matches>0);
  game(s,801,{player:{101:{SupplyPointsConsumedByAllies:100000}}});
  const next=report(s);assert.equal(next.freeloading.penalized_matches,first.freeloading.penalized_matches);
  assert.equal(next.freeloading.net_received,first.freeloading.net_received);
  assert.equal(next.context.risk_examples.find(e=>e.match_id==='800').penalties.dependency,first.context.risk_examples[0].penalties.dependency);
});

test('v4 UI exposes explicit terms, model differences, bounded relief and original evidence with escaped names',t=>{
  const s=fixture(t);s.run('UPDATE members SET name=? WHERE id=1','<script>Bad</script>');
  for(let i=0;i<5;i++)game(s,800+i,{player:{101:weak}});
  const data=zhanfanAnalysis(s),r=data.members.find(r=>r.member_id===1);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:n=>n==null?'—':String(n),empty:()=>''});
  const panel=ui.courtPanel({model:data.model,min_games:data.min_games,report:r});
  assert(panel.includes(r.sentence));assert(panel.includes('逐局依据与减刑记录'));assert(panel.includes('href="#match/800"'));
  assert(panel.includes('最多缓解原缺口 50%'));assert(panel.includes('数据覆盖不是判决准确率'));
  const table=ui.courtView(data),comparison=ui.courtView(zhanfanComparison(s));
  for(const html of [table,comparison]){assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('zhanfan-v4-context'));}
  assert(comparison.includes('旧版 v2 刑期'));assert(comparison.includes('现行 v4 刑期'));
});
