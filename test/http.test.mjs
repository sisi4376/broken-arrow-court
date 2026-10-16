import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exportStatic } from '../src/static-export.mjs';
import { createApplication } from '../src/server.mjs';
import { tempDir,rawMatch,detailFor } from './helpers.mjs';

async function application(t){
  let app;const directory=tempDir(t,()=>app?.close());app=createApplication({directory,startScheduler:false,staticOutputDirectory:path.join(directory,'public-site'),sourceOptions:{fetcher:async()=>new Response('{}',{status:404})}});
  app.store.setting('sync_enabled',false);
  await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  function client(){let cookie='';let csrf='';return{async request(route,method='GET',body,extraHeaders={}){
    const response=await fetch(base+route,{method,headers:{...body===undefined?{}:{'Content-Type':'application/json'},...cookie?{Cookie:cookie}:{},...csrf?{'X-CSRF-Token':csrf}:{},...extraHeaders},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const data=await response.json();if(route==='/api/session'&&data.user)csrf=data.user.csrf;
    return{status:response.status,data};
  }};}
  return{app,client,base};
}

test('friend analysis is authenticated and deck confirmation enforces ownership and same-country pairs',async t=>{
  const {app,client}=await application(t);const owner=client(),friend=client(),guest=client();
  assert.equal((await guest.request('/api/members/1/analysis')).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'deck-owner',password:'deck-owner-password'});await owner.request('/api/session');
  await owner.request('/api/members','POST',{name:'Friend'});await owner.request('/api/members','POST',{name:'Third'});
  const invite=await owner.request('/api/invitations','POST',{member_id:2});
  await friend.request('/api/register','POST',{name:'Friend',username:'deck-friend',password:'deck-friend-password',invite:invite.data.code});await friend.request('/api/session');
  for(const [member_id,player_id]of [[1,'101'],[2,'102'],[3,'103']])await owner.request('/api/accounts','POST',{member_id,player_id,name:'Account '+player_id});
  app.store.run("INSERT INTO analysis_catalogue VALUES('deck_model',?,'now')",JSON.stringify({specializations:[{id:3,name:'Marines',countryId:2},{id:4,name:'Armor',countryId:2},{id:7,name:'VDV',countryId:1}],units:{}}));
  app.store.ingest('800',rawMatch());app.store.saveDetail('800',detailFor(rawMatch()));
  assert.equal((await friend.request('/api/members/1/analysis')).status,200);
  assert.equal((await friend.request('/api/matches/800/players/101/deck','PUT',{spec1:3,spec2:4})).status,403);
  assert.equal((await friend.request('/api/matches/800/players/102/deck','PUT',{spec1:3,spec2:7})).status,400);
  assert.equal((await friend.request('/api/matches/800/players/102/deck','PUT',{spec1:3,spec2:3})).status,400);
  assert.equal((await friend.request('/api/matches/800/players/102/deck','PUT',{spec1:3,spec2:4})).status,200);
  const detail=await owner.request('/api/matches/800');assert.equal(detail.data.participants.find(p=>p.player_id==='102').deck.source,'confirmed');
  const report=await owner.request('/api/members/2/analysis');assert.equal(report.data.decks[0].key,'3_4');
  assert.equal((await owner.request('/api/matches/800/players/102/deck','DELETE')).status,200);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM match_decks').n,0);
});

test('supply analysis requires authentication, returns per-game supply data and serves the frontend module',async t=>{
  const {app,client,base}=await application(t),guest=client(),owner=client();
  assert.equal((await guest.request('/api/analytics/supply')).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'supply-owner',password:'supply-owner-password'});await owner.request('/api/session');
  for(const name of ['B','C'])await owner.request('/api/members','POST',{name});
  for(const[member_id,player_id]of [[1,'101'],[2,'102'],[3,'103']])await owner.request('/api/accounts','POST',{member_id,player_id});
  const raw=rawMatch();app.store.ingest('800',raw);const d=detailFor(raw);d.data.Data['101'].SupplyPointsConsumedFromAllies=123;d.data.Data['102'].SupplyPointsConsumedByAllies=456;app.store.saveDetail('800',d);
  const result=await owner.request('/api/analytics/supply?supply_min_games=1');
  assert.equal(result.status,200);assert.equal(result.data.hungry[0].avg_received_allies,123);assert.equal(result.data.transport[0].avg_supplied_allies,456);
  assert.equal((await owner.request('/api/analytics/supply')).data.hungry.length,0);
  const asset=await fetch(base+'/performance.js');assert.equal(asset.status,200);assert((await asset.text()).includes('小馋猫榜'));
});

