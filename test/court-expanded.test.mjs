import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { independentRatioPenalty } from '../src/court-model.mjs';
import { expandedZhanfanAnalysis as zhanfanAnalysis, expandedZhanfanComparison as zhanfanComparison, zhanfanAnalysis as currentAnalysis, signedZhanfanAnalysis, sentenceMonths, sentenceLabel, ZHANFAN_SIGNED_MODEL, ZHANFAN_EXPANDED_MODEL as MODEL } from '../src/zhanfan.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';
import { readFileSync } from 'node:fs';

const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const params=new URLSearchParams('mode=0&court_min_games=1');
function fixture(t){const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');return s;}
function game(s,id,{values={},winner=-1,map=4,mode=0,ids=[101,102,103,201]}={}){
  const raw=rawMatch(ids,{WinnerTeam:winner,MapId:map,Type:mode,TotalPlayTimeInSec:1800});
  for(const p of Object.values(raw.Data))p.TeamId=p.Id===201?1:0;
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const [id,p]of Object.entries(d.data.Data))Object.assign(p,{DestructionScore:3500,LossesScore:3500,DamageDealt:350,ObjectivesCaptured:0,DamageFriendlyFireDealt:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:0,SupplyPointsConsumedByAllies:0,UnitData:{}},values[id]);
  s.saveDetail(String(id),d);return d;
}
const report=(s,q=params)=>zhanfanAnalysis(s,q).members.find(r=>r.member_id===1);
const good={DestructionScore:15500,DamageDealt:1550,LossesScore:3500};
const bad={DestructionScore:500,DamageDealt:50,LossesScore:3500};

test('v9 maps the standard scale to -100..200 with neutral50 and preserves archived v8',()=>{
  assert.equal(MODEL.version,'zhanfan-v9-expanded');assert.equal(MODEL.context.score_floor,-100);assert.equal(MODEL.context.score_cap,200);assert.equal(MODEL.context.slope,75);
  for(const ratio of [.001,.25,.5,1,2,4,1000]){
    const p=independentRatioPenalty(ratio,1,0,200,-100,75);
    near(p,3*independentRatioPenalty(ratio,1,0)-100);assert(p>=-100&&p<=200);
  }
  for(const [ratio,expected]of [[4,-100],[2,-25],[1,50],[.5,125],[.25,200]])near(independentRatioPenalty(ratio,1,0,200,-100,75),expected);
  near(independentRatioPenalty(0,0,500,200,-100,75),50);
  near(independentRatioPenalty(0,1,0,200,-100,75),200);near(independentRatioPenalty(1,0,0,200,-100,75),-100);
  for(const b of MODEL.benchmarks)near(b.score,Math.max(0,Math.min(100,b.raw_core+20*(.5-b.win_rate))));
});

test('current sentencing begins lifetime exactly at75, preserves acquittal25 and archived85 boundary',()=>{
  const rule=MODEL.sentencing;assert.equal(rule.life_score,75);assert.equal(rule.acquittal_score,25);
  for(const score of [0,24.9,25])assert.equal(sentenceMonths(score,rule),0);
  assert.equal(sentenceMonths(25.1,rule),1);assert.equal(sentenceMonths(75,rule),240);assert.equal(sentenceLabel(sentenceMonths(75,rule)),'无期徒刑');
  for(const score of [74,74.9,74.99,74.9999])assert(sentenceMonths(score,rule)<240);
  for(const score of [75,75.1,80,85,100])assert(sentenceMonths(score,rule)>=240);
  assert.equal(ZHANFAN_SIGNED_MODEL.sentencing.life_score,85);assert(sentenceMonths(75,ZHANFAN_SIGNED_MODEL.sentencing)<240);
  let previous=0;for(let i=0;i<=1000;i++){const m=sentenceMonths(i/10,rule);assert(m>=previous&&m<=360);previous=m;}
  for(const b of MODEL.benchmarks)assert.equal(b.sentence_months,sentenceMonths(b.score,rule));
});

test('negative and excess items and games offset before the final truncation',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{values:{101:{...good,LossesScore:63500}}});
  const r=report(s),e=r.context.risk_examples[0];near(e.combat_penalty,-100);near(e.exchange_penalty,200);near(e.core_points,20);
  near(r.score_breakdown.core,30);near(r.score,30);near(r.components[0].points,-30);near(r.components[1].points,60);
  assert.equal(r.score_breakdown.item_floor,-100);assert.equal(r.score_breakdown.item_cap,200);
  const across=fixture(t);game(across,900,{values:{101:good}});game(across,901,{values:{101:bad}});
  near(report(across).components[0].average,50);near(report(across).components[1].average,50);near(report(across).score,50);
});

