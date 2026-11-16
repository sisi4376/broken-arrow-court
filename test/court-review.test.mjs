import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,member,rawMatch,detailFor,airUnit } from './helpers.mjs';
import { courtReview } from '../src/court-review.mjs';
import { zhanfanAnalysis } from '../src/zhanfan.mjs';
import { compileAirUnit } from '../src/air-superiority.mjs';
import { createCourt } from '../public/zhanfan.js';

function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'SAM',role:15}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','900',JSON.stringify({id:900,hudName:'Plane',role:164}),'now');
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify({units:{900:compileAirUnit(airUnit())}}));
  return s;
}
function game(s,id=800,{ids=[101,102,103,201],mode=0,map=4,complete=true,teams={},values={},winner=0}={}){
  const raw=rawMatch(ids,{Type:mode,MapId:map,WinnerTeam:winner});
  for(const p of Object.values(raw.Data))p.TeamId=teams[p.Id]??(p.Id===201?1:0);
  s.ingest(String(id),raw);const d=detailFor(raw);
  for(const[id,p]of Object.entries(d.data.Data))Object.assign(p,{DestructionScore:200,LossesScore:500,ObjectivesCaptured:2,
    SupplyPointsConsumed:6000,SupplyPointsConsumedFromAllies:5000,SupplyPointsConsumedByAllies:100,DamageFriendlyFireDealt:10},values[id]);
  if(complete)s.saveDetail(String(id),d);return d;
}
const get=(s,q='mode=0')=>courtReview(s,new URLSearchParams(q));
const category=(r,id)=>r.categories.find(c=>c.id===id);

test('review groups real evidence by person-match, excludes AI and enemy peers, and never invents labels or a new score',t=>{
  const s=fixture(t);game(s,800,{ids:[101,104,102,103,201,-2,202],teams:{202:100}});
  const before=zhanfanAnalysis(s),r=get(s),a=category(r,'shared_supply').cases.find(c=>c.member_id===1);
  assert.equal(r.overview.person_matches,3);assert.equal(r.overview.confirmed_labels,0);
  assert.equal(a.values.destruction,400);assert.equal(a.values.losses,1000);assert.equal(a.net_exchange,-600);
  assert.equal(a.values.received,10000);assert.equal(a.values.supplied,200);assert.equal(a.net_received,9800);
  assert.equal(a.heavy_kills,6);assert.equal(a.models[0].deployments,2);assert.equal(a.models[0].kills,6);
  assert.equal(a.peers.length,3);assert.deepEqual(a.player_ids,['101','104']);assert(a.peers.every(p=>p.member_id!==null));
  assert.equal(a.status,'待人工复核');assert(!('score' in a));assert(!('sentence' in a));assert(!('label' in a));
  assert.deepEqual(zhanfanAnalysis(s),before);
});

test('null evidence stays unknown, while omitted full protobuf scalar values stay zero',t=>{
  const s=fixture(t),d=game(s);
  d.data.Data['101'].SupplyPointsConsumedFromAllies=null;delete d.data.Data['102'].SupplyPointsConsumedFromAllies;
  s.saveDetail('800',d);
  const r=get(s);assert(!category(r,'shared_supply').cases.some(c=>c.member_id===1));
  const a=category(r,'costly_objectives').cases.find(c=>c.member_id===1),b=category(r,'costly_objectives').cases.find(c=>c.member_id===2);
  assert.equal(a.values.received,null);assert.equal(a.net_received,null);assert.equal(b.values.received,0);
  assert.equal(a.peers.find(p=>p.member_id===1).values.received,null);
});

