import { Store } from '../src/db.mjs';
import { Publication } from '../src/publication.mjs';
import { exportStatic } from '../src/static-export.mjs';
import path from 'node:path';
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!process.env.PUBLISH_GIT_REMOTE) throw new Error('请先在 .env 配置独立静态仓库 PUBLISH_GIT_REMOTE');
const store = new Store(process.env.DATA_DIR || 'data');
try {
  // A manual run must use this process's current code, not a previous daemon's cache.
  console.log('[1/2] Exporting the current read-only snapshot...');
  await exportStatic(store, { directory: path.resolve(process.env.STATIC_OUTPUT_DIR || 'site') });
  console.log('[2/2] Publishing to the configured Git repository (or checking that it is up to date)...');
  const publisher = new Publication(store, { directory: path.resolve(process.env.STATIC_OUTPUT_DIR || 'site'), remote: process.env.PUBLISH_GIT_REMOTE, branch: process.env.PUBLISH_GIT_BRANCH || 'main', intervalMinutes: 5 });
  console.log(JSON.stringify(await publisher.run({ forcePush: true }), null, 2));
  console.log('Publication completed. Cloud deployment may still be pending; unchanged content does not create a new commit.');
} finally { store.close(); }
