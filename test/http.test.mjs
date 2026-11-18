import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exportStatic } from '../src/static-export.mjs';
import { createApplication } from '../src/server.mjs';
import { tempDir,rawMatch,detailFor,member } from './helpers.mjs';
import { quietMatchAccounts } from '../src/account-query-policy.mjs';

async function application(t,options={}){
  let app;const directory=tempDir(t,()=>app?.close());app=createApplication({directory,startScheduler:false,staticOutputDirectory:path.join(directory,'public-site'),sourceOptions:{fetcher:async()=>new Response('{}',{status:404})},...options});
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

test('desktop publication queue requires the local token and waits for active sync',async t=>{
  const {app,base}=await application(t,{shutdownToken:'a'.repeat(64)});
  const request=(method='GET',token='a'.repeat(64))=>fetch(base+'/api/service/publication',{method,headers:{'X-Service-Token':token}});
  assert.equal((await request('GET','wrong')).status,403);
  assert.equal((await request('POST','wrong')).status,403);
  app.publication.remote='https://github.com/example/public.git';
  let calls=0;app.publication.run=async()=>{calls++;};
  app.engine.active=Promise.resolve();
  const queued=await request('POST');assert.equal(queued.status,202);assert.equal((await queued.json()).queued,true);assert.equal(calls,0);
  app.engine.active=null;await app.publication.tick();
  const status=await(await request()).json();assert.equal(status.active,false);assert.equal(status.queued,false);assert.equal(status.status,'complete');assert.equal(calls,1);
});

test('sync status exposes local query ranking and silence deadline without contacting the source',async t=>{
  const {app,client}=await application(t),owner=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'quiet-owner',password:'quiet-owner-password'});await owner.request('/api/session');
  assert.equal((await owner.request('/api/sync/status')).data.settings.match_query_quiet_enabled,false);
  assert.equal((await owner.request('/api/settings','PATCH',{match_query_quiet_enabled:'true'})).status,400);
  assert.equal((await owner.request('/api/settings','PATCH',{match_query_quiet_enabled:true})).status,200);
  member(app.store,'Tracked',[101]);app.store.saveProfile('101',{info:{id:101},statInfo:{fightsCountRt:500}});
  const raw=rawMatch([101,201],{EndTime:Math.floor(Date.now()/1000)-60});app.store.ingest('900',raw);app.store.saveDetail('900',detailFor(raw));
  quietMatchAccounts(app.store,'900',raw,'101');
  const response=await owner.request('/api/sync/status'),account=response.data.accounts.find(a=>a.player_id==='101');
  assert.equal(response.status,200);assert.equal(account.query_games,500);assert.equal(account.query_silent,true);
  assert.equal(account.query_quiet_until,raw.EndTime*1000+45*60000);assert.equal(account.query_quiet_match_id,'900');
  await owner.request('/api/settings','PATCH',{match_query_quiet_enabled:false});
  const disabled=(await owner.request('/api/sync/status')).data;
  assert.equal(disabled.settings.match_query_quiet_enabled,false);
  assert.equal(disabled.accounts.find(a=>a.player_id==='101').query_silent,false);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM source_requests').n,0);assert.equal(app.store.settings().sync_enabled,false);
});

test('application connects finished sync rounds to publication checks',async t=>{
  const {app}=await application(t);let checks=0;
  app.publication.tick=async()=>{assert.equal(app.engine.active,null);checks++;};
  app.engine.run=async()=>{};app.engine.request();await app.engine.active;
  assert.equal(checks,1);
  app.engine.active=Promise.resolve();assert.equal(app.publication.isSyncActive(),true);
  app.engine.active=null;assert.equal(app.publication.isSyncActive(),false);
});

