export const UPDATE_REQUEST_INTERVAL_MS = 10 * 60000;
// The public relay never receives local credentials or database contents.
export function relayUrl(value = '') {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('更新请求服务必须使用不含路径或凭据的 HTTPS 地址');
  return url.origin;
}

export class UpdateRelay {
  constructor(store, engine, publication, { url = '', token = '', fetcher = fetch, clock = Date.now } = {}) {
    this.store = store; this.engine = engine; this.publication = publication;
    this.url = relayUrl(url); this.token = token; this.fetcher = fetcher;
    this.clock = clock;
  }
  async call(route, body) {
    const response = await this.fetcher(this.url + route, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`更新请求服务暂不可用（${response.status}）`);
    return response.json();
  }
  async tick() {
    if (this.stopped || this.active || !this.url || !this.token || this.engine.active || this.engine.stopped) return;
    this.active = this.run().catch(error => {
      if (this.lastError !== error.message) this.store.event(null, 'warning', error.message);
      this.lastError = error.message;
    }).finally(() => { this.active = null; });
    await this.active;
  }
  async run() {
    // Wait through source cooldowns; never turn a blocked request into a successful no-op.
    if (Date.now() < this.engine.source.blockedUntil || !this.store.get('SELECT id FROM accounts WHERE active=1 LIMIT 1')) return;
    const { request } = await this.call('/next');
    this.lastError = null;
    if (!request) return;
    if (!/^[a-f0-9]{32}$/.test(request.id)) throw new Error('无效的更新请求编号');
    const key = `remote_update:${request.id}`;
    let receipt = this.store.settings()[key];
    if (!receipt) {
      // No await between checking engine.active and starting this request.
      if (this.engine.active || this.stopped) return;
      const started = this.store.transaction(() => {
        const at = this.clock();
        const nextAllowedAt = Math.max(Number(this.store.settings().remote_update_next_allowed_at)||0,this.engine.cooldown?.(at).next_allowed_at||0);
        if (at < nextAllowedAt) {
          this.store.setting(key, { result: 'cooldown', next_allowed_at: nextAllowedAt });
          return false;
        }
        const next = at + (this.store.policy?.sync_cooldown_ms||UPDATE_REQUEST_INTERVAL_MS);
        // Reserve the global window and create the run/receipt in one transaction.
        // It survives restarts and does not depend on browser-side throttling.
        this.store.setting('remote_update_next_allowed_at', next);
        const result = this.engine.request('incremental', { manual: true, requestId: request.id });
        if (!result.started) throw new Error('同步服务暂忙，请稍后重试');
        this.store.setting(key, { ...this.store.settings()[key], next_allowed_at: next });
        return true;
      });
      if (started) {
        this.store.event(null, 'info', `收到群友更新请求 ${request.id.slice(0, 8)}，开始增量同步`);
        await this.engine.active;
      }
      receipt = this.store.settings()[key];
    }
    // run_id is saved atomically with sync_runs creation. An interrupted run is
    // reported as failed after restart rather than silently crawled twice.
    if (!receipt) throw new Error('未能登记更新请求');
    if (!receipt.result) {
      const run = this.store.get('SELECT status FROM sync_runs WHERE id=?', receipt.run_id);
      while (this.engine.active) await this.engine.active;
      receipt.next_allowed_at=Math.max(receipt.next_allowed_at||0,this.engine.cooldown?.().next_allowed_at||0);
      await this.publication.tick({ forcePush: true });
      while (this.publication.active) await this.publication.active;
      const publication = await this.publication.status();
      receipt.result = run?.status === 'complete' && publication.configured && publication.status === 'complete' && !publication.last_error ? 'complete' : 'failed';
      this.store.setting(key, receipt);
    }
    await this.call('/ack', { id: request.id, status: receipt.result, next_allowed_at: receipt.next_allowed_at || 0 });
    const message = receipt.result === 'complete' ? '同步及网页发布已完成' : receipt.result === 'cooldown' ? '更新请求冷却中，本次请求不重复采集' : '任务未完整完成，请检查同步与发布日志';
    this.store.event(null, receipt.result === 'failed' ? 'warning' : 'info', `群友更新请求 ${request.id.slice(0, 8)}：${message}`);
  }
  start() { if (!this.url || !this.token) return; this.timer = setInterval(() => this.tick(), 15000); this.timer.unref(); this.tick(); }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.active; }
}
