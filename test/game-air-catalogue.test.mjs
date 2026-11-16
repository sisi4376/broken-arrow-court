import test from 'node:test';
import assert from 'node:assert/strict';
import {compileGameAirCatalogue} from '../src/game-air-catalogue.mjs';
import {classifyAirLoadout} from '../src/air-superiority.mjs';

const tables=()=>({Units:[{Id:1,HUDName:'Test plane',Role:164}],Modifications:[{Id:2,UnitId:1,Name:'Pylon'}],
  Options:[{Id:3,ModificationId:2,UIName:'AAM',Turret0Id:0,Turret1Id:11},{Id:4,ModificationId:2,UIName:'Bomb',Turret1Id:12},{Id:5,ModificationId:2,UIName:'Empty',Turret1Id:13}],
  Turrets:[{Id:10,IsDefault:true},{Id:11,IsDefault:false},{Id:12,IsDefault:false},{Id:13,IsDefault:false}],
  TurretUnits:[{Id:20,UnitId:1,TurretId:10},{Id:21,UnitId:1,TurretId:11}],
  TurretWeapons:[{Id:30,TurretId:10,WeaponId:40},{Id:31,TurretId:11,WeaponId:41},{Id:32,TurretId:12,WeaponId:42}],
  Weapons:[{Id:40,Type:116},{Id:41,Type:87},{Id:42,Type:160}],
  WeaponAmmunitions:[{Id:50,UnitId:1,WeaponId:40,Quantity:100},{Id:51,UnitId:1,WeaponId:41,Quantity:2},{Id:52,UnitId:1,WeaponId:42,Quantity:1},{Id:53,UnitId:99,WeaponId:41,Quantity:99}]});

test('original weapon tables join by unit/turret/weapon IDs, distinguish empty pylons and skip zero sentinel IDs',()=>{
  const t=tables(),before=JSON.stringify(t),model=compileGameAirCatalogue(t,{versionName:'1.2.1',buildId:'test',validFrom:100}),plane=model.units[1];
  assert.deepEqual(plane.base_turrets,[10]);assert.deepEqual(model.roles,{1:164});
  assert.equal(classifyAirLoadout({OptionIds:[3]},plane).status,'eligible');
  for(const id of [4,5])assert.equal(classifyAirLoadout({OptionIds:[id]},plane).status,'not_eligible');
  assert.equal(JSON.stringify(t),before);
  t.WeaponAmmunitions.find(a=>a.Id===51).Quantity=0;
  assert.equal(classifyAirLoadout({OptionIds:[3]},compileGameAirCatalogue(t).units[1]).status,'not_eligible');
});
test('missing referenced turrets/weapons and malformed rows cannot produce a guessed game catalogue',()=>{
  let t=tables();t.Turrets=t.Turrets.filter(x=>x.Id!==12);assert.throws(()=>compileGameAirCatalogue(t),/缺少炮塔/);
  t=tables();t.Weapons=[];assert.throws(()=>compileGameAirCatalogue(t),/缺少武器/);
  t=tables();t.Units.push({...t.Units[0]});assert.throws(()=>compileGameAirCatalogue(t),/重复/);
});
