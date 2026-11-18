import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { independentRatioPenalty } from '../src/court-model.mjs';
import { overcapZhanfanAnalysis as zhanfanAnalysis, overcapZhanfanComparison as zhanfanComparison, zhanfanAnalysis as currentAnalysis, coreZhanfanAnalysis, overcapZhanfanAnalysis, createOvercapModel, sentenceMonths } from '../src/zhanfan.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const weak={DestructionScore:0,DamageDealt:0,LossesScore:3500};
function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');return s;
}
function game(s,id,{winner=0,values={},map=4,mode=0,ids=[101,102,103,201]}={}){
  const raw=rawMatch(ids,{WinnerTeam:winner,MapId:map,Type:mode,TotalPlayTimeInSec:1800});
  for(const p of Object.values(raw.Data))p.TeamId=p.Id===201?1:0;
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const [id,p]of Object.entries(d.data.Data))Object.assign(p,{DestructionScore:3500,LossesScore:3500,DamageDealt:350,ObjectivesCaptured:0,DamageFriendlyFireDealt:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:0,SupplyPointsConsumedByAllies:0,UnitData:{}},values[id]);
  s.saveDetail(String(id),d);return d;
}
const params=new URLSearchParams('court_min_games=1&mode=0');
const report=(s,cap=150)=>overcapZhanfanAnalysis(s,params,cap).members.find(r=>r.member_id===1);

test('overcap extends only the severe end of the logarithmic item scale',()=>{
  for(const [ratio,expected]of [[4,0],[2,25],[1,50],[.5,75],[.25,100],[.125,125],[.0625,150]]){
    near(independentRatioPenalty(ratio,1,0,150),expected);
    near(independentRatioPenalty(ratio,1,0),Math.min(100,expected));
  }
  near(independentRatioPenalty(0,0,500,150),50);
  near(independentRatioPenalty(0,1,0,150),150);
  near(independentRatioPenalty(1,0,0,150),0);
  for(const cap of [null,99,201,150.5,NaN,Infinity])assert.equal(independentRatioPenalty(0,1,500,cap),null);
  let previous=150;
  for(const own of [0,1,100,500,1000,4000,16000,1e9]){
    const p=independentRatioPenalty(own,4000,500,150);assert(p>=0&&p<=previous);previous=p;
  }
});

test('the cap is explicit, bounded, adjustable and shared with benchmark metadata',()=>{
  assert.equal(createOvercapModel().context.score_cap,150);
  for(const cap of [100,125,150,175,200]){
    const m=createOvercapModel(cap);assert.equal(m.version,'zhanfan-v7-overcap');
    for(const b of m.benchmarks){
      assert(b.raw_core<=cap);near(b.raw_core,independentRatioPenalty(b.ratio,1,0,cap));
      near(b.score,Math.max(0,Math.min(100,b.raw_core+20*(.5-b.win_rate))));
      assert.equal(b.sentence_months,sentenceMonths(b.score));
    }
  }
  for(const cap of [99,201,100.5,'150',null,NaN])assert.throws(()=>createOvercapModel(cap),RangeError);
});

test('20 games, 80% wins and no extra offences can reach 96 rather than the old 79.3',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{winner:i<16?0:1,values:{101:weak}});
  const r=report(s),old=coreZhanfanAnalysis(s,params).members.find(r=>r.member_id===1);
  near(r.win_rate,80);near(r.score_breakdown.core,100);near(r.score,96);near(old.score,79.3);
  near(r.components.find(c=>c.key==='victory').points,-4);
  near(r.components.find(c=>c.key==='dependency').points,0);near(r.components.find(c=>c.key==='discipline').points,0);
  assert.equal(r.freeloading.penalized_matches,0);assert.equal(r.sentence,'无期徒刑');
  for(const e of r.context.risk_examples){near(e.combat_penalty,125);near(e.exchange_penalty,125);near(e.core_points,125);assert.equal(e.item_cap,150);}
});

test('cap100 recovers v6 numerics and raising caps is monotone on identical archives',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{winner:i<16?0:1,values:{101:weak}});
  const old=coreZhanfanAnalysis(s,params).members.find(r=>r.member_id===1),restored=report(s,100);
  for(const key of ['score','raw_score','sentence_months','scored_matches','win_rate'])assert.equal(restored[key],old[key]);
  assert.deepEqual(restored.components,old.components);
  assert.deepEqual(restored.context.risk_examples[0].penalties,old.context.risk_examples[0].penalties);
  let previous=0;for(const cap of [100,110,125,150,175,200]){const r=report(s,cap);assert(r.score>=previous);previous=r.score;}
});

test('equal and moderately weak evidence is unchanged, with no second surcharge above50',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{winner:i%2,values:{101:{DestructionScore:1500,DamageDealt:150,LossesScore:3500}}});
  const r=report(s),old=coreZhanfanAnalysis(s,params).members.find(r=>r.member_id===1);
  near(r.score,old.score);near(r.score_breakdown.core,old.score_breakdown.core);assert.deepEqual(r.components,old.components);
  for(const c of r.components.filter(c=>c.kind==='core'))assert(c.penalty<=100);
});

