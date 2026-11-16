import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopStatus, savePublicationInterval, saveAutoSync,saveSourceProvider } from '../src/desktop.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tools: { type: 'boolean' },storage:{type:'boolean'}, minutes: { type: 'string' },from:{type:'string'},to:{type:'string'},group:{type:'string'},provider:{type:'string'},page:{type:'string'} } });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (positionals[0] === 'status') console.log(JSON.stringify(await desktopStatus(root, { checkTools: values.tools,storage:values.storage,statistics:Object.fromEntries(['from','to','group','provider','page'].filter(k=>values[k]!==undefined).map(k=>[k,values[k]])) })));
  else if(positionals[0]==='source')console.log(JSON.stringify(await saveSourceProvider(root,positionals[1])));
  else if (positionals[0] === 'interval') console.log(JSON.stringify(await savePublicationInterval(root, values.minutes)));
  else if(positionals[0]==='sync'&&['on','off'].includes(positionals[1]))console.log(JSON.stringify(await saveAutoSync(root,positionals[1]==='on')));
  else throw new Error('Usage: desktop-control.mjs status [--tools] | interval --minutes N | sync on|off');
} catch (e) { console.error(e.message); process.exitCode = 1; }
