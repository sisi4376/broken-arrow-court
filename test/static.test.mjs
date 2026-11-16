import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testStore, member, rawMatch, detailFor, airUnit, selfDestructionPrices } from './helpers.mjs';
import { exportStatic, siteInventory, withSiteLock, STATIC_SOURCES } from '../src/static-export.mjs';
import { Publication, pushStatic } from '../src/publication.mjs';
import { dashboard, listMatches, unitStats, supplyAnalysis } from '../src/queries.mjs';
import { overallAnalysis, friendAnalysis } from '../src/analysis.mjs';
import { zhanfanAnalysis } from '../src/zhanfan.mjs';
import { compileAirUnit,AIR_MODEL_VERSION } from '../src/air-superiority.mjs';
import {compileIconVariants} from '../src/unit-icons.mjs';

const require = createRequire(import.meta.url);
const initSql = require('../vendor/sqljs/sql-wasm.js');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const s = testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  for(let i=0;i<3;i++) {const raw=rawMatch(undefined,{Type:i,MapId:[4,12,22][i]});s.ingest(String(800+i),raw);if(i!==1){const detail=detailFor(raw);detail.data.Data['101'].SupplyPointsConsumed=1300+i;detail.data.Data['101'].SupplyPointsConsumedByAllies=700+i;detail.data.Data['101'].SupplyPointsConsumedFromAllies=200+i;detail.data.Data['104'].SupplyPointsConsumedFromAllies=100;detail.data.Data['101'].Destruction=17;detail.data.Data['101'].Losses=12;detail.data.Data['101'].RawExp=900;s.saveDetail(String(800+i),detail);}}
  s.ingest('9999999',rawMatch([101,201,202]));
  return s;
}
async function openReader(directory, options = {}) {
  const inventory=await siteInventory(directory);const moduleFile=inventory.files.find(f=>f.endsWith('/reader.mjs'));
  const{createReader}=await import(pathToFileURL(path.join(directory,moduleFile)).href);
  return createReader(new URL('https://public.example/court/'),{
    sqlite:()=>initSql({locateFile:file=>path.resolve('vendor/sqljs',file)}),
    fetcher:async url=>new Response(await readFile(path.join(directory,new URL(url).pathname.slice('/court/'.length)))),
    ...options,
  });
}

function memoryCache() {
  const caches = new Map();
  return {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name);
      return { async match(key) { return entries.get(key)?.clone(); }, async put(key, response) { entries.set(key, response.clone()); } };
    },
    async keys() { return [...caches.keys()]; }, async delete(name) { return caches.delete(name); },
  };
}

test('common public pages and direct match links never initialize or download SQLite', async t => {
  const s=fixture(t),dir=path.join(s.directory,'fast-site');await exportStatic(s,{directory:dir});
  const requests=[];
  const reader=await openReader(dir,{sqlite:()=>{throw new Error('Unexpected SQLite initialization');},fetcher:async url=>{
    requests.push(new URL(url).pathname);return new Response(await readFile(path.join(dir,new URL(url).pathname.slice('/court/'.length))));
  }});
  for(const route of ['/api/session','/api/members','/api/maps','/api/dashboard?days=0&mode=0','/api/matches?page=1&mode=0',
    '/api/analytics/supply?mode=0&supply_min_games=5','/api/analytics/zhanfan?court_min_games=5&mode=0',
    '/api/analytics/overview?min_games=5&mode=0','/api/members/2/analysis?member=2&mode=0&match_scope=court&match_page=1',
    '/api/members/2/analysis?mode=0&match_scope=other','/api/matches/800']) await reader.request(route);
  assert(!requests.some(p=>p.includes('sqlite')||p.includes('wasm')));
  assert(!(await readFile(path.join(dir,'index.html'),'utf8')).includes('sql-wasm.js'));
});