test('successful public-data mutations notify publication immediately while reads and failed requests stay quiet',async t=>{
  const {app,client}=await application(t,{startScheduler:true}),owner=client(),guest=client();let changes=0;
  app.publication.tick=async options=>{if(options?.dataChanged)changes++;};
  await owner.request('/api/register','POST',{name:'Owner',username:'publish-data-owner',password:'publish-data-password'});await owner.request('/api/session');
  assert.equal(changes,1);
  await owner.request('/api/dashboard');assert.equal(changes,1);
  assert.equal((await guest.request('/api/members/1','PATCH',{name:'Denied'})).status,401);assert.equal(changes,1);
  assert.equal((await owner.request('/api/members/1','PATCH',{name:'Updated'})).status,200);assert.equal(changes,2);
  const payload=JSON.stringify({format:'broken-arrow-court-v1',matches:[{id:'800',raw:rawMatch()}]});
  assert.equal((await owner.request('/api/import','POST',{payload})).status,200);assert.equal(changes,3);
  assert.equal(app.store.settings().sync_enabled,false);
});

test('manual sync requests preserve the automatic setting and carry a separate manual flag',async t=>{
  const {app,client}=await application(t),owner=client(),guest=client(),calls=[];
  app.engine.request=(kind,options)=>{calls.push({kind,...options});return{started:true};};
  assert.equal((await guest.request('/api/sync/run','POST',{kind:'full'})).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'manual-sync-owner',password:'manual-sync-password'});await owner.request('/api/session');
  for(const enabled of [false,true])for(const kind of ['incremental','full']){
    app.store.setting('sync_enabled',enabled);
    const response=await owner.request('/api/sync/run','POST',{kind});
    assert.equal(response.status,202);assert.equal(app.store.settings().sync_enabled,enabled);
    assert.deepEqual(calls.at(-1),{kind,manual:true});
  }
  app.engine.pending='full';app.engine.pendingManual=true;
  assert.equal((await owner.request('/api/settings','PATCH',{sync_enabled:false})).status,200);
  assert.equal(app.engine.pending,'full');assert.equal(app.store.settings().sync_enabled,false);
});

test('desktop auto-sync control requires its local token, persists without starting work, and clears queued work when paused',async t=>{
  const {app,client}=await application(t,{shutdownToken:'fixture-local-token'}),local=client();let started=0;app.engine.request=()=>{started++;};
  assert.equal((await local.request('/api/service/sync','POST',{enabled:true})).status,403);
  const headers={'X-Service-Token':'fixture-local-token'};
  assert.equal((await local.request('/api/service/sync','POST',{enabled:'false'},headers)).status,400);
  assert.equal((await local.request('/api/service/sync','POST',{enabled:true},{...headers,Origin:'https://other.example'})).status,403);
  assert.equal((await local.request('/api/service/sync','POST',{enabled:true},headers)).status,200);
  assert.equal(app.store.settings().sync_enabled,true);assert.equal(started,0);
  app.engine.pending='incremental';
  assert.equal((await local.request('/api/service/sync','POST',{enabled:false},headers)).status,200);
  assert.equal(app.store.settings().sync_enabled,false);assert.equal(app.engine.pending,null);assert.equal(started,0);
  app.engine.pending='full';app.engine.pendingManual=true;
  assert.equal((await local.request('/api/service/sync','POST',{enabled:false},headers)).status,200);
  assert.equal(app.engine.pending,'full');assert.equal(app.store.settings().sync_enabled,false);assert.equal(started,0);
});

