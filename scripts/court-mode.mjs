import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{process.loadEnvFile(path.join(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
const command=process.argv[2]??'status';
if(!['on','off','status'].includes(command))throw new Error('Usage: node scripts/court-mode.mjs [on|off|status]');
const store=new Store(path.resolve(root,process.env.DATA_DIR||'data'));
try{
  if(command!=='status'){
    const enabled=command==='on';
    store.transaction(()=>{store.setting('court_mode',enabled);store.audit(null,'court-mode-local',{court_mode:enabled});});
  }
  console.log(store.settings().court_mode===true?'开庭模式：已开启。公开网页随下一次发布更新。':'开庭模式：已关闭，使用常规界面。');
}finally{store.close();}
