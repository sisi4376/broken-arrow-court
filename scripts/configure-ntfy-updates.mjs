import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { updateDeploymentEnv } from '../src/github-deploy.mjs';
import { ntfyConfig } from '../public/ntfy-transport.js';

const original = await readFile('.env', 'utf8');
const existing = parseEnv(original);
const config = ntfyConfig({ url: existing.UPDATE_NTFY_URL || 'https://ntfy.sh', topic: existing.UPDATE_NTFY_TOPIC || 'court-updates-' + randomBytes(16).toString('hex') });
const next = updateDeploymentEnv(original, { UPDATE_NTFY_URL: config.url, UPDATE_NTFY_TOPIC: config.topic });
if (next !== original) {
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/ntfy-updates.env.tmp', next, { mode: 0o600 });
  await rename('.cache/ntfy-updates.env.tmp', '.env');
}
console.log('免登录更新请求已配置；重启后台并发布网页后生效。云端默认缓存 12 小时。');
