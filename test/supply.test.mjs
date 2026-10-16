import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { memberStats, supplyAnalysis, dashboard } from '../src/queries.mjs';

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
