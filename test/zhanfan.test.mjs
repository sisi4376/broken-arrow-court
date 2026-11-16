import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,member,rawMatch,detailFor } from './helpers.mjs';
import { legacyZhanfanAnalysis as zhanfanAnalysis,zhanfanAnalysis as currentAnalysis,ZHANFAN_MODEL,sentenceLabel,sentenceDetails,sentenceMonths,calibratedScore } from '../src/zhanfan.mjs';
import { friendAnalysis } from '../src/analysis.mjs';
import { createCourt } from '../public/zhanfan.js';

function fixture(t) {
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'No games',[]);
  return s;
}
function game(s,id,{values={},ids=[101,102,103],mode=0,map=4,complete=true,teams={},duration=1800,winner=-1}={}) {
  const raw=rawMatch(ids,{Type:mode,MapId:map,TotalPlayTimeInSec:duration,WinnerTeam:winner});
  for(const p of Object.values(raw.Data))p.TeamId=teams[p.Id]??0;
  s.ingest(String(id),raw);
  const d=detailFor(raw);
  for(const p of Object.values(d.data.Data))Object.assign(p,{DestructionScore:1000,LossesScore:1000,DamageDealt:100,ObjectivesCaptured:1,SupplyPointsConsumed:1000,SupplyPointsConsumedByAllies:0,SupplyPointsConsumedFromAllies:0},values[p.Id]);
  if(complete)s.saveDetail(String(id),d);
  return d;
}
const report=(s,id=1,query='')=>zhanfanAnalysis(s,new URLSearchParams(query)).members.find(r=>r.member_id===id);

test('empty archives stay unjudged rather than giving zero years to unknown players',t=>{
  const s=fixture(t),data=zhanfanAnalysis(s);
  assert.equal(data.members.length,4);assert.equal(data.ranked,0);
  for(const r of data.members){assert.equal(r.score,null);assert.equal(r.sentence_months,null);assert.equal(r.status,'待取证');assert.equal(r.rank,null);assert(r.components.every(c=>c.penalty===null));}
  assert.equal(ZHANFAN_MODEL.dimensions.reduce((n,d)=>n+d.weight,0),100);
  assert.equal(ZHANFAN_MODEL.dimensions.reduce((n,d)=>n+d.weight*d.prior/100,0),40);
  assert.equal(ZHANFAN_MODEL.baseline,calibratedScore(ZHANFAN_MODEL.raw_baseline));
  for(const[n,label]of [[null,'待取证'],[NaN,'待取证'],[0,'当庭释放'],[5,'有期徒刑 5 个月'],[12,'有期徒刑 1 年'],[25,'有期徒刑 2 年 1 个月'],[239,'有期徒刑 19 年 11 个月'],[240,'无期徒刑'],[241,'无期徒刑'],[999,'无期徒刑']])assert.equal(sentenceLabel(n),label);
});

test('each sentencing stage has flavor text and twenty years is the inclusive lifetime boundary',()=>{
  const stages=[[0,0],[1,1],[11,1],[12,2],[35,2],[36,3],[59,3],[60,4],[119,4],[120,5],[179,5],[180,6],[239,6],[240,7],[360,7]];
  for(const[months,index]of stages){const result=sentenceDetails(months);assert.equal(result.stage,ZHANFAN_MODEL.sentence_bands[index].name);assert.equal(result.flavor,ZHANFAN_MODEL.sentence_bands[index].flavor);assert(result.flavor.length>10);assert.equal(result.life,months>=240);}
  assert.equal(new Set(ZHANFAN_MODEL.sentence_bands.map(b=>b.flavor)).size,8);
});

test('fixed calibration spreads middle scores without cohort ranks or reversing performance order',()=>{
  for(const a of ZHANFAN_MODEL.calibration)assert.equal(calibratedScore(a.raw),a.score);
  assert.equal(calibratedScore(34),35);assert.equal(calibratedScore(38),45);
  assert(calibratedScore(41)-calibratedScore(29)>2*(41-29));
  assert.equal(calibratedScore(-10),0);assert.equal(calibratedScore(110),100);
  for(const unknown of [null,undefined,NaN,Infinity,'40'])assert.equal(calibratedScore(unknown),null);
  let previous=-1;for(let i=0;i<=1000;i++){const score=calibratedScore(i/10);assert(score>previous);assert(score>=0&&score<=100);previous=score;}
});

