import test from 'node:test';
import assert from 'node:assert/strict';
import {matchGameVersion} from '../public/match-version.js';

const match=(start,end)=>({end_time:Date.parse(end)/1000,duration:(Date.parse(end)-Date.parse(start))/1000});
test('game version follows official live releases rather than the price directory label',()=>{
  for(const [day,version]of [['2026-07-18','1.1.0.4'],['2026-08-01','1.1.1'],['2026-08-08','1.1.1.1'],['2026-08-15','1.1.1.2'],['2026-08-25','1.1.2'],['2026-09-01','1.2.0'],['2026-09-05','1.2.0.1'],['2026-09-10','1.2.0.2'],['2026-10-19','1.2.0.3'],['2026-10-21','1.2.1']]){
    assert.equal(matchGameVersion(match(day+'T15:00:00Z',day+'T15:30:00Z')),version);
  }
});
test('missing times, maintenance, untimed hotfix days and matches spanning versions remain unconfirmed',()=>{
  for(const m of [{},{end_time:1792050000},{end_time:Infinity,duration:100},match('2026-06-01T10:00:00Z','2026-06-01T11:00:00Z'),match('2026-10-20T10:30:00Z','2026-10-20T14:30:00Z'),match('2026-10-20T11:30:00Z','2026-10-20T12:00:00Z'),match('2026-09-07T18:00:00Z','2026-09-07T18:30:00Z')])assert.equal(matchGameVersion(m),null);
  const m=match('2026-10-21T15:00:00Z','2026-10-21T15:30:00Z');
  assert.equal(matchGameVersion({...m,detail:{data:{StartTime:Date.parse('2026-10-20T10:00:00Z')/1000}}}),null);
});
