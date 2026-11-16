import { normalizeMatch } from './domain.mjs';
import { localProfile } from './profile-stats.mjs';

export const MATCH_QUERY_QUIET_MS = 45 * 60000;
const quietKey = playerId => `account_query_quiet:${playerId}`;
export const queryQuietEnabled = store => store.settings().match_query_quiet_enabled === true;
function savedQuiet(store, playerId) {
  const row = store.get('SELECT value FROM settings WHERE key=?', quietKey(playerId));
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

export function accountQueryState(store, playerId, at = Date.now()) {
  if (!queryQuietEnabled(store)) return { query_silent: false, query_quiet_until: null, query_quiet_match_id: null };
  const value = savedQuiet(store, playerId);
  const silent = Number.isSafeInteger(value?.until) && value.until > at;
  return { query_silent: silent, query_quiet_until: silent ? value.until : null, query_quiet_match_id: silent ? value.match_id : null };
}

// Use saved lifetime statistics and the local projection; ranking never fetches.
export function accountGameCount(store, account) {
  const stat = localProfile(store, account).data.statInfo ?? {};
  const lifetime = ['fightsCountRt', 'fightsCountCt', 'fightsCountSk']
    .reduce((total, key) => total + (Number.isFinite(stat[key]) && stat[key] >= 0 ? stat[key] : 0), 0);
  const local = store.get('SELECT COUNT(*) n FROM account_matches WHERE account_id=?', account.id).n;
  return Math.max(lifetime, Number(account.backfill_total) || 0, Number(account.recent_target) || 0, local);
}

export function quietMatchAccounts(store, matchId, data, discoveredPlayerId = null, at = Date.now()) {
  if (!queryQuietEnabled(store)) return [];
  const match = normalizeMatch(matchId, data);
  const ended = match.endTime * 1000;
  const until = ended + MATCH_QUERY_QUIET_MS;
  // Missing/future end times must not indefinitely suppress a registered account.
  if (!Number.isSafeInteger(ended) || ended <= 0 || ended > at || until <= at) return [];
  const players = new Set(match.participants.filter(p => p.teamId !== 100 && /^[1-9]\d*$/.test(p.playerId)).map(p => p.playerId));
  if (discoveredPlayerId !== null) players.add(String(discoveredPlayerId));
  const accounts = store.all('SELECT player_id FROM accounts').filter(a => players.has(a.player_id));
  return store.transaction(() => {
    const changed = [];
    for (const account of accounts) {
      const previous = savedQuiet(store, account.player_id);
      if (Number.isSafeInteger(previous?.until) && previous.until >= until) continue;
      store.setting(quietKey(account.player_id), { until, match_id: String(matchId), ended_at: ended });
      changed.push(account.player_id);
    }
    return changed;
  });
}
