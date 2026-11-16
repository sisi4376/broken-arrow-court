import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import { testStore,member,rawMatch,detailFor } from './helpers.mjs';
import { dashboard,memberStats,listMatches,matchDetail } from '../src/queries.mjs';

test('all-match party filter includes solo and pair games while the default and same-team gates stay intact',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  for(const[id,players]of [['800',[101,201,202,203]],['801',[101,102,201,202]],['802',[101,102,201,103]],['803',[101,102,103,201]],['804',[201,202,203,204]]]){
    s.ingest(id,rawMatch(players,{Type:0,MapId:id==='800'?12:4}));
  }
  const matches=query=>listMatches(s,new URLSearchParams(query)).total;
  assert.equal(matches(''),2);assert.equal(matches('team=same'),1);assert.equal(matches('team=all'),4);
  assert.equal(matches('team=all&mode=1'),0);assert.equal(matches('team=all&map=12'),1);
  assert.equal(matches('team=all&member=3'),2);assert.equal(matches('team=all&q=800'),1);
  assert.equal(matches('team=all&from=2099-01-01'),0);assert.equal(matches('team=invalid'),2);
  assert.equal(dashboard(s,new URLSearchParams('team=all')).overview.matches,4);
  assert.equal(memberStats(s,new URLSearchParams('team=all')).find(m=>m.member_id===1).matches,4);
  assert.equal(memberStats(s).find(m=>m.member_id===1).matches,2);
});

test('three accounts of one person never qualify as three friends',t=>{
  const s=testStore(t);member(s,'One',[101,102,103]);s.ingest('800',rawMatch());
  assert.equal(s.get('SELECT friend_count FROM matches').friend_count,1);assert.equal(dashboard(s,new URLSearchParams()).overview.matches,0);
});

test('teammate sorting receives every eligible pair instead of an initial top-20 subset',t=>{
  const s=testStore(t),ids=Array.from({length:7},(_,i)=>101+i);
  for(const id of ids)member(s,'Friend '+id,[id]);
  const raw=rawMatch(ids);for(const p of Object.values(raw.Data))p.TeamId=0;
  s.ingest('800',raw);
  assert.equal(dashboard(s,new URLSearchParams('combo_min_games=1')).combos.length,21);
});

test('map distribution, match lists and details share names and retain unknown map IDs',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  s.ingest('800',rawMatch(undefined,{MapId:22}));s.ingest('801',rawMatch(undefined,{MapId:27}));
  const f=new URLSearchParams('map=22');
  assert.equal(dashboard(s,f).maps[0].name,'Ignalina Powerplant');assert.equal(listMatches(s,f).items[0].map_name,'Ignalina Powerplant');assert.equal(matchDetail(s,'800').map_name,'Ignalina Powerplant');
  const daugavpils=new URLSearchParams('map=27');
  assert.equal(dashboard(s,daugavpils).maps[0].name,'Daugavpils');assert.equal(listMatches(s,daugavpils).items[0].map_name,'Daugavpils');
  assert.equal(matchDetail(s,'801').map_name,'Daugavpils');assert.equal(matchDetail(s,'801').raw.MapId,27);assert.equal(listMatches(s,daugavpils).total,1);
  for(const[id,map,name]of [['802',25,'Kadaga Military Base'],['803',28,'Coal Mountain'],['804',999,'未知地图 #999']]){
    s.ingest(id,rawMatch(undefined,{MapId:map}));const f=new URLSearchParams('map='+map);
    assert.equal(matchDetail(s,id).map_name,name);assert.equal(matchDetail(s,id).raw.MapId,map);
    assert.equal(dashboard(s,f).maps[0].name,name);assert.equal(listMatches(s,f).items[0].map_name,name);
  }
});

test('mode migration restores omitted normal modes, preserves unknown imports, and stats obey mode filters',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  const normal=rawMatch();delete normal.Type;s.ingest('800',normal);s.ingest('801',rawMatch());s.ingest('802',rawMatch(undefined,{Type:3}));
  s.ingest('803',{players:[{id:101},{id:102},{id:103}]});
  s.run("UPDATE matches SET mode=NULL WHERE id='800'");s.db.exec('DROP TABLE match_decks; DROP TABLE analysis_catalogue; DROP TABLE source_requests; DROP TABLE source_request_blocks; DROP TABLE request_history_evidence; PRAGMA user_version=2');s.migrate();
  assert.equal(s.get("SELECT mode FROM matches WHERE id='800'").mode,'0');
  assert.equal(s.get("SELECT mode FROM matches WHERE id='803'").mode,null);
  assert.equal(s.get('PRAGMA user_version').user_version,7);
  const f=new URLSearchParams('mode=0');assert.equal(dashboard(s,f).overview.matches,1);assert.equal(listMatches(s,f).total,1);assert(memberStats(s,f).every(r=>r.matches===1));
  assert.equal(listMatches(s,new URLSearchParams('mode=1')).total,1);assert.equal(listMatches(s,new URLSearchParams('mode=3')).total,1);
  assert.equal(listMatches(s,new URLSearchParams()).total,4);
  s.migrate();assert.equal(s.get('SELECT COUNT(*) n FROM matches').n,4);
});