test('version caches survive a reader reload, remain optional and refresh without stale results', async t => {
  const s=fixture(t),dir=path.join(s.directory,'cache-site');await exportStatic(s,{directory:dir});
  const cacheStorage=memoryCache(),requests=[];
  const options={cacheStorage,fetcher:async url=>{requests.push(new URL(url).pathname);return new Response(await readFile(path.join(dir,new URL(url).pathname.slice('/court/'.length))));}};
  const first=await openReader(dir,options);await first.request('/api/dashboard?mode=0');
  const second=await openReader(dir,options),before=requests.length;
  await second.request('/api/dashboard?days=0&mode=0');
  assert.deepEqual(requests.slice(before),['/court/manifest.json']);
  const fallback='/api/dashboard?map=4';await second.request(fallback);
  const third=await openReader(dir,options),prior=requests.filter(p=>p.endsWith('.sqlite.gz')).length;await third.request(fallback);
  assert.equal(requests.filter(p=>p.endsWith('.sqlite.gz')).length,prior);
  s.run("UPDATE members SET name='Fresh name' WHERE id=1");await exportStatic(s,{directory:dir});
  assert.equal(await second.hasUpdate(),true);await second.refresh();assert.equal((await second.request('/api/members')).members[0].name,'Fresh name');
  const unavailable=await openReader(dir,{cacheStorage:{open(){throw new Error('quota');},keys(){throw new Error('disabled');}}});
  assert.equal((await unavailable.request('/api/dashboard?mode=0')).overview.matches,1);
  const changed=await second.request('/api/dashboard?mode=0');assert.equal(changed.members[0].name,'Fresh name');
  changed.members[0].name='Mutated';assert.equal((await second.request('/api/dashboard?mode=0')).members[0].name,'Fresh name');
});

test('court mode alone triggers publication and read-only readers follow the server setting',async t=>{
  const s=fixture(t),dir=path.join(s.directory,'court-mode-site');
  const pub=new Publication(s,{directory:dir});await pub.run();
  const reader=await openReader(dir);
  assert.equal((await reader.request('/api/session')).ui.court_mode,false);
  s.setting('court_mode',true);
  assert.equal((await pub.run()).changed,true);
  assert.equal(await reader.hasUpdate(),true);
  await reader.refresh();
  assert.equal((await reader.request('/api/session')).ui.court_mode,true);
  assert.equal((await reader.request('/api/sync/status')).settings.court_mode,true);
  const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json')));
  assert.deepEqual(manifest.ui,{court_mode:true});
  assert(!('settings' in manifest));
  assert.equal((await pub.run()).changed,false);
  s.setting('court_mode',false);assert.equal((await pub.run()).changed,true);
  await reader.refresh();assert.equal((await reader.request('/api/session')).ui.court_mode,false);
});

test('public snapshot includes registered personal games but excludes unrelated games, credentials and private fields',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');
  s.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'private-login-name','SECRET_PASSWORD_HASH','admin','2026-01-01');
  s.ingest('8888888',rawMatch([201,202,203]));
  const row=s.get("SELECT raw_json FROM matches WHERE id='800'");const raw=JSON.parse(row.raw_json);raw.private_token='SECRET_RAW_TOKEN';raw.Data['101'].password_hash='SECRET_PLAYER_TOKEN';s.ingest('800',raw);
  const a=await exportStatic(s,{directory:dir});const b=await exportStatic(s,{directory:dir});assert.equal(a.changed,true);assert.equal(b.changed,false);assert.equal(a.revision,b.revision);
  const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json')));assert.equal(manifest.matches,4);assert.equal(manifest.court_matches,3);assert.equal(manifest.personal_matches,1);
  const inventory=await siteInventory(dir);
  assert(inventory.files.includes('edgeone.json'));
  const hosting=JSON.parse(await readFile(path.join(dir,'edgeone.json'),'utf8'));
  assert.equal(hosting.outputDirectory,'.');
  assert(hosting.buildCommand.startsWith('echo '));
  assert(hosting.installCommand.startsWith('echo '));
  for(const route of ['/','/index.html','/manifest.json'])assert.equal(hosting.caches.find(rule=>rule.source===route).cacheTtl,0);
  for(const route of ['/assets/*','/matches/*','/data/*'])assert.equal(hosting.caches.find(rule=>rule.source===route).cacheTtl,31536000);
  assert.equal(hosting.headers.find(rule=>rule.source==='/manifest.json').headers[0].value,'no-store');
  const policy=hosting.headers.find(rule=>rule.source==='/*').headers.find(header=>header.key==='Content-Security-Policy').value;
  assert(policy.includes("'wasm-unsafe-eval'"));
  assert((await readFile(path.join(dir,'_headers'),'utf8')).includes('  Content-Security-Policy: '+policy+'\n'));
  for(const file of inventory.files.filter(f=>f.endsWith('.json'))){const text=await readFile(path.join(dir,file),'utf8');for(const secret of ['SECRET_PASSWORD_HASH','SECRET_RAW_TOKEN','SECRET_PLAYER_TOKEN','private-login-name','csrf','shutdown_token'])assert(!text.includes(secret),file+' leaked '+secret);}
  const dbFile=path.join(s.directory,'public-check.sqlite');await writeFile(dbFile,gunzipSync(await readFile(path.join(dir,manifest.database))));
  const db=new DatabaseSync(dbFile,{readOnly:true});
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('users','sessions','settings','invitations','profiles','sync_events')").all(),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM matches WHERE id='9999999'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM matches WHERE id='8888888'").get().n,0);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
  assert(!inventory.files.some(f=>f.startsWith('data/backups/')));await assert.rejects(access(path.join(dir,'.git')));
  const reader=await openReader(dir);
  assert.equal((await reader.request('/api/matches')).total,3);
  assert.equal((await reader.request('/api/matches?team=all')).total,4);
  assert.equal((await reader.request('/api/dashboard?team=all')).overview.matches,4);
});

