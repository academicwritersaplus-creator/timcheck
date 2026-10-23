'use strict';
require('dotenv').config({ quiet: true });

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: int('PORT', 3000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || 'postgres://timcheck:timcheck@localhost:5432/timcheck',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionSecret: process.env.SESSION_SECRET || '',
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  // File storage
  storageDriver: process.env.STORAGE_DRIVER || 'local',        // 'local' or 's3'
  storageDir: process.env.STORAGE_DIR || './storage',
  s3: {
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,             // set for Cloudflare R2, Backblaze, MinIO
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },

  // Limits
  maxUploadMb: int('MAX_UPLOAD_MB', 10),
  uploadsPerHour: int('UPLOADS_PER_HOUR', 120),
  maxPasteChars: int('MAX_PASTE_CHARS', 200000),
  maxWordsChecked: int('MAX_WORDS_CHECKED', 60000),
  minWords: 20,

  // Background worker
  runWorkerInWeb: process.env.RUN_WORKER_IN_WEB !== 'false',
  workerConcurrency: int('WORKER_CONCURRENCY', 2),
  workerPollMs: int('WORKER_POLL_MS', 1500),
  maxAttempts: 3,
};

if (!config.sessionSecret) {
  if (isProd) {
    console.error('SESSION_SECRET must be set in production. Refusing to start.');
    process.exit(1);
  }
  config.sessionSecret = 'dev-only-secret-change-me';
  console.warn('[config] SESSION_SECRET not set - using an insecure development secret.');
}

module.exports = config;
'use strict';
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on('error', err => console.error('[db] idle client error', err.message));

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
'use strict';
// Creates or updates the database tables. Run with: npm run migrate
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  migrate()
    .then(() => { console.log('Database schema is up to date.'); return pool.end(); })
    .catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
}

module.exports = migrate;
'use strict';
/*
 * Loads sources into the comparison collection.
 *   npm run seed                      -> loads data/sample-sources.json
 *   npm run add-sources -- ./folder   -> loads every .txt, .pdf and .docx file in a folder
 * Re-running is safe: a source with the same title is updated, not duplicated.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const migrate = require('./migrate');
const { indexSource, tokenize } = require('./similarity');
const { extractText, detectType } = require('./extract');

async function upsertSource({ title, author, origin, body }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const words = tokenize(body).length;
    const { rows } = await client.query(
      `INSERT INTO sources (title, author, origin, body, word_count) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (title) DO UPDATE SET author = EXCLUDED.author, origin = EXCLUDED.origin,
         body = EXCLUDED.body, word_count = EXCLUDED.word_count
       RETURNING id`, [title.slice(0, 300), author || null, origin || null, body, words]);
    const n = await indexSource(client, rows[0].id, body);
    await client.query('COMMIT');
    return { id: rows[0].id, shingles: n };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fromFolder(dir) {
  const files = fs.readdirSync(dir).filter(f => /\.(txt|pdf|docx)$/i.test(f));
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const type = /\.txt$/i.test(f) ? 'text' : detectType(buf, f);
    if (!type) { console.warn(`skip ${f}: not a valid file`); continue; }
    try {
      const body = await extractText(buf, type);
      const r = await upsertSource({ title: f.replace(/\.[^.]+$/, ''), author: null, origin: `Imported file: ${f}`, body });
      console.log(`added "${f}" (source #${r.id}, ${r.shingles} shingles)`);
    } catch (e) { console.warn(`skip ${f}: ${e.message}`); }
  }
}

async function main() {
  await migrate();
  const dir = process.argv[2];
  if (dir) {
    await fromFolder(dir);
  } else {
    const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'sample-sources.json'), 'utf8'));
    for (const s of samples) {
      const r = await upsertSource(s);
      console.log(`source #${r.id}: ${s.title}`);
    }
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM sources');
  console.log(`Comparison collection now has ${rows[0].n} sources.`);
}

if (require.main === module) {
  main().then(() => pool.end()).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { upsertSource };
'use strict';
/*
 * TimCheck similarity engine
 * --------------------------
 * 1. Split text into words (lower-case, punctuation ignored).
 * 2. Make overlapping 5-word "shingles" and hash each one.
 * 3. Look up every shingle hash in the source_shingles index (one SQL query).
 * 4. Verify hash hits word-by-word (so hash collisions can never create a match).
 * 5. Join hits that line up in both texts into continuous passages.
 * 6. Give each submitted word to at most ONE source (longest passage wins),
 *    so overlapping sources are never double counted.
 * 7. Similarity % = matched words / total words * 100.
 *
 * The same text always gives the same result (fully deterministic).
 */
const crypto = require('crypto');

