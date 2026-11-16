import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,member,rawMatch,detailFor,airUnit } from './helpers.mjs';
import { legacyZhanfanAnalysis as zhanfanAnalysis,zhanfanTrialComparison as zhanfanComparison,ZHANFAN_TRIAL_MODEL,ZHANFAN_PERCENTILE_TRIAL_MODEL,calibratedScore,freeloadingEvidence,performanceRatioPenalty } from '../src/zhanfan.mjs';
import { compileAirUnit } from '../src/air-superiority.mjs';
import { createCourt } from '../public/zhanfan.js';

function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'No games');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','900',JSON.stringify({id:900,role:15}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','901',JSON.stringify({id:901,role:164}),'now');
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify({units:{901:compileAirUnit(airUnit(901))}}));
  return s;
}
function game(s,id=800,{ids=[101,102,103,201],values={},units={},winner=-1,mode=0,map=4,complete=true}={}){
  const raw=rawMatch(ids,{Type:mode,MapId:map,WinnerTeam:winner});
  for(const p of Object.values(raw.Data))p.TeamId=p.Id===201?1:0;
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const[id,p]of Object.entries(d.data.Data))Object.assign(p,{DestructionScore:1000,LossesScore:1000,DamageDealt:100,ObjectivesCaptured:1,DamageFriendlyFireDealt:0,SupplyPointsConsumed:1000,SupplyPointsConsumedByAllies:0,SupplyPointsConsumedFromAllies:0,UnitData:units[id]??{}},values[id]);
  if(complete)s.saveDetail(String(id),d);return d;
}
const compare=(s,q='court_min_games=1')=>zhanfanComparison(s,new URLSearchParams(q));
const first=c=>c.members.find(r=>r.member_id===1);
const part=(r,key)=>r.components.find(c=>c.key===key);
const heavy=(kills,id=900)=>({Id:id,KilledCount:kills,OptionIds:id===901?[100,200]:[]});
const weak={101:{DestructionScore:10,DamageDealt:1},102:{DestructionScore:100,DamageDealt:100},103:{DestructionScore:200,DamageDealt:200}};

test('trial keeps current verdicts unchanged, uses identical samples and normalizes the new neutral baseline',t=>{
  const s=fixture(t);for(let i=0;i<5;i++)game(s,800+i);
  const before=zhanfanAnalysis(s),c=compare(s);
  assert.deepEqual(c.current,zhanfanAnalysis(s,new URLSearchParams('court_min_games=1')));
  assert.deepEqual(zhanfanAnalysis(s),before);
  assert.equal(c.trial.model.dimensions.reduce((n,d)=>n+d.weight,0),100);
  assert.equal(c.trial.model.dimensions.reduce((n,d)=>n+d.weight*d.prior/100,0),40);
  assert.equal(calibratedScore(40,ZHANFAN_TRIAL_MODEL),50);
  assert.equal(calibratedScore(0,ZHANFAN_TRIAL_MODEL),0);assert.equal(calibratedScore(100,ZHANFAN_TRIAL_MODEL),100);
  let previous=-1;for(let i=0;i<=1000;i++){const score=calibratedScore(i/10,ZHANFAN_TRIAL_MODEL);assert(score>previous);previous=score;}
  for(const r of c.members){
    assert.equal(r.current.scored_matches,r.trial.scored_matches);
    if(r.name!=='No games'){assert.equal(r.trial.score,50);assert.equal(r.delta_score,0);}
    else{assert.equal(r.trial.score,null);assert.equal(r.delta_score,null);assert.equal(r.delta_months,null);assert(r.drivers.every(d=>d.delta===null));}
  }
});

test('ratio scale is finite, bounded, monotone, symmetric and explicit about zero or invalid inputs',()=>{
  for(const[x,y,expected]of [[1,1,50],[1,2,80],[2,1,20],[1,4,100],[4,1,0],[0,0,50],[0,1,100],[1,0,0]])assert.equal(performanceRatioPenalty(x,y),expected);
  assert.equal(performanceRatioPenalty(1,3,1),80);assert.equal(performanceRatioPenalty(3,1,1),20);
  for(const x of [null,undefined,NaN,Infinity,-1,'100',1e300])assert.equal(performanceRatioPenalty(x,100,1),null);
  for(const [ref,buffer,slope]of [[NaN,1,30],[1,-1,30],[1,1,0],[1,1,NaN]])assert.equal(performanceRatioPenalty(10,ref,buffer,slope),null);
  let previous=101;
  for(let x=0;x<=1000;x++){
    const p=performanceRatioPenalty(x,100,50);assert(p<=previous);assert(p>=0&&p<=100);previous=p;
    assert(Math.abs(p+performanceRatioPenalty(100,x,50)-100)<1e-10);
  }
});