test('browser SQLite reuses server queries with identical filters, averages, combinations and unit aggregates',async t=>{
  assert(!Object.hasOwn(STATIC_SOURCES,'court-review.mjs'));
  const s=fixture(t);const dir=path.join(s.directory,'public-site');
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'Heavy SAM fixture',role:15}),'now');
  await exportStatic(s,{directory:dir});const reader=await openReader(dir);
  const heavy=(await reader.request('/api/analytics/supply?supply_min_games=1')).charges.find(c=>c.id==='heavy_aa_kills');
  assert.equal(heavy.rows[0].heavy_aa_kills,12);assert.equal(heavy.rows[0].avg_heavy_aa_kills,6);assert.equal(heavy.rows[0].heavy_aa_units[0].name,'Heavy SAM fixture');
  for(const query of ['', 'combo_min_games=1','combo_min_games=3','supply_min_games=1','supply_min_games=3','mode=0','mode=1','mode=2','team=same','team=all','team=all&mode=1','team=all&member=1','member=1','map=22','q=800','from=2026-10-01&to=2026-10-31']){
    const params=new URLSearchParams(query);
    const actual=await reader.request('/api/dashboard?'+query);const expected=dashboard(s,params);expected.overview.candidates=4;
    assert.deepEqual(plain(actual),plain(expected),query);
    const a=await reader.request('/api/matches?'+query);const e=listMatches(s,params);for(const row of e.items)row.updated_at=null;
    assert.deepEqual(plain(a),plain(e),query);
    assert.deepEqual(plain((await reader.request('/api/analytics/units?'+query)).units),plain(unitStats(s,params)),query);
    assert.deepEqual(plain(await reader.request('/api/analytics/supply?'+query)),plain(supplyAnalysis(s,params)),query);
    assert.deepEqual(plain(await reader.request('/api/analytics/zhanfan?'+query)),plain(zhanfanAnalysis(s,params)),query);
    await assert.rejects(reader.request('/api/analytics/zhanfan?court_compare=1&'+query),/仅在本地后台/);
    await assert.rejects(reader.request('/api/analytics/zhanfan?court_cases=1&'+query),/仅在本地后台/);
  }
  assert.equal((await reader.request('/api/matches/800')).units.length,4);
  await assert.rejects(reader.request('/api/settings',{method:'PATCH'}),/不提供写入/);
  assert.equal((await reader.request('/api/matches/9999999')).friend_count,1);
});

test('live map ID corrections agree across static filters, dashboard, lists and lazy match details',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'mapped-site');
  const cases=[['825',25,'Kadaga Military Base'],['827',27,'Daugavpils'],['828',28,'Coal Mountain']];
  for(const[id,map]of cases)s.ingest(id,rawMatch(undefined,{MapId:map}));
  await exportStatic(s,{directory:dir});const reader=await openReader(dir);
  const maps=(await reader.request('/api/maps')).maps;
  for(const[id,map,name]of cases){
    assert.equal(maps.find(m=>m.map_id===String(map)).name,name);
    assert.equal((await reader.request('/api/dashboard?map='+map)).maps[0].name,name);
    assert.equal((await reader.request('/api/matches?map='+map)).items[0].map_name,name);
    const detail=await reader.request('/api/matches/'+id);assert.equal(detail.map_name,name);assert.equal(detail.raw.MapId,map);
  }
});

