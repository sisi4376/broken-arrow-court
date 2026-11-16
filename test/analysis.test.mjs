import test from 'node:test';
import assert from 'node:assert/strict';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
import {friendAnalysis,overallAnalysis,identifyDeck} from '../src/analysis.mjs';
import {compileIconVariants} from '../src/unit-icons.mjs';

export const model={specializations:[{id:3,name:'Marines',countryId:2},{id:4,name:'Armor',countryId:2},{id:5,name:'Airborne',countryId:2},{id:7,name:'VDV',countryId:1},{id:8,name:'Tank',countryId:1}],units:{238:{country_id:2,spec_ids:[3]},239:{country_id:2,spec_ids:[4]},240:{country_id:2,spec_ids:[5]}}};
function seed(s){s.run("INSERT INTO analysis_catalogue VALUES('deck_model',?,'2026-10-15')",JSON.stringify(model));}
function game(s,id,{win=true,map=4,mode=0,players=[101,102,103],second=239}={}){
  const raw=rawMatch(players,{WinnerTeam:win?0:1,MapId:map,Type:mode,EndTime:1792050000+Number(id)});
  raw.Data['103'].TeamId=1;s.ingest(id,raw);
  const detail=detailFor(raw);
  for(const [pid,p]of Object.entries(detail.data.Data))p.UnitData={['1'+pid]:{Id:238,SpawnTime:1792050001,KilledCount:2,TotalDamageDealt:50},['2'+pid]:{Id:second,SpawnTime:1792050010,DeathTime:1792050200,TotalDamageDealt:10}};
  s.saveDetail(id,detail);
}

test('specialization inference requires a unique same-country pair; manual confirmation takes precedence',()=>{
  assert.equal(identifyDeck({UnitData:{a:{Id:238},b:{Id:239}}},null,model).key,'3_4');
  assert.equal(identifyDeck({UnitData:{a:{Id:238}}},null,model).source,'unknown');
  assert.equal(identifyDeck({},null,model).source,'unknown');
  const d=identifyDeck({UnitData:{a:{Id:238},b:{Id:239}}},{spec1:3,spec2:5},model);
  assert.equal(d.key,'3_5');assert.equal(d.source,'confirmed');
  assert.equal(identifyDeck({AnalysisUnitIds:['238','239']},null,model).key,'3_4');
});

test('friend reports separate same-team partners from opponents and enforce ranking sample thresholds',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);member(s,'D',[105]);seed(s);
  for(let i=0;i<6;i++)game(s,String(800+i),{win:i<4,map:i<3?4:9});
  game(s,'810',{players:[101,105,103]});
  let a=friendAnalysis(s,1);
  assert.equal(a.overview.matches,7);assert.equal(a.overview.wins,5);
  assert.equal(a.teammates.most.name,'B');assert.equal(a.teammates.best.name,'B');
  assert.equal(a.teammates.rows.find(r=>r.name==='C').same.matches,0);
  assert.equal(a.teammates.rows.find(r=>r.name==='C').opposed.matches,7);
  assert.equal(a.teammates.rows.find(r=>r.name==='B').same.matches,6);
  a=friendAnalysis(s,1,new URLSearchParams('min_games=1'));assert.equal(a.teammates.best.name,'D');
});

test('deck and map win rates obey filters and retain unknown decks without ranking them as favorites',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);seed(s);
  game(s,'800');game(s,'801',{win:false,map:9});game(s,'802',{mode:1,second:240});
  const a=friendAnalysis(s,1,new URLSearchParams('mode=0&map=4'));
  assert.equal(a.overview.matches,1);assert.equal(a.decks[0].key,'3_4');assert.equal(a.decks[0].wins,1);
  assert.equal(a.maps[0].map_id,'4');assert.equal(a.deck_maps.length,1);
  const b=overallAnalysis(s,new URLSearchParams('mode=0'));
  assert.equal(b.overview.matches,6);assert.equal(b.overview.unique_matches,2);assert.equal(b.overview.win_rate,0.5);
  const personal=overallAnalysis(s,new URLSearchParams('mode=0&member=1'));assert.equal(personal.overview.matches,2);
  const raw=rawMatch([101,102,103],{Type:0});s.ingest('803',raw);
  const c=friendAnalysis(s,1,new URLSearchParams('mode=0'));
  assert.equal(c.overview.matches,3);assert.equal(c.overview.deck_known,2);assert(c.decks.some(d=>d.key==='unknown'));
  assert.notEqual(c.favorites.deck.key,'unknown');
});

