import test from 'node:test';
import assert from 'node:assert/strict';
import {compileGamePriceCatalogue,compareGamePriceCatalogue} from '../src/game-price-catalogue.mjs';
import {resolveUnitLoadout,publicUnitLoadout} from '../src/unit-loadouts.mjs';
const source={versionName:'1.2.1',buildId:'26052592',sourceHash:'a'.repeat(64),validFrom:100};
const tables=()=>({Units:[{Id:1,Cost:55,HUDName:'Engineers',CategoryType:1,ThumbnailFileName:'US_TEST-Label'}],
  Modifications:[{Id:2,UnitId:1,Name:'Squad',Order:1}],Options:[{Id:3,ModificationId:2,Name:'6 men',Cost:0},{Id:4,ModificationId:2,Name:'7 men',Cost:5}]});
test('game prices join exact unit/slot/option IDs, preserve equipped prices, names and provenance without modifying source tables',()=>{
  const t=tables(),before=JSON.stringify(t),c=compileGamePriceCatalogue(t,source);
  for(const [ids,expected]of [[[3],55],[[4],60]]){
    const r=resolveUnitLoadout(ids,null,{unit_id:1,price_catalogue:c});assert.equal(r.cost,expected);assert.equal(r.price_source,'game_files');assert.equal(publicUnitLoadout(r).price_source,'game_files');
  }
  assert.equal(c.units[1].catalogue.hudName,'Engineers');assert.equal(c.source_hash,source.sourceHash);assert.equal(JSON.stringify(t),before);
  assert.equal(resolveUnitLoadout([],null,{unit_id:1,price_catalogue:c}).cost,null);
  assert.equal(resolveUnitLoadout([999],null,{unit_id:1,price_catalogue:c}).cost,null);
});
test('invalid provenance, duplicate IDs, orphan modifications/options and empty slots stop a game import',()=>{
  assert.throws(()=>compileGamePriceCatalogue(tables(),{...source,sourceHash:'unknown'}));
  let t=tables();t.Units.push({...t.Units[0]});assert.throws(()=>compileGamePriceCatalogue(t,source),/重复/);
  t=tables();t.Modifications[0].UnitId=999;assert.throws(()=>compileGamePriceCatalogue(t,source),/缺失单位/);
  t=tables();t.Options[0].ModificationId=999;assert.throws(()=>compileGamePriceCatalogue(t,source),/缺失槽位/);
  t=tables();t.Options=[];assert.throws(()=>compileGamePriceCatalogue(t,source),/空挂载槽/);
});
test('full catalogue comparison catches base, payload price, renamed same-ID loadouts, newly added and removed records',()=>{
  const old=compileGamePriceCatalogue(tables(),source),t=tables();t.Units[0].Cost=50;t.Options[0].Cost=10;t.Options[0].Name='New weapon';t.Options.pop();t.Options.push({Id:5,ModificationId:2,Name:'New',Cost:20});
  const r=compareGamePriceCatalogue(old,compileGamePriceCatalogue(t,source));
  assert.equal(r.base_changes.length,1);assert.equal(r.option_changes.length,1);assert.equal(r.layout_changes.length,1);assert.equal(r.new_options[0].option_id,5);assert.equal(r.removed_options[0].option_id,4);
});