test('old official unknown modes are repaired from preserved raw evidence without touching explicit types, units, or snapshots',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  const original=detailFor(rawMatch()).data;delete original.Type;
  const mistaken={...original,Type:-1};
  s.snapshot('/fights/fight_900.json',original);s.ingest('900',mistaken,1);s.saveDetail('900',{data:mistaken,metadata:{source:'official',mode_unknown:true}});
  const explicit=detailFor(rawMatch(undefined,{Type:-1})).data;
  s.snapshot('/fights/fight_901.json',explicit);s.ingest('901',explicit,1);s.saveDetail('901',{data:explicit,metadata:{source:'official',mode_unknown:true}});
  s.ingest('902',rawMatch(undefined,{Type:1}),1);s.ingest('903',rawMatch(undefined,{Type:3}),1);
  s.ingest('904',mistaken,1);s.saveDetail('904',{data:mistaken,metadata:{source:'other',mode_unknown:true}});
  const network=s.get("SELECT content_hash,payload_gzip FROM source_snapshots WHERE source_key='/fights/fight_900.json'");
  const units=s.get('SELECT COUNT(*) n FROM unit_instances').n;
  s.migrate();
  const fixed=s.get("SELECT * FROM matches WHERE id='900'"),detail=JSON.parse(fixed.detail_json);
  assert.equal(fixed.mode,'0');assert.equal(JSON.parse(fixed.raw_json).Type,0);assert.equal(detail.data.Type,0);
  assert.equal(detail.metadata.mode_unknown,false);assert.equal(detail.metadata.mode_defaulted,true);
  assert.equal(s.ingest('900',JSON.parse(fixed.raw_json),1).changed,false);
  assert.equal(s.get("SELECT mode FROM matches WHERE id='901'").mode,'-1');assert.equal(s.get("SELECT mode FROM matches WHERE id='902'").mode,'1');assert.equal(s.get("SELECT mode FROM matches WHERE id='903'").mode,'3');assert.equal(s.get("SELECT mode FROM matches WHERE id='904'").mode,'-1');
  const unchanged=s.get("SELECT content_hash,payload_gzip FROM source_snapshots WHERE source_key='/fights/fight_900.json'");
  assert.equal(unchanged.content_hash,network.content_hash);assert.deepEqual(unchanged.payload_gzip,network.payload_gzip);assert.equal(Object.hasOwn(JSON.parse(gunzipSync(unchanged.payload_gzip)),'Type'),false);
  assert.equal(s.get('SELECT COUNT(*) n FROM unit_instances').n,units);
  assert.equal(listMatches(s,new URLSearchParams('mode=0')).total,1);
  assert.equal(listMatches(s,new URLSearchParams('mode=1')).total,1);
  assert.equal(listMatches(s,new URLSearchParams('mode=3')).total,1);
  const snapshots=s.get('SELECT COUNT(*) n FROM source_snapshots').n;s.migrate();assert.equal(s.get('SELECT COUNT(*) n FROM source_snapshots').n,snapshots);
});
test('at least three distinct friends in either team qualify, same team remains a separate filter',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[104]);s.ingest('800',rawMatch());
  assert.equal(s.get('SELECT friend_count FROM matches').friend_count,3);assert.equal(s.get('SELECT same_team_count FROM matches').same_team_count,2);
  assert.equal(dashboard(s,new URLSearchParams()).overview.matches,1);assert.equal(dashboard(s,new URLSearchParams('team=same')).overview.matches,0);
});
test('spectators are excluded and disabling or reassigning an account reclassifies old matches',t=>{
  const s=testStore(t);const a=member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103,104]);const raw=rawMatch();raw.Data['104'].TeamId=100;s.ingest('800',raw);
  assert.equal(s.get('SELECT friend_count FROM matches').friend_count,3);
  s.run('UPDATE accounts SET member_id=? WHERE player_id=?',a,'103');s.reclassify();assert.equal(s.get('SELECT friend_count FROM matches').friend_count,2);
  s.run('UPDATE members SET active=0 WHERE id=?',a);s.reclassify();assert.equal(s.get('SELECT friend_count FROM matches').friend_count,1);
});
test('summary deduplication preserves rich data and unit records after later summary changes',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);const raw=rawMatch();
  assert.equal(s.ingest('800',raw).added,true);assert.deepEqual(s.ingest('800',raw),{added:false,changed:false});
  s.saveDetail('800',detailFor(raw));raw.Data['101'].Name='Renamed';s.ingest('800',raw);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,1);assert.equal(s.get('SELECT COUNT(*) AS n FROM unit_instances').n,4);
  assert.equal(JSON.parse(s.get('SELECT raw_json FROM participants WHERE player_id=?','101').raw_json).DamageDealt,400);
  assert.equal(s.get('SELECT detail_state FROM matches').detail_state,'complete');
  assert.equal(s.all('SELECT id FROM source_snapshots WHERE source_key=?','match:800').length,2);
});
test('member statistics count each match once when multiple accounts appear and exclude unqualified solo games',t=>{
  const s=testStore(t);const a=member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);s.ingest('800',rawMatch());s.ingest('801',rawMatch([101,200,201,202]));
  const stats=memberStats(s);const row=stats.find(r=>r.member_id===a);assert.equal(row.matches,1);assert.equal(row.destruction,2300);assert.equal(row.decided,0);assert.equal(row.rating_delta,0);
  assert.equal(dashboard(s,new URLSearchParams()).overview.matches,1);
});

