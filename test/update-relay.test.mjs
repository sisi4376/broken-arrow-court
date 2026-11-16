import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../relay/worker.mjs';
import { UpdateRelay, relayUrl } from '../src/update-relay.mjs';
import { SyncEngine } from '../src/sync.mjs';
import { testStore } from './helpers.mjs';

function cloud(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../relay/schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const DB = { prepare(sql) { return { args: [], bind(...args) { this.args = args; return this; }, async first() { return db.prepare(sql).get(...this.args) ?? null; }, async run() { return { meta: { changes: Number(db.prepare(sql).run(...this.args).changes) } }; } }; } };
  const env = { DB, SITE_ORIGIN: 'https://friends.example', CONSUMER_TOKEN: 'a'.repeat(64) };
  const send = (route, body, admin = false, ip = '1.2.3.4', origin = env.SITE_ORIGIN) => worker.fetch(new Request('https://relay.example' + route, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'CF-Connecting-IP': ip, ...(admin ? { Authorization: `Bearer ${env.CONSUMER_TOKEN}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  return { db, env, send };
}
const id = 'b'.repeat(32);
test('relay accepts, deduplicates, limits, authenticates and completes a request', async t => {
  const { db, send } = cloud(t);
  assert.equal((await send('/requests', { id })).status, 202);
  assert.equal((await send('/requests', { id })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 1);
  assert.equal((await send('/requests', { id: 'c'.repeat(32) })).status, 429);
  assert.equal((await send('/next')).status, 401);
  assert.equal((await (await send('/next', null, true)).json()).request.id, id);
  await send('/ack', { id, status: 'complete' }, true);
  assert.equal((await (await send('/requests/' + id)).json()).status, 'complete');
  assert.equal((await (await send('/next', null, true)).json()).request, null);
  assert.equal((await send('/requests', { id }, false, '1.2.3.4', 'https://evil.example')).status, 403);
});
test('queue cap is enforced across visitors and queued requests are not expired', async t => {
  const { db, send, env } = cloud(t);
  for (let i = 0; i < 20; i++) assert.equal((await send('/requests', { id: i.toString(16).padStart(32, '0') }, false, 'ip' + i)).status, 202);
  assert.equal((await send('/requests', { id }, false, 'other')).status, 429);
  db.exec('UPDATE requests SET created_at=1');
  await worker.scheduled({}, env);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 20);
});
test('relay URL never accepts credentials, script schemes or extra URL components', () => {
  assert.equal(relayUrl('https://relay.example/'), 'https://relay.example');
  for (const value of ['http://relay.example', 'https://token@relay.example', 'https://relay.example/a', 'https://relay.example/?key=secret', "https://relay.example/#'unsafe"]) assert.throws(() => relayUrl(value));
});
function consumer(store, fetcher, outcome = 'complete') {
  let runs = 0;
  const engine = { source: { blockedUntil: 0 }, request(kind, { requestId }) {
    runs++;
    const run = store.run('INSERT INTO sync_runs(kind,started_at,status) VALUES(?,?,?)', kind, 'now', outcome);
    store.setting('remote_update:' + requestId, { run_id: Number(run.lastInsertRowid) });
    this.active = Promise.resolve().finally(() => { this.active = null; });
    return { started: true };
  } };
  const publication = { tick: async () => {}, status: async () => ({ configured: true, status: 'complete' }) };
  const relay = new UpdateRelay(store, engine, publication, { url: 'https://relay.example', token: 'secret', fetcher });
  return { relay, engine, get runs() { return runs; } };
}
function account(store) { store.run("INSERT INTO members(name,created_at) VALUES('friend','now')"); store.run("INSERT INTO accounts(member_id,player_id,name,created_at) VALUES(1,'123','friend','now')"); }
test('failed acknowledgement retries without crawling again, including after restart', async t => {
  const store = testStore(t); account(store);
  let acks = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith('/next')) return Response.json({ request: { id } });
    acks++; if (acks === 1) throw new Error('offline');
    assert.equal(JSON.parse(options.body).status, 'complete'); return Response.json({ ok: true });
  };
  const first = consumer(store, fetcher); await first.relay.tick();
  assert.equal(first.runs, 1);
  const restarted = consumer(store, fetcher); await restarted.relay.tick();
  assert.equal(restarted.runs, 0); assert.equal(acks, 2);
});
test('busy engine and upstream cooldown leave requests queued', async t => {
  const store = testStore(t); account(store); let calls = 0;
  const c = consumer(store, async () => { calls++; return Response.json({ request: null }); });
  c.engine.active = Promise.resolve(); await c.relay.tick();
  c.engine.active = null; c.engine.source.blockedUntil = Date.now() + 60000; await c.relay.tick();
  assert.equal(calls, 0);
});
test('interrupted or partial sync is acknowledged as failure without another run', async t => {
  const store = testStore(t); account(store);
  let status;
  const c = consumer(store, async (url, options) => url.endsWith('/next') ? Response.json({ request: { id } }) : (status = JSON.parse(options.body).status, Response.json({ ok: true })), 'partial');
  await c.relay.tick(); assert.equal(status, 'failed'); assert.equal(c.runs, 1);
});
test('an uploaded but unverified website never acknowledges a group update as complete',async t=>{
  const store=testStore(t);account(store);let status;
  const c=consumer(store,async(url,options)=>url.endsWith('/next')?Response.json({request:{id}}):(status=JSON.parse(options.body).status,Response.json({ok:true})));
  c.relay.publication.status=async()=>({configured:true,status:'uploaded',last_error:null});
  await c.relay.tick();assert.equal(status,'failed');assert.equal(c.runs,1);
});

test('real sync engine persists request receipt with run creation and keeps automatic sync disabled', async t => {
  const store = testStore(t);
  const engine = new SyncEngine(store, { blockedUntil: 0 });
  // No accounts: exercise atomic run creation without any external requests.
  engine.enrich = async () => {};
  store.setting('sync_enabled', false);
  engine.request('incremental', { manual: true, requestId: id });
  const receipt = store.settings()['remote_update:' + id];
  assert.ok(receipt.run_id);
  await engine.active;
  assert.equal(store.get('SELECT status FROM sync_runs WHERE id=?', receipt.run_id).status, 'complete');
  assert.equal(store.settings().sync_enabled, false);
});

test('global ten-minute window rejects other request IDs across restarts and permits the exact boundary', async t => {
  const store = testStore(t); account(store);
  let currentId = id, at = 1000000;
  const replies = [];
  const fetcher = async (url, options) => {
    if (url.endsWith('/next')) return Response.json({ request: { id: currentId } });
    replies.push(JSON.parse(options.body)); return Response.json({ ok: true });
  };
  const first = consumer(store, fetcher); first.relay.clock = () => at;
  await first.relay.tick(); assert.equal(first.runs, 1);
  assert.equal(replies.at(-1).next_allowed_at, at + 600000);
  const restarted = consumer(store, fetcher); restarted.relay.clock = () => at;
  currentId = 'c'.repeat(32); at += 599999;
  await Promise.all([restarted.relay.tick(), restarted.relay.tick()]);
  assert.equal(restarted.runs, 0);
  assert.equal(replies.at(-1).status, 'cooldown');
  assert.equal(store.settings()['remote_update:' + currentId].run_id, undefined);
  currentId = 'd'.repeat(32); at++;
  await restarted.relay.tick(); assert.equal(restarted.runs, 1);
  assert.equal(replies.at(-1).status, 'complete');
});

test('failed sync consumes its window but receipt retries do not extend it', async t => {
  const store = testStore(t); account(store);
  let currentId = id, at = 2000000;
  const statuses = [];
  const c = consumer(store, async (url, options) => {
    if (url.endsWith('/next')) return Response.json({ request: { id: currentId } });
    statuses.push(JSON.parse(options.body).status); return Response.json({ ok: true });
  }, 'failed');
  c.relay.clock = () => at;
  await c.relay.tick(); assert.equal(c.runs, 1);
  const next = store.settings().remote_update_next_allowed_at;
  at += 1000; await c.relay.tick();
  assert.equal(c.runs, 1); assert.equal(store.settings().remote_update_next_allowed_at, next);
  currentId = 'e'.repeat(32); await c.relay.tick();
  assert.equal(c.runs, 1); assert.equal(statuses.at(-1), 'cooldown');
});

test('concurrent relay ticks never start concurrent source work', async t => {
  const store = testStore(t); account(store);
  let release, polls = 0;
  const c = consumer(store, async url => {
    if (url.endsWith('/next')) { polls++; await new Promise(resolve => { release = resolve; }); return Response.json({ request: { id } }); }
    return Response.json({ ok: true });
  });
  const running = c.relay.tick();
  await c.relay.tick(); await c.relay.tick();
  assert.equal(polls, 1); release(); await running; assert.equal(c.runs, 1);
});