test('actual air options and heavy classification are supporting evidence, not automatically inferred duties or victim types',t=>{
  const s=fixture(t),d=game(s);
  d.data.Data['101'].ObjectivesCaptured=0;d.data.Data['101'].UnitData={1:{Id:900,OptionIds:[100,200],KilledCount:7}};
  d.data.Data['102'].ObjectivesCaptured=0;d.data.Data['102'].UnitData={1:{Id:900,OptionIds:[101,200],KilledCount:99}};
  d.data.Data['103'].ObjectivesCaptured=0;d.data.Data['103'].UnitData={1:{Id:999,KilledCount:99}};
  s.saveDetail('800',d);
  const r=get(s),c=category(r,'specialist');assert.equal(c.candidates,1);assert.equal(c.cases[0].member_id,1);assert.equal(c.cases[0].air_kills,7);
  const g=category(r,'shared_supply').cases.find(c=>c.member_id===3);assert.equal(g.air_kills,null);assert.equal(g.heavy_kills,null);
  assert(c.limitation.includes('不等于击落敌机'));assert(!('role' in c.cases[0]));
});

test('sampling respects all match filters, active friends, focused member, complete details and ambiguous alts',t=>{
  const s=fixture(t);game(s,800);game(s,801,{mode:1,map:28});game(s,802,{complete:false});
  game(s,803,{ids:[101,201,202]});game(s,804,{ids:[101,104,102,103],teams:{104:1}});
  const r=get(s);assert.equal(r.overview.matches,3);assert.equal(r.overview.complete,2);assert.equal(r.overview.missing,1);assert.equal(r.overview.ambiguous_team,1);
  assert(r.categories.flatMap(c=>c.cases).every(c=>c.match_id!=='804'||c.member_id!==1));
  const scoped=get(s,'mode=1&map=28&member=1');assert.equal(scoped.overview.matches,1);assert.equal(scoped.overview.person_matches,1);
  assert(scoped.categories.flatMap(c=>c.cases).every(c=>c.member_id===1&&c.match_id==='801'));
  assert.equal(get(s,'from=2099-01-01').overview.matches,0);
  assert.equal(get(s,'q=801').overview.matches,1);
  assert.deepEqual(get(s,'mode=0&court_min_games=10000'),r);
  s.run('UPDATE members SET active=0 WHERE id=3');s.reclassify();assert.equal(get(s).overview.matches,0);
});

test('cases are deterministic event-based samples with at most one case per friend and three friends per scenario',t=>{
  const s=fixture(t);member(s,'D',[105]);member(s,'E',[106]);
  for(let i=0;i<6;i++)game(s,800+i,{ids:[101,102,103,105,106],values:{101:{SupplyPointsConsumedFromAllies:9000+i}}});
  const r=get(s),c=category(r,'shared_supply');assert.equal(c.candidates,30);assert.equal(c.cases.length,3);
  assert.equal(new Set(c.cases.map(r=>r.member_id)).size,3);assert.equal(c.cases[0].match_id,'805');
  assert.equal(r.overview.selected,new Set(r.categories.flatMap(c=>c.cases.map(r=>r.key))).size);
  assert.deepEqual(get(s),r);
  game(s,999,{winner:999});assert.equal(category(get(s,'q=999'),'shared_supply').candidates,0);
});

test('case UI links original matches, escapes evidence names and clearly distinguishes selection from judgement',t=>{
  const s=fixture(t);game(s);s.run('UPDATE members SET name=? WHERE id=1','<script>Member</script>');
  s.run('UPDATE unit_catalogue SET data_json=? WHERE unit_id=?',JSON.stringify({id:238,role:15,hudName:'<img src=x onerror=alert(1)>'}),'238');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const html=createCourt({S:{},esc,fmt:n=>n==null?'—':String(n),icon:()=>'',empty:()=>''}).courtView(get(s));
  assert(html.includes('案例复核'));assert(html.includes('待人工复核'));assert(html.includes('人工确认 0'));assert(html.includes('不生成新刑期'));
  assert(html.includes('不是随机代表性样本'));assert(html.includes('href="#match/800"'));
  assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('&lt;img'));assert(!html.includes('<img'));
  assert(html.includes('data-court-view="cases" class="active" aria-pressed="true"'));
});
