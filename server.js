/* LMS Portal sync server: zero dependencies, Node 18+.
 *   node server.js            (or: npm start)
 * Serves index.html and keeps the app data in a JSON file so every browser and
 * device that opens the portal sees the same library. If no server is running,
 * index.html still works on its own with browser storage.
 *
 * Env: PORT (default 3000), HOST (default 127.0.0.1), LMS_DATA (default ./data/lms-data.json)
 *
 * API (all replies carry the header X-LMS-Sync: 1):
 *   GET  /api/rev  -> { rev }
 *   GET  /api/db   -> { rev, db }            (404 { empty:true } until first save)
 *   PUT  /api/db   body { baseRev, db }      200 { rev } | 409 { rev, db } if baseRev is stale
 *
 * NOTE: login is still checked in the browser, so anyone who can reach this port can
 * read the data (including password hashes). Keep HOST on 127.0.0.1 or a trusted
 * network; this is not meant to be exposed to the internet as it is. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.LMS_DATA || path.join(__dirname, 'data', 'lms-data.json'));
const MAX_BODY = 5 * 1024 * 1024;
const STATIC = { '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm' };

let store = { rev: 0, db: null };
try {
  const s = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (s && Number.isInteger(s.rev) && validDb(s.db)) store = s;
} catch (e) { /* first run */ }

function validDb(d) {
  return !!d && typeof d === 'object' && ['books', 'members', 'txns', 'users'].every(k => Array.isArray(d[k]));
}
function persist() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  if (fs.existsSync(DATA)) fs.copyFileSync(DATA, DATA + '.bak'); // keep the previous version
  fs.renameSync(tmp, DATA); // atomic swap, so a crash never leaves half a file
}
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-LMS-Sync': '1', 'X-Content-Type-Options': 'nosniff' }, extra));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function api(req, res, route) {
  if (route === '/api/rev' && req.method === 'GET') return send(res, 200, { rev: store.rev });
  if (route === '/api/db' && req.method === 'GET') {
    return store.db ? send(res, 200, store) : send(res, 404, { empty: true, rev: store.rev });
  }
  if (route === '/api/db' && req.method === 'PUT') {
    let msg;
    try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'payload too large' : 'invalid JSON' }); }
    if (!msg || !validDb(msg.db) || !Number.isInteger(msg.baseRev)) return send(res, 400, { error: 'expected { baseRev, db }' });
    if (store.db && msg.baseRev !== store.rev) return send(res, 409, store); // someone saved first
    store = { rev: store.rev + 1, db: msg.db };
    try { persist(); } catch (e) { console.error('save failed:', e.message); return send(res, 500, { error: 'could not save' }); }
    return send(res, 200, { rev: store.rev });
  }
  return send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer((req, res) => {
  const route = (req.url || '/').split('?')[0];
  if (route.startsWith('/api/')) return api(req, res, route).catch(() => send(res, 500, { error: 'server error' }));
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  // only top-level public files: no folders, no dotfiles, no server code or data
  let name;
  try { name = decodeURIComponent(route).replace(/^\/+/, '') || 'index.html'; } catch (e) { res.writeHead(400); return res.end(); }
  const ext = path.extname(name).toLowerCase();
  const isSw = name === 'sw.js'; // the only script we serve (never server.js)
  if (name.includes('/') || name.includes('\\') || name.startsWith('.') || !(STATIC[ext] || isSw)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': isSw ? 'text/javascript; charset=utf-8' : STATIC[ext], 'X-Content-Type-Options': 'nosniff' };
    if (isSw) headers['Cache-Control'] = 'no-cache'; // browsers must always check for a new worker
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.listen(PORT, HOST, () => console.log(`LMS Portal running at http://${HOST}:${PORT}  (data: ${DATA})`));
