import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, now } from '../src/db.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.cache/tests');
export function tempDir(t,beforeCleanup=null) {
  mkdirSync(root,{recursive:true}); const dir=mkdtempSync(path.join(root,'run-'));
  t.after(async()=>{await beforeCleanup?.();const resolved=path.resolve(dir);if(!resolved.startsWith(root+path.sep))throw new Error('Invalid cleanup target');rmSync(resolved,{recursive:true,force:true});});
  return dir;
}
export function testStore(t) {
  let store;const directory=tempDir(t,()=>store?.close());store=new Store(directory);return store;
}
export function member(store,name,players=[]) {
  const id=Number(store.run('INSERT INTO members(name,created_at) VALUES(?,?)',name,now()).lastInsertRowid);
  for(const playerId of players) store.run('INSERT INTO accounts(member_id,player_id,name,created_at,last_profile_sync) VALUES(?,?,?,?,?)',id,String(playerId),`Player ${playerId}`,now(),now());
  return id;
}
export function rawMatch(ids=[101,102,103,104],extra={}) {
  return {EndTime:1792050000,TotalPlayTimeInSec:1800,MapId:4,Type:1,VictoryLevel:70,Data:Object.fromEntries(ids.map((id,i)=>[String(id),{Id:id,Name:`Player ${id}`,...(i===3?{TeamId:1}:{}),OldRating:1500,NewRating:i===3?1480:1520,DestructionScore:1000+i*100,LossesScore:500,ObjectivesCaptured:i}])),...extra};
}
export function detailFor(raw) {
  return {data:{...raw,StartTime:raw.EndTime-raw.TotalPlayTimeInSec,TotalObjectiveZonesCount:10,Data:Object.fromEntries(Object.entries(raw.Data).map(([id,p])=>[id,{...p,DamageDealt:400,DamageReceived:100,TotalSpawnedUnitScore:1200,TotalRefundedUnitScore:100,TotalExp:2000,UnitData:{[`${id}01`]:{Id:238,OptionIds:[560,1634],SpawnTime:raw.EndTime-1700,DeathTime:raw.EndTime-300,TotalDamageDealt:25.5,TotalDamageReceived:12,KilledCount:3}}}]))},metadata:{mapName:'Coast'}};
}
export function flightPage(props) {
  return `<html><script>self.__next_f.push(${JSON.stringify([1,`20:${JSON.stringify(['$','$L1',null,props])}\n`])})</script></html>`;
}
