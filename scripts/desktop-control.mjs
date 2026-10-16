import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopStatus, savePublicationInterval } from '../src/desktop.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tools: { type: 'boolean' }, minutes: { type: 'string' } } });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (positionals[0] === 'status') console.log(JSON.stringify(await desktopStatus(root, { checkTools: values.tools })));
  else if (positionals[0] === 'interval') console.log(JSON.stringify(await savePublicationInterval(root, values.minutes)));
  else throw new Error('Usage: desktop-control.mjs status [--tools] | interval --minutes N');
} catch (e) { console.error(e.message); process.exitCode = 1; }
