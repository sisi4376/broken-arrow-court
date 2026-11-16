import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor, selfDestructionPrices } from './helpers.mjs';
import { memberStats, supplyAnalysis, dashboard } from '../src/queries.mjs';
import { createPerformance } from '../public/performance.js';

function fixture(t) {
  const s=testStore(t);
  member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  function game(id,mode,values,complete=true) {
    const raw=rawMatch(undefined,{Type:mode});raw.Data['104'].TeamId=0;s.ingest(id,raw);
    if(complete){const detail=detailFor(raw);for(const[player,fields]of Object.entries(values))Object.assign(detail.data.Data[player],fields);s.saveDetail(id,detail);}
  }
  game('800',0,{
    101:{SupplyPointsConsumed:1000,SupplyPointsConsumedFromAllies:400,SupplyPointsConsumedByAllies:100,Destruction:12,Losses:8},
    104:{SupplyPointsConsumed:200,SupplyPointsConsumedFromAllies:200,SupplyPointsConsumedByAllies:200},
    102:{SupplyPointsConsumedFromAllies:250,SupplyPointsConsumedByAllies:800},
    103:{SupplyPointsConsumedFromAllies:300,SupplyPointsConsumedByAllies:50},
  });
  game('801',0,{102:{SupplyPointsConsumedFromAllies:250,SupplyPointsConsumedByAllies:800}});
  game('802',0,{},false);
  game('803',1,{101:{SupplyPointsConsumedFromAllies:2000,SupplyPointsConsumedByAllies:2000}});
  const solo=rawMatch([101,900,901],{Type:0});s.ingest('899',solo);const d=detailFor(solo);d.data.Data['101'].SupplyPointsConsumedFromAllies=99999;s.saveDetail('899',d);
  return s;
}

test('supply and economy averages merge alternate accounts once and exclude missing details and solo games',t=>{
  const s=fixture(t),params=new URLSearchParams('mode=0'),a=memberStats(s,params).find(r=>r.name==='A');
  assert.equal(a.matches,3);assert.equal(a.detail_matches,2);assert.equal(a.supply_matches,2);
  assert.equal(a.supply_consumed,1200);assert.equal(a.avg_supply_consumed,600);
  assert.equal(a.avg_received_allies,300);assert.equal(a.avg_supplied_allies,150);
  assert.equal(a.avg_spawned_score,2400);assert.equal(a.avg_refunded_score,200);
  assert.equal(a.avg_kills,6);assert.equal(a.avg_units_lost,4);assert.equal(a.avg_experience,4000);assert.equal(a.avg_raw_experience,0);
  const missing=memberStats(s,new URLSearchParams('q=802')).find(r=>r.name==='A');
  assert.equal(missing.avg_received_allies,null);assert.equal(missing.avg_supply_consumed,null);assert.equal(missing.avg_spawned_score,null);assert.equal(missing.supply_matches,0);
});

test('supply rankings use per-game means, tie ranks and complete-detail thresholds under active filters',t=>{
  const s=fixture(t),params=new URLSearchParams('mode=0&supply_min_games=2'),data=supplyAnalysis(s,params);
  assert.equal(data.min_games,2);assert.equal(data.eligible,3);
  assert.deepEqual(data.hungry.map(r=>[r.name,r.avg_received_allies]),[['A',300],['B',250],['C',150]]);
  assert.deepEqual(data.transport.map(r=>[r.name,r.avg_supplied_allies]),[['B',800],['A',150],['C',25]]);
  assert.equal(supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=3')).eligible,0);
  assert.equal(supplyAnalysis(s,params).members.find(r=>r.name==='A').received_allies,600);
  assert.equal(supplyAnalysis(s,new URLSearchParams('mode=1&supply_min_games=1')).hungry[0].avg_received_allies,2000);
  assert.equal(supplyAnalysis(s,new URLSearchParams('q=802&supply_min_games=1')).hungry.length,0);
  const tie=detailFor(rawMatch(undefined,{Type:0}));tie.data.Data['104'].TeamId=0;
  tie.data.Data['101'].SupplyPointsConsumedFromAllies=500;tie.data.Data['102'].SupplyPointsConsumedFromAllies=500;s.saveDetail('800',tie);
  assert.deepEqual(supplyAnalysis(s,new URLSearchParams('q=800&supply_min_games=1')).hungry.map(r=>r.rank),[1,1,3]);
  for(const value of ['', '0','-1','1.5','oops','Infinity','10001'])assert.equal(supplyAnalysis(s,new URLSearchParams('supply_min_games='+value)).min_games,5);
});

test('supply ranks by mean rather than total and keeps friends without complete detail unranked',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);member(s,'D',[104]);
  for(let i=0;i<3;i++){
    const raw=rawMatch(i===0?[101,102,103,104]:[101,103,104],{Type:0});s.ingest(String(800+i),raw);
    const detail=detailFor(raw);detail.data.Data['101'].SupplyPointsConsumedFromAllies=100;
    if(i===0)detail.data.Data['102'].SupplyPointsConsumedFromAllies=200;
    s.saveDetail(String(800+i),detail);
  }
  const data=supplyAnalysis(s,new URLSearchParams('supply_min_games=1'));
  assert.equal(data.hungry[0].name,'B');assert.equal(data.hungry[0].received_allies,200);
  assert.equal(data.hungry[1].name,'A');assert.equal(data.hungry[1].received_allies,300);
  const strict=supplyAnalysis(s,new URLSearchParams('supply_min_games=2'));assert(!strict.hungry.some(r=>r.name==='B'));
});