test('self-destruction survives public projection and browser SQLite death counts match the local archive',async t=>{
  const s=fixture(t),dir=path.join(s.directory,'self-destruction-site');
  selfDestructionPrices(s);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'Fixture armored unit'}),'now');
  const d=JSON.parse(s.get("SELECT detail_json FROM matches WHERE id='800'").detail_json);
  const rows=[{DeathTime:100},{SelfDestruction:true},{SelfDestruction:true,DeathTime:101},{WasRefunded:true},
    {TotalSelfDamageDealt:1000},{SelfDestruction:'true'},{DeathTime:0},{WasRefunded:true,SelfDestruction:true,DeathTime:102}];
  d.data.Data['101'].UnitData=Object.fromEntries(rows.map((u,i)=>[String(500+i),{Id:238,OptionIds:[560,1634],SpawnTime:90,...u}]));
  // The alternate account must not enter this person's test sample.
  d.data.Data['104'].UnitData={};s.saveDetail('800',d);
  const params=new URLSearchParams('q=800&unit_member=1');const local=unitStats(s,params);
  assert.equal(local[0].deaths,3);assert.equal(local[0].refunded,2);assert.equal(local[0].instances,8);
  await exportStatic(s,{directory:dir});const reader=await openReader(dir);
  const match=await reader.request('/api/matches/800');
  assert.equal(match.units.find(u=>u.net_id==='501').raw.SelfDestruction,true);
  assert.equal(match.units.find(u=>u.net_id==='501').death_time,null);
  assert.equal(match.participants.find(p=>p.player_id==='101').raw.UnitData['501'].SelfDestruction,true);
  assert.deepEqual(plain((await reader.request('/api/analytics/units?'+params)).units),plain(local));
  const query='q=800&supply_min_games=1';
  const publicBoard=await reader.request('/api/analytics/supply?'+query),privateBoard=supplyAnalysis(s,new URLSearchParams(query));
  assert.deepEqual(plain(publicBoard),plain(privateBoard));
  assert(!publicBoard.charges.find(c=>c.id==='self_destruction').rows.some(r=>r.member_id===1));
  const good=JSON.parse(s.get("SELECT detail_json FROM matches WHERE id='802'").detail_json);
  good.data.Data['101'].Losses=1;
  Object.values(good.data.Data['101'].UnitData)[0].SelfDestruction=true;
  Object.values(good.data.Data['104'].UnitData)[0].SelfDestruction=true;s.saveDetail('802',good);
  await exportStatic(s,{directory:dir});await reader.refresh();
  const nextQuery='q=802&supply_min_games=1',next=await reader.request('/api/analytics/supply?'+nextQuery);
  assert.deepEqual(plain(next),plain(supplyAnalysis(s,new URLSearchParams(nextQuery))));
  const own=next.charges.find(c=>c.id==='self_destruction').rows.find(r=>r.member_id===1);
  assert.equal(own.self_destructions,2);assert.equal(own.sample_count,1);assert.equal(own.avg_self_destructions,2);
  assert.equal(own.avg_self_destruction_score,220);assert.equal(own.self_destruction_cases[0].units.length,2);
  assert.equal(own.self_destruction_cases[0].units[0].score,110);
  const marker=Object.values(good.data.Data['101'].UnitData)[0];
  delete marker.SelfDestruction;delete marker.DeathTime;marker.TotalSelfDamageDealt=-1;good.data.Data['101'].Losses=0;
  s.saveDetail('802',good);await exportStatic(s,{directory:dir});await reader.refresh();
  const compatible=await reader.request('/api/analytics/supply?'+nextQuery);
  assert.deepEqual(plain(compatible),plain(supplyAnalysis(s,new URLSearchParams(nextQuery))));
  assert.equal(compatible.members.find(r=>r.member_id===1).self_destruction_compatible,1);
  assert.equal((await reader.request('/api/matches/802')).units.find(u=>u.player_id==='101').raw.TotalSelfDamageDealt,-1);
  assert.deepEqual(plain(await reader.request('/api/analytics/supply?mode=0')),plain(supplyAnalysis(s,new URLSearchParams('mode=0'))));
  marker.OptionIds=[999];s.saveDetail('802',good);await exportStatic(s,{directory:dir});await reader.refresh();
  const unknownPrice=await reader.request('/api/analytics/supply?'+nextQuery),unpriced=unknownPrice.members.find(r=>r.member_id===1);
  assert.deepEqual(plain(unknownPrice),plain(supplyAnalysis(s,new URLSearchParams(nextQuery))));
  assert.equal(unpriced.avg_self_destruction_score,null);assert.equal(unpriced.self_destruction_score_samples,0);
  assert.equal(unpriced.self_destruction_cases[0].units.length,2);assert.equal(unpriced.self_destruction_score,110);
});

