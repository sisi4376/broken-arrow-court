import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { testStore, tempDir, member, rawMatch, detailFor, airUnit } from './helpers.mjs';
import { compileAirUnit } from '../src/air-superiority.mjs';
import { stackedGameEvidence, stackedTrial, STACKED_TRIAL_MODEL } from '../src/court-stacked-trial.mjs';
import { expandedZhanfanAnalysis as zhanfanAnalysis } from '../src/zhanfan.mjs';
import { STATIC_SOURCES, exportStatic } from '../src/static-export.mjs';
import { createApplication } from '../src/server.mjs';
import { LOCAL_POLICY } from '../src/distribution.mjs';

const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function person(key,values={},special={}){
  return {key,values:{destruction:3500,losses:3500,damage:350,objectives:0,friendly_fire:0,consumed:10000,received:0,supplied:0,kills:10,units_lost:10,...values},
    unit_evidence:{heavy:{known:true,kills:0},air:{known:true,kills:0},...special}};
}
function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','900',JSON.stringify({id:900,hudName:'Plane',role:164}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'SAM',role:15}),'now');
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify({units:{900:compileAirUnit(airUnit())}}));return s;
}
function game(s,id,{values={},ids=[101,102,103,201],units={},winner=0,map=4,mode=0,complete=true}={}){
  const raw=rawMatch(ids,{MapId:map,Type:mode,WinnerTeam:winner,TotalPlayTimeInSec:1800});
  for(const p of Object.values(raw.Data))p.TeamId=p.Id===201?1:0;
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const [id,p]of Object.entries(d.data.Data))Object.assign(p,{DestructionScore:3500,LossesScore:3500,DamageDealt:350,ObjectivesCaptured:0,DamageFriendlyFireDealt:0,SupplyPointsConsumed:10000,SupplyPointsConsumedFromAllies:0,SupplyPointsConsumedByAllies:0,Destruction:10,Losses:10,UnitData:units[id]??{}},values[id]);
  if(complete)s.saveDetail(String(id),d);return d;
}
const run=(s,q='mode=0')=>stackedTrial(s,new URLSearchParams(q));
const mine=d=>d.members.find(r=>r.member_id===1);

test('four independent support credits stack to80 without reusing the old max credit in core',()=>{
  const a=person('a',{objectives:2,consumed:1000,supplied:10000},{heavy:{known:true,kills:2},air:{known:true,kills:2}}),b=person('b');
  const e=stackedGameEvidence(a,[a,b]);near(e.core,50);near(e.relief,80);near(e.before_outcome,-30);
  for(const key of ['objectives','heavy','air','transport'])near(e.corrections[key],-20);
  near(e.corrections.dependency,0);near(e.corrections.unit_kd,0);
});

test('independent20-point penalties are bounded and KD requires both unit and value exchange shortfalls',()=>{
  const b=person('b',{kills:100,units_lost:0}),a=person('a',{destruction:0,losses:100000,damage:0,friendly_fire:1000,received:10000,kills:0,units_lost:100000});
  const e=stackedGameEvidence(a,[a,b]);near(e.corrections.dependency,20);near(e.corrections.discipline,20);assert(e.corrections.unit_kd>19&&e.corrections.unit_kd<=20);
  const rich=person('rich',{destruction:100000,losses:0,kills:0,units_lost:100000});near(stackedGameEvidence(rich,[rich,b]).corrections.unit_kd,0);
  const unknown=person('unknown',{kills:null});assert.equal(stackedGameEvidence(a,[a,unknown]).corrections.unit_kd,null);
  const precise=person('fraction',{kills:1.5});assert.equal(stackedGameEvidence(precise,[precise,b]).corrections.unit_kd,null);
});

