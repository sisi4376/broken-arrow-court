import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { coreZhanfanAnalysis as zhanfanAnalysis, coreZhanfanComparison as zhanfanComparison, zhanfanAnalysis as currentAnalysis, independentZhanfanAnalysis, ZHANFAN_CORE_MODEL as MODEL, sentenceMonths } from '../src/zhanfan.mjs';
import { independentRatioPenalty } from '../src/court-model.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const weak={DestructionScore:0,LossesScore:4000,DamageDealt:0};
function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');return s;
}
function game(s,id,{winner=-1,values={},ids=[101,102,103,201],teams={},map=4,mode=0,complete=true,duration=1800}={}){
  const raw=rawMatch(ids,{WinnerTeam:winner,MapId:map,Type:mode,TotalPlayTimeInSec:duration});
  for(const p of Object.values(raw.Data))p.TeamId=teams[p.Id]??(p.Id===201?1:0);
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const [id,p]of Object.entries(d.data.Data))Object.assign(p,{DestructionScore:4000,LossesScore:4000,DamageDealt:1000,ObjectivesCaptured:0,DamageFriendlyFireDealt:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:0,SupplyPointsConsumedByAllies:0,UnitData:{}},values[id]);
  if(complete)s.saveDetail(String(id),d);return d;
}
const report=(s,q='court_min_games=1')=>zhanfanAnalysis(s,new URLSearchParams(q)).members.find(r=>r.member_id===1);

test('v6 reserves the full scale for core performance and uses signed adjustments, not weights normalized to 132',()=>{
  assert.equal(MODEL.version,'zhanfan-v6-core');assert.equal(MODEL.aggregation,'core-adjustments');
  assert.equal(MODEL.dimensions.filter(d=>d.kind==='core').reduce((n,d)=>n+d.weight,0),100);
  assert.deepEqual(MODEL.dimensions.filter(d=>d.kind==='core').map(d=>d.weight),[60,40]);
  for(const b of MODEL.benchmarks){
    near(b.score,Math.max(0,Math.min(100,independentRatioPenalty(b.ratio,1,0)+20*(.5-b.win_rate))));
    assert.equal(b.sentence_months,sentenceMonths(b.score));
  }
});

test('40 games at 50% wins can reach 90 without teammate supply consumption or friendly fire',t=>{
  const s=fixture(t);for(let i=0;i<40;i++)game(s,800+i,{winner:i%2,values:{101:weak}});
  const r=report(s);near(r.score_breakdown.core,90);near(r.score,90);
  assert.equal(r.win_rate,50);assert.equal(r.freeloading.penalized_matches,0);
  for(const key of ['victory','dependency','discipline'])near(r.components.find(c=>c.key===key).points,0);
  near(r.score_breakdown.ceiling_without_extras,90);assert.equal(r.sentence,'无期徒刑');
  assert(r.sensitivity.low_months<=r.sentence_months&&r.sensitivity.high_months>=r.sentence_months);
  const old=independentZhanfanAnalysis(s).members.find(r=>r.member_id===1);assert(old.score<75);
});

test('100 games at 80% wins can reach 90 with no extra offences, so being carried does not cap core severity',t=>{
  const s=fixture(t);for(let i=0;i<100;i++)game(s,800+i,{winner:i%5===0?1:0,values:{101:weak}});
  const r=report(s);near(r.win_rate,80);near(r.score,90);
  assert(r.components.find(c=>c.key==='victory').points<0);
  near(r.components.find(c=>c.key==='dependency').points,0);near(r.components.find(c=>c.key==='discipline').points,0);
  near(r.score_breakdown.ceiling_without_extras,90);
});

test('a fixed moderate win record admits 90 without changing supply or friendly-fire behaviour',t=>{
  const s=fixture(t);for(let i=0;i<63;i++)game(s,800+i,{winner:i<28?0:1,values:{101:weak}});
  const r=report(s);assert(r.score>90);assert(r.score<100);assert.equal(r.context.exchange_matches,63);
  assert.equal(r.freeloading.net_received,0);near(r.components.find(c=>c.key==='discipline').points,0);
  assert.equal(r.score,Math.round(r.score_breakdown.before_clamp*10)/10);near(r.score_breakdown.ceiling_without_extras,r.score_breakdown.before_clamp);
});

test('a handful of matches cannot produce a 90-point verdict and empty archives stay unjudged',t=>{
  const s=fixture(t);const empty=report(s);assert.equal(empty.score,null);assert.equal(empty.score_breakdown.core,null);
  assert.equal(empty.score_breakdown.ceiling_without_extras,null);assert.equal(empty.sentence_months,null);
  game(s,800,{winner:1,values:{101:weak}});assert.equal(report(s,'court_min_games=5').eligible,false);
  for(let i=1;i<5;i++)game(s,800+i,{winner:1,values:{101:weak}});
  assert(report(s).score<=70);assert.equal(report(s).status,'初步判决');
});

test('the same evidence and victories have the same core: results adjust rather than replace it',t=>{
  const s=fixture(t);for(let i=0;i<30;i++){
    game(s,800+i,{map:4,winner:0,values:{101:weak}});game(s,900+i,{map:28,winner:1,values:{101:weak}});
    game(s,1000+i,{map:12,winner:999,values:{101:weak}});
  }
  const win=report(s,'map=4'),loss=report(s,'map=28'),unknown=report(s,'map=12');
  near(win.score_breakdown.core,loss.score_breakdown.core);near(win.score_breakdown.core,unknown.score_breakdown.core);
  near(win.components.find(c=>c.key==='victory').points,-7.5);near(loss.components.find(c=>c.key==='victory').points,7.5);
  near(unknown.components.find(c=>c.key==='victory').points,0);assert.equal(unknown.outcome_matches,0);
  assert(win.score<unknown.score&&unknown.score<loss.score);
});

