import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {resolveUnitLoadout} from '../src/unit-loadouts.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const db=new DatabaseSync(path.join(process.env.DATA_DIR||'data','court.sqlite'),{readOnly:true});
try{
  const row=key=>db.prepare('SELECT data_json FROM analysis_catalogue WHERE key=?').get(key);
  const model=JSON.parse(row('unit_loadouts')?.data_json??'{"units":{}}'),history=JSON.parse(row('unit_loadout_history')?.data_json??'{}');
  const counts={deployments:0,current_complete:0,resolved:0,priced:0,historical:0,supplement:0,ambiguous_price:0},unresolved=[];
  for(const r of db.prepare("SELECT unit_id,json_extract(raw_json,'$.OptionIds') options,COUNT(*) n FROM unit_instances GROUP BY unit_id,options ORDER BY n DESC").all()){
    const ids=JSON.parse(r.options??'null'),unit=model.units[r.unit_id],before=resolveUnitLoadout(ids,unit,model),after=resolveUnitLoadout(ids,unit,{...model,unit_id:Number(r.unit_id),history});
    counts.deployments+=r.n;if(before.resolution==='complete')counts.current_complete+=r.n;
    if(after.resolution==='complete')counts.resolved+=r.n;else unresolved.push({unit_id:r.unit_id,option_ids:ids,deployments:r.n,issues:after.issues});
    if(after.cost!==null)counts.priced+=r.n;
    if(after.basis==='historical')counts.historical+=r.n;if(after.basis==='supplement')counts.supplement+=r.n;if(after.issues.includes('ambiguous_price'))counts.ambiguous_price+=r.n;
  }
  console.log(JSON.stringify({counts,unresolved},null,2));
}finally{db.close();}