test('raw over100 evidence is retained until the final sum while supply remains bounded',t=>{
  const s=fixture(t);for(let i=0;i<50;i++)game(s,800+i,{winner:1,values:{101:{DestructionScore:0,DamageDealt:0,LossesScore:100000,SupplyPointsConsumedFromAllies:10000,DamageFriendlyFireDealt:1000},102:{DestructionScore:100000,DamageDealt:10000},103:{DestructionScore:100000,DamageDealt:10000}}});
  const r=report(s);assert(r.score_breakdown.core>100);assert(r.score_breakdown.before_clamp>100);assert.equal(r.score,100);
  near(r.components.reduce((sum,c)=>sum+c.points,0),r.score_breakdown.before_clamp);
  for(const e of r.context.risk_examples){near(e.combat_base,150);near(e.exchange_base,150);assert(e.penalties.dependency<=100);assert(e.penalties.discipline<=100);}
  assert(r.components.find(c=>c.key==='dependency').points<=8);assert(r.components.find(c=>c.key==='discipline').points<=4);
});

test('empty archives stay unjudged, small samples shrink, and strong sustained evidence retains acquittal',t=>{
  const s=fixture(t);assert.equal(report(s).score,null);assert.equal(report(s).score_breakdown.ceiling_without_extras,null);
  const worst={DestructionScore:0,DamageDealt:0,LossesScore:100000};
  for(let i=0;i<5;i++)game(s,800+i,{winner:1,values:{101:worst,102:{DestructionScore:100000,DamageDealt:10000},103:{DestructionScore:100000,DamageDealt:10000}}});
  const small=report(s);near(small.score,86.7);assert.equal(small.status,'初步判决');
  for(let i=0;i<50;i++)game(s,1000+i,{map:28,winner:0,values:{101:{DestructionScore:100000,DamageDealt:100000,LossesScore:0}}});
  const strong=zhanfanAnalysis(s,new URLSearchParams('map=28')).members.find(r=>r.member_id===1);
  assert.equal(strong.score,0);assert.equal(strong.sentence,'当庭释放');
});

test('support credit is still limited and does not stack or manufacture specialist evidence',t=>{
  const s=fixture(t);game(s,800,{values:{101:{...weak,ObjectivesCaptured:2}}});
  const e=report(s).context.relief_examples[0];near(e.support_credit,20);near(e.combat_penalty,105);near(e.exchange_penalty,105);near(e.relief_points,20);
  assert.equal(e.values.heavy_kills,undefined);
});

test('v7 personal parity, v6 comparison, alternate-account grouping and filters remain intact',t=>{
  const s=fixture(t);game(s,800,{values:{101:weak}});const before=report(s);
  game(s,800,{ids:[101,104,102,103,201],values:{101:{...weak,LossesScore:1750,SupplyPointsConsumed:5000},104:{...weak,LossesScore:1750,SupplyPointsConsumed:5000}}});
  assert.deepEqual(report(s),before);
  const current=zhanfanAnalysis(s,params);assert.deepEqual(friendAnalysis(s,1,params).court.report,currentAnalysis(s,params).members.find(r=>r.member_id===1));
  const c=zhanfanComparison(s,params);assert.deepEqual(c.current,current);assert.deepEqual(c.previous,coreZhanfanAnalysis(s,params));
  game(s,801,{mode:1});assert.equal(report(s).scored_matches,1);
  member(s,'New empty');assert.deepEqual(report(s),before);
});

test('v7 UI exposes item150 and weighted limits90/60, and distinguishes raw core from final100',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{winner:i<16?0:1,values:{101:weak}});
  s.run('UPDATE members SET name=? WHERE id=1','<script>Name</script>');
  const data=zhanfanAnalysis(s),r=data.members.find(r=>r.member_id===1);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:(n,d=0)=>n==null?'—':String(Number(n.toFixed(d))),empty:()=>''});
  const panel=ui.courtPanel({model:data.model,min_games:5,report:r});
  for(const text of ['罚分100/150',' / 90',' / 60','核心单局 125 / 150','裁剪前','96','不是任何被告的真实数据'])assert(panel.includes(text),text);
  for(const html of [panel,ui.courtView(data),ui.courtView(zhanfanComparison(s))]){
    assert(!html.includes('NaN'));assert(!html.includes('undefined'));assert(!html.includes('<script>'));assert(html.includes('zhanfan-v7-overcap'));
  }
  const compare=ui.courtView(zhanfanComparison(s));assert(compare.includes('旧版 v6 刑期'));assert(compare.includes('现行 v7 刑期'));assert(compare.includes('&lt;script&gt;'));
});
