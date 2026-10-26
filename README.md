# Library Management System (LMS Portal)

A single-file web app (HTML/CSS/vanilla JS) for managing a library: books, members, issue/return, fines and e-book PDFs.

## Features
- Role-based portals: **Admin**, **Librarian**, **Reader**
- Book inventory (add/edit/delete), member directory, issue & return with ₹10/day late fines
- Reader self-registration with simulated email OTP
- Salted SHA-256 password hashing, escaped output (XSS-safe), CSV audit export
- Data saved in browser localStorage; dark/light theme

## Run
Open `index.html` in any modern browser.

Demo logins: `admin@library.org` / `Admin@123` · `librarian@library.org` / `Librarian@123`

> Note: login is client-side only (demo). A production version needs a real backend (e.g. Node + MySQL).
