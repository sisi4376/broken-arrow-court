import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { CloudBackup } from '../src/cloud-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const store = new Store(path.resolve(root, process.env.DATA_DIR || 'data'));
try {
  const backup = new CloudBackup(store, { repository: process.env.CLOUD_BACKUP_REPOSITORY || '', proxy: process.env.CLOUD_BACKUP_PROXY || '', retention: Number(process.env.CLOUD_BACKUP_RETENTION || 14) });
  if (!backup.repository) throw new Error('请先配置 CLOUD_BACKUP_REPOSITORY');
  const recovery = process.argv.find(arg => arg.startsWith('--recover='));
  if (recovery) await backup.recover(recovery.slice('--recover='.length)); else await backup.tick({ force: true });
  console.log(JSON.stringify(await backup.status(), null, 2));
} finally { store.close(); }
