import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
import {friendAnalysis,personalMatches} from '../src/analysis.mjs';
import {dashboard} from '../src/queries.mjs';
import {zhanfanAnalysis} from '../src/zhanfan.mjs';
import {exportStatic,siteInventory} from '../src/static-export.mjs';

function fixture(t){
  const s=testStore(t);member(s,'A',[101,104]);member(s,'B',[102]);member(s,'C',[103]);
  const qualified=rawMatch([101,102,103]);s.ingest('800',qualified);s.saveDetail('800',detailFor(qualified));
  for(let i=0;i<25;i++)s.ingest(String(900+i),rawMatch([101,104,201],{Type:i===0?0:1,EndTime:1792050000+i*100}));
  s.ingest('999',rawMatch([102,201,202]));s.ingest('1000',rawMatch([201,202,203]));return s;
}
test('personal archive paginates registered alternate accounts as one match and separates noncourt records without altering sentencing',t=>{
  const s=fixture(t),before=dashboard(s,new URLSearchParams()),court=zhanfanAnalysis(s,new URLSearchParams());
  const a=personalMatches(s,1,new URLSearchParams('match_scope=other'));
  assert.deepEqual({...a.counts},{total:26,court:1,other:25});assert.equal(a.total,25);assert.equal(a.pages,2);assert.equal(a.items.length,20);assert.equal(a.items[0].accounts.length,2);assert.equal(a.items[0].friend_count,1);assert.equal(a.items[0].won,1);
  const second=personalMatches(s,1,new URLSearchParams('match_scope=other&match_page=2'));assert.equal(second.items.length,5);assert(!second.items.some(r=>a.items.some(x=>r.id===x.id)));
  assert.equal(personalMatches(s,1,new URLSearchParams('match_scope=other&match_page=1000')).page,2);
  assert.deepEqual(dashboard(s,new URLSearchParams()),before);assert.deepEqual(zhanfanAnalysis(s,new URLSearchParams()),court);
  const friend=friendAnalysis(s,1,new URLSearchParams('match_scope=other'));assert.equal(friend.overview.matches,1);assert.equal(friend.match_archive.total,25);assert.equal(friend.recent_matches.length,1);
});
test('personal filters cannot leak another member, ignore the court-only team gate and preserve mode/map/date and unknown outcomes',t=>{
  const s=fixture(t);const p=new URLSearchParams('match_scope=other&member=2&mode=0&team=same');
  const r=personalMatches(s,1,p);assert.equal(r.total,1);assert.equal(r.items[0].id,'900');
  assert.equal(personalMatches(s,1,new URLSearchParams('match_scope=other&map=999')).total,0);
  assert.equal(personalMatches(s,1,new URLSearchParams('match_scope=other&from=2030-01-01')).total,0);
  s.run('UPDATE participants SET team_id=1,won=0 WHERE match_id=? AND player_id=?','924','104');
  assert.equal(personalMatches(s,1,new URLSearchParams('match_scope=other')).items[0].won,null);
  s.run('UPDATE accounts SET active=0 WHERE player_id IN (?,?)','101','104');s.reclassify();assert.equal(personalMatches(s,1,new URLSearchParams('match_scope=other')).total,0);
});
test('read-only public personal archive and lazy match data match the local archive while unrelated matches remain excluded',async t=>{
  const s=fixture(t),dir=path.join(s.directory,'site');await exportStatic(s,{directory:dir});
  const inventory=await siteInventory(dir),module=inventory.files.find(f=>f.endsWith('/reader.mjs'));
  const {createReader}=await import(pathToFileURL(path.join(dir,module)).href),require=createRequire(import.meta.url),initSql=require('../vendor/sqljs/sql-wasm.js');
  const reader=createReader(new URL('https://public.example/court/'),{sqlite:()=>initSql({locateFile:file=>path.resolve('vendor/sqljs',file)}),fetcher:async url=>new Response(await readFile(path.join(dir,new URL(url).pathname.slice('/court/'.length))))});
  for(const query of ['match_scope=other','match_scope=other&match_page=2','match_scope=other&mode=0','match_scope=court']){
    const local=friendAnalysis(s,1,new URLSearchParams(query)),pub=await reader.request('/api/members/1/analysis?'+query);
    assert.deepEqual(JSON.parse(JSON.stringify(pub.match_archive)),JSON.parse(JSON.stringify(local.match_archive)));
    assert.deepEqual(JSON.parse(JSON.stringify(pub.court)),JSON.parse(JSON.stringify(local.court)));
  }
  assert.equal((await reader.request('/api/matches/900')).friend_count,1);
  await assert.rejects(reader.request('/api/matches/1000'),/不在公开档案/);
  await assert.rejects(reader.request('/api/members/1/analysis',{method:'POST'}),/不提供写入/);
});