test('net supply never rewards reciprocal gross supply or invents a duty from zero captures',()=>{
  const b=person('b'),a=person('a',{supplied:10000,received:10000});
  let e=stackedGameEvidence(a,[a,b]);near(e.corrections.transport,0);near(e.corrections.dependency,0);near(e.corrections.objectives,0);
  const net=person('net',{supplied:5000,received:1000});e=stackedGameEvidence(net,[net,b]);near(e.corrections.transport,-8);near(e.corrections.dependency,0);
  const missing=person('missing',{}, {heavy:{known:false,kills:0}});e=stackedGameEvidence(a,[a,missing]);assert.equal(e.corrections.heavy,null);near(e.corrections.air,0);
});

test('supply dependency is continuous above the allowance and independent of combat and support relief',()=>{
  const b=person('b');
  for(const [received,expected] of [[0,0],[3500,0],[6750,10],[10000,20]]){
    const ordinary=person('ordinary',{received});
    const strong=person('strong',{received,destruction:100000,damage:10000,objectives:2},
      {heavy:{known:true,kills:2},air:{known:true,kills:2}});
    const weak=person('weak',{received,destruction:0,damage:0,losses:100000});
    for(const a of [ordinary,strong,weak])near(stackedGameEvidence(a,[a,b]).corrections.dependency,expected);
    near(stackedGameEvidence(strong,[strong,b]).relief,60);
  }
  const net=person('net',{received:10000,supplied:3250});near(stackedGameEvidence(net,[net,b]).corrections.dependency,10);
  const tiny=person('tiny',{consumed:0,received:100});near(stackedGameEvidence(tiny,[tiny,b]).corrections.dependency,0);
});

test('independent supply penalties average all valid matches and retain the ten-game shrinkage',t=>{
  const s=fixture(t);
  for(let i=0;i<20;i++)game(s,900+i,{values:{101:{SupplyPointsConsumedFromAllies:i<10?10000:0}}});
  const d=run(s),r=mine(d),c=r.trial.components.find(c=>c.key==='dependency');
  assert.equal(d.model.version,'stacked-20-trial-v2');assert.equal(r.trial.scored_matches,20);
  assert.equal(c.samples,20);near(c.mean,10);near(c.points,20/3);
  assert.equal(d.summary.sample_mismatches,0);
});

test('full trial retains formal samples and scores, independently shrinks corrections and never writes',t=>{
  const s=fixture(t);for(let i=0;i<20;i++)game(s,800+i,{winner:i<16?0:1,values:{101:{ObjectivesCaptured:2,SupplyPointsConsumed:1000,SupplyPointsConsumedByAllies:10000}},units:{101:{h:{Id:238,KilledCount:2},a:{Id:900,OptionIds:[100,200],KilledCount:2}}}});
  const before=zhanfanAnalysis(s,new URLSearchParams('mode=0')),changes=s.get('SELECT total_changes() n').n;
  const d=run(s),r=mine(d);assert.equal(d.summary.sample_mismatches,0);assert.deepEqual(d.members.map(r=>r.formal),before.members);
  near(r.trial.core,50);for(const key of ['objectives','heavy','air','transport'])near(r.trial.components.find(c=>c.key===key).points,-40/3);
  near(r.trial.components.find(c=>c.key==='victory').points,-8);assert(r.trial.before_clamp<0);assert.equal(r.trial.score,0);
  assert.equal(s.get('SELECT total_changes() n').n,changes);assert.deepEqual(zhanfanAnalysis(s,new URLSearchParams('mode=0')),before);
  assert.equal(d.experimental,true);assert.equal(d.public,false);assert.equal(d.model.correction_cap,20);
  assert.equal(d.members.find(r=>r.name==='Empty').trial.score,null);
});

test('unknown optional evidence stays unknown rather than changing the complete base-scoring sample',t=>{
  const s=fixture(t);const d=game(s,800,{units:{102:{u:{Id:999999,KilledCount:9}}}});
  d.data.Data['101'].Destruction=null;s.saveDetail('800',d);
  const trial=mine(run(s)).trial;assert.equal(trial.scored_matches,1);
  for(const key of ['heavy','air','unit_kd']){const c=trial.components.find(c=>c.key===key);assert.equal(c.samples,0);assert.equal(c.unavailable,1);assert.equal(c.mean,null);near(c.points,0);}
  assert.equal(trial.examples[0].corrections.unit_kd,null);
});

