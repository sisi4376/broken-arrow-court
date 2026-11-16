import {gunzipSync} from 'node:zlib';
import {compileUnitLoadout,resolveUnitLoadout} from './unit-loadouts.mjs';

const KEY='unit_loadout_history';
function snapshots(store){
  const cached=new Map();
  for(const r of store.all("SELECT source_key,payload_gzip FROM source_snapshots WHERE source_key LIKE '/api/dek/%' OR source_key LIKE 'github:repos/JohnJinHM/BA-Units/%' ORDER BY id")){
    try{cached.set(r.source_key,JSON.parse(gunzipSync(r.payload_gzip)));}catch{}
  }
  return cached;
}
export function compileGameSupplements(tables,units,unknown,translations={},source={}){
  if(!['Options','Modifications','Units'].every(k=>Array.isArray(tables[k])))return [];
  const modifications=new Map(tables.Modifications.map(m=>[m.Id,m])),unitIds=new Set(tables.Units.map(u=>u.Id)),result=[];
  for(const o of tables.Options){
    if(!Number.isSafeInteger(o.Id)||!Number.isSafeInteger(o.ModificationId))continue;
    const m=modifications.get(o.ModificationId),u=units[m?.UnitId];
    if(!u||!unitIds.has(m.UnitId)||!unknown.get(String(m.UnitId))?.has(o.Id)||!u.slots.some(s=>s.id===m.Id)||u.slots.some(s=>s.options.some(x=>x.id===o.Id)))continue;
    const compiled=compileUnitLoadout({id:m.UnitId,cost:u.base_cost,modifications:[{id:m.Id,name:m.Name,uiName:m.UIName,options:[{id:o.Id,name:o.Name,uiName:o.UIName,cost:o.Cost}]}]},translations);
    result.push({unit_id:m.UnitId,slot_id:m.Id,option:compiled.slots[0].options[0],source_ref:source.ref??null});
  }
  return result;
}