test('ratio scoring distinguishes actual margins when percentile ranks stay identical',t=>{
  const s=fixture(t);game(s,800,{values:{101:{DestructionScore:10,DamageDealt:10},102:{DestructionScore:100,DamageDealt:100},103:{DestructionScore:200,DamageDealt:200}}});
  const low=first(compare(s));
  game(s,800,{values:{101:{DestructionScore:80,DamageDealt:80},102:{DestructionScore:100,DamageDealt:100},103:{DestructionScore:200,DamageDealt:200}}});
  const higher=first(compare(s));
  for(const key of ['exchange','output']){
    assert.equal(part(low.previous,key).average,part(higher.previous,key).average);
    assert(part(higher.trial,key).average<part(low.trial,key).average);
  }
  const expected=.6*performanceRatioPenalty(80,150,500)+.4*performanceRatioPenalty(80,150,50);
  assert(Math.abs(part(higher.trial,'output').average-expected)<1e-10);
  assert.equal(part(higher.trial,'exchange').average,performanceRatioPenalty(80,1000,500));
  game(s,800,{values:{101:{DestructionScore:80,DamageDealt:80},102:{DestructionScore:100,DamageDealt:100},103:{DestructionScore:200,DamageDealt:200},201:{DestructionScore:999999,DamageDealt:999999}}});
  assert.deepEqual(first(compare(s)),higher);
});

test('ratio changes only the three main scales and keeps previous food, victory, discipline and sampling evidence',t=>{
  const s=fixture(t);game(s,800,{values:{...weak,101:{...weak[101],SupplyPointsConsumedFromAllies:9000,SupplyPointsConsumed:10000,DamageFriendlyFireDealt:2}},winner:0});
  const c=compare(s);
  assert.equal(c.previous.model.version,'zhanfan-v3-trial2');assert.equal(c.trial.model.version,'zhanfan-v3-ratio-trial');
  for(const key of ['dimensions','calibration','sentencing','freeloading','prior_games'])assert.deepEqual(ZHANFAN_TRIAL_MODEL[key],ZHANFAN_PERCENTILE_TRIAL_MODEL[key]);
  for(const r of c.members){
    for(const key of ['scored_matches','outcome_matches','wins','losses','skipped','freeloading'])assert.deepEqual(r.trial[key],r.previous[key]);
    for(const key of ['victory','discipline','dependency'])assert.deepEqual(part(r.trial,key),part(r.previous,key));
    if(r.comparable){assert.equal(r.delta_previous_months,r.trial.sentence_months-r.previous.sentence_months);assert(Math.abs(r.delta_previous_score-(r.trial.score-r.previous.score))<.00001);}
  }
  assert.equal(c.ranges.previous.min,Math.min(...c.members.filter(r=>r.comparable).map(r=>r.previous.score)));
  const pending=compare(s,'court_min_games=10000');
  for(const r of pending.members){assert.equal(r.delta_previous_score,null);assert.equal(r.delta_previous_months,null);}
  assert.deepEqual(pending.ranges.trial,{min:null,max:null,sd:null});
});

test('sparse objectives do not produce infinities, and a single capture is smoothed rather than granting full credit',t=>{
  const s=fixture(t);game(s,800,{values:{101:{ObjectivesCaptured:0},102:{ObjectivesCaptured:0},103:{ObjectivesCaptured:0}}});
  assert.equal(part(first(compare(s)).trial,'contribution').average,50);
  game(s,800,{values:{101:{ObjectivesCaptured:1},102:{ObjectivesCaptured:0},103:{ObjectivesCaptured:0}}});
  assert.equal(part(first(compare(s)).trial,'contribution').average,20);
  assert(compare(s).trial.members.filter(r=>r.score!==null).every(r=>Number.isFinite(r.score)));
});

test('not supplying teammates is not a trial offence and donations do not replace combat or objective performance',t=>{
  const s=fixture(t);game(s);const before=first(compare(s));
  game(s,800,{values:{101:{SupplyPointsConsumedByAllies:20000}}});const after=first(compare(s));
  for(const k of ['output','contribution']){
    assert(part(after.current,k).average<part(before.current,k).average);
    assert.equal(part(after.trial,k).average,part(before.trial,k).average);
  }
  assert.equal(after.trial.score,before.trial.score);
  assert.equal(part(after.trial,'dependency').points,0);
  assert(!after.trial.components.some(c=>c.key==='logistics'));
  assert.equal(part(after.trial,'victory').weight,20);
});

