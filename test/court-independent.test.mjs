import test from 'node:test';
import assert from 'node:assert/strict';
import { independentEvidence, independentRatioPenalty as penalty } from '../src/court-model.mjs';
import { ZHANFAN_INDEPENDENT_MODEL as MODEL, independentZhanfanAnalysis as zhanfanAnalysis, independentZhanfanComparison as zhanfanComparison, zhanfanAnalysis as currentAnalysis, contextZhanfanAnalysis, sentenceMonths } from '../src/zhanfan.mjs';
import { testStore, member, rawMatch, detailFor, airUnit } from './helpers.mjs';
import { compileAirUnit } from '../src/air-superiority.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

const base={destruction:4000,losses:4000,damage:1000,objectives:0,friendly_fire:0,supplied:0,received:0,consumed:10000};
const units=(heavy=0,air=0)=>({heavy:{known:true,kills:heavy},air:{known:true,kills:air}});
const person=(key,values={},e=units())=>({key,values:{...base,...values},unit_evidence:e});
function evidence(values={},e=units(),peers=[person('B'),person('C')]) {
  const g=person('A',values,e);return independentEvidence(g,[g,...peers],MODEL);
}
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('fixed ratio meanings and neutral reference are specified independently of the player archive',()=>{
  for(const [ratio,expected]of [[.25,100],[.5,75],[1,50],[2,25],[4,0]])near(penalty(ratio,1,0),expected);
  assert.equal(penalty(0,0,0),50);assert.equal(penalty(0,1,0),100);assert.equal(penalty(1,0,0),0);
  assert.equal(penalty(0,0,500),50);near(penalty(1500,500,500),25);
  for(const v of [null,NaN,Infinity,-1,'10',1e300])assert.equal(penalty(v,1,0),null);
  assert.equal(MODEL.version,'zhanfan-v5-independent');assert.equal(MODEL.dimensions.reduce((n,d)=>n+d.weight,0),100);
  assert.equal(MODEL.dimensions.reduce((n,d)=>n+d.prior*d.weight/100,0),42.5);
  for(const b of MODEL.benchmarks){
    near(b.score,penalty(b.ratio,1,0)*.6+(1-b.win_rate)*25);
    assert.equal(b.sentence_months,sentenceMonths(b.score));
  }
  assert.equal(MODEL.benchmarks[0].score,MODEL.sentencing.acquittal_score);
});

test('combat and exchange have independent nonzero baselines rather than a common shortfall gate',()=>{
  const normal=evidence();near(normal.penalties.pressure,50);near(normal.penalties.exchange,50);
  assert.equal(normal.penalties.dependency,0);assert.equal(normal.penalties.discipline,0);
  const costly=evidence({destruction:20000,losses:50000,damage:10000});
  near(costly.penalties.pressure,0);assert(costly.penalties.exchange>50);
  const efficientButQuiet=evidence({destruction:100,losses:0,damage:0});
  assert(efficientButQuiet.penalties.pressure>75);assert(efficientButQuiet.penalties.exchange<50);
  const moreKills=evidence({destruction:20000});
  assert(moreKills.penalties.pressure<normal.penalties.pressure);assert(moreKills.penalties.exchange<normal.penalties.exchange);
});

test('net supply surcharge remains contextual while not donating never creates a separate penalty',()=>{
  const healthy=evidence({received:10000});assert.equal(healthy.penalties.dependency,0);
  const weak={destruction:0,damage:0,received:8000};const food=evidence(weak);
  assert(food.penalties.dependency>0);
  near(food.penalties.dependency,100*((.8-.35)/.65)*((food.penalties.pressure-50)/50));
  assert.equal(evidence({...weak,received:3500}).penalties.dependency,0);
  assert.equal(evidence({...weak,supplied:8000}).penalties.dependency,0);
  const donated=evidence({supplied:100000});assert.deepEqual(donated.penalties,evidence().penalties);
  const peerDonations=evidence(weak,units(),[person('B',{supplied:100000}),person('C')]);
  assert.deepEqual(peerDonations.penalties,food.penalties);
});

test('objective and specialist credits are capped, not stacked, and cannot erase a large resource exchange penalty',()=>{
  const weak={destruction:0,damage:0,losses:10000,received:10000};
  const none=evidence(weak),one=evidence({...weak,objectives:1}),many=evidence({...weak,objectives:100});
  near(one.evidence.support_credit,10);near(many.evidence.support_credit,20);
  for(const key of ['pressure','exchange']){
    near(none.penalties[key]-many.penalties[key],20);assert(many.penalties[key]>=75);
  }
  const heavy=evidence(weak,units(10)),air=evidence(weak,units(0,10)),both=evidence({...weak,objectives:100},units(10,10));
  assert.deepEqual(heavy.penalties,air.penalties);assert.deepEqual(heavy.penalties,both.penalties);
  near(heavy.evidence.relief_points,12);assert.equal(evidence(weak,units()).support.credit,0);
  const unknown=units();unknown.heavy.known=false;
  const missing=evidence(weak,units(10),[person('B',{},unknown),person('C')]);
  assert.deepEqual(missing.penalties,none.penalties);assert.equal(missing.evidence.unavailable_specialists,1);
});

