import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { testStore, member, rawMatch } from './helpers.mjs';
import { CloudBackup } from '../src/cloud-backup.mjs';

function fakeGithub(options={}) {
  const calls=[],assets=[],tags=[];let manifest,viewCount=0;
  return { calls,tags,get manifest(){return manifest;},runner:async args=>{
    calls.push(args);
    if(args[0]==='repo')return JSON.stringify({isEmpty:options.empty===true});
    if(args[0]==='api'&&args[1]==='repos/owner/private')return JSON.stringify({private:options.private!==false,full_name:'owner/private'});
    if(args[0]==='api')return JSON.stringify([options.releases??[]]);
    if(args[1]==='create'){tags.push(args[2]);return '';}
    if(args[1]==='upload'){
      for(const f of args.slice(3,5)){const bytes=await readFile(f);assets.push({name:path.basename(f),size:bytes.length});
        if(f.endsWith('.json'))manifest=JSON.parse(bytes);
        else{const raw=gunzipSync(bytes);assert.equal(raw.subarray(0,15).toString(),'SQLite format 3');}
      }if(options.uploadTimeout)throw new Error('timeout after upload');return '';
    }
    if(args[1]==='view'){
      viewCount++;if(options.firstViewTimeout&&viewCount===1)throw new Error('view timeout');
      return JSON.stringify({assets:options.badAssets?[]:assets,isDraft:true,url:'https://github.com/owner/private/releases/tag/test'});
    }
    return '';
  }};
}
test('automatic private backup verifies an online snapshot, publishes draft only after upload, and skips until due',async t=>{
  const s=testStore(t);member(s,'A',[101]);s.ingest('800',rawMatch());
  const gh=fakeGithub(),b=new CloudBackup(s,{repository:'owner/private',runner:gh.runner});
  await b.tick();const status=await b.status();
  assert(status.last_success);assert.equal(status.last_error,null);assert.equal(gh.manifest.counts.matches,1);
  const manifest=gh.manifest;assert.equal(manifest.database.file,'court.sqlite.gz');assert.match(manifest.database.sha256,/^[a-f0-9]{64}$/);
  const actions=gh.calls.filter(a=>a[0]==='release').map(a=>a[1]);assert.deepEqual(actions,['create','upload','view','edit']);
  assert.equal(gh.calls.filter(a=>a[0]==='api'&&a[1]==='repos/owner/private').length,3);
  const count=gh.calls.length;await b.tick();assert.equal(gh.calls.length,count);
  assert(!(await readdir(s.directory)).some(n=>n.startsWith('cloud-backup-')||n==='cloud-backup.lock'));
});
test('public destinations are rejected before any backup bytes are uploaded, with retry backoff and visible failure',async t=>{
  const s=testStore(t),gh=fakeGithub({private:false}),b=new CloudBackup(s,{repository:'owner/private',runner:gh.runner});
  await assert.rejects(b.tick(),/私有仓库/);assert(!gh.calls.some(a=>a[0]==='release'));
  const status=await b.status();assert.match(status.last_error,/私有仓库/);assert(status.next_retry);assert.equal(status.last_success,null);
  const count=gh.calls.length;await b.tick();assert.equal(gh.calls.length,count);
  await assert.rejects(b.tick({force:true}),/私有仓库/);assert(gh.calls.length>count);
});
test('incomplete remote attachments never become completed backups or prune any history',async t=>{
  const s=testStore(t),gh=fakeGithub({badAssets:true}),b=new CloudBackup(s,{repository:'owner/private',runner:gh.runner});
  await assert.rejects(b.tick(),/核验失败/);
  assert(!gh.calls.some(a=>a[0]==='release'&&['edit','delete'].includes(a[1])));
  assert.equal((await b.status()).last_success,null);
});
test('concurrent backup requests share one operation and an unconfigured backup makes no network calls',async t=>{
  const s=testStore(t),gh=fakeGithub(),b=new CloudBackup(s,{repository:'owner/private',runner:gh.runner});
  await Promise.all([b.tick(),b.tick({force:true})]);assert.equal(gh.tags.length,1);
  const off=new CloudBackup(s,{runner:()=>{throw new Error('network');}});await off.tick();assert.equal((await off.status()).enabled,false);
  assert.throws(()=>new CloudBackup(s,{repository:'https://token@github.com/owner/private'}));
});

test('ambiguous upload timeouts recover using actual remote attachments and initialize an empty private repository',async t=>{
  const s=testStore(t),gh=fakeGithub({uploadTimeout:true,empty:true}),b=new CloudBackup(s,{repository:'owner/private',runner:gh.runner});
  await b.tick();assert((await b.status()).last_success);
  assert(gh.calls.some(a=>a[0]==='api'&&a.includes('repos/owner/private/contents/README.md')));
  assert.equal(gh.tags.length,1);
});

test('a retry resumes an already uploaded draft instead of transmitting another full database',async t=>{
  const s=testStore(t),gh=fakeGithub({firstViewTimeout:true}),b=new CloudBackup(s,{repository:'owner/private',runner:gh.runner});
  await assert.rejects(b.tick(),/view timeout/);assert((await b.state()).pending);
  await b.tick({force:true});assert((await b.status()).last_success);
  assert.equal(gh.calls.filter(a=>a[1]==='upload').length,1);assert.equal((await b.state()).pending,undefined);
});