test('teammate minimum counts distinct same-team matches, not accounts, and respects match filters',t=>{
  const s=fixture(t);
  assert.equal(dashboard(s,new URLSearchParams()).combo_min_games,5);assert.equal(dashboard(s,new URLSearchParams()).combos.length,0);
  const data=dashboard(s,new URLSearchParams('mode=0&combo_min_games=3'));
  assert.equal(data.combos.length,3);assert(data.combos.every(r=>r.matches===3));
  assert.equal(dashboard(s,new URLSearchParams('mode=0&combo_min_games=4')).combos.length,0);
  assert.equal(dashboard(s,new URLSearchParams('mode=1&combo_min_games=1')).combos.length,3);
  for(const value of ['0','-1','2.5','x','10001'])assert.equal(dashboard(s,new URLSearchParams('combo_min_games='+value)).combo_min_games,5);
});

test('charge rankings use score exchange, requested directions and independent sample counts',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Short',[105]);
  for(let i=0;i<2;i++){
    const raw=rawMatch(i===0?[101,102,103,104,105]:[101,102,103],{Type:0,WinnerTeam:0});
    for(const[id,p]of Object.entries(raw.Data)){
      p.DestructionScore=id==='102'?100:id==='103'?500:2000;p.ObjectivesCaptured=id==='101'||id==='104'?0:2;
      p.TeamId=id==='103'?1:0;p.OldRating=1500;p.NewRating=1500+(id==='101'?-10:id==='104'?-5:id==='103'?-20:5);
    }
    s.ingest(String(800+i),raw);const d=detailFor(raw);
    for(const[id,p]of Object.entries(d.data.Data))Object.assign(p,{Destruction:id==='102'?5:id==='101'?2:id==='104'?1:0,Losses:id==='101'?2:id==='104'?1:0,SupplyPointsConsumedByAllies:id==='102'?900:id==='103'?0:100});
    s.saveDetail(String(800+i),d);
  }
  const summary=rawMatch([101,102,103],{Type:0});for(const p of Object.values(summary.Data)){p.OldRating=null;p.NewRating=null;p.DestructionScore=p.Id===102?100:p.Id===103?500:2000;p.ObjectivesCaptured=p.Id===101?0:2;}s.ingest('802',summary);
  const data=supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=2'));
  assert.equal(data.charges.length,10);
  const charges=Object.fromEntries(data.charges.map(c=>[c.id,c]));
  assert.equal(charges.transport.direction,'desc');
  assert.equal(charges.transport.title,'运输大队长');
  assert.deepEqual(data.charges.filter(c=>c.group==='mitigation').map(c=>c.id),['transport','heavy_aa_kills','air_superiority']);
  assert.equal(data.charges.filter(c=>c.group==='sentencing').length,7);assert.deepEqual(charges.transport.rows.map(r=>r.name),['B','A','C']);
  assert.deepEqual(charges.kd.rows.map(r=>r.name),['B','C','A']);assert.equal(charges.kd.rows[0].unit_kd,'Infinity');
  assert.equal(charges.kd.key,'score_ratio');assert.equal(charges.kd.label,'分数交换比');
  assert.deepEqual(charges.kd.rows.map(r=>r.score_ratio),[0.2,1,4]);
  assert(charges.kd.rows.every(r=>r.sample_count===3));
  assert.equal(charges.kills.key,'avg_destruction');assert.equal(charges.kills.rows[0].name,'B');assert.equal(charges.kills.rows[0].avg_destruction,100);
  assert.equal(charges.kd.title,'KD失职罪');assert.equal(charges.objectives.rows[0].name,'A');assert.equal(charges.objectives.rows[0].avg_objectives,0);assert.equal(charges.losses.rows[0].name,'A');
  assert.equal(charges.wins.rows[0].name,'C');assert.equal(charges.rating,undefined);
  assert.equal(charges.losses.rows.find(r=>r.name==='A').sample_count,3);
  const unknown=supplyAnalysis(s,new URLSearchParams('q=802&supply_min_games=1'));
  assert.equal(unknown.charges.find(c=>c.id==='heavy_aa_kills').rows.length,0);
  assert.equal(unknown.charges.find(c=>c.id==='kd').rows.length,3);
});

