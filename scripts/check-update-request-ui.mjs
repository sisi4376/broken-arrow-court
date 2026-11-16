import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../src/server.mjs';
import { exportStatic } from '../src/static-export.mjs';

const out = path.resolve('.cache/update-request-ui'); mkdirSync(out, { recursive: true });
const directory = mkdtempSync(path.join(out, 'data-'));
const app = createApplication({ directory, startScheduler: false, staticOutputDirectory: path.join(directory, 'site') });
const ntfy = process.argv.includes('--ntfy');
const previousTopic = process.env.UPDATE_NTFY_TOPIC;
if (ntfy) process.env.UPDATE_NTFY_TOPIC = 'court-updates-' + 'a'.repeat(32);
const previous = process.env.UPDATE_RELAY_URL;
process.env.UPDATE_RELAY_URL = 'https://relay.example';
try { await exportStatic(app.store, { directory: app.staticDirectory }); }
finally { if (previous === undefined) delete process.env.UPDATE_RELAY_URL; else process.env.UPDATE_RELAY_URL = previous; if (previousTopic === undefined) delete process.env.UPDATE_NTFY_TOPIC; else process.env.UPDATE_NTFY_TOPIC = previousTopic; }
const manifest = JSON.parse(readFileSync(path.join(app.staticDirectory, 'manifest.json')));
assert.equal(manifest.update_relay_url, 'https://relay.example');
assert(!JSON.stringify(manifest).includes('UPDATE_RELAY_TOKEN'));
assert(readFileSync(path.join(app.staticDirectory, '_headers'), 'utf8').includes("connect-src 'self' " + (ntfy ? 'https://ntfy.sh' : 'https://relay.example') + ';'));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href); let browser;
try {
  try { browser = await pw.chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { browser = await pw.chromium.launch({ headless: true }); }
  const page = await browser.newPage(), errors = [];
  const now = Date.now(); await page.clock.install({ time: now });
  page.on('pageerror', error => errors.push(error.message));
  let posts = 0, complete = false, id;
  await page.route(ntfy ? 'https://ntfy.sh/**' : 'https://relay.example/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
    if (request.method() === 'POST') { posts++; id = request.postDataJSON().id; }
    const payload = { id, status: complete ? 'complete' : 'queued', next_allowed_at: complete ? now + 600000 : 0 };
    const body = !ntfy ? JSON.stringify(payload) : request.method() === 'POST' ? JSON.stringify({ event: 'message', id: 'cloud-receipt' }) : complete ? JSON.stringify({ event: 'message', id: 'cloud-receipt', message: JSON.stringify({ format: 'court-update-result-v1', ...payload }) }) : '';
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
  const url = `http://127.0.0.1:${app.server.address().port}/readonly/`;
  await page.goto(url.replace('/readonly/', '/')); await page.locator('#auth-form').waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url); await page.getByRole('button', { name: '请求更新', exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(out, `${ntfy ? 'ntfy-' : ''}button-${width}.png`) });
  }
  await page.getByRole('button', { name: '请求更新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#request-public-update')?.disabled);
  await page.getByRole('button', { name: '已请求，等待更新', exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: '已请求，等待更新', exact: true }).waitFor();
  assert.equal(posts, 1);
  complete = true;
  await page.reload(); await page.getByRole('button', { name: '10 分钟后可请求', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '10 分钟后可请求', exact: true }).isDisabled());
  await page.reload(); await page.getByRole('button', { name: '10 分钟后可请求', exact: true }).waitFor();
  await page.clock.fastForward(600001);
  await page.getByRole('button', { name: '请求更新', exact: true }).waitFor();
  assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  console.log('Desktop/mobile button, request receipt, persisted ten-minute cooldown and automatic expiry passed.');
} finally { await browser?.close(); await app.close(); }
