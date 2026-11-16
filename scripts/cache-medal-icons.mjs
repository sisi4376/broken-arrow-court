import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MEDALS} from '../public/medals.js';

const exec=promisify(execFile),api=async endpoint=>JSON.parse((await exec(process.env.GH_BIN||'gh',['api',endpoint],{windowsHide:true,timeout:90000,maxBuffer:2*1024*1024})).stdout);
const rows=await api('repos/eiaol/BATrace-IMG/contents/public/Medals'),files=new Map(rows.map(r=>[r.name,r]));
const directory='.cache/medal-icons/source';await mkdir(directory,{recursive:true});
const pending=[...MEDALS],result=[];
async function worker(){
  while(pending.length){
    const medal=pending.shift(),file=files.get(medal.file);if(!file)throw Error('Missing source medal: '+medal.file);
    const data=await api('repos/eiaol/BATrace-IMG/git/blobs/'+file.sha),bytes=Buffer.from(data.content??'','base64');
    const sha=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    if(data.encoding!=='base64'||bytes.length>1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||sha!==file.sha)throw Error('Invalid medal PNG: '+medal.file);
    await writeFile(directory+'/'+medal.file,bytes);result.push({file:medal.file,source_sha:sha,source_bytes:bytes.length});
  }
}
await Promise.all([worker(),worker(),worker()]);
await writeFile('.cache/medal-icons/manifest.json',JSON.stringify(result,null,2));console.log(JSON.stringify({downloaded:result.length,source_bytes:result.reduce((n,r)=>n+r.source_bytes,0)}));