test('score exchange merges alts, divides cumulative scores, admits summary-only games and preserves filters and infinity',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'D',[105]);
  const game=(id,values,extra={})=>{
    const raw=rawMatch(Object.keys(values).map(Number),{Type:0,...extra});
    for(const [id,[destruction,losses]]of Object.entries(values))Object.assign(raw.Data[id],{DestructionScore:destruction,LossesScore:losses});
    s.ingest(id,raw);
  };
  game('800',{101:[1000,100],104:[0,900],102:[300,100],103:[0,0],105:[100,0]});
  game('801',{101:[100,1000],102:[100,1000],103:[0,100]},{MapId:7});
  game('802',{101:[99999,1],102:[99999,1],103:[99999,1]},{Type:1});
  game('899',{101:[99999,1],900:[0,1],901:[0,1]});
  const board=params=>supplyAnalysis(s,new URLSearchParams(params)).charges.find(c=>c.id==='kd');
  const b=board('mode=0&supply_min_games=1');assert.deepEqual(b.rows.map(r=>r.name),['C','B','A','D']);
  assert.deepEqual(b.rows.map(r=>r.score_ratio),[0,400/1100,1100/2000,'Infinity']);
  assert.deepEqual(b.rows.map(r=>r.sample_count),[2,2,2,1]);assert(b.rows.every(r=>r.detail_matches===0));
  assert.equal(JSON.parse(JSON.stringify(b)).rows[3].score_ratio,'Infinity');
  const summary=memberStats(s,new URLSearchParams('mode=0'));
  assert(b.rows.every(r=>{const m=summary.find(m=>m.member_id===r.member_id);return r.score_ratio===(m.losses?m.destruction/m.losses:'Infinity');}));
  assert.deepEqual(board('mode=0&supply_min_games=2').rows.map(r=>r.name),['C','B','A']);
  assert.equal(board('mode=0&map=7&supply_min_games=1').rows.find(r=>r.name==='A').score_ratio,0.1);
  assert(!board('mode=0&q=800&supply_min_games=1').rows.some(r=>r.name==='C'));
  assert.equal(board('mode=1&supply_min_games=1').rows.find(r=>r.name==='A').score_ratio,99999);
  const html=createPerformance({S:{supplyMin:1},esc:v=>String(v),icon:()=>'',fmt:(n,p=0)=>Number(n).toFixed(p),empty:()=>''}).supplyView(supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=1')));
  assert(html.includes('data-table-sort="score_ratio"'));assert(html.includes('分数交换比'));assert(html.includes('摧毁分 1100.0 / 损失分 2000.0'));
  assert(!html.includes('K/D 为击毁单位数'));
});