test('favorite units count each friend-match once, merge alternate accounts, and exclude incomplete detail',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);seed(s);
  game(s,'800',{players:[101,102,103,104]});game(s,'801',{win:false});
  s.ingest('802',rawMatch([101,102,103],{Type:0}));
  const a=friendAnalysis(s,1);const u=a.units.find(u=>u.unit_id==='238');
  assert.equal(a.overview.matches,3);assert.equal(u.matches,2);assert.equal(u.instances,3);assert.equal(u.kills,6);
  assert.equal(u.damage,150);assert.equal(u.usage_rate,1);
  assert.equal(u.decided,1); // 800 has A on both teams, so its outcome is unknown.
  assert.equal(u.wins,0);assert.equal(a.teammates.rows.find(r=>r.name==='B').unclassified,1);
});

test('portrait unit leaders rank deployments rather than matches and total damage/kills, preserving ties and filters',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty',[]);seed(s);
  function add(id,{map=4,mode=0,players=[101,102,103],unitData={},alternate={}}={}){
    const raw=rawMatch(players,{Type:mode,MapId:map});s.ingest(id,raw);const detail=detailFor(raw);
    detail.data.Data['101'].UnitData=unitData;
    if(detail.data.Data['104'])detail.data.Data['104'].UnitData=alternate;
    s.saveDetail(id,detail);
  }
  const u=(Id,TotalDamageDealt=0,KilledCount=0)=>({Id,TotalDamageDealt,KilledCount});
  add('800',{players:[101,102,103,104],unitData:{a:u(238,10,1),...Object.fromEntries(Array.from({length:5},(_,i)=>['b'+i,u(239,2)])),c:u(240,200,2),d:u(241,5,20)},alternate:{a:u(239,4,1)}});
  add('801',{unitData:{a:u(238,10,1),b:u(242,200,20)}});
  add('802',{map:9,unitData:{a:u(999,9999,9999)}});
  add('803',{mode:1,unitData:{a:u(999,9999,9999)}});
  add('804',{players:[101,102,201],unitData:{a:u(999,9999,9999)}});
  s.ingest('805',rawMatch([101,102,103],{Type:0}));
  const report=friendAnalysis(s,1,new URLSearchParams('mode=0&map=4'));
  assert.equal(report.units[0].unit_id,'238'); // Appears in more matches, but is not deployed most often.
  assert.deepEqual(report.unit_highlights.most_used.map(r=>r.unit_id),['239']);
  assert.equal(report.unit_highlights.most_used[0].instances,6);
  assert.equal(report.unit_highlights.most_used[0].matches,1);
  assert.deepEqual(report.unit_highlights.most_damage.map(r=>r.unit_id),['240','242']);
  assert.equal(report.unit_highlights.most_damage[0].damage,200);
  assert.deepEqual(report.unit_highlights.most_kills.map(r=>r.unit_id),['241','242']);
  assert.equal(report.unit_highlights.most_kills[0].kills,20);
  assert.equal(friendAnalysis(s,1,new URLSearchParams('mode=0&map=9')).unit_highlights.most_damage[0].unit_id,'999');
  assert.deepEqual(friendAnalysis(s,4).unit_highlights,{most_used:[],most_damage:[],most_kills:[]});
});

test('units without recorded damage or kills do not become damage or kill leaders',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  const raw=rawMatch([101,102,103],{Type:0});s.ingest('800',raw);const d=detailFor(raw);d.data.Data['101'].UnitData={a:{Id:238}};s.saveDetail('800',d);
  const h=friendAnalysis(s,1).unit_highlights;
  assert.equal(h.most_used[0].instances,1);assert.deepEqual(h.most_damage,[]);assert.deepEqual(h.most_kills,[]);
});

