import test from 'node:test';
import assert from 'node:assert/strict';
import { compileIconVariants,resolveUnitIcon,resolveUnitName,iconName } from '../src/unit-icons.mjs';
import { testStore,member,rawMatch,detailFor } from './helpers.mjs';
import { matchDetail } from '../src/queries.mjs';
import { publicMatch } from '../src/static-export.mjs';

const tables={Units:[{Id:238,HUDName:'Base',ThumbnailFileName:'BASE'},{Id:239,HUDName:'Replacement',ThumbnailFileName:'REPLACED'},{Id:999,ThumbnailFileName:'FOREIGN'}],
  Modifications:[{Id:1,UnitId:238},{Id:2,UnitId:238},{Id:3,UnitId:999}],
  Options:[{Id:11,ModificationId:1},{Id:12,ModificationId:1,ThumbnailOverride:'OVERRIDE',ReplaceUnitName:'Variant'},
    {Id:13,ModificationId:1,ReplaceUnitId:239},{Id:14,ModificationId:1,ThumbnailOverride:'../secret'},
    {Id:21,ModificationId:2,ConcatenateWithUnitName:' Arena'},{Id:22,ModificationId:2,ThumbnailOverride:'OTHER',ReplaceUnitName:'Conflicting'},
    {Id:31,ModificationId:3,ThumbnailOverride:'FOREIGN_OVERRIDE'}]};

test('explicit thumbnail overrides and replacement units follow actual selected options, not defaults or foreign options',()=>{
  const model=compileIconVariants(tables,'pinned-game-source'),original=JSON.stringify(model);
  assert.equal(resolveUnitIcon([12,21],238,model),'OVERRIDE');
  assert.equal(resolveUnitIcon([21,13],238,model),'REPLACED');
  assert.equal(resolveUnitIcon([11,21],238,model),null);
  for(const options of [null,[12,12],[12,13],[12,22],[12,31],[12,999],['12',21],[14,21]])assert.equal(resolveUnitIcon(options,238,model),null,JSON.stringify(options));
  assert.equal(resolveUnitIcon([12],999,model),null);assert.equal(JSON.stringify(model),original);
  for(const value of ['../secret','x.png','https://x/x','a/b',null])assert.equal(iconName(value),null);
});

test('resolved variant icons survive public projection while unsafe paths never leave the whitelist',t=>{
  const s=testStore(t);member(s,'A',[101]);member(s,'B',[102]);member(s,'C',[103]);
  const raw=rawMatch();s.ingest('800',raw);const detail=detailFor(raw);
  for(const p of Object.values(detail.data.Data))for(const u of Object.values(p.UnitData))u.OptionIds=[12,21];
  s.saveDetail('800',detail);s.run('INSERT INTO analysis_catalogue VALUES(?,?,?)','unit_icon_variants',JSON.stringify(compileIconVariants(tables)),'now');
  const full=matchDetail(s,'800');assert(full.units.every(u=>u.icon==='OVERRIDE'));
  assert(full.units.every(u=>u.display_name==='Variant Arena'));
  assert(publicMatch(full).units.every(u=>u.icon==='OVERRIDE'));
  assert(publicMatch(full).units.every(u=>u.display_name==='Variant Arena'));
  full.units[0].icon='../secret';assert.equal(publicMatch(full).units[0].icon,null);
  full.units[0].display_name={private:'SECRET'};assert.equal(publicMatch(full).units[0].display_name,null);
});

test('actual loadout names replace and append in slot order, retain direct suffixes and do not guess missing choices',()=>{
  const model=compileIconVariants(tables);
  assert.equal(resolveUnitName([21,12],238,model),'Variant Arena');
  assert.equal(resolveUnitName([13,21],238,model),'Replacement Arena');
  assert.equal(resolveUnitName([11,21],238,model,'Base override'),'Base override Arena');
  for(const ids of [null,[],[12],[12,12],[12,13],[12,22],[12,31],[12,999],['12',21]])assert.equal(resolveUnitName(ids,238,model),null,JSON.stringify(ids));
  const attached=structuredClone(tables);attached.Options.find(o=>o.Id===21).ConcatenateWithUnitName='A1';
  assert.equal(resolveUnitName([21,11],238,compileIconVariants(attached),'M1'),'M1A1');
  const reordered=structuredClone(tables);reordered.Modifications[0].Order=2;reordered.Modifications[1].Order=1;
  assert.equal(resolveUnitName([12,21],238,compileIconVariants(reordered)),'Variant');
  attached.Options.find(o=>o.Id===21).ConcatenateWithUnitName=null;
  assert.equal(resolveUnitName([11,21],238,compileIconVariants(attached)),null);
  attached.Options.find(o=>o.Id===11).ReplaceUnitId=238;
  assert.equal(resolveUnitName([11,21],238,compileIconVariants(attached),'Local Base'),null);
});
