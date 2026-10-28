/* Tests for server.js (sync backend) and the browser's sync behaviour.
 * Run:  node tests/e2e-sync.js   (starts its own server on port 8766 with a temp data file) */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8766, BASE = `http://127.0.0.1:${PORT}`;
const root = path.resolve(__dirname, '..');
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lms-sync-')), 'lms-data.json');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; failures.push(msg); console.log('  ✗ ' + msg); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

let srv = null;
async function startServer() {
  srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', LMS_DATA: dataFile }), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/rev'); return; } catch (e) { await sleep(100); } }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!srv) return;
  const s = srv; srv = null;
  await new Promise(r => { s.on('close', r); s.kill(); });
}
const put = body => fetch(BASE + '/api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function open(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  if (process.env.PDFLIB_PATH) await context.route('**/pdf-lib.min.js', r => r.fulfill({ path: process.env.PDFLIB_PATH, contentType: 'text/javascript' }));
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  await page.evaluate(() => { document.getElementById('splash-screen').style.display = 'none'; });
  return page;
}

(async () => {
  await startServer();
  const browser = await chromium.launch();
  try {
    console.log('\n1. Server API & safety');
    let r = await fetch(BASE + '/api/db');
    ok(r.status === 404 && r.headers.get('x-lms-sync') === '1', 'empty server answers 404 with the sync header');
    r = await put('not json'); ok(r.status === 400, 'invalid JSON rejected (400)');
    r = await put({ baseRev: 0, db: { books: [] } }); ok(r.status === 400, 'incomplete data rejected (400)');
    r = await put({ baseRev: 0, db: { books: [], members: [], txns: [], users: [] } });
    ok(r.status === 200 && (await r.json()).rev === 1, 'first save accepted, rev becomes 1');
    r = await put({ baseRev: 0, db: { books: [], members: [], txns: [], users: [] } });
    ok(r.status === 409 && (await r.json()).rev === 1, 'stale save rejected (409) with current rev');
    for (const u of ['/server.js', '/package.json', '/tests/e2e.js', '/data/lms-data.json', '/.git/config', '/%2e%2e/etc/passwd', '/node_modules/x.js']) {
      r = await fetch(BASE + u); if (r.status === 200) { ok(false, 'private file served: ' + u); }
    }
    ok(true, 'server code, data and dotfiles are not served');
    r = await fetch(BASE + '/index.html'); ok(r.status === 200 && (await r.text()).includes('LMS'), 'index.html is served');
    await stopServer(); fs.rmSync(dataFile, { force: true }); await startServer(); // clean slate for the browser tests

    console.log('\n2. Two devices share one library');
    const A = await open(browser);
    ok(await A.evaluate(() => sync.on), 'browser detects the sync server');
    await A.evaluate(() => { db.books.push({ isbn: '978-1111111111', title: 'Sync Test Book', author: 'Tester', genre: 'Test', total: 2, price: 199 }); saveDb(); });
    await A.waitForFunction(() => !sync.dirty && !sync.busy && sync.rev >= 1);
    ok(fs.readFileSync(dataFile, 'utf8').includes('Sync Test Book'), 'a change is written to the server file');
    ok(await A.isVisible('#syncBadge'), 'sync badge is shown');
    const B = await open(browser); // fresh browser profile, no local data
    ok(await B.evaluate(() => db.books.some(b => b.title === 'Sync Test Book')), 'a second device loads the first device\'s data');
    await B.evaluate(() => { db.members.push({ id: 'MEM-777', name: 'Sync Member', email: 'sync@example.in', contact: '9876500000' }); saveDb(); });
    await A.waitForFunction(() => db.members.some(m => m.id === 'MEM-777'), null, { timeout: 15000 }).then(() => ok(true, 'first device picks up the second device\'s change by itself'), () => ok(false, 'first device picks up the second device\'s change by itself'));

    console.log('\n3. Conflicts, persistence, fallback');
    await A.evaluate(() => { sync.rev = 0; db.books.push({ isbn: '978-2222222222', title: 'Stale Write', author: 'X', genre: 'X', total: 1, price: 1 }); saveDb(); });
    await A.waitForFunction(() => /Someone else saved first/.test(document.getElementById('toast').textContent), null, { timeout: 5000 }).then(() => ok(true, 'stale save shows a "someone else saved first" notice'), () => ok(false, 'stale save shows a notice'));
    ok(await A.evaluate(() => !db.books.some(b => b.title === 'Stale Write') && db.members.some(m => m.id === 'MEM-777')), 'stale save is not applied; latest server data is loaded');
    await stopServer(); await startServer();
    const C = await open(browser);
    ok(await C.evaluate(() => db.books.some(b => b.title === 'Sync Test Book') && db.members.some(m => m.id === 'MEM-777')), 'data survives a server restart');
    await A.evaluate(() => { db.members.push({ id: 'MEM-778', name: 'Offline Edit', email: 'off@example.in', contact: '9876500001' }); saveDb(); });
    await stopServer();
    await A.waitForTimeout(1500);
    ok(await A.evaluate(() => sync.dirty === true && db.members.some(m => m.id === 'MEM-778') && !!localStorage.getItem('lms_db_v2')), 'edit made while the server is down is kept locally and queued');
    await startServer();
    await C.waitForFunction(() => db.members.some(m => m.id === 'MEM-778'), null, { timeout: 20000 }).then(() => ok(true, 'edit made while offline is uploaded when the server returns'), () => ok(false, 'edit made while offline is uploaded when the server returns'));
    console.log('\n4. Installable app & offline mode (PWA)');
    r = await fetch(BASE + '/manifest.webmanifest');
    const mf = await r.json().catch(() => ({}));
    ok(r.status === 200 && mf.display === 'standalone' && (mf.icons || []).length >= 2, 'web app manifest is served');
    const iconOk = await Promise.all((mf.icons || []).map(i => fetch(BASE + '/' + i.src).then(x => x.status === 200 && x.headers.get('content-type') === 'image/png')));
    ok(iconOk.length >= 2 && iconOk.every(Boolean), 'manifest icons exist');
    r = await fetch(BASE + '/sw.js'); ok(r.status === 200 && /javascript/.test(r.headers.get('content-type')), 'service worker script is served');
    r = await fetch(BASE + '/server.js'); ok(r.status === 404, 'server.js is still private');
    const D = await open(browser);
    await D.evaluate(() => navigator.serviceWorker.ready);
    await D.reload(); await D.waitForFunction(() => typeof db !== 'undefined' && db);
    ok(await D.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
    await D.context().setOffline(true);
    await D.reload(); await D.waitForFunction(() => typeof db !== 'undefined' && db, null, { timeout: 15000 });
    ok(await D.evaluate(() => document.title.includes('LMS Portal') && db.books.length > 0), 'app opens with no network (from cache) and shows its data');
    await D.evaluate(() => { document.getElementById('splash-screen').style.display = 'none'; });
    await D.fill('#authUsername', 'admin@library.org'); await D.fill('#authPassword', 'Admin@123'); await D.click('text=🚀 Login to Portal'); await D.waitForTimeout(400);
    ok(await D.evaluate(() => !!currentUser), 'login and navigation work offline');
    await D.context().setOffline(false);
    ok(A.errors.length + B.errors.length + C.errors.length === 0, 'no JS errors (' + [...A.errors, ...B.errors, ...C.errors].join('|') + ')');
  } finally {
    await browser.close();
    await stopServer();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
