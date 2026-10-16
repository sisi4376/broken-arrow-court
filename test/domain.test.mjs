import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMatch,extractProfile,extractMatchDetail,extractImport,parseSearchQuery,parseMatchReference,numericId,MAPS,mapName } from '../src/domain.mjs';
import { rawMatch,detailFor,flightPage } from './helpers.mjs';

test('protobuf omitted scalar defaults correctly identify team 0 and winner 0',()=>{
  const match=normalizeMatch('800',rawMatch());
  assert.equal(match.winnerTeam,0);assert.equal(match.participants[0].teamId,0);assert.equal(match.participants[0].won,1);assert.equal(match.participants[3].won,0);assert.equal(match.mode,1);
});
test('winner team 1 and spectator are handled independently of rating changes',()=>{
  const raw=rawMatch([101,102,103],{WinnerTeam:1});raw.Data['102'].TeamId=1;raw.Data['103'].TeamId=100;
  const p=normalizeMatch('800',raw).participants;
  assert.equal(p[0].won,0);assert.equal(p[1].won,1);assert.equal(p[2].won,null);
});
test('unknown source formats preserve unknown team and unknown result',()=>{
  const n=normalizeMatch('800',{data:[{id:101,name:'Unknown'}]});assert.equal(n.participants[0].teamId,null);assert.equal(n.participants[0].won,null);assert.equal(n.mode,null);
});

test('verified map directory resolves known maps without inventing labels for unlisted IDs',()=>{
  assert.equal(Object.keys(MAPS).length,26);
  for(const [id,name]of [[3,'Baltiisk'],[5,'Airport'],[8,'Tallinn Harbour'],[11,'Central Village'],[12,'Oil refinery'],[22,'Ignalina Powerplant'],[24,'Kadaga'],[25,'Kadaga Military Base'],[26,'Daugavpils'],[27,'Daugavpils'],[28,'Coal Mountain']])assert.equal(mapName(id),name);
  assert.equal(mapName('999'),'未知地图 #999');assert.equal(mapName(null),'未知地图');
  assert.equal(mapName('__proto__'),'未知地图 #__proto__');
});

test('omitted protobuf mode defaults to normal mode zero, without altering explicit modes',()=>{
  const raw=rawMatch();delete raw.Type;assert.equal(normalizeMatch('800',raw).mode,0);
  for(const value of [0,1,2,3])assert.equal(normalizeMatch('800',{...raw,Type:value}).mode,value);
});
test('Flight parser reads nested server-rendered profile and full unit details without executing scripts',()=>{
  const p=extractProfile(flightPage({playerData:{info:{id:101},statInfo:{fightsCountRt:500}},matchMap:{800:rawMatch()}}));
  assert.equal(p.playerData.statInfo.fightsCountRt,500);assert.equal(Object.keys(p.matchMap).length,1);
  const d=extractMatchDetail(flightPage({initialMatchData:{matchInfo:detailFor(rawMatch()).data}}));
  assert.equal(d.data.Data['101'].UnitData['10101'].TotalDamageDealt,25.5);
  assert.throws(()=>extractProfile('<script>throw Error("must not execute")</script>'),/playerData/);
});
test('imports support match pages, pagination responses, maps, and archive exports',()=>{
  const raw=rawMatch();assert.equal(extractImport({matches:[{matchId:'800',data:raw}]}).matches.size,1);
  assert.equal(extractImport({matchMap:{800:raw}}).matches.size,1);
  assert.equal(extractImport({format:'broken-arrow-court-v1',matches:[{id:'800',raw}]}).matches.size,1);
  assert.throws(()=>extractImport({}),/没有可识别/);
});
test('search accepts Steam64 profile links without numeric precision loss',()=>{
  assert.equal(parseSearchQuery('https://steamcommunity.com/profiles/76561199052647384/'),'76561199052647384');
  assert.equal(parseSearchQuery('https://dash.batrace.top/player/214374'),'214374');
});

test('old match references accept IDs and BAtrace links without permitting arbitrary source URLs',()=>{
  assert.equal(parseMatchReference('6438487'),'6438487');
  assert.equal(parseMatchReference('https://dash.batrace.top/match/6438487?x=1'),'6438487');
  assert.throws(()=>parseMatchReference('https://unrelated.example/match/6438487'));
  assert.throws(()=>parseMatchReference('https://dash.batrace.top.attacker.test/match/6438487'));
  assert.throws(()=>numericId('-2'));
  const raw=rawMatch();delete raw.Data['101'].DestructionScore;delete raw.Data['101'].LossesScore;
  const p=normalizeMatch('800',raw).participants[0];assert.equal(p.destruction,0);assert.equal(p.losses,0);
});
