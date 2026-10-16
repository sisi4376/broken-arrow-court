import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../src/db.mjs';
import { exportStatic } from '../src/static-export.mjs';
import { Publication } from '../src/publication.mjs';
import { deployGitHubPages, runCommand } from '../src/github-deploy.mjs';

const { values } = parseArgs({ options: {
  repository: { type: 'string' }, 'create-public-repository': { type: 'boolean' },
  'allow-public-data': { type: 'boolean' }, 'restart-service': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node scripts/deploy-github-pages.mjs --repository OWNER/NAME --allow-public-data [--create-public-repository] [--restart-service]');
  console.log('Requires Node.js 24+, Git, GitHub CLI and gh auth login. Publishes a PUBLIC, read-only snapshot; never uploads the original database.');
  process.exit(0);
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
try {
  const result = await deployGitHubPages({ root, repository: values.repository, createPublicRepository: values['create-public-repository'], allowPublicData: values['allow-public-data'] }, {
    log: console.log,
    exportSite: async ({ directory, dataDirectory }) => {
      const store = new Store(dataDirectory);
      try { return await exportStatic(store, { directory }); } finally { store.close(); }
    },
    publishSite: async ({ directory, dataDirectory, remote, branch }) => {
      const store = new Store(dataDirectory);
      try { return await new Publication(store, { directory, remote, branch }).run({ forcePush: true }); } finally { store.close(); }
    },
  });
  if (values['restart-service']) {
    for (const command of ['stop', 'start']) {
      const r = await runCommand(process.execPath, ['scripts/service.mjs', command], { cwd: root });
      if (r.code !== 0) throw new Error(`Site configured, but service ${command} failed. Check data/server-error.log and restart manually.`);
      console.log(r.stdout);
      if (command === 'stop' && r.stdout.includes('finishing the current source request')) throw new Error('Service is still shutting down. Wait and run Start.ps1 before relying on automatic updates.');
    }
  }
  console.log(JSON.stringify(result, null, 2));
  console.log('Pages configuration and push succeeded. Check GitHub Actions / Settings > Pages for build completion; this is not a claim that the website is already live.');
  if (!values['restart-service']) console.log('Restart the local service to load automatic publication settings.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
