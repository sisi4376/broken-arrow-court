import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { tempDir, member, rawMatch, testStore } from './helpers.mjs';
import { desktopStatus, savePublicationInterval } from '../src/desktop.mjs';

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