test('public air leaderboard retains actual options and safe catalogue fields with identical server results',async t=>{
  const s=fixture(t),dir=path.join(s.directory,'air-site');
  for(const[id,role]of [[238,10],[900,164]])s.run('INSERT INTO unit_catalogue VALUES(?,?,?)',String(id),JSON.stringify({id,role}),'now');
  const model={version:AIR_MODEL_VERSION,updated_at:'2026-10-17T00:00:00Z',db_file:'fixture.db',private_token:'SECRET_AIR_MODEL',units:{900:compileAirUnit(airUnit())}};
  model.units[900].private_token='SECRET_AIR_UNIT';model.units[900].modifications[0].options[0].private_token='SECRET_AIR_OPTION';
  model.catalogues=[{...structuredClone(model),version_name:'old',valid_until:1792494000},{...structuredClone(model),version_name:'1.2.1',db_file:'next.db',valid_from:1792494000}];
  s.run("INSERT INTO analysis_catalogue VALUES('air_superiority_model',?,'now')",JSON.stringify(model));
  for(const id of ['800','802']){
    const d=JSON.parse(s.get('SELECT detail_json FROM matches WHERE id=?',id).detail_json);
    d.data.Data['101'].UnitData.air={Id:900,OptionIds:id==='800'?[100,200]:[200,100],KilledCount:id==='800'?5:2,private_token:'SECRET_AIR_INSTANCE'};
    d.data.Data['101'].UnitData.ground={Id:900,OptionIds:[100,201],KilledCount:99};
    d.data.Data['102'].UnitData.unknown={Id:900,OptionIds:[100,'bad'],KilledCount:88};
    s.saveDetail(id,d);
  }
  const pub=new Publication(s,{directory:dir});await pub.run();const reader=await openReader(dir);
  for(const query of ['supply_min_games=1','mode=0&supply_min_games=1','mode=2&supply_min_games=1','member=1&supply_min_games=2','q=801','from=2026-10-01&map=22'])assert.deepEqual(plain(await reader.request('/api/analytics/supply?'+query)),plain(supplyAnalysis(s,new URLSearchParams(query))),query);
  const a=(await reader.request('/api/analytics/supply?supply_min_games=1')).charges.find(c=>c.id==='air_superiority').rows.find(r=>r.member_id===1);
  assert.equal(a.air_superiority_kills,7);assert.equal(a.avg_air_superiority_kills,3.5);assert.equal(a.air_superiority_units.length,1);
  const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'))),bytes=gunzipSync(await readFile(path.join(dir,manifest.database)));
  for(const secret of ['SECRET_AIR_MODEL','SECRET_AIR_UNIT','SECRET_AIR_OPTION','SECRET_AIR_INSTANCE'])assert(!bytes.includes(Buffer.from(secret)));
  model.updated_at='2026-10-18T00:00:00Z';
  s.run("UPDATE analysis_catalogue SET data_json=?,updated_at='later' WHERE key='air_superiority_model'",JSON.stringify(model));
  assert.equal((await pub.run()).changed,true);assert.equal(await reader.hasUpdate(),true);
});

test('read-only exports preserve friend reports, confirmed decks and all analysis filters without exporting editor identities',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'reports-site');
  s.run("INSERT INTO analysis_catalogue VALUES('unit_display_catalogue',?,'now')",JSON.stringify({version_name:'1.2.1',units:{238:{id:238,hudName:'Current unit name',role:15,private_token:'SECRET_DISPLAY'}}}));
  s.run("INSERT INTO analysis_catalogue VALUES('unit_icon_variants',?,'now')",JSON.stringify(compileIconVariants({Units:[{Id:238,HUDName:'Current unit name'}],Modifications:[{Id:1,UnitId:238},{Id:2,UnitId:238}],Options:[{Id:560,ModificationId:1,ReplaceUnitName:'Renamed variant'},{Id:1634,ModificationId:2}]})));
  s.run("INSERT INTO analysis_catalogue VALUES('deck_model',?,'now')",JSON.stringify({specializations:[{id:3,name:'Marines',countryId:2},{id:4,name:'Armor',countryId:2}],units:{238:{country_id:2,spec_ids:[3]}}}));
  s.run("INSERT INTO match_decks(match_id,player_id,spec1,spec2,updated_at) VALUES('800','101',3,4,'now')");
  await exportStatic(s,{directory:dir});const reader=await openReader(dir);
  for(const query of ['','mode=0','map=12','member=2','min_games=1','mode=0&team=same']){
    const params=new URLSearchParams(query);
    assert.deepEqual(plain(await reader.request('/api/analytics/overview?'+query)),plain(overallAnalysis(s,params)),query);
    assert.deepEqual(plain(await reader.request('/api/members/2/analysis?'+query)),plain(friendAnalysis(s,2,params)),query);
  }
  assert.equal((await reader.request('/api/matches/800')).participants.find(p=>p.player_id==='101').deck.source,'confirmed');
  assert.equal((await reader.request('/api/members/2/analysis')).units[0].catalogue.hudName,'Current unit name');
  assert.equal((await reader.request('/api/members/2/analysis')).units[0].variants[0].display_name,'Renamed variant');
  assert(!JSON.stringify(await reader.request('/api/analytics/overview')).includes('SECRET_DISPLAY'));
  await assert.rejects(reader.request('/api/matches/800/players/101/deck',{method:'PUT'}),/不提供写入/);
});

