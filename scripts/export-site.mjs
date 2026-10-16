import { Store } from '../src/db.mjs';
import { exportStatic } from '../src/static-export.mjs';
import path from 'node:path';
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const store = new Store(process.env.DATA_DIR || 'data');
try { console.log(JSON.stringify(await exportStatic(store, { directory: path.resolve(process.env.STATIC_OUTPUT_DIR || 'site') }), null, 2)); }
finally { store.close(); }
