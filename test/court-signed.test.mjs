import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { independentRatioPenalty } from '../src/court-model.mjs';
import { signedZhanfanAnalysis as zhanfanAnalysis, signedZhanfanComparison as zhanfanComparison, zhanfanAnalysis as currentAnalysis, overcapZhanfanAnalysis, ZHANFAN_SIGNED_MODEL as MODEL } from '../src/zhanfan.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const p=(value,reference=1,buffer=0)=>independentRatioPenalty(value,reference,buffer,150,-50,50);
function fixture(t){const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');return s;}
function game(s,id,{values={},winner=-1,map=4,mode=0,ids=[101,102,103,201]}={}){
  const raw=rawMatch(ids,{WinnerTeam:winner,MapId:map,Type:mode,TotalPlayTimeInSec:1800});
  for(const v of Object.values(raw.Data))v.TeamId=v.Id===201?1:0;
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const [id,v]of Object.entries(d.data.Data))Object.assign(v,{DestructionScore:3500,LossesScore:3500,DamageDealt:350,ObjectivesCaptured:0,DamageFriendlyFireDealt:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:0,SupplyPointsConsumedByAllies:0,UnitData:{}},values[id]);
  s.saveDetail(String(id),d);return d;
}
const params=new URLSearchParams('mode=0&court_min_games=1');
const mine=s=>zhanfanAnalysis(s,params).members.find(r=>r.member_id===1);

test('signed scale is the linear mapping of old0..100 to -50..150, not merely wider caps',()=>{
  for(const [ratio,expected]of [[16,-50],[4,-50],[2,0],[1,50],[.5,100],[.25,150],[.0625,150]]){
    near(p(ratio),expected);near(p(ratio),2*independentRatioPenalty(ratio,1,0)-50);
  }
  for(const ratio of [.01,.13,.3,.7,1.2,2.7,100])near(p(ratio),2*independentRatioPenalty(ratio,1,0)-50);
  near(p(0,0,500),50);near(p(0,1),150);near(p(1,0),-50);
  for(const floor of [-101,1,-.5,NaN])assert.equal(independentRatioPenalty(1,1,0,150,floor,50),null);
  for(const slope of [0,-1,NaN,Infinity,'50'])assert.equal(independentRatioPenalty(1,1,0,150,-50,slope),null);
  assert.equal(MODEL.context.slope,50);assert.equal(MODEL.context.score_floor,-50);assert.equal(MODEL.context.score_cap,150);
});

test('negative and over100 core items offset before clipping, across both items and games',t=>{
  const s=fixture(t);
  // Smoothed destruction/damage are 4x peers, but destruction/losses are 1/4.
  const mixed={DestructionScore:15500,DamageDealt:1550,LossesScore:63500};
  game(s,800,{values:{101:mixed}});
  const r=mine(s);near(r.components[0].average,-50);near(r.components[1].average,150);
  near(r.context.risk_examples[0].core_points,30);
  near(r.score_breakdown.core,(30+10*50)/11);
  assert.equal(r.score_breakdown.item_floor,-50);
  for(let i=1;i<20;i++)game(s,800+i,{values:{101:mixed}});
  near(mine(s).score_breakdown.core,(20*30+10*50)/30);
  assert(mine(s).components[0].points<0);
  const across=fixture(t);
  game(across,900,{values:{101:{DestructionScore:15500,DamageDealt:1550,LossesScore:3500}}});
  game(across,901,{values:{101:{DestructionScore:500,DamageDealt:50,LossesScore:3500}}});
  near(mine(across).components[0].average,50);near(mine(across).components[1].average,50);near(mine(across).score,50);
});

test('only the final total clips: extreme strength reaches0, persistent severe behaviour reaches100',t=>{
  const s=fixture(t);
  for(let i=0;i<20;i++){
    game(s,800+i,{map:4,winner:0,values:{101:{DestructionScore:15500,DamageDealt:1550,LossesScore:3500}}});
    game(s,900+i,{map:28,winner:i<16?0:1,values:{101:{DestructionScore:500,DamageDealt:50,LossesScore:3500}}});
  }
  const result=map=>zhanfanAnalysis(s,new URLSearchParams('map='+map)).members.find(r=>r.member_id===1);
  const good=result(4),bad=result(28);
  assert(good.score_breakdown.before_clamp<0);assert.equal(good.score,0);assert.equal(good.sentence,'当庭释放');
  near(bad.score_breakdown.core,350/3);near(bad.score_breakdown.before_clamp,338/3);assert.equal(bad.score,100);assert.equal(bad.sentence,'无期徒刑');
  for(const r of [good,bad])near(r.score_breakdown.before_clamp,r.components.reduce((sum,c)=>sum+c.points,0));
});

