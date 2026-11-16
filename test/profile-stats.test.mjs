import test from 'node:test';
import assert from 'node:assert/strict';
import {testStore,member,rawMatch,detailFor} from './helpers.mjs';
import {localProfile,profileCalibration,profileCalibrationDays} from '../src/profile-stats.mjs';

const stamp='2026-10-20T00:00:00.000Z',ended=Date.parse('2026-10-21T00:00:00Z')/1000;
function baseline(s,stat={}){
  s.saveProfile('101',{info:{id:101,name:'A',rating:1500,rank:40,level:10},last_fights_data:['800'],statInfo:{fightsCountRt:100,winCountRt:60,lossCountRt:40,updatedAt:'$D'+stamp,...stat}});
  s.run('UPDATE profiles SET updated_at=?',stamp);
}
const view=s=>localProfile(s,s.get('SELECT * FROM accounts WHERE player_id=?','101'));

test('local lifetime projection adds only new unique matches and retains the upstream baseline',t=>{
  const s=testStore(t);member(s,'A',[101]);baseline(s);
  const raw=rawMatch(undefined,{Type:0,EndTime:ended}),detail=detailFor(raw);
  Object.assign(detail.data.Data['101'],{Destruction:7,Losses:3,SupplyPointsConsumed:100,SupplyPointsConsumedByAllies:40,SupplyPointsConsumedFromAllies:20,DestructionScore:900,LossesScore:300});
  s.ingest('901',raw,1);s.saveDetail('901',detail);
  let p=view(s);assert.equal(p.data.statInfo.fightsCountRt,101);assert.equal(p.data.statInfo.winCountRt,61);
  assert.equal(p.data.statInfo.unitsKilledCountRt,7);assert.equal(p.data.statInfo.supplyPtsConsumed,100);
  assert.equal(p.data.info.rating,1520);assert.equal(p.data.info.level,10);assert.equal(p.data.info.rank,40);
  s.ingest('901',raw,1);s.saveDetail('901',detail);p=view(s);
  assert.equal(p.data.statInfo.fightsCountRt,101);assert.equal(p.data.statInfo.supplyPtsConsumed,100);assert.equal(p.local_update.matches,1);
  assert.equal(JSON.parse(s.get('SELECT data_json FROM profiles').data_json).statInfo.fightsCountRt,100);
});

test('late imports and baseline ID overlap never add old games to lifetime twice',t=>{
  const s=testStore(t);member(s,'A',[101]);baseline(s);
  for(const [id,time] of [['800',ended],['801',ended-2*86400]])s.ingest(id,rawMatch(undefined,{Type:0,EndTime:time}),1);
  assert.equal(view(s).data.statInfo.fightsCountRt,100);assert.equal(view(s).local_update.matches,0);
});

test('missing detail remains partial then fills once, and recalibration replaces the whole baseline',t=>{
  const s=testStore(t);member(s,'A',[101]);baseline(s);
  const raw=rawMatch(undefined,{Type:0,EndTime:ended});s.ingest('901',raw,1);
  let p=view(s);assert.equal(p.data.statInfo.fightsCountRt,101);assert.equal(p.data.statInfo.winCountRt,60);assert.equal(p.local_update.missing_details,1);
  s.saveDetail('901',detailFor(raw));p=view(s);assert.equal(p.data.statInfo.winCountRt,61);assert.equal(p.local_update.missing_details,0);
  s.saveProfile('101',{info:{id:101,name:'A'},last_fights_data:['901','800'],statInfo:{fightsCountRt:101,winCountRt:61,updatedAt:'$D2026-10-22T00:00:00Z'}});
  assert.equal(view(s).data.statInfo.fightsCountRt,101);assert.equal(view(s).local_update.matches,0);
});

test('mode groups and deserters are separate and a missing baseline is explicitly local-only',t=>{
  const s=testStore(t);member(s,'A',[101]);
  for(const [id,type] of [['901',0],['902',1],['903',3]]){
    const raw=rawMatch(undefined,{Type:type,EndTime:ended});s.ingest(id,raw,1);const d=detailFor(raw);d.data.Data['101'].Deserter=true;s.saveDetail(id,d);
  }
  const p=view(s);assert.equal(p.local_update.baseline_available,false);
  for(const key of ['Rt','Ct','Sk']){assert.equal(p.data.statInfo['fightsCount'+key],1);assert.equal(p.data.statInfo['leaveCount'+key],1);assert.equal(p.data.statInfo['winCount'+key],undefined);}
});

test('calibration is staggered from seven to ten days and is not due before its deadline',t=>{
  const s=testStore(t);member(s,'A',[101]);baseline(s);
  assert.deepEqual(['100','101','102','103'].map(profileCalibrationDays),[7,8,9,10]);
  const next=Date.parse(stamp)+8*86400000;
  assert.equal(profileCalibration(s,'101',next-1).due,false);assert.equal(profileCalibration(s,'101',next).due,true);
  s.run('UPDATE profiles SET updated_at=?',new Date(next).toISOString());
  assert.equal(profileCalibration(s,'101',next).last_at,stamp);assert.equal(profileCalibration(s,'101',next).due,true);
});
