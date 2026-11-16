import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { zhanfanAnalysis, zhanfanComparison, expandedZhanfanAnalysis } from '../src/zhanfan.mjs';
import { stackedTrial } from '../src/court-stacked-trial.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');
  for(let i=0;i<20;i++){
    const raw=rawMatch([101,102,103,201],{Type:0,MapId:4,WinnerTeam:i<12?0:1,TotalPlayTimeInSec:1800});
    for(const p of Object.values(raw.Data))p.TeamId=p.Id===201?1:0;
    s.ingest(String(800+i),raw);const d=detailFor(raw);
    for(const p of Object.values(d.data.Data))Object.assign(p,{DestructionScore:3500,LossesScore:3500,DamageDealt:350,
      ObjectivesCaptured:0,DamageFriendlyFireDealt:0,SupplyPointsConsumed:10000,
      SupplyPointsConsumedFromAllies:0,SupplyPointsConsumedByAllies:0,Destruction:10,Losses:10,UnitData:{}});
    Object.assign(d.data.Data[101],{SupplyPointsConsumedFromAllies:i<10?10000:0,ObjectivesCaptured:2});
    if(i===0){d.data.Data[101].Destruction=null;d.data.Data[102].UnitData={u:{Id:999999,KilledCount:2}};}
    s.saveDetail(String(800+i),d);
  }
  return s;
}
const params=new URLSearchParams('mode=0&court_min_games=1');

test('formal v10 exactly adopts approved trial v2 with per-item evidence samples and no writes',t=>{
  const s=fixture(t),changes=s.get('SELECT total_changes() n').n;
  const d=zhanfanAnalysis(s,params),trial=stackedTrial(s,params);
  assert.equal(d.model.version,'zhanfan-v10-stacked');assert.equal(d.model.approved_trial,trial.model.version);
  assert.equal(d.model.dimensions.length,10);
  for(const r of d.members){
    const next=trial.members.find(x=>x.member_id===r.member_id).trial;
    assert.equal(r.score,next.score);assert.equal(r.sentence_months,next.sentence_months);
    assert.equal(r.scored_matches,next.scored_matches);assert.equal(r.outcome_matches,next.outcome_matches);
    for(const c of next.components){const actual=r.components.find(a=>a.key===c.key);
      assert.equal(actual.samples,c.samples);assert.equal(actual.unavailable,c.unavailable);
      if(r.scored_matches)near(actual.points,c.points);else assert.equal(actual.points,null);
    }
    if(r.scored_matches){near(r.score_breakdown.core,next.core);near(r.score_breakdown.before_clamp,next.before_clamp);}
  }
  const a=d.members.find(r=>r.member_id===1);
  near(a.components.find(c=>c.key==='dependency').points,20/3);
  assert.equal(a.components.find(c=>c.key==='unit_kd').samples,19);
  assert.equal(a.components.find(c=>c.key==='heavy').samples,19);
  assert.equal(s.get('SELECT total_changes() n').n,changes);
});

test('current personal reports, ranking, archived v9 and filtered trial retain parity',t=>{
  const s=fixture(t);
  for(const query of ['mode=0','mode=0&member=1','mode=0&team=same','mode=1','map=28','from=2099-01-01']){
    const p=new URLSearchParams(query),d=zhanfanAnalysis(s,p),trial=stackedTrial(s,p);
    const clean=({rank,...r})=>r;
    for(const r of d.members){assert.deepEqual(clean(friendAnalysis(s,r.member_id,p).court.report),clean(r));
      assert.equal(r.score,trial.members.find(x=>x.member_id===r.member_id).trial.score);}
  }
  const c=zhanfanComparison(s,params);
  assert.deepEqual(c.current,zhanfanAnalysis(s,params));assert.deepEqual(c.previous,expandedZhanfanAnalysis(s,params));
});

test('formal stacked UI shows signed limits and standalone supply while public still hides old and review pages',t=>{
  const s=fixture(t),d=zhanfanAnalysis(s,params),report=d.members.find(r=>r.member_id===1);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const options={S:{},esc,icon:()=>'',fmt:(n,p=0)=>n==null?'—':Number(n).toFixed(p),empty:()=>''};
  const ui=createCourt(options),panel=ui.courtPanel({model:d.model,min_games:1,report}),ranking=ui.courtView(d);
  for(const text of ['+20分','−20分','±20分','其余八项独立叠加','不再乘战斗不足','净补给队友','单位损耗附加'])assert(panel.includes(text),text);
  assert(!panel.includes('后三项'));assert(!panel.includes(' / +8 分'));
  for(const html of [panel,ranking]){assert(!html.includes('NaN'));assert(!html.includes('undefined'));assert(html.includes('zhanfan-v10-stacked'));}
  const publicUi=createCourt({...options,readOnly:true}),publicRanking=publicUi.courtView(d);
  assert(!publicRanking.includes('案例复核'));assert(!publicRanking.includes('data-court-view='));
  assert(!publicUi.courtView(zhanfanComparison(s,params)).includes('旧版 v9 刑期'));
});
