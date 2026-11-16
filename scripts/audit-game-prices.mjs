import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {matchPriceCatalogue} from '../src/match-prices.mjs';
import {resolveUnitLoadout} from '../src/unit-loadouts.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const directory=process.env.DATA_DIR||'data',db=new DatabaseSync(path.join(directory,'court.sqlite'),{readOnly:true});
try{
  const row=db.prepare("SELECT data_json FROM analysis_catalogue WHERE key='unit_loadout_history'").get();
  const history=JSON.parse(row?.data_json??'{}'),catalogues=history.price_catalogues?.filter(c=>c.price_source==='game_files')??[];
  if(!catalogues.length)throw Error('没有已导入的游戏原始价格目录');
  const result={matches:0,participants:0,exact_spawn_totals:0,deployments:0,unresolved_deployments:0,mismatches:[]};
  const first=Math.min(...catalogues.map(c=>c.valid_from));
  for(const m of db.prepare("SELECT id,end_time,duration,detail_json FROM matches WHERE detail_state='complete' AND end_time>=?").all(first)){
    const detail=JSON.parse(m.detail_json),c=matchPriceCatalogue(history,{start:detail.data.StartTime??m.end_time-m.duration,end:m.end_time});
    if(c?.price_source!=='game_files')continue;result.matches++;
    for(const [id,p]of Object.entries(detail.data.Data??{})){
      let sum=0,missing=0;
      for(const u of Object.values(p.UnitData??{})){
        result.deployments++;const r=resolveUnitLoadout(u.OptionIds,null,{unit_id:u.Id,price_catalogue:c});
        if(r.cost===null){missing++;result.unresolved_deployments++;}else sum+=r.cost;
      }
      if(typeof p.TotalSpawnedUnitScore!=='number')continue;
      result.participants++;
      if(!missing&&sum===p.TotalSpawnedUnitScore)result.exact_spawn_totals++;
      else result.mismatches.push({match_id:m.id,player_id:id,calculated:sum,reported:p.TotalSpawnedUnitScore,unresolved:missing});
    }
  }
  if(process.argv.includes('--record'))for(const c of catalogues){
    const filename=path.join(directory,'price-audits',`${c.version_name}-build-${c.build_id}.json`);
    const report=JSON.parse(await readFile(filename,'utf8'));report.deployment_crosscheck=result;await writeFile(filename,JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify(result,null,2));if(result.mismatches.length||result.unresolved_deployments)process.exitCode=1;
}finally{db.close();}
