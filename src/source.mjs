import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { extractProfile, extractMatchDetail, numericId, parseSearchQuery } from './domain.mjs';
import { reserveRequest, finishRequest } from './request-monitor.mjs';

export class SourceError extends Error {
  constructor(message, status = 0, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

// Head pages share a short cache across manual checks, clients and restarts.
function cacheLifetime(resource) {
  const url = new URL(resource, 'https://local');
  if (url.pathname === '/api/players/matches' && url.searchParams.get('offset') === '0') return 120000;
  if (['/api/dek/db-version', '/api/dek/available-versions'].includes(url.pathname)) return 6 * 3600000;
  if (url.pathname === '/api/units/full' && url.searchParams.has('db_file')) return 7 * 86400000;
  return 0;
}
function validCatalogue(resource, data) {
  const url = new URL(resource, 'https://local');
  if (url.pathname === '/api/players/matches') return Array.isArray(data?.matches) && Number.isInteger(data.totalCount) && data.totalCount >= 0;
  if (url.pathname === '/api/dek/db-version') return typeof data?.dbFileName === 'string' && !!data.dbFileName;
  if (url.pathname === '/api/dek/available-versions') return Array.isArray(data?.versions);
  return String(data?.unit?.id) === url.searchParams.get('unitid');
}

export class SourceClient {
  constructor(store, { base = process.env.SOURCE_BASE_URL || 'https://dash.batrace.top', fetcher = fetch, timeout = 25000, monitorStore = store,transport=null } = {}) {
    this.store = store;
    this.monitorStore = monitorStore;
    this.base = base.replace(/\/$/, '');
    if (!/^https?:\/\//.test(this.base)) throw new Error('SOURCE_BASE_URL 必须是 HTTP(S) 地址');
    this.fetcher = fetcher;
    this.timeout = timeout;
    this.transport=transport??{lastRequest:0,queue:Promise.resolve()};
    this.cooldownKey = `source_cooldown:${this.base}`;
    this.budgetKey = `source_budget_until:${this.base}`;
    this.blockedUntil = Math.max(Number(monitorStore.settings()[this.cooldownKey]) || 0,Number(monitorStore.settings()[this.budgetKey]) || 0);
    this.searchCache = new Map();
    this.inflight = new Map();
    this.onRequest = null;
  }
  get lastRequest(){return this.transport.lastRequest;}
  set lastRequest(value){this.transport.lastRequest=value;}
  get queue(){return this.transport.queue;}
  set queue(value){this.transport.queue=value;}
  async read(resource, { json = true, snapshot = true, minDelay = 0, force = false } = {}) {
    if (!resource.startsWith('/') || resource.startsWith('//')) throw new Error('无效的数据源路径');
    const maxAge = json && snapshot && !force ? cacheLifetime(resource) : 0;
    const key = JSON.stringify([resource, json, snapshot, force]);
    if (this.inflight.has(key)) return structuredClone(await this.inflight.get(key));
    const operation = this.queue.then(async () => {
      if (maxAge) {
        const cached = this.store.get('SELECT payload_gzip,checked_at FROM source_cache WHERE base=? AND resource=?', this.base, resource);
        if (cached && cached.checked_at <= Date.now() && Date.now() - cached.checked_at < maxAge) {
          try {
            const data = JSON.parse(gunzipSync(cached.payload_gzip));
            if (validCatalogue(resource, data)) return data;
          } catch { /* A damaged cache entry is repaired by the next successful read. */ }
        }
      }
      this.blockedUntil = Math.max(this.blockedUntil, Number(this.monitorStore.settings()[this.cooldownKey]) || 0,Number(this.monitorStore.settings()[this.budgetKey]) || 0);
      if (Date.now() < this.blockedUntil) throw new SourceError('数据源限流冷却中，稍后自动重试', 429, this.blockedUntil - Date.now());
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        const delay = Math.max(0, this.lastRequest + Math.max(Number(this.monitorStore.settings().request_delay_ms ?? 1800),Number(minDelay)||0) - Date.now());
        if (delay) await sleep(delay);
        this.blockedUntil=Math.max(this.blockedUntil,Number(this.monitorStore.settings()[this.cooldownKey])||0,Number(this.monitorStore.settings()[this.budgetKey])||0);
        if(Date.now()<this.blockedUntil)throw new SourceError('请求正在冷却，已阻止发送',429,this.blockedUntil-Date.now());
        // No request may be sent when its persistent audit record cannot be saved.
        const record=reserveRequest(this.monitorStore,this.base,resource,attempt+1);
        if(record.blocked){
          this.blockedUntil=record.retryAt;this.monitorStore.setting(this.budgetKey,record.retryAt);
          throw new SourceError(record.reason,429,record.retryAt-Date.now());
        }
        this.lastRequest = Date.now();
        let status=null,bytes=0,failure=null;
        try {
          this.onRequest?.(resource,record);
          const response = await this.fetcher(this.base + resource, {
            headers: { Accept: json ? 'application/json' : 'text/html', 'User-Agent': 'BrokenArrowCourt/1.0 (private friends archive; low-rate requests)' },
            signal: AbortSignal.timeout(this.timeout), redirect: 'manual',
          });
          status=response.status;
          if (response.status === 429 || response.status === 403) {
            const header = response.headers.get('retry-after');
            const retryAfter = Math.max(3600000, Number(header) * 1000 || Date.parse(header) - Date.now() || 3600000);
            this.blockedUntil = Date.now() + retryAfter;
            this.monitorStore.setting(this.cooldownKey, this.blockedUntil);
            throw new SourceError(response.status === 403 ? '数据源拒绝访问，已停止请求并进入冷却' : '数据源限流，已进入冷却', response.status, retryAfter);
          }
          if (!response.ok) throw new SourceError(`数据源 HTTP ${response.status}：${resource}`, response.status);
          const text = await response.text();
          bytes=Buffer.byteLength(text);
          if (bytes > 30 * 1024 * 1024) throw new SourceError('数据源响应超过 30 MB');
          let result;
          try { result = json ? JSON.parse(text) : text; } catch { throw new SourceError('数据源未返回有效 JSON，可能出现访问验证'); }
          if (snapshot) this.store.snapshot(resource, json ? result : text);
          if (json && snapshot && cacheLifetime(resource) && validCatalogue(resource, result)) {
            this.store.run('INSERT INTO source_cache(base,resource,payload_gzip,checked_at) VALUES(?,?,?,?) ON CONFLICT(base,resource) DO UPDATE SET payload_gzip=excluded.payload_gzip,checked_at=excluded.checked_at', this.base, resource, gzipSync(text), Date.now());
          }
          return result;
        } catch (error) {
          lastError = error instanceof SourceError ? error : new SourceError(`连接数据源失败：${error.cause?.message ?? error.message}`);
          failure=lastError.message;
        } finally { finishRequest(this.monitorStore,record.id,{status,bytes,error:failure}); }
        if ((lastError.status>=300&&lastError.status<400)||[400,401,403,404,429].includes(lastError.status)) break;
        if (attempt < 2) await sleep(1200 * (2 ** attempt));
      }
      throw lastError;
    });
    this.queue = operation.catch(() => {});
    this.inflight.set(key, operation);
    try { return await operation; }
    finally { this.inflight.delete(key); }
  }
  async search(input) {
    const query = parseSearchQuery(input);
    if (!query || query.length > 100) throw new Error('请输入 1 至 100 个字符');
    const cached = this.searchCache.get(query);
    if (cached && cached.expires > Date.now()) return cached.data;
    const data = await this.read(`/api/players/search?q=${encodeURIComponent(query)}&limit=20`, { snapshot: false });
    if (!Array.isArray(data.players)) throw new SourceError('玩家搜索返回结构变化');
    this.searchCache.set(query, { expires: Date.now() + 300000, data });
    if (this.searchCache.size > 100) this.searchCache.delete(this.searchCache.keys().next().value);
    return data;
  }
  async profile(id) { return extractProfile(await this.read(`/player/${numericId(id)}`, { json: false })); }
  async matches(id, offset = 0, {force=false} = {}) {
    const data = await this.read(`/api/players/matches?stbid=${numericId(id)}&offset=${offset}&limit=10`,{force});
    if (!Array.isArray(data.matches) || !Number.isInteger(data.totalCount) || data.totalCount < 0) throw new SourceError('对局列表返回结构变化');
    return data;
  }
  async detail(id, {minDelay=0}={}) {
    numericId(id, '对局 ID');
    if (process.env.SOURCE_DETAIL_PATH) {
      const data = await this.read(process.env.SOURCE_DETAIL_PATH.replace('{id}', id),{minDelay});
      const match = data.data ?? data;
      if (!match.Data) throw new SourceError('扩展详情接口缺少 Data');
      return { data: match, metadata: data.metadata ?? {} };
    }
    return extractMatchDetail(await this.read(`/match/${id}`, { json: false,minDelay }));
  }
  async units(ids) {
    const data = await this.read(`/api/dek/units/batch?unit_ids=${ids.map((id) => numericId(id, '单位 ID')).join(',')}`);
    if (!Array.isArray(data.units)) throw new SourceError('单位资料返回结构变化');
    return data.units;
  }
}
