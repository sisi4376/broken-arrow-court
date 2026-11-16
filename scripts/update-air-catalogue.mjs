import {Store} from '../src/db.mjs';
import {createSource} from '../src/source-provider.mjs';
import {updateAirCatalogue} from '../src/air-superiority.mjs';
try {process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const store=new Store(process.env.DATA_DIR||'data');
try {
  const result=await updateAirCatalogue(store,createSource(store),{force:process.argv.includes('--force'),onProgress:p=>console.log(JSON.stringify(p))});
  console.log(JSON.stringify(result));
}finally{store.close();}