test('signed corrections are clamped only after summation and strong sustained evidence retains acquittal',t=>{
  const s=fixture(t);for(let i=0;i<100;i++){
    game(s,800+i,{map:4,winner:0,values:{101:{DestructionScore:100000,LossesScore:0,DamageDealt:100000}}});
    game(s,1000+i,{map:28,winner:1,values:{101:{...weak,SupplyPointsConsumedFromAllies:10000,DamageFriendlyFireDealt:1000}}});
  }
  const good=report(s,'map=4'),bad=report(s,'map=28');
  assert(good.score_breakdown.before_clamp<0);assert.equal(good.score,0);assert.equal(good.sentence,'当庭释放');
  assert(bad.score_breakdown.before_clamp>100);assert.equal(bad.score,100);assert.equal(bad.sentence,'无期徒刑');
  for(const r of [good,bad]){
    near(r.components.reduce((sum,c)=>sum+c.points,0),r.score_breakdown.before_clamp);
    near(r.components.filter(c=>c.kind==='core').reduce((sum,c)=>sum+c.points,0),r.score_breakdown.core);
    assert(r.components.filter(c=>c.kind==='adjustment').every(c=>c.points>=-10&&c.points<=10));
  }
});

test('core aggregation preserves raw v5 evidence, personal parity, fixed samples, filters and v5 comparisons',t=>{
  const s=fixture(t);for(let i=0;i<10;i++)game(s,800+i,{values:{101:weak},winner:0});
  const params=new URLSearchParams('mode=0'),r=report(s,'mode=0');
  assert.deepEqual(friendAnalysis(s,1,params).court.report,currentAnalysis(s,params).members.find(r=>r.member_id===1));
  const c=zhanfanComparison(s,params);assert.deepEqual(c.current,zhanfanAnalysis(s,params));
  assert.deepEqual(c.previous,independentZhanfanAnalysis(s,params));
  const p=c.previous.members.find(m=>m.member_id===1);assert.equal(p.scored_matches,r.scored_matches);
  assert.deepEqual(p.context.risk_examples[0].penalties,r.context.risk_examples[0].penalties);
  assert.equal(c.previous.model.version,'zhanfan-v5-independent');assert.equal(c.current.model.version,'zhanfan-v6-core');
  member(s,'New empty friend');assert.deepEqual(report(s,'mode=0'),r);
  game(s,900,{mode:1,map:28});assert.equal(report(s,'mode=0').scored_matches,10);assert.equal(report(s,'mode=1').scored_matches,1);
});

test('alternate accounts and invalid evidence retain safe sample and unknown-value handling',t=>{
  const s=fixture(t);game(s,800,{values:{101:weak}});const before=report(s);
  game(s,800,{ids:[101,104,102,103,201],values:{101:{...weak,LossesScore:2000,SupplyPointsConsumed:5000},104:{...weak,LossesScore:2000,SupplyPointsConsumed:5000}}});
  assert.deepEqual(report(s),before);
  game(s,801,{ids:[101,104,102,103],teams:{104:1}});assert.equal(report(s).skipped.ambiguous_team,1);
  const d=game(s,802);d.data.Data['101'].DamageFriendlyFireDealt=null;s.saveDetail('802',d);assert.equal(report(s).skipped.invalid_data,1);
  game(s,803,{complete:false});assert.equal(report(s).skipped.missing_detail,1);
  game(s,804,{duration:0});assert.equal(report(s).skipped.invalid_data,2);
  const zero={DestructionScore:0,DamageDealt:0,ObjectivesCaptured:0};
  game(s,805,{values:{101:zero,102:zero,103:zero,201:zero}});assert.equal(report(s).skipped.no_activity,1);
});

test('v6 UI presents signed points and ceilings without calling adjustments percentages or inventing labels',t=>{
  const s=fixture(t);s.run('UPDATE members SET name=? WHERE id=1','<script>Name</script>');
  for(let i=0;i<5;i++)game(s,800+i,{winner:0,values:{101:weak}});
  const data=zhanfanAnalysis(s),r=data.members.find(m=>m.member_id===1);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:n=>n==null?'—':String(n),empty:()=>''});
  const panel=ui.courtPanel({model:data.model,min_games:5,report:r});
  assert(panel.includes('±10分'));assert(panel.includes('+8分'));assert(panel.includes('裁剪前'));assert(panel.includes('核心'));
  assert(panel.includes('构造测试，不是任何朋友的真实数据'));assert(panel.includes('href="#match/800"'));
  assert(!panel.includes('20%'));assert(!panel.includes('/ 75'));
  for(const html of [ui.courtView(data),ui.courtView(zhanfanComparison(s))]){
    assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(!html.includes('NaN'));assert(!html.includes('undefined'));
    assert(html.includes('zhanfan-v6-core'));
  }
  const c=ui.courtView(zhanfanComparison(s));assert(c.includes('旧版 v5 刑期'));assert(c.includes('现行 v6 刑期'));
});