test('nonlinear sentencing retains an acquittal zone and differentiates the middle range',()=>{
  for(const[score,months]of [[0,0],[24.9,0],[25,0],[25.1,1],[30,7],[35,20],[40,34],[45,52],[50,70],[60,113],[70,160],[80,212],[84.9,239],[85,240],[100,328]])assert.equal(sentenceMonths(score),months,String(score));
  for(const unknown of [null,undefined,NaN,Infinity,'40'])assert.equal(sentenceMonths(unknown),null);
  assert.equal(sentenceLabel(sentenceMonths(25)),'当庭释放');assert.equal(sentenceLabel(sentenceMonths(84.9)),'有期徒刑 19 年 11 个月');assert.equal(sentenceLabel(sentenceMonths(85)),'无期徒刑');
  assert.equal(sentenceMonths(-100),0);assert.equal(sentenceMonths(1000),sentenceMonths(100));
  let previous=0;for(let i=0;i<=1000;i++){const months=sentenceMonths(i/10);assert(months>=previous);assert(months<=ZHANFAN_MODEL.max_months);previous=months;}
});

test('calibrated scores and UI support lifetime labels, victory data and escaped flavor copy',t=>{
  const s=fixture(t);
  for(let i=0;i<30;i++)game(s,800+i,{values:{101:{DestructionScore:1,LossesScore:9000,DamageDealt:1,ObjectivesCaptured:0,DamageFriendlyFireDealt:1000,SupplyPointsConsumedFromAllies:10000,SupplyPointsConsumed:10000}}});
  const computed=report(s);assert(computed.score>66.6);assert.equal(computed.sentence_months,sentenceMonths(computed.score));assert.equal(computed.rank,1);
  const r={...computed,score:90,sentence_months:sentenceMonths(90),...sentenceDetails(sentenceMonths(90))};
  assert.equal(r.sentence,'无期徒刑');assert.equal(r.flavor,ZHANFAN_MODEL.sentence_bands[7].flavor);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createCourt({S:{},esc,icon:()=>'',fmt:n=>n==null?'—':String(n),empty:()=>''});
  const panel=ui.courtPanel({model:ZHANFAN_MODEL,min_games:5,report:r});
  assert(panel.includes('无期徒刑'));assert(panel.includes('class="court-flavor"'));assert(panel.includes(esc(r.flavor)));
  assert(panel.includes('原始综合罚分'));assert(panel.includes('评分局胜率'));assert(panel.includes('胜负表现 · 15%'));
  const table=ui.courtView({model:ZHANFAN_MODEL,min_games:5,members:[{...r,name:'<script>alert(1)</script>'}],ranked:1});
  assert(table.includes('&lt;script&gt;'));assert(!table.includes('<script>'));assert(table.includes(esc(r.flavor)));assert(table.includes(String(r.sentence_months)));
});

test('equal teammates are neutral, samples are shrunk and repeated games do not accumulate prison time',t=>{
  const s=fixture(t);game(s,800);
  const first=report(s);assert.equal(first.raw_score,40);assert.equal(first.score,50);assert.equal(first.sentence_months,sentenceMonths(50));assert.equal(first.eligible,false);
  assert.equal(first.reliability,1/11);assert.equal(first.status,'暂缓宣判');
  for(let i=1;i<20;i++)game(s,800+i);
  const r=report(s);assert.equal(r.score,first.score);assert.equal(r.sentence_months,first.sentence_months);assert.equal(r.scored_matches,20);
  assert.equal(r.status,'娱乐判决');assert.equal(r.rank,1);assert.equal(r.sentence,sentenceLabel(sentenceMonths(50)));assert.equal(r.flavor,sentenceDetails(r.sentence_months).flavor);assert(r.sensitivity.low_months<=r.sentence_months&&r.sensitivity.high_months>=r.sentence_months);
  assert.deepEqual(zhanfanAnalysis(s).members.filter(r=>r.eligible).map(r=>r.rank),[1,1,1]);
});