test('freeloading requires both excess teammate dependency and low contribution, with a neutral safe zone',()=>{
  const food=(received,supplied,contribution,consumed=10000)=>freeloadingEvidence({received,supplied,consumed},contribution);
  assert.equal(food(0,0,0).penalty,0);
  assert.equal(food(3500,0,0).penalty,0);
  assert.equal(food(8000,0,60).penalty,0);
  assert.equal(food(8000,0,90).penalty,0);
  assert.equal(food(8000,8000,0).penalty,0);
  assert.equal(food(8000,10000,0).penalty,0);
  assert.equal(food(0,0,0,0).penalty,0);
  assert.equal(food(300,0,0,300).penalty,0);
  assert.equal(food(10000,0,0).penalty,100);
  assert(food(9000,0,20).penalty>food(5000,0,20).penalty);
  assert(food(9000,0,10).penalty>food(9000,0,40).penalty);
  assert(food(9000,3000,20).penalty<food(9000,0,20).penalty);
  assert(food(8000,0,20).penalty>0);
});

test('only low-contribution high-dependency games trigger food penalties and peer supply volume cannot create an offence',t=>{
  const s=fixture(t);const values={...weak,101:{...weak[101],ObjectivesCaptured:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:9000},102:{...weak[102],ObjectivesCaptured:2},103:{...weak[103],ObjectivesCaptured:3}};
  game(s,800,{values});const weakFood=first(compare(s)).trial;
  assert(part(weakFood,'dependency').average>0);assert.equal(weakFood.freeloading.penalized_matches,1);assert.equal(weakFood.freeloading.dependent_matches,1);
  game(s,800,{values:{...values,101:{...values[101],ObjectivesCaptured:10}}});
  const capture=first(compare(s)).trial;assert.equal(part(capture,'dependency').points,0);assert.equal(capture.freeloading.penalized_matches,0);
  game(s,800,{values:{...values,101:{...values[101],DamageDealt:10000,DestructionScore:10000}}});
  assert.equal(part(first(compare(s)).trial,'dependency').points,0);
  game(s,800,{values:{...values,101:{...values[101],SupplyPointsConsumedFromAllies:0},102:{...values[102],SupplyPointsConsumedByAllies:999999}}});
  const noFood=first(compare(s)).trial;assert.equal(part(noFood,'dependency').points,0);assert.equal(noFood.freeloading.penalized_matches,0);
  assert.equal(noFood.scored_matches,1);
});

test('food merges alts within each game but teammate supply cannot pay off penalties in another game',t=>{
  const s=fixture(t),v={...weak,101:{...weak[101],ObjectivesCaptured:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:9000},102:{...weak[102],ObjectivesCaptured:2},103:{...weak[103],ObjectivesCaptured:3}};
  game(s,800,{values:v});const before=first(compare(s)).trial;
  game(s,800,{ids:[101,104,102,103,201],values:{...v,
    101:{...v[101],DestructionScore:5,LossesScore:500,DamageDealt:.5,SupplyPointsConsumed:5000,SupplyPointsConsumedFromAllies:4500},
    104:{...v[101],DestructionScore:5,LossesScore:500,DamageDealt:.5,SupplyPointsConsumed:5000,SupplyPointsConsumedFromAllies:4500}}});
  assert.deepEqual(first(compare(s)).trial,before);
  game(s,801,{values:{101:{SupplyPointsConsumedByAllies:900000}}});
  const after=first(compare(s)).trial;assert.equal(after.freeloading.penalized_matches,1);assert.equal(after.freeloading.net_received,9000);
  assert.equal(part(after,'dependency').average,part(before,'dependency').average/2);
  assert(part(after,'dependency').points>0);
});

test('heavy and actual air loadout kills give bounded personal compensation, never stacked or inferred from enemy kills',t=>{
  const s=fixture(t);game(s,800,{values:weak});const base=first(compare(s)).trial;
  game(s,800,{values:weak,units:{101:{1:heavy(10)},102:{1:heavy(1)},201:{1:heavy(999)}}});
  const h=first(compare(s)).trial;assert(Math.abs(part(base,'output').average-part(h,'output').average-15)<1e-10);
  assert.equal(h.specialist.credited_matches,1);
  game(s,800,{values:weak,units:{101:{1:heavy(10),2:heavy(10,901)},102:{1:heavy(1),2:heavy(1,901)},201:{1:heavy(0)}}});
  const both=first(compare(s)).trial;assert.deepEqual(both,h);
  game(s,800,{values:weak,units:{101:{1:heavy(10,901)},102:{1:heavy(1,901)}}});
  assert.deepEqual(first(compare(s)).trial,h);
  const d=game(s,800,{values:weak,units:{101:{1:{...heavy(10,901),OptionIds:[101,200]}},102:{1:heavy(1,901)}}});
  assert.equal(part(first(compare(s)).trial,'output').average,part(base,'output').average);
  d.data.Data['101'].UnitData['1'].OptionIds=[999,200];s.saveDetail('800',d);
  const unknown=first(compare(s)).trial;assert.equal(unknown.scored_matches,1);assert.equal(unknown.specialist.credited_matches,0);
});