test('registration, invitation claim, ownership, and inactive-member session revocation',async t=>{
  const{app,client}=await application(t);const owner=client();const friend=client();
  assert.equal((await owner.request('/api/dashboard')).status,401);
  assert.equal((await owner.request('/api/register','POST',{name:'院长',username:'owner',password:'a-long-test-password'})).status,201);
  assert.equal((await owner.request('/api/session')).data.user.role,'admin');
  const id=(await owner.request('/api/members','POST',{name:'朋友甲'})).data.id;
  const invitation=(await owner.request('/api/invitations','POST',{member_id:id})).data;
  assert.equal((await friend.request('/api/register','POST',{name:'不应新建的名称',username:'friend',password:'another-long-password',invite:invitation.code})).status,201);
  const me=(await friend.request('/api/session')).data.user;assert.equal(me.member_id,id);assert.equal(me.name,'朋友甲');
  assert.equal((await owner.request('/api/members')).data.members.length,2);
  assert.equal((await friend.request('/api/accounts','POST',{member_id:1,player_id:'101'})).status,403);
  assert.equal((await friend.request('/api/accounts','POST',{player_id:'102',name:'Small account'})).status,201);
  assert.equal((await friend.request('/api/accounts','POST',{player_id:'103',name:'Second account'})).status,201);
  assert.equal((await friend.request('/api/members','POST',{name:'Forbidden'})).status,403);
  assert.equal((await friend.request('/api/settings','PATCH',{sync_minutes:1})).status,403);
  assert.equal((await owner.request('/api/members/'+id,'PATCH',{active:false})).status,200);
  assert.equal((await friend.request('/api/dashboard')).status,401);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts WHERE member_id=?',id).n,2);
});

test('CSRF and origin checks reject unauthorized mutations, one-use invites cannot be reused',async t=>{
  const{client}=await application(t);const owner=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'owner',password:'a-long-test-password'});await owner.request('/api/session');
  assert.equal((await owner.request('/api/members','POST',{name:'X'},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await owner.request('/api/members','POST',{name:'X'},{Origin:'https://unrelated.example'})).status,403);
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  assert.equal((await client().request('/api/register','POST',{name:'A',username:'friend1',password:'a-long-test-password',invite})).status,201);
  assert.equal((await client().request('/api/register','POST',{name:'B',username:'friend2',password:'a-long-test-password',invite})).status,403);
});

test('file import validates first, keeps full match details, and filters candidates from statistics',async t=>{
  const{app,client}=await application(t);const c=client();await c.request('/api/register','POST',{name:'A',username:'owner',password:'a-long-test-password'});await c.request('/api/session');
  for(let i=1;i<=3;i++){
    const id=i===1?1:(await c.request('/api/members','POST',{name:`Friend ${i}`})).data.id;
    await c.request('/api/accounts','POST',{member_id:id,player_id:String(100+i)});
  }
  const raw=rawMatch();
  const bad=await c.request('/api/import','POST',{payload:{matches:[{matchId:'800',data:raw},{matchId:'801',data:{}}]}});assert.equal(bad.status,400);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM matches').n,0);
  const payload={format:'broken-arrow-court-v1',matches:[{id:'800',raw,detail:detailFor(raw)},{id:'801',raw:rawMatch([101,201,202])}]};
  assert.equal((await c.request('/api/import','POST',{payload})).status,200);
  assert.equal((await c.request('/api/dashboard')).data.overview.matches,1);
  assert.equal((await c.request('/api/matches')).data.total,1);assert.equal((await c.request('/api/matches?scope=all')).data.total,2);
  const detail=(await c.request('/api/matches/800')).data;assert.equal(detail.units.length,4);assert.equal(detail.participants[0].raw.DamageDealt,400);
  const archive=(await c.request('/api/export')).data;assert.equal(archive.matches.length,2);assert(!('users' in archive));assert.equal(archive.matches.find(m=>m.id==='800').detail.data.Data['101'].UnitData['10101'].KilledCount,3);
  const richImport=await c.request('/api/import','POST',{payload:{matchId:'802',data:detailFor(raw).data}});
  assert.equal(richImport.status,200);assert.equal(richImport.data.details,1);
  assert.equal((await c.request('/api/matches/802')).data.units.length,4);
});

