import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { tempDir } from './helpers.mjs';
import { deployGitHubPages, githubRepository, updateDeploymentEnv } from '../src/github-deploy.mjs';

async function setup(t, settings = {}) {
  const root = tempDir(t), calls = [], events = [];
  const original = settings.env ?? '# Keep private settings\r\nDATA_DIR=./private-data\r\nPORT=4500\r\nCUSTOM_SECRET="not-for-github"\r\n';
  await writeFile(path.join(root, '.env'), original);
  let exists = settings.exists ?? false;
  const pages = { html_url: 'https://owner.github.io/court/', status: 'building', build_type: 'legacy', source: { branch: 'main', path: '/' } };
  const missing = () => ({ code: 1, stdout: '{"status":"404"}', stderr: 'gh: Not Found (HTTP 404)' });
  const ok = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const options = { root, repository: 'owner/court', allowPublicData: true, createPublicRepository: true };
  const deps = {
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === 'git') {
        if (args.includes('rev-parse')) return settings.own ? ok(path.join(root, 'site')) : { code: 128, stdout: '', stderr: '' };
        if (args.includes('get-url')) return ok(settings.origin || 'https://github.com/owner/court.git');
        return ok('');
      }
      if (args[0] === 'auth' && settings.authError) return { code: 1, stdout: '', stderr: 'Run gh auth login' };
      if (args[0] === 'repo') { exists = true; return ok('https://github.com/owner/court'); }
      if (args[0] !== 'api') return ok('version');
      const post = args.includes('POST'), route = args.find(x => x.startsWith('repos/'));
      if (route === 'repos/owner/court') return exists ? ok({ private: settings.private ?? false }) : missing();
      if (route.endsWith('/contents')) return settings.nonempty ? ok([{ name: 'README.md' }]) : missing();
      if (route.endsWith('/pages')) return post ? ok(pages) : settings.pages ? ok({ ...pages, ...settings.pages }) : missing();
      throw new Error('Unexpected command: ' + args.join(' '));
    },
    exportSite: async config => { events.push({ kind: 'export', ...config }); await mkdir(config.directory, { recursive: true }); },
    publishSite: async config => { events.push({ kind: 'publish', ...config }); if (settings.pushError) throw new Error('Push failed'); return { revision: 'a'.repeat(64) }; },
  };
  return { root, original, calls, events, options, deps, env: () => readFile(path.join(root, '.env'), 'utf8') };
}

test('repository parsing never accepts credentials, other hosts or option injection', () => {
  for (const input of ['owner/court', 'https://github.com/owner/court.git', 'git@github.com:owner/court.git']) assert.equal(githubRepository(input), 'owner/court');
  for (const input of ['https://token:secret@github.com/owner/court', 'https://evil.example/owner/court', '--public', '../court', 'owner/..', 'owner/court?token=secret', 'owner/court/other']) assert.throws(() => githubRepository(input));
});

test('deployment requires an explicit public-data acknowledgement before doing anything', async t => {
  const f = await setup(t);
  await assert.rejects(deployGitHubPages({ ...f.options, allowPublicData: false }, f.deps), /allow-public-data/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []); assert.equal(await f.env(), f.original);
});

test('new public deployment preserves private config and sets only repository-local credentials', async t => {
  const f = await setup(t); const r = await deployGitHubPages(f.options, f.deps);
  assert.equal(r.url, 'https://owner.github.io/court/'); assert.equal(r.status, 'building');
  const env = parseEnv(await f.env()); assert.equal(env.CUSTOM_SECRET, 'not-for-github'); assert.equal(env.PORT, '4500'); assert.equal(env.DATA_DIR, './private-data');
  assert.equal(env.PUBLISH_GIT_REMOTE, 'https://github.com/owner/court.git'); assert.equal(env.PUBLISH_MIN_INTERVAL_MINUTES, '120');
  assert.deepEqual(f.events.map(e => e.kind), ['export', 'publish']); assert.equal(f.events[0].dataDirectory, path.join(f.root, 'private-data'));
  assert(f.calls.some(c => c.command === 'gh' && c.args.includes('create') && c.args.includes('--public')));
  assert(f.calls.some(c => c.args.includes('source[branch]=main') && c.args.includes('source[path]=/')));
  assert(f.calls.filter(c => c.args.includes('config')).every(c => c.args.includes('--local') && !c.args.includes('--global')));
  assert(!JSON.stringify(f.calls).includes('not-for-github')); assert(!f.calls.some(c => c.args.includes('edit') || c.args.includes('--force')));
  assert(!(await readdir(f.root)).some(name => name.endsWith('.tmp')));
});