test('changing public data changes the revision, preserves prior assets, and enables readers to detect updates',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');await exportStatic(s,{directory:dir});const reader=await openReader(dir);await reader.request('/api/session');
  assert.equal(await reader.hasUpdate(),false);s.run("UPDATE members SET name='Renamed friend' WHERE id=1");
  const next=await exportStatic(s,{directory:dir});assert.equal(next.changed,true);assert.equal(await reader.hasUpdate(),true);
  await reader.refresh();assert.equal((await reader.request('/api/members')).members[0].name,'Renamed friend');assert.equal(await reader.hasUpdate(),false);
  const marker=(await siteInventory(dir)).marker;assert.equal(marker.generations.length,2);
  for(const file of marker.generations[1].files)await access(path.join(dir,file));
});

test('export refuses unrelated output folders and publisher stays offline without a configured remote',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');await mkdir(dir);await writeFile(path.join(dir,'unrelated.txt'),'KEEP');
  await assert.rejects(exportStatic(s,{directory:dir}),/非空/);assert.equal(await readFile(path.join(dir,'unrelated.txt'),'utf8'),'KEEP');
  const pub=new Publication(s,{directory:path.join(s.directory,'safe-site')});const a=await pub.run();const b=await pub.run();assert.equal(a.changed,true);assert.equal(b.changed,false);
  assert(!(await readdir(path.join(s.directory,'safe-site'))).includes('.git'));
  await assert.rejects(pushStatic(path.join(s.directory,'safe-site'),{remote:'https://token:secret@github.com/owner/repo.git'}),/不能包含凭据/);
});

test('Git publication stages only the independent generated site and never force pushes',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');await exportStatic(s,{directory:dir});const calls=[];
  const gitRunner=async(cwd,args)=>{calls.push({cwd,args});if(args[0]==='rev-parse')return{code:0,output:path.resolve('.')};if(args[0]==='remote'&&args[1]==='get-url')return{code:2,output:''};if(args.includes('--quiet'))return{code:1,output:''};return{code:0,output:''};};
  await pushStatic(dir,{remote:'https://github.com/owner/court-public.git',gitRunner});
  assert(calls.some(c=>c.args[0]==='init'));assert(calls.every(c=>c.cwd===dir));assert(!calls.some(c=>c.args.includes('--force')));
  const additions=calls.filter(c=>c.args[0]==='add').flatMap(c=>c.args.slice(c.args.indexOf('--')+1));
  assert(additions.includes('manifest.json'));assert(!additions.some(f=>f.includes('court.sqlite')||f.includes('.env')||f==='.'||f.includes('.court-static-site')));
});

test('concurrent export and Git operations cannot replace a snapshot while another operation holds the lock',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');await exportStatic(s,{directory:dir});
  await withSiteLock(dir,async()=>{await assert.rejects(exportStatic(s,{directory:dir}),/正在运行/);});
  await assert.rejects(access(path.join(dir,'.court-operation.lock')));
  assert.equal((await exportStatic(s,{directory:dir})).changed,false);
});

test('automatic export notices confirmed deck corrections even when match timestamps do not change',async t=>{
  const s=fixture(t);const pub=new Publication(s,{directory:path.join(s.directory,'public-site')});await pub.run();
  assert.equal((await pub.run()).changed,false);
  s.run('INSERT INTO match_decks(match_id,player_id,spec1,spec2,updated_at) VALUES(?,?,?,?,?)','800','101',1,2,new Date().toISOString());
  assert.equal((await pub.run()).changed,true);assert.equal((await pub.run()).changed,false);
});

test('deployment failure survives restart and manual retry verifies the same revision without another push',async t=>{
  const s=fixture(t);let pushes=0,checks=0,fail=true;
  const options={directory:path.join(s.directory,'public-site'),remote:'https://github.com/owner/public.git',
    push:async directory=>{pushes++;return {revision:(await siteInventory(directory)).marker.revision,commit:'a'.repeat(40)};},
    verifyDeployment:async()=>{checks++;if(fail)throw Error('Pages 构建失败');return {status:'complete',commit:'a'.repeat(40)};}};
  let pub=new Publication(s,options);await pub.tick();assert.equal((await pub.status()).status,'failed');assert.equal(pushes,1);
  pub=new Publication(s,options);assert.equal((await pub.status()).status,'failed');
  await pub.tick();assert.equal(checks,1);assert.equal((await pub.status()).status,'failed');
  fail=false;await pub.tick({forcePush:true});assert.equal(checks,2);assert.equal(pushes,1);assert.equal((await pub.status()).status,'complete');
  const state=JSON.parse(await readFile(pub.stateFile,'utf8'));assert.equal(state.deployed_revision,state.pushed_revision);assert.equal(state.last_error,null);
});