test('filters, alts, actual air loadouts, known outcomes and sample thresholds preserve their contracts',t=>{
  const s=fixture(t);game(s,800,{winner:-1,units:{101:{a:{Id:900,OptionIds:[101,200],KilledCount:10}}}});
  let d=run(s);assert.equal(mine(d).trial.eligible,false);assert.equal(mine(d).trial.outcome_matches,0);near(mine(d).trial.components.find(c=>c.key==='air').points,0);
  const base=mine(d).trial;
  game(s,800,{winner:-1,ids:[101,104,102,103,201],values:{101:{DestructionScore:1500,LossesScore:1500,DamageDealt:150,SupplyPointsConsumed:5000,Destruction:5,Losses:5},104:{DestructionScore:2000,LossesScore:2000,DamageDealt:200,SupplyPointsConsumed:5000,Destruction:5,Losses:5}},units:{101:{a:{Id:900,OptionIds:[101,200],KilledCount:10}}}});
  d=run(s);near(mine(d).trial.score,base.score);assert.deepEqual(mine(d).trial.components,base.components);
  game(s,801,{mode:1,map:28});game(s,802,{complete:false});assert.equal(mine(run(s)).trial.scored_matches,1);assert.equal(mine(run(s,'mode=1')).trial.scored_matches,1);
  assert.equal(mine(run(s,'mode=0&map=28')).trial.score,null);assert.equal(mine(run(s,'mode=0&court_min_games=1')).trial.eligible,true);
  assert.equal(run(s,'from=2099-01-01').summary.ranked,0);
});

test('trial files and algorithms are not part of static publication and private preview returns404',async t=>{
  for(const value of Object.values(STATIC_SOURCES))assert(!/trial\.(html|js|css)|court-stacked-trial/.test(value));
  const s=fixture(t),dir=path.join(s.directory,'public-site');await exportStatic(s,{directory:dir});
  const html=await readFile(path.join(dir,'index.html'),'utf8');assert(!html.includes('trial.html'));
  assert.equal(STACKED_TRIAL_MODEL.sentencing.life_score,75);
});

test('local trial endpoints require an admin, have no activation endpoint, and leave formal API unchanged',async t=>{
  let app;const dir=tempDir(t,()=>app?.close());app=createApplication({directory:dir,policy:LOCAL_POLICY,startScheduler:false,staticOutputDirectory:path.join(dir,'public-site')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base+'/api/analytics/zhanfan/trial')).status,401);assert.equal((await fetch(base+'/trial.html')).status,403);
  const registration=await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Owner',username:'trial-owner',password:'trial-password-long'})});
  const cookie=registration.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie};
  assert.equal((await fetch(base+'/trial.html',{headers})).status,200);assert.equal((await fetch(base+'/trial.js',{headers})).status,200);assert.equal((await fetch(base+'/trial.css',{headers})).status,200);
  const formal=await(await fetch(base+'/api/analytics/zhanfan',{headers})).json();
  const response=await fetch(base+'/api/analytics/zhanfan/trial',{headers});assert.equal(response.status,200);assert.equal((await response.json()).experimental,true);
  assert.deepEqual(await(await fetch(base+'/api/analytics/zhanfan',{headers})).json(),formal);
  await exportStatic(app.store,{directory:path.join(dir,'public-site')});assert.equal((await fetch(base+'/readonly/trial.html')).status,404);
  assert.equal((await fetch(base+'/api/analytics/zhanfan/trial/activate',{headers})).status,404);
  const id=Number(app.store.run('INSERT INTO members(name,created_at) VALUES(?,?)','Member','now').lastInsertRowid);
  app.store.run('UPDATE users SET role=? WHERE member_id=?','member',1);
  assert.equal((await fetch(base+'/api/analytics/zhanfan/trial',{headers})).status,403);assert.equal((await fetch(base+'/trial.html',{headers})).status,403);assert(id>0);
});
