import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MEDALS,medalIds,renderMedals} from '../public/medals.js';
import {publicMatch,STATIC_SOURCES} from '../src/static-export.mjs';
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('medals use original game names in tooltips and accessible labels',()=>{
  const expected={0:'高效作战',1:'区域控制',6:'毁灭之王',7:'生存专家',10:'钢铁洪流',16:'天神下凡',23:'运输大队长',24:'草船借箭',25:'等级不是问题！',28:'空突利刃'};
  for(const [id,name] of Object.entries(expected)){
    const medal=MEDALS.find(m=>m.id===Number(id));assert.equal(medal.name,name);
    const html=renderMedals([Number(id)],{esc,icon:()=>''});
    assert(html.includes(`aria-label="${name}"`));assert(html.includes(`title="${name} · ${medal.english}"`));
  }
  for(const medal of MEDALS){assert(medal.localization_key.startsWith('ui_'));assert.equal(medal.name,medal.name.trim());}
});

test('medals preserve zero IDs and archived array objects, rejecting malformed values and unsafe paths',()=>{
  assert.deepEqual(medalIds([0,6,25,-1,'1',null,Infinity]),[0,6,25]);
  assert.deepEqual(medalIds({0:0,1:6}),[0,6]);assert.deepEqual(medalIds({secret:99}),[]);
  const html=renderMedals([0,25,999],{esc,icon:()=>'<i></i>'});
  assert(html.includes('medalKdIcon.png'));assert(html.includes('medalUnderdogsIcon.png'));assert(html.includes('未识别奖章 #999'));
  assert.equal(renderMedals([],{esc,icon:()=>''}),'');assert.equal(renderMedals(null,{esc,icon:()=>''}),'');
  const match=publicMatch({raw:{},detail:null,participants:[{raw:{Medals:[0,6,25]}}],units:[]});
  assert.deepEqual(medalIds(match.participants[0].raw.Medals),[0,6,25]);
});
test('all known medal icons are small local PNGs shipped with the static website',async()=>{
  assert.equal(new Set(MEDALS.map(m=>m.id)).size,30);
  for(const m of MEDALS){
    assert(/^[A-Za-z0-9_-]+\.png$/.test(m.file));const file=STATIC_SOURCES['medal-icon-'+m.file];assert(file);
    const bytes=await readFile(file);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),64);assert.equal(bytes.readUInt32BE(20),64);assert(bytes.length<30000);
  }
});