test('final0..100 clipping retains unclipped evidence, finite high-score reachability and untouched corrections',t=>{
  const s=fixture(t);for(let i=0;i<20;i++){
    game(s,800+i,{map:4,winner:0,values:{101:good}});
    game(s,900+i,{map:28,winner:i<16?0:1,values:{101:bad}});
  }
  const strong=report(s,new URLSearchParams('map=4')),weak=report(s,new URLSearchParams('map=28'));
  assert(strong.score_breakdown.before_clamp<0);assert.equal(strong.score,0);assert.equal(strong.sentence,'当庭释放');
  near(weak.score_breakdown.core,150);near(weak.score_breakdown.before_clamp,146);assert.equal(weak.score,100);assert.equal(weak.sentence,'无期徒刑');
  near(weak.components.find(c=>c.key==='victory').points,-4);
  near(weak.components.find(c=>c.key==='dependency').points,0);near(weak.components.find(c=>c.key==='discipline').points,0);
  for(const r of [strong,weak])near(r.components.reduce((sum,c)=>sum+c.points,0),r.score_breakdown.before_clamp);
});

test('credits retain their20-point cap, independent surcharges remain bounded, and no evidence stays unknown',t=>{
  const s=fixture(t);assert.equal(report(s).score,null);assert.equal(report(s).score_breakdown.core,null);
  game(s,800,{values:{101:{...good,ObjectivesCaptured:2,SupplyPointsConsumedFromAllies:10000}}});
  let r=report(s);near(r.components[0].average,-100);near(r.components[1].average,-100);near(r.components.find(c=>c.key==='dependency').average,0);
  game(s,801,{values:{101:{...bad,ObjectivesCaptured:2,SupplyPointsConsumedFromAllies:10000,DamageFriendlyFireDealt:1000}}});
  r=report(s);const e=r.context.risk_examples[0];near(e.support_credit,20);near(e.combat_penalty,180);near(e.exchange_penalty,180);near(e.relief_points,20);
  assert(e.penalties.dependency<=100);assert(e.penalties.discipline<=100);
  const neutral=fixture(t);game(neutral,900);near(report(neutral).score,50);assert.equal(report(neutral).outcome_matches,0);
});

test('archived v9 retains v8 comparisons, unchanged filters and merged alts while personal pages follow current scoring',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{values:{101:good},winner:i%2});
  const current=zhanfanAnalysis(s,params),clean=({rank,...r})=>r;
  for(const r of currentAnalysis(s,params).members){const p=friendAnalysis(s,r.member_id,params).court;assert.equal(p.model.version,'zhanfan-v10-stacked');assert.deepEqual(clean(p.report),clean(r));}
  const comparison=zhanfanComparison(s,params);assert.deepEqual(comparison.current,current);assert.deepEqual(comparison.previous,signedZhanfanAnalysis(s,params));
  const before=report(s);game(s,800,{winner:0,ids:[101,104,102,103,201],values:{101:{DestructionScore:7500,DamageDealt:750,LossesScore:1700,SupplyPointsConsumed:5000},104:{DestructionScore:8000,DamageDealt:800,LossesScore:1800,SupplyPointsConsumed:5000}}});
  assert.deepEqual(report(s),before);game(s,900,{mode:1});assert.equal(report(s).scored_matches,20);
});

test('UI ranges, weighted maxima, mapping anchors and comparison labels follow v9 metadata',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{values:{101:{...good,LossesScore:63500}}});
  const data=zhanfanAnalysis(s,params),r=data.members.find(m=>m.member_id===1);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:(n,d=0)=>n==null?'—':String(Number(n.toFixed(d))),empty:()=>''});
  const panel=ui.courtPanel({model:data.model,min_games:1,report:r}),ranking=ui.courtView(data),compare=ui.courtView(zhanfanComparison(s,params));
  for(const text of ['-100～200',' / 120',' / 80','-100、-25、50、125、200','负分可抵扣','合计146'])assert(panel.includes(text),text);
  assert(ranking.includes('-100/-25/50/125/200'));assert(compare.includes('旧版 v8 刑期'));assert(compare.includes('现行 v9 刑期'));
  assert(panel.includes('无期线75分'));assert(panel.includes('75分达到20年'));assert(ranking.includes('75分起无期'));assert(panel.includes('指数−25)/50'));
  assert(ranking.includes('data-court-view="current"'));assert(ranking.includes('data-court-view="cases"'));
  assert(!ranking.includes('data-court-view="compare"'));assert(!ranking.includes('旧版 v8 刑期'));assert(!ranking.includes('新旧判决对照'));
  const controller=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert(!controller.includes('court_compare:'));assert(!controller.includes('S.courtComparison'));
  const publicUi=createCourt({S:{},esc,icon:()=>'',fmt:(n,d=0)=>n==null?'—':String(Number(n.toFixed(d))),empty:()=>'',readOnly:true});
  const publicRanking=publicUi.courtView(data);
  assert(publicRanking.includes('蘸饭刑期榜'));assert(!publicRanking.includes('案例复核'));assert(!publicRanking.includes('data-court-view='));
  assert(!publicUi.courtView(zhanfanComparison(s,params)).includes('旧版 v8 刑期'));
  assert.equal(publicUi.courtView({kind:'court-evidence-review'}),'');
  assert(controller.includes('readOnly:READ_ONLY'));assert(controller.includes('if(READ_ONLY)return;'));
  for(const html of [panel,ranking,compare]){assert(!html.includes('NaN'));assert(!html.includes('undefined'));assert(html.includes('zhanfan-v9-expanded'));}
});
