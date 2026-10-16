import { setTimeout as sleep } from 'node:timers/promises';
import { extractProfile, extractMatchDetail, numericId, parseSearchQuery } from './domain.mjs';

export class SourceError extends Error {
  constructor(message, status = 0, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

export class SourceClient {
  constructor(store, { base = process.env.SOURCE_BASE_URL || 'https://dash.batrace.top', fetcher = fetch, timeout = 25000 } = {}) {
    this.store = store;
    this.base = base.replace(/\/$/, '');
    if (!/^https?:\/\//.test(this.base)) throw new Error('SOURCE_BASE_URL 必须是 HTTP(S) 地址');
    this.fetcher = fetcher;
    this.timeout = timeout;
    this.lastRequest = 0;
    this.blockedUntil = 0;
    this.queue = Promise.resolve();
    this.searchCache = new Map();
    this.onRequest = null;
  }
  async read(resource, { json = true, snapshot = true } = {}) {
    if (!resource.startsWith('/') || resource.startsWith('//')) throw new Error('无效的数据源路径');
    const operation = this.queue.then(async () => {
      if (Date.now() < this.blockedUntil) throw new SourceError('数据源限流冷却中，稍后自动重试', 429, this.blockedUntil - Date.now());
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        const delay = Math.max(0, this.lastRequest + Number(this.store.settings().request_delay_ms ?? 1800) - Date.now());
        if (delay) await sleep(delay);
        this.lastRequest = Date.now();
        this.onRequest?.(resource);
        try {
          const response = await this.fetcher(this.base + resource, {
            headers: { Accept: json ? 'application/json' : 'text/html', 'User-Agent': 'BrokenArrowCourt/1.0 (private friends archive; low-rate requests)' },
            signal: AbortSignal.timeout(this.timeout), redirect: 'follow',
          });
          if (response.status === 429 || response.status === 403) {
            const header = response.headers.get('retry-after');
            const retryAfter = Math.max(60000, Number(header) * 1000 || Date.parse(header) - Date.now() || 300000);
            this.blockedUntil = Date.now() + retryAfter;
            throw new SourceError(response.status === 403 ? '数据源拒绝访问，已停止请求并进入冷却' : '数据源限流，已进入冷却', response.status, retryAfter);
          }
          if (!response.ok) throw new SourceError(`数据源 HTTP ${response.status}：${resource}`, response.status);
          const text = await response.text();
          if (Buffer.byteLength(text) > 30 * 1024 * 1024) throw new SourceError('数据源响应超过 30 MB');
          let result;
          try { result = json ? JSON.parse(text) : text; } catch { throw new SourceError('数据源未返回有效 JSON，可能出现访问验证'); }
          if (snapshot) this.store.snapshot(resource, json ? result : text);
          return result;
        } catch (error) {
          lastError = error instanceof SourceError ? error : new SourceError(`连接数据源失败：${error.cause?.message ?? error.message}`);
          if ([400,401,403,404,429].includes(lastError.status)) break;
          if (attempt < 2) await sleep(1200 * (2 ** attempt));
        }
      }
      throw lastError;
    });
    this.queue = operation.catch(() => {});
    return operation;
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
  async matches(id, offset = 0) {
    const data = await this.read(`/api/players/matches?stbid=${numericId(id)}&offset=${offset}&limit=10`);
    if (!Array.isArray(data.matches) || !Number.isInteger(data.totalCount) || data.totalCount < 0) throw new SourceError('对局列表返回结构变化');
    return data;
  }
  async detail(id) {
    numericId(id, '对局 ID');
    if (process.env.SOURCE_DETAIL_PATH) {
      const data = await this.read(process.env.SOURCE_DETAIL_PATH.replace('{id}', id));
      const match = data.data ?? data;
      if (!match.Data) throw new SourceError('扩展详情接口缺少 Data');
      return { data: match, metadata: data.metadata ?? {} };
    }
    return extractMatchDetail(await this.read(`/match/${id}`, { json: false }));
  }
  async units(ids) {
    const data = await this.read(`/api/dek/units/batch?unit_ids=${ids.map((id) => numericId(id, '单位 ID')).join(',')}`);
    if (!Array.isArray(data.units)) throw new SourceError('单位资料返回结构变化');
    return data.units;
  }
}