test('poor exchange and low contributions produce longer sentences; high logistics can reduce a low-combat sentence',t=>{
  const s=fixture(t),weak={DestructionScore:10,LossesScore:5000,DamageDealt:10,ObjectivesCaptured:0};
  game(s,800,{values:{101:weak,102:{DestructionScore:5000,LossesScore:100,DamageDealt:1000,ObjectivesCaptured:5}}});
  const before=report(s);assert(before.score>report(s,2).score);assert(before.score>40);assert.equal(before.components.find(c=>c.key==='dependency').points,0);
  const d=game(s,800,{values:{101:{...weak,SupplyPointsConsumedByAllies:10000},102:{DestructionScore:5000,LossesScore:100,DamageDealt:1000,ObjectivesCaptured:5}}});
  const support=report(s);assert(support.score<before.score);assert(support.components.find(c=>c.key==='output').average<before.components.find(c=>c.key==='output').average);
  const base=support.score;d.data.Data['101'].DamageFriendlyFireDealt=50;s.saveDetail('800',d);assert(report(s).score>base);
});

test('supply dependency is contextual, bounded and never treats normal supply use as a standalone conviction',t=>{
  const s=fixture(t),d=game(s,800,{values:{101:{DamageDealt:1,ObjectivesCaptured:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:8000},102:{DamageDealt:1000,ObjectivesCaptured:5}}});
  const low=report(s),dependency=r=>r.components.find(c=>c.key==='dependency').average;
  assert(dependency(low)>0);
  d.data.Data['101'].DamageDealt=5000;d.data.Data['101'].ObjectivesCaptured=10;s.saveDetail('800',d);assert(dependency(report(s))<dependency(low));
  d.data.Data['101'].SupplyPointsConsumedByAllies=8000;s.saveDetail('800',d);assert.equal(dependency(report(s)),0);
  for(const r of zhanfanAnalysis(s).members.filter(r=>r.score!==null)){assert(Number.isFinite(r.score)&&r.score>=0&&r.score<=100);assert(r.components.every(c=>c.penalty>=0&&c.penalty<=100));}
});

test('splitting one person into alternate accounts does not add samples or alter merged evidence',t=>{
  const s=fixture(t);game(s,800,{values:{101:{DestructionScore:2000,LossesScore:1000,DamageDealt:300,ObjectivesCaptured:4,SupplyPointsConsumed:2000,SupplyPointsConsumedFromAllies:800,SupplyPointsConsumedByAllies:400}}});
  const before=report(s);
  const half={DestructionScore:1000,LossesScore:500,DamageDealt:150,ObjectivesCaptured:2,SupplyPointsConsumed:1000,SupplyPointsConsumedFromAllies:400,SupplyPointsConsumedByAllies:200};
  game(s,800,{ids:[101,102,103,104],values:{101:half,104:half}});
  const after=report(s);assert.deepEqual(after,before);
  game(s,801,{ids:[101,102,103,104],teams:{104:1}});
  const ambiguous=report(s);assert.equal(ambiguous.matches,2);assert.equal(ambiguous.scored_matches,1);assert.equal(ambiguous.skipped.ambiguous_team,1);
});

test('only valid comparable complete friend games count; observers, bots, solo and missing data are not evidence',t=>{
  const s=fixture(t);game(s,800,{complete:false});
  game(s,801,{ids:[101,901,902]});
  game(s,802,{teams:{101:0,102:1,103:2}});
  game(s,803,{duration:0});
  const invalid=game(s,804);invalid.data.Data['101'].SupplyPointsConsumedFromAllies=null;s.saveDetail('804',invalid);
  const r=report(s);assert.equal(r.matches,4);assert.equal(r.scored_matches,0);assert.equal(r.skipped.missing_detail,1);assert.equal(r.skipped.no_peers,1);assert.equal(r.skipped.invalid_data,2);
  game(s,805,{ids:[101,102,103,104],teams:{104:100}});
  assert.equal(report(s).scored_matches,1);
  const a=report(s);const bot=game(s,805,{ids:[101,102,103,-100],values:{'-100':{DamageDealt:1e6}}});
  assert.equal(report(s).score,a.score);assert.equal(report(s).matches,a.matches);
  bot.data.Data['101'].DamageDealt=1e300;s.saveDetail('805',bot);assert.equal(report(s).scored_matches,0);
});

