import {execFileSync} from 'node:child_process';
import {Store} from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import {updateUnitLoadoutHistory} from '../src/unit-loadout-history.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const ref=process.argv.find(s=>s.startsWith('--ref='))?.slice(6)??'00116fddace6bac6bd43f89ecef43b4e1f8f191a';
if(!/^[a-f0-9]{40}$/.test(ref))throw new Error('--ref 必须是 BA-Units 的完整提交 SHA');
const store=new Store(process.env.DATA_DIR||'data');
try{
  for(const table of ['Options','Modifications','Units']){
    const resource=`repos/JohnJinHM/BA-Units/contents/output/tables/${table}.json?ref=${ref}`,key='github:'+resource;
    if(store.get('SELECT 1 AS found FROM source_snapshots WHERE source_key=?',key)){console.log(`${table}: already cached`);continue;}
    const data=JSON.parse(execFileSync('gh',['api','-H','Accept: application/vnd.github.raw+json',resource],{encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024}));
    if(!Array.isArray(data)||!data.every(row=>Number.isSafeInteger(row.Id)))throw new Error(`${table}: 游戏数据表结构不符`);
    store.snapshot(key,data);console.log(`${table}: ${data.length} rows cached`);
  }
  console.log(JSON.stringify(await updateUnitLoadoutHistory(store,createSource(store),{cachedOnly:true})));
}finally{store.close();}
