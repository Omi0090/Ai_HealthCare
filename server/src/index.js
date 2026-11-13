require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { initStore, getStore } = require('./db/store');
const { errorHandler } = require('./middleware/auth');
const ml = require('./services/mlService');

const authRoutes = require('./routes/auth');
const claimRoutes = require('./routes/claims');
const dashboardRoutes = require('./routes/dashboard');
const caseRoutes = require('./routes/cases');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT || 600),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

app.get('/api/health', async (req, res) => {
  let kind = 'uninitialised';
  try {
    const store = getStore();
    kind = store.kind === 'mongodb' ? 'mongodb' : 'json';
  } catch { /* store not initialised yet (e.g. before start()) */ }
  res.json({
    status: 'ok',
    service: 'MedGuard AI - Healthcare Insurance Fraud Detection API',
    version: '1.0.0',
    database: kind,
    ml: ml.getStatus(),
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/claims', claimRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: `Unknown endpoint ${req.method} ${req.originalUrl}` }));
app.use(errorHandler);

async function start() {
  await initStore();
  await ml.checkHealth();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  MedGuard AI API  ->  http://localhost:${PORT}/api`);
    console.log(`  ML service       ->  ${ml.getStatus().reachable ? 'online' : 'offline (using fallback linear model)'}`);
    console.log(`  Database         ->  ${getStore().kind === 'mongodb' ? 'MongoDB (Mongoose)' : 'local JSON store (MongoDB not reachable)'}\n`);
  });
  const shutdown = async () => {
    console.log('\n[server] shutting down...');
    server.close();
    const { closeStore } = require('./db/store');
    await closeStore();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
