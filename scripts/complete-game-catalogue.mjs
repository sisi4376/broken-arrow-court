import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Store} from '../src/db.mjs';
import {compileGameAirCatalogue} from '../src/game-air-catalogue.mjs';
import {publicDisplayCatalogue} from '../src/unit-display-catalogue.mjs';
import {publicAirModel} from '../src/air-superiority.mjs';
import {LIVE_121_AT} from '../src/match-prices.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const folder=process.argv.find(a=>a.startsWith('--directory='))?.slice(12);
if(!folder)throw Error('请使用 --directory= 提供已验证的原始游戏表目录');
const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
if(manifest.build_id!=='26052592')throw Error('此导入仅针对已核实的 1.2.1 正式版构建 26052592');
const tables=Object.fromEntries(await Promise.all(['Units','Modifications','Options','Turrets','TurretUnits','TurretWeapons','Weapons','WeaponAmmunitions'].map(async name=>{
  const bytes=await readFile(path.join(folder,'tables',name+'.json'));
  if(createHash('sha256').update(bytes).digest('hex')!==manifest.table_sha256?.[name])throw Error(`${name} 表指纹不一致`);
  const rows=JSON.parse(bytes);if(rows.length!==manifest.row_counts[name])throw Error(`${name} 表条目数不一致`);return [name,rows];
})));
const store=new Store(process.env.DATA_DIR||'data');
try{
  const history=JSON.parse(store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);
  const prices=history.price_catalogues.find(c=>c.version_name==='1.2.1'&&c.price_source==='game_files');
  if(prices?.source_hash!==manifest.sha256)throw Error('需要先导入相同原始资源的 1.2.1 价格目录');
  const stamp=new Date().toISOString(),model=JSON.parse(store.get("SELECT data_json FROM analysis_catalogue WHERE key='air_superiority_model'")?.data_json??'{}');
  if(!Object.keys(model.units??{}).length)throw Error('缺少可冻结的旧版飞机挂载目录');
  const air=compileGameAirCatalogue(tables,{versionName:'1.2.1',buildId:manifest.build_id,validFrom:LIVE_121_AT});air.updated_at=stamp;
  const originalRoles=Object.fromEntries(store.all('SELECT unit_id,data_json FROM unit_catalogue').map(r=>[r.unit_id,JSON.parse(r.data_json).role]).filter(([,role])=>Number.isSafeInteger(role)&&role>=0));
  const frozen=model.catalogues??[{...publicAirModel(model),version_name:'1.2.0 系列目录',valid_until:LIVE_121_AT,roles:originalRoles}];
  const updatedAir={...model,catalogues:frozen.filter(c=>c.version_name!=='1.2.1').concat(air),updated_at:stamp};
  const display=publicDisplayCatalogue({version_name:'1.2.1',updated_at:stamp,units:Object.fromEntries(Object.entries(prices.units).map(([id,u])=>[id,u.catalogue]))});
  const report={version:'1.2.1',build_id:manifest.build_id,source_hash:manifest.sha256,display_units:Object.keys(display.units).length,air_units:Object.keys(air.units).length,air_catalogues:updatedAir.catalogues.map(c=>({version_name:c.version_name,units:Object.keys(c.units).length})),updated_at:stamp};
  if(!process.argv.includes('--dry-run')){
    await store.backup();
    store.transaction(()=>{
      for(const[key,data]of [['unit_display_catalogue',display],['air_superiority_model',updatedAir]])store.run('INSERT INTO analysis_catalogue VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at',key,JSON.stringify(data),stamp);
    });
    const reports=path.join(store.directory,'price-audits');await mkdir(reports,{recursive:true});await writeFile(path.join(reports,'catalogue-unification-26052592.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify(report,null,2));
}finally{store.close();}
