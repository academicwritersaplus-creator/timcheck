'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);

const config = require('./src/config');
const { pool } = require('./src/db');
const migrate = require('./src/migrate');
const worker = require('./src/worker');
const { requireAppHeader } = require('./src/middleware');

const app = express();
if (config.isProd) app.set('trust proxy', 1);   // behind Render / Railway / Nginx HTTPS proxy

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
}));
app.use(express.json({ limit: '100kb' }));

app.use(session({
  name: 'timcheck.sid',
  store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: 3600 }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 24 * 3600 * 1000 },
}));

app.use('/api', requireAppHeader);
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/documents', require('./src/routes/documents'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api', require('./src/routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '1h' : 0 }));
app.get('/{*any}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

async function main() {
  await migrate();
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM sources');
  if (!rows[0].n) console.warn('[setup] The comparison collection is empty. Run: npm run seed');
  if (config.runWorkerInWeb) worker.start();
  app.listen(config.port, () => console.log(`TimCheck running at ${config.appUrl} (port ${config.port})`));
}

if (require.main === module) {
  main().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
}

module.exports = app;