test('name variants split renamed loadouts, merge same-name options and alts, and count each friend-match once',t=>{
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'Base tank'}),'now');
  const icons=compileIconVariants({Units:[{Id:238,HUDName:'Base tank'}],Modifications:[{Id:1,UnitId:238}],Options:[{Id:11,ModificationId:1,ReplaceUnitName:'Variant A'},{Id:12,ModificationId:1,ReplaceUnitName:'Variant B'},{Id:13,ModificationId:1,ReplaceUnitName:'Variant A'},{Id:14,ModificationId:1}]});
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_icon_variants',JSON.stringify(icons),'now');
  const unit=id=>({Id:238,OptionIds:[id],KilledCount:2,TotalDamageDealt:10});
  for(const [id,first,alt]of [['800',{a:unit(11),b:unit(13),c:unit(12),d:unit(14)},{a:unit(11)}],['801',{a:unit(12)},{}]]){
    const raw=rawMatch([101,102,103,104],{Type:0,MapId:id==='800'?4:9});s.ingest(id,raw);const d=detailFor(raw);
    for(const p of Object.values(d.data.Data))p.UnitData={};d.data.Data['101'].UnitData=first;d.data.Data['104'].UnitData=alt;s.saveDetail(id,d);
  }
  const u=friendAnalysis(s,1).units[0];assert.equal(u.matches,2);assert.equal(u.instances,6);assert.equal(u.damage,60);assert.equal(u.variants.length,3);
  const a=u.variants.find(v=>v.display_name==='Variant A'),b=u.variants.find(v=>v.display_name==='Variant B');
  assert.equal(a.matches,1);assert.equal(a.instances,3);assert.equal(a.kills,6);assert.equal(a.usage_rate,0.5);
  assert.equal(b.matches,2);assert.equal(b.instances,2);assert.equal(b.usage_rate,1);
  assert.equal(u.variants.reduce((n,v)=>n+v.instances,0),u.instances);assert.equal(u.variants.reduce((n,v)=>n+v.damage,0),u.damage);
  assert.equal(friendAnalysis(s,1,new URLSearchParams('map=9')).units[0].variants.length,1);
});

test('manual deck corrections update rankings, survive later match refreshes, and can be removed',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);seed(s);game(s,'800');
  s.run("INSERT INTO match_decks(match_id,player_id,spec1,spec2,updated_at) VALUES('800','101',3,5,'now')");
  let a=friendAnalysis(s,1);assert.equal(a.decks[0].key,'3_5');assert.equal(a.decks[0].confirmed,1);
  game(s,'800');a=friendAnalysis(s,1);assert.equal(a.decks[0].key,'3_5');
  s.run('DELETE FROM match_decks');assert.equal(friendAnalysis(s,1).decks[0].key,'3_4');
});

test('recent results and streaks use match chronology, and an empty friend report is usable',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);member(s,'Empty',[]);seed(s);
  for(let i=0;i<4;i++)game(s,String(800+i),{win:i<2});
  const a=friendAnalysis(s,1);assert.equal(a.trend.best_win_streak,2);assert.equal(a.trend.best_loss_streak,2);assert.equal(a.trend.current_streak,-2);
  assert.equal(a.recent_matches[0].id,'803');
  const e=friendAnalysis(s,4);assert.equal(e.overview.matches,0);assert.equal(e.overview.win_rate,null);assert.equal(e.teammates.best,null);assert.deepEqual(e.units,[]);
  assert.equal(friendAnalysis(s,999),null);
});

test('missing scores and outcomes stay unknown rather than lowering averages as zero',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);seed(s);game(s,'800');
  s.ingest('801',{players:[{id:101},{id:102},{id:103}]});
  const a=friendAnalysis(s,1);assert.equal(a.overview.matches,2);assert.equal(a.overview.decided,1);
  assert.equal(a.overview.avg_destruction,1000);assert.equal(a.overview.destruction_samples,1);
  assert.equal(a.overview.rating_samples,1);assert.equal(a.overview.deck_known,1);
});
