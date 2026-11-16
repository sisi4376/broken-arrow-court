import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore, member, rawMatch, detailFor } from './helpers.mjs';
import { zhanfanAnalysis } from '../src/zhanfan.mjs';
import { createCourt } from '../public/zhanfan.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=0)=>n==null?'—':Number(n).toFixed(d);
const ui=readOnly=>createCourt({S:{},esc,icon:()=>'',fmt,empty:()=>'',readOnly});
function fixture(t){
  const store=testStore(t);member(store,'A',[101]);member(store,'B',[102]);member(store,'C',[103]);
  const raw=rawMatch([101,102,103,201],{WinnerTeam:0,TotalPlayTimeInSec:1800});
  for(const p of Object.values(raw.Data))p.TeamId=p.Id===201?1:0;
  store.ingest('800',raw);store.saveDetail('800',detailFor(raw));
  return {store,data:zhanfanAnalysis(store,new URLSearchParams('court_min_games=1'))};
}
function withPenalties(data,values){
  const r=structuredClone(data.members.find(r=>r.member_id===1));
  r.components=r.components.map(c=>{
    const penalty=values[c.key]??c.prior;
    return {...c,penalty,points:(penalty-(c.center??0))*c.weight/100,change:(penalty-c.prior)*c.weight/100};
  });
  return r;
}
function render(data,r,readOnly=false){
  const court=ui(readOnly);
  return {table:court.courtView({...data,members:[r]}),panel:court.courtPanel({model:data.model,min_games:1,report:r})};
}

test('neutral baselines no longer make60% combat the primary penalty by default',t=>{
  const {data}=fixture(t),r=withPenalties(data,{});
  assert.equal(r.components.find(c=>c.key==='pressure').points,30);
  assert.equal(r.components.find(c=>c.key==='exchange').points,20);
  for(const readOnly of [false,true]){
    const html=render(data,r,readOnly);
    assert(html.table.includes('<td>无明显加刑项</td>'));assert(html.panel.includes('主要加刑（相对基线）：<b>无明显加刑项</b>'));
  }
});

test('the largest extra baseline contribution wins even when its absolute weighted points are smaller',t=>{
  const {data}=fixture(t),r=withPenalties(data,{pressure:52.5,exchange:65});
  assert(r.components[0].points>r.components[1].points);assert(r.components[0].change<r.components[1].change);
  for(const readOnly of [false,true]){
    const html=render(data,r,readOnly);
    assert(html.table.includes('<td>战损交换<div class="table-sub">较基线 +6.00 分</div></td>'));
    assert(html.panel.includes('主要加刑（相对基线）：<b>战损交换 +6.00分</b>'));
  }
});

test('below-neutral combat and trivial friendly fire do not fabricate a main offence',t=>{
  const {data}=fixture(t),r=withPenalties(data,{pressure:47.5,exchange:29.7,victory:35.2,discipline:2.9});
  const html=render(data,r);assert(html.table.includes('<td>无明显加刑项</td>'));assert(html.panel.includes('<b>无明显加刑项</b>'));
});

test('victory, food, friendly fire and combat can each be the main additional penalty',t=>{
  const {data}=fixture(t);
  for(const [values,name,points]of [
    [{victory:75},'共同胜负','10.00'],
    [{pressure:55,dependency:60},'净蹭队友补给','12.00'],
    [{discipline:50},'友伤约束','10.00'],
    [{unit_kd:25},'单位损耗附加','5.00'],
    [{pressure:55,exchange:52,victory:55},'战斗兑现','3.00'],
  ]){
    const html=render(data,withPenalties(data,values));
    assert(html.table.includes(`<td>${name}<div class="table-sub">较基线 +${points} 分</div></td>`),name);
    assert(html.panel.includes(`主要加刑（相对基线）：<b>${name} +${points}分</b>`),name);
  }
});

test('the1-point display threshold is inclusive, finite, stable on ties, and unknown stays unknown',t=>{
  const {store,data}=fixture(t);
  assert(render(data,withPenalties(data,{victory:52.5})).table.includes('<td>共同胜负<div class="table-sub">较基线 +1.00 分</div></td>'));
  assert(render(data,withPenalties(data,{victory:52.499})).table.includes('<td>无明显加刑项</td>'));
  const tied=withPenalties(data,{victory:55,discipline:10});assert(render(data,tied).panel.includes('<b>共同胜负 +2.00分</b>'));
  const invalid=withPenalties(data,{});invalid.components[0].change=NaN;invalid.components[1].change=Infinity;
  assert(render(data,invalid).table.includes('<td>无明显加刑项</td>'));
  const unknown=zhanfanAnalysis(store,new URLSearchParams('map=999'));
  assert(ui(false).courtView(unknown).includes('<td>待取证</td>'));
});

test('rendering attribution never changes scores, sentences, evidence, ranks or component ordering',t=>{
  const {store,data}=fixture(t),before=JSON.stringify(data);
  for(const readOnly of [false,true])for(const r of data.members)render(data,r,readOnly);
  assert.equal(JSON.stringify(data),before);
  assert.deepEqual(zhanfanAnalysis(store,new URLSearchParams('court_min_games=1')),data);
  const unsafe=withPenalties(data,{exchange:65});unsafe.components[1].name='<script>bad</script>';
  const html=render(data,unsafe);assert(html.table.includes('&lt;script&gt;'));assert(html.panel.includes('&lt;script&gt;'));assert(!html.table.includes('<script>'));
});