test('self-destruction ranks personal per-game scores, merges alts, retains zero games and excludes refunds, solo and incomplete records',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'D',[105]);
  selfDestructionPrices(s);
  const units=n=>Object.fromEntries(Array.from({length:n},(_,i)=>[String(i+1),{Id:238,OptionIds:[560,1634],SelfDestruction:true,...(i===0?{DeathTime:100}:{})}]));
  const game=(id,ids,counts,mode=0)=>{
    const raw=rawMatch(ids,{Type:mode});s.ingest(id,raw);const d=detailFor(raw);
    for(const [id,p]of Object.entries(d.data.Data))p.UnitData=units(counts[id]??0);
    s.saveDetail(id,d);return d;
  };
  const d=game('800',[101,104,102,103],{101:2,104:1,102:4});
  d.data.Data['101'].UnitData.refund={Id:238,SelfDestruction:true,WasRefunded:true};
  d.data.Data['103'].UnitData.selfDamage={Id:238,TotalSelfDamageDealt:9000};s.saveDetail('800',d);
  game('801',[101,103,105],{101:2});game('802',[101,103,105],{101:1});
  s.ingest('803',rawMatch([101,102,103],{Type:0}));
  game('899',[101,900,901],{101:100});game('804',[101,102,103],{101:20},1);
  const board=params=>supplyAnalysis(s,new URLSearchParams(params)).charges.find(c=>c.id==='self_destruction');
  const b=board('mode=0&supply_min_games=1');
  assert.equal(b.title,'自毁长城罪');assert.equal(b.direction,'desc');assert.equal(b.group,'sentencing');assert.equal(b.format,'decimal2');
  assert.deepEqual(b.rows.map(r=>[r.name,r.self_destructions,r.avg_self_destructions,r.sample_count]),[['B',4,4,1],['A',6,2,3],['C',0,0,3],['D',0,0,2]]);
  assert.deepEqual(b.rows.map(r=>r.rank),[1,2,3,3]);
  assert.equal(b.key,'avg_self_destruction_score');
  assert.deepEqual(b.rows.map(r=>[r.avg_self_destruction_score,r.self_destruction_score_ranked]),[[440,440],[220,660],[0,0],[0,0]]);
  assert.deepEqual(b.rows[1].self_destruction_cases.map(m=>[m.match_id,m.count]),[['802',1],['801',2],['800',3]]);
  assert.deepEqual(board('mode=0&supply_min_games=2').rows.map(r=>r.name),['A','C','D']);
  assert.equal(board('q=803&supply_min_games=1').rows.length,0);
  assert.equal(board('mode=1&supply_min_games=1').rows.find(r=>r.name==='A').self_destructions,20);
  const html=createPerformance({S:{supplyMin:1},esc:v=>String(v),icon:()=>'',fmt:(n,p=0)=>Number(n).toFixed(p),empty:()=>''}).supplyView(supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=1')));
  assert(html.includes('自毁长城罪'));assert(html.includes('data-table-sort="avg_self_destruction_score"'));assert(html.includes('累计确认 6 个'));assert(html.includes('href="#match/800"'));assert(html.includes('Fixture armored unit'));assert(html.includes('标准装甲'));
  const invalid=JSON.parse(s.get("SELECT detail_json FROM matches WHERE id='801'").detail_json);invalid.data.Data['101'].UnitData.bad={Id:238,SelfDestruction:'true'};s.saveDetail('801',invalid);
  const a=board('mode=0&supply_min_games=1').rows.find(r=>r.name==='A');assert.equal(a.self_destructions,6);assert.equal(a.self_destructions_ranked,4);assert.equal(a.sample_count,2);assert.equal(a.self_destruction_excluded,2);
  assert(!board('q=801&supply_min_games=1').rows.some(r=>r.name==='A'));
});

test('heavy AA ranks kills from every role-15 model, merges alts and retains kills before refunds or death',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  const ids=[156,163,225,227,231,251,448,466,545,9999];
  for(const id of ids)s.run('INSERT INTO unit_catalogue VALUES(?,?,?)',String(id),JSON.stringify({id,hudName:`Heavy ${id}`,role:id===9999?'15':15}),'now');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','31',JSON.stringify({id:31,hudName:'Tor',role:16}),'now');
  function game(id,players=[101,102,103,104],mode=0){
    const raw=rawMatch(players,{Type:mode});s.ingest(id,raw);const d=detailFor(raw);
    for(const p of Object.values(d.data.Data))p.UnitData={};
    for(const [i,unit]of ids.entries())d.data.Data['101'].UnitData['heavy'+i]={Id:unit,SpawnTime:1,DeathTime:2,WasRefunded:i%2===0,KilledCount:i+1};
    d.data.Data['101'].UnitData.repeat={Id:156,SpawnTime:3,KilledCount:7};
    d.data.Data['101'].UnitData.light={Id:31,SpawnTime:3,KilledCount:999};
    if(d.data.Data['104'])d.data.Data['104'].UnitData.alt={Id:163,SpawnTime:1,KilledCount:3};
    s.saveDetail(id,d);
  }
  game('800');
  const zero=rawMatch(undefined,{Type:0});s.ingest('801',zero);const d=detailFor(zero);
  for(const p of Object.values(d.data.Data))p.UnitData={};s.saveDetail('801',d);
  game('802');s.run("UPDATE matches SET detail_state='error' WHERE id='802'");
  game('803',undefined,1);game('899',[101,900,901]);
  const result=supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=2'));
  const board=result.charges.find(c=>c.id==='heavy_aa_kills');
  assert.equal(board.direction,'desc');assert.equal(board.group,'mitigation');assert.equal(board.key,'avg_heavy_aa_kills');assert.equal(board.title,'重防赎罪榜');assert.equal(board.format,'decimal2');
  assert(!result.charges.some(c=>c.id==='heavy_aa'||c.title==='防空守护者'));
  assert.deepEqual(board.rows.map(r=>[r.name,r.heavy_aa_kills]),[['A',65],['B',0],['C',0]]);
  assert.equal(board.rows[0].avg_heavy_aa_kills,32.5);assert.equal(board.rows[0].heavy_aa_units.length,10);assert.equal(board.rows[0].sample_count,2);
  assert.deepEqual({...board.rows[0].heavy_aa_units.find(u=>u.unit_id==='163')},{member_id:1,unit_id:'163',deployments:2,kills:5,name:'Heavy 163'});
  assert.equal(supplyAnalysis(s,new URLSearchParams('q=801&supply_min_games=1')).charges.find(c=>c.id==='heavy_aa_kills').rows[0].heavy_aa_kills,0);
  assert.equal(supplyAnalysis(s,new URLSearchParams('mode=0&supply_min_games=3')).charges.find(c=>c.id==='heavy_aa_kills').rows.length,0);
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const ui=createPerformance({S:{supplyMin:2},esc,fmt:n=>String(n),icon:()=>'',empty:()=>''});
  board.rows[0].heavy_aa_units[0].name='<script>unit</script>';
  const html=ui.supplyView(result);
  assert(html.includes('重防赎罪榜'));assert(!html.includes('防空守护者'));assert(html.includes('累计重防击杀 65'));
  assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('击杀 10 · 部署 1 次'));
});

