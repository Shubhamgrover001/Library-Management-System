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
- Data saved in browser localStorage (records) and IndexedDB (PDFs); dark/light theme

## Run
Open `index.html` in any modern browser (internet is needed once per preview to load `pdf-lib` from a CDN).

Demo logins: `admin@library.org` / `Admin@123` · `librarian@library.org` / `Librarian@123`

## Tests
35 automated end-to-end tests (headless Chromium) cover login/roles, issue/return/fines, XSS, CSV, PDF preview (7 pages) and paywall, subscription/purchase, holds, wishlist, persistence and accessibility.

```bash
npm i playwright pdf-lib        # dev dependencies
python3 -m http.server 8765 &   # serve the folder
node tests/e2e.js               # writes tests/results.json
```

> Note: login, payments and OTP are client-side simulations (demo). A production version needs a real backend (e.g. Node + MySQL), server-side authorization and a payment gateway.
