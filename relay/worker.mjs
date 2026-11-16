const ID = /^[a-f0-9]{32}$/;
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
    if (origin === env.SITE_ORIGIN) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (!env.CONSUMER_TOKEN || env.CONSUMER_TOKEN.length < 32) return reply({ error: '服务尚未配置' }, 503);
    if (request.method === 'OPTIONS') return new Response(null, { status: origin === env.SITE_ORIGIN ? 204 : 403, headers });
    const url = new URL(request.url), route = url.pathname;
    try {
      if (route === '/next' || route === '/ack') {
        if (request.headers.get('Authorization') !== `Bearer ${env.CONSUMER_TOKEN}`) return reply({ error: '无权访问' }, 401);
        if (route === '/next' && request.method === 'GET') return reply({ request: await env.DB.prepare("SELECT id FROM requests WHERE status='queued' ORDER BY created_at,id LIMIT 1").first() });
        if (route === '/ack' && request.method === 'POST') {
          const body = await request.json();
          if (!ID.test(body.id) || !['complete','failed','cooldown'].includes(body.status)) return reply({ error: '无效参数' }, 400);
          await env.DB.prepare("UPDATE requests SET status=?,finished_at=?,next_allowed_at=? WHERE id=? AND status='queued'").bind(body.status, Date.now(), Number(body.next_allowed_at) || 0, body.id).run();
          return reply({ ok: true });
        }
        return reply({ error: '无效方法' }, 405);
      }
      if (origin !== env.SITE_ORIGIN) return reply({ error: '请从公开网站操作' }, 403);
      if (route === '/requests' && request.method === 'POST') {
        if (Number(request.headers.get('Content-Length') || 0) > 512) return reply({ error: '请求过大' }, 413);
        const raw = await request.text();
        if (raw.length > 512) return reply({ error: '请求过大' }, 413);
        const { id } = JSON.parse(raw);
        if (!ID.test(id)) return reply({ error: '无效请求编号' }, 400);
        const prior = await env.DB.prepare('SELECT status,next_allowed_at FROM requests WHERE id=?').bind(id).first();
        if (prior) return reply({ id, ...prior });
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.CONSUMER_TOKEN + ':' + ip));
        const visitor = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        const now = Date.now();
        // One atomic statement enforces cooldown and queue limits under concurrency.
        const result = await env.DB.prepare(`INSERT OR IGNORE INTO requests(id,visitor,created_at)
          SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM requests WHERE visitor=? AND created_at>?)
          AND (SELECT COUNT(*) FROM requests WHERE status='queued')<20
          AND (SELECT COUNT(*) FROM requests WHERE created_at>?)<100`).bind(id, visitor, now, visitor, now - 60000, now - 86400000).run();
        if (!result.meta.changes) {
          const duplicate = await env.DB.prepare('SELECT status FROM requests WHERE id=?').bind(id).first();
          return duplicate ? reply({ id, status: duplicate.status }) : reply({ error: '请求较多，请一分钟后重试' }, 429);
        }
        return reply({ id, status: 'queued' }, 202);
      }
      if (route.startsWith('/requests/') && request.method === 'GET') {
        const id = route.slice('/requests/'.length);
        if (!ID.test(id)) return reply({ error: '无效编号' }, 400);
        const row = await env.DB.prepare('SELECT status,next_allowed_at FROM requests WHERE id=?').bind(id).first();
        return row ? reply({ id, ...row }) : reply({ error: '未找到请求' }, 404);
      }
      return reply({ error: '未找到接口' }, 404);
    } catch { return reply({ error: '服务暂不可用，请稍后重试' }, 503); }
  },
  async scheduled(event, env) {
    // Never discard offline queued requests; retain terminal receipts for 30 days.
    await env.DB.prepare("DELETE FROM requests WHERE status!='queued' AND finished_at<?").bind(Date.now() - 30 * 86400000).run();
  },
};
