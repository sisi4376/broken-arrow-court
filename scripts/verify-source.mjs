import { Store } from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const parent=path.join(root,'.cache/source-verification');mkdirSync(parent,{recursive:true});
const directory=mkdtempSync(path.join(parent,'run-'));
try { process.loadEnvFile(path.join(root,'.env')); } catch(error) { if(error.code!=='ENOENT')throw error; }
const store=new Store(directory),monitorStore=new Store(path.resolve(root,process.env.DATA_DIR||'data'));
const source=createSource(store,{monitorStore});
try{
  const profile=await source.profile('214374');
  const page=await source.matches('214374',0);
  const item=page.matches[0];store.ingest(item.matchId,item.data);
  const detail=await source.detail(item.matchId);store.saveDetail(item.matchId,detail);
  const unit=store.get('SELECT unit_id FROM unit_instances LIMIT 1');
  let unitCatalogue=null;let unitError=null;
  try{unitCatalogue=unit?(await source.units([unit.unit_id]))[0]:null;}catch(error){unitError=error.message;}
  console.log(JSON.stringify({player_id:profile.playerData.info.id,lifetime_ranked_games:profile.playerData.statInfo?.fightsCountRt,upstream_available:page.totalCount,match_id:item.matchId,participants:Object.keys(detail.data.Data).length,unit_instances:store.get('SELECT COUNT(*) AS n FROM unit_instances').n,match_fields:Object.keys(detail.data),player_fields:Object.keys(Object.values(detail.data.Data)[0]),unit_catalogue_ok:!!unitCatalogue,unit_catalogue_sample:unitCatalogue?{id:unitCatalogue.id,name:unitCatalogue.name,hudName:unitCatalogue.hudName}:null,unit_error:unitError,archive:directory},null,2));
}finally{store.close();monitorStore.close();}
