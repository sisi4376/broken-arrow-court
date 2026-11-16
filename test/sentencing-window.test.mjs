import test from 'node:test';
import assert from 'node:assert/strict';
import {sentencingWindow} from '../src/queries.mjs';
import {zhanfanAnalysis} from '../src/zhanfan.mjs';
import {friendAnalysis} from '../src/analysis.mjs';
import {createCourt} from '../public/zhanfan.js';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
const p=o=>new URLSearchParams(o),at=Date.parse('2026-11-15T12:00:00+08:00');

test('sentencing requires a 30-day window including combined custom filters, but all-time needs no registration age',()=>{
  for(const params of [{days:7},{days:29},{from:'2026-10-01',to:'2026-10-29'},{days:30,from:'2026-11-01'},{from:'2026-11-01',to:'2027-01-01'},{from:'2026-02-31'},{from:'bad'}])assert.equal(sentencingWindow(p(params),at).eligible,false,JSON.stringify(params));
  for(const params of [{},{days:30},{days:90},{days:365},{from:'2026-10-01',to:'2026-10-30'},{days:'custom',from:'2026-10-01',to:'2026-10-30'}])assert.equal(sentencingWindow(p(params),at).eligible,true,JSON.stringify(params));
});

test('short ranges never expose a personal sentence or rank, and normal court scoring stays unchanged',t=>{
  const s=testStore(t);for(const [name,id]of [['A',101],['B',102],['C',103]])member(s,name,[id]);
  const raw=rawMatch(undefined,{EndTime:Math.floor(Date.now()/1000)-3600});s.ingest('800',raw);s.saveDetail('800',detailFor(raw));
  const normal=zhanfanAnalysis(s,p({court_min_games:1}));assert(normal.ranked>0);
  const short=zhanfanAnalysis(s,p({days:7,court_min_games:1}));assert.equal(short.ranked,0);assert.equal(short.sentencing_window.eligible,false);
  for(const r of short.members){assert.equal(r.sentence_months,null);assert.equal(r.sensitivity,null);assert.equal(r.rank,null);assert.equal(r.eligible,false);}
  const personal=friendAnalysis(s,1,p({days:7,court_min_games:1}));assert.equal(personal.court.sentencing_window.eligible,false);
  const {courtPanel,courtView}=createCourt({S:{},esc:String,icon:()=>'',fmt:String,empty:(title,description)=>title+description});
  assert.match(courtPanel(personal.court),/暂不判刑/);assert.match(courtView(short),/统计范围不足30天/);
  assert(!courtPanel(personal.court).includes('有期徒刑'));
  assert.equal(zhanfanAnalysis(s,p({days:30,court_min_games:1})).members[0].score,normal.members[0].score);
});
