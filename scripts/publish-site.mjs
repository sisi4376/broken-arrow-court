import { Store } from '../src/db.mjs';
import { Publication } from '../src/publication.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!process.env.PUBLISH_GIT_REMOTE) throw new Error('请先在 .env 配置独立静态仓库 PUBLISH_GIT_REMOTE');
// A live backend owns synchronization and publication. Forward to its queue
// instead of opening a second writer during the long snapshot transaction.
let service;
try { service = JSON.parse(await readFile(path.join(process.env.DATA_DIR || 'data', 'service.json'), 'utf8')); } catch {}
if (service && /^http:\/\/127\.0\.0\.1:\d+$/.test(service.url || '') && /^[a-f0-9]{64}$/.test(service.shutdown_token || '')) {
  let healthy = false;
  try { healthy = (await fetch(service.url + '/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (healthy) {
    const request = async method => {
      const response = await fetch(service.url + '/api/service/publication', { method, headers: { 'X-Service-Token': service.shutdown_token }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(response.status === 404 ? '请先重启后台以加载发布队列，再更新网页' : `后台发布请求失败（${response.status}）`);
      return response.json();
    };
    console.log('网页发布已交给运行中的后台；有采集任务时等待采集结束。');
    let status = await request('POST');
    const deadline = Date.now() + 30 * 60000;
    while (status.active || status.queued) {
      if (Date.now() > deadline) throw new Error('发布仍在后台排队或运行，请在管理器查看状态；不要重复启动独立发布进程');
      await sleep(1000); status = await request('GET');
    }
    if (status.status === 'failed' || status.last_error) throw new Error(status.last_error || '网页发布失败，请检查后台日志');
    if(status.status!=='complete')throw new Error('网页已提交，但尚未确认部署完成，请在管理页重试');
    console.log('网页部署成功，已核对线上版本。');
    process.exit(0);
  }
}
const store = new Store(process.env.DATA_DIR || 'data');
try {
  // A manual run must use this process's current code, not a previous daemon's cache.
  console.log('Checking changes, generating the read-only snapshot once if needed, and publishing...');
  const publisher = new Publication(store, { directory: path.resolve(process.env.STATIC_OUTPUT_DIR || 'site'), remote: process.env.PUBLISH_GIT_REMOTE, branch: process.env.PUBLISH_GIT_BRANCH || 'main', intervalMinutes: 5 });
  const result=await publisher.run({ forcePush: true });
  console.log(JSON.stringify(result, null, 2));
  if(result.publication_status==='uploaded')throw new Error('已推送，但此托管平台未完成自动部署验证');
  console.log('网页部署成功，已核对线上版本；内容未变化时不生成重复提交。');
} finally { store.close(); }
