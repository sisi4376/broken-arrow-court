import test from 'node:test';
import assert from 'node:assert/strict';
import {unitNameResolver} from '../src/unit-name-catalogue.mjs';
import {compileIconVariants} from '../src/unit-icons.mjs';

test('variant names follow the match release when identical option IDs are renamed',()=>{
  const icons=name=>compileIconVariants({Units:[{Id:7,HUDName:'Base'}],Modifications:[{Id:1,UnitId:7}],Options:[{Id:11,ModificationId:1,ReplaceUnitName:name}]});
  const old=icons('Old variant'),next=icons('New variant'),data={unit_icon_variants:old,unit_loadout_history:{price_catalogues:[{db_file:'old',valid_until:200,icon_variants:old},{db_file:'new',valid_from:200,icon_variants:next}]}};
  const store={get(sql){const key=sql.match(/key='([^']+)'/)?.[1];return data[key]?{data_json:JSON.stringify(data[key])}:undefined;}};
  const resolve=unitNameResolver(store),row={unit_id:'7',option_ids:'[11]',duration:20};
  assert.equal(resolve({...row,end_time:150},{hudName:'Base'}),'Old variant');
  assert.equal(resolve({...row,end_time:250},{hudName:'Base'}),'New variant');
  assert.equal(resolve({...row,end_time:150},{hudName:'Base'}),'Old variant');
});
