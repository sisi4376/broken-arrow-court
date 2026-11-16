import { UpdateRelay } from './update-relay.mjs';
import { ntfyConfig, ntfyMessages, ntfyPublish } from '../public/ntfy-transport.js';

export class NtfyUpdateRelay extends UpdateRelay {
  constructor(store, engine, publication, { url = 'https://ntfy.sh', topic = '', fetcher = fetch } = {}) {
    const config = ntfyConfig({ url, topic });
    super(store, engine, publication, { url: config?.url || '', token: config ? 'anonymous-ntfy' : '', fetcher });
    this.config = config; this.stateKey = `ntfy_queue:${config?.url}/${topic}`;
  }
  state() { return this.store.settings()[this.stateKey] || { pending: [], acknowledged: [] }; }
  async call(route, body) {
    let state = this.state();
    if (route === '/next') {
      if (!state.pending.length) {
        const messages = await ntfyMessages(this.config, this.fetcher);
        const ids = messages.filter(m => m.format === 'court-update-request-v1' && !state.acknowledged.includes(m.id)).map(m => m.id);
        state.pending = [...new Set(ids)];
        // Persist the whole received batch before crawling, so cloud expiry or
        // a restart cannot lose the other requests in this batch.
        this.store.setting(this.stateKey, state);
      }
      return { request: state.pending.length ? { id: state.pending[0] } : null };
    }
    if (route === '/ack') {
      await ntfyPublish(this.config, { format: 'court-update-result-v1', ...body }, this.fetcher);
      state = this.state();
      state.pending = state.pending.filter(id => id !== body.id);
      state.acknowledged = [...new Set([...state.acknowledged, body.id])].slice(-1000);
      this.store.setting(this.stateKey, state);
      return { ok: true };
    }
    throw new Error('无效的中转操作');
  }
}