test('manual publication can bypass retry backoff without changing scheduled publication',async t=>{
  const s=fixture(t);const pub=new Publication(s,{directory:path.join(s.directory,'public-site')});await pub.run();
  const state=JSON.parse(await readFile(pub.stateFile,'utf8'));
  await writeFile(pub.stateFile,JSON.stringify({...state,last_push:new Date().toISOString(),next_retry:new Date(Date.now()+900000).toISOString()}));
  pub.remote='https://token:secret@github.com/owner/repo.git';
  assert.equal((await pub.run()).changed,false);
  await assert.rejects(pub.run({forcePush:true}),/不能包含凭据/);
});

test('manual website requests wait for sync, bypass auto-disable, deduplicate and expose completion or failures',async t=>{
  const s=fixture(t);let syncing=true,calls=0,release;
  const pub=new Publication(s,{directory:path.join(s.directory,'public-site'),enabled:false,remote:'https://github.com/owner/public.git',isSyncActive:()=>syncing});
  pub.run=async options=>{assert.equal(options.forcePush,true);calls++;await new Promise(resolve=>{release=resolve;});};
  await pub.tick({forcePush:true});await pub.tick({forcePush:true});assert.equal(calls,0);assert.equal((await pub.status()).queued,true);
  syncing=false;const task=pub.tick();await pub.tick({forcePush:true});assert.equal(calls,1);
  assert.equal((await pub.status()).active,true);release();await task;assert.equal(calls,1);
  assert.equal((await pub.status()).status,'complete');assert.equal((await pub.status()).queued,false);
  pub.run=async()=>{throw Error('Publication failed');};await pub.tick({forcePush:true});
  const status=await pub.status();assert.equal(status.status,'failed');assert.equal(status.last_error,'Publication failed');
  await pub.stop();await pub.tick({forcePush:true});assert.equal((await pub.status()).active,false);
});

test('a manual request during an automatic check queues one forced follow-up',async t=>{
  const s=fixture(t),pub=new Publication(s,{directory:path.join(s.directory,'public-site')});const calls=[];let release;
  pub.run=async options=>{calls.push(options.forcePush);if(calls.length===1)await new Promise(resolve=>{release=resolve;});};
  const automatic=pub.tick();await pub.tick({forcePush:true});await pub.tick({forcePush:true});assert.equal((await pub.status()).queued,true);
  release();await automatic;await pub.active;assert.deepEqual(calls,[false,true]);
  assert.equal((await pub.status()).status,'complete');
});

test('backend data publishes immediately across restarts while source-only changes keep the interval',async t=>{
  const s=fixture(t);let pushes=0;
  const options={directory:path.join(s.directory,'public-site'),remote:'https://github.com/owner/court-public.git',
    verifyDeployment:async()=>({status:'complete'}),push:async directory=>{pushes++;return{revision:(await siteInventory(directory)).marker.revision};}};
  let pub=new Publication(s,options);await pub.run();assert.equal(pushes,1);
  const finish=()=>Number(s.run("INSERT INTO sync_runs(kind,status,started_at,finished_at) VALUES('incremental','complete',?,?)",new Date().toISOString(),new Date().toISOString()).lastInsertRowid);
  s.run("UPDATE members SET name='Manual rename' WHERE id=1");await pub.run();assert.equal(pushes,2);
  const syncId=finish();await pub.run();assert.equal(pushes,2);
  assert.equal(JSON.parse(await readFile(pub.stateFile,'utf8')).published_sync_id,syncId);
  const unchangedId=finish();await pub.run();assert.equal(pushes,2);
  assert.equal(JSON.parse(await readFile(pub.stateFile,'utf8')).published_sync_id,unchangedId);
  pub=new Publication(s,options);
  s.run("UPDATE members SET name='Another manual rename' WHERE id=1");await pub.run();assert.equal(pushes,3);
  const sourceOnly=JSON.parse(await readFile(pub.stateFile,'utf8'));
  await writeFile(pub.stateFile,JSON.stringify({...sourceOnly,pushed_revision:'0'.repeat(64)}));
  await pub.run();assert.equal(pushes,3);
  s.run("INSERT INTO sync_runs(kind,status,started_at) VALUES('incremental','running',?)",new Date().toISOString());
  await pub.run();assert.equal(pushes,3);
  s.run("UPDATE sync_runs SET status='partial',finished_at=? WHERE status='running'",new Date().toISOString());
  await pub.run();assert.equal(pushes,4);
});

