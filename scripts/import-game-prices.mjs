import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/db.mjs';
import {compileGamePriceCatalogue,compareGamePriceCatalogue} from '../src/game-price-catalogue.mjs';
import {compileIconVariants} from '../src/unit-icons.mjs';
import {LIVE_121_AT} from '../src/match-prices.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const folder=process.argv.find(a=>a.startsWith('--directory='))?.slice(12);
if(!folder)throw Error('请使用 --directory= 提供已验证的本地游戏数据表目录');
const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
if(manifest.build_id!=='26052592')throw Error('此导入仅针对已核实的 1.2.1 正式版构建 26052592');
const tables=Object.fromEntries(await Promise.all(['Units','Modifications','Options'].map(async name=>{
  const bytes=await readFile(path.join(folder,'tables',name+'.json'));
  if(manifest.table_sha256?.[name]!==createHash('sha256').update(bytes).digest('hex'))throw Error(`${name} 表与提取清单指纹不一致`);
  const rows=JSON.parse(bytes);if(rows.length!==manifest.row_counts[name])throw Error(`${name} 表条目数不一致`);
  return [name,rows];
})));
const store=new Store(process.env.DATA_DIR||'data');
try{
  const history=JSON.parse(store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'")?.data_json??'null');
  if(!history?.price_catalogues?.some(c=>c.version_name==='1.2.0_od'))throw Error('请先建立旧版价格快照');
  const current=JSON.parse(store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadouts'").data_json);
  const model=compileGamePriceCatalogue(tables,{versionName:'1.2.1',buildId:manifest.build_id,sourceHash:manifest.sha256,validFrom:LIVE_121_AT,translations:current.translations});
  model.icon_variants=compileIconVariants(tables,{ref:'local-game-build-'+manifest.build_id});
  const previous=history.price_catalogues.find(c=>c.version_name==='1.2.1');
  const audit=compareGamePriceCatalogue(previous??{units:{}},model);
  const report={version:'1.2.1',build_id:manifest.build_id,source_hash:manifest.sha256,units:tables.Units.length,options:tables.Options.length,modifications:tables.Modifications.length,compared_to:previous?.db_file??null,...audit};
  if(process.argv.includes('--dry-run')){console.log(JSON.stringify({...report,base_changes:report.base_changes.length,option_changes:report.option_changes.length,layout_changes:report.layout_changes.length,new_units:report.new_units.length,new_options:report.new_options.length},null,2));}
  else{
    await store.backup();
    store.transaction(()=>{
      history.price_catalogues=history.price_catalogues.filter(c=>c.version_name!=='1.2.1').concat(model);
      store.run("UPDATE analysis_catalogue SET data_json=?,updated_at=? WHERE key='unit_loadout_history'",JSON.stringify(history),new Date().toISOString());
      for(const [name,rows]of Object.entries(tables))store.snapshot(`local-game:build-${manifest.build_id}/${name}.json`,rows);
    });
    const reports=path.join(store.directory,'price-audits');await mkdir(reports,{recursive:true});await writeFile(path.join(reports,'1.2.1-build-'+manifest.build_id+'.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({version:model.version_name,units:report.units,options:report.options,base_differences:audit.base_changes.length,option_differences:audit.option_changes.length,layout_differences:audit.layout_changes.length,new_units:audit.new_units.length,new_options:audit.new_options.length,source_hash:manifest.sha256},null,2));
  }
}finally{store.close();}
