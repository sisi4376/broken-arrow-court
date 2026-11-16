import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/db.mjs';
import {importHistoryEvidence,requestStatistics} from '../src/request-statistics.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{process.loadEnvFile(path.join(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
const directory=path.resolve(root,process.env.DATA_DIR||'data'),file=path.join(directory,'court.sqlite');
const report=JSON.parse(await readFile(path.join(root,'reports/request-audit-2026-10-27/audit.json'),'utf8'));
const original=new DatabaseSync(file,{readOnly:true});let backupFile;
try{
  const count=original.prepare('SELECT SUM(requests) n FROM sync_runs').get().n;
  if(count<report.metrics.recorded_sync_attempts)throw Error('当前档案不包含审计报告的全部同步轮次，未导入');
  await mkdir(path.join(directory,'backups'),{recursive:true});backupFile=path.join(directory,'backups','before-request-history-'+Date.now()+'.sqlite');await backup(original,backupFile);
}finally{original.close();}
const store=new Store(directory);
try{const imported=importHistoryEvidence(store,report);console.log(JSON.stringify({backup:backupFile,imported,statistics:requestStatistics(store).summary}));}finally{store.close();}