test('heavy AA ranks per-game kills rather than deployments or totals and excludes missing detail',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);member(s,'D',[104]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','163',JSON.stringify({id:163,hudName:'Patriot PAC-2',role:15}),'now');
  for(let i=0;i<4;i++){
    const raw=rawMatch(i===0||i===3?[101,102,103]:[101,103,104],{Type:0});s.ingest(String(800+i),raw);
    if(i===3)continue;
    const d=detailFor(raw);for(const p of Object.values(d.data.Data))p.UnitData={};
    d.data.Data['101'].UnitData.a={Id:163,KilledCount:1};
    if(i===0){d.data.Data['101'].UnitData.b={Id:163,KilledCount:4};d.data.Data['102'].UnitData={a:{Id:163,KilledCount:3},b:{Id:163,KilledCount:1}};}
    s.saveDetail(String(800+i),d);
  }
  const board=supplyAnalysis(s,new URLSearchParams('supply_min_games=1')).charges.find(c=>c.id==='heavy_aa_kills');
  assert.deepEqual(board.rows.map(r=>[r.name,r.heavy_aa_kills,r.avg_heavy_aa_kills,r.sample_count]),[['B',4,4,1],['A',7,7/3,3],['C',0,0,3],['D',0,0,2]]);
  assert.deepEqual(supplyAnalysis(s,new URLSearchParams('supply_min_games=2')).charges.find(c=>c.id==='heavy_aa_kills').rows.map(r=>r.name),['A','C','D']);
});

test('unclassified units and invalid kill counts exclude the whole friend-match instead of becoming zero',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','163',JSON.stringify({id:163,hudName:'Patriot',role:15}),'now');
  for(let i=0;i<3;i++){
    const raw=rawMatch(undefined,{Type:0});s.ingest(String(800+i),raw);const d=detailFor(raw);
    for(const p of Object.values(d.data.Data))p.UnitData={};
    d.data.Data['101'].UnitData.a={Id:163,KilledCount:i?200:2};
    if(i===1)d.data.Data['104'].UnitData.unknown={Id:9999,KilledCount:100};
    if(i===2)d.data.Data['101'].UnitData.a.KilledCount=-1;
    s.saveDetail(String(800+i),d);
  }
  const result=supplyAnalysis(s,new URLSearchParams('supply_min_games=1')),a=result.members.find(r=>r.name==='A');
  assert.equal(a.detail_matches,3);assert.equal(a.heavy_aa_kill_matches,1);assert.equal(a.heavy_aa_kill_excluded,2);assert.equal(a.heavy_aa_kills,2);assert.equal(a.avg_heavy_aa_kills,2);
  assert.equal(a.heavy_aa_units[0].deployments,1);
  const unknown=supplyAnalysis(s,new URLSearchParams('q=801&supply_min_games=1')).members.find(r=>r.name==='A');
  assert.equal(unknown.heavy_aa_kills,null);assert.equal(unknown.avg_heavy_aa_kills,null);assert.equal(unknown.heavy_aa_kill_matches,0);
  assert(!supplyAnalysis(s,new URLSearchParams('supply_min_games=2')).charges.find(c=>c.id==='heavy_aa_kills').rows.some(r=>r.name==='A'));
});