test('individual behaviour is monotone, bounded, independent of enemy evidence, and zero activity is not judged',()=>{
  let previous=null;
  for(let x=0;x<=10000;x+=100){
    const r=evidence({destruction:x,damage:x/4,received:10000,losses:10000,objectives:1});
    for(const n of Object.values(r.penalties))assert(Number.isFinite(n)&&n>=0&&n<=100);
    if(previous)for(const key of ['pressure','exchange','dependency'])assert(r.penalties[key]<=previous.penalties[key]+1e-9);
    previous=r;
  }
  assert(evidence({losses:10000}).penalties.exchange>evidence({losses:1000}).penalties.exchange);
  assert(evidence({friendly_fire:100}).penalties.discipline>evidence({friendly_fire:1}).penalties.discipline);
  const zero={destruction:0,damage:0,objectives:0};
  assert.equal(independentEvidence(person('A',zero),[person('A',zero),person('B',zero)],MODEL),null);
});

function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','900',JSON.stringify({id:900,role:15}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','901',JSON.stringify({id:901,role:164}),'now');
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify({units:{901:compileAirUnit(airUnit(901))}}));
  return s;
}
const fields={destruction:'DestructionScore',losses:'LossesScore',damage:'DamageDealt',objectives:'ObjectivesCaptured',friendly_fire:'DamageFriendlyFireDealt',supplied:'SupplyPointsConsumedByAllies',received:'SupplyPointsConsumedFromAllies',consumed:'SupplyPointsConsumed'};
function game(s,id,{values={},ids=[101,102,103,201],teams={},winner=-1,mode=0,map=4,units={},complete=true,duration=1800}={}){
  const raw=rawMatch(ids,{WinnerTeam:winner,MapId:map,Type:mode,TotalPlayTimeInSec:duration});
  for(const p of Object.values(raw.Data))p.TeamId=teams[p.Id]??(p.Id===201?1:0);
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const [id,p]of Object.entries(d.data.Data)){
    for(const [key,field]of Object.entries(fields))p[field]=base[key];
    Object.assign(p,values[id]);p.UnitData=units[id]??{};
  }
  if(complete)s.saveDetail(String(id),d);return d;
}
const report=(s,q='court_min_games=1')=>zhanfanAnalysis(s,new URLSearchParams(q)).members.find(r=>r.member_id===1);
const weak={DestructionScore:0,LossesScore:10000,DamageDealt:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:10000};

test('equal and unknown-result evidence stays neutral at 42.5, while empty archives remain unjudged',t=>{
  const s=fixture(t);const empty=report(s);assert.equal(empty.score,null);assert.equal(empty.sentence_months,null);
  for(let i=0;i<20;i++)game(s,800+i);
  const r=report(s);assert.equal(r.score,42.5);assert.equal(r.sentence_months,sentenceMonths(42.5));
  assert.equal(r.outcome_matches,0);assert.equal(r.components.find(c=>c.key==='victory').samples,0);
  assert.equal(r.components.find(c=>c.key==='victory').penalty,50);
  assert.equal(r.context.exchange_matches,0);assert.equal(r.context.imbalanced_matches,0);
});

test('actual terms, independent win samples, personal parity and v4 comparison all use the default v5',t=>{
  const s=fixture(t);for(let i=0;i<40;i++){
    game(s,800+i,{values:{101:weak},winner:0,map:4});game(s,900+i,{values:{101:weak},winner:1,map:28});
  }
  const wins=report(s,'map=4'),losses=report(s,'map=28');
  assert(wins.score>25);assert(losses.score>wins.score);assert(losses.sentence_months>wins.sentence_months);
  assert.equal(wins.components.find(c=>c.key==='victory').penalty,10);assert.equal(losses.components.find(c=>c.key==='victory').penalty,90);
  assert.deepEqual(wins.components.filter(c=>c.key!=='victory'),losses.components.filter(c=>c.key!=='victory'));
  assert.equal(wins.context.risk_examples.length,3);assert(wins.context.risk_examples.every(e=>e.combat_base>50&&e.exchange_base>50));
  const p=new URLSearchParams('map=4');assert.deepEqual(friendAnalysis(s,1,p).court.report,currentAnalysis(s,p).members.find(r=>r.member_id===1));
  const c=zhanfanComparison(s,p);assert.equal(c.current.model.version,'zhanfan-v5-independent');
  assert.deepEqual(c.previous,contextZhanfanAnalysis(s,p));assert.equal(c.previous.model.version,'zhanfan-v4-context');
  assert.equal(c.members.find(r=>r.member_id===1).delta_months,wins.sentence_months-c.previous.members.find(r=>r.member_id===1).sentence_months);
});

test('sustained extreme evidence can reach lifetime without a percentile transform or forcing a cohort rank',t=>{
  const s=fixture(t);for(let i=0;i<80;i++)game(s,800+i,{winner:1,values:{101:{...weak,DamageFriendlyFireDealt:1000}}});
  const r=report(s);assert(r.score>=85);assert.equal(r.sentence,'无期徒刑');assert.equal(r.rank,1);
  member(s,'New empty friend');assert.deepEqual(report(s),r);
});

