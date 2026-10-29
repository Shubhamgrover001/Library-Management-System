/* Tests for fine receipts, search/filters, book covers, backup/restore.
 * Run: node tests/e2e-polish.js  (starts its own server on port 8767) */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const PORT = 8767, BASE = `http://127.0.0.1:${PORT}`, root = path.resolve(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; failures.push(m); console.log('  ✗ ' + m); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-pol-'));
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), LMS_DATA: path.join(tmp, 'd.json') }), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/rev'); break; } catch (e) { await sleep(100); } }
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, acceptDownloads: true });
    if (process.env.PDFLIB_PATH) await ctx.route('**/pdf-lib.min.js', r => r.fulfill({ path: process.env.PDFLIB_PATH, contentType: 'text/javascript' }));
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE + '/'); await p.waitForFunction(() => typeof db !== 'undefined' && db);
    await p.evaluate(() => { document.getElementById('splash-screen').style.display = 'none'; });
    await p.fill('#authUsername', 'admin@library.org'); await p.fill('#authPassword', 'Admin@123'); await p.click('text=🚀 Login to Portal'); await p.waitForTimeout(400);

    console.log('\n1. Fine receipts');
    await p.evaluate(() => { const t = db.txns[0]; Object.assign(t, { status: 'Returned', issueDate: '2026-01-01', dueDate: '2026-01-15', returnDate: '2026-01-18', fine: 30, payMode: 'Cash' }); db.txns.push({ id: 'TX-W1', memberId: t.memberId, isbn: t.isbn, issueDate: '2026-02-01', dueDate: '2026-02-15', returnDate: '2026-02-17', status: 'Returned', fine: 20, payMode: 'Waived Off' }); saveDb(); switchView('fines'); });
    ok(await p.locator('button[data-action="fine-receipt"]').count() === 2, 'each fine in history has a Receipt button');
    await p.click('button[data-txn="TX-W1"]');
    ok(await p.isVisible('#receiptModal') && /Waiver/.test(await p.textContent('#receiptBody')) && /RC-TX-W1/.test(await p.textContent('#receiptBody')), 'waived fine shows a waiver receipt');
    await p.evaluate(() => { document.getElementById('receiptModal').style.display = 'none'; });
    await p.click(`button[data-txn="${await p.evaluate(() => db.txns[0].id)}"]`);
    const rt = await p.textContent('#receiptBody');
    ok(/Receipt/.test(rt) && /Dayslate3/.test(rt.replace(/\s/g, '')) && /Cash/.test(rt), 'paid fine receipt shows days late, amount and mode');
    await p.evaluate(() => showFineReceipt('NOPE'));
    await p.evaluate(() => { document.getElementById('receiptModal').style.display = 'none'; });

    console.log('\n2. Search & filters');
    await p.evaluate(() => switchView('books'));
    const all = await p.locator('#bookTableBody tr.clickable-row').count();
    const g = await p.evaluate(() => db.books[0].genre);
    await p.selectOption('#bookGenre', g);
    const want = await p.evaluate(g => db.books.filter(b => b.genre === g).length, g);
    ok(all > 0 && await p.locator('#bookTableBody tr.clickable-row').count() === want, 'genre filter narrows the book list');
    await p.fill('#bookSearch', 'zzzz-nothing'); ok(await p.locator('#bookTableBody tr.clickable-row').count() === 0, 'search and filter combine (no match shows empty)');
    await p.fill('#bookSearch', ''); await p.selectOption('#bookGenre', '');
    await p.evaluate(() => switchView('members'));
    await p.selectOption('#memberLoan', 'none');
    const noLoan = await p.evaluate(() => db.members.filter(m => loansOf(m.id) === 0).length);
    ok(await p.locator('#memberTableBody tr').count() === Math.max(noLoan, 1) , 'member filter "No loans" works');
    await p.selectOption('#memberLoan', 'on');
    const onLoan = await p.evaluate(() => db.members.filter(m => loansOf(m.id) > 0).length);
    ok(await p.locator('#memberTableBody tr').count() === Math.max(onLoan, 1), 'member filter "With loans" works');
    await p.selectOption('#memberLoan', '');

    console.log('\n3. Book covers');
    await p.evaluate(() => switchView('books'));
    await p.click('text=+ Add New Book');
    await p.fill('#newBookIsbn', '978-5555555555'); await p.fill('#newBookTitle', 'Cover Book'); await p.fill('#newBookAuthor', 'Painter'); await p.fill('#newBookGenre', 'Art');
    await p.setInputFiles('#newBookCover', { name: 'c.png', mimeType: 'image/png', buffer: PNG });
    await p.click('text=💾 Save Book'); await p.waitForTimeout(500);
    ok(await p.evaluate(() => /^data:image\/jpeg;base64,/.test(bookByIsbn('978-5555555555').cover || '')), 'cover is saved as a small JPEG data URL');
    ok(await p.locator('#bookTableBody img.cover-thumb').count() === 1, 'cover thumbnail shows in the catalog');
    await p.evaluate(() => showBookDetails('978-5555555555'));
    ok(await p.isVisible('#detCover'), 'cover shows in book details');
    await p.evaluate(() => { document.getElementById('bookDetailModal').style.display = 'none'; });
    await p.evaluate(() => { bookByIsbn('978-5555555555').cover = 'javascript:alert(1)'; renderBooks(); });
    ok(await p.locator('#bookTableBody img.cover-thumb').count() === 0, 'a tampered (non-image) cover value is never rendered');
    await p.evaluate(() => { bookByIsbn('978-5555555555').cover = 'data:image/png;base64,AAAA" onerror="x'; renderBooks(); });
    ok(await p.locator('#bookTableBody img.cover-thumb').count() === 0, 'cover value with injected attributes is not rendered');
    await p.evaluate(() => { delete bookByIsbn('978-5555555555').cover; });
    await p.evaluate(() => openBookModalForAdd());
    await p.fill('#newBookIsbn', '978-6666666666'); await p.fill('#newBookTitle', 'Bad Cover'); await p.fill('#newBookAuthor', 'X'); await p.fill('#newBookGenre', 'X');
    await p.setInputFiles('#newBookCover', { name: 'c.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await p.click('text=💾 Save Book'); await p.waitForTimeout(400);
    ok(await p.evaluate(() => !bookByIsbn('978-6666666666')), 'a fake image file is rejected and the book is not saved');
    await p.evaluate(() => closeBookModal());

    console.log('\n4. Backup & restore');
    ok(await p.isVisible('#backupSection') || (await p.evaluate(() => switchView('settings')), await p.isVisible('#backupSection')), 'admin sees backup section');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => downloadBackup())]);
    const bf = path.join(tmp, 'backup.json'); await dl.saveAs(bf);
    const bj = JSON.parse(fs.readFileSync(bf, 'utf8'));
    ok(bj.app === 'lms-portal' && Array.isArray(bj.db.books) && /^LMS_Backup_/.test(dl.suggestedFilename()), 'backup file downloads with all records');
    const nBooks = await p.evaluate(() => db.books.length);
    await p.evaluate(() => { db.books.length = 0; saveDb(); });
    await p.setInputFiles('#restoreFile', bf); await p.waitForSelector('#confirmModal', { state: 'visible' }); await p.click('#confirmYes'); await p.waitForTimeout(400);
    ok(await p.evaluate(() => db.books.length) === nBooks, 'restore brings the deleted books back');
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{"hello":1}');
    await p.setInputFiles('#restoreFile', path.join(tmp, 'bad.json')); await p.waitForTimeout(400);
    ok(await p.evaluate(() => db.books.length) === nBooks && !(await p.isVisible('#confirmModal')), 'invalid backup file is rejected, data untouched');
    ok(errs.length === 0, 'no JS errors (' + errs.join('|') + ')');
  } finally { await browser.close(); srv.kill(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
