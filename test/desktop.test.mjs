import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { tempDir, member, rawMatch, testStore } from './helpers.mjs';
import { desktopStatus, savePublicationInterval, saveAutoSync,saveSourceProvider } from '../src/desktop.mjs';
import { reserveRequest,finishRequest } from '../src/request-monitor.mjs';
import {BUILD_POLICY} from '../src/distribution.mjs';

test('routine desktop publication bypasses repeat consent while first deployment retains it', async () => {
  const source = await readFile(new URL('../desktop/Manager.cs', import.meta.url), 'utf8');
  const publish = source.slice(source.indexOf('async void Publish()'), source.indexOf('async void Login()'));
  const deploy = source.slice(source.indexOf('async void Deploy()'), source.indexOf('async void Publish()'));
  assert(publish.includes('CanUpdateWebsite()')); assert(publish.includes('scripts/publish-site.mjs'));
  assert(!publish.includes('ConfirmPublication(')); assert(!publish.includes('MessageBox.Show'));
  assert(deploy.includes('ConfirmPublication(')); assert(deploy.includes('--allow-public-data'));
  assert(source.includes('if (!consentBox.Checked)'));
});

test('desktop status is read-only for a new installation and never leaks private configuration', async t => {
  const root = tempDir(t); await writeFile(path.join(root, '.env'), 'PRIVATE_KEY=never-show-this\nPORT=4500\nPUBLISH_GIT_REMOTE=https://github.com/owner/court.git\n');
  const status = await desktopStatus(root, { fetcher: () => { throw Error('No service'); } });
  assert.equal(status.service_running, false); assert.equal(status.local_url, 'http://127.0.0.1:4500'); assert.equal(status.repository, 'owner/court');
  assert(!JSON.stringify(status).includes('never-show-this')); await assert.rejects(readFile(path.join(root, 'data/court.sqlite')));
});

test('desktop status reports archive counts and checks only loopback service URLs', async t => {
  const store = testStore(t); member(store, 'A', [101]); member(store, 'B', [102]); member(store, 'C', [103]); store.ingest('800', rawMatch());
  const root = tempDir(t); await writeFile(path.join(root, '.env'), 'DATA_DIR=' + store.directory + '\n');
  const file = path.join(store.directory, 'service.json'); await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:4317', shutdown_token: 'secret-service-token' }));
  const calls = []; const fetcher = async url => { calls.push(url); return { ok: true }; };
  const status = await desktopStatus(root, { fetcher }); assert.equal(status.friends, 3); assert.equal(status.matches, 1); assert.equal(status.service_running, true);
  assert.equal(status.last_sync,null);assert.equal(status.sync_schedule.timezone,'Asia/Shanghai');
  store.run("INSERT INTO sync_runs(kind,status,started_at,finished_at) VALUES('incremental','partial',?,?)",'2026-10-22T01:00:00Z','2026-10-22T01:02:00Z');
  const finished=await desktopStatus(root,{fetcher});assert.equal(finished.last_sync.status,'partial');assert.equal(finished.last_sync.finished_at,'2026-10-22T01:02:00Z');
  calls.length=1;
  assert.deepEqual(calls, ['http://127.0.0.1:4317/api/health']); assert(!JSON.stringify(status).includes('secret-service-token'));
  await writeFile(file, JSON.stringify({ url: 'http://evil.example', shutdown_token: 'secret-service-token' })); calls.length = 0;
  assert.equal((await desktopStatus(root, { fetcher })).service_running, false); assert.deepEqual(calls, []);
});

test('desktop tool checks discard credential output and preserve a valid custom Pages URL', async t => {
  const root = tempDir(t); await writeFile(path.join(root, '.env'), 'PUBLISH_GIT_REMOTE=https://github.com/owner/court.git\n');
  const run = async (command, args) => ({ code: 0, stdout: args[0] === 'auth' ? 'Logged in to github.com account owner\nToken: SECRET_CLI_TOKEN' : args[0] === 'api' ? JSON.stringify({ status: 'built', html_url: 'https://court.example/' }) : 'version', stderr: '' });
  const status = await desktopStatus(root, { checkTools: true, run });
  assert.equal(status.github_signed_in, true); assert.equal(status.github_account, 'owner'); assert.equal(status.pages_status, 'built'); assert.equal(status.public_url, 'https://court.example/'); assert(!JSON.stringify(status).includes('SECRET_CLI_TOKEN'));
});