test('data notifications coalesce during publication and wait for an active sync without forcing retries',async t=>{
  const s=fixture(t);let syncing=true,release;
  const pub=new Publication(s,{directory:path.join(s.directory,'public-site'),isSyncActive:()=>syncing});const calls=[];
  pub.run=async options=>{calls.push(options);if(calls.length===1)await new Promise(resolve=>{release=resolve;});};
  await pub.tick({dataChanged:true});assert.equal(calls.length,0);assert.equal((await pub.status()).queued,true);
  syncing=false;const first=pub.tick();
  await pub.tick({dataChanged:true});await pub.tick({dataChanged:true});
  release();await first;await pub.active;
  assert.deepEqual(calls,[{forcePush:false},{forcePush:false}]);assert.equal((await pub.status()).queued,false);
  await pub.stop();
});

test('data-only changes retain retry eligibility across restart without a completed sync',async t=>{
  const s=fixture(t);let pushes=0,fail=false;
  const options={directory:path.join(s.directory,'public-site'),remote:'https://github.com/owner/court-public.git',verifyDeployment:async()=>({status:'complete'}),push:async directory=>{pushes++;if(fail)throw Error('Offline');return{revision:(await siteInventory(directory)).marker.revision};}};
  let pub=new Publication(s,options);await pub.run();
  s.ingest('850',rawMatch());fail=true;await assert.rejects(pub.run(),/Offline/);assert.equal(pushes,2);
  let state=JSON.parse(await readFile(pub.stateFile,'utf8'));assert.notEqual(state.data_fingerprint,state.pushed_data_fingerprint);
  pub=new Publication(s,options);fail=false;await pub.run();assert.equal(pushes,2);
  await writeFile(pub.stateFile,JSON.stringify({...state,next_retry:new Date(Date.now()-1000).toISOString()}));
  await pub.run();assert.equal(pushes,3);
  state=JSON.parse(await readFile(pub.stateFile,'utf8'));assert.equal(state.data_fingerprint,state.pushed_data_fingerprint);
});

test('new sync data never bypasses failed-push backoff and is retried without another sync',async t=>{
  const s=fixture(t);let pushes=0,fail=false;
  const pub=new Publication(s,{directory:path.join(s.directory,'public-site'),remote:'https://github.com/owner/court-public.git',
    verifyDeployment:async()=>({status:'complete'}),push:async directory=>{pushes++;if(fail)throw Error('Network unavailable');return{revision:(await siteInventory(directory)).marker.revision};}});
  await pub.run();s.run("UPDATE members SET name='New data' WHERE id=1");
  s.run("INSERT INTO sync_runs(kind,status,started_at,finished_at) VALUES('incremental','complete',?,?)",new Date().toISOString(),new Date().toISOString());
  fail=true;await assert.rejects(pub.run(),/Network unavailable/);assert.equal(pushes,2);
  let state=JSON.parse(await readFile(pub.stateFile,'utf8'));assert.equal(state.published_sync_id,0);assert(Date.parse(state.next_retry)>Date.now());
  fail=false;assert.equal((await pub.run()).changed,false);assert.equal(pushes,2);
  state=JSON.parse(await readFile(pub.stateFile,'utf8'));await writeFile(pub.stateFile,JSON.stringify({...state,next_retry:new Date(Date.now()-1000).toISOString()}));
  await pub.run();assert.equal(pushes,3);
  state=JSON.parse(await readFile(pub.stateFile,'utf8'));assert.equal(state.published_sync_id,1);assert.equal(state.next_retry,null);
});

test('automatic publication defers active sync and retains a round finishing during publication for the next check',async t=>{
  const s=fixture(t);let syncing=true,pushes=0;
  const pub=new Publication(s,{directory:path.join(s.directory,'public-site'),remote:'https://github.com/owner/court-public.git',isSyncActive:()=>syncing,
    verifyDeployment:async()=>({status:'complete'}),push:async directory=>{pushes++;if(pushes===1)s.run("INSERT INTO sync_runs(kind,status,started_at,finished_at) VALUES('incremental','complete',?,?)",new Date().toISOString(),new Date().toISOString());return{revision:(await siteInventory(directory)).marker.revision};}});
  assert.deepEqual(await pub.run(),{deferred:true,reason:'sync-active'});await pub.tick();assert.equal(pushes,0);
  await assert.rejects(access(pub.stateFile));
  syncing=false;await pub.tick();assert.equal(pushes,1);
  assert.equal(JSON.parse(await readFile(pub.stateFile,'utf8')).published_sync_id,0);
  s.run("UPDATE members SET name='Completed during export' WHERE id=1");
  await pub.tick();assert.equal(pushes,2);
  assert.equal(JSON.parse(await readFile(pub.stateFile,'utf8')).published_sync_id,1);
  await pub.stop();await pub.tick();assert.equal(pushes,2);
});
