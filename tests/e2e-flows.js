/* End-to-end tests for LMS Portal (real Chromium via Playwright).
 * Run:  node tests/e2e-flows.js
 * Optional: PDFLIB_PATH=/path/to/pdf-lib.min.js to run the PDF-preview test offline. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; failures.push(msg); console.log('  ✗ ' + msg); } }

function makePdf(pages) { // valid multi-page PDF without dependencies
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 0; i < pages; i++) {
    const c = `BT /F1 24 Tf 72 700 Td (Test page ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + pages + i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${4 + i} 0 R`);
  }
  for (let i = 0; i < pages; i++) { const c = `BT /F1 24 Tf 72 700 Td (Test page ${i + 1}) Tj ET`; objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`); }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function open(browser, ctx) {
  const context = ctx || await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 820 } });
  if (process.env.PDFLIB_PATH) await context.route('**/pdf-lib.min.js', r => r.fulfill({ path: process.env.PDFLIB_PATH, contentType: 'text/javascript' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  await page.evaluate(() => { document.getElementById('splash-screen').style.display = 'none'; });
  page.errors = errors;
  return page;
}
async function login(page, user, pw) {
  await page.fill('#authUsername', user); await page.fill('#authPassword', pw);
  await page.click('text=🚀 Login to Portal');
  await page.waitForTimeout(250);
}
const toastText = page => page.textContent('#toast');
const loggedIn = page => page.evaluate(() => !!currentUser);