test('unknown teammate unit classifications disable specialist compensation but do not discard base-scoring games',t=>{
  const s=fixture(t);game(s,800,{values:weak,units:{101:{1:heavy(10)},102:{1:heavy(1,999)}}});
  const r=first(compare(s));assert.equal(r.current.scored_matches,1);assert.equal(r.trial.scored_matches,1);
  assert.equal(r.trial.specialist.unavailable_matches,1);assert.equal(r.trial.specialist.credited_matches,0);
  game(s,800,{values:weak,units:{101:{1:heavy(10)},102:{1:heavy(-1)}}});
  assert.equal(first(compare(s)).trial.specialist.credited_matches,0);
});

test('trial merges alternate accounts and scopes every new evidence item to the same match filters',t=>{
  const s=fixture(t);game(s,800,{values:weak,units:{101:{1:heavy(10)}}});const before=first(compare(s));
  game(s,800,{ids:[101,104,102,103,201],values:{...weak,101:{DestructionScore:5,LossesScore:500,DamageDealt:.5,ObjectivesCaptured:.5,SupplyPointsConsumed:500},104:{DestructionScore:5,LossesScore:500,DamageDealt:.5,ObjectivesCaptured:.5,SupplyPointsConsumed:500}},units:{101:{1:heavy(5)},104:{1:heavy(5)}}});
  assert.deepEqual(first(compare(s)),before);
  game(s,801,{mode:1,map:28,values:weak,units:{101:{1:heavy(1000)}}});
  assert.deepEqual(first(compare(s,'court_min_games=1&mode=0')),before);
  assert.deepEqual(first(compare(s,'court_min_games=1&map=4')),before);
  assert.deepEqual(first(compare(s,'court_min_games=1&member=1&q=800')),before);
  const pending=first(compare(s,'court_min_games=3'));assert.equal(pending.comparable,false);assert.equal(pending.delta_months,null);
});

test('trial wins retain independent sample shrinkage, invalid data exclusions and fixed thresholds',t=>{
  const s=fixture(t);game(s,800,{winner:0});game(s,801,{winner:1});game(s,802,{winner:-1});game(s,803,{complete:false});
  const r=first(compare(s));assert.equal(r.trial.outcome_matches,2);assert.equal(r.trial.scored_matches,3);
  assert.equal(part(r.trial,'victory').penalty,50);assert.deepEqual(r.trial.skipped,r.current.skipped);
  assert.deepEqual(r.trial.components.filter(c=>c.key==='victory').map(c=>c.samples),[2]);
  assert.equal(r.trial.sentence_months!==null,true);assert.deepEqual(ZHANFAN_TRIAL_MODEL.sentencing,{acquittal_score:25,life_score:85,exponent:1.4});
  const d=game(s,804);d.data.Data['101'].DamageDealt=null;s.saveDetail('804',d);
  const invalid=first(compare(s));assert.equal(invalid.trial.scored_matches,3);assert.equal(invalid.trial.skipped.invalid_data,1);
});

test('comparison UI exposes trial status, raw evidence and safe sortable values without changing personal verdict UI',t=>{
  const s=fixture(t);game(s,800,{values:weak,units:{101:{1:heavy(10)}}});
  s.run('UPDATE members SET name=? WHERE id=1','<script>alert(1)</script>');
  const c=compare(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,fmt:n=>n==null?'—':String(n),icon:()=>'',empty:()=>''});
  const html=ui.courtView(c);assert(html.includes('草案 · 未替换现行判决'));assert(html.includes('量刑分项'));assert(html.includes('专长补偿 1 / 1 局'));
  assert(html.includes('蹭饭罚分'));assert(html.includes('净依赖超线'));assert(html.includes('不送补给不扣分'));
  assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('court-ratio-comparison'));
  assert(html.includes('上版试算刑期'));assert(html.includes('比值试算刑期'));assert(html.includes('标准差'));assert(html.includes('较上版指数变化'));
  assert(ui.courtView(c.current).includes('蘸饭刑期榜'));assert(!ui.courtPanel({model:c.current.model,min_games:1,report:c.current.members[0]}).includes('新旧量刑试算'));
});