test('personal performance uses same-team peers and survives enemy changes, filters and personal report scope',t=>{
  const s=fixture(t);const d=game(s,800,{ids:[101,102,103,901],teams:{901:1},values:{101:{DamageDealt:1000,ObjectivesCaptured:3}}});
  const first=report(s);d.data.Data['901'].DestructionScore=999999;d.data.Data['901'].DamageDealt=999999;s.saveDetail('800',d);
  assert.deepEqual(report(s),first);
  game(s,801,{mode:1,map:28,values:{101:{DamageDealt:1,ObjectivesCaptured:0}}});
  assert.equal(report(s,1,'mode=0').score,first.score);assert.equal(report(s,1,'map=4').score,first.score);assert.equal(report(s,1,'q=800').score,first.score);
  const params=new URLSearchParams('mode=0&court_min_games=1');
  assert.deepEqual(friendAnalysis(s,1,params).court.report,currentAnalysis(s,params).members.find(r=>r.member_id===1));
  assert.equal(report(s,1,'mode=0&court_min_games=1').eligible,true);assert.notEqual(report(s,1,'mode=0&court_min_games=1').rank,null);
  assert.equal(report(s,1,'mode=0&court_min_games=2').eligible,false);
  assert.equal(report(s,1,'court_min_games=bad').eligible,false);
});

test('win rate independently changes the verdict, is scoped to eligible games and uses known outcomes only',t=>{
  const s=fixture(t),options={ids:[101,102,103,901],teams:{901:1}};
  for(let i=0;i<40;i++){
    game(s,1000+i,{...options,map:4,winner:0});
    game(s,2000+i,{...options,map:28,winner:1});
  }
  const wins=report(s,1,'map=4'),losses=report(s,1,'map=28');
  assert.equal(wins.win_rate,100);assert.equal(wins.wins,40);assert.equal(wins.losses,0);
  assert.equal(losses.win_rate,0);assert.equal(losses.wins,0);assert.equal(losses.losses,40);
  assert.equal(wins.components.find(c=>c.key==='victory').penalty,10);
  assert.equal(losses.components.find(c=>c.key==='victory').penalty,90);
  assert.deepEqual(wins.components.filter(c=>c.key!=='victory'),losses.components.filter(c=>c.key!=='victory'));
  assert(losses.score>wins.score);assert(losses.sentence_months>wins.sentence_months);
  for(let i=0;i<20;i++)game(s,3000+i,{...options,map:12,winner:i===0?999:-1});
  const unknown=report(s,1,'map=12');assert.equal(unknown.win_rate,null);assert.equal(unknown.outcome_matches,0);assert.equal(unknown.wins+unknown.losses,0);
  assert.equal(unknown.components.find(c=>c.key==='victory').penalty,50);
  assert.equal(unknown.components.find(c=>c.key==='victory').samples,0);
  game(s,3020,{...options,map:12,winner:0});
  const mixed=report(s,1,'map=12'),v=mixed.components.find(c=>c.key==='victory');
  assert.equal(mixed.scored_matches,21);assert.equal(mixed.outcome_matches,1);assert.equal(mixed.win_rate,100);assert.equal(v.samples,1);
  assert(Math.abs(v.penalty-100*5/11)<1e-10);
  game(s,4000,{...options,map:12,winner:1,complete:false});
  game(s,4001,{...options,map:12,winner:1,duration:0});
  assert.equal(report(s,1,'map=12').outcome_matches,1);
  assert.deepEqual(friendAnalysis(s,1,new URLSearchParams('map=12')).court.report,currentAnalysis(s,new URLSearchParams('map=12')).members.find(r=>r.member_id===1));
});

test('omitted protobuf zero values remain zero while explicit invalid values stay unknown',t=>{
  const s=fixture(t),d=game(s,800);
  for(const key of ['DamageFriendlyFireDealt','SupplyPointsConsumedByAllies','SupplyPointsConsumedFromAllies'])delete d.data.Data['101'][key];
  s.saveDetail('800',d);assert.equal(report(s).scored_matches,1);assert.equal(report(s).components.find(c=>c.key==='discipline').average,0);
  d.data.Data['101'].DamageFriendlyFireDealt='0';s.saveDetail('800',d);assert.equal(report(s).scored_matches,0);assert.equal(report(s).score,null);
});
