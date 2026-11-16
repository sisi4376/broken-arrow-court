import {gunzipSync} from 'node:zlib';
import {compileUnitLoadout,LOADOUT_VERSION} from './unit-loadouts.mjs';

function saveHistory(store,history){
  store.run("INSERT INTO analysis_catalogue VALUES('unit_loadout_history',?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",JSON.stringify(history),new Date().toISOString());
}
export function archiveLoadoutCatalogue(store,model){
  if(!model.db_file||!Object.keys(model.units??{}).length)return;
  const row=store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'");
  const history=row?JSON.parse(row.data_json):{catalogues:[],supplements:[]};
  const previous=history.catalogues?.find(c=>c.db_file===model.db_file);
  const archived={...previous,db_file:model.db_file,name:model.version_name??previous?.name??model.db_file,
    units:{...previous?.units,...model.units},updated_at:model.updated_at};
  history.catalogues=(history.catalogues??[]).filter(c=>c.db_file!==model.db_file).concat(archived);
  saveHistory(store,history);
}

function refreshBoundCatalogue(store,model){
  const row=store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'");
  if(!row)return;
  const history=JSON.parse(row.data_json);
  // Only an exact release match can replace provisional prices. A future
  // release must be given its own time interval, never overwrite this one.
  const c=history.price_catalogues?.find(c=>c.version_name===model.version_name&&c.price_source==='official_patch');
  if(!c||model.version_name!=='1.2.1')return;
  for(const [id,u]of Object.entries(model.units))c.units[id]={...u,price_source:'catalogue'};
  c.upstream_db_file=model.db_file;c.updated_at=model.updated_at;
  saveHistory(store,history);
}

export async function updateUnitLoadouts(store,source,{force=false,cachedOnly=false,translations,allowed=()=>true,onProgress=()=>{}}={}){
  const row=store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadouts'");
  let model=row?JSON.parse(row.data_json):{version:LOADOUT_VERSION,units:{}};
  const names=translations??model.translations??{};
  const ids=store.all("SELECT DISTINCT unit_id FROM unit_instances WHERE unit_id!='' ORDER BY CAST(unit_id AS INTEGER)").map(r=>r.unit_id);
  if(!allowed())return {updated:0,total:Object.keys(model.units).length};
  if(!cachedOnly&&!force&&model.last_error_at&&Date.now()-Date.parse(model.last_error_at)<3600000)return {updated:0,total:Object.keys(model.units).length};
  const stale=!model.updated_at||Date.now()-Date.parse(model.updated_at)>7*86400000;
  const checkVersion=!model.version_checked_at||Date.now()-Date.parse(model.version_checked_at)>6*3600000;
  if(!force&&!stale&&!translations&&!checkVersion&&ids.every(id=>model.units[id]))return {updated:0,total:Object.keys(model.units).length};
  let version;
  try{
    version=cachedOnly?{dbFileName:model.db_file,versionName:model.version_name}:await source.read('/api/dek/db-version',{minDelay:5000,force});
    if(typeof version.dbFileName!=='string'||!version.dbFileName)throw new Error('单位挂载目录版本缺失');
  }catch(error){
    if(!cachedOnly){model.last_error_at=new Date().toISOString();store.run("INSERT INTO analysis_catalogue(key,data_json,updated_at) VALUES('unit_loadouts',?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",JSON.stringify(model),new Date().toISOString());}
    throw error;
  }
  const changed=model.db_file!==version.dbFileName||model.version!==LOADOUT_VERSION;
  if(changed){archiveLoadoutCatalogue(store,model);model={version:LOADOUT_VERSION,units:{}};}
  model={...model,db_file:version.dbFileName,version_name:version.versionName??model.version_name,translations:names,
    ...(!cachedOnly?{version_checked_at:new Date().toISOString()}:{})};
  const cached=new Map();
  if(!force)for(const r of store.all("SELECT source_key,payload_gzip FROM source_snapshots WHERE source_key LIKE '/api/units/full?%' ORDER BY id")){
    const params=new URL(r.source_key,'https://local').searchParams;
    if(params.get('db_file')===version.dbFileName){try{cached.set(params.get('unitid'),JSON.parse(gunzipSync(r.payload_gzip)).unit);}catch{}}
  }
  let updated=0;
  const save=()=>{
    store.run("INSERT INTO analysis_catalogue(key,data_json,updated_at) VALUES('unit_loadouts',?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",JSON.stringify(model),new Date().toISOString());
    if(changed||model.version_name==='1.2.1')refreshBoundCatalogue(store,model);
  };
  try{
    // Consume already archived responses before making any new network requests.
    for(const unitId of [...ids].sort((a,b)=>Number(cached.has(b))-Number(cached.has(a)))){
      if(!allowed())break;
      if(!force&&model.units[unitId]&&!stale&&!translations)continue;
      if(cachedOnly&&!cached.has(unitId))continue;
      const unit=cached.get(unitId)??(await source.read('/api/units/full?'+new URLSearchParams({unitid:unitId,db_file:version.dbFileName}),{minDelay:5000,force})).unit;
      if(String(unit?.id)!==unitId)throw new Error('单位挂载目录 ID 不匹配');
      model.units[unitId]=compileUnitLoadout(unit,names);model.updated_at=new Date().toISOString();updated++;
      save();onProgress({unit_id:unitId,updated,total:ids.length});
    }
    if(!cachedOnly)delete model.last_error_at;
  }catch(error){model.last_error_at=new Date().toISOString();throw error;}finally{save();}
  return {updated,total:Object.keys(model.units).length};
}
