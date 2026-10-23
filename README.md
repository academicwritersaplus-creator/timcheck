# TimCheck

TimCheck is an **educational demonstration** of a similarity (plagiarism) checker. It shows how a checker reads a document, finds matching passages, calculates a percentage, and produces a report. It also teaches how fake checker websites and edited reports mislead students.

> **TimCheck is not connected to Turnitin or any other commercial service.** It compares text only with its own small sample collection. Every report it makes carries the watermark **"TimCheck • EDUCATIONAL DEMO • NOT A TURNITIN REPORT"**. A TimCheck report must never be presented as a Turnitin report or as proof that work is original.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Honest limits](#2-honest-limits)
3. [How it is built](#3-how-it-is-built)
4. [Run it on your computer](#4-run-it-on-your-computer)
5. [Environment variables](#5-environment-variables)
6. [Database setup](#6-database-setup)
7. [File storage](#7-file-storage)
8. [Put it online (hosting)](#8-put-it-online-hosting)
9. [Adding your own sample sources](#9-adding-your-own-sample-sources)
10. [Testing checklist](#10-testing-checklist)
11. [Why not browser storage? (upgrade explanation)](#11-why-not-browser-storage)
12. [Project files](#12-project-files)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What it does

| Feature | How it works |
|---|---|
| Accounts | Register with full name, email and password. Passwords need 8+ characters, a letter and a number. Passwords are stored as bcrypt hashes. Login, logout, 7-day sessions. |
| Personal dashboard | Counts of documents by status, average similarity, recent submissions. |
| Private history | Every query checks the owner. Other users get "not found", even if they guess an ID. |
| Submit | PDF (.pdf), Word (.docx), or pasted text. Size limit (10 MB default), file-type check by content, not only by name. |
| Background processing | Uploads return immediately with status **pending**. A worker reads the file, checks it, and sets **processing → completed** or **failed** (with a clear reason). |
| Similarity checker | Real text matching against the sample collection (see below). Same text = same result, every time. |
| Report page | Watermarked, with highlighted passages, numbered sources, percentage per source, word counts, report reference, date and time. Click a highlight to see the matching source text. |
| PDF report | Downloadable, print-friendly, watermark on every page, footer with reference and verification link. |
| Verification page | Anyone can enter a report reference and see the true stored numbers (not the title or text). This shows how an edited PDF can be caught. |
| History and search | Search by title or reference, filter by status and date, sort, pagination (20 per page). |
| Admin view | Admins see all submissions (title, owner, date, status, %) with a filter by user. Admins do **not** see other people's text or reports. |
| Learn section | How fake sites imitate real services, how invented scores and edited PDFs mislead students, how to tell a genuine report from an unverified one, and why a percentage is not proof of plagiarism. |

### How the similarity number is calculated

1. The text is split into words (capitals and punctuation ignored).
2. Every run of 5 words (a "shingle") is hashed.
3. All hashes are looked up in an indexed database table in **one query**.
4. Each hit is checked word by word, so a hash collision can never create a false match.
5. Hits that continue in the same order in both texts are joined into passages.
6. Each submitted word is given to at most one source (longest passage first), so nothing is counted twice.
7. **Similarity = matched words ÷ total words × 100**, rounded to one decimal.

---

## 2. Honest limits

- The sample collection is small (14 texts written for this demo). Most real writing will show 0%.
- Only exact runs of 5+ words are found. Light rewording, synonyms and translation are not detected.
- Quotes and reference lists are not excluded automatically.
- Scanned PDFs (images with no text layer) cannot be read. There is no OCR.
- Old `.doc` files are not supported. Save as `.docx` or PDF.
- Documents longer than `MAX_WORDS_CHECKED` (60,000 words by default) are checked only up to that limit. The report says so.
- There is no "forgot password" email, because that needs a paid or configured email service. Section 8 explains how to add one.
- The S3 storage option is written and its package installs, but it was **not tested against a real bucket** in this build. Local disk storage was fully tested.

---

## 3. How it is built

- **Node.js + Express 5** web server (`server.js`)
- **PostgreSQL** database for users, documents, matches, sessions and the shingle index
- **Local disk or S3-compatible bucket** for original files
- **Background worker** using `SELECT … FOR UPDATE SKIP LOCKED`, so several workers or servers can share the queue safely
- **pdf-parse** (PDF text), **mammoth** (Word text), **pdfkit** (PDF reports)
- Front end: plain **HTML, CSS and JavaScript** (`public/`). No build step. Works on phones and computers.
- No paid APIs.

Security features: bcrypt password hashing, session ID regenerated on login, `httpOnly` + `SameSite` cookies (`Secure` in production), CSRF protection (custom header required on every change), Helmet security headers with a strict Content Security Policy, rate limits on login/register/upload/verify, parameterised SQL everywhere, uploaded files stored outside the public folder with random names and never served directly.

**Tested performance (this build):** 1,200 documents were submitted through the real API and all were processed in 8.5 seconds. With 1,200+ stored documents, history pages, search and filters each answered in under 10 ms.

---

## 4. Run it on your computer

### What you need

- **Node.js 22** (or 20.16+). Download from <https://nodejs.org>.
- **PostgreSQL 13 or newer**. Download from <https://www.postgresql.org/download/>. (Or use a free hosted database such as Neon or Supabase, see section 6.)

### Steps

```bash
# 1. Get the code and install packages
cd timcheck
npm install

# 2. Create the database (skip if you use a hosted database)
psql -U postgres -c "CREATE USER timcheck WITH PASSWORD 'choose-a-password';"
psql -U postgres -c "CREATE DATABASE timcheck OWNER timcheck;"

# 3. Create your settings file
cp .env.example .env
#    Open .env and set DATABASE_URL and SESSION_SECRET.
#    Make a secret with:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. Create the tables and load the sample collection
npm run migrate
npm run seed

# 5. Start
npm start
```

Open <http://localhost:3000>. Create an account and check a document.

To become an admin, put your email in `ADMIN_EMAILS` in `.env`, then register or log in with that email.

---

## 5. Environment variables

| Name | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgres://timcheck:timcheck@localhost:5432/timcheck` | PostgreSQL connection string |
| `DATABASE_SSL` | Hosted DBs | `false` | Set `true` for Render, Neon, Supabase, Railway |
| `SESSION_SECRET` | Yes in production | (dev value) | Long random string. The server will not start in production without it. |
| `NODE_ENV` | Yes in production | — | Set to `production` online (turns on secure cookies) |
| `APP_URL` | Yes online | `http://localhost:3000` | Your public address. Printed on PDF reports. |
| `PORT` | No | `3000` | Web port (hosts usually set this for you) |
| `ADMIN_EMAILS` | No | — | Comma-separated emails that become admins |
| `STORAGE_DRIVER` | No | `local` | `local` or `s3` |
| `STORAGE_DIR` | No | `./storage` | Folder for uploaded files when `local` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | When `s3` | — | Bucket details |
| `MAX_UPLOAD_MB` | No | `10` | Largest file allowed |
| `UPLOADS_PER_HOUR` | No | `120` | Uploads allowed per user per hour |
| `MAX_PASTE_CHARS` | No | `200000` | Longest pasted text |
| `MAX_WORDS_CHECKED` | No | `60000` | Words checked per document |
| `RUN_WORKER_IN_WEB` | No | `true` | `false` if you run `npm run worker` as a separate process |
| `WORKER_CONCURRENCY` | No | `2` | Documents processed at the same time per process |
| `REPORT_TIMEZONE` | No | `UTC` | Time zone printed on PDF reports, e.g. `America/New_York` |

---

## 6. Database setup

`npm run migrate` runs `db/schema.sql`. It is safe to run many times. It also runs automatically every time the server starts.

Tables:

| Table | Holds |
|---|---|
| `users` | name, email (unique, case-insensitive), bcrypt hash, role |
| `documents` | one row per submission: owner, title, type, status, extracted text, word count, similarity, report reference, times |
| `matches` | one row per highlighted passage (character positions + source excerpt) |
| `sources` | the sample collection |
| `source_shingles` | the 5-word index used for fast matching |
| `user_sessions` | login sessions |

Indexes cover owner + date, status + date, report reference, and a trigram index for title search, so lists stay fast with hundreds of thousands of rows.

The extension `pg_trgm` is required. It is included with standard PostgreSQL and is available on Render, Neon, Supabase and Railway.

**Hosted database options (all have free tiers):**

- **Neon** (<https://neon.tech>): create a project, copy the connection string into `DATABASE_URL`, set `DATABASE_SSL=true`.
- **Supabase** (<https://supabase.com>): Project settings → Database → connection string (use the "session" pooler or direct connection).
- **Render PostgreSQL**: created inside Render (see section 8). Use the *Internal Database URL*.

Backups: hosted databases make daily backups. On your own server, run `pg_dump timcheck > backup.sql` on a schedule.

---

## 7. File storage

Original uploads are kept so a document can be re-processed.

- **`STORAGE_DRIVER=local`** (default): files go in `STORAGE_DIR`, named `u<userId>/<random-id>.<ext>`, with owner-only permissions. Use this on your own server or on a host with a **persistent disk**. Many free hosts wipe the disk on every deploy, so do not use local storage there.
- **`STORAGE_DRIVER=s3`**: files go to any S3-compatible bucket. Good, cheap choices: **Cloudflare R2** (free 10 GB), **Backblaze B2**, **AWS S3**. Keep the bucket **private** (no public access). Example for Cloudflare R2:

```
STORAGE_DRIVER=s3
S3_BUCKET=timcheck-uploads
S3_REGION=auto
S3_ENDPOINT=https://<your-account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

When a user deletes a document, its file is deleted too.

---

## 8. Put it online (hosting)

### Option A: Render (easiest)

1. Put the project in a GitHub repository (the `.gitignore` already leaves out `node_modules`, `.env` and `storage/`).
2. On <https://render.com>: **New → PostgreSQL**. Copy its *Internal Database URL*.
3. **New → Web Service**, connect your repository.
   - Build command: `npm install`
   - Start command: `npm start`
4. Add environment variables: `NODE_ENV=production`, `DATABASE_URL=<internal URL>`, `DATABASE_SSL=true`, `SESSION_SECRET=<random>`, `APP_URL=https://<your-service>.onrender.com`, `ADMIN_EMAILS=<your email>`.
5. Storage: either add a **Disk** to the service (paid plans) mounted at `/var/data` and set `STORAGE_DIR=/var/data/storage`, or use Cloudflare R2 (section 7).
6. Deploy. Then open the service **Shell** and run `npm run seed` once.

### Option B: Railway

1. New project → **Deploy from GitHub repo**, then **Add → Database → PostgreSQL**.
2. In the web service variables, set `DATABASE_URL=${{Postgres.DATABASE_URL}}` and the other variables from Option A step 4.
3. Add a **Volume** mounted at `/data` and set `STORAGE_DIR=/data/storage`, or use R2.
4. Run `npm run seed` once from the service shell.

### Option C: Your own Linux server (VPS)

```bash
# Ubuntu example
sudo apt install -y postgresql nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
# create the database as in section 4, copy the code to /opt/timcheck, then:
cd /opt/timcheck && npm ci --omit=dev && cp .env.example .env   # edit .env
npm run seed
sudo npm install -g pm2 && pm2 start server.js --name timcheck && pm2 save && pm2 startup
```

Nginx (HTTPS with a free Let's Encrypt certificate via `sudo certbot --nginx`):

```nginx
server {
  server_name timcheck.example.com;
  client_max_body_size 12m;            # a little more than MAX_UPLOAD_MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Growing bigger

- Run the worker as its own process: set `RUN_WORKER_IN_WEB=false` on the web service and start a second service with `npm run worker`. You can run several workers; the queue design prevents double processing.
- Use S3/R2 storage so several web servers can share files.
- Stuck jobs (for example after a crash) are put back in the queue automatically after 10 minutes, up to 3 attempts.

### Before real public use

- Set `NODE_ENV=production` and a strong `SESSION_SECRET`.
- Serve over HTTPS only (all the hosts above do this).
- Add password reset by email (for example with an SMTP service) and email verification.
- Write a privacy notice: users upload their own writing, so say how long you keep it and how to delete it (users can already delete documents).
- Keep the TimCheck name, watermark and "not Turnitin" notices. Do not rename the site or reports to anything that imitates a real checker.

---

## 9. Adding your own sample sources

Put `.txt`, `.pdf` or `.docx` files in a folder, then:

```bash
npm run add-sources -- ./my-sources
```

Each file becomes a source named after the file. Running it again updates sources with the same name. Only add texts you have the right to use. The collection is shown publicly on the **Sample collection** page so users know exactly what they are compared against.

---

## 10. Testing checklist

### Automated (all passed in this build)

Start the server (`npm start`), then in a second terminal:

```bash
npm test                 # 40 end-to-end checks
UPLOADS_PER_HOUR=5000 npm start      # (restart with a higher limit first)
npm run load-test -- 1200            # 1,200 documents through the real API
```

`npm test` checks:

- [x] Weak password rejected; registration works; duplicate email (any letter case) rejected
- [x] Logout ends the session; wrong password rejected; login works
- [x] Anonymous users cannot list documents; requests without the app header are blocked (CSRF)
- [x] Pasted text, PDF and Word submissions are accepted and complete
- [x] Correct sample sources are matched; highlights point at the right characters
- [x] Same text gives the same percentage twice (reproducible)
- [x] Fake PDF rejected; `.doc` gets a helpful message; too-short text rejected; files over the size limit rejected (413)
- [x] PDF report downloads and is a real PDF
- [x] Verification page finds a real reference, hides the title, and reports unknown references as not found
- [x] User B cannot open, download or delete user A's document; user B's history is empty
- [x] Normal users cannot use the admin API
- [x] Search by title and by reference; filter by status and date; `%` in search is treated literally
- [x] Owner can delete a document and it is gone

Load test result: 1,200 accepted, 1,200 completed, 0 failed; first page, page 50, last page, search and filters each < 10 ms.

### Manual checks (done with a headless browser in this build)

- [x] Landing page, register, dashboard, submit, report, history, learn pages render on desktop (1280 px) and phone (390 px)
- [x] Phone menu opens and closes
- [x] Clicking a highlight shows the matching source passage
- [x] A scanned PDF with no text ends as **failed** with a clear reason, and offers "Try again" / "Delete"
- [x] Admin page shows all submissions and filters by user
- [x] PDF report: watermark on every page, reference and verification link in the footer

Things worth checking on your own deployment:

- [ ] Register, log in, log out on your real domain (HTTPS)
- [ ] Upload a real PDF and Word file from your phone
- [ ] Download the PDF report and print it
- [ ] Open the verification page and enter the reference from the PDF
- [ ] Log in as a second user and confirm you cannot see the first user's documents
- [ ] Restart the server and confirm documents and accounts are still there

---

## 11. Why not browser storage?

A simple prototype could keep accounts and documents in the browser's `localStorage`. That does not work for a real service:

| Browser storage | This build (database + file storage) |
|---|---|
| About 5–10 MB per site. A few hundred documents fill it. | PostgreSQL holds millions of rows; files go to disk or a bucket with no practical limit. |
| Lives in one browser on one device. Clearing the browser deletes everything. | Saved on the server. Users can log in from any device. |
| Anyone with the device can read it. Passwords would have to be checked in the browser, which is not secure. | Passwords checked on the server with bcrypt; sessions in secure cookies. |
| No real separation between users. | Every query is filtered by the logged-in user. |
| Loading all records at once becomes slow. | Pagination and indexes keep each page fast. |

So this project already uses the "upgraded" design. If you start from a browser-only prototype, the upgrade path is the one used here:

1. Move accounts to a `users` table and check passwords on the server (bcrypt).
2. Replace local storage reads/writes with API calls (`fetch('/api/...')`).
3. Store document records in a database table with an owner column, and always filter by the logged-in user.
4. Store files in server storage or a bucket, not as text inside the browser.
5. Process heavy work (text extraction, matching) on the server in the background.
6. Add pagination, indexes, rate limits and HTTPS.

The front end only keeps one tiny item in `sessionStorage`: the page to return to after login.

---

## 12. Project files

```
server.js                 web server, security headers, sessions, routes
src/config.js             reads environment variables
src/db.js                 PostgreSQL connection pool
src/migrate.js            creates/updates tables (db/schema.sql)
src/seed.js               loads sample sources (npm run seed / add-sources)
src/similarity.js         the matching engine
src/extract.js            PDF and Word text extraction, file-type checks
src/worker.js             background queue worker
src/storage.js            local disk or S3 file storage
src/report-pdf.js         watermarked PDF report
src/middleware.js         login checks, admin check, CSRF header check
src/routes/auth.js        register, login, logout
src/routes/documents.js   submit, list, search, report, PDF, retry, delete
src/routes/admin.js       admin overview
src/routes/public.js      verification, sample collection, health check
public/                   the website (index.html, styles.css, app.js)
data/sample-sources.json  the 14 sample texts
assets/fonts/             DejaVu Sans fonts for PDF reports (free licence included)
scripts/smoke-test.js     end-to-end tests (npm test)
scripts/load-test.js      1,000+ document load test
test/fixtures/            sample PDF and Word files used by the tests
```

---

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| `Startup failed: connect ECONNREFUSED` | PostgreSQL is not running, or `DATABASE_URL` is wrong. |
| `self-signed certificate` / SSL errors | Set `DATABASE_SSL=true` for hosted databases. |
| `extension "pg_trgm" is not available` | Install the PostgreSQL "contrib" package (`sudo apt install postgresql-contrib`). |
| Every report shows 0% | Run `npm run seed`. The Sample collection page should list 14 sources. |
| Documents stay "pending" | The worker is not running. Keep `RUN_WORKER_IN_WEB=true`, or start `npm run worker`. |
| "Too many attempts" when logging in | Login is limited to 30 tries per 15 minutes per address. Wait, or restart the server in development. |
| Login works locally but not online | Set `NODE_ENV=production` and use HTTPS. Secure cookies are not sent over plain HTTP. |
| PDF upload fails with "No text found" | The PDF is a scanned image. Export it from Word as PDF, or paste the text instead. |