(async () => {
  const browser = await chromium.launch();

  console.log('\n1. Login & roles');
  let p = await open(browser);
  await login(p, 'admin@library.org', 'wrong'); ok(!(await loggedIn(p)), 'wrong password rejected');
  await login(p, 'admin@library.org', 'Admin@123'); ok(await loggedIn(p), 'admin logs in');
  ok((await p.$$eval('#sidebarNav a', a => a.map(x => x.textContent))).length === 6, 'admin sees 6 menu items');
  ok(await p.isVisible('#exportCsvBtn'), 'admin sees CSV export');
  await p.evaluate(() => logoutSession());
  await login(p, 'librarian@library.org', 'Librarian@123');
  ok((await p.$$eval('#sidebarNav a', a => a.map(x => x.textContent))).length === 5, 'librarian sees 5 menu items (no members)');
  ok(!(await p.isVisible('#exportCsvBtn')), 'librarian has no CSV export');
  await p.evaluate(() => logoutSession());
  ok(p.errors.length === 0, 'no JS errors (' + p.errors.join('|') + ')');
  await p.context().close();

  console.log('\n2. Dashboard numbers & issue/return/fines');
  p = await open(browser);
  await login(p, 'admin@library.org', 'Admin@123');
  ok(await p.textContent('#statBooks') === '9', 'total collection = 9 copies');
  ok(await p.textContent('#statIssued') === '3', 'issued = 3');
  ok(await p.textContent('#statOverdue') === '1', 'overdue = 1');
  await p.fill('#issueBookInput', 'Python Crash Course'); await p.fill('#issueMemberInput', 'MEM-101');
  await p.click('text=🚀 Issue Book');
  ok((await toastText(p)).includes('issued to Rahul Sharma'), 'issue succeeds');
  ok(await p.textContent('#statIssued') === '4', 'issued count becomes 4');
  await p.fill('#issueBookInput', 'Python Crash Course'); await p.fill('#issueMemberInput', 'MEM-101');
  await p.click('text=🚀 Issue Book');
  ok((await toastText(p)).includes('already has this book'), 'same book twice to same member blocked');
  await p.fill('#issueDateVal', '2026-01-01'); await p.dispatchEvent('#issueDateVal', 'change');
  ok(await p.inputValue('#dueDateVal') === '2026-01-15', 'changing issue date moves due date by 14 days');
  await p.evaluate(() => openReturnModal('TX-8819'));
  ok((await p.inputValue('#modalFineAmt')) === '₹150.00', 'overdue 15 days => fine ₹150.00');
  await p.selectOption('#payMethod', 'Cash'); await p.click('text=✅ Confirm Return');
  const tx = await p.evaluate(() => db.txns.find(t => t.id === 'TX-8819'));
  ok(tx.status === 'Returned' && tx.fine === 150 && tx.payMode === 'Cash', 'return stored with fine and payment mode');
  ok(await p.textContent('#statOverdue') === '0', 'overdue drops to 0');
  await p.click('a[data-view=fines]');
  ok((await p.textContent('#finePaid')) === '₹150.00', 'fines page shows ₹150 collected');
  const dl = p.waitForEvent('download'); await p.evaluate(() => exportData());
  const d = await dl; const csv = fs.readFileSync(await d.path(), 'utf8');
  ok(csv.includes('Txn ID') && csv.includes('TX-8819'), 'CSV export has headers and rows');
  ok(p.errors.length === 0, 'no JS errors (' + p.errors.join('|') + ')');
  await p.context().close();

  console.log('\n3. Holds queue');
  p = await open(browser);
  await login(p, 'admin@library.org', 'Admin@123');
  await p.fill('#issueMemberInput', 'MEM-101'); await p.evaluate(() => reserveBook('978-0132350884'));
  ok((await toastText(p)).includes('already have this book'), 'hold blocked for member who already has the book');
  await p.fill('#issueMemberInput', 'MEM-102'); await p.evaluate(() => reserveBook('978-0132350884'));
  ok(await p.evaluate(() => db.holds.length) === 1, 'hold placed for MEM-102');
  await p.evaluate(() => openReturnModal('TX-8820')); await p.selectOption('#payMethod', { index: 0 }); await p.click('text=✅ Confirm Return');
  await p.fill('#issueBookInput', 'Clean Code'); await p.fill('#issueMemberInput', 'MEM-103'); await p.click('text=🚀 Issue Book');
  ok((await toastText(p)).includes('reserved for members in the hold queue'), 'free copy is kept for the member in the queue');
  await p.fill('#issueBookInput', 'Clean Code'); await p.fill('#issueMemberInput', 'MEM-102'); await p.click('text=🚀 Issue Book');
  ok((await toastText(p)).includes('issued to Amit Kumar'), 'queued member gets the copy');
  ok(await p.evaluate(() => db.holds.length) === 0, 'hold is cleared once fulfilled');
  await p.context().close();

  console.log('\n4. Members, registration & clean-up');
  p = await open(browser);
  await login(p, 'admin@library.org', 'Admin@123');
  await p.evaluate(() => { db.members.push({ id: 'MEM-200', name: 'Staff Made', email: 'staff.made@example.in', contact: '9876500000' }); saveDb(); });
  await p.evaluate(() => logoutSession());
  await p.click('text=New Reader?');
  await p.fill('#pubRegName', 'Staff Made'); await p.fill('#pubRegEmail', 'staff.made@example.in'); await p.fill('#pubRegContact', '9876500000');
  await p.fill('#pubRegPass', 'secret1'); await p.fill('#pubRegConfirmPass', 'secret1'); await p.click('text=✉️ Send Verification Code');
  let otp = (await p.textContent('#verifyEmailInfo')).match(/(\d{6})/)[1];
  await p.fill('#verificationCodeInput', otp); await p.click('text=✅ Verify');
  await p.waitForTimeout(400);
  const linked = await p.evaluate(() => ({ users: db.users.filter(u => u.memberId === 'MEM-200').length, members: db.members.filter(m => m.email === 'staff.made@example.in').length }));
  ok(linked.users === 1 && linked.members === 1, 'staff-created member can register online and is linked (no duplicate member)');
  await login(p, 'staff.made@example.in', 'secret1');
  ok(await p.evaluate(() => currentUser && currentUser.memberId === 'MEM-200'), 'new reader logs in with email');
  ok((await p.$$eval('#sidebarNav a', a => a.length)) === 5, 'reader sees 5 menu items');
  await p.evaluate(() => logoutSession());
  await login(p, 'MEM-200', 'secret1'); ok(await loggedIn(p), 'reader can also log in with Member ID');
  await p.evaluate(() => logoutSession());
  await login(p, 'admin@library.org', 'Admin@123');
  await p.evaluate(() => openMemberModalForEdit('MEM-200'));
  ok(await p.evaluate(() => document.getElementById('newMemberEmail').readOnly), 'email locked for a member that has a login');
  await p.evaluate(() => { db.wishlist['staff.made@example.in'] = ['978-0132350884']; db.library['staff.made@example.in'] = [{ isbn: '978-0132350884', source: 'purchase', date: '2026-01-01' }]; saveDb(); deleteMember('MEM-200'); });
  await p.click('#confirmYes'); await p.waitForTimeout(200);
  const left = await p.evaluate(() => ({ w: !!db.wishlist['staff.made@example.in'], l: !!db.library['staff.made@example.in'], u: db.users.some(u => u.id === 'staff.made@example.in') }));
  ok(!left.w && !left.l && !left.u, 'deleting a member removes login, library and wishlist');
  await p.context().close();

  console.log('\n5. E-book paywall (preview vs subscription vs purchase)');
  p = await open(browser);
  await login(p, 'admin@library.org', 'Admin@123');
  await p.click('a[data-view=books]'); await p.click('text=+ Add New Book');
  await p.fill('#newBookIsbn', '978-1111111111'); await p.fill('#newBookTitle', '<img src=x onerror="window.__xss=1">Test Book');
  await p.fill('#newBookAuthor', 'Tester'); await p.fill('#newBookGenre', 'Testing'); await p.fill('#newBookPrice', '250');
  await p.setInputFiles('#newBookPdf', { name: 'test.pdf', mimeType: 'application/pdf', buffer: makePdf(12) });
  await p.click('text=💾 Save Book'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => (db.books.find(b => b.isbn === '978-1111111111') || {}).hasPdf === true), 'admin uploads a PDF with the book');
  ok(!(await p.evaluate(() => window.__xss)), 'HTML in a book title is escaped (no XSS)');
  await p.setInputFiles('#newBookPdf', []).catch(() => {});
  await p.evaluate(() => { openBookModalForAdd(); }); await p.fill('#newBookIsbn', '978-2222222222'); await p.fill('#newBookTitle', 'Fake'); await p.fill('#newBookAuthor', 'A'); await p.fill('#newBookGenre', 'G');
  await p.setInputFiles('#newBookPdf', { name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf at all') });
  await p.click('text=💾 Save Book'); await p.waitForTimeout(200);
  ok((await toastText(p)).includes('not a valid PDF') && !(await p.evaluate(() => db.books.some(b => b.isbn === '978-2222222222'))), 'non-PDF upload rejected');
  await p.evaluate(() => closeBookModal());
  await p.evaluate(() => logoutSession());
  await p.click('text=New Reader?');
  await p.fill('#pubRegName', 'Reader One'); await p.fill('#pubRegEmail', 'reader1@example.in'); await p.fill('#pubRegContact', '9811111111');
  await p.fill('#pubRegPass', 'secret1'); await p.fill('#pubRegConfirmPass', 'secret1'); await p.click('text=✉️ Send Verification Code');
  await p.fill('#verificationCodeInput', '000000'); await p.click('text=✅ Verify');
  ok((await toastText(p)).includes('Invalid verification code'), 'wrong OTP rejected');
  otp = (await p.textContent('#verifyEmailInfo')).match(/(\d{6})/)[1];
  await p.fill('#verificationCodeInput', otp); await p.click('text=✅ Verify'); await p.waitForTimeout(400);
  await login(p, 'reader1@example.in', 'secret1');
  const isbn = '978-1111111111';
  ok(await p.evaluate(i => accessOf(bookByIsbn(i)) === 'preview', isbn), 'reader without plan gets preview access only');
  ok(await p.isVisible(`#userCatalogBody [data-action=read-pdf][data-isbn="${isbn}"]`), 'preview button shown');
  await p.click(`#userCatalogBody [data-action=read-pdf][data-isbn="${isbn}"]`); await p.waitForTimeout(800);
  if (process.env.PDFLIB_PATH) {
    const pages = await p.evaluate(async () => { const b = await (await fetch(document.getElementById('pdfFrame').src)).arrayBuffer(); return (await PDFLib.PDFDocument.load(b)).getPageCount(); });
    ok(pages === 7, 'preview contains exactly 7 of 12 pages (got ' + pages + ')');
  } else console.log('  - preview page-count check skipped (set PDFLIB_PATH)');
  await p.evaluate(() => closePdfViewer());
  await p.evaluate(() => downloadBookPDF('978-1111111111'));
  ok((await toastText(p)).includes('Buy this book or subscribe'), 'download blocked without payment');
  await p.click('[data-action=subscribe][data-plan=monthly]'); await p.click('text=✅ Pay Now');
  ok(await p.evaluate(() => subActive(currentUser)), 'monthly subscription activates after demo payment');
  ok(await p.evaluate(i => accessOf(bookByIsbn(i)) === 'full', isbn), 'subscriber gets full access');
  const dl2 = p.waitForEvent('download'); await p.evaluate(i => downloadBookPDF(i), isbn); await dl2;
  ok(true, 'subscriber can download the PDF');
  await p.evaluate(() => { currentUser.sub.expires = '2000-01-01'; saveDb(); });
  ok(await p.evaluate(i => accessOf(bookByIsbn(i)) === 'preview', isbn), 'expired subscription falls back to preview');
  await p.evaluate(i => openCheckout({ type: 'book', isbn: i }), isbn); await p.click('text=✅ Pay Now');
  ok(await p.evaluate(i => accessOf(bookByIsbn(i)) === 'full' && libEntry(currentUser.id, i).source === 'purchase', isbn), 'single-book purchase gives permanent access');
  ok(await p.evaluate(() => db.payments.filter(x => x.userId === 'reader1@example.in').length === 2), 'both payments recorded');
  await p.evaluate(() => logoutSession());
  ok(await p.evaluate(i => accessOf(bookByIsbn(i)) === 'none', isbn), 'no access at all after logout (fail closed)');
  await p.evaluate(() => { downloadBookPDF('978-1111111111'); });
  await p.evaluate(() => { const b = document.createElement('button'); b.id = 'ghost'; b.dataset.action = 'delete-book'; b.dataset.isbn = '978-0132350884'; document.body.appendChild(b); });
  await p.click('#ghost', { force: true }).catch(() => {});
  ok(await p.evaluate(() => db.books.some(b => b.isbn === '978-0132350884')), 'actions are ignored when logged out');
  ok(p.errors.length === 0, 'no JS errors (' + p.errors.join('|') + ')');
  await p.context().close();

  console.log('\n6. Multi-tab sync & data safety');
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const a = await open(browser, ctx), b = await open(browser, ctx);
  await login(a, 'admin@library.org', 'Admin@123'); await login(b, 'librarian@library.org', 'Librarian@123');
  await a.fill('#issueBookInput', 'Design Patterns'); await a.fill('#issueMemberInput', 'MEM-101'); await a.click('text=🚀 Issue Book');
  await b.waitForTimeout(400);
  ok(await b.evaluate(() => db.txns.length) === 4, 'second tab sees the loan made in the first tab');
  await b.fill('#issueBookInput', 'Python Crash Course'); await b.fill('#issueMemberInput', 'MEM-103'); await b.click('text=🚀 Issue Book');
  ok(await b.evaluate(() => db.txns.map(t => t.id).join()) === 'TX-8819,TX-8820,TX-8821,TX-8822,TX-8823', 'ids do not collide between tabs');
  await ctx.close();
  const c2 = await browser.newContext(); const q = await c2.newPage();
  await q.goto(URL); await q.evaluate(() => localStorage.setItem('lms_db_v2', '{"broken":true}')); await q.reload();
  await q.waitForFunction(() => typeof db !== 'undefined' && db);
  ok(await q.evaluate(() => localStorage.getItem('lms_db_v2_bak') === '{"broken":true}'), 'unreadable saved data is backed up before re-seeding');
  await c2.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
