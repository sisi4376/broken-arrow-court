import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const directory=path.resolve(root,process.env.DATA_DIR||'data');
const stateFile=path.join(directory,'service.json');
async function state(){try{return JSON.parse(await readFile(stateFile,'utf8'));}catch{return null;}}
async function healthy(record){if(!record)return false;try{return(await fetch(`${record.url}/api/health`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}}
const command=process.argv[2]||'start';
function report(record,status){console.log(process.argv.includes('--json')?JSON.stringify({url:record.url,status}):`${status}: ${record.url}`);}
let record=await state();
if(command==='start'){
  if(await healthy(record)){report(record,'Already running');process.exit(0);}
  await mkdir(directory,{recursive:true});
  const out=openSync(path.join(directory,'server.log'),'a');const err=openSync(path.join(directory,'server-error.log'),'a');
  const child=spawn(process.execPath,[`--env-file-if-exists=${path.join(root,'.env')}`,path.join(root,'src/server.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  child.on('error',(error)=>{console.error(error.message);process.exitCode=1;});child.unref();closeSync(out);closeSync(err);
  for(let i=0;i<24;i++){await sleep(500);record=await state();if(await healthy(record)){report(record,'Running');process.exit(0);}}
  console.error(`Startup failed. See ${path.join(directory,'server-error.log')}`);process.exitCode=1;
}else if(command==='stop'){
  if(!(await healthy(record))){console.log('Service is not running.');process.exit(0);}
  const response=await fetch(`${record.url}/api/service/stop`,{method:'POST',headers:{'X-Service-Token':record.shutdown_token},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error(`Stop failed (${response.status})`);
  for(let i=0;i<100;i++){await sleep(1000);if(!(await healthy(record))){console.log('Stopped.');process.exit(0);}}
  console.log('Shutdown requested; finishing the current source request.');
}else if(command==='status'){
  console.log(await healthy(record)?`Running: ${record.url}`:'Service is not running.');
}else throw new Error('Usage: node scripts/service.mjs [start|stop|status]');