test('existing managed Pages deployment is reusable without overwriting its configuration', async t => {
  const f = await setup(t, { exists: true, own: true, nonempty: true, pages: {}, env: 'PUBLISH_GIT_REMOTE=https://github.com/owner/court.git\nPUBLISH_MIN_INTERVAL_MINUTES=180\n' });
  await deployGitHubPages({ ...f.options, repository: undefined }, f.deps);
  const first = await f.env(); await deployGitHubPages(f.options, f.deps); assert.equal(await f.env(), first);
  assert.equal(parseEnv(first).PUBLISH_MIN_INTERVAL_MINUTES, '180');
  assert(!f.calls.some(c => c.args.includes('POST') || c.args.includes('create')));
});

test('a missing repository is not created without an explicit creation flag', async t => {
  const f = await setup(t);
  await assert.rejects(deployGitHubPages({ ...f.options, createPublicRepository: false }, f.deps), /Repository not found/);
  assert.deepEqual(f.events, []); assert(!f.calls.some(c => c.args.includes('create')));
});

test('private repositories are never made public automatically', async t => {
  const f = await setup(t, { exists: true, private: true });
  await assert.rejects(deployGitHubPages(f.options, f.deps), /never changes visibility/);
  assert.deepEqual(f.events, []); assert.equal(await f.env(), f.original); assert(!f.calls.some(c => c.args.includes('edit')));
});

test('unrelated nonempty repositories, mismatched origins and different Pages setups are refused', async t => {
  for (const [settings, pattern] of [
    [{ exists: true, nonempty: true }, /not empty/],
    [{ own: true, origin: 'https://github.com/owner/private-source.git' }, /another remote/],
    [{ exists: true, own: true, pages: { build_type: 'workflow' } }, /Pages configuration/],
    [{ exists: true, own: true, pages: { source: { branch: 'main', path: '/docs' } } }, /Pages configuration/],
  ]) {
    const f = await setup(t, settings); await assert.rejects(deployGitHubPages(f.options, f.deps), pattern);
    assert.deepEqual(f.events, []); assert.equal(await f.env(), f.original);
  }
});

test('conflicting publication config is not redirected to a new repository or branch', async t => {
  for (const env of ['PUBLISH_GIT_REMOTE=https://github.com/other/private.git\n', 'PUBLISH_GIT_BRANCH=archive\n']) {
    const f = await setup(t, { env }); await assert.rejects(deployGitHubPages(f.options, f.deps), /not replaced/);
    assert.deepEqual(f.calls, []); assert.equal(await f.env(), env);
  }
});

test('login and push failures do not overwrite .env or falsely enable Pages', async t => {
  for (const settings of [{ authError: true }, { pushError: true }]) {
    const f = await setup(t, settings); await assert.rejects(deployGitHubPages(f.options, f.deps), /login|Push failed/);
    assert.equal(await f.env(), f.original); assert(!f.calls.some(c => c.args.includes('POST')));
  }
});

test('concurrent .env edits are preserved even if the remote push already finished', async t => {
  const f = await setup(t); const publish = f.deps.publishSite;
  f.deps.publishSite = async config => { const r = await publish(config); await writeFile(path.join(f.root, '.env'), f.original + '# concurrent edit\r\n'); return r; };
  await assert.rejects(deployGitHubPages(f.options, f.deps), /changed during deployment/);
  assert.equal(await f.env(), f.original + '# concurrent edit\r\n');
});

test('dotenv updates preserve comments, CRLF and unrelated values while removing duplicate managed keys', () => {
  const input = '# original\r\nDATA_DIR="./private folder"\r\nPUBLISH_GIT_BRANCH=old\r\nexport PUBLISH_GIT_BRANCH=other\r\nSECRET="x=y # keep"\r\n';
  const updated = updateDeploymentEnv(input, { PUBLISH_GIT_BRANCH: 'main', STATIC_EXPORT_ENABLED: '1' });
  assert(updated.includes('# original\r\n')); assert(updated.includes('SECRET="x=y # keep"'));
  assert.equal((updated.match(/PUBLISH_GIT_BRANCH=/g) || []).length, 1); assert.equal(parseEnv(updated).DATA_DIR, './private folder');
  assert.equal(updateDeploymentEnv(updated, { PUBLISH_GIT_BRANCH: 'main', STATIC_EXPORT_ENABLED: '1' }), updated);
});

test('dotenv updates preserve multiline secrets and quote paths containing spaces and hashes', () => {
  const input = 'SECRET="first line\nSTATIC_EXPORT_ENABLED=do-not-touch\nlast line"\nSTATIC_OUTPUT_DIR="./static #site"\n';
  const values = { STATIC_EXPORT_ENABLED: '1', STATIC_OUTPUT_DIR: './static #site' };
  const output = updateDeploymentEnv(input, values), env = parseEnv(output);
  assert.equal(env.SECRET, parseEnv(input).SECRET); assert.equal(env.STATIC_OUTPUT_DIR, values.STATIC_OUTPUT_DIR); assert.equal(env.STATIC_EXPORT_ENABLED, '1');
  assert.throws(() => updateDeploymentEnv('SECRET="unclosed\n', values), /Unclosed/);
});
