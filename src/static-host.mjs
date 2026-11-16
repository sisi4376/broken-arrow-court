import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { siteInventory } from './static-export.mjs';
import { relayUrl } from './update-relay.mjs';

export const STATIC_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png':'image/png', '.wasm': 'application/wasm', '.sqlite': 'application/vnd.sqlite3', '.gz': 'application/gzip' };
export async function serveStatic(req, res, directory, relativePath) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  try {
    const inventory = await siteInventory(directory);
    const file = decodeURIComponent(relativePath || 'index.html');
    if (!inventory.files.includes(file) || ['.gitignore', '_headers', '.nojekyll'].includes(file)) { res.writeHead(404); res.end(); return; }
    const bytes = await readFile(path.join(inventory.root, file));
    const manifest = file.endsWith('.html') ? JSON.parse(await readFile(path.join(inventory.root, 'manifest.json'), 'utf8')) : {};
    const relay = relayUrl(manifest.update_ntfy?.url || manifest.update_relay_url || '');
    res.writeHead(200, {
      'Content-Type': `${TYPES[path.extname(file)] || 'text/plain'}${['.html', '.js', '.mjs', '.json', '.css'].includes(path.extname(file)) ? '; charset=utf-8' : ''}`,
      'Content-Length': bytes.length, 'Content-Security-Policy': relay ? STATIC_CSP.replace("connect-src 'self'", "connect-src 'self' " + relay) : STATIC_CSP,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': file === 'manifest.json' || file === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('静态档案尚未生成，请稍后刷新。'); }
}
