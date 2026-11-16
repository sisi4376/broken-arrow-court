import test from 'node:test';
import assert from 'node:assert/strict';
import { ntfyConfig, ntfyMessages, ntfyPublish } from '../public/ntfy-transport.js';
import { NtfyUpdateRelay } from '../src/ntfy-update-relay.mjs';
import { testStore } from './helpers.mjs';

const topic = 'court-updates-' + 'a'.repeat(32), id = 'b'.repeat(32), other = 'c'.repeat(32);
const config = ntfyConfig({ topic });
const message = (id, format = 'court-update-request-v1') => JSON.stringify({ event: 'message', id: 'cloud-id', time: 123, message: JSON.stringify({ format, id }) });
test('ntfy configuration and messages validate public routing fields and reject unrelated payloads', async () => {
  assert.equal(config.url, 'https://ntfy.sh');
  assert.throws(() => ntfyConfig({ topic: '../secret' }));
  assert.throws(() => ntfyConfig({ url: 'https://password@ntfy.sh', topic }));
  const messages = await ntfyMessages(config, async () => new Response(['invalid', '{}', message(id), message('not-an-id')].join('\n')));
  assert.equal(messages.length, 1); assert.equal(messages[0].id, id);
});
test('ntfy publication requires an actual message receipt and sends no local credentials', async () => {
  let options;
  await ntfyPublish(config, { id }, async (url, value) => { options = value; return Response.json({ event: 'message', id: 'cloud-id' }); });
  assert.equal(options.credentials, 'omit'); assert.equal(options.headers['Content-Type'], 'text/plain');
  assert.equal(options.headers.Authorization, undefined);
  await assert.rejects(ntfyPublish(config, { id }, async () => Response.json({ event: 'error' })));
});
test('whole batch is durable locally and survives cloud cache expiry and restart', async t => {
  const store = testStore(t); let expired = false, polls = 0, publications = 0;
  const fetcher = async (url, options) => {
    if (options.method === 'POST') { publications++; return Response.json({ event: 'message', id: 'receipt' }); }
    polls++; return new Response(expired ? '' : [message(id), message(id), message(other)].join('\n'));
  };
  const relay = () => new NtfyUpdateRelay(store, {}, {}, { topic, fetcher });
  assert.equal((await relay().call('/next')).request.id, id);
  expired = true;
  const restarted = relay();
  await restarted.call('/ack', { id, status: 'complete' });
  assert.equal((await restarted.call('/next')).request.id, other);
  assert.equal(polls, 1); assert.equal(publications, 1);
});
test('acknowledged cached requests and status messages never become new work', async t => {
  const store = testStore(t);
  const fetcher = async (url, options) => options.method === 'POST' ? Response.json({ event: 'message', id: 'receipt' }) : new Response([message(id), message(other, 'court-update-result-v1')].join('\n'));
  const relay = new NtfyUpdateRelay(store, {}, {}, { topic, fetcher });
  assert.equal((await relay.call('/next')).request.id, id);
  await relay.call('/ack', { id, status: 'failed' });
  assert.equal((await relay.call('/next')).request, null);
});
test('failed result publication preserves the durable queue for retry', async t => {
  const store = testStore(t);
  const relay = new NtfyUpdateRelay(store, {}, {}, { topic, fetcher: async (url, options) => options.method === 'POST' ? new Response('', { status: 429 }) : new Response(message(id)) });
  await relay.call('/next');
  await assert.rejects(relay.call('/ack', { id, status: 'complete' }));
  assert.equal((await relay.call('/next')).request.id, id);
});