const K = 5; // shingle size in words
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(WORD_RE)) {
    tokens.push({
      w: m[0].toLowerCase().replace(/’/g, "'").normalize('NFKC'),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

// 48-bit hash: fits safely in a JavaScript number and a PostgreSQL BIGINT.
function hashShingle(words) {
  return crypto.createHash('md5').update(words.join(' ')).digest().readUIntBE(0, 6);
}

function shingles(tokens) {
  const out = [];
  for (let i = 0; i + K <= tokens.length; i++) {
    out.push(hashShingle(tokens.slice(i, i + K).map(t => t.w)));
  }
  return out;
}

/** Add one source to the comparison collection (inside a transaction client). */
async function indexSource(client, sourceId, body) {
  const hashes = shingles(tokenize(body));
  await client.query('DELETE FROM source_shingles WHERE source_id = $1', [sourceId]);
  const CHUNK = 5000;
  for (let off = 0; off < hashes.length; off += CHUNK) {
    const part = hashes.slice(off, off + CHUNK);
    await client.query(
      `INSERT INTO source_shingles (hash, source_id, pos)
       SELECT h, $2, p FROM unnest($1::bigint[], $3::int[]) AS t(h, p)`,
      [part, sourceId, part.map((_, i) => off + i)],
    );
  }
  return hashes.length;
}

/** Compare text against the whole collection. `db` is a pg Pool or client. */
async function checkText(db, text, { maxWords = 60000 } = {}) {
  let tokens = tokenize(text);
  const truncated = tokens.length > maxWords;
  if (truncated) tokens = tokens.slice(0, maxWords);
  const n = tokens.length;
  const result = { totalWords: n, matchedWords: 0, similarity: 0, sources: [], passages: [], truncated };
  if (n < K) return result;

  const docHashes = shingles(tokens);
  const unique = [...new Set(docHashes)];
  const { rows } = await db.query(
    'SELECT hash, source_id, pos FROM source_shingles WHERE hash = ANY($1::bigint[])',
    [unique],
  );
  if (!rows.length) return result;

  // hash -> list of [sourceId, pos]
  const hits = new Map();
  for (const r of rows) {
    const h = Number(r.hash);
    if (!hits.has(h)) hits.set(h, []);
    hits.get(h).push([r.source_id, r.pos]);
  }

  // Load the candidate sources so every hit can be verified word-by-word.
  const sourceIds = [...new Set(rows.map(r => r.source_id))];
  const srcRes = await db.query(
    'SELECT id, title, author, origin, body FROM sources WHERE id = ANY($1::int[])', [sourceIds]);
  const src = new Map();
  for (const s of srcRes.rows) src.set(s.id, { ...s, tokens: tokenize(s.body) });

  // Collect verified hits grouped by (source, diagonal). On one diagonal the
  // doc position and source position move forward together = same passage.
  const diagonals = new Map();
  docHashes.forEach((h, i) => {
    const list = hits.get(h);
    if (!list) return;
    for (const [sid, j] of list) {
      const st = src.get(sid).tokens;
      let ok = true;
      for (let k = 0; k < K; k++) if (!st[j + k] || st[j + k].w !== tokens[i + k].w) { ok = false; break; }
      if (!ok) continue;
      const key = sid + ':' + (i - j);
      if (!diagonals.has(key)) diagonals.set(key, []);
      diagonals.get(key).push(i);
    }
  });

  // Merge neighbouring hits into runs.
  const runs = [];
  for (const [key, list] of diagonals) {
    const [sid, d] = key.split(':').map(Number);
    list.sort((a, b) => a - b);
    let a = list[0], b = list[0];
    for (let x = 1; x <= list.length; x++) {
      if (x < list.length && list[x] === b + 1) { b = list[x]; continue; }
      runs.push({ sid, d, a, b: b + K - 1, len: b + K - a });
      if (x < list.length) { a = b = list[x]; }
    }
  }
  // Longest first; ties broken by source id then position (deterministic).
  runs.sort((r1, r2) => r2.len - r1.len || r1.sid - r2.sid || r1.a - r2.a);

  const owner = new Int32Array(n);         // 0 = unmatched, otherwise source id
  const srcPos = new Int32Array(n).fill(-1);
  for (const r of runs) {
    let free = 0;
    for (let i = r.a; i <= r.b; i++) if (!owner[i]) free++;
    if (free < K) continue;                 // mostly covered already
    for (let i = r.a; i <= r.b; i++) if (!owner[i]) { owner[i] = r.sid; srcPos[i] = i - r.d; }
  }

  // Build passages: continuous words owned by the same source.
  const perSource = new Map();
  let matched = 0;
  for (let i = 0; i < n;) {
    if (!owner[i]) { i++; continue; }
    const sid = owner[i];
    let j = i;
    while (j + 1 < n && owner[j + 1] === sid) j++;
    const words = j - i + 1;
    matched += words;
    perSource.set(sid, (perSource.get(sid) || 0) + words);
    const st = src.get(sid).tokens, body = src.get(sid).body;
    let s0 = Infinity, s1 = -1;
    for (let x = i; x <= j; x++) { s0 = Math.min(s0, srcPos[x]); s1 = Math.max(s1, srcPos[x]); }
    let excerpt = body.slice(st[s0].start, st[s1].end).replace(/\s+/g, ' ');
    if (excerpt.length > 600) excerpt = excerpt.slice(0, 597) + '...';
    result.passages.push({
      sourceId: sid,
      charStart: tokens[i].start,
      charEnd: tokens[j].end,
      wordCount: words,
      excerpt,
    });
    i = j + 1;
  }

  result.matchedWords = matched;
  result.similarity = Math.round((matched / n) * 1000) / 10;
  result.sources = [...perSource.entries()]
    .map(([sid, words]) => {
      const s = src.get(sid);
      return { sourceId: sid, title: s.title, author: s.author, origin: s.origin, words,
        percent: Math.round((words / n) * 1000) / 10 };
    })
    .sort((x, y) => y.words - x.words || x.sourceId - y.sourceId);
  return result;
}

module.exports = { tokenize, shingles, indexSource, checkText, K };
'use strict';
// Turns an uploaded file into plain text.
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

function detectType(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const head = buffer.subarray(0, 5).toString('latin1');
  if (ext === 'pdf' && head.startsWith('%PDF')) return 'pdf';
  // .docx files are ZIP archives and start with "PK"
  if (ext === 'docx' && head.startsWith('PK')) return 'docx';
  return null;
}

function clean(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')                 // soft hyphens
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractText(buffer, type) {
  if (type === 'text') return clean(buffer.toString('utf8'));
  if (type === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    let data;
    try { data = await parser.getText({ pageJoiner: '\n' }); } finally { await parser.destroy().catch(() => {}); }
    // Re-join words that were hyphenated across a line break ("infec-\ntion").
    // PDFs break lines at the page edge; join those lines back into paragraphs.
    const text = clean((data.text || '').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2'))
      .replace(/([^\n.!?:])\n(?=[^\n])/g, '$1 ');
    if (!text) throw new Error('No text found in this PDF. It may be a scanned image (OCR is not supported in this demo).');
    return text;
  }
  if (type === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    const text = clean(value || '');
    if (!text) throw new Error('No text found in this Word document.');
    return text;
  }
  throw new Error('Unsupported file type');
}

module.exports = { detectType, extractText, clean };
'use strict';
/*
 * Background worker. Uploads are saved as "pending" and the web request
 * returns at once. Workers pick jobs from the documents table using
 * FOR UPDATE SKIP LOCKED, so you can run several workers (or several
 * servers) without two of them processing the same document.
 *
 * Runs inside the web process by default. For larger installs run it on
 * its own:  RUN_WORKER_IN_WEB=false in the web service + `npm run worker`.
 */
const crypto = require('crypto');
const config = require('./config');
const { pool } = require('./db');
const storage = require('./storage');
const { extractText } = require('./extract');
const { checkText } = require('./similarity');

let stopping = false;

async function claimJob() {
  const { rows } = await pool.query(`
    UPDATE documents SET status = 'processing', started_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM documents WHERE status = 'pending'
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, input_type, storage_key, attempts`);
  return rows[0] || null;
}

async function processJob(job) {
  const buffer = await storage.read(job.storage_key);
  const text = await extractText(buffer, job.input_type);
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < config.minWords) {
    throw new Error(`The document has only ${words.length} words. At least ${config.minWords} are needed.`);
  }
  const result = await checkText(pool, text, { maxWords: config.maxWordsChecked });
  const sha = crypto.createHash('sha256').update(text).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM matches WHERE document_id = $1', [job.id]);
    if (result.passages.length) {
      await client.query(
        `INSERT INTO matches (document_id, source_id, char_start, char_end, word_count, source_excerpt)
         SELECT $1, * FROM unnest($2::int[], $3::int[], $4::int[], $5::int[], $6::text[])`,
        [job.id,
          result.passages.map(p => p.sourceId), result.passages.map(p => p.charStart),
          result.passages.map(p => p.charEnd), result.passages.map(p => p.wordCount),
          result.passages.map(p => p.excerpt)],
      );
    }
    await client.query(
      `UPDATE documents SET status = 'completed', extracted_text = $2, text_sha256 = $3,
         word_count = $4, matched_words = $5, similarity = $6, completed_at = now(),
         error_message = $7
       WHERE id = $1`,
      [job.id, text, sha, result.totalWords, result.matchedWords, result.similarity,
        result.truncated ? `Only the first ${config.maxWordsChecked} words were checked.` : null],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function failOrRetry(job, err) {
  const userError = err && err.message ? err.message.slice(0, 500) : 'Unknown error';
  const permanent = /No text found|Unsupported|only \d+ words|Invalid/.test(userError);
  const finalFail = permanent || job.attempts >= config.maxAttempts;
  await pool.query(
    `UPDATE documents SET status = $2::varchar, error_message = $3,
       completed_at = CASE WHEN $2::varchar = 'failed' THEN now() END
     WHERE id = $1`,
    [job.id, finalFail ? 'failed' : 'pending', userError],
  );
  console.warn(`[worker] ${job.id} ${finalFail ? 'failed' : 'will retry'}: ${userError}`);
}

// If a worker crashed mid-job, put stuck jobs back in the queue.
async function recoverStale() {
  await pool.query(`
    UPDATE documents
    SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
        error_message = CASE WHEN attempts >= $1 THEN 'Processing timed out.' ELSE error_message END
    WHERE status = 'processing' AND started_at < now() - interval '10 minutes'`, [config.maxAttempts]);
}

async function loop(id) {
  while (!stopping) {
    let job = null;
    try {
      job = await claimJob();
      if (!job) { await new Promise(r => setTimeout(r, config.workerPollMs)); continue; }
      await processJob(job);
    } catch (err) {
      if (job) await failOrRetry(job, err).catch(e => console.error('[worker]', e.message));
      else { console.error(`[worker ${id}]`, err.message); await new Promise(r => setTimeout(r, 3000)); }
    }
  }
}

function start() {
  recoverStale().catch(e => console.error('[worker] recover', e.message));
  setInterval(() => recoverStale().catch(() => {}), 60000).unref();
  for (let i = 0; i < config.workerConcurrency; i++) loop(i + 1);
  console.log(`[worker] started ${config.workerConcurrency} worker loop(s)`);
}

function stop() { stopping = true; }

if (require.main === module) {
  start();
  process.on('SIGTERM', () => { stop(); setTimeout(() => process.exit(0), 2000); });
}

module.exports = { start, stop, processJob };
'use strict';
// File storage for uploaded originals.
// - "local": files are written to STORAGE_DIR, outside the public web folder,
//   under random names. They are never served directly; only the owner's
//   extracted text is shown through authenticated API routes.
// - "s3": any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

function safeKey(key) {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
  return key;
}

const local = {
  root: path.resolve(config.storageDir),
  async save(key, buffer) {
    const file = path.join(this.root, safeKey(key));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer, { mode: 0o600 });
  },
  async read(key) {
    return fs.readFile(path.join(this.root, safeKey(key)));
  },
  async remove(key) {
    await fs.rm(path.join(this.root, safeKey(key)), { force: true });
  },
};

let s3Client = null;
async function s3() {
  if (s3Client) return s3Client;
  let sdk;
  try { sdk = require('@aws-sdk/client-s3'); } catch {
    throw new Error('STORAGE_DRIVER=s3 needs the package @aws-sdk/client-s3 (npm install @aws-sdk/client-s3)');
  }
  const client = new sdk.S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: Boolean(config.s3.endpoint),
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  s3Client = { sdk, client };
  return s3Client;
}

const remote = {
  async save(key, buffer) {
    const { sdk, client } = await s3();
    await client.send(new sdk.PutObjectCommand({
      Bucket: config.s3.bucket, Key: safeKey(key), Body: buffer, ServerSideEncryption: config.s3.endpoint ? undefined : 'AES256',
    }));
  },
  async read(key) {
    const { sdk, client } = await s3();
    const out = await client.send(new sdk.GetObjectCommand({ Bucket: config.s3.bucket, Key: safeKey(key) }));
    return Buffer.from(await out.Body.transformToByteArray());
  },
  async remove(key) {
    const { sdk, client } = await s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: config.s3.bucket, Key: safeKey(key) }));
  },
};

module.exports = config.storageDriver === 's3' ? remote : local;
'use strict';
// Builds the downloadable, print-friendly PDF report.
// Every page carries a diagonal "TimCheck - EDUCATIONAL DEMO - NOT A TURNITIN REPORT"
// watermark and a footer with the report reference and verification link.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('./config');

// Fonts: DejaVu Sans (supports most languages) is looked for in assets/fonts
// or in the project's top folder. If it is missing, the built-in Helvetica is used.
function findFont(file, fallback) {
  for (const dir of [path.join(__dirname, '..', 'assets', 'fonts'), path.join(__dirname, '..')]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return fallback;
}
const FONT = findFont('DejaVuSans.ttf', 'Helvetica');
const FONT_BOLD = findFont('DejaVuSans-Bold.ttf', 'Helvetica-Bold');
const FONT_ITALIC = findFont('DejaVuSans-Oblique.ttf', 'Helvetica-Oblique');

const INK = '#1c2433';
const MUTED = '#5b6577';
const BRAND = '#0f766e';
const WATERMARK = 'TimCheck  •  EDUCATIONAL DEMO  •  NOT A TURNITIN REPORT';
const SOURCE_COLORS = ['#c2410c', '#1d4ed8', '#7e22ce', '#15803d', '#be123c', '#a16207', '#0e7490', '#4338ca'];

function colorFor(index) { return SOURCE_COLORS[index % SOURCE_COLORS.length]; }

function fmtDate(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: process.env.REPORT_TIMEZONE || 'UTC',
    timeZoneName: 'short',
  }).format(new Date(d));
}

/**
 * @param {object} doc      documents row (completed)
 * @param {Array}  sources  [{source_id, title, author, origin, words, percent}]
 * @param {Array}  matches  [{source_id, char_start, char_end, word_count, source_excerpt}]
 * @param {stream.Writable} out
 */
function buildReportPdf(doc, sources, matches, out) {
  const pdf = new PDFDocument({
    size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true,
    info: {
      Title: `TimCheck educational demo report ${doc.report_ref}`,
      Author: 'TimCheck (educational demonstration)',
      Subject: 'Independent similarity estimate. Not a Turnitin report.',
      Keywords: 'TimCheck, educational demonstration, not Turnitin',
    },
  });
  pdf.registerFont('body', FONT);
  pdf.registerFont('bold', FONT_BOLD);
  pdf.registerFont('italic', FONT_ITALIC);
  pdf.pipe(out);

  const W = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const L = pdf.page.margins.left;
  const srcIndex = new Map(sources.map((s, i) => [s.source_id, i]));

  // ---------- header
  pdf.rect(0, 0, pdf.page.width, 6).fill(BRAND);
  pdf.font('bold').fontSize(22).fillColor(BRAND).text('TimCheck', L, 50, { continued: true })
    .font('body').fontSize(11).fillColor(MUTED).text('   Similarity demonstration report');
  pdf.y += 14;

  // ---------- disclaimer box
  const boxY = pdf.y;
  const disclaimer = 'EDUCATIONAL DEMONSTRATION — NOT A TURNITIN REPORT. This report was produced by TimCheck, '
    + 'an independent teaching tool. It compares text only against TimCheck\'s own small collection of sample documents. '
    + 'It is not connected to Turnitin or any other commercial database, and it cannot be used as evidence of originality.';
  pdf.font('body').fontSize(8.5);
  const dh = pdf.heightOfString(disclaimer, { width: W - 20 }) + 16;
  pdf.roundedRect(L, boxY, W, dh, 4).fillAndStroke('#fff7e6', '#f0b44c');
  pdf.fillColor('#7a4b00').text(disclaimer, L + 10, boxY + 8, { width: W - 20 });
  pdf.y = boxY + dh + 16;

  // ---------- summary
  const top = pdf.y;
  const rows = [
    ['Document title', doc.title],
    ['Report reference', doc.report_ref],
    ['Submitted', fmtDate(doc.created_at)],
    ['Report generated', fmtDate(doc.completed_at)],
    ['Total words checked', String(doc.word_count)],
    ['Matched words', String(doc.matched_words)],
    ['Matched passages', String(matches.length)],
    ['Sample sources matched', String(sources.length)],
  ];
  let y = top;
  for (const [k, v] of rows) {
    pdf.font('body').fontSize(9).fillColor(MUTED).text(k, L, y, { width: 130 });
    pdf.font('bold').fontSize(9.5).fillColor(INK).text(v, L + 135, y, { width: W - 135 - 150 });
    y = Math.max(pdf.y, y + 14) + 3;
  }
  // big percentage
  const cx = L + W - 130;
  pdf.roundedRect(cx, top, 130, 92, 6).fill('#eef7f6');
  pdf.font('bold').fontSize(32).fillColor(BRAND).text(`${Number(doc.similarity).toFixed(1)}%`, cx, top + 16, { width: 130, align: 'center' });
  pdf.font('body').fontSize(8.5).fillColor(MUTED).text('similarity estimate\n(demo calculation)', cx, top + 58, { width: 130, align: 'center' });
  pdf.y = Math.max(y, top + 100) + 10;

  if (doc.error_message) {
    pdf.font('italic').fontSize(8.5).fillColor('#9a3412').text(`Note: ${doc.error_message}`, L);
    pdf.moveDown(0.5);
  }

  // ---------- sources
  heading(pdf, 'Matched sample sources', L);
  if (!sources.length) {
    pdf.font('body').fontSize(10).fillColor(MUTED).text('No passages matched the sample collection.', L);
  }
  sources.forEach((s, i) => {
    const yy = pdf.y;
    if (yy > pdf.page.height - 110) pdf.addPage();
    const y2 = pdf.y;
    pdf.rect(L, y2 + 2, 10, 10).fill(colorFor(i));
    pdf.font('bold').fontSize(10).fillColor(INK).text(`[${i + 1}]  ${s.title}`, L + 18, y2, { width: W - 90 });
    const after = pdf.y;
    pdf.font('bold').fontSize(10).fillColor(colorFor(i)).text(`${Number(s.percent).toFixed(1)}%`, L + W - 60, y2, { width: 60, align: 'right' });
    pdf.y = after;
    const meta = [s.author, s.origin, `${s.words} matched words`].filter(Boolean).join(' · ');
    pdf.font('body').fontSize(8.5).fillColor(MUTED).text(meta, L + 18, pdf.y, { width: W - 18 });
    pdf.moveDown(0.5);
  });
  pdf.font('italic').fontSize(8).fillColor(MUTED)
    .text('Sources are TimCheck sample documents written or collected for this demonstration only.', L);

  // ---------- full text with highlights
  pdf.addPage();
  heading(pdf, 'Submitted text with highlighted matches', L);
  pdf.font('body').fontSize(8.5).fillColor(MUTED)
    .text('Coloured, underlined text matched a sample source. The number in brackets shows which source.', L);
  pdf.moveDown(0.6);

  // Single line breaks become spaces (same length, so match offsets stay valid).
  const text = (doc.extracted_text || '').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
  const segs = [];
  let pos = 0;
  for (const m of matches) {
    if (m.char_start > pos) segs.push({ t: text.slice(pos, m.char_start) });
    segs.push({ t: text.slice(m.char_start, m.char_end), src: srcIndex.get(m.source_id) });
    pos = m.char_end;
  }
  if (pos < text.length) segs.push({ t: text.slice(pos) });
  pdf.x = L;
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s.src === undefined) {
      pdf.font('body').fontSize(10).fillColor(INK).text(s.t, { continued: !last, lineGap: 3, width: W, underline: false });
    } else {
      pdf.font('bold').fontSize(10).fillColor(colorFor(s.src)).text(s.t, { continued: true, lineGap: 3, width: W, underline: true });
      pdf.font('body').fontSize(7.5).fillColor(colorFor(s.src)).text(` [${s.src + 1}] `, { continued: !last, lineGap: 3, underline: false });
    }
  });
  if (!segs.length) pdf.text('');

  // ---------- passage details
  if (matches.length) {
    pdf.addPage();
    heading(pdf, 'Matched passage details', L);
    const limit = 300;
    matches.slice(0, limit).forEach((m, i) => {
      if (pdf.y > pdf.page.height - 140) pdf.addPage();
      const si = srcIndex.get(m.source_id);
      const s = sources[si];
      pdf.font('bold').fontSize(9).fillColor(colorFor(si))
        .text(`Passage ${i + 1} · ${m.word_count} words · Source [${si + 1}] ${s ? s.title : ''}`, L, pdf.y, { width: W });
      pdf.font('body').fontSize(8.5).fillColor(INK)
        .text(`Submitted: “${clip(text.slice(m.char_start, m.char_end))}”`, L + 10, pdf.y + 2, { width: W - 10 });
      pdf.font('italic').fontSize(8.5).fillColor(MUTED)
        .text(`Sample source: “${clip(m.source_excerpt)}”`, L + 10, pdf.y + 2, { width: W - 10 });
      pdf.moveDown(0.7);
    });
    if (matches.length > limit) {
      pdf.font('italic').fontSize(8.5).fillColor(MUTED).text(`…and ${matches.length - limit} more passages (see the online report).`, L);
    }
  }

  // ---------- how to read
  if (pdf.y > pdf.page.height - 200) pdf.addPage(); else pdf.moveDown(1.2);
  heading(pdf, 'How to read this demonstration', L);
  const notes = [
    'The percentage is matched words divided by total words, using exact runs of 5 or more words.',
    'A high percentage does not prove plagiarism. Quotes, references, common phrases and properly cited material also match.',
    'A low percentage does not prove originality. TimCheck only knows its own small sample collection.',
    `Check this report is unedited: open ${config.appUrl}/#/verify and enter reference ${doc.report_ref}. `
      + `The text fingerprint shown there must be: ${doc.text_sha256}`,
  ];
  notes.forEach(n => {
    pdf.font('body').fontSize(9).fillColor(INK).text(`•  ${n}`, L, pdf.y, { width: W });
    pdf.moveDown(0.3);
  });

  // ---------- watermark + footer on every page
  const range = pdf.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    pdf.switchToPage(p);
    const bottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.save();
    pdf.fillColor(BRAND).opacity(0.08).font('bold').fontSize(19);
    const ww = pdf.widthOfString(WATERMARK);
    for (const fy of [0.2, 0.5, 0.8]) {
      pdf.save();
      pdf.rotate(-32, { origin: [pdf.page.width / 2, pdf.page.height * fy] });
      pdf.text(WATERMARK, pdf.page.width / 2 - ww / 2, pdf.page.height * fy - 10, { lineBreak: false });
      pdf.restore();
    }
    pdf.restore();
    pdf.opacity(1);
    pdf.moveTo(L, pdf.page.height - 44).lineTo(L + W, pdf.page.height - 44).lineWidth(0.5).stroke('#d5dae3');
    pdf.font('bold').fontSize(7.5).fillColor(MUTED)
      .text(`TimCheck educational demonstration. Not a Turnitin report. Ref ${doc.report_ref}`, L, pdf.page.height - 38, { lineBreak: false });
    pdf.font('body').text(`Verify this report at ${config.appUrl}/#/verify`, L, pdf.page.height - 28, { lineBreak: false });
    pdf.text(`Page ${p - range.start + 1} of ${range.count}`, L + W - 60, pdf.page.height - 38, { width: 60, align: 'right', lineBreak: false });
    pdf.page.margins.bottom = bottom;
  }
  pdf.end();
}