test('password changes invalidate old sessions and preserve the current login with rotated CSRF',async t=>{
  const{client}=await application(t);const first=client(),second=client();
  await first.request('/api/register','POST',{name:'Owner',username:'owner',password:'a-long-test-password'});await first.request('/api/session');
  await second.request('/api/login','POST',{username:'owner',password:'a-long-test-password'});await second.request('/api/session');
  assert.equal((await first.request('/api/password','POST',{old_password:'a-long-test-password',password:'new-long-password'})).status,200);
  await first.request('/api/session');assert.equal((await first.request('/api/dashboard')).status,200);assert.equal((await second.request('/api/dashboard')).status,401);
});

test('public preview serves only generated read-only assets, without exposing local admin APIs or private files',async t=>{
  const{app,base}=await application(t);await exportStatic(app.store,{directory:app.staticDirectory});
  const page=await fetch(base+'/readonly/');assert.equal(page.status,200);assert((await page.text()).includes('bootstrap.mjs'));
  assert(page.headers.get('content-security-policy').includes('wasm-unsafe-eval'));
  assert.equal((await fetch(base+'/readonly/manifest.json',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/readonly/.git/config')).status,404);
  assert.equal((await fetch(base+'/readonly/.court-static-site.json')).status,404);
  assert.equal((await fetch(base+'/api/members')).status,401);
});

test('map filter options use the same catalog names as match detail and keep unknown IDs selectable',async t=>{
  const{app,client}=await application(t);const owner=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'owner',password:'a-long-test-password'});await owner.request('/api/session');
  app.store.ingest('800',rawMatch(undefined,{MapId:12}));app.store.ingest('801',rawMatch(undefined,{MapId:28}));app.store.ingest('802',rawMatch(undefined,{MapId:999}));
  const maps=(await owner.request('/api/maps')).data.maps;
  assert.equal(maps.find(m=>m.map_id==='12').name,'Oil refinery');assert.equal(maps.find(m=>m.map_id==='28').name,'Coal Mountain');assert.equal(maps.find(m=>m.map_id==='999').name,'未知地图 #999');
  assert.equal((await owner.request('/api/matches/800')).data.map_name,'Oil refinery');
  assert.equal((await owner.request('/api/matches/801')).data.map_name,'Coal Mountain');
});

test('known old match IDs can be imported without a player history listing and failures leave existing data intact',async t=>{
  const{app,client}=await application(t);const owner=client(),friend=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'owner',password:'a-long-test-password'});await owner.request('/api/session');
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  await friend.request('/api/register','POST',{name:'Friend',username:'friend',password:'a-long-test-password',invite});await friend.request('/api/session');
  let calls=0;app.source.detail=async()=>{calls++;return detailFor(rawMatch());};
  assert.equal((await friend.request('/api/import/match','POST',{reference:'800'})).status,403);assert.equal(calls,0);
  assert.equal((await owner.request('/api/import/match','POST',{reference:'https://unrelated.example/match/800'})).status,400);assert.equal(calls,0);
  const imported=await owner.request('/api/import/match','POST',{reference:'https://dash.batrace.top/match/800'});
  assert.equal(imported.status,200);assert.equal(imported.data.friend_count,0);assert.equal(calls,1);
  assert.equal((await owner.request('/api/matches/800')).data.units.length,4);
  app.source.detail=async()=>{throw new Error('详情已不可用');};
  assert.equal((await owner.request('/api/import/match','POST',{reference:'801'})).status,400);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM matches').n,1);
});

test('only admins can reset another login password and reset revokes old sessions',async t=>{
  const{client}=await application(t);const owner=client(),friend=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'owner',password:'a-long-test-password'});await owner.request('/api/session');
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  await friend.request('/api/register','POST',{name:'Friend',username:'friend',password:'a-long-test-password',invite});
  const user=(await friend.request('/api/session')).data.user;
  assert.equal((await friend.request('/api/users/1/password','POST',{password:'new-long-password'})).status,403);
  assert.equal((await owner.request(`/api/users/${user.id}/password`,'POST',{password:'new-long-password'})).status,200);
  assert.equal((await friend.request('/api/dashboard')).status,401);
  assert.equal((await friend.request('/api/login','POST',{username:'friend',password:'a-long-test-password'})).status,401);
  assert.equal((await friend.request('/api/login','POST',{username:'friend',password:'new-long-password'})).status,200);
  assert.equal((await owner.request('/api/accounts','POST',{player_id:'76561198000000000'})).status,400);
});
