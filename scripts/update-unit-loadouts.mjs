import {readFile} from 'node:fs/promises';
import {Store} from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import {updateUnitLoadouts} from '../src/unit-loadout-catalogue.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const file=process.argv.find(s=>s.startsWith('--translations='))?.slice(15);
const translations=file?JSON.parse(await readFile(file,'utf8')):undefined;
const store=new Store(process.env.DATA_DIR||'data');
try{console.log(JSON.stringify(await updateUnitLoadouts(store,createSource(store),{force:process.argv.includes('--force'),cachedOnly:process.argv.includes('--cached-only'),translations,onProgress:p=>console.log(JSON.stringify(p))})));}
finally{store.close();}