function heading(pdf, t, L) {
  pdf.font('bold').fontSize(13).fillColor(INK).text(t, L);
  pdf.moveDown(0.4);
}

function clip(s, n = 400) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { buildReportPdf, SOURCE_COLORS };
'use strict';
const db = require('./db');

// Loads the logged-in user from the database on every protected request,
// so a deleted account or changed role takes effect immediately.
async function requireAuth(req, res, next) {
  try {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Please log in.' });
    const { rows } = await db.query('SELECT id, full_name, email, role FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Please log in.' });
    }
    req.user = rows[0];
    next();
  } catch (e) { next(e); }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

// CSRF protection: browsers will not let another website add a custom header
// to a cross-site request without a CORS pre-flight (which we never allow).
function requireAppHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'TimCheck') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { requireAuth, requireAdmin, requireAppHeader, UUID_RE, asyncRoute };
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy-password', 12);
const EMAIL_RE =/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function validatePassword(pw) {
  const problems = [];
  if (typeof pw !== 'string' || pw.length < 8) problems.push('at least 8 characters');
  if (typeof pw === 'string' && pw.length > 128) problems.push('no more than 128 characters');
  if (!/[A-Za-z]/.test(pw || '')) problems.push('a letter');
  if (!/[0-9]/.test(pw || '')) problems.push('a number');
  return problems;
}

function publicUser(u) {
  return { id: u.id, fullName: u.full_name, email: u.email, role: u.role };
}

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    // New session id on login prevents session-fixation attacks.
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save(e => (e ? reject(e) : resolve()));
    });
  });
}

router.post('/register', authLimiter, asyncRoute(async (req, res) => {
  const fullName = String(req.body.fullName || '').trim().replace(/\s+/g, ' ');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = req.body.password;
  const errors = {};
  if (fullName.length < 2 || fullName.length > 100) errors.fullName = 'Enter your full name (2–100 characters).';
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
  const pw = validatePassword(password);
  if (pw.length) errors.password = `Password needs ${pw.join(', ')}.`;
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });

  const hash = await bcrypt.hash(password, 12);
  const role = config.adminEmails.includes(email) ? 'admin' : 'user';
  let user;
  try {
    const { rows } = await db.query(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, full_name, email, role',
      [fullName, email, hash, role]);
    user = rows[0];
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.', fields: { email: 'This email is already registered.' } });
    throw e;
  }
  await startSession(req, user);
  res.status(201).json({ user: publicUser(user) });
}));

router.post('/login', authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
  const user = rows[0];
  // Always run bcrypt so response time does not reveal whether the email exists.
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (config.adminEmails.includes(email) && user.role !== 'admin') {
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    user.role = 'admin';
  }
  await startSession(req, user);
  res.json({ user: publicUser(user) });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('timcheck.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

module.exports = router;
'use strict';
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const storage = require('../storage');
const { detectType } = require('../extract');
const { buildReportPdf } = require('../report-pdf');
const { requireAuth, UUID_RE, asyncRoute } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 5, fieldSize: config.maxPasteChars * 4 },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: config.uploadsPerHour, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => `u${req.user.id}`,
  message: { error: `Upload limit reached (${config.uploadsPerHour} per hour). Please try again later.` },
});