test('statistics queries and CSV are admin-only, while source switching is persistent, idle-only and never starts network work',async t=>{
  const {app,client}=await application(t),owner=client(),guest=client();
  assert.equal((await guest.request('/api/source/statistics')).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'statistics-owner',password:'statistics-owner-password'});await owner.request('/api/session');
  app.store.run("INSERT INTO sync_runs(id,kind,started_at,requests) VALUES(1,'incremental','2026-10-01T00:00:00Z',10)");app.store.setting('request_history_cutoff_run_id',1);
  const result=await owner.request('/api/source/statistics?from=2026-10-01&to=2026-10-27&group=month');assert.equal(result.status,200);assert.equal(result.data.summary.requests,10);assert.equal(result.data.rows.length,1);
  assert.equal((await owner.request('/api/source/statistics?from=2026-02-30')).status,400);
  assert.equal((await owner.request('/api/source/provider','POST',{provider:'official'})).status,200);assert.equal(app.source.provider,'official');assert.equal(app.engine.source,app.source);assert.equal(app.store.settings().source_provider,'official');assert.equal(app.store.settings().sync_enabled,false);
  app.engine.active=Promise.resolve();assert.equal((await owner.request('/api/source/provider','POST',{provider:'official'})).status,409);app.engine.active=null;
  assert.equal((await owner.request('/api/source/provider','POST',{provider:'batrace'})).status,400);assert.equal(app.source.provider,'official');assert.equal(app.store.get('SELECT COUNT(*) n FROM source_requests').n,0);
});

test('lifetime profile reads combine the saved baseline with local matches without contacting the source',async t=>{
  const {app,client}=await application(t),owner=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'lifetime-owner',password:'lifetime-owner-password'});await owner.request('/api/session');
  const id=Number(app.store.run('INSERT INTO accounts(member_id,player_id,name,created_at) VALUES(?,?,?,?)',1,'101','Local account',new Date().toISOString()).lastInsertRowid);
  app.store.saveProfile('101',{info:{id:101},statInfo:{fightsCountRt:10,updatedAt:'$D2026-10-20T00:00:00Z'}});
  app.store.ingest('901',rawMatch(undefined,{Type:0,EndTime:Date.parse('2026-10-21T00:00:00Z')/1000}),id);
  app.source.fetcher=()=>{throw Error('Profile display must stay local');};
  const response=await owner.request(`/api/accounts/${id}/profile`);
  assert.equal(response.status,200);assert.equal(response.data.data.statInfo.fightsCountRt,11);
  assert.equal(response.data.calibration.days,8);assert.equal(response.data.local_update.matches,1);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM source_requests').n,0);
});

test('request monitoring and its limits are private, persistent, paginated and admin controlled',async t=>{
  const {app,client}=await application(t),owner=client(),friend=client(),guest=client();
  assert.equal((await guest.request('/api/source/requests')).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'request-owner',password:'request-owner-password'});await owner.request('/api/session');
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  await friend.request('/api/register','POST',{name:'Friend',username:'request-friend',password:'request-friend-password',invite});await friend.request('/api/session');
  assert.equal((await friend.request('/api/source/requests')).status,403);
  assert.equal((await friend.request('/api/sync/status')).data.request_monitor,null);
  assert.equal((await friend.request('/api/settings','PATCH',{request_limit_day:1})).status,403);
  assert.equal((await owner.request('/api/settings','PATCH',{request_limit_day:0})).status,400);
  assert.equal((await owner.request('/api/settings','PATCH',{request_limit_day:30,request_limit_hour:20,request_limit_minute:5})).status,200);
  await assert.rejects(app.source.read('/user/monitor-test-one'),/404/);
  app.store.setting('request_delay_ms',0);await assert.rejects(app.source.read('/user/monitor-test-two'),/404/);
  const m=(await owner.request('/api/sync/status')).data.request_monitor;
  assert.equal(m.total,2);assert.equal(m.errors_today,2);assert.equal(m.limits.day,30);assert.equal(m.limits.minute,5);
  const first=(await owner.request('/api/source/requests?limit=1')).data;
  const second=(await owner.request('/api/source/requests?limit=1&before='+first.next_before)).data;
  assert.equal(first.rows[0].resource,'/user/monitor-test-two');assert.equal(second.rows[0].resource,'/user/monitor-test-one');
  const page=(await owner.request('/api/source/requests?page=2&page_size=1')).data;
  assert.equal(page.total_rows,2);assert.equal(page.total_pages,2);assert.equal(page.rows[0].id,second.rows[0].id);
  assert.equal((await owner.request('/api/source/requests?page=1')).data.page_size,15);
  for(const query of ['page=0','page=1&page_size=16','page=abc'])assert.equal((await owner.request('/api/source/requests?'+query)).status,400);
  assert.equal((await owner.request('/api/source/requests?limit=1000')).status,400);
  assert.equal(app.store.settings().sync_enabled,false);
});