export async function updateUnitLoadoutHistory(store,source,{force=false,cachedOnly=false,allowed=()=>true,onProgress=()=>{}}={}){
  const currentRow=store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadouts'");
  if(!currentRow)return {updated:0};
  const current=JSON.parse(currentRow.data_json),row=store.get('SELECT data_json FROM analysis_catalogue WHERE key=?',KEY);
  let history=row?JSON.parse(row.data_json):{catalogues:[],supplements:[]};
  const save=()=>store.run('INSERT INTO analysis_catalogue(key,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at',KEY,JSON.stringify(history),new Date().toISOString());
  const cached=snapshots(store),unknown=new Map(),needed=new Set();
  for(const r of store.all("SELECT DISTINCT unit_id,json_extract(raw_json,'$.OptionIds') options FROM unit_instances")){
    let ids;try{ids=JSON.parse(r.options);}catch{continue;}
    const u=current.units[r.unit_id];if(!u||!Array.isArray(ids))continue;
    if(resolveUnitLoadout(ids,u,current).resolution!=='complete')needed.add(r.unit_id);
    for(const id of ids)if(!u.slots.some(s=>s.options.some(o=>o.id===id))){if(!unknown.has(r.unit_id))unknown.set(r.unit_id,new Set());unknown.get(r.unit_id).add(id);}
  }
  const gameTables=new Map();let supplementsAdded=false;
  for(const [key,value] of cached)if(key.startsWith('github:')){
    const url=new URL('https://api.github.com/'+key.slice(7)),ref=url.searchParams.get('ref'),table=url.pathname.match(/\/tables\/(Options|Modifications|Units)\.json$/)?.[1];
    if(table&&/^[a-f0-9]{40}$/.test(ref??'')){if(!gameTables.has(ref))gameTables.set(ref,{});gameTables.get(ref)[table]=value;}
  }
  for(const [ref,tables] of gameTables){
    const found=compileGameSupplements(tables,current.units,unknown,current.translations,{ref:`https://github.com/JohnJinHM/BA-Units/blob/${ref}/output/tables/Options.json`});
    const added=found.filter(s=>!history.supplements.some(old=>old.unit_id===s.unit_id&&old.slot_id===s.slot_id&&old.option.id===s.option.id));
    if(added.length){history.supplements.push(...added);supplementsAdded=true;save();}
  }
  if(!needed.size)return {updated:0};
  if(!allowed())return {updated:0};
  if(!force&&!cachedOnly&&history.last_error_at&&Date.now()-Date.parse(history.last_error_at)<3600000)return {updated:0};
  if(!force&&!cachedOnly&&history.updated_at&&Date.now()-Date.parse(history.updated_at)<7*86400000&&[...needed].every(id=>history.covered_units?.includes(id)))return {updated:0};
  const read=async resource=>{
    if(!force&&cached.has(resource)&&(cachedOnly||resource!=='/api/dek/available-versions'))return cached.get(resource);
    const url=new URL(resource,'https://local'),batch=url.searchParams.get('unit_ids')?.split(',');
    if(!force&&batch)for(const [key,value] of cached){
      if(!key.startsWith(url.pathname+'?'))continue;
      const other=new URL(key,'https://local');if(other.searchParams.get('db_file')!==url.searchParams.get('db_file'))continue;
      if(url.pathname.endsWith('batch-modifications')&&batch.every(id=>Array.isArray(value.modifications?.[id])))return value;
      if(url.pathname.endsWith('/batch')&&batch.every(id=>value.units?.some(u=>String(u.id)===id)))return value;
    }
    if(cachedOnly)return null;return source.read(resource,{minDelay:5000,force});
  };
  let versions;
  try{
    versions=await read('/api/dek/available-versions');
    if(!versions&&cachedOnly)return {updated:0};
    if(!Array.isArray(versions?.versions))throw new Error('历史挂载目录版本列表不完整');
  }catch(error){history.last_error_at=new Date().toISOString();save();throw error;}
  let updated=0;
  const stable=versions.versions.filter(v=>v.isPublic&&!/PTE|test|beta/i.test(v.versionName??'')&&v.dbFileName!==current.db_file&&typeof v.dbFileName==='string');
  try{
    for(const version of stable){
      if(!allowed())break;
      const catalogue=history.catalogues.find(c=>c.db_file===version.dbFileName)??{db_file:version.dbFileName,name:version.versionName,units:{}};
      let changed=false;
      const ids=[...needed].filter(id=>force||!catalogue.checked_units?.includes(id)).sort((a,b)=>Number(a)-Number(b));
      for(let i=0;i<ids.length&&allowed();i+=50){
        const batch=ids.slice(i,i+50),params=new URLSearchParams({unit_ids:batch.join(','),db_file:version.dbFileName});
        const mods=await read('/api/dek/units/batch-modifications?'+params),base=await read('/api/dek/units/batch?'+params);
        if(!mods?.modifications||!Array.isArray(base?.units))continue;
        for(const id of batch){
          const unit=base.units.find(u=>String(u.id)===id),modifications=mods.modifications[id];
          if(!unit||!Array.isArray(modifications))continue;
          catalogue.units[id]=compileUnitLoadout({...unit,modifications},current.translations);changed=true;updated++;
        }
        const checked=batch.filter(id=>!base.units.some(u=>String(u.id)===id)||Array.isArray(mods.modifications[id]));
        catalogue.checked_units=[...new Set([...(catalogue.checked_units??[]),...checked])];changed||=checked.length>0;
      }
      if(changed){catalogue.updated_at=new Date().toISOString();history.catalogues=history.catalogues.filter(c=>c.db_file!==catalogue.db_file).concat(catalogue);save();onProgress({version:catalogue.name,units:Object.keys(catalogue.units).length});}
    }
    const covered=[...needed].filter(id=>stable.every(v=>history.catalogues.find(c=>c.db_file===v.dbFileName)?.checked_units?.includes(id)));
    if(updated||supplementsAdded||!history.updated_at||JSON.stringify(covered)!==JSON.stringify(history.covered_units))history.updated_at=new Date().toISOString();
    history.covered_units=covered;delete history.last_error_at;
  }catch(error){history.last_error_at=new Date().toISOString();throw error;}finally{save();}
  return {updated,versions:history.catalogues.length,supplements:history.supplements.length};
}
