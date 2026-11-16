import {Store} from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import {updateUnitLoadoutHistory} from '../src/unit-loadout-history.mjs';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const store=new Store(process.env.DATA_DIR||'data');
try{console.log(JSON.stringify(await updateUnitLoadoutHistory(store,createSource(store),{force:process.argv.includes('--force'),cachedOnly:process.argv.includes('--cached-only'),onProgress:p=>console.log(JSON.stringify(p))})));}
finally{store.close();}
