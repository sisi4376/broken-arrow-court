import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { exportStatic, siteInventory, withSiteLock } from '../src/static-export.mjs';
import { Publication, pushStatic } from '../src/publication.mjs';
import { dashboard, listMatches, unitStats, supplyAnalysis } from '../src/queries.mjs';
import { overallAnalysis, friendAnalysis } from '../src/analysis.mjs';

const require = createRequire(import.meta.url);
const initSql = require('../vendor/sqljs/sql-wasm.js');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const s = testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  for(let i=0;i<3;i++) {const raw=rawMatch(undefined,{Type:i,MapId:[4,12,22][i]});s.ingest(String(800+i),raw);if(i!==1){const detail=detailFor(raw);detail.data.Data['101'].SupplyPointsConsumed=1300+i;detail.data.Data['101'].SupplyPointsConsumedByAllies=700+i;detail.data.Data['101'].SupplyPointsConsumedFromAllies=200+i;detail.data.Data['104'].SupplyPointsConsumedFromAllies=100;detail.data.Data['101'].Destruction=17;detail.data.Data['101'].Losses=12;detail.data.Data['101'].RawExp=900;s.saveDetail(String(800+i),detail);}}
  s.ingest('9999999',rawMatch([101,201,202]));
  return s;
}
async function openReader(directory) {
  const inventory=await siteInventory(directory);const moduleFile=inventory.files.find(f=>f.endsWith('/reader.mjs'));
  const{createReader}=await import(pathToFileURL(path.join(directory,moduleFile)).href);
  return createReader(new URL('https://public.example/court/'),{
    sqlite:()=>initSql({locateFile:file=>path.resolve('vendor/sqljs',file)}),
    fetcher:async url=>new Response(await readFile(path.join(directory,new URL(url).pathname.slice('/court/'.length)))),
  });
}

test('public snapshot excludes credentials, private state, solo games and unknown raw fields; unchanged exports do not republish',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');
  s.run('INSERT INTO users(member_id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',1,'private-login-name','SECRET_PASSWORD_HASH','admin','2026-01-01');
  const row=s.get("SELECT raw_json FROM matches WHERE id='800'");const raw=JSON.parse(row.raw_json);raw.private_token='SECRET_RAW_TOKEN';raw.Data['101'].password_hash='SECRET_PLAYER_TOKEN';s.ingest('800',raw);
  const a=await exportStatic(s,{directory:dir});const b=await exportStatic(s,{directory:dir});assert.equal(a.changed,true);assert.equal(b.changed,false);assert.equal(a.revision,b.revision);
  const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json')));assert.equal(manifest.matches,3);
  const inventory=await siteInventory(dir);
  for(const file of inventory.files.filter(f=>f.endsWith('.json'))){const text=await readFile(path.join(dir,file),'utf8');for(const secret of ['SECRET_PASSWORD_HASH','SECRET_RAW_TOKEN','SECRET_PLAYER_TOKEN','private-login-name','csrf','shutdown_token'])assert(!text.includes(secret),file+' leaked '+secret);}
  const dbFile=path.join(s.directory,'public-check.sqlite');await writeFile(dbFile,gunzipSync(await readFile(path.join(dir,manifest.database))));
  const db=new DatabaseSync(dbFile,{readOnly:true});
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('users','sessions','settings','invitations','profiles','sync_events')").all(),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM matches WHERE id='9999999'").get().n,0);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
  assert(!inventory.files.some(f=>f.startsWith('data/backups/')));await assert.rejects(access(path.join(dir,'.git')));
});

test('browser SQLite reuses server queries with identical filters, averages, combinations and unit aggregates',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'public-site');await exportStatic(s,{directory:dir});const reader=await openReader(dir);
  for(const query of ['', 'combo_min_games=1','combo_min_games=3','supply_min_games=1','supply_min_games=3','mode=0','mode=1','mode=2','team=same','member=1','map=22','q=800','from=2026-10-01&to=2026-10-31']){
    const params=new URLSearchParams(query);
    const actual=await reader.request('/api/dashboard?'+query);const expected=dashboard(s,params);expected.overview.candidates=3;
    assert.deepEqual(plain(actual),plain(expected),query);
    const a=await reader.request('/api/matches?'+query);const e=listMatches(s,params);for(const row of e.items)row.updated_at=null;
    assert.deepEqual(plain(a),plain(e),query);
    assert.deepEqual(plain((await reader.request('/api/analytics/units?'+query)).units),plain(unitStats(s,params)),query);
    assert.deepEqual(plain(await reader.request('/api/analytics/supply?'+query)),plain(supplyAnalysis(s,params)),query);
  }
  assert.equal((await reader.request('/api/matches/800')).units.length,4);
  await assert.rejects(reader.request('/api/settings',{method:'PATCH'}),/不提供写入/);
  await assert.rejects(reader.request('/api/matches/9999999'),/不在公开/);
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

test('read-only exports preserve friend reports, confirmed decks and all analysis filters without exporting editor identities',async t=>{
  const s=fixture(t);const dir=path.join(s.directory,'reports-site');
  s.run("INSERT INTO analysis_catalogue VALUES('deck_model',?,'now')",JSON.stringify({specializations:[{id:3,name:'Marines',countryId:2},{id:4,name:'Armor',countryId:2}],units:{238:{country_id:2,spec_ids:[3]}}}));
  s.run("INSERT INTO match_decks(match_id,player_id,spec1,spec2,updated_at) VALUES('800','101',3,4,'now')");
  await exportStatic(s,{directory:dir});const reader=await openReader(dir);
  for(const query of ['','mode=0','map=12','member=2','min_games=1','mode=0&team=same']){
    const params=new URLSearchParams(query);
    assert.deepEqual(plain(await reader.request('/api/analytics/overview?'+query)),plain(overallAnalysis(s,params)),query);
    assert.deepEqual(plain(await reader.request('/api/members/2/analysis?'+query)),plain(friendAnalysis(s,2,params)),query);
  }
  assert.equal((await reader.request('/api/matches/800')).participants.find(p=>p.player_id==='101').deck.source,'confirmed');
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

test('manual publication can bypass retry backoff without changing scheduled publication',async t=>{
  const s=fixture(t);const pub=new Publication(s,{directory:path.join(s.directory,'public-site')});await pub.run();
  const state=JSON.parse(await readFile(pub.stateFile,'utf8'));
  await writeFile(pub.stateFile,JSON.stringify({...state,last_push:new Date().toISOString(),next_retry:new Date(Date.now()+900000).toISOString()}));
  pub.remote='https://token:secret@github.com/owner/repo.git';
  assert.equal((await pub.run()).changed,false);
  await assert.rejects(pub.run({forcePush:true}),/不能包含凭据/);
});