test('desktop interval settings preserve all unrelated configuration and reject invalid values', async t => {
  const root = tempDir(t); await writeFile(path.join(root, '.env'), '# private\nDATA_DIR="./private data"\nPRIVATE_KEY=do-not-change\n');
  await savePublicationInterval(root, 180); const env = parseEnv(await readFile(path.join(root, '.env'), 'utf8'));
  assert.equal(env.PUBLISH_MIN_INTERVAL_MINUTES, '180'); assert.equal(env.PRIVATE_KEY, 'do-not-change'); assert.equal(env.DATA_DIR, './private data'); assert(!env.PUBLISH_GIT_REMOTE);
  for (const n of [0, 4, -1, 1.5, 10081, NaN, 'bad']) await assert.rejects(savePublicationInterval(root, n));
});

test('desktop reports persisted daily traffic and can toggle automatic sync while the service is offline',async t=>{
  const store=testStore(t),root=tempDir(t);await writeFile(path.join(root,'.env'),'DATA_DIR='+store.directory+'\nSOURCE_BASE_URL=https://desktop.example\n');
  store.setting('sync_enabled',false);
  const record=reserveRequest(store,'https://desktop.example','/test',1);finishRequest(store,record.id,{status:200,bytes:4096});
  let status=await desktopStatus(root);assert.equal(status.sync_enabled,false);assert.equal(status.request_monitor.today,1);assert.equal(status.request_monitor.bytes_today,4096);assert.equal(status.request_monitor.daily.length,1);
  await saveAutoSync(root,true);assert.equal(store.settings().sync_enabled,true);
  await saveAutoSync(root,false);status=await desktopStatus(root);assert.equal(status.sync_enabled,false);
  assert.equal(store.get('SELECT COUNT(*) n FROM source_requests').n,1);
  await assert.rejects(saveAutoSync(root,'false'),/开启或关闭/);
  const empty=tempDir(t);await assert.rejects(saveAutoSync(empty,true));await assert.rejects(readFile(path.join(empty,'data/court.sqlite')));
});

test('desktop automatic sync uses the local service token without leaking it or writing on failure',async t=>{
  const store=testStore(t),root=tempDir(t);await writeFile(path.join(root,'.env'),'DATA_DIR='+store.directory+'\n');store.setting('sync_enabled',false);
  await writeFile(path.join(store.directory,'service.json'),JSON.stringify({url:'http://127.0.0.1:4317',shutdown_token:'private-fixture-token'}));
  const calls=[],fetcher=async(url,options)=>{calls.push([url,options]);return{ok:true};};
  assert.deepEqual(await saveAutoSync(root,true,{fetcher}),{sync_enabled:true});
  assert.equal(calls[1][0],'http://127.0.0.1:4317/api/service/sync');assert.equal(calls[1][1].headers['X-Service-Token'],'private-fixture-token');assert.deepEqual(JSON.parse(calls[1][1].body),{enabled:true});
  await assert.rejects(saveAutoSync(root,true,{fetcher:async url=>({ok:url.endsWith('/health')})}),/保存失败/);
  assert.equal(store.settings().sync_enabled,false);
});

test('desktop source selection persists without enabling sync and all-time queries include legacy requests',async t=>{
  const store=testStore(t),root=tempDir(t);await writeFile(path.join(root,'.env'),'DATA_DIR='+store.directory+'\n');store.setting('sync_enabled',false);
  store.run("INSERT INTO sync_runs(id,kind,started_at,requests) VALUES(1,'incremental','2026-10-01T00:00:00Z',10)");store.setting('request_history_cutoff_run_id',1);
  await saveSourceProvider(root,'official');let status=await desktopStatus(root,{statistics:{group:'month',from:'2026-10-01',to:'2026-10-31'}});assert.equal(status.source_provider,'official');assert.equal(status.sync_enabled,false);assert.equal(status.request_monitor.total,10);assert.equal(status.request_monitor.statistics.rows[0].date,'2026-10');
  if(BUILD_POLICY.fixed)await assert.rejects(saveSourceProvider(root,'batrace'),/冻结/);
  else{await saveSourceProvider(root,'batrace');assert.equal(store.settings().source_provider,'batrace');assert.equal((await desktopStatus(root)).source_provider,'batrace');}
  assert.equal(store.get('SELECT COUNT(*) n FROM source_requests').n,0);await assert.rejects(saveSourceProvider(root,'unknown'));
});
