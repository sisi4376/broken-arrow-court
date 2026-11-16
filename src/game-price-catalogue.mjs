import {compileUnitLoadout,LOADOUT_VERSION} from './unit-loadouts.mjs';

const validId=n=>Number.isSafeInteger(n)&&n>=0;
function index(rows,name){
  if(!Array.isArray(rows)||rows.some(r=>!validId(r.Id))||new Set(rows.map(r=>r.Id)).size!==rows.length)throw Error(`${name} 表 ID 缺失或重复`);
  return new Map(rows.map(r=>[r.Id,r]));
}
export function compileGamePriceCatalogue(tables,{versionName,buildId,sourceHash,validFrom,translations={}}={}){
  const units=index(tables.Units,'Units'),mods=index(tables.Modifications,'Modifications'),options=index(tables.Options,'Options');
  if(typeof versionName!=='string'||!/^\d+(\.\d+){2,3}$/.test(versionName)||!/^\d+$/.test(String(buildId))||!/^[a-f0-9]{64}$/.test(sourceHash??'')||!Number.isFinite(validFrom))throw Error('游戏版本、构建 ID、资源指纹或生效时间无效');
  const byUnit=new Map(),byMod=new Map();
  for(const m of mods.values()){
    if(!units.has(m.UnitId))throw Error(`槽位 ${m.Id} 指向缺失单位 ${m.UnitId}`);
    if(!byUnit.has(m.UnitId))byUnit.set(m.UnitId,[]);byUnit.get(m.UnitId).push(m);
  }
  for(const o of options.values()){
    if(!mods.has(o.ModificationId))throw Error(`挂载 ${o.Id} 指向缺失槽位 ${o.ModificationId}`);
    if(!byMod.has(o.ModificationId))byMod.set(o.ModificationId,[]);byMod.get(o.ModificationId).push(o);
  }
  const order=(a,b)=>(a.Order??a.Id)-(b.Order??b.Id)||a.Id-b.Id,result={};
  for(const u of units.values()){
    const modifications=(byUnit.get(u.Id)??[]).sort(order).map(m=>({id:m.Id,name:m.Name,uiName:m.UIName,
      options:(byMod.get(m.Id)??[]).sort(order).map(o=>({id:o.Id,name:o.Name,uiName:o.UIName,cost:o.Cost}))}));
    if(modifications.some(m=>!m.options.length))throw Error(`单位 ${u.Id} 存在空挂载槽`);
    result[u.Id]={...compileUnitLoadout({id:u.Id,cost:u.Cost,modifications},translations),
      catalogue:{id:u.Id,hudName:u.HUDName,name:u.Name,cost:u.Cost,categoryType:u.CategoryType,
        countryId:u.CountryId,role:u.Role,thumbnailFileName:u.ThumbnailFileName}};
  }
  return {version:LOADOUT_VERSION,version_name:versionName,db_file:`game-build-${buildId}`,price_source:'game_files',
    source_hash:sourceHash,build_id:String(buildId),valid_from:validFrom,units:result};
}

export function compareGamePriceCatalogue(before,after){
  const report={base_changes:[],option_changes:[],new_units:[],removed_units:[],new_options:[],removed_options:[],layout_changes:[]};
  for(const [id,u]of Object.entries(after.units)){
    const old=before.units[id];if(!old){report.new_units.push(Number(id));continue;}
    if(old.base_cost!==u.base_cost)report.base_changes.push({unit_id:Number(id),name:u.catalogue?.hudName??null,before:old.base_cost,after:u.base_cost});
    const oldOptions=new Map(old.slots.flatMap(s=>s.options.map(o=>[o.id,{...o,slot_id:s.id}])));
    const newOptions=new Map(u.slots.flatMap(s=>s.options.map(o=>[o.id,{...o,slot_id:s.id}])));
    for(const [oid,o]of newOptions){
      const p=oldOptions.get(oid);if(!p){report.new_options.push({unit_id:Number(id),option_id:oid});continue;}
      if(p.cost!==o.cost)report.option_changes.push({unit_id:Number(id),option_id:oid,name:o.key,before:p.cost,after:o.cost});
      if(p.slot_id!==o.slot_id||p.key!==o.key)report.layout_changes.push({unit_id:Number(id),option_id:oid,before_slot:p.slot_id,after_slot:o.slot_id,before_name:p.key,after_name:o.key});
    }
    for(const oid of oldOptions.keys())if(!newOptions.has(oid))report.removed_options.push({unit_id:Number(id),option_id:oid});
  }
  for(const id of Object.keys(before.units))if(!after.units[id])report.removed_units.push(Number(id));
  return report;
}
