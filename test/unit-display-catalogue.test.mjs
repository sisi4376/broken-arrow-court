import test from 'node:test';
import assert from 'node:assert/strict';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
import {unitStats,matchDetail} from '../src/queries.mjs';
import {overallAnalysis,friendAnalysis} from '../src/analysis.mjs';
import {publicDisplayCatalogue} from '../src/unit-display-catalogue.mjs';

test('aggregate lists and profile highlights share current base names while historical match catalogues stay intact',t=>{
  const s=testStore(t);for(const id of [101,102,103])member(s,String(id),[id]);
  s.run('INSERT INTO unit_catalogue VALUES(?,?,?)','238',JSON.stringify({id:238,hudName:'Old name',cost:80,role:15}),'now');
  const raw=rawMatch();s.ingest('800',raw);s.saveDetail('800',detailFor(raw));
  const display=publicDisplayCatalogue({version_name:'1.2.1',private_token:'SECRET',units:{238:{id:238,hudName:'New name',cost:60,role:15,private_token:'SECRET'}}});
  assert(!JSON.stringify(display).includes('SECRET'));assert(!Object.hasOwn(display.units[238],'cost'));
  s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_display_catalogue',JSON.stringify(display),'now');
  assert.equal(matchDetail(s,'800').units[0].catalogue.hudName,'Old name');assert.equal(matchDetail(s,'800').units[0].catalogue.cost,80);
  const p=new URLSearchParams();assert.equal(unitStats(s,p)[0].catalogue.hudName,'New name');assert.equal(overallAnalysis(s,p).units[0].catalogue.hudName,'New name');
  assert.equal(friendAnalysis(s,1,p).unit_highlights.most_damage[0].catalogue.hudName,'New name');
});
