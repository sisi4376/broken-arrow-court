import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { matchDetail } from './queries.mjs';
import { mapName, TITLE } from './domain.mjs';
import { deckModel } from './analysis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATIC_SOURCES = {
  'app.js': 'public/app.js', 'style.css': 'public/style.css', 'icons.js': 'public/icons.js', 'favicon.svg': 'public/favicon.svg',
  'LUCIDE-LICENSE': 'public/LUCIDE-LICENSE', 'queries.mjs': 'src/queries.mjs', 'domain.mjs': 'src/domain.mjs',
  'bootstrap.mjs': 'readonly/bootstrap.mjs', 'reader.mjs': 'readonly/reader.mjs',
  'analysis.js': 'public/analysis.js', 'analysis.mjs': 'src/analysis.mjs',
  'table-sort.js': 'public/table-sort.js',
  'performance.js': 'public/performance.js',
  'sql-wasm.js': 'vendor/sqljs/sql-wasm.js', 'sql-wasm.wasm': 'vendor/sqljs/sql-wasm.wasm', 'SQLJS-LICENSE': 'vendor/sqljs/LICENSE',
};
export { ROOT as SOURCE_ROOT };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const MATCH_FIELDS = 'TotalObjectiveZonesCount MapId StartTime EndTime TotalPlayTimeInSec Type GameType MatchType Mode WinnerTeam VictoryLevel EndMatchReason'.split(' ');
const PLAYER_FIELDS = 'Id Name TeamId OldRating NewRating DestructionScore LossesScore ObjectivesCaptured TotalSpawnedUnitScore TotalRefundedUnitScore Destruction Losses DamageDealt DamageReceived DamageFriendlyFireDealt DamageFriendlyFireReceived SupplyPointsConsumed SupplyCaptured SupplyCapturedByEnemy SupplyAirdropped SupplyPointsConsumedByAllies SupplyPointsConsumedFromAllies RawExpWithMultipliers RawExp TotalExp DLRatio Deserter'.split(' ');
const UNIT_FIELDS = 'Id SpawnTime DeathTime WasRefunded WasAirdropped TotalDamageDealt TotalDamageReceived TotalSupplyPointsConsumed KilledCount TotalSelfDamageDealt TotalFriendlyFireDamageDealt TotalFriendlyFireDamageReceived BuildingDestroyedCount'.split(' ');
const CATALOG_FIELDS = 'id Id hudName uiName name cost categoryType category_type countryId country_id'.split(' ');
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
function fields(value, keys) { return Object.fromEntries(Object.entries(pick(value, keys)).filter(([, v]) => scalar(v))); }
function catalogue(value) {
  if (!value) return null;
  const result = fields(value, CATALOG_FIELDS);
  for (const key of ['name', 'hudName', 'uiName']) if (value[key] && typeof value[key] === 'object') result[key] = fields(value[key], ['en', 'zh', 'zh-CN', 'en-US', 'ru', 'ja']);
  return result;
}
function unitRaw(value) {
  const result = fields(value, UNIT_FIELDS);
  if (Array.isArray(value?.OptionIds)) result.OptionIds = value.OptionIds.filter(x => Number.isSafeInteger(x));
  return result;
}
function playerRaw(value) {
  const result = fields(value, PLAYER_FIELDS);
  if (value?.UnitData) result.UnitData = Object.fromEntries(Object.entries(value.UnitData).filter(([id]) => /^\d+$/.test(id)).map(([id, unit]) => [id, unitRaw(unit)]));
  if (value?.Medals && typeof value.Medals === 'object') result.Medals = Object.fromEntries(Object.entries(value.Medals).filter(([id, v]) => /^\d+$/.test(id) && scalar(v)));
  if (Array.isArray(value?.TransferredUnits)) result.TransferredUnits = value.TransferredUnits.filter(x => Number.isSafeInteger(x));
  return result;
}
function gameRaw(value) {
  return { ...fields(value, MATCH_FIELDS), ...(value?.Data ? { Data: Object.fromEntries(Object.entries(value.Data).filter(([id]) => /^-?\d+$/.test(id)).map(([id, p]) => [id, playerRaw(p)])) } : {}) };
}
export function publicMatch(detail) {
  const result = pick(detail, 'id end_time duration map_id mode winner_team victory_level friend_count same_team_count detail_state map_name'.split(' '));
  result.raw = gameRaw(detail.raw);
  result.detail = detail.detail ? { data: gameRaw(detail.detail.data), metadata: {} } : null;
  result.participants = detail.participants.map(p => ({ ...pick(p, 'match_id player_id name team_id old_rating new_rating rating_delta destruction losses objectives won registered'.split(' ')), member_id: p.registered ? p.member_id : null, member_name: p.registered ? p.member_name : null, raw: playerRaw(p.raw) }));
  result.units = detail.units.map(u => ({ ...pick(u, 'match_id player_id net_id unit_id spawn_time death_time refunded kills damage damage_received supply'.split(' ')), raw: unitRaw(u.raw), catalogue: catalogue(u.catalogue) }));
  return result;
}
const PUBLIC_SCHEMA = `
CREATE TABLE members(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);
CREATE TABLE accounts(id INTEGER PRIMARY KEY,member_id INTEGER,player_id TEXT,name TEXT,active INTEGER);
CREATE TABLE matches(id TEXT PRIMARY KEY,end_time INTEGER,duration REAL,map_id TEXT,mode TEXT,winner_team INTEGER,victory_level INTEGER,friend_count INTEGER,same_team_count INTEGER,detail_state TEXT,detail_error TEXT,updated_at TEXT,raw_json TEXT);
CREATE TABLE participants(match_id TEXT,player_id TEXT,name TEXT,team_id INTEGER,old_rating REAL,new_rating REAL,rating_delta REAL,destruction REAL,losses REAL,objectives INTEGER,won INTEGER,raw_json TEXT);
CREATE INDEX participants_player ON participants(player_id,match_id);
CREATE INDEX participants_match ON participants(match_id);
CREATE TABLE unit_instances(match_id TEXT,player_id TEXT,net_id TEXT,unit_id TEXT,spawn_time INTEGER,death_time INTEGER,refunded INTEGER,kills INTEGER,damage REAL,damage_received REAL,supply REAL);
CREATE INDEX units_match ON unit_instances(match_id,player_id);
CREATE TABLE unit_catalogue(unit_id TEXT PRIMARY KEY,data_json TEXT);
CREATE TABLE match_assets(id TEXT PRIMARY KEY,asset TEXT);
CREATE TABLE analysis_catalogue(key TEXT PRIMARY KEY,data_json TEXT,updated_at TEXT);
CREATE TABLE match_decks(match_id TEXT,player_id TEXT,spec1 INTEGER,spec2 INTEGER,PRIMARY KEY(match_id,player_id));
CREATE VIEW registered_participants AS SELECT p.*,a.id AS account_id,a.member_id,m.name AS member_name FROM participants p JOIN accounts a ON a.player_id=p.player_id JOIN members m ON m.id=a.member_id WHERE a.active=1 AND m.active=1 AND (p.team_id IS NULL OR p.team_id!=100);
`;
function insert(db, table, columns, rows) {
  const keys = columns.split(' '); const statement = db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`);
  for (const row of rows) statement.run(...keys.map(k => row[k] ?? null));
}
async function atomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content); await rename(temporary, file);
}
export async function siteInventory(directory) {
  const root = path.resolve(directory);
  const marker = JSON.parse(await readFile(path.join(root, '.court-static-site.json'), 'utf8'));
  if (marker.format !== 'court-static-output-v1') throw new Error('目录不是法庭生成的独立静态站点');
  const files = [...new Set(marker.generations.flatMap(g => g.files))];
  for (const file of files) if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(p => p === '..' || p === '.git') || !path.resolve(root, file).startsWith(root + path.sep)) throw new Error('无效的发布文件路径');
  return { root, marker, files };
}
export async function withSiteLock(directory, operation) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, '.court-operation.lock');
  let lock;
  try { lock = await open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let alive = true;
    try { const previous = JSON.parse(await readFile(file, 'utf8')); process.kill(previous.pid, 0); }
    catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('已有静态导出或提交任务正在运行，稍后重试');
    await unlink(file); lock = await open(file, 'wx');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  try { return await operation(); } finally { await unlink(file).catch(() => {}); }
}
export async function exportStatic(store, { directory = path.join(ROOT, 'site') } = {}) {
  const root = path.resolve(directory);
  if (root === ROOT || !path.relative(ROOT, root) || ['public', 'src', 'readonly', 'data', 'vendor'].includes(path.relative(ROOT, root).split(path.sep)[0])) throw new Error('静态输出必须使用独立目录，不能覆盖源文件或私有数据目录');
  return withSiteLock(root, () => buildStatic(store, root));
}
async function buildStatic(store, root) {
  let previous = null;
  try { previous = await siteInventory(root); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { if ((await readdir(root)).some(name => !['.git', '.court-operation.lock'].includes(name))) throw new Error('静态输出目录非空且没有受管标记，请选择空目录'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const assets = new Map();
  for (const [name, source] of Object.entries(STATIC_SOURCES)) assets.set(name, await readFile(path.join(ROOT, source)));
  const assetHash = hash(Buffer.concat([...assets.values()]));
  const files = new Map([...assets].map(([name, bytes]) => [`assets/${assetHash}/${name}`, bytes]));
  const model = store.transaction(() => {
    const members = store.all('SELECT id,name,active FROM members WHERE active=1 ORDER BY id');
    const accounts = store.all('SELECT a.id,a.member_id,a.player_id,a.name,a.active FROM accounts a JOIN members m ON m.id=a.member_id WHERE a.active=1 AND m.active=1 ORDER BY a.id');
    const matches = store.all('SELECT id FROM matches WHERE friend_count>=3 ORDER BY CAST(id AS INTEGER)').map(m => publicMatch(matchDetail(store, m.id)));
    const sourceModel=deckModel(store);
    const analysisModel=pick(sourceModel,['specializations','units','updated_at','db_file','version_id']);
    const matchIds=new Set(matches.map(m=>m.id));
    const decks=store.all('SELECT match_id,player_id,spec1,spec2 FROM match_decks').filter(r=>matchIds.has(r.match_id));
    return { members, accounts, matches, analysisModel, decks };
  });
  const staging = path.join(store.directory, `static-export-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(staging);
  let databaseBytes;
  try {
    db.exec(PUBLIC_SCHEMA + 'BEGIN;');
    insert(db, 'members', 'id name active', model.members);
    insert(db, 'accounts', 'id member_id player_id name active', model.accounts);
    insert(db, 'analysis_catalogue', 'key data_json updated_at', [{key:'deck_model',data_json:JSON.stringify(model.analysisModel),updated_at:model.analysisModel.updated_at??null}]);
    insert(db, 'match_decks', 'match_id player_id spec1 spec2', model.decks);
    const catalogues = new Map();
    for (const m of model.matches) {
      const data = Buffer.from(JSON.stringify(m));
      const asset = `matches/${m.id}-${hash(data)}.json`; files.set(asset, data);
      insert(db, 'match_assets', 'id asset', [{ id: m.id, asset }]);
      insert(db, 'matches', 'id end_time duration map_id mode winner_team victory_level friend_count same_team_count detail_state detail_error updated_at raw_json', [{ ...m, detail_error: null, updated_at: null, raw_json: JSON.stringify(m.raw.Data ? { Data: {} } : {}) }]);
      insert(db, 'participants', 'match_id player_id name team_id old_rating new_rating rating_delta destruction losses objectives won raw_json', m.participants.map(p => ({ ...p, raw_json: JSON.stringify({...fields(p.raw, ['DamageDealt', 'DamageReceived', 'DamageFriendlyFireDealt', 'SupplyPointsConsumed', 'SupplyPointsConsumedByAllies', 'SupplyPointsConsumedFromAllies', 'TotalSpawnedUnitScore', 'TotalRefundedUnitScore', 'Destruction', 'Losses', 'TotalExp', 'RawExp']),AnalysisUnitIds:[...new Set(m.units.filter(u=>u.player_id===p.player_id).map(u=>u.unit_id))]}) })));
      insert(db, 'unit_instances', 'match_id player_id net_id unit_id spawn_time death_time refunded kills damage damage_received supply', m.units);
      for (const unit of m.units) if (unit.catalogue) catalogues.set(unit.unit_id, unit.catalogue);
    }
    insert(db, 'unit_catalogue', 'unit_id data_json', [...catalogues].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ unit_id: id, data_json: JSON.stringify(value) })));
    db.exec('COMMIT; VACUUM;'); db.close(); databaseBytes = await readFile(staging);
  } finally { try { db.close(); } catch {} await unlink(staging).catch(() => {}); }
  const compressed = gzipSync(databaseBytes, { level: 9 });
  const databaseHash = hash(compressed); const database = `data/${databaseHash}.sqlite.gz`; files.set(database, compressed);
  for (const member of model.members) member.accounts = model.accounts.filter(a => a.member_id === member.id).map(a => ({ ...a, archived_count: model.matches.filter(m => m.participants.some(p => p.player_id === a.player_id)).length }));
  const manifestData = {
    format: 'court-readonly-v1', title: TITLE, database, database_encoding: 'gzip', members: model.members,
    maps: [...new Set(model.matches.map(m => m.map_id))].sort((a, b) => Number(a) - Number(b)).map(id => ({ map_id: id, name: mapName(id) })),
    modes: [...new Set(model.matches.map(m => m.mode).filter(m => m !== null))].sort().map(mode => ({ mode })),
    matches: model.matches.length, complete: model.matches.filter(m => m.detail_state === 'complete').length,
  };
  const revision = hash(JSON.stringify({ ...manifestData, assets: assetHash }));
  if (previous?.marker.revision === revision) return { changed: false, revision, directory: root, matches: model.matches.length };
  const publishedAt = new Date().toISOString();
  const manifest = { ...manifestData, revision, published_at: publishedAt };
  const html = (await readFile(path.join(ROOT, 'readonly/index.html'), 'utf8')).replaceAll('ASSET_VERSION', assetHash);
  files.set('index.html', Buffer.from(html));
  files.set('.nojekyll', Buffer.from(''));
  files.set('.gitignore', Buffer.from('/.court-static-site.json\n/.court-operation.lock\n*.tmp\n'));
  files.set('_headers', Buffer.from("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'\n/manifest.json\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-cache\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/matches/*\n  Cache-Control: public, max-age=31536000, immutable\n/data/*\n  Cache-Control: public, max-age=31536000, immutable\n"));
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  if (files.size > 20000 || [...files.values()].some(bytes => bytes.length > 25 * 1024 * 1024)) throw new Error('静态站点超过免费 Pages 的文件数量或单文件 25 MiB 限制，保留上一版档案');
  for (const [relative, bytes] of files) if (relative !== 'manifest.json') {
    const target = path.join(root, relative);
    if (!await readFile(target).then(old => old.equals(bytes)).catch(() => false)) await atomic(target, bytes);
  }
  // Publish the manifest last so readers never observe references to half-written data.
  await atomic(path.join(root, 'manifest.json'), files.get('manifest.json'));
  const generations = [{ revision, files: [...files.keys()] }, ...(previous?.marker.generations ?? []).slice(0, 1)];
  await atomic(path.join(root, '.court-static-site.json'), JSON.stringify({ format: 'court-static-output-v1', revision, generations }));
  const retained = new Set(generations.flatMap(g => g.files));
  for (const file of previous?.files ?? []) if (!retained.has(file)) await unlink(path.join(root, file)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  return { changed: true, revision, directory: root, matches: model.matches.length, database_bytes: databaseBytes.length, download_bytes: compressed.length, published_at: publishedAt };
}
