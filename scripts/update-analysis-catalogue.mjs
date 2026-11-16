import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store, now } from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import { extractFlight } from '../src/domain.mjs';

try { process.loadEnvFile('.env'); } catch (error) { if(error.code!=='ENOENT') throw error; }
const directory=path.resolve(process.env.DATA_DIR||'data');
await mkdir(path.join(directory,'backups'),{recursive:true});
const db=new DatabaseSync(path.join(directory,'court.sqlite'),{readOnly:true});
try { await backup(db,path.join(directory,'backups',`before-analysis-${now().replace(/[:.]/g,'-')}.sqlite`)); } finally { db.close(); }
const store=new Store(directory);const source=createSource(store);
try {
  const html=await source.read('/units',{json:false});let props;
  function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v.initialSpecializations))props=v;for(const[k,x]of Object.entries(v))if(!['messages','dangerouslySetInnerHTML','initialUnits'].includes(k))walk(x);}
  extractFlight(html).forEach(walk);
  if(!props?.initialSpecializations?.length||!props.initialDbFile)throw new Error('公开专精目录结构已变化');
  const specs=props.initialSpecializations;
  const used=new Set(store.all('SELECT unit_id FROM unit_catalogue UNION SELECT DISTINCT unit_id FROM unit_instances').map(u=>String(u.unit_id)));
  const units={};
  for(const country of [...new Set(specs.map(s=>s.countryId))]){
    const list=specs.filter(s=>s.countryId===country);
    for(let i=0;i<list.length;i+=2){
      const a=list[i],b=list[i+1]??list[0];
      const query=new URLSearchParams({country_id:String(country),spec1_id:String(a.id),spec2_id:String(b.id),db_file:props.initialDbFile});
      const data=await source.read(`/api/dek/units?${query}`);
      if(!Array.isArray(data.units))throw new Error('专精单位池结构已变化');
      for(const u of data.units){
        if(!used.has(String(u.id)))continue;
        const row=units[u.id]??={country_id:u.countryId,spec_ids:[]};
        for(const [slot,spec] of [['spec1',a.id],['spec2',b.id]]){
          if(Object.values(u.availability?.[slot]??{}).some(n=>Number(n)>0)&&!row.spec_ids.includes(spec))row.spec_ids.push(spec);
        }
      }
      console.log(JSON.stringify({country,specs:[a.id,b.id],returned:data.units.length}));
    }
  }
  const model={specializations:specs,units,db_file:props.initialDbFile,version_id:props.initialVersionId,updated_at:now(),source:source.base+'/units'};
  store.run("INSERT INTO analysis_catalogue(key,data_json,updated_at) VALUES('deck_model',?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",JSON.stringify(model),now());
  console.log(JSON.stringify({ok:true,specializations:specs.length,mapped_units:Object.keys(units).length,archived_unit_types:used.size,db_file:model.db_file}));
} finally { store.close(); }
