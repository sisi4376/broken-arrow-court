import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import { repairSelfDestruction } from '../src/self-destruction-audit.mjs';

try { process.loadEnvFile('.env'); } catch(e) { if(e.code!=='ENOENT')throw e; }
const apply=process.argv.includes('--apply'),refresh=Number(process.argv.find(a=>a.startsWith('--refresh='))?.split('=')[1]??0);
if(!Number.isInteger(refresh)||refresh<0||refresh>200)throw Error('refresh must be 0..200');
const directory=path.resolve(process.env.DATA_DIR||'data');
if(apply||refresh){
  try { const record=JSON.parse(await readFile(path.join(directory,'service.json'),'utf8'));let alive=false;try{process.kill(record.pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}if(alive)throw Error('请先停止正式后台，再执行回源或修复；审计不会并行请求上游。'); }
  catch(e){if(e.code!=='ENOENT')throw e;}
}
const store=new Store(directory);
try {
  const source=createSource(store,{timeout:12000});
  const ids=(process.argv.find(a=>a.startsWith('--ids='))?.slice(6)??'').split(',').filter(Boolean);
  const report=await repairSelfDestruction(store,{source,apply,refresh,ids,onProgress:r=>console.log(JSON.stringify(r))});
  const out=path.resolve('.cache/self-destruction-audit');await mkdir(out,{recursive:true});
  const finished=new Date().toISOString(),content=JSON.stringify({...report,finished_at:finished},null,2);
  await writeFile(path.join(out,'audit-'+finished.replace(/[:.]/g,'-')+'.json'),content);
  await writeFile(path.join(out,'report.json'),content);
  console.log(JSON.stringify({matches:report.matches,units:report.units,archived_flags:report.archived_flags,uncertain_matches:report.uncertain_matches.length,repair_candidates:report.repair_candidates,repaired:report.repaired,fetched:report.fetched.length,report:path.join(out,'report.json')}));
}finally{store.close();}