test('strong sustained performance can still be acquitted and a one-game estimate cannot enter default standings',t=>{
  const s=fixture(t),strong={DestructionScore:20000,LossesScore:4000,DamageDealt:10000};
  game(s,800,{values:{101:strong},winner:0});
  assert.equal(report(s,'court_min_games=5').eligible,false);
  for(let i=1;i<30;i++)game(s,800+i,{values:{101:strong},winner:i%5===0?1:0});
  const r=report(s);assert(r.score<=25);assert.equal(r.sentence_months,0);assert.equal(r.sentence,'当庭释放');
});

test('donating in another game never erases a food incident and omitted protobuf scalars remain genuine zero',t=>{
  const s=fixture(t),d=game(s,800,{values:{101:weak}});
  delete d.data.Data['101'].DamageFriendlyFireDealt;s.saveDetail('800',d);
  const a=report(s);assert(a.freeloading.penalized_matches>0);
  game(s,801,{values:{101:{SupplyPointsConsumedByAllies:100000}}});
  const b=report(s);assert.equal(b.freeloading.penalized_matches,a.freeloading.penalized_matches);
  assert.equal(b.freeloading.net_received,a.freeloading.net_received);
  near(b.context.risk_examples.find(e=>e.match_id==='800').penalties.dependency,a.context.risk_examples[0].penalties.dependency);
});

test('scope, safe exclusions, unknown outcomes, alts and minimum samples retain their contracts',t=>{
  const s=fixture(t);game(s,800,{values:{101:weak}});const before=report(s);
  game(s,800,{values:{101:weak,201:{DestructionScore:99999999,DamageDealt:99999999}}});assert.deepEqual(report(s),before);
  const half=Object.fromEntries(Object.entries(weak).map(([k,v])=>[k,v/2]));
  game(s,800,{ids:[101,104,102,103,201],values:{101:half,104:half}});assert.deepEqual(report(s),before);
  game(s,801,{ids:[101,104,102,103],teams:{104:1}});assert.equal(report(s).skipped.ambiguous_team,1);
  const d=game(s,802);d.data.Data['101'].DamageFriendlyFireDealt=null;s.saveDetail('802',d);assert.equal(report(s).skipped.invalid_data,1);
  game(s,803,{complete:false});assert.equal(report(s).skipped.missing_detail,1);
  game(s,804,{map:28,mode:1});assert.equal(report(s,'mode=1').scored_matches,1);assert.equal(report(s,'map=28').scored_matches,1);
  assert.equal(report(s,'q=800').scored_matches,1);assert.equal(report(s,'q=800&court_min_games=5').eligible,false);
  assert.equal(report(s,'q=800').components.find(c=>c.key==='victory').samples,0);
});

test('actual loadouts credit their owner only and incomplete classification never fabricates relief',t=>{
  const s=fixture(t),plane=options=>({Id:901,KilledCount:10,OptionIds:options});
  game(s,800,{values:{101:weak},units:{101:{a:plane([100,200])}}});const air=report(s);
  assert.equal(air.context.specialist_relief_matches,1);near(air.context.relief_examples[0].support_credit,20);
  game(s,800,{values:{101:weak},units:{101:{a:plane([101,200])}}});const bomb=report(s);
  assert.equal(bomb.context.specialist_relief_matches,0);assert(bomb.score>air.score);
  game(s,800,{values:{101:weak},units:{102:{h:{Id:900,KilledCount:10}}}});assert.equal(report(s).context.specialist_relief_matches,0);
  game(s,800,{values:{101:weak},units:{101:{h:{Id:900,KilledCount:10}},102:{u:{Id:999999,KilledCount:10}}}});
  assert.equal(report(s).context.specialist_relief_matches,0);
});

test('UI labels v4 versus v5 correctly and exposes fixed benchmarks, independent raw evidence and safe names',t=>{
  const s=fixture(t);s.run('UPDATE members SET name=? WHERE id=1','<script>Unsafe</script>');
  for(let i=0;i<5;i++)game(s,800+i,{values:{101:weak}});
  const data=zhanfanAnalysis(s),r=data.members.find(r=>r.member_id===1);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:n=>n==null?'—':String(n),empty:()=>''});
  const panel=ui.courtPanel({model:data.model,min_games:data.min_games,report:r});
  assert(panel.includes(r.sentence));assert(panel.includes('固定量刑参照'));assert(panel.includes('42.5'));assert(panel.includes('补给项最终'));
  assert(panel.includes('href="#match/800"'));assert(panel.includes('战斗罚分'));assert(panel.includes('交换罚分'));
  const table=ui.courtView(data),c=ui.courtView(zhanfanComparison(s));
  for(const html of [table,c]){assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(!html.includes('undefined'));assert(!html.includes('NaN'));}
  assert(c.includes('旧版 v4 刑期'));assert(c.includes('现行 v5 刑期'));assert(c.includes('不再共同乘贡献缺口'));
});