test('website publication requires an administrator and CSRF, uses only the saved target and reports private status',async t=>{
  const {app,client}=await application(t),owner=client(),friend=client(),guest=client();app.publication.remote='';
  assert.equal((await guest.request('/api/publication/run','POST',{})).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'publish-owner',password:'publish-owner-password'});await owner.request('/api/session');
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  await friend.request('/api/register','POST',{name:'Friend',username:'publish-friend',password:'publish-friend-password',invite});await friend.request('/api/session');
  assert.equal((await friend.request('/api/publication/run','POST',{})).status,403);
  assert.equal((await owner.request('/api/publication/run','POST',{}, {'X-CSRF-Token':''})).status,403);
  assert.equal((await owner.request('/api/publication/run','POST',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await owner.request('/api/publication/run','POST',{})).status,400);
  let forced=false;app.publication.remote='https://github.com/owner/public-site.git';
  app.publication.tick=async options=>{forced=options.forcePush;};
  const response=await owner.request('/api/publication/run','POST',{remote:'https://github.com/attacker/other.git'});
  assert.equal(response.status,202);assert.equal(response.data.queued,false);assert(forced);
  assert.equal(app.publication.remote,'https://github.com/owner/public-site.git');
  app.engine.active=Promise.resolve();assert.equal((await owner.request('/api/publication/run','POST',{})).data.queued,true);app.engine.active=null;
  const adminStatus=(await owner.request('/api/sync/status')).data.settings.publication;
  assert.equal(adminStatus.configured,true);assert.equal(adminStatus.active,false);assert(!JSON.stringify(adminStatus).includes('github.com'));
  assert.equal((await friend.request('/api/sync/status')).data.settings.publication,undefined);
});

test('sync status exposes the Beijing schedule and rejects the obsolete single interval',async t=>{
  const {client}=await application(t),owner=client();
  await owner.request('/api/register','POST',{name:'Owner',username:'schedule-owner',password:'schedule-password'});await owner.request('/api/session');
  const status=(await owner.request('/api/sync/status')).data;
  assert.deepEqual(status.settings.sync_schedule.day_hours,[6,12,18]);assert.equal(status.settings.sync_schedule.fast_minutes,10);
  assert([10,null].includes(status.settings.sync_minutes));
  assert.equal((await owner.request('/api/settings','PATCH',{sync_minutes:15})).status,400);
  assert.equal((await owner.request('/api/settings','PATCH',{sync_enabled:false,request_delay_ms:1800})).status,200);
});

test('private backup status and manual cloud backups are restricted to local administrators',async t=>{
  const {app,client}=await application(t),owner=client(),friend=client(),guest=client();
  assert.equal((await guest.request('/api/backup/cloud','POST',{})).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'backup-owner',password:'backup-owner-password'});await owner.request('/api/session');
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  await friend.request('/api/register','POST',{name:'Friend',username:'backup-friend',password:'backup-friend-password',invite});await friend.request('/api/session');
  assert.equal((await friend.request('/api/backup/cloud','POST',{})).status,403);
  assert.equal((await friend.request('/api/sync/status')).data.settings.cloud_backup,undefined);
  assert.equal((await owner.request('/api/sync/status')).data.settings.cloud_backup.enabled,false);
  assert.equal((await owner.request('/api/backup/cloud','POST',{})).status,400);
  let forced=false;app.cloudBackup.repository='owner/private';app.cloudBackup.tick=async options=>{forced=options.force;};
  assert.equal((await owner.request('/api/backup/cloud','POST',{})).status,202);assert(forced);
});

