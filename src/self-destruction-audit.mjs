import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { selfDestructionStats, SELF_DESTRUCTION_VERSION } from './self-destruction.mjs';
import { normalizeMatch } from './domain.mjs';

const hash = v => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
function instances(detail) {
  return Object.entries(detail?.data?.Data ?? {}).flatMap(([pid,p]) => Object.entries(p.UnitData ?? {}).map(([net,raw]) => ({ player_id: String(p.Id ?? pid), net_id: String(net), raw })));
}
export function detailEvidence(detail) {
  const units = instances(detail);
  return { units: units.length, lifecycle: units.filter(u => u.raw.SpawnTime > 0 || u.raw.DeathTime > 0).length, self: units.filter(u => u.raw.SelfDestruction === true).length };
}
export function canImproveDetail(id, current, fresh) {
  try{normalizeMatch(id, fresh.data);}catch{return false;}
  const old = detailEvidence(current), next = detailEvidence(fresh);
  if (!current) return next.units > 0;
  if (current.data.EndTime !== fresh.data.EndTime || String(current.data.MapId) !== String(fresh.data.MapId)) return false;
  const players = Object.keys(current.data.Data).sort().join(',');
  if (players !== Object.keys(fresh.data.Data).sort().join(',')) return false;
  const units = new Map(instances(fresh).map(u => [u.player_id + ':' + u.net_id, u.raw]));
  for (const u of instances(current)) {
    const replacement = units.get(u.player_id + ':' + u.net_id);
    if (!replacement || String(replacement.Id) !== String(u.raw.Id) || u.raw.SelfDestruction === true && replacement.SelfDestruction !== true) return false;
  }
  return next.units >= old.units && next.lifecycle >= old.lifecycle && next.self >= old.self && (next.units > old.units || next.lifecycle > old.lifecycle || next.self > old.self);
}
export function auditSelfDestruction(store) {
  const repairs = [], matches = store.all('SELECT id,detail_json,detail_state,end_time FROM matches ORDER BY end_time DESC');
  let units = 0, archivedFlags = 0, parsed = 0;
  const missingDetails = [];
  for (const m of matches) {
    let detail; try { detail = m.detail_json ? JSON.parse(m.detail_json) : null; } catch {}
    if (!detail) { missingDetails.push(m.id); continue; }
    parsed++;
    const expected = instances(detail), rows = store.all('SELECT player_id,net_id,raw_json FROM unit_instances WHERE match_id=?', m.id);
    const stored = new Map(rows.map(r => { let raw;try{raw=JSON.parse(r.raw_json);}catch{raw=null;}return [r.player_id + ':' + r.net_id,raw]; }));
    units += expected.length; archivedFlags += expected.filter(u => u.raw.SelfDestruction === true).length;
    const lost = expected.filter(u => !stored.has(u.player_id + ':' + u.net_id));
    const stale = expected.filter(u => stored.has(u.player_id + ':' + u.net_id) && hash(stored.get(u.player_id + ':' + u.net_id)) !== hash(u.raw));
    if (lost.length || stale.length || expected.length !== rows.length) repairs.push({ id: m.id, detail, missing: lost.length, changed: stale.length, extra: rows.length - expected.length + lost.length });
  }
  let snapshotVersions=0,snapshotErrors=0;
  const known=new Map(matches.map(m=>[m.id,m]));
  for(const r of store.all("SELECT source_key,payload_gzip FROM source_snapshots WHERE source_key LIKE 'match-detail:%' ORDER BY fetched_at,id")){
    snapshotVersions++;
    try{
      const id=r.source_key.slice('match-detail:'.length),m=known.get(id);if(!m)continue;
      const fresh=JSON.parse(gunzipSync(r.payload_gzip)),existing=repairs.find(c=>c.id===id),current=existing?.detail??(m.detail_json?JSON.parse(m.detail_json):null);
      if(m.end_time&&fresh.data.EndTime!==m.end_time)continue;
      if(canImproveDetail(id,current,fresh)){
        const entry={id,detail:fresh,source:'saved_snapshot',missing:0,changed:0,extra:0};
        if(existing)Object.assign(existing,entry);else repairs.push(entry);
      }
    }catch{snapshotErrors++;}
  }
  const model = selfDestructionStats(store, { sql: 'm.friend_count>=3', args: [] });
  const uncertain = new Map();
  for (const m of model.members.values()) for (const c of m.unknown) {
    const record = uncertain.get(c.match_id) ?? { id: c.match_id, end_time: c.end_time, reasons: [] };
    if (!record.reasons.includes(c.reason)) record.reasons.push(c.reason);
    uncertain.set(c.match_id, record);
  }
  return { model: SELF_DESTRUCTION_VERSION, matches: matches.length, parsed, units, archived_flags: archivedFlags, snapshot_versions:snapshotVersions,snapshot_errors:snapshotErrors,repairs, missing_details: missingDetails,
    uncertain_matches: [...uncertain.values()].sort((a,b) => b.end_time-a.end_time),
    members: [...model.members].map(([id,m]) => ({ member_id: id, confirmed: m.total, ranked: m.ranked, auditable_games: m.samples, uncertain_games: m.excluded })) };
}
export async function repairSelfDestruction(store, { source, refresh = 0, ids = [], apply = false, onProgress = () => {}, maxFailures = 3 } = {}) {
  const before = auditSelfDestruction(store), fetched = [], candidates = [...before.repairs];
  const queue = [...new Set([...ids, ...before.missing_details, ...before.uncertain_matches.map(m => m.id)])].slice(0, refresh);
  let failures = 0;
  for (const id of queue) {
    try {
      const row = store.get('SELECT detail_json FROM matches WHERE id=?', id); if (!row) continue;
      const current = row.detail_json ? JSON.parse(row.detail_json) : null, fresh = await source.detail(id);
      const improves = canImproveDetail(id, current, fresh);
      fetched.push({ id, status: improves ? 'improved' : hash(current?.data) === hash(fresh.data) ? 'unchanged' : 'no_safe_improvement', before: detailEvidence(current), after: detailEvidence(fresh) });
      if (improves) candidates.push({ id, detail: fresh, source: 'upstream' });
      failures = 0;
    } catch (e) {
      fetched.push({ id, status: 'unavailable', message: e.message }); failures++;
      if ([403,429].includes(e.status) || failures >= maxFailures) { onProgress(fetched.at(-1)); break; }
    }
    onProgress(fetched.at(-1));
  }
  const unique = new Map(candidates.map(c => [c.id,c]));
  let backup = null;
  if (apply && unique.size) {
    backup = await store.backup();
    for (const c of unique.values()) { store.saveDetail(c.id, c.detail); onProgress({ id: c.id, status: 'repaired' }); }
  }
  return { ...before, repairs: before.repairs.map(({detail,...r}) => r), refresh_requested: refresh, fetched,
    repair_candidates: unique.size, repaired: apply ? unique.size : 0, backup: backup ? true : false,
    after: apply && unique.size ? auditSelfDestruction(store).members : before.members };
}
