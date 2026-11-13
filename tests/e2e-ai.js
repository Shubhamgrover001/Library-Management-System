/* Tests for the optional AI helpers. A fake "Anthropic" server stands in for the real API,
 * so no key or internet is needed.   Run:  node tests/e2e-ai.js */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8767, FAKE = 8768, BASE = `http://127.0.0.1:${PORT}`;
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-ai-'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fake upstream: replies by looking at the system prompt
let upstreamCalls = 0, lastKey = null, lastUser = '';
const upstream = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    upstreamCalls++; lastKey = req.headers['x-api-key'];
    const j = JSON.parse(body); lastUser = j.messages[0].content;
    let text = '{}';
    if (/recommend/i.test(j.system)) text = 'Sure! {"picks":[{"isbn":"978-0262033848","reason":"Builds on algorithms"},{"isbn":"not-in-catalog","reason":"x"}]}';
    else if (/staff/i.test(j.system)) text = 'Amit Kumar has Design Patterns overdue.';
    else if (/catalogue/i.test(j.system)) text = '{"genre":"Self-Help","description":"A book about habits.","tags":["habits","productivity"]}';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
  });
});

function startServer(env) {
  return new Promise(async (resolve, reject) => {
    const s = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', LMS_DATA: path.join(tmp, 'd' + Math.random() + '.json'), ANTHROPIC_API_KEY: '', AI_URL: '' }, env), stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/rev'); return resolve(s); } catch (e) { await sleep(100); } }
    reject(new Error('server did not start'));
  });
}
const stop = s => new Promise(r => { s.on('close', r); s.kill(); });
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

async function open(browser, who) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  if (process.env.PDFLIB_PATH) await context.route('**/pdf-lib.min.js', r => r.fulfill({ path: process.env.PDFLIB_PATH, contentType: 'text/javascript' }));
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  await page.evaluate(() => { document.getElementById('splash-screen').style.display = 'none'; });
  await page.fill('#authUsername', who.u); await page.fill('#authPassword', who.p);
  await page.click('text=🚀 Login to Portal'); await page.waitForTimeout(500);
  return page;
}

(async () => {
  await new Promise(r => upstream.listen(FAKE, '127.0.0.1', r));
  const browser = await chromium.launch();
  let srv;
  try {
    console.log('\n1. No API key: AI is off and the app still works');
    srv = await startServer({});
    let r = await fetch(BASE + '/api/ai/status');
    ok(r.status === 200 && (await r.json()).enabled === false, 'status says disabled');
    r = await post('/api/ai/ask', { question: 'hi' });
    ok(r.status === 503, 'AI routes answer 503 without a key');
    let page = await open(browser, { u: 'admin@library.org', p: 'Admin@123' });
    ok(await page.evaluate(() => document.getElementById('aiAskCard').style.display === 'none'), 'assistant card is hidden');
    await page.click('text=📖 Books Catalog'); await page.click('text=+ Add New Book');
    ok(await page.evaluate(() => document.getElementById('aiFillBtn').style.display === 'none'), 'auto-fill button is hidden');
    ok(page.errors.length === 0, 'no page errors');
    await stop(srv);

    console.log('\n2. With a key: server routes');
    srv = await startServer({ ANTHROPIC_API_KEY: 'test-key', AI_URL: `http://127.0.0.1:${FAKE}/v1/messages` });
    ok((await (await fetch(BASE + '/api/ai/status')).json()).enabled === true, 'status says enabled');
    r = await post('/api/ai/recommend', { history: [{ title: 'Clean Code', author: 'x', genre: 'y' }], catalog: [{ isbn: '978-0262033848', title: 'Intro to Algorithms', author: 'Cormen', genre: 'CS' }] });
    let j = await r.json();
    ok(r.status === 200 && j.picks.length === 1 && j.picks[0].isbn === '978-0262033848', 'recommend returns only books that are in the catalog');
    ok(lastKey === 'test-key', 'the key is sent to the upstream by the server');
    r = await post('/api/ai/recommend', { history: [], catalog: [] }); ok(r.status === 400, 'recommend rejects an empty catalog');
    r = await post('/api/ai/ask', { question: '' }); ok(r.status === 400, 'ask rejects an empty question');
    r = await post('/api/ai/ask', { question: 'who is overdue?', context: { x: 1 } });
    ok((await r.json()).answer.includes('Amit'), 'ask returns the answer');
    r = await post('/api/ai/book-details', { title: 'Atomic Habits', author: 'James Clear' });
    j = await r.json(); ok(j.genre === 'Self-Help' && j.tags.length === 2, 'book-details returns genre and tags');
    r = await fetch(BASE + '/api/ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'nope' }); ok(r.status === 400, 'invalid JSON rejected');
    // the server drops the connection once the body is too big, so a reset counts as rejected too
    const big = await fetch(BASE + '/api/ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'x'.repeat(300 * 1024) }) }).then(x => x.status === 413, () => true);
    ok(big, 'oversized body rejected');
    r = await fetch(BASE + '/api/ai/ask'); ok(r.status === 405, 'GET on an AI route is refused');

    console.log('\n3. With a key: browser features');
    page = await open(browser, { u: 'admin@library.org', p: 'Admin@123' });
    await page.waitForFunction(() => ai.enabled);
    ok(await page.evaluate(() => document.getElementById('aiAskCard').style.display !== 'none'), 'assistant card is shown');
    await page.fill('#aiAskInput', 'Who has overdue books?'); await page.click('#aiAskBtn');
    await page.waitForFunction(() => document.getElementById('aiAskOut').textContent.length > 0);
    ok((await page.textContent('#aiAskOut')).includes('Amit Kumar'), 'assistant answer is shown');
    ok(!/@example\.in|9876/.test(lastUser), 'member emails and phone numbers are not sent to the AI');
    await page.click('text=📖 Books Catalog'); await page.click('text=+ Add New Book');
    await page.fill('#newBookTitle', 'Atomic Habits'); await page.fill('#newBookAuthor', 'James Clear'); await page.click('#aiFillBtn');
    await page.waitForFunction(() => document.getElementById('newBookGenre').value === 'Self-Help');
    ok((await page.textContent('#aiFillNote')).includes('habits'), 'auto-fill sets the genre and shows the note');
    ok(page.errors.length === 0, 'no page errors (staff)');

    // add a reader account, wait until the server has it, then log in as that reader in a fresh browser
    const staff = await open(browser, { u: 'admin@library.org', p: 'Admin@123' });
    await staff.evaluate(async () => {
      db.users.push(await makeUser('reader@x.org', 'Test Reader', 'user', 'Reader@123', 'MEM-101')); saveDb();
    });
    for (let i = 0; i < 50; i++) {
      const sv = await (await fetch(BASE + '/api/db')).json();
      if (sv.db.users.some(u => u.id === 'reader@x.org')) break;
      await sleep(200);
    }
    const rp = await open(browser, { u: 'reader@x.org', p: 'Reader@123' });
    await rp.waitForFunction(() => ai.enabled);
    await rp.click('#aiRecBtn');
    await rp.waitForFunction(() => document.getElementById('aiRecOut').textContent.includes('Introduction to Algorithms'));
    ok(true, 'reader sees a recommendation built from the real catalog');
    ok(rp.errors.length === 0, 'no page errors (reader)');
  } finally {
    if (srv) await stop(srv);
    upstream.close(); await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
