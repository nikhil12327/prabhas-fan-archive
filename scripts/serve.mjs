// Dependency-free static server for local preview: `node scripts/serve.mjs`
// Serves ./public with correct content types. API routes return 501 locally
// (they only run on Vercel), so the UI's error paths can be exercised too.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }

  // API routes are Vercel-only.
  if (path.startsWith('/api/')) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API runs on Vercel; run `vercel dev` to test locally.' }));
    return;
  }

  const rel = normalize(path).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT + sep) && file !== ROOT) { res.writeHead(403).end('Forbidden'); return; }

  let target = file;
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = join(target, 'index.html');
  } catch {
    // allow extension-less directory URLs like /admin
    try { const s = await stat(target + '.html'); if (s.isFile()) target += '.html'; }
    catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not found'); return; }
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
