/* End-to-end tests for LMS Portal (headless Chromium via Playwright).
   Run:  python3 -m http.server 8765 &   then   node tests/e2e.js
   Dev deps: playwright, pdf-lib (npm i playwright pdf-lib). pdf-lib CDN call is served from node_modules. */
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const URL = process.env.LMS_URL || 'http://localhost:8765/index.html';
const results = [];
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'expected'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const pdfLibPath = path.join(path.dirname(require.resolve('pdf-lib/package.json')), 'dist', 'pdf-lib.min.js');
  await ctx.route('**/pdf-lib.min.js', r => r.fulfill({ path: pdfLibPath, contentType: 'application/javascript' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const T = async (id, name, fn) => {
    try { await fn(); results.push({ id, name, pass: true }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, name, pass: false, error: e.message.replace(/\s+/g, ' ').slice(0, 450) }); console.log('FAIL', id, name, '-', e.message.split('\n')[0]); }
  };
  const toast = async () => (await page.locator('#toast').textContent()).trim();
  const login = async (u, p) => { await page.fill('#authUsername', u); await page.fill('#authPassword', p); await page.click('.auth-card .btn-primary'); await page.waitForTimeout(300); };
  const logout = async () => { await page.click('.role-switcher'); await page.click('#confirmYes'); await page.waitForTimeout(200); };
  const nav = async v => { await page.click(`#sidebarNav a[data-view="${v}"]`); };
  const navCount = async () => page.locator('#sidebarNav a').count();

  await page.goto(URL);
  await page.waitForSelector('#splash-screen', { state: 'hidden', timeout: 8000 });

  await T('T01', 'Admin login shows dashboard stats (9 books, 3 issued, 3 members, 1 overdue)', async () => {
    await login('admin@library.org', 'Admin@123');
    eq(await page.textContent('#statBooks'), '9'); eq(await page.textContent('#statIssued'), '3');
    eq(await page.textContent('#statMembers'), '3'); eq(await page.textContent('#statOverdue'), '1');
  });
  await T('T02', 'Admin sees 6 menu items; CSV export visible', async () => {
    eq(await navCount(), 6); ok(await page.locator('#exportCsvBtn').isVisible(), 'export hidden');
  });
  await T('T03', 'Add book with price appears in inventory; bad ISBN rejected', async () => {
    await nav('books'); await page.click('text=+ Add New Book');
    await page.fill('#newBookIsbn', 'abc'); await page.fill('#newBookTitle', 'T'); await page.fill('#newBookAuthor', 'A'); await page.fill('#newBookGenre', 'G');
    await page.click('text=💾 Save Book'); ok((await toast()).includes('ISBN'), 'bad ISBN accepted');
    await page.fill('#newBookIsbn', '978-0143425672'); await page.fill('#newBookTitle', 'Atomic Habits'); await page.fill('#newBookAuthor', 'James Clear'); await page.fill('#newBookGenre', 'Self-Help'); await page.fill('#newBookPrice', '250');
    await page.click('text=💾 Save Book');
    const row = page.locator('#bookTableBody tr', { hasText: 'Atomic Habits' }); ok(await row.count() === 1, 'row missing'); ok((await row.textContent()).includes('₹250'), 'price missing');
  });
  await T('T04', 'Issue book reduces availability and raises issued count', async () => {
    await nav('dashboard'); await page.fill('#issueBookInput', 'Python Crash Course'); await page.fill('#issueMemberInput', 'MEM-101'); await page.click('text=🚀 Issue Book');
    ok((await toast()).includes('issued'), await toast()); eq(await page.textContent('#statIssued'), '4');
  });
  await T('T05', 'Same member cannot borrow the same book twice', async () => {
    await page.fill('#issueBookInput', 'Python Crash Course'); await page.fill('#issueMemberInput', 'MEM-101'); await page.click('text=🚀 Issue Book');
    ok((await toast()).includes('already has'), await toast());
  });
  await T('T06', 'Issue blocked when no copies are available (Clean Code: 2/2 out)', async () => {
    await page.fill('#issueBookInput', 'Clean Code'); await page.fill('#issueMemberInput', 'MEM-102'); await page.click('text=🚀 Issue Book');
    ok((await toast()).includes('No copies'), await toast());
  });
  await T('T07', 'Returning the 15-day-overdue loan charges Rs 150 and logs it in Fines', async () => {
    await nav('transactions'); await page.selectOption('#loanSelect', 'TX-8819'); await page.click('text=🔄 Process Return & Collect Fine');
    eq(await page.inputValue('#modalFineAmt'), '₹150.00'); await page.selectOption('#payMethod', 'Cash'); await page.click('text=✅ Confirm Return & Submit');
    await nav('fines'); eq(await page.textContent('#finePaid'), '₹150.00');
  });
  await T('T08', 'Waived fine is tracked separately from collected fine', async () => {
    await page.evaluate(() => { const t = db.txns.find(x => x.id === 'TX-8820'); t.dueDate = addDays(todayISO(), -3); saveDb(); renderAll(); });
    await nav('transactions'); await page.selectOption('#loanSelect', 'TX-8820'); await page.click('text=🔄 Process Return & Collect Fine');
    await page.selectOption('#payMethod', 'Waived Off'); await page.click('text=✅ Confirm Return & Submit');
    await nav('fines'); eq(await page.textContent('#fineWaived'), '₹30.00'); eq(await page.textContent('#finePaid'), '₹150.00');
    await page.evaluate(() => { const t = db.txns.find(x => x.id === 'TX-8820'); Object.assign(t, { status: 'Issued', returnDate: null, fine: 0, payMode: null, dueDate: addDays(todayISO(), 9) }); saveDb(); renderAll(); });
  });
  await T('T09', 'XSS: script payload in book title is rendered as text, not executed', async () => {
    await nav('books'); await page.click('text=+ Add New Book');
    await page.fill('#newBookIsbn', '978-1111111111'); await page.fill('#newBookTitle', '<img src=x onerror="window.__xss=1">'); await page.fill('#newBookAuthor', 'X'); await page.fill('#newBookGenre', 'X');
    await page.click('text=💾 Save Book'); await page.waitForTimeout(300);
    eq(await page.evaluate(() => window.__xss), undefined, 'payload executed'); ok(await page.locator('#bookTableBody').textContent().then(s => s.includes('<img src=x')), 'text not shown');
    await page.locator('#bookTableBody tr', { hasText: '978-1111111111' }).locator('[data-action=delete-book]').click(); await page.click('#confirmYes');
  });
  await T('T10', 'CSV export contains header and transaction rows', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsvBtn')]);
    const txt = fs.readFileSync(await dl.path(), 'utf8'); ok(txt.includes('Txn ID') && txt.includes('TX-8819') && txt.includes('150.00'), 'csv content');
  });
  await T('T11', 'Staff cannot delete a book that is currently on loan', async () => {
    await nav('books'); await page.locator('#bookTableBody tr', { hasText: 'Clean Code' }).locator('[data-action=delete-book]').click();
    ok((await toast()).includes('on loan'), await toast());
  });
  await T('T12', 'Member directory: duplicate email blocked', async () => {
    await nav('members'); await page.click('text=+ Register Member'); await page.fill('#newMemberName', 'Dup'); await page.fill('#newMemberEmail', 'rahul.s@example.in'); await page.fill('#newMemberContact', '9876543210');
    await page.click('text=💾 Save Member'); ok((await toast()).includes('already used'), await toast()); await page.click('#memberModal >> text=❌ Cancel');
  });
  await T('T13', 'Login brute-force lockout after 5 failed attempts', async () => {
    await logout();
    for (let i = 0; i < 5; i++) await login('admin@library.org', 'wrong' + i);
    await login('admin@library.org', 'Admin@123'); ok((await toast()).toLowerCase().includes('locked') || (await toast()).toLowerCase().includes('too many'), 'no lockout: ' + await toast());
    await page.evaluate(() => { if (typeof loginLock !== 'undefined') { loginLock.until = 0; loginLock.fails = 0; } });
    if (!(await page.isVisible('#auth-screen'))) await logout();
  });
  await T('T14', 'Librarian sees 5 items and no Member Directory', async () => {
    await login('librarian@library.org', 'Librarian@123'); eq(await navCount(), 5);
    ok(!(await page.locator('#sidebarNav').textContent()).includes('Member Directory'), 'members visible'); ok(!(await page.locator('#exportCsvBtn').isVisible()), 'export visible'); await logout();
  });

  // ---- Reader flow ----
  const pdf = await PDFDocument.create(); for (let i = 0; i < 15; i++) pdf.addPage([300, 400]);
  const pdfPath = path.join(__dirname, '.sample15.pdf'); fs.writeFileSync(pdfPath, await pdf.save());
  await T('T15', 'Admin uploads 15-page PDF to a book; oversize (>12 MB) and fake PDFs rejected', async () => {
    await login('admin@library.org', 'Admin@123'); await nav('books'); await page.click('text=+ Add New Book');
    await page.fill('#newBookIsbn', '978-2222222222'); await page.fill('#newBookTitle', 'Sample Ebook'); await page.fill('#newBookAuthor', 'Tester'); await page.fill('#newBookGenre', 'Test'); await page.fill('#newBookPrice', '99');
    const big = path.join(__dirname, '.big.pdf'); fs.writeFileSync(big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(13 * 1024 * 1024)]));
    await page.setInputFiles('#newBookPdf', big); await page.click('text=💾 Save Book'); await page.waitForTimeout(300); ok((await toast()).includes('12 MB'), await toast()); fs.unlinkSync(big);
    const fake = path.join(__dirname, '.fake.pdf'); fs.writeFileSync(fake, 'not a pdf'); await page.setInputFiles('#newBookPdf', fake); await page.click('text=💾 Save Book'); await page.waitForTimeout(300); ok((await toast()).includes('not a valid PDF'), await toast()); fs.unlinkSync(fake);
    await page.setInputFiles('#newBookPdf', pdfPath); await page.click('text=💾 Save Book'); await page.waitForTimeout(500);
    ok((await page.locator('#bookTableBody tr', { hasText: 'Sample Ebook' }).textContent()).includes('📄'), 'pdf flag missing'); await logout();
  });
  let otp;
  await T('T16', 'Reader self-registration: wrong OTP rejected, correct OTP creates member MEM-104', async () => {
    await page.click('text=New Reader? Register Online Account');
    await page.fill('#pubRegName', 'Test Reader'); await page.fill('#pubRegEmail', 'reader@example.in'); await page.fill('#pubRegContact', '9811122233'); await page.fill('#pubRegPass', 'Reader@1'); await page.fill('#pubRegConfirmPass', 'Reader@1');
    await page.click('text=✉️ Send Verification Code'); otp = (await page.textContent('#verifyEmailInfo')).match(/(\d{6})/)[1];
    await page.fill('#verificationCodeInput', otp === '000000' ? '111111' : '000000'); await page.click('text=✅ Verify & Complete'); ok((await toast()).includes('Invalid'), await toast());
    await page.fill('#verificationCodeInput', otp); await page.click('text=✅ Verify & Complete'); ok((await toast()).includes('MEM-104'), await toast());
  });
  await T('T17', 'Reader logs in by Member ID and sees 5 reader menu items', async () => {
    await login('MEM-104', 'Reader@1'); eq(await navCount(), 5); ok((await page.textContent('#subCard')).includes('Free preview'), 'not in preview mode');
  });
  await T('T18', 'Free preview PDF contains exactly 7 of 15 pages', async () => {
    await page.click('[data-action=read-pdf][data-isbn="978-2222222222"]'); await page.waitForSelector('#pdfViewerModal', { state: 'visible' }); await page.waitForTimeout(800);
    const n = await page.evaluate(async () => { const b = await (await fetch(pdfViewUrl)).blob(); return (await PDFLib.PDFDocument.load(await b.arrayBuffer())).getPageCount(); });
    eq(n, 7); ok((await page.textContent('#pdfNoteText')).includes('7 of 15'), 'note'); await page.click('#pdfViewerModal >> text=✕ Close');
  });
  await T('T19', 'Download is blocked without subscription or purchase', async () => {
    await page.evaluate(() => downloadBookPDF('978-2222222222')); ok((await toast()).includes('Buy this book'), await toast());
  });
  await T('T20', 'Buying a book adds it to My Library as Owned and logs Rs 99 payment; full 15 pages readable', async () => {
    await page.click('#userCatalogBody [data-action=buy-book][data-isbn="978-2222222222"]'); eq(await page.inputValue('#coAmount'), '₹99.00'); await page.click('text=✅ Pay Now');
    await nav('user-library'); const t = await page.textContent('#userLibraryBody'); ok(t.includes('Sample Ebook') && t.includes('Owned'), 'not owned');
    ok((await page.textContent('#userPaymentsBody')).includes('99.00'), 'payment missing');
    await page.click('#userLibraryBody [data-action=read-pdf]'); await page.waitForTimeout(500);
    const n = await page.evaluate(async () => { await loadPdfLib(); const b = await (await fetch(pdfViewUrl)).blob(); return (await PDFLib.PDFDocument.load(await b.arrayBuffer())).getPageCount(); });
    eq(n, 15); await page.click('#pdfViewerModal >> text=✕ Close');
  });
  await T('T21', 'Monthly subscription (Rs 149) activates for 30 days', async () => {
    await nav('user-portal'); await page.click('[data-action=subscribe][data-plan=monthly]'); eq(await page.inputValue('#coAmount'), '₹149.00'); await page.click('text=✅ Pay Now');
    ok((await page.textContent('#subCard')).includes('Active until'), 'not active');
    const days = await page.evaluate(() => daysBetween(todayISO(), currentUser.sub.expires)); eq(days, 30);
  });
  await T('T22', 'Hold request for a fully-loaned book is created and can be cancelled', async () => {
    await nav('user-loans'); await page.fill('#holdBookTitleInput', 'Clean Code'); await page.click('text=📌 Request Hold');
    ok((await page.textContent('#userHoldsBody')).includes('Clean Code'), 'hold missing'); await page.click('#userHoldsBody [data-action=cancel-hold]'); ok((await page.textContent('#userHoldsBody')).includes('No active holds'), 'not cancelled');
  });
  await T('T23', 'Wishlist add and remove', async () => {
    await nav('user-portal'); await page.locator('#userCatalogBody [data-action=wishlist]').first().click(); await nav('user-wishlist');
    ok(await page.locator('#userWishlistBody [data-action=wishlist]').count() === 1, 'not saved'); await page.click('#userWishlistBody [data-action=wishlist]');
  });
  await T('T24', 'Expired subscription falls back to preview mode', async () => {
    await page.evaluate(() => { currentUser.sub.expires = addDays(todayISO(), -1); saveDb(); renderAll(); }); await nav('user-portal');
    ok((await page.textContent('#subCard')).includes('Free preview'), 'still active');
  });
  await T('T25', 'Password change works and old password stops working', async () => {
    await nav('settings'); await page.fill('#currentPassInput', 'Reader@1'); await page.fill('#newPassInput', 'Reader@2'); await page.fill('#confirmPassInput', 'Reader@2'); await page.click('text=🔒 Reset Password Securely');
    await logout(); await login('reader@example.in', 'Reader@1'); ok((await toast()).includes('Invalid'), 'old pw worked'); await login('reader@example.in', 'Reader@2'); eq(await navCount(), 5);
  });
  await T('T26', 'Data and session persist across page reload', async () => {
    await page.reload(); await page.waitForSelector('#splash-screen', { state: 'hidden', timeout: 8000 }); ok((await page.textContent('#currentRoleEmail')).includes('reader@example.in'), 'session lost');
  });
  await T('T27', 'Dark theme toggle persists after reload', async () => {
    await page.click('#themeToggleBtn'); await page.reload(); await page.waitForSelector('#splash-screen', { state: 'hidden', timeout: 8000 }); eq(await page.getAttribute('body', 'data-theme'), 'dark');
  });

  // ---- Accessibility ----
  await T('A01', 'Sidebar items are keyboard-focusable', async () => { ok(await page.evaluate(() => document.querySelector('#sidebarNav a').tabIndex >= 0), 'tabIndex < 0'); });
  await T('A02', 'Enter key activates a sidebar item', async () => {
    await page.focus('#sidebarNav a[data-view="user-library"]'); await page.keyboard.press('Enter'); ok(await page.locator('#view-user-library.active').count() === 1, 'not activated');
  });
  await T('A03', 'Toast is an aria-live status region', async () => { ok(['status', 'alert'].includes(await page.getAttribute('#toast', 'role')) || (await page.getAttribute('#toast', 'aria-live')), 'no live region'); });
  await T('A04', 'Modals expose role=dialog and aria-modal', async () => { eq(await page.evaluate(() => [...document.querySelectorAll('.modal-backdrop')].every(m => m.getAttribute('role') === 'dialog' && m.getAttribute('aria-modal') === 'true')), true); });
  await T('A05', 'Escape closes an open modal', async () => {
    await page.evaluate(() => openCheckout({ type: 'subscription', plan: 'monthly' })); await page.keyboard.press('Escape'); eq(await page.evaluate(() => document.getElementById('checkoutModal').style.display), 'none');
  });
  await T('A06', 'Password visibility toggles have accessible names', async () => { eq(await page.evaluate(() => [...document.querySelectorAll('.toggle-password')].every(b => b.getAttribute('aria-label'))), true); });
  await T('A07', 'Clickable table rows are keyboard-focusable', async () => {
    await logout(); await login('admin@library.org', 'Admin@123'); await nav('books'); ok(await page.evaluate(() => document.querySelector('#bookTableBody .clickable-row').tabIndex >= 0), 'row not focusable');
  });
  await T('A08', 'No uncaught JavaScript errors during the whole run', async () => { eq(errors.length, 0, errors.join('; ')); });

  fs.rmSync(pdfPath, { force: true });
  const pass = results.filter(r => r.pass).length;
  console.log(`\n${pass}/${results.length} passed`);
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ date: new Date().toISOString(), pass, total: results.length, results }, null, 2));
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})();