function makeReportRef() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `TC-${d}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function cleanTitle(t, fallback) {
  const s = String(t || '').replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, ' ');
  return (s || fallback || 'Untitled document').slice(0, 200);
}

// ------------------------------------------------------------- submit
router.post('/', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is too large. The limit is ${config.maxUploadMb} MB.` });
    if (err.code === 'LIMIT_FIELD_VALUE') return res.status(413).json({ error: `Pasted text is too long. The limit is ${config.maxPasteChars.toLocaleString()} characters.` });
    return res.status(400).json({ error: 'Upload failed: ' + err.message });
  });
}, asyncRoute(async (req, res) => {
  let buffer, type, filename = null;
  if (req.file) {
    filename = req.file.originalname.slice(0, 255);
    type = detectType(req.file.buffer, filename);
    if (!type) {
      const isDoc = /\.doc$/i.test(filename);
      return res.status(400).json({ error: isDoc
        ? 'Old .doc files are not supported. Please save the file as .docx or PDF and try again.'
        : 'Only PDF (.pdf) and Word (.docx) files are accepted, or paste your text.' });
    }
    buffer = req.file.buffer;
  } else {
    const text = String(req.body.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'Choose a file or paste some text.' });
    if (text.length > config.maxPasteChars) return res.status(413).json({ error: `Pasted text is too long. The limit is ${config.maxPasteChars.toLocaleString()} characters.` });
    const words = text.match(/[\p{L}\p{N}]+/gu) || [];
    if (words.length < config.minWords) return res.status(400).json({ error: `Please paste at least ${config.minWords} words.` });
    buffer = Buffer.from(text, 'utf8');
    type = 'text';
  }

  const id = crypto.randomUUID();
  const ext = type === 'text' ? 'txt' : type;
  const key = `u${req.user.id}/${id}.${ext}`;
  const title = cleanTitle(req.body.title, filename ? filename.replace(/\.[^.]+$/, '') : 'Pasted text');

  await storage.save(key, buffer);
  try {
    await db.query(
      `INSERT INTO documents (id, user_id, title, input_type, original_filename, size_bytes, storage_key, report_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.user.id, title, type, filename, buffer.length, key, makeReportRef()]);
  } catch (e) {
    await storage.remove(key).catch(() => {});
    throw e;
  }
  res.status(201).json({ id, status: 'pending' });
}));

// ------------------------------------------------------------- list
const SORTS = {
  newest: 'created_at DESC, id',
  oldest: 'created_at ASC, id',
  similarity: 'similarity DESC NULLS LAST, created_at DESC',
  title: 'title ASC, created_at DESC',
};

// Adds search/filter conditions. Values always go in as $n parameters,
// never pasted into the SQL, so search text cannot inject SQL.
function buildFilters(q, params) {
  const where = [];
  if (q.q) {
    params.push(`%${String(q.q).slice(0, 100).replace(/[\\%_]/g, m => '\\' + m)}%`);
    where.push(`(d.title ILIKE $${params.length} OR d.report_ref ILIKE $${params.length})`);
  }
  if (['pending', 'processing', 'completed', 'failed'].includes(q.status)) {
    params.push(q.status); where.push(`d.status = $${params.length}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { params.push(q.from); where.push(`d.created_at >= $${params.length}::date`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { params.push(q.to); where.push(`d.created_at < ($${params.length}::date + 1)`); }
  return where;
}

function paging(q) {
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 20, 5), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

router.get('/', asyncRoute(async (req, res) => {
  const params = [req.user.id];
  const where = ['d.user_id = $1', ...buildFilters(req.query, params)];
  const { page, pageSize, offset } = paging(req.query);
  const order = SORTS[req.query.sort] || SORTS.newest;
  const whereSql = where.join(' AND ');
  const [list, count] = await Promise.all([
    db.query(
      `SELECT d.id, d.title, d.input_type, d.original_filename, d.size_bytes, d.status, d.error_message,
              d.word_count, d.similarity, d.report_ref, d.created_at, d.completed_at
       FROM documents d WHERE ${whereSql} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`, params),
    db.query(`SELECT count(*)::int AS n FROM documents d WHERE ${whereSql}`, params),
  ]);
  res.json({ items: list.rows, total: count.rows[0].n, page, pageSize });
}));

router.get('/stats', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'pending')::int    AS pending,
            count(*) FILTER (WHERE status = 'processing')::int AS processing,
            count(*) FILTER (WHERE status = 'completed')::int  AS completed,
            count(*) FILTER (WHERE status = 'failed')::int     AS failed,
            round(avg(similarity), 1) AS avg_similarity
     FROM documents WHERE user_id = $1`, [req.user.id]);
  res.json(rows[0]);
}));

// ------------------------------------------------------------- single
async function ownDocument(req, res, columns = 'd.*') {
  if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Document not found.' }); return null; }
  // The user_id check is what stops anyone opening someone else's document.
  const { rows } = await db.query(`SELECT ${columns} FROM documents d WHERE d.id = $1 AND d.user_id = $2`,
    [req.params.id, req.user.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Document not found.' }); return null; }
  return rows[0];
}

async function reportData(docId) {
  const [m, s] = await Promise.all([
    db.query(`SELECT source_id, char_start, char_end, word_count, source_excerpt
              FROM matches WHERE document_id = $1 ORDER BY char_start`, [docId]),
    db.query(`SELECT s.id AS source_id, s.title, s.author, s.origin, sum(m.word_count)::int AS words
              FROM matches m JOIN sources s ON s.id = m.source_id
              WHERE m.document_id = $1 GROUP BY s.id ORDER BY words DESC, s.id`, [docId]),
  ]);
  return { matches: m.rows, sources: s.rows };
}

router.get('/:id', asyncRoute(async (req, res) => {
  const doc = await ownDocument(req, res,
    `d.id, d.title, d.input_type, d.original_filename, d.size_bytes, d.status, d.error_message, d.word_count,
     d.matched_words, d.similarity, d.report_ref, d.text_sha256, d.created_at, d.started_at, d.completed_at,
     d.extracted_text`);
  if (!doc) return;
  const data = doc.status === 'completed' ? await reportData(doc.id) : { matches: [], sources: [] };
  data.sources.forEach(s => { s.percent = doc.word_count ? Math.round((s.words / doc.word_count) * 1000) / 10 : 0; });
  res.json({ document: doc, ...data });
}));

router.get('/:id/report.pdf', asyncRoute(async (req, res) => {
  const doc = await ownDocument(req, res);
  if (!doc) return;
  if (doc.status !== 'completed') return res.status(409).json({ error: 'The report is not ready yet.' });
  const { matches, sources } = await reportData(doc.id);
  sources.forEach(s => { s.percent = doc.word_count ? Math.round((s.words / doc.word_count) * 1000) / 10 : 0; });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="TimCheck-demo-report-${doc.report_ref}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  buildReportPdf(doc, sources, matches, res);
}));

router.post('/:id/retry', asyncRoute(async (req, res) => {
  const doc = await ownDocument(req, res, 'd.id, d.status');
  if (!doc) return;
  if (doc.status !== 'failed') return res.status(409).json({ error: 'Only failed documents can be retried.' });
  await db.query(`UPDATE documents SET status = 'pending', attempts = 0, error_message = NULL WHERE id = $1`, [doc.id]);
  res.json({ ok: true });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const doc = await ownDocument(req, res, 'd.id, d.storage_key');
  if (!doc) return;
  await db.query('DELETE FROM documents WHERE id = $1 AND user_id = $2', [doc.id, req.user.id]);
  await storage.remove(doc.storage_key).catch(e => console.warn('[storage] remove failed', e.message));
  res.json({ ok: true });
}));

module.exports = router;
module.exports.buildFilters = buildFilters;
module.exports.paging = paging;
module.exports.SORTS = SORTS;
'use strict';
// Admin overview: metadata for ALL submissions (title, owner, date, status, %).
// Admins cannot read other people's document text or reports through this API.
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin, asyncRoute } = require('../middleware');
const { buildFilters, paging, SORTS } = require('./documents');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/documents', asyncRoute(async (req, res) => {
  const params = [];
  const where = buildFilters(req.query, params);
  if (req.query.user) {
    params.push(`%${String(req.query.user).slice(0, 100).replace(/[\\%_]/g, m => '\\' + m)}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { page, pageSize, offset } = paging(req.query);
  const order = (SORTS[req.query.sort] || SORTS.newest).replace(/(^|, )(\w)/g, '$1d.$2');
  const [list, count] = await Promise.all([
    db.query(
      `SELECT d.id, d.title, d.input_type, d.status, d.similarity, d.word_count, d.report_ref,
              d.created_at, d.completed_at, u.full_name AS owner_name, u.email AS owner_email
       FROM documents d JOIN users u ON u.id = d.user_id ${whereSql}
       ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`, params),
    db.query(`SELECT count(*)::int AS n FROM documents d JOIN users u ON u.id = d.user_id ${whereSql}`, params),
  ]);
  res.json({ items: list.rows, total: count.rows[0].n, page, pageSize });
}));

router.get('/stats', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM sources) AS sources,
            count(*)::int AS documents,
            count(*) FILTER (WHERE status = 'pending')::int    AS pending,
            count(*) FILTER (WHERE status = 'processing')::int AS processing,
            count(*) FILTER (WHERE status = 'completed')::int  AS completed,
            count(*) FILTER (WHERE status = 'failed')::int     AS failed
     FROM documents`);
  res.json(rows[0]);
}));

module.exports = router;
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { asyncRoute } = require('../middleware');

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many checks. Please wait a few minutes.' },
});

// Report verification. Anyone with a reference can confirm that a report
// exists and see its key numbers. No title, owner or text is revealed.
router.get('/verify/:ref', verifyLimiter, asyncRoute(async (req, res) => {
  const ref = String(req.params.ref || '').trim().toUpperCase();
  if (!/^TC-\d{8}-[0-9A-F]{10}$/.test(ref)) return res.status(400).json({ error: 'That does not look like a TimCheck reference (example: TC-20261023-1A2B3C4D5E).' });
  const { rows } = await db.query(
    `SELECT report_ref, created_at, completed_at, word_count, matched_words, similarity, text_sha256
     FROM documents WHERE report_ref = $1 AND status = 'completed'`, [ref]);
  if (!rows[0]) return res.status(404).json({ found: false, error: 'No completed TimCheck report has this reference.' });
  res.json({ found: true, report: rows[0] });
}));

// The comparison collection is public so users can see exactly what they
// are compared against.
router.get('/sources', asyncRoute(async (req, res) => {
  const { rows } = await db.query('SELECT id, title, author, origin, word_count FROM sources ORDER BY title');
  res.json({ items: rows });
}));

router.get('/sources/:id', asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await db.query('SELECT id, title, author, origin, word_count, body FROM sources WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  res.json(rows[0]);
}));

router.get('/health', asyncRoute(async (req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
}));

module.exports = router;
-- TimCheck database schema (PostgreSQL 13+)
-- Safe to run more than once: every statement is idempotent.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fast ILIKE search on titles

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(254) NOT NULL,
  password_hash TEXT         NOT NULL,
  role          VARCHAR(10)  NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- --------------------------------------------- comparison collection
-- The "sample sources" every submission is compared against.
CREATE TABLE IF NOT EXISTS sources (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(300) NOT NULL,
  author      VARCHAR(200),
  origin      VARCHAR(300),            -- free text: where the sample came from
  body        TEXT         NOT NULL,
  word_count  INTEGER      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_title_idx ON sources (title);

-- Inverted index: one row per 5-word "shingle" in every source.
-- Looking up all shingles of a submission is a single indexed query,
-- so the collection can grow to many thousands of sources.
CREATE TABLE IF NOT EXISTS source_shingles (
  hash      BIGINT  NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL           -- word position of the shingle in the source
);
CREATE INDEX IF NOT EXISTS source_shingles_hash_idx ON source_shingles (hash);
CREATE INDEX IF NOT EXISTS source_shingles_source_idx ON source_shingles (source_id);

-- ------------------------------------------------------------ documents
CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY,
  user_id           INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             VARCHAR(200) NOT NULL,
  input_type        VARCHAR(10)  NOT NULL CHECK (input_type IN ('pdf', 'docx', 'text')),
  original_filename VARCHAR(255),
  size_bytes        INTEGER      NOT NULL DEFAULT 0,
  storage_key       VARCHAR(300) NOT NULL,          -- where the original file lives
  status            VARCHAR(12)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message     TEXT,
  attempts          INTEGER      NOT NULL DEFAULT 0,
  extracted_text    TEXT,
  text_sha256       CHAR(64),
  word_count        INTEGER,
  similarity        NUMERIC(5,1),
  matched_words     INTEGER,
  report_ref        VARCHAR(40)  NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS documents_user_created_idx ON documents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_status_created_idx ON documents (status, created_at);
CREATE INDEX IF NOT EXISTS documents_created_idx ON documents (created_at DESC);
CREATE INDEX IF NOT EXISTS documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);

-- One row per highlighted passage in a report.
CREATE TABLE IF NOT EXISTS matches (
  id            SERIAL PRIMARY KEY,
  document_id   UUID    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  char_start    INTEGER NOT NULL,      -- character offsets in documents.extracted_text
  char_end      INTEGER NOT NULL,
  word_count    INTEGER NOT NULL,
  source_excerpt TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_document_idx ON matches (document_id);

-- Login sessions (used by connect-pg-simple).
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR      NOT NULL PRIMARY KEY,
  sess   JSON         NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);
[
  {
    "title": "Hand Hygiene and the Prevention of Healthcare-Associated Infections",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Hand hygiene remains the single most effective measure for preventing healthcare-associated infections in hospitals and long-term care facilities. Microorganisms are transferred between patients most often on the hands of healthcare workers, who touch patients, equipment, and surfaces many times during a single shift. Alcohol-based hand rubs are now recommended for most clinical situations because they act quickly, cause less skin irritation than repeated washing, and can be placed at the point of care. Soap and water are still required when hands are visibly soiled or when caring for patients with spore-forming organisms such as Clostridioides difficile. Despite clear guidelines, compliance among nurses and physicians is frequently reported to be below fifty percent. Common barriers include heavy workloads, skin damage, lack of accessible dispensers, and the belief that gloves make hand hygiene unnecessary. Successful improvement programmes usually combine education, reminders in the workplace, direct observation with feedback, and visible support from senior leaders. When these elements are sustained over time, infection rates and antibiotic use both tend to fall, which benefits patients and reduces costs for the health system."
  },
  {
    "title": "Evidence-Based Practice in Nursing: An Introduction",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Evidence-based practice is the careful integration of the best available research evidence with clinical expertise and patient values to guide healthcare decisions. In nursing, the approach moved practice away from tradition and routine towards care that can be justified by reliable findings. The process normally begins with a focused clinical question, often framed using the PICO format, which identifies the population, intervention, comparison, and outcome. The nurse then searches databases such as CINAHL and PubMed, appraises the quality of the studies found, and decides whether the results apply to the patient in front of them. Systematic reviews and randomised controlled trials sit near the top of the traditional evidence hierarchy, although qualitative research is essential for understanding patient experiences. Barriers to evidence-based practice include limited time, restricted access to journals, weak research skills, and organisational cultures that resist change. Nurse leaders can reduce these barriers by providing protected time, journal clubs, and mentorship. Ultimately, evidence-based practice aims to improve patient outcomes, reduce unwarranted variation in care, and support nurses in explaining the reasons behind their clinical decisions."
  },
  {
    "title": "Patient Safety Culture and Medication Errors",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Medication errors are among the most common preventable causes of harm in modern healthcare. They can occur at any stage of the medication process, including prescribing, transcribing, dispensing, administering, and monitoring. Nurses are often the final safeguard before a drug reaches the patient, which is why the rights of medication administration are taught early in nursing education. However, research shows that blaming individuals rarely prevents future mistakes. A strong patient safety culture encourages staff to report errors and near misses without fear of punishment, so that the organisation can learn from them and redesign unsafe systems. Practical strategies include barcode scanning at the bedside, standardised concentrations for high-alert drugs, independent double checks, and reducing interruptions during medication rounds. Clear communication during handover and active involvement of patients and families also help to catch errors before they cause harm. Organisations with mature safety cultures treat every incident as an opportunity to strengthen processes rather than as evidence of personal failure."
  },
  {
    "title": "Core Values and Ethical Principles in Social Work",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Social work is a profession grounded in a commitment to human dignity, social justice, and the wellbeing of individuals, families, and communities. Professional codes of ethics describe core values such as service, integrity, competence, and the importance of human relationships. Social workers are expected to respect the right of clients to make their own decisions, even when those decisions involve risk, while also protecting people who are vulnerable to harm. Ethical dilemmas often arise when these principles conflict, for example when confidentiality must be weighed against a duty to warn others of serious danger. Practitioners are encouraged to use structured decision-making models, consult with supervisors, and document their reasoning carefully. Cultural humility is also central to ethical practice, because it asks workers to recognise their own biases and to learn from the lived experience of the people they serve. By advocating for policy change and fair access to resources, social workers address not only individual problems but also the structural conditions that produce inequality."
  },
  {
    "title": "Mental Health Stigma and Help-Seeking Behaviour",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Stigma surrounding mental illness continues to prevent many people from seeking the support they need. Public stigma refers to negative attitudes held by society, such as the belief that people with mental health conditions are dangerous or weak. Self-stigma occurs when individuals accept these stereotypes and apply them to themselves, which can lower self-esteem and reduce hope for recovery. Structural stigma appears in policies and funding decisions that treat mental healthcare as less important than physical healthcare. Young people, men, and members of some cultural communities are particularly likely to delay treatment because of these pressures. Anti-stigma campaigns that rely only on information have shown limited success. Programmes that create direct contact with people who have lived experience of mental illness tend to produce stronger and longer-lasting changes in attitude. Healthcare professionals also play an important role, since respectful language and non-judgemental care can encourage patients to return for follow-up and to speak openly about their symptoms."
  },
  {
    "title": "Academic Integrity in Higher Education",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Academic integrity is the commitment to honesty, trust, fairness, respect, and responsibility in learning, teaching, and research. Universities rely on these values because degrees are meant to certify that graduates have genuinely achieved the knowledge and skills they claim. Breaches of academic integrity include plagiarism, fabrication of data, unauthorised collaboration, and contract cheating, in which a student submits work completed by someone else. Text-matching software is widely used to identify passages that resemble existing sources, but a similarity score alone cannot establish whether misconduct has occurred. Academic staff must review the matches, consider whether material was quoted and referenced correctly, and give the student an opportunity to explain. Many institutions now emphasise education rather than punishment, teaching students how to paraphrase, cite, and manage their time. Assessment design also matters, since tasks that are personalised, staged, and connected to classroom activities make dishonest shortcuts less attractive and easier to detect."
  },
  {
    "title": "Climate Change and Public Health",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Climate change is increasingly recognised as one of the greatest threats to global public health in the twenty-first century. Rising average temperatures increase the frequency and severity of heatwaves, which cause heat exhaustion, heatstroke, and the worsening of cardiovascular and respiratory disease. Older adults, outdoor workers, and people living in poorly ventilated housing face the highest risks. Changes in rainfall patterns contribute to droughts and floods that damage crops, contaminate drinking water, and displace communities. Warmer conditions also allow mosquitoes and ticks to spread into new regions, expanding the reach of diseases such as dengue, malaria, and Lyme disease. Mental health effects, including anxiety and trauma after disasters, are receiving growing attention. Health systems must therefore prepare through early warning systems, resilient infrastructure, and surveillance of climate-sensitive diseases. At the same time, reducing greenhouse gas emissions from transport, energy, and healthcare itself would produce immediate health benefits through cleaner air."
  },
  {
    "title": "Photosynthesis: Converting Light into Chemical Energy",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Photosynthesis is the process by which green plants, algae, and some bacteria convert light energy into chemical energy stored in sugar. The process takes place mainly in the chloroplasts of leaf cells, where the pigment chlorophyll absorbs light most strongly in the blue and red parts of the spectrum. In the light-dependent reactions, water molecules are split, oxygen is released as a by-product, and the energy carriers ATP and NADPH are produced. These carriers then power the Calvin cycle, a series of light-independent reactions in which carbon dioxide from the air is fixed into organic molecules. The enzyme RuBisCO plays a central role in this fixation step and is thought to be the most abundant protein on Earth. The rate of photosynthesis depends on light intensity, carbon dioxide concentration, and temperature, and any one of these can become the limiting factor. Because it supplies oxygen and forms the base of most food chains, photosynthesis supports nearly all life on the planet."
  },
  {
    "title": "The Industrial Revolution and Urban Change",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "The Industrial Revolution began in Britain in the late eighteenth century and transformed the way goods were produced, moving manufacturing from homes and small workshops into large factories. New machines such as the spinning jenny and the power loom greatly increased textile output, while improvements to the steam engine provided reliable power that was no longer tied to rivers. Coal and iron industries expanded rapidly, and canals followed by railways connected mines, factories, and ports. Millions of people migrated from rural areas to growing industrial towns in search of work. Urban living conditions were often extremely poor, with overcrowded housing, polluted water, and frequent outbreaks of cholera and typhoid. Factory labour involved long hours, dangerous machinery, and the employment of young children. Over time, public pressure led to factory acts, sanitation reforms, and the growth of trade unions. The period laid the foundations of the modern economy but also created social problems that governments are still learning to manage."
  },
  {
    "title": "An Overview of Machine Learning",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Machine learning is a branch of artificial intelligence in which computer systems improve their performance on a task by learning patterns from data rather than following explicitly programmed rules. In supervised learning, a model is trained on examples that include both inputs and the correct outputs, such as emails labelled as spam or not spam. Unsupervised learning looks for structure in data without labels, for instance by grouping customers with similar purchasing behaviour. Reinforcement learning trains an agent to take actions in an environment so as to maximise a reward over time. A central challenge in all approaches is generalisation, meaning the ability of a model to perform well on new data it has not seen before. Models that memorise their training data too closely are said to overfit. Practitioners therefore divide data into training, validation, and test sets and use techniques such as regularisation. Concerns about bias, privacy, and transparency have made responsible development an important part of the field."
  },
  {
    "title": "Nutrition in Older Adults",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Good nutrition is essential for healthy ageing, yet older adults are at increased risk of malnutrition for many reasons. Appetite often declines with age, and changes in taste, smell, and dental health can make eating less enjoyable. Chronic illnesses, multiple medications, depression, and social isolation further reduce food intake. Malnutrition is associated with muscle loss, falls, slower wound healing, longer hospital stays, and higher mortality. Nurses and other health professionals should screen for nutritional risk using validated tools when patients are admitted to hospital or care homes and at regular intervals afterwards. Interventions may include fortified foods, oral nutritional supplements, assistance with eating, and attention to the mealtime environment. Adequate protein intake combined with physical activity helps to preserve muscle strength. Involving family members and dietitians, and respecting cultural food preferences, improves the chances that a nutrition plan will be followed."
  },
  {
    "title": "The Water Cycle",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "The water cycle describes the continuous movement of water between the oceans, the atmosphere, and the land. Energy from the sun heats surface water, causing it to evaporate and rise into the air as water vapour. Plants also release water vapour through their leaves in a process called transpiration. As the vapour rises and cools, it condenses into tiny droplets that form clouds. When these droplets combine and become heavy enough, they fall back to the surface as precipitation in the form of rain, snow, sleet, or hail. Some of this water flows over the land as runoff into rivers and lakes, while some soaks into the ground and becomes groundwater stored in aquifers. Eventually most of the water returns to the oceans, and the cycle begins again. The water cycle redistributes heat around the planet, shapes weather patterns, and supplies the fresh water on which ecosystems and human societies depend."
  },
  {
    "title": "Therapeutic Communication in Nursing Practice",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Therapeutic communication is a purposeful form of interaction that helps patients express their thoughts and feelings, understand their situation, and take part in decisions about their care. Unlike social conversation, it is focused on the needs of the patient rather than those of the nurse. Key techniques include active listening, open-ended questions, reflection, clarification, and the respectful use of silence. Nonverbal behaviours such as eye contact, posture, and tone of voice often communicate more than words, so nurses must remain aware of the messages they send. Barriers to effective communication include giving false reassurance, changing the subject, offering personal opinions, and using medical jargon that patients may not understand. Cultural and language differences require additional sensitivity and, when necessary, the use of professional interpreters. When therapeutic communication is done well, patients report greater satisfaction, experience less anxiety, and are more likely to follow their treatment plans."
  },
  {
    "title": "Child Welfare and Family Support Services",
    "author": "TimCheck sample collection",
    "origin": "Original sample text written for TimCheck",
    "body": "Child welfare systems exist to protect children from harm while supporting families to provide safe and stable care. Most contact with these systems begins with a report of suspected neglect or abuse, which is then assessed by social workers to determine the level of risk. Research consistently shows that neglect, often linked to poverty, substance use, and parental mental illness, is far more common than physical abuse. For this reason, many services now focus on early help, offering parenting programmes, financial assistance, and access to health care before problems become severe. When children cannot remain safely at home, placement with relatives is usually preferred to foster care with strangers, because it maintains family connections and cultural identity. Decisions about removal and reunification are among the most difficult in social work and must balance the rights of parents with the best interests of the child. Strong relationships between workers and families are closely linked to better outcomes."
  }
]
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TimCheck — similarity checking, explained</title>
  <meta name="description" content="TimCheck is an educational demonstration of how similarity checkers work. It is not affiliated with Turnitin.">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="notice" role="note">
    Educational demonstration. TimCheck is independent and is not connected to Turnitin. Its reports are not Turnitin reports.
  </div>
  <header class="topbar">
    <div class="wrap topbar-inner">
      <a class="brand" href="#/" aria-label="TimCheck home">
        <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="5" width="26" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="8" y="11" width="16" height="4" rx="1" fill="#ffd84d"/><rect x="8" y="18" width="10" height="2.4" rx="1" fill="currentColor"/></svg>
        <span>TimCheck</span>
      </a>
      <button class="menu-btn" id="menuBtn" aria-expanded="false" aria-controls="nav">Menu</button>
      <nav id="nav" class="nav" aria-label="Main"></nav>
    </div>
  </header>
  <main id="main" class="wrap" tabindex="-1"></main>
  <footer class="footer">
    <div class="wrap footer-inner">
      <p>TimCheck is a teaching tool. It compares text against its own small sample collection only. A similarity number from TimCheck is a demonstration, never proof of plagiarism or originality.</p>
      <p><a href="#/learn">How similarity checking works</a> <a href="#/sources">Sample collection</a> <a href="#/verify">Verify a report</a></p>
    </div>
  </footer>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
</body>
</html>
:root {
  color-scheme: light;
  --paper: #f3f6f7;
  --surface: #ffffff;
  --ink: #17262b;
  --muted: #56686d;
  --line: #d6e0e2;
  --pine: #123b3a;
  --pine-2: #1d6b63;
  --pine-3: #e4efed;
  --hi: #ffd84d;
  --warn: #9a4a06;
  --warn-bg: #fff4e0;
  --bad: #b42318;
  --bad-bg: #fdecea;
  --ok: #1f7a4d;
  --ok-bg: #e6f5ec;
  --serif: "Iowan Old Style", "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 72px;
  --r-sm: 6px; --r-md: 10px;
}

/* Highlight colours for sources 1–8 (same order as the PDF report) */
.c0 { --c: #ffd84d; --ct: #6b4f00; }
.c1 { --c: #bfe0ff; --ct: #1d4ed8; }
.c2 { --c: #e0d0ff; --ct: #6b21a8; }
.c3 { --c: #c3efd3; --ct: #15803d; }
.c4 { --c: #ffcdd6; --ct: #be123c; }
.c5 { --c: #ffdcbc; --ct: #a14a07; }
.c6 { --c: #bdeef0; --ct: #0e7490; }
.c7 { --c: #d7dbff; --ct: #4338ca; }

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 16px/1.55 var(--sans); min-height: 100vh; display: flex; flex-direction: column;
}
main { flex: 1; padding-top: var(--s6); padding-bottom: var(--s8); outline: none; }
.wrap { width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 var(--s4); }
@media (min-width: 720px) { .wrap { padding: 0 var(--s5); } }

h1, h2, h3 { font-family: var(--serif); font-weight: 600; line-height: 1.2; margin: 0 0 var(--s3); letter-spacing: -0.005em; }
h1 { font-size: clamp(1.9rem, 4.5vw, 2.6rem); }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.15rem; }
p { margin: 0 0 var(--s4); }
a { color: var(--pine-2); text-underline-offset: 2px; }
a:hover { color: var(--pine); }
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
.prose { max-width: 68ch; }
.prose p, .prose li { line-height: 1.65; }
.prose h2 { margin-top: var(--s7); }
.prose h3 { margin-top: var(--s5); }

:focus-visible { outline: 3px solid #2f8f84; outline-offset: 2px; border-radius: 3px; }
.skip { position: absolute; left: -999px; top: 0; background: var(--surface); padding: var(--s2) var(--s3); z-index: 100; }
.skip:focus { left: var(--s2); top: var(--s2); }

/* ---------------------------------------------------------------- chrome */
.notice { background: var(--pine); color: #e3efed; font-size: 0.8125rem; text-align: center; padding: 6px var(--s4); }
.topbar { background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 20; }
.topbar-inner { display: flex; align-items: center; gap: var(--s4); min-height: 60px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: var(--s2); color: var(--pine); text-decoration: none; font-family: var(--serif); font-weight: 700; font-size: 1.3rem; }
.brand svg { width: 28px; height: 28px; }
.nav { display: flex; gap: var(--s1); margin-left: auto; align-items: center; }
.nav a, .nav button.link {
  color: var(--ink); text-decoration: none; padding: var(--s2) var(--s3); border-radius: var(--r-sm); font-size: 0.9375rem;
}
.nav a:hover { background: var(--pine-3); }
.nav a[aria-current="page"] { background: var(--pine-3); color: var(--pine); font-weight: 600; }
.nav .who { color: var(--muted); font-size: 0.875rem; padding: 0 var(--s2); }
.menu-btn { display: none; margin-left: auto; }
@media (max-width: 860px) {
  .menu-btn { display: inline-flex; }
  .nav { display: none; width: 100%; flex-direction: column; align-items: stretch; padding-bottom: var(--s3); }
  .nav.open { display: flex; }
  .nav .who { padding: var(--s2) var(--s3); }
}
.footer { border-top: 1px solid var(--line); background: var(--surface); padding: var(--s5) 0; font-size: 0.875rem; color: var(--muted); }
.footer-inner p { max-width: 75ch; }
.footer a { margin-right: var(--s4); }

/* --------------------------------------------------------------- controls */
button, .btn {
  font: inherit; font-weight: 600; font-size: 0.9375rem; cursor: pointer; border-radius: var(--r-sm);
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
  padding: 10px var(--s4); display: inline-flex; align-items: center; justify-content: center; gap: var(--s2);
  text-decoration: none; min-height: 42px;
}
button:hover, .btn:hover { border-color: #aebfc2; color: var(--ink); }
.btn-primary { background: var(--pine-2); border-color: var(--pine-2); color: #fff; }
.btn-primary:hover { background: var(--pine); border-color: var(--pine); color: #fff; }
.btn-danger { color: var(--bad); }
.btn-sm { padding: 6px var(--s3); min-height: 34px; font-size: 0.875rem; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
button.link { background: none; border: 0; padding: 0; min-height: 0; color: var(--pine-2); text-decoration: underline; font-weight: 400; }

label { display: block; font-weight: 600; font-size: 0.9375rem; margin-bottom: var(--s1); }
.hint { font-size: 0.8125rem; color: var(--muted); margin-top: var(--s1); }
input[type=text], input[type=email], input[type=password], input[type=search], input[type=date], select, textarea {
  font: inherit; width: 100%; padding: 10px var(--s3); border: 1px solid #b9c7ca; border-radius: var(--r-sm);
  background: #fff; color: var(--ink); min-height: 42px;
}
textarea { min-height: 260px; resize: vertical; line-height: 1.55; }
input:focus, select:focus, textarea:focus { border-color: var(--pine-2); outline: 2px solid #9fd1ca; outline-offset: 0; }
.field { margin-bottom: var(--s4); }
.field-error { color: var(--bad); font-size: 0.8125rem; margin-top: var(--s1); }
.field.invalid input { border-color: var(--bad); }
.form-error { background: var(--bad-bg); color: var(--bad); padding: var(--s3); border-radius: var(--r-sm); margin-bottom: var(--s4); font-size: 0.9375rem; }
.pw-rules { list-style: none; padding: 0; margin: var(--s2) 0 0; font-size: 0.8125rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); }
.pw-rules li::before { content: "○ "; }
.pw-rules li.met { color: var(--ok); }
.pw-rules li.met::before { content: "● "; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s5); }
.stack > * + * { margin-top: var(--s5); }
.row { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: center; }
.spread { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--s4); flex-wrap: wrap; margin-bottom: var(--s5); }
.spread h1 { margin: 0; }

/* -------------------------------------------------------------- landing */
.hero { display: grid; gap: var(--s7); grid-template-columns: 1fr; align-items: center; padding: var(--s5) 0 var(--s7); }
@media (min-width: 920px) { .hero { grid-template-columns: 1fr 1.05fr; } }
.hero h1 { font-size: clamp(2.1rem, 5vw, 3.2rem); max-width: 16ch; }
.hero .lead { font-size: 1.15rem; color: #31454b; max-width: 46ch; }
.specimen { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s5); box-shadow: 0 18px 40px -28px rgba(18, 59, 58, 0.45); }
.specimen-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3); border-bottom: 1px solid var(--line); padding-bottom: var(--s3); margin-bottom: var(--s4); }
.specimen-score { font-family: var(--serif); font-size: 2.4rem; font-weight: 700; color: var(--pine); line-height: 1; font-variant-numeric: tabular-nums; }
.specimen p { font-family: var(--serif); font-size: 1.05rem; line-height: 1.75; margin: 0; }
.specimen-legend { margin-top: var(--s4); font-size: 0.8125rem; color: var(--muted); display: grid; gap: var(--s1); }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; background: var(--c); vertical-align: -1px; margin-right: var(--s2); }

/* highlighter marks */
mark.m {
  background: linear-gradient(transparent 8%, var(--c) 8%, var(--c) 92%, transparent 92%);
  color: inherit; padding: 0 1px; border-radius: 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone;
  cursor: pointer;
}
mark.m sup { font-family: var(--sans); font-size: 0.68em; font-weight: 700; color: var(--ct); margin-left: 2px; }
mark.m.active { outline: 2px solid var(--ct); outline-offset: 1px; }
.specimen mark.m { background-size: 0% 100%; background-repeat: no-repeat; background-image: linear-gradient(var(--c), var(--c)); background-color: transparent; transition: background-size 0.7s ease; }
.specimen.lit mark.m { background-size: 100% 100%; }
.specimen.lit mark.m:nth-of-type(2) { transition-delay: 0.6s; }
@media (prefers-reduced-motion: reduce) { .specimen mark.m { transition: none; } }

.three { display: grid; gap: var(--s5); grid-template-columns: 1fr; }
@media (min-width: 760px) { .three { grid-template-columns: repeat(3, 1fr); } }
.three h3 { font-size: 1.1rem; }
.three p { color: #3a4e54; font-size: 0.9375rem; }
.honest { border-left: 4px solid var(--hi); background: var(--surface); padding: var(--s4) var(--s5); border-radius: 0 var(--r-md) var(--r-md) 0; max-width: 75ch; }

/* ----------------------------------------------------------------- auth */
.auth { max-width: 440px; margin: var(--s5) auto 0; }
.auth h1 { font-size: 2rem; }

/* ------------------------------------------------------------ dashboard */
.tiles { display: grid; gap: var(--s3); grid-template-columns: repeat(2, 1fr); }
@media (min-width: 720px) { .tiles { grid-template-columns: repeat(5, 1fr); } }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s4); text-decoration: none; color: var(--ink); }
.tile b { display: block; font-family: var(--serif); font-size: 1.9rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
.tile span { color: var(--muted); font-size: 0.875rem; }
a.tile:hover { border-color: var(--pine-2); }

/* -------------------------------------------------------------- statuses */
.status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8125rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.status.pending { background: #eef1f2; color: #4d5f64; }
.status.processing { background: #e3eefb; color: #1f5fae; }
.status.processing::before { animation: pulse 1.1s ease-in-out infinite; }
.status.completed { background: var(--ok-bg); color: var(--ok); }
.status.failed { background: var(--bad-bg); color: var(--bad); }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .status.processing::before { animation: none; } }
.pct { font-variant-numeric: tabular-nums; font-weight: 700; }

/* ---------------------------------------------------------------- tables */
.filters { display: grid; gap: var(--s3); grid-template-columns: 1fr; margin-bottom: var(--s4); }
@media (min-width: 760px) { .filters { grid-template-columns: 2fr 1fr 1fr 1fr 1fr auto; align-items: end; } }
.filters label { font-size: 0.8125rem; font-weight: 600; }
.table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
.table th, .table td { text-align: left; padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); vertical-align: middle; }
.table th { font-size: 0.8125rem; color: var(--muted); font-weight: 600; background: #f8fafb; }
.table tr:last-child td { border-bottom: 0; }
.table td.title a { font-weight: 600; color: var(--ink); text-decoration: none; }
.table td.title a:hover { color: var(--pine-2); text-decoration: underline; }
.table .ref { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); }
@media (max-width: 760px) {
  .table, .table tbody, .table tr, .table td { display: block; width: 100%; }
  .table thead { display: none; }
  .table tr { border-bottom: 1px solid var(--line); padding: var(--s3) var(--s4); }
  .table td { border: 0; padding: 2px 0; }
  .table td[data-label]::before { content: attr(data-label) ": "; color: var(--muted); font-size: 0.8125rem; }
}
.pager { display: flex; gap: var(--s3); align-items: center; justify-content: space-between; margin-top: var(--s4); flex-wrap: wrap; }
.empty { text-align: center; padding: var(--s7) var(--s4); background: var(--surface); border: 1px dashed #b9c7ca; border-radius: var(--r-md); }

/* ---------------------------------------------------------------- submit */
.tabs { display: flex; gap: var(--s2); border-bottom: 1px solid var(--line); margin-bottom: var(--s5); }
.tabs button { border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: none; padding: var(--s3) var(--s2); min-height: 0; color: var(--muted); }
.tabs button[aria-selected="true"] { color: var(--pine); border-bottom-color: var(--pine-2); }
.drop { border: 2px dashed #a9bcc0; border-radius: var(--r-md); padding: var(--s6) var(--s4); text-align: center; background: #fbfcfc; cursor: pointer; }
.drop.over { border-color: var(--pine-2); background: var(--pine-3); }
.drop strong { display: block; font-size: 1.05rem; margin-bottom: var(--s1); }
.progress { height: 8px; background: #e3eaeb; border-radius: 99px; overflow: hidden; margin-top: var(--s3); }
.progress > i { display: block; height: 100%; background: var(--pine-2); width: 0; transition: width 0.2s; }
.counter { text-align: right; font-size: 0.8125rem; color: var(--muted); margin-top: var(--s1); }

/* ---------------------------------------------------------------- report */
.report-grid { display: grid; gap: var(--s5); grid-template-columns: 1fr; }
@media (min-width: 980px) { .report-grid { grid-template-columns: minmax(0, 1fr) 340px; align-items: start; } .report-side { position: sticky; top: 84px; } }
.report-paper { position: relative; overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); }
.report-head { padding: var(--s5); border-bottom: 1px solid var(--line); display: grid; gap: var(--s4); grid-template-columns: 1fr auto; align-items: start; }
.report-head h1 { font-size: clamp(1.4rem, 3vw, 1.9rem); margin-bottom: var(--s2); word-break: break-word; }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 2px var(--s4); font-size: 0.875rem; margin: 0; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; font-weight: 600; word-break: break-word; }
.score { text-align: center; min-width: 120px; }
.score b { display: block; font-family: var(--serif); font-size: 3rem; line-height: 1; color: var(--pine); font-variant-numeric: tabular-nums; }
.score span { font-size: 0.8125rem; color: var(--muted); }
@media (max-width: 560px) { .report-head { grid-template-columns: 1fr; } .score { text-align: left; } }
.disclaimer { background: var(--warn-bg); color: var(--warn); border: 1px solid #f1c27d; border-radius: var(--r-sm); padding: var(--s3) var(--s4); font-size: 0.875rem; }
.disclaimer strong { color: #7a3a00; }
.report-text { padding: var(--s5); font-family: var(--serif); font-size: 1.05rem; line-height: 1.85; white-space: pre-wrap; word-wrap: break-word; position: relative; z-index: 1; }
.watermark { position: absolute; inset: -40%; z-index: 2; pointer-events: none; display: flex; flex-direction: column; justify-content: space-around; transform: rotate(-28deg); opacity: 0.06; user-select: none; }
.watermark div { white-space: nowrap; font-family: var(--sans); font-weight: 800; font-size: 26px; color: var(--pine); letter-spacing: 0.02em; }
.sources-list { list-style: none; margin: 0; padding: 0; }
.sources-list li { display: grid; grid-template-columns: 28px 1fr auto; gap: var(--s2); padding: var(--s3) 0; border-bottom: 1px solid var(--line); align-items: start; }
.sources-list li:last-child { border-bottom: 0; }
.chip { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: var(--c); color: var(--ct); font-weight: 800; font-size: 0.8125rem; }
.sources-list .t { font-weight: 600; font-size: 0.9375rem; line-height: 1.35; }
.sources-list .p { font-weight: 700; color: var(--ct); font-variant-numeric: tabular-nums; }
.passage-pop { margin-top: var(--s3); background: #f8fafb; border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--s3); font-size: 0.875rem; }
.passage-pop q { font-family: var(--serif); font-style: italic; }
.waiting { padding: var(--s7) var(--s5); text-align: center; }
.spinner { width: 34px; height: 34px; border: 3px solid var(--pine-3); border-top-color: var(--pine-2); border-radius: 50%; margin: 0 auto var(--s4); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

/* ----------------------------------------------------------------- learn */
.learn-layout { display: grid; gap: var(--s6); grid-template-columns: 1fr; }
@media (min-width: 980px) { .learn-layout { grid-template-columns: 220px minmax(0, 1fr); } .toc { position: sticky; top: 84px; align-self: start; } }
.toc ol { padding-left: 1.2em; margin: 0; font-size: 0.9375rem; display: grid; gap: var(--s2); }
.compare { width: 100%; border-collapse: collapse; font-size: 0.9375rem; margin: var(--s4) 0 var(--s5); background: var(--surface); }
.compare th, .compare td { border: 1px solid var(--line); padding: var(--s3); vertical-align: top; text-align: left; }
.compare th { background: #f8fafb; }
.callout { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--pine-2); padding: var(--s4) var(--s5); border-radius: 0 var(--r-md) var(--r-md) 0; margin: var(--s4) 0; }
.fake-vs-real { display: grid; gap: var(--s4); grid-template-columns: 1fr; margin: var(--s4) 0; }
@media (min-width: 640px) { .fake-vs-real { grid-template-columns: 1fr 1fr; } }
.mini-report { border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s4); background: var(--surface); font-size: 0.875rem; }
.mini-report b.big { font-family: var(--serif); font-size: 2rem; display: block; }
.mini-report.flag { border-color: #e9a29b; background: #fff8f7; }

/* ----------------------------------------------------------------- toast */
.toast { position: fixed; left: 50%; bottom: var(--s5); transform: translateX(-50%) translateY(20px); background: var(--pine); color: #fff; padding: var(--s3) var(--s5); border-radius: var(--r-sm); opacity: 0; pointer-events: none; transition: 0.2s; z-index: 50; max-width: calc(100% - 32px); }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.error { background: var(--bad); }

/* ----------------------------------------------------------------- print */
@media print {
  .notice, .topbar, .footer, .no-print, .report-side .actions { display: none !important; }
  body { background: #fff; }
  main { padding: 0; }
  .report-grid { display: block; }
  .report-paper, .panel { border: 0; }
  .report-side { margin-top: 24px; }
  mark.m { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .watermark { opacity: 0.1; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
'use strict';
/* TimCheck front end: a small single-page app with hash routes. */

const state = { user: null, loaded: false };
const main = document.getElementById('main');
const MAX_UPLOAD_MB = 10;
const WATERMARK = 'TimCheck • EDUCATIONAL DEMO • NOT A TURNITIN REPORT';

// ------------------------------------------------------------ helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fmtDay = d => d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
const pct = v => (v === null || v === undefined) ? '—' : `${Number(v).toFixed(1)}%`;
const statusBadge = s => `<span class="status ${esc(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</span>`;
const sizeLabel = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

async function api(path, opts = {}) {
  const headers = { 'X-Requested-With': 'TimCheck', ...(opts.headers || {}) };
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    if (res.status === 401 && state.user) { state.user = null; renderNav(); go('#/login'); }
    throw err;
  }
  return data;
}