test('per-match averages merge alternate accounts and use only available detail samples for friendly fire',t=>{
  const s=testStore(t);const a=member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  const first=rawMatch();s.ingest('800',first);
  const detail=detailFor(first);detail.data.Data['101'].DamageFriendlyFireDealt=12;detail.data.Data['104'].DamageFriendlyFireDealt=8;s.saveDetail('800',detail);
  const second=rawMatch([101,102,103]);second.Data['101'].DestructionScore=700;second.Data['101'].LossesScore=200;second.Data['101'].ObjectivesCaptured=2;s.ingest('801',second);
  const third=rawMatch([101,102,103]);third.Data['101'].DestructionScore=0;third.Data['101'].LossesScore=0;s.ingest('802',third);s.saveDetail('802',detailFor(third));
  const row=memberStats(s).find(r=>r.member_id===a);
  assert.equal(row.matches,3);assert.equal(row.avg_destruction,1000);assert.equal(row.avg_losses,400);assert.equal(row.avg_objectives,5/3);
  assert.equal(row.avg_friendly_fire,10);assert.equal(row.friendly_fire_matches,2);
  const filtered=memberStats(s,new URLSearchParams('q=801')).find(r=>r.member_id===a);
  assert.equal(filtered.avg_destruction,700);assert.equal(filtered.avg_friendly_fire,null);assert.equal(filtered.friendly_fire_matches,0);
  const match=listMatches(s,new URLSearchParams('q=800')).items[0];assert.equal(match.totals.avg_destruction,4600/3);assert.equal(match.totals.avg_losses,2000/3);
});
test('nested import transaction rolls back the whole file on invalid records',t=>{
  const s=testStore(t);assert.throws(()=>s.transaction(()=>{s.ingest('800',rawMatch());s.ingest('801',{});}));
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,0);assert.equal(s.get('SELECT COUNT(*) AS n FROM source_snapshots').n,0);
});
test('online backup contains a consistent, restorable SQLite database',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch());const file=await s.backup();const restored=new DatabaseSync(file,{readOnly:true});
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM matches').get().n,1);restored.close();
});

test('an existing version 1 archive gains history-gap tracking without losing accounts or matches',t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch());
  s.db.exec('DROP TABLE account_history_gaps; DROP TABLE match_decks; DROP TABLE analysis_catalogue; DROP TABLE source_requests; DROP TABLE source_request_blocks; DROP TABLE request_history_evidence; PRAGMA user_version=1;');s.migrate();
  assert.equal(s.get('SELECT COUNT(*) AS n FROM accounts').n,1);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,1);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM account_history_gaps').n,0);
  s.migrate();assert.equal(s.get('SELECT COUNT(*) AS n FROM matches').n,1);
});