test('support never falls below-50 and supply/FF remain bounded independent adjustments',t=>{
  const s=fixture(t);game(s,800,{values:{101:{DestructionScore:15500,DamageDealt:1550,LossesScore:3500,ObjectivesCaptured:2,SupplyPointsConsumedFromAllies:10000}}});
  let r=mine(s);near(r.components[0].average,-50);near(r.components[1].average,-50);near(r.components.find(c=>c.key==='dependency').average,0);
  game(s,801,{values:{101:{DestructionScore:500,DamageDealt:50,LossesScore:3500,ObjectivesCaptured:2,SupplyPointsConsumedFromAllies:10000,DamageFriendlyFireDealt:1000}}});
  r=mine(s);const e=r.context.risk_examples[0];near(e.combat_base,150);near(e.combat_penalty,130);near(e.support_credit,20);
  assert(e.penalties.dependency<=100);assert(e.penalties.discipline<=100);assert(e.relief_points<=20);
});

test('neutral evidence, no evidence, unknown outcomes and the sample prior retain their meanings',t=>{
  const s=fixture(t);assert.equal(mine(s).score,null);
  game(s,800);const r=mine(s);near(r.score,50);near(r.components[0].average,50);assert.equal(r.outcome_matches,0);
  assert.equal(r.score_breakdown.item_floor,-50);assert.equal(r.score_breakdown.item_cap,150);
  assert.equal(r.components.find(c=>c.key==='victory').points,0);
  const bad=fixture(t);for(let i=0;i<5;i++)game(bad,900+i,{winner:1,values:{101:{DestructionScore:500,DamageDealt:50,LossesScore:3500}}});
  near(mine(bad).score,86.7);assert.equal(mine(bad).status,'初步判决');
});

test('all friends, including empty members, share v8 with personal parity, stable filters and v7 comparisons',t=>{
  const s=fixture(t);for(let i=0;i<10;i++)game(s,800+i,{winner:i%2,values:{101:{DestructionScore:15500,DamageDealt:1550,LossesScore:3500}}});
  const clean=({rank,...r})=>r,current=zhanfanAnalysis(s,params);
  for(const r of current.members){
    const personal=friendAnalysis(s,r.member_id,params).court;assert.deepEqual(clean(personal.report),clean(currentAnalysis(s,params).members.find(m=>m.member_id===r.member_id)));
  }
  const comparison=zhanfanComparison(s,params);assert.deepEqual(comparison.current,current);assert.deepEqual(comparison.previous,overcapZhanfanAnalysis(s,params));
  const before=mine(s);game(s,800,{winner:0,ids:[101,104,102,103,201],values:{101:{DestructionScore:7500,DamageDealt:750,LossesScore:1700,SupplyPointsConsumed:5000},104:{DestructionScore:8000,DamageDealt:800,LossesScore:1800,SupplyPointsConsumed:5000}}});
  assert.deepEqual(mine(s),before);game(s,900,{mode:1});assert.equal(mine(s).scored_matches,10);
});

test('UI exposes the signed range, negative weighted points and zero-axis bars without early clipping',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{values:{101:{DestructionScore:15500,DamageDealt:1550,LossesScore:63500}}});
  s.run('UPDATE members SET name=? WHERE id=1','<script>Name</script>');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:(n,d=0)=>n==null?'—':String(Number(n.toFixed(d))),empty:()=>''});
  const data=zhanfanAnalysis(s,params),html=ui.courtPanel({model:data.model,min_games:1,report:data.members.find(r=>r.member_id===1)});
  for(const text of ['负分可抵扣','-50～150','court-signed-track','background:var(--green)','裁剪前'])assert(html.includes(text),text);
  for(const page of [html,ui.courtView(data),ui.courtView(zhanfanComparison(s,params))]){assert(page.includes('zhanfan-v8-signed'));assert(!page.includes('NaN'));assert(!page.includes('undefined'));assert(!page.includes('<script>'));}
  assert(ui.courtView(zhanfanComparison(s,params)).includes('旧版 v7 刑期'));
});