function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

function setTitle(t) { document.title = t ? `${t} — TimCheck` : 'TimCheck — similarity checking, explained'; }

// ------------------------------------------------------------ nav
function renderNav() {
  const nav = document.getElementById('nav');
  const links = state.user
    ? [['#/dashboard', 'Dashboard'], ['#/submit', 'Check a document'], ['#/documents', 'My documents'], ['#/learn', 'Learn'], ['#/verify', 'Verify']]
      .concat(state.user.role === 'admin' ? [['#/admin', 'Admin']] : [])
    : [['#/learn', 'Learn'], ['#/verify', 'Verify a report'], ['#/login', 'Log in'], ['#/register', 'Create account']];
  nav.innerHTML = links.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')
    + (state.user ? `<span class="who">${esc(state.user.fullName)}</span><button class="btn-sm" id="logoutBtn">Log out</button>` : '');
  markNav();
  const lb = document.getElementById('logoutBtn');
  if (lb) lb.onclick = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null; renderNav(); toast('You are logged out.'); go('#/');
  };
}
function markNav() {
  const base = '#/' + (location.hash.slice(2).split('/')[0] || '');
  document.querySelectorAll('#nav a').forEach(a => { if (a.getAttribute('href') === base) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
document.getElementById('menuBtn').onclick = e => {
  const nav = document.getElementById('nav');
  const open = nav.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
};

// ------------------------------------------------------------ router
let pollTimer = null;
const routes = {
  '': landing, login: loginPage, register: registerPage, dashboard: dashboard, submit: submitPage,
  documents: documentsPage, report: reportPage, learn: learnPage, verify: verifyPage, sources: sourcesPage, admin: adminPage,
};
const protectedRoutes = ['dashboard', 'submit', 'documents', 'report', 'admin'];

async function render() {
  clearTimeout(pollTimer);
  document.getElementById('nav').classList.remove('open');
  document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
  const [path, query] = location.hash.slice(1).split('?');
  const parts = path.replace(/^\//, '').split('/');
  const name = parts[0] || '';
  const view = routes[name];
  if (!view) { main.innerHTML = '<div class="empty"><h1>Page not found</h1><p><a href="#/">Go to the home page</a></p></div>'; return; }
  if (protectedRoutes.includes(name) && !state.user) { sessionStorage.setItem('afterLogin', location.hash); go('#/login'); return; }
  if ((name === 'login' || name === 'register') && state.user) { go('#/dashboard'); return; }
  markNav();
  main.innerHTML = '';
  try {
    await view(parts.slice(1), new URLSearchParams(query || ''));
  } catch (e) {
    main.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
  }
  if (!render.first) main.focus({ preventScroll: true });
  render.first = false;
  window.scrollTo(0, 0);
}
render.first = true;

window.addEventListener('hashchange', render);
(async function init() {
  try { state.user = (await api('/auth/me')).user; } catch { state.user = null; }
  renderNav();
  render();
})();

// ------------------------------------------------------------ landing
function landing() {
  setTitle('');
  main.innerHTML = `
  <section class="hero">
    <div>
      <h1>See how a similarity checker reads your writing.</h1>
      <p class="lead">TimCheck compares a document with its own collection of sample texts, highlights the passages that match, and explains what the number does and does not mean.</p>
      <div class="row">
        ${state.user ? '<a class="btn btn-primary" href="#/submit">Check a document</a>' : '<a class="btn btn-primary" href="#/register">Create a free account</a>'}
        <a class="btn" href="#/learn">Learn how it works</a>
      </div>
    </div>
    <figure class="specimen" aria-label="Example of a highlighted report">
      <div class="specimen-head">
        <div><strong>Sample essay paragraph</strong><div class="small muted">66 words checked</div></div>
        <div class="specimen-score" id="specScore">0%</div>
      </div>
      <p>In my essay I argue that <mark class="m c0">hand hygiene remains the single most effective measure for preventing healthcare-associated infections in hospitals<sup>1</sup></mark> and care homes. My own view is that managers should make dispensers easier to reach. Also, <mark class="m c1">the water cycle describes the continuous movement of water between the oceans, the atmosphere, and the land<sup>2</sup></mark>, which is a separate point I should cite.</p>
      <figcaption class="specimen-legend">
        <span class="c0"><i class="swatch"></i>Hand Hygiene and the Prevention of Healthcare-Associated Infections</span>
        <span class="c1"><i class="swatch"></i>The Water Cycle</span>
      </figcaption>
    </figure>
  </section>

  <section class="three">
    <div><h3>Upload or paste</h3><p>Send a PDF or Word file, or paste text. Each submission is saved to your private history with its own report reference.</p></div>
    <div><h3>Real text matching</h3><p>Runs of five or more identical words are found and joined into passages. The same text always gives the same result.</p></div>
    <div><h3>Watermarked reports</h3><p>Every report says clearly that it is an educational demonstration and can be checked on the verification page.</p></div>
  </section>

  <section class="honest" style="margin-top:48px">
    <h2>What TimCheck is not</h2>
    <p>TimCheck is not connected to Turnitin or any commercial database. It only knows the ${'<a href="#/sources">sample collection</a>'} listed on this site. A TimCheck report must never be presented as a Turnitin report or as proof that work is original.</p>
  </section>`;
  const fig = main.querySelector('.specimen');
  const score = document.getElementById('specScore');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => setTimeout(() => {
    fig.classList.add('lit');
    if (reduce) { score.textContent = '56.1%'; return; }
    const t0 = performance.now();
    (function tick(t) {
      const k = Math.min(1, (t - t0) / 1300);
      score.textContent = `${(56.1 * k).toFixed(1)}%`;
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }, 300));
}

// ------------------------------------------------------------ auth pages
function fieldErrors(form, fields) {
  form.querySelectorAll('.field').forEach(f => { f.classList.remove('invalid'); const e = f.querySelector('.field-error'); if (e) e.remove(); });
  Object.entries(fields || {}).forEach(([name, msg]) => {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) return;
    const f = input.closest('.field'); f.classList.add('invalid');
    f.insertAdjacentHTML('beforeend', `<div class="field-error">${esc(msg)}</div>`);
    input.setAttribute('aria-invalid', 'true');
  });
}

function afterLogin(user) {
  state.user = user; renderNav();
  const next = sessionStorage.getItem('afterLogin'); sessionStorage.removeItem('afterLogin');
  go(next && next !== '#/login' ? next : '#/dashboard');
}

function loginPage() {
  setTitle('Log in');
  main.innerHTML = `
  <div class="auth panel">
    <h1>Log in</h1>
    <form id="f" novalidate>
      <div id="err"></div>
      <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn-primary" style="width:100%">Log in</button>
    </form>
    <p class="small muted" style="margin-top:16px">New here? <a href="#/register">Create an account</a></p>
  </div>`;
  const f = document.getElementById('f');
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      toast(`Welcome back, ${user.fullName.split(' ')[0]}.`);
      afterLogin(user);
    } catch (err) {
      document.getElementById('err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
  f.email.focus();
}

const PW_RULES = [['len', 'At least 8 characters', p => p.length >= 8], ['let', 'A letter', p => /[A-Za-z]/.test(p)], ['num', 'A number', p => /\d/.test(p)]];

function registerPage() {
  setTitle('Create account');
  main.innerHTML = `
  <div class="auth panel">
    <h1>Create your account</h1>
    <p class="muted small">Your documents and reports are private to your account.</p>
    <form id="f" novalidate>
      <div id="err"></div>
      <div class="field"><label for="fullName">Full name</label><input id="fullName" name="fullName" type="text" autocomplete="name" maxlength="100" required></div>
      <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" maxlength="128" required aria-describedby="pwRules">
        <ul class="pw-rules" id="pwRules">${PW_RULES.map(r => `<li data-r="${r[0]}">${r[1]}</li>`).join('')}</ul></div>
      <div class="field"><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>
      <button class="btn-primary" style="width:100%">Create account</button>
    </form>
    <p class="small muted" style="margin-top:16px">Already registered? <a href="#/login">Log in</a></p>
  </div>`;
  const f = document.getElementById('f');
  f.password.oninput = () => PW_RULES.forEach(([k, , test]) => f.querySelector(`[data-r="${k}"]`).classList.toggle('met', test(f.password.value)));
  f.onsubmit = async e => {
    e.preventDefault();
    const errs = {};
    if (f.fullName.value.trim().length < 2) errs.fullName = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value.trim())) errs.email = 'Enter a valid email address.';
    const failed = PW_RULES.filter(r => !r[2](f.password.value)).map(r => r[1].toLowerCase());
    if (failed.length) errs.password = `Password needs ${failed.join(', ')}.`;
    if (f.confirm.value !== f.password.value) errs.confirm = 'The two passwords do not match.';
    fieldErrors(f, errs);
    if (Object.keys(errs).length) { f.querySelector('[aria-invalid="true"]').focus(); return; }
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const { user } = await api('/auth/register', { method: 'POST', body: { fullName: f.fullName.value, email: f.email.value, password: f.password.value } });
      toast('Your account is ready.');
      afterLogin(user);
    } catch (err) {
      fieldErrors(f, err.data && err.data.fields);
      document.getElementById('err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
  f.fullName.focus();
}

// ------------------------------------------------------------ dashboard
async function dashboard() {
  setTitle('Dashboard');
  const [stats, recent] = await Promise.all([api('/documents/stats'), api('/documents?pageSize=5')]);
  main.innerHTML = `
  <div class="spread">
    <div><h1>Hello, ${esc(state.user.fullName.split(' ')[0])}</h1><p class="muted" style="margin:0">Your private workspace. Only you can see these documents.</p></div>
    <a class="btn btn-primary" href="#/submit">Check a document</a>
  </div>
  <div class="tiles">
    <a class="tile" href="#/documents"><b>${stats.total}</b><span>Documents</span></a>
    <a class="tile" href="#/documents?status=completed"><b>${stats.completed}</b><span>Completed</span></a>
    <a class="tile" href="#/documents?status=processing"><b>${stats.pending + stats.processing}</b><span>Waiting or processing</span></a>
    <a class="tile" href="#/documents?status=failed"><b>${stats.failed}</b><span>Failed</span></a>
    <div class="tile"><b>${stats.avg_similarity === null ? '—' : pct(stats.avg_similarity)}</b><span>Average similarity</span></div>
  </div>
  <h2 style="margin-top:40px">Recent submissions</h2>
  ${recent.items.length ? docTable(recent.items) + '<p style="margin-top:16px"><a href="#/documents">See all documents</a></p>'
    : '<div class="empty"><h3>No documents yet</h3><p class="muted">Upload a PDF or Word file, or paste text, to get your first report.</p><a class="btn btn-primary" href="#/submit">Check a document</a></div>'}`;
  if (stats.pending + stats.processing > 0) pollTimer = setTimeout(() => location.hash.startsWith('#/dashboard') && render(), 4000);
}

function docTable(items, admin) {
  return `<table class="table"><thead><tr><th>Title</th>${admin ? '<th>Owner</th>' : ''}<th>Submitted</th><th>Status</th><th>Similarity</th><th>Report</th></tr></thead><tbody>
  ${items.map(d => `<tr>
    <td class="title">${admin ? `<strong>${esc(d.title)}</strong>` : `<a href="#/report/${d.id}">${esc(d.title)}</a>`}<div class="ref">${esc(d.report_ref)}</div></td>
    ${admin ? `<td data-label="Owner">${esc(d.owner_name)}<div class="small muted">${esc(d.owner_email)}</div></td>` : ''}
    <td data-label="Submitted">${fmtDate(d.created_at)}</td>
    <td data-label="Status">${statusBadge(d.status)}</td>
    <td data-label="Similarity"><span class="pct">${d.status === 'completed' ? pct(d.similarity) : '—'}</span></td>
    <td data-label="Report">${admin ? '<span class="small muted">Owner only</span>' : `<a href="#/report/${d.id}">${d.status === 'completed' ? 'Open report' : 'View status'}</a>`}</td>
  </tr>`).join('')}</tbody></table>`;
}

// ------------------------------------------------------------ submit
function submitPage() {
  setTitle('Check a document');
  main.innerHTML = `
  <div class="spread"><div><h1>Check a document</h1><p class="muted" style="margin:0">Your text is compared with the TimCheck <a href="#/sources">sample collection</a>.</p></div></div>
  <div class="panel" style="max-width:780px">
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-tab="file" id="tab-file">Upload a file</button>
      <button role="tab" aria-selected="false" data-tab="text" id="tab-text">Paste text</button>
    </div>
    <form id="f" novalidate>
      <div id="err"></div>
      <div class="field"><label for="title">Document title</label><input id="title" name="title" type="text" maxlength="200" placeholder="For example: Week 4 reflection essay"><div class="hint">Leave empty to use the file name.</div></div>
      <div data-pane="file">
        <input type="file" id="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
        <div class="drop" id="drop" tabindex="0" role="button" aria-describedby="dropHint">
          <strong id="dropLabel">Choose a PDF or Word file</strong>
          <span class="muted small" id="dropHint">or drag it here. PDF and .docx up to ${MAX_UPLOAD_MB} MB. Scanned PDFs without text cannot be read.</span>
        </div>
      </div>
      <div data-pane="text" hidden>
        <div class="field"><label for="text">Text to check</label><textarea id="text" name="text" maxlength="200000" placeholder="Paste at least 20 words."></textarea><div class="counter" id="count">0 words</div></div>
      </div>
      <div class="progress" id="prog" hidden><i></i></div>
      <div class="row" style="margin-top:20px"><button class="btn-primary" id="go">Start check</button><span class="small muted">Results usually appear within a few seconds.</span></div>
    </form>
  </div>`;
  let mode = 'file', file = null;
  const f = document.getElementById('f');
  const drop = document.getElementById('drop'), input = document.getElementById('file');
  main.querySelectorAll('[role=tab]').forEach(t => t.onclick = () => {
    mode = t.dataset.tab;
    main.querySelectorAll('[role=tab]').forEach(x => x.setAttribute('aria-selected', x === t));
    main.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== mode; });
  });
  const pick = fl => {
    const err = document.getElementById('err'); err.innerHTML = '';
    if (!fl) return;
    if (!/\.(pdf|docx)$/i.test(fl.name)) { err.innerHTML = `<div class="form-error">${/\.doc$/i.test(fl.name) ? 'Old .doc files are not supported. Save it as .docx or PDF first.' : 'Choose a PDF or .docx file.'}</div>`; return; }
    if (fl.size > MAX_UPLOAD_MB * 1048576) { err.innerHTML = `<div class="form-error">This file is ${sizeLabel(fl.size)}. The limit is ${MAX_UPLOAD_MB} MB.</div>`; return; }
    file = fl;
    document.getElementById('dropLabel').textContent = `${fl.name} (${sizeLabel(fl.size)})`;
  };
  drop.onclick = () => input.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  input.onchange = () => pick(input.files[0]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => pick(e.dataTransfer.files[0]));
  const ta = document.getElementById('text');
  ta.oninput = () => { const n = (ta.value.match(/[\p{L}\p{N}]+/gu) || []).length; document.getElementById('count').textContent = `${n.toLocaleString()} words`; };

  f.onsubmit = e => {
    e.preventDefault();
    const err = document.getElementById('err'); err.innerHTML = '';
    const fd = new FormData();
    fd.append('title', f.title.value);
    if (mode === 'file') {
      if (!file) { err.innerHTML = '<div class="form-error">Choose a file first.</div>'; return; }
      fd.append('file', file);
    } else {
      const n = (ta.value.match(/[\p{L}\p{N}]+/gu) || []).length;
      if (n < 20) { err.innerHTML = '<div class="form-error">Paste at least 20 words.</div>'; return; }
      fd.append('text', ta.value);
    }
    const btn = document.getElementById('go'); btn.disabled = true; btn.textContent = 'Uploading…';
    const prog = document.getElementById('prog'); prog.hidden = false;
    // XMLHttpRequest is used here because it reports upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents');
    xhr.setRequestHeader('X-Requested-With', 'TimCheck');
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) prog.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`; };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 201) { toast('Submitted. Checking now.'); go(`#/report/${data.id}`); return; }
      if (xhr.status === 401) { state.user = null; renderNav(); go('#/login'); return; }
      err.innerHTML = `<div class="form-error">${esc(data.error || 'Upload failed. Please try again.')}</div>`;
      btn.disabled = false; btn.textContent = 'Start check'; prog.hidden = true;
    };
    xhr.onerror = () => { err.innerHTML = '<div class="form-error">Network error. Check your connection and try again.</div>'; btn.disabled = false; btn.textContent = 'Start check'; prog.hidden = true; };
    xhr.send(fd);
  };
}

// ------------------------------------------------------------ documents list
async function documentsPage(_, qs, admin = false) {
  setTitle(admin ? 'All submissions' : 'My documents');
  const params = new URLSearchParams();
  ['q', 'status', 'from', 'to', 'sort', 'page', 'user'].forEach(k => { if (qs.get(k)) params.set(k, qs.get(k)); });
  params.set('pageSize', '20');
  const data = await api((admin ? '/admin/documents?' : '/documents?') + params);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const base = admin ? '#/admin' : '#/documents';
  const link = page => { const p = new URLSearchParams(qs); p.set('page', page); return `${base}?${p}`; };
  const filtering = ['q', 'status', 'from', 'to', 'user'].some(k => qs.get(k));
  const listHtml = `
  <form class="filters" id="filters" role="search">
    <div><label for="q">Search title or reference</label><input id="q" name="q" type="search" value="${esc(qs.get('q') || '')}"></div>
    ${admin ? `<div><label for="user">User name or email</label><input id="user" name="user" type="search" value="${esc(qs.get('user') || '')}"></div>` : ''}
    <div><label for="status">Status</label><select id="status" name="status">
      ${['', 'pending', 'processing', 'completed', 'failed'].map(s => `<option value="${s}" ${qs.get('status') === s ? 'selected' : ''}>${s ? s[0].toUpperCase() + s.slice(1) : 'Any status'}</option>`).join('')}
    </select></div>
    <div><label for="from">From</label><input id="from" name="from" type="date" value="${esc(qs.get('from') || '')}"></div>
    <div><label for="to">To</label><input id="to" name="to" type="date" value="${esc(qs.get('to') || '')}"></div>
    ${admin ? '' : `<div><label for="sort">Sort</label><select id="sort" name="sort">
      ${[['newest', 'Newest first'], ['oldest', 'Oldest first'], ['similarity', 'Highest similarity'], ['title', 'Title A–Z']].map(([v, t]) => `<option value="${v}" ${(qs.get('sort') || 'newest') === v ? 'selected' : ''}>${t}</option>`).join('')}
    </select></div>`}
    <div class="row"><button class="btn-primary">Apply</button>${filtering ? `<a class="btn" href="${base}">Clear</a>` : ''}</div>
  </form>
  ${data.items.length ? docTable(data.items, admin) : `<div class="empty"><h3>${filtering ? 'No documents match these filters' : 'No documents yet'}</h3>${filtering ? `<p><a href="${base}">Clear the filters</a></p>` : '<p><a class="btn btn-primary" href="#/submit">Check a document</a></p>'}</div>`}
  <div class="pager">
    <span class="small muted">${data.total.toLocaleString()} document${data.total === 1 ? '' : 's'}. Page ${data.page} of ${pages}.</span>
    <span class="row">${data.page > 1 ? `<a class="btn btn-sm" href="${link(data.page - 1)}">Previous</a>` : ''}${data.page < pages ? `<a class="btn btn-sm" href="${link(data.page + 1)}">Next</a>` : ''}</span>
  </div>`;
  if (admin) return listHtml;
  main.innerHTML = `<div class="spread"><h1>My documents</h1><a class="btn btn-primary" href="#/submit">Check a document</a></div>${listHtml}`;
  wireFilters(base);
  if (data.items.some(d => d.status === 'pending' || d.status === 'processing')) {
    pollTimer = setTimeout(() => location.hash.startsWith('#/documents') && render(), 4000);
  }
}

function wireFilters(base) {
  const form = document.getElementById('filters');
  form.onsubmit = e => {
    e.preventDefault();
    const p = new URLSearchParams();
    new FormData(form).forEach((v, k) => { if (v) p.set(k, v); });
    go(`${base}?${p}`);
  };
}

// ------------------------------------------------------------ report
async function reportPage([id]) {
  const data = await api(`/documents/${encodeURIComponent(id)}`);
  const d = data.document;
  setTitle(d.title);
  const header = `<p class="no-print"><a href="#/documents">My documents</a></p>`;
  if (d.status === 'pending' || d.status === 'processing') {
    main.innerHTML = `${header}<div class="panel waiting"><div class="spinner" aria-hidden="true"></div>
      <h1 style="font-size:1.6rem">${esc(d.title)}</h1>
      <p>${statusBadge(d.status)}</p>
      <p class="muted">${d.status === 'pending' ? 'Your document is in the queue.' : 'Reading the text and comparing it with the sample collection.'} This page updates by itself.</p>
      <p class="small muted">Reference ${esc(d.report_ref)}. Submitted ${fmtDate(d.created_at)}.</p></div>`;
    pollTimer = setTimeout(() => location.hash === `#/report/${id}` && render(), 2000);
    return;
  }
  if (d.status === 'failed') {
    main.innerHTML = `${header}<div class="panel"><h1>${esc(d.title)}</h1><p>${statusBadge('failed')}</p>
      <div class="form-error">${esc(d.error_message || 'The document could not be processed.')}</div>
      <div class="row"><button class="btn-primary" id="retry">Try again</button><a class="btn" href="#/submit">Submit a different file</a><button class="btn-danger" id="del">Delete</button></div></div>`;
    document.getElementById('retry').onclick = async () => { await api(`/documents/${id}/retry`, { method: 'POST' }); toast('Queued again.'); render(); };
    document.getElementById('del').onclick = () => deleteDoc(id);
    return;
  }

  // Build highlighted text from character offsets.
  const idx = new Map(data.sources.map((s, i) => [s.source_id, i]));
  const text = d.extracted_text || '';
  let html = '', pos = 0;
  data.matches.forEach((m, i) => {
    html += esc(text.slice(pos, m.char_start));
    const si = idx.get(m.source_id);
    html += `<mark class="m c${si % 8}" data-i="${i}" tabindex="0" title="Matches source ${si + 1}">${esc(text.slice(m.char_start, m.char_end))}<sup>${si + 1}</sup></mark>`;
    pos = m.char_end;
  });
  html += esc(text.slice(pos));
  const wm = Array.from({ length: 22 }, () => `<div>${WATERMARK}&nbsp;&nbsp;&nbsp;${WATERMARK}</div>`).join('');

  main.innerHTML = `${header}
  <div class="report-grid">
    <article class="report-paper" aria-label="Similarity report">
      <div class="watermark" aria-hidden="true">${wm}</div>
      <div class="report-head">
        <div>
          <h1>${esc(d.title)}</h1>
          <dl class="meta">
            <dt>Report reference</dt><dd>${esc(d.report_ref)}</dd>
            <dt>Submitted</dt><dd>${fmtDate(d.created_at)}</dd>
            <dt>Words checked</dt><dd>${Number(d.word_count).toLocaleString()}</dd>
            <dt>Matched words</dt><dd>${Number(d.matched_words).toLocaleString()}</dd>
            <dt>Matched passages</dt><dd>${data.matches.length}</dd>
          </dl>
        </div>
        <div class="score"><b>${pct(d.similarity)}</b><span>similarity estimate<br>(demo calculation)</span></div>
      </div>
      <div style="padding:20px 24px 0"><div class="disclaimer"><strong>Educational demonstration, not a Turnitin report.</strong> TimCheck compared this text only with its own ${'<a href="#/sources">sample collection</a>'}. It is not connected to Turnitin or any other database.${d.error_message ? ` ${esc(d.error_message)}` : ''}</div></div>
      <div class="report-text" id="rt">${html || '<span class="muted">No text.</span>'}</div>
    </article>
    <aside class="report-side stack">
      <div class="panel actions">
        <div class="row"><a class="btn btn-primary" href="/api/documents/${d.id}/report.pdf">Download PDF report</a><button id="print">Print</button></div>
        <div class="row" style="margin-top:12px"><button class="btn-sm btn-danger" id="del">Delete document</button></div>
      </div>
      <div class="panel">
        <h2 style="font-size:1.2rem">Matched sample sources</h2>
        ${data.sources.length ? `<ul class="sources-list">${data.sources.map((s, i) => `
          <li class="c${i % 8}"><span class="chip">${i + 1}</span>
            <div><div class="t"><a href="#/sources/${s.source_id}">${esc(s.title)}</a></div><div class="small muted">${s.words} matched words</div></div>
            <span class="p">${pct(s.percent)}</span></li>`).join('')}</ul>`
          : '<p class="muted">No passages matched the sample collection.</p>'}
        <div id="pop" aria-live="polite"></div>
      </div>
      <div class="panel small">
        <h3>Reading this number</h3>
        <p>${pct(d.similarity)} of the words are inside passages of 5 or more words that also appear in a sample source. Quotes and references count as matches too, so a high number is not proof of plagiarism, and a low number is not proof of originality.</p>
        <p style="margin:0">Text fingerprint (SHA-256): <span class="ref" style="word-break:break-all">${esc(d.text_sha256)}</span></p>
      </div>
    </aside>
  </div>`;
  document.getElementById('print').onclick = () => window.print();
  document.getElementById('del').onclick = () => deleteDoc(id);
  const showPassage = mk => {
    main.querySelectorAll('mark.active').forEach(x => x.classList.remove('active'));
    mk.classList.add('active');
    const m = data.matches[mk.dataset.i]; const si = idx.get(m.source_id); const s = data.sources[si];
    document.getElementById('pop').innerHTML = `<div class="passage-pop c${si % 8}"><span class="chip">${si + 1}</span> <strong>${m.word_count} words</strong> match <em>${esc(s.title)}</em>:<p style="margin:8px 0 0"><q>${esc(m.source_excerpt)}</q></p></div>`;
  };
  document.getElementById('rt').addEventListener('click', e => { const mk = e.target.closest('mark.m'); if (mk) showPassage(mk); });
  document.getElementById('rt').addEventListener('keydown', e => { const mk = e.target.closest('mark.m'); if (mk && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showPassage(mk); } });
}

async function deleteDoc(id) {
  if (!confirm('Delete this document and its report? This cannot be undone.')) return;
  await api(`/documents/${id}`, { method: 'DELETE' });
  toast('Document deleted.');
  go('#/documents');
}

// ------------------------------------------------------------ verify
async function verifyPage([ref]) {
  setTitle('Verify a report');
  main.innerHTML = `
  <div class="prose">
    <h1>Verify a TimCheck report</h1>
    <p>Reports can be edited after download. A PDF can be changed to show a lower number or a different title. Enter the reference printed on a TimCheck report to see the values that are stored on this server.</p>
    <form id="vf" class="row" style="align-items:flex-end">
      <div style="flex:1;min-width:240px"><label for="ref">Report reference</label><input id="ref" name="ref" type="text" placeholder="TC-20261023-1A2B3C4D5E" value="${esc(ref || '')}" autocapitalize="characters"></div>
      <button class="btn-primary">Check reference</button>
    </form>
    <div id="vr" style="margin-top:24px"></div>
    <div class="callout small">This page can only confirm TimCheck reports. It cannot confirm reports from Turnitin or any other service. To check those, ask your institution or use the service's own verification route.</div>
  </div>`;
  const vf = document.getElementById('vf');
  const run = async r => {
    const out = document.getElementById('vr');
    out.innerHTML = '<p class="muted">Checking…</p>';
    try {
      const { report } = await api(`/verify/${encodeURIComponent(r.trim())}`);
      out.innerHTML = `<div class="panel">
        <p>${statusBadge('completed')} This reference exists in TimCheck. Compare every value below with the report you were given. If any value is different, the report has been changed.</p>
        <dl class="meta">
          <dt>Reference</dt><dd>${esc(report.report_ref)}</dd>
          <dt>Submitted</dt><dd>${fmtDate(report.created_at)}</dd>
          <dt>Words checked</dt><dd>${Number(report.word_count).toLocaleString()}</dd>
          <dt>Matched words</dt><dd>${Number(report.matched_words).toLocaleString()}</dd>
          <dt>Similarity</dt><dd>${pct(report.similarity)}</dd>
          <dt>Text fingerprint</dt><dd class="ref" style="word-break:break-all">${esc(report.text_sha256)}</dd>
        </dl>
        <p class="small muted" style="margin:12px 0 0">The title and text are private to the owner, so they are not shown here.</p></div>`;
    } catch (e) {
      out.innerHTML = `<div class="form-error">${esc(e.message)} A missing or unknown reference is a strong sign that a report is not genuine.</div>`;
    }
  };
  vf.onsubmit = e => { e.preventDefault(); if (vf.ref.value.trim()) { history.replaceState(null, '', `#/verify/${encodeURIComponent(vf.ref.value.trim())}`); run(vf.ref.value); } };
  if (ref) run(decodeURIComponent(ref));
}

// ------------------------------------------------------------ sources
async function sourcesPage([id]) {
  if (id) {
    const s = await api(`/sources/${encodeURIComponent(id)}`);
    setTitle(s.title);
    main.innerHTML = `<p><a href="#/sources">Sample collection</a></p><article class="panel prose"><h1>${esc(s.title)}</h1>
      <p class="small muted">${esc(s.author || '')}${s.origin ? ` — ${esc(s.origin)}` : ''}. ${s.word_count} words.</p>
      <div style="font-family:var(--serif);white-space:pre-wrap;line-height:1.75">${esc(s.body)}</div></article>`;
    return;
  }
  setTitle('Sample collection');
  const { items } = await api('/sources');
  main.innerHTML = `<div class="prose"><h1>The sample collection</h1>
    <p>Every submission is compared only with these ${items.length} documents. They were written for this demonstration. Turnitin and other commercial services compare against billions of web pages, publications and past student papers, which TimCheck does not have.</p>
    <p class="small muted">The site owner can add more sources with <code>npm run add-sources -- ./folder</code>.</p></div>
    <table class="table" style="margin-top:16px"><thead><tr><th>Title</th><th>Origin</th><th>Words</th></tr></thead><tbody>
    ${items.map(s => `<tr><td class="title"><a href="#/sources/${s.id}">${esc(s.title)}</a></td><td data-label="Origin">${esc(s.origin || '')}</td><td data-label="Words">${s.word_count}</td></tr>`).join('')}
    </tbody></table>`;
}

// ------------------------------------------------------------ admin
async function adminPage(_, qs) {
  if (state.user.role !== 'admin') { main.innerHTML = '<div class="form-error">Admins only.</div>'; return; }
  const stats = await api('/admin/stats');
  const list = await documentsPage(_, qs, true);
  setTitle('Admin');
  main.innerHTML = `<div class="spread"><div><h1>All submissions</h1><p class="muted" style="margin:0">Admins see document details, not document text. Reports stay private to their owners.</p></div></div>
  <div class="tiles" style="margin-bottom:24px">
    <div class="tile"><b>${stats.users}</b><span>Users</span></div>
    <div class="tile"><b>${stats.documents.toLocaleString()}</b><span>Documents</span></div>
    <div class="tile"><b>${stats.pending + stats.processing}</b><span>In the queue</span></div>
    <div class="tile"><b>${stats.failed}</b><span>Failed</span></div>
    <div class="tile"><b>${stats.sources}</b><span>Sample sources</span></div>
  </div>${list}`;
  wireFilters('#/admin');
}

// ------------------------------------------------------------ learn
function learnPage() {
  setTitle('Learn');
  main.innerHTML = `
  <div class="learn-layout">
    <nav class="toc" aria-label="On this page"><ol>
      <li><a href="#/learn" data-to="learn-how">How TimCheck works</a></li>
      <li><a href="#/learn" data-to="learn-fake">How fake checker sites imitate real services</a></li>
      <li><a href="#/learn" data-to="learn-scores">How invented scores and edited PDFs mislead students</a></li>
      <li><a href="#/learn" data-to="learn-verify">Telling a genuine report from an unverified one</a></li>
      <li><a href="#/learn" data-to="learn-percent">Why a percentage is not proof of plagiarism</a></li>
      <li><a href="#/learn" data-to="learn-limits">Limits of this demonstration</a></li>
    </ol></nav>
    <article class="prose">
      <h1>How similarity checking works, and how it is faked</h1>
      <p>This page explains what a similarity report really measures, how dishonest websites and edited files copy the look of a report, and how to protect yourself.</p>

      <h2 id="learn-how">How TimCheck works</h2>
      <ol>
        <li><strong>Read the text.</strong> PDF and Word files are turned into plain text. Pasted text is used as it is.</li>
        <li><strong>Split it into words.</strong> Capital letters and punctuation are ignored, so “Hand hygiene,” and “hand hygiene” are the same.</li>
        <li><strong>Make five-word pieces.</strong> “hand hygiene remains the single” is one piece, “hygiene remains the single most” is the next, and so on.</li>
        <li><strong>Look them up.</strong> Every piece of every sample source is stored in a database index. All pieces of your document are looked up in one query, and each hit is checked word by word.</li>
        <li><strong>Join hits into passages.</strong> Hits that continue in the same order in both texts become one highlighted passage.</li>
        <li><strong>Count each word once.</strong> If two sources match the same words, the longer passage wins, so nothing is counted twice.</li>
        <li><strong>Calculate.</strong> Similarity = matched words ÷ total words × 100. The same text always gives the same number.</li>
      </ol>
      <p>Commercial checkers use similar ideas but much larger collections, more careful handling of quotes and references, and methods that can catch some light rewording. TimCheck finds exact runs of five or more words only.</p>

      <h2 id="learn-fake">How fake checker sites imitate real services</h2>
      <p>Some websites sell “official” plagiarism reports or “guaranteed 0% similarity” services. Common tricks include:</p>
      <ul>
        <li><strong>Borrowed names and logos.</strong> A name that contains or sounds like a well-known brand, plus a copied logo and colours, so the site looks official.</li>
        <li><strong>Copied report layouts.</strong> Screenshots or templates of real reports, with a new number typed in.</li>
        <li><strong>No real checking.</strong> The site shows a progress bar and then a random or chosen score. Sometimes it never reads the file at all.</li>
        <li><strong>Collecting papers.</strong> Some sites keep and resell uploaded essays, which can later make the original author look like the copier.</li>
        <li><strong>Pressure to pay.</strong> A low score is shown only after payment, or a high score is shown to sell a “rewriting” service.</li>
      </ul>
      <div class="callout">This is why TimCheck uses its own name, puts a watermark on every report, and says on every page that it is not connected to Turnitin.</div>

      <h2 id="learn-scores">How invented scores and edited PDFs mislead students</h2>
      <p>A PDF is easy to change. With common editing tools, anyone can change the percentage, the title, the date or the student name, or delete the highlighted pages. The result can look exactly like a real report.</p>
      <div class="fake-vs-real">
        <div class="mini-report flag"><b class="big">3%</b>Edited PDF given to a student. Reference TC-20261023-… is printed on it. The highlights page has been removed.</div>
        <div class="mini-report"><b class="big">38.4%</b>Value stored on the TimCheck server for the same reference, shown on the verification page.</div>
      </div>
      <p>Students are harmed in several ways. They may submit work believing it is safe, pay for a service that did nothing, or be accused of misconduct when the institution runs its own check and gets a very different result. Presenting a falsified report to a school is itself academic misconduct and can have serious consequences.</p>

      <h2 id="learn-verify">Telling a genuine report from an unverified one</h2>
      <table class="compare">
        <thead><tr><th>Check</th><th>Genuine report</th><th>Warning sign</th></tr></thead>
        <tbody>
          <tr><td>Where it came from</td><td>Your institution's learning system, or a service your teacher named</td><td>A website found through an advert, a social media message, or a seller</td></tr>
          <tr><td>Verification</td><td>Can be confirmed with the issuer, or by the teacher inside their own account</td><td>No reference, or a reference the issuer does not recognise</td></tr>
          <tr><td>Numbers</td><td>Percentages add up and match the highlighted text</td><td>Round or very low numbers with few or no highlights</td></tr>
          <tr><td>File</td><td>Downloaded by you, directly from the service</td><td>Sent to you as an attachment or screenshot by someone else</td></tr>
          <tr><td>Promises</td><td>Explains that the number needs human review</td><td>Guarantees “0%” or “undetectable” results</td></tr>
        </tbody>
      </table>
      <p>For TimCheck reports, use the <a href="#/verify">verification page</a>. For any other service, ask the issuer directly. A screenshot or PDF alone is never proof.</p>

      <h2 id="learn-percent">Why a percentage is not proof of plagiarism</h2>
      <ul>
        <li><strong>Correct quotes match.</strong> A properly quoted and referenced sentence is still the same words as its source.</li>
        <li><strong>Common phrases match.</strong> Technical terms, standard definitions and set phrases (“evidence-based practice is”) appear in many texts.</li>
        <li><strong>Your own earlier work matches.</strong> Reusing your own draft or an earlier assignment can raise the number.</li>
        <li><strong>Reference lists match.</strong> Citations often appear in exactly the same form in other papers.</li>
        <li><strong>A low number can hide problems.</strong> Heavy paraphrasing, translation, or work written by someone else may show no matches at all.</li>
      </ul>
      <p>A similarity report is a starting point for a human reader. Teachers look at <em>which</em> passages match and <em>why</em>, then decide whether there is a problem. No single percentage is a pass or fail line.</p>

      <h2 id="learn-limits">Limits of this demonstration</h2>
      <ul>
        <li>The collection has only a small number of sample texts, so most real writing will show 0%.</li>
        <li>Only exact runs of five or more words are found. Light rewording is not detected.</li>
        <li>Quotes and references are not excluded automatically.</li>
        <li>Scanned PDFs that contain images instead of text cannot be read. Old .doc files are not supported.</li>
        <li>Documents longer than the configured word limit are checked only up to that limit, and the report says so.</li>
      </ul>
    </article>
  </div>`;
  // In-page links (the address bar hash is used by the router, so scroll manually).
  main.querySelectorAll('.toc a[data-to]').forEach(a => a.onclick = e => {
    e.preventDefault();
    const target = document.getElementById(a.dataset.to);
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true });
  });
}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#123b3a"/><rect x="7" y="10" width="18" height="5" rx="1.5" fill="#ffd84d"/><rect x="7" y="18" width="12" height="3" rx="1" fill="#e9f1f0"/></svg>
