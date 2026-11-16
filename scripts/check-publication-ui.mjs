import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../src/server.mjs';
import { exportStatic } from '../src/static-export.mjs';

const out = path.resolve('.cache/publication-ui'); mkdirSync(out, { recursive: true });
const directory = mkdtempSync(path.join(out, 'data-'));
const app = createApplication({ directory, startScheduler: false, staticOutputDirectory: path.join(directory, 'site') });
app.store.setting('sync_enabled', false);
app.publication.remote = 'https://github.com/example/isolated-test.git';
let release, calls = 0;
app.publication.run = async ({ forcePush }) => {
  assert.equal(forcePush, true); calls++;
  await new Promise(resolve => { release = resolve; });
};
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href); let browser;
try {
  try { browser = await pw.chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { browser = await pw.chromium.launch({ headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.getByLabel('朋友称呼', { exact: true }).fill('测试管理员');
  await page.getByLabel('登录名', { exact: true }).fill('publication-ui-owner');
  await page.getByLabel('密码', { exact: true }).fill('publication-ui-password');
  await page.getByLabel('确认密码', { exact: true }).fill('publication-ui-password');
  await page.getByRole('button', { name: '创建法庭', exact: true }).click();
  await page.locator('[data-action="publish-site"]').waitFor();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of ['dashboard', 'sync']) {
      await page.goto(url + '/#' + route);
      await page.locator('[data-action="publish-site"]').waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert(await page.locator('[data-action="sync-now"]').evaluate(el => el.nextElementSibling?.dataset.action === 'publish-site'));
      const boxes = await page.locator('.page-actions button').evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom }; }));
      assert(boxes.every((a, i) => boxes.every((b, j) => i === j || a.r <= b.x + 1 || b.r <= a.x + 1 || a.b <= b.y + 1 || b.b <= a.y + 1)), 'action buttons overlap');
      await page.screenshot({ path: path.join(out, `${route}-${viewport.width}.png`), fullPage: true });
    }
  }
  await page.getByRole('button', { name: '更新网页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-action="publish-site"]')?.disabled);
  assert.equal(await page.locator('[data-action="publish-site"]').textContent(), '发布中');
  app.publication.operation.phase='deploying';
  await page.reload();await page.getByRole('status').filter({hasText:'正在等待 Pages 部署并核对线上版本'}).waitFor();
  assert.equal(calls, 1); release(); await app.publication.active;
  await page.reload(); await page.getByRole('button', { name: '更新网页', exact: true }).waitFor();
  app.engine.active = Promise.resolve();
  await page.getByRole('button', { name: '更新网页', exact: true }).click();
  await page.getByRole('button', { name: '等待发布', exact: true }).waitFor();
  assert.equal(calls, 1); app.engine.active = null;
  const task = app.publication.tick(); release(); await task;
  app.publication.run = async () => { throw Error('模拟发布失败'); };
  await page.reload(); await page.getByRole('button', { name: '更新网页', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '网页更新失败：模拟发布失败' }).waitFor();
  assert.equal(await page.locator('[data-action="publish-site"]').isEnabled(), true);
  await page.screenshot({ path: path.join(out, 'failure-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '开庭', exact: true }).click();
  await page.getByRole('button', { name: '调取新卷宗', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '更新网页', exact: true }).count(), 1);
  await exportStatic(app.store, { directory: app.staticDirectory });
  const viewer = await browser.newPage(); await viewer.goto(url + '/readonly/');
  await viewer.locator('#main h1').waitFor();
  assert.equal(await viewer.locator('[data-action="publish-site"]').count(), 0);
  assert.equal(await viewer.locator('#publication-status').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['dashboard and sync adjacency', 'desktop and mobile layout', 'publish busy state', 'queued until sync ends', 'failure and retry', 'court labels', 'read-only exclusions'], screenshots: out }));
} finally {
  if (release) release(); app.engine.active = null;
  await browser?.close(); await app.close();
}
