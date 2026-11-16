import {readdir,lstat,statfs} from 'node:fs/promises';
import path from 'node:path';
async function tree(directory){
  let bytes=0,files=0,skipped=0;const queue=[directory];
  while(queue.length){const entry=queue.pop();let stat;try{stat=await lstat(entry);}catch(error){if(error.code==='ENOENT')continue;skipped++;continue;}
    if(stat.isSymbolicLink()){skipped++;continue;}
    if(stat.isDirectory()){for(const child of await readdir(entry).catch(()=>[]))queue.push(path.join(entry,child));}
    else if(stat.isFile()){bytes+=stat.size;files++;}
  }return {bytes,files,skipped};
}
export async function localStorage(root,{data=path.join(root,'data'),site=path.join(root,'site')}={}){
  const entries=await readdir(root,{withFileTypes:true}).catch(()=>[]),groups=[];
  for(const entry of entries){const full=path.join(root,entry.name),value=await tree(full);groups.push({name:entry.name,...value});}
  const dataStats=await tree(data),siteStats=await tree(site),backups=await tree(path.join(data,'backups'));
  const databases=[];for(const name of ['court.sqlite','court.sqlite-wal','court.sqlite-shm']){const v=await tree(path.join(data,name));databases.push({name,...v});}
  let volume=null;try{const v=await statfs(root);volume={total_bytes:v.blocks*v.bsize,available_bytes:v.bavail*v.bsize};}catch{}
  return {checked_at:new Date().toISOString(),project_bytes:groups.reduce((n,g)=>n+g.bytes,0),data_bytes:dataStats.bytes,site_bytes:siteStats.bytes,backup_bytes:backups.bytes,database_bytes:databases.reduce((n,g)=>n+g.bytes,0),groups:groups.sort((a,b)=>b.bytes-a.bytes),databases,volume,note:'文件大小合计；跳过符号链接，不等同于文件系统实际分配的磁盘块。'};
}
