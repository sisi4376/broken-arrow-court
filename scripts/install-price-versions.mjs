import {Store} from '../src/db.mjs';
import {archiveLoadoutCatalogue} from '../src/unit-loadout-catalogue.mjs';
import {compilePatch121,LIVE_121_AT,PRE_121_DB} from '../src/match-prices.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const store=new Store(process.env.DATA_DIR||'data');
try{
  const model=JSON.parse(store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadouts'")?.data_json??'null');
  if(!model)throw Error('缺少单位价格目录');
  await store.backup();
  archiveLoadoutCatalogue(store,model);
  const history=JSON.parse(store.get("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").data_json);
  const frozen=history.price_catalogues?.find(c=>c.version_name==='1.2.0_od');
  const archived=model.db_file===PRE_121_DB?model:history.catalogues.find(c=>c.db_file===PRE_121_DB);
  if(!frozen&&!archived)throw Error('缺少更新前的价格快照，未安装');
  const baseline=frozen??{...structuredClone(archived),version_name:'1.2.0_od',price_source:'catalogue',valid_until:LIVE_121_AT};
  if(!frozen)for(const s of history.supplements??[]){
    const slot=baseline.units[s.unit_id]?.slots.find(x=>x.id===s.slot_id);
    if(slot&&!slot.options.some(o=>o.id===s.option.id))slot.options.push({...s.option,source:'game_extract'});
  }
  const patch=compilePatch121(baseline);delete patch.valid_until;
  const existing=history.price_catalogues?.find(c=>c.version_name==='1.2.1');
  history.price_catalogues=[baseline,existing?.upstream_db_file||existing?.price_source==='game_files'?existing:patch,
    ...(history.price_catalogues??[]).filter(c=>!['1.2.0_od','1.2.1'].includes(c.version_name))];
  store.run("UPDATE analysis_catalogue SET data_json=?,updated_at=? WHERE key='unit_loadout_history'",JSON.stringify(history),new Date().toISOString());
  console.log(JSON.stringify({versions:history.price_catalogues.map(c=>({version:c.version_name,units:Object.keys(c.units).length,from:c.valid_from??null,until:c.valid_until??null})),adjustments:patch.changes.length,pending_units:Object.values(patch.units).filter(u=>u.price_pending).map(u=>u.id)},null,2));
}finally{store.close();}
