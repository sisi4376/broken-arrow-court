import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, now } from '../src/db.mjs';
import {LOCAL_POLICY} from '../src/distribution.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.cache/tests');
export function tempDir(t,beforeCleanup=null) {
  mkdirSync(root,{recursive:true}); const dir=mkdtempSync(path.join(root,'run-'));
  t.after(async()=>{await beforeCleanup?.();const resolved=path.resolve(dir);if(!resolved.startsWith(root+path.sep))throw new Error('Invalid cleanup target');rmSync(resolved,{recursive:true,force:true});});
  return dir;
}
export function testStore(t,options={policy:LOCAL_POLICY}) {
  let store;const directory=tempDir(t,()=>store?.close());store=new Store(directory,options);return store;
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

export function selfDestructionPrices(store){
  const unit={id:238,base_cost:100,catalogue:{id:238,hudName:'Fixture armored unit'},slots:[
    {id:1,name:'武器',options:[{id:560,key:'Cannon',name:'主炮',cost:10}]},
    {id:2,name:'装甲',options:[{id:1634,key:'Armor',name:'标准装甲',cost:0}]},
  ]};
  const model={version:'unit-loadouts-v1',version_name:'fixture',units:{238:unit}};
  for(const [key,value]of [['unit_loadouts',model],['unit_loadout_history',{price_catalogues:[model]}]])
    store.run('INSERT OR REPLACE INTO analysis_catalogue VALUES(?,?,?)',key,JSON.stringify(value),'now');
}

export function airUnit(id=900) {
  const turret=(id,type,isDefault=false,quantity=1)=>({turret:{id,isDefault,weapons:type===null?[]:[{weapon:{type,ammunition:[{quantity}]}}]}});
  const option=(id,name,turret,slot=1)=>({id,name,uiName:name,isDefault:id===100||id===200,replaceUnitId:0,[`turret${slot}Id`]:turret});
  return {id,hudName:'Fixture multirole',role:164,turrets:[turret(1,116,true),turret(2,87,true),turret(3,160),turret(4,null),turret(5,84),turret(6,88,false,0)],
    modifications:[{id:10,name:'Wing',options:[option(100,'AAM',2),option(101,'Bomb',3),option(102,'Empty',4),option(103,'ARM',5),option(104,'No ammunition',6)]},
      {id:11,name:'Fuselage',options:[option(200,'Fuel and ECM',4,2),option(201,'Bomb',3,2),{...option(202,'Replacement',4,2),replaceUnitId:999}]}]};
}