test('court UI is permanent for new installs and legacy settings and cannot be disabled',async t=>{
  const {app,client,base}=await application(t),owner=client(),friend=client(),guest=client();
  assert.deepEqual((await guest.request('/api/session')).data.ui,{court_mode:true});
  app.store.setting('court_mode',false);
  assert.equal((await guest.request('/api/session')).data.ui.court_mode,true);
  await owner.request('/api/register','POST',{name:'Owner',username:'court-mode-owner',password:'court-mode-password'});await owner.request('/api/session');
  const invite=(await owner.request('/api/invitations','POST',{})).data.code;
  await friend.request('/api/register','POST',{name:'Friend',username:'court-mode-friend',password:'court-mode-password',invite});await friend.request('/api/session');
  assert.equal((await friend.request('/api/settings','PATCH',{court_mode:true})).status,403);
  assert.equal((await owner.request('/api/settings','PATCH',{court_mode:'true'})).status,400);
  assert.equal((await owner.request('/api/settings','PATCH',{court_mode:true})).status,200);
  assert.equal(app.store.settings().court_mode,true);
  assert.equal((await guest.request('/api/session')).data.ui.court_mode,true);
  assert.equal((await friend.request('/api/sync/status')).data.settings.court_mode,true);
  assert.equal((await fetch(base+'/court-ui.js')).status,200);
  assert.equal((await fetch(base+'/court-ui.css')).status,200);
  assert.equal((await owner.request('/api/settings','PATCH',{court_mode:false})).status,400);
  assert.equal((await guest.request('/api/session')).data.ui.court_mode,true);
});

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
  assert.equal((await guest.request('/api/analytics/zhanfan')).status,401);
  assert.equal((await guest.request('/api/analytics/zhanfan?court_compare=1')).status,401);
  assert.equal((await guest.request('/api/analytics/zhanfan?court_cases=1')).status,401);
  await owner.request('/api/register','POST',{name:'Owner',username:'supply-owner',password:'supply-owner-password'});await owner.request('/api/session');
  for(const name of ['B','C'])await owner.request('/api/members','POST',{name});
  for(const[member_id,player_id]of [[1,'101'],[2,'102'],[3,'103']])await owner.request('/api/accounts','POST',{member_id,player_id});
  const raw=rawMatch();app.store.ingest('800',raw);const d=detailFor(raw);d.data.Data['101'].SupplyPointsConsumedFromAllies=123;d.data.Data['102'].SupplyPointsConsumedByAllies=456;app.store.saveDetail('800',d);
  const result=await owner.request('/api/analytics/supply?supply_min_games=1');
  assert.equal(result.status,200);assert.equal(result.data.hungry[0].avg_received_allies,123);assert.equal(result.data.transport[0].avg_supplied_allies,456);
  assert.equal((await owner.request('/api/analytics/supply')).data.hungry.length,0);
  const asset=await fetch(base+'/performance.js');assert.equal(asset.status,200);assert((await asset.text()).includes('蘸饭罪名榜'));
  const court=await owner.request('/api/analytics/zhanfan?court_min_games=1');assert.equal(court.status,200);assert.equal(court.data.model.version,'zhanfan-v10-stacked');assert(court.data.members.some(r=>r.scored_matches===1));
  const comparison=await owner.request('/api/analytics/zhanfan?court_min_games=1&court_compare=1');assert.equal(comparison.status,200);assert.deepEqual(comparison.data.current,court.data);assert.equal(comparison.data.kind,'court-model-comparison');assert.equal(comparison.data.previous.model.version,'zhanfan-v9-expanded');
  const cases=await owner.request('/api/analytics/zhanfan?court_cases=1');assert.equal(cases.status,200);assert.equal(cases.data.kind,'court-evidence-review');assert.equal(cases.data.overview.confirmed_labels,0);assert(!('trial' in cases.data));
  const courtAsset=await fetch(base+'/zhanfan.js');assert.equal(courtAsset.status,200);assert((await courtAsset.text()).includes('蘸饭刑期榜'));
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
