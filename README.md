# Library Management System (LMS Portal)

A single-file web app (HTML/CSS/vanilla JS) for managing a library: books, members, issue/return, fines, and a paid e-book store with free previews.

## Features
- Role-based portals: **Admin**, **Librarian**, **Reader**
- Book inventory (add/edit/delete, price, optional e-book PDF up to 12 MB), member directory, issue & return with ₹10/day late fines, fine waivers, hold queue
- Dashboard stats and usage analytics (peak issue day, top genre, most-issued book), overdue report, CSV audit export (admin)
- **Reader e-library:** free 7-page preview of any book; monthly (₹149) / yearly (₹1,199) subscription or one-time purchase (demo checkout) for full read + download; *My Library*, *My Payments*, wishlist, physical-book holds
- Reader self-registration with simulated email OTP; login by email or Member ID
- Salted SHA-256 password hashing, escaped output (XSS-safe), CSV formula-injection guard, PDF validation, login lockout (5 failures → 30 s)
- Accessibility: keyboard-operable menus and table rows, Escape closes dialogs, `role="dialog"`/`aria-live` toasts, labelled controls
- Reports page (most borrowed books, active members, loans per month, overdue list, CSV export)
- Barcode scanning with the camera (Chrome/Edge) or by typing / USB scanner; reminders for due-soon and overdue loans (WhatsApp / email links for staff, alerts for readers, "hold ready" notice)
- Fine receipts (printable), search + genre/loan filters, optional book cover images, admin backup & restore of all records
- Data saved in browser localStorage (records) and IndexedDB (PDFs); dark/light theme
- Optional sync server (`npm start`) so several devices share one library
- Installable app (PWA): add to home screen, opens offline from cache (needs http/https, e.g. via `npm start`)

## Run
Open `index.html` in any modern browser (internet is needed once per preview to load `pdf-lib` from a CDN). Data then lives in that browser only.

**Shared data across devices:** run `npm start` (or `node server.js`, no packages needed) and open http://127.0.0.1:3000. The server keeps the data in `data/lms-data.json`. Settings: `PORT`, `HOST` (default `127.0.0.1`), `LMS_DATA`. If two devices save at the same time, the second one is asked to repeat its change. Login is still checked in the browser, so keep the server on a trusted network and do not expose it to the internet.

Demo logins: `admin@library.org` / `Admin@123` · `librarian@library.org` / `Librarian@123`

## Tests
147 automated end-to-end checks (headless Chromium via Playwright) cover login/roles, issue/return/fines, hold queue, XSS, CSV, PDF preview (7 pages) and paywall, subscription/purchase, wishlist, persistence, multi-tab safety, accessibility, reports, barcode entry, reminders, fine receipts, search filters, book covers, backup/restore, the sync server and offline (PWA) mode.

```bash
npm install                          # installs Playwright and pdf-lib (dev dependencies)
npx playwright install chromium      # one-time browser download
npm test                             # runs all suites: tests/e2e.js (35), tests/e2e-flows.js (69), tests/e2e-sync.js (25), tests/e2e-polish.js (18)
```

`npm test` starts its own local server on port 8765, so nothing else needs to be running. The same command runs in GitHub Actions on every push (`.github/workflows/node.js.yml`).

> Note: login, payments and OTP are client-side simulations (demo). A production version needs a real backend (e.g. Node + MySQL), server-side authorization and a payment gateway.
