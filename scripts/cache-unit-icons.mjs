import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { compileIconVariants,iconName } from '../src/unit-icons.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const destination=path.join(root,'public','unit-icons');
const png=b=>b.length>8&&b.length<1024*1024&&b.subarray(0,8).toString('hex')==='89504e470d0a1a0a';
const api=async endpoint=>JSON.parse((await exec(process.env.GH_BIN||'gh',['api',endpoint],{windowsHide:true,timeout:90000,maxBuffer:24*1024*1024})).stdout);
const db=new DatabaseSync(path.resolve(root,process.env.DATA_DIR||'data','court.sqlite'));
const names=db.prepare("SELECT DISTINCT json_extract(c.data_json,'$.thumbnailFileName') name FROM unit_catalogue c JOIN unit_instances u ON u.unit_id=c.unit_id").all()
  .map(r=>r.name).filter(n=>typeof n==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(n)).sort();
const versions=new Map();
for(const row of db.prepare("SELECT source_key,payload_gzip FROM source_snapshots WHERE source_key LIKE 'github:%/tables/%' ORDER BY id").all()){
  const match=row.source_key.match(/^github:repos\/JohnJinHM\/BA-Units\/contents\/output\/tables\/(Options|Units|Modifications)\.json\?ref=([a-f0-9]{40})$/);if(!match)continue;
  try{const tables=versions.get(match[2])??{};tables[match[1]]=JSON.parse(gunzipSync(row.payload_gzip));versions.set(match[2],tables);}catch{}
}
const source=[...versions.entries()].findLast(([,tables])=>['Options','Units','Modifications'].every(key=>Array.isArray(tables[key])));
if(source){
  const model=compileIconVariants(source[1],`https://github.com/JohnJinHM/BA-Units/tree/${source[0]}/output/tables`),json=JSON.stringify(model);
  const previous=db.prepare("SELECT data_json FROM analysis_catalogue WHERE key='unit_icon_variants'").get();
  if(previous?.data_json!==json)db.prepare("INSERT INTO analysis_catalogue VALUES('unit_icon_variants',?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at").run(json,new Date().toISOString());
}
const row=db.prepare("SELECT data_json FROM analysis_catalogue WHERE key='unit_icon_variants'").get();
if(row)for(const unit of Object.values(JSON.parse(row.data_json).units??{}))for(const option of Object.values(unit.options??{})){
  const name=iconName(option.thumbnail);if(name&&!names.includes(name))names.push(name);
}
db.close();await mkdir(destination,{recursive:true});
const missing=[];
for(const name of names){try{if(png(await readFile(path.join(destination,name+'.png'))))continue;}catch{}missing.push(name);}
if(process.argv.includes('--offline')){console.log(JSON.stringify({catalogued:names.length,missing:missing.length}));process.exit(0);}
if(!missing.length){console.log(JSON.stringify({cached:names.length,downloaded:0}));process.exit(0);}
const tree=await api('repos/eiaol/BATrace-IMG/git/trees/main?recursive=1');
if(tree.truncated)throw new Error('图标目录不完整，停止下载');
const blobs=new Map(tree.tree.filter(t=>t.type==='blob'&&/^public\/Labels\/Icons\/[A-Za-z0-9_-]+\.png$/.test(t.path)).map(t=>[path.basename(t.path,'.png'),t.sha]));
let downloaded=0,unavailable=0,failed=0;
async function worker(){
  while(missing.length){
    const name=missing.shift(),sha=blobs.get(name);if(!sha){unavailable++;continue;}
    try{
      const data=await api('repos/eiaol/BATrace-IMG/git/blobs/'+sha),bytes=Buffer.from(data.content,'base64');
      const hash=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
      if(data.encoding!=='base64'||!png(bytes)||hash!==sha)throw new Error('图片校验失败');
      const file=path.join(destination,name+'.png');await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);downloaded++;
      if(downloaded%25===0)console.log(`Downloaded ${downloaded}; remaining ${missing.length}`);
    }catch{failed++;console.log('Unavailable: '+name);}
  }
}
await Promise.all([worker(),worker(),worker()]);
console.log(JSON.stringify({cached:names.length-unavailable-failed,downloaded,unavailable,failed}));
if(failed)process.exitCode=1;
