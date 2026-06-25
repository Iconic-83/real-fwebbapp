require('dotenv').config();
// Force IPv4 DNS — Telegram & some APIs fail on IPv6 in this environment
const dns    = require('dns');
const https  = require('https');
const crypto = require('crypto');
dns.setDefaultResultOrder('ipv4first');

// Prevent Node.js from exiting on unhandled promise rejections (Express 4 doesn't
// auto-catch async handler rejections — without this, any missing try/catch kills the process)
process.on('unhandledRejection', (reason) => {
  console.error('[SAFETY] Unhandled Promise Rejection — crash prevented:', reason?.message || String(reason));
});

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
const OpenAI    = require('openai');
const db        = require('./db');

const app    = express();
const PORT   = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── CORS — allow same-origin tunnel access + localhost ───────────────────────
// Vite adds crossorigin to module scripts so browser sends Origin even for
// same-origin requests. Must allow the tunnel host or JS bundle gets 500.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-side / curl
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return cb(null, true);
    if (origin.endsWith('.onrender.com')) return cb(null, true); // production domain
    if (origin.endsWith('.trycloudflare.com')) return cb(null, true);
    if (origin.endsWith('.loca.lt')) return cb(null, true);
    if (EXTRA_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// ── FIX 5: Authentication middleware ─────────────────────────────────────────
const APP_SECRET = process.env.APP_SECRET || '';
const PUBLIC_PATHS = ['/api/health', '/api/prices', '/api/url'];
function requireAuth(req, res, next) {
  if (!APP_SECRET) return next(); // no secret configured = open (dev mode)
  // Skip auth for health + static assets + tunnel probe
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  if (!req.path.startsWith('/api')) return next(); // static files
  const token = req.headers['x-app-token'] || req.query._token;
  if (token === APP_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
app.use(requireAuth);

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Prepared once — storage table created in db.js before this runs
const _stmtGetStorage = db.prepare('SELECT value FROM storage WHERE key = ?');
const _stmtSetStorage = db.prepare(`
  INSERT INTO storage (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);

function getStorageValue(key) {
  const row = _stmtGetStorage.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setStorageValue(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  _stmtSetStorage.run(key, v);
}

// API keys cached for 30 s — avoid DB round-trip on every request
let _keysCache = null, _keysCacheAt = 0;
function getApiKeys() {
  if (_keysCache && (Date.now() - _keysCacheAt) < 30000) return _keysCache;
  const stored = getStorageValue('ptp_keys') || {};
  _keysCache = {
    openai_key:    process.env.OPENAI_API_KEY    || stored.openai_key    || '',
    claude_key:    process.env.ANTHROPIC_API_KEY  || stored.claude_key   || '',
    oanda_key:     process.env.OANDA_API_KEY      || stored.oanda_key     || '',
    oanda_account: process.env.OANDA_ACCOUNT_ID   || stored.oanda_account || '',
    twelve_key:    process.env.TWELVE_DATA_KEY    || stored.twelve_key    || '',
    tg_token:      process.env.TELEGRAM_TOKEN     || stored.tg_token      || '',
    tg_chat:       process.env.TELEGRAM_CHAT_ID   || stored.tg_chat       || '',
  };
  _keysCacheAt = Date.now();
  return _keysCache;
}
function invalidateKeysCache() { _keysCache = null; }

// ═════════════════════════════════════════════════════════════════════════════
// DATABASE SCHEMA — every CREATE TABLE / migration / index runs here, before
// any code below this point prepares statements against them. Previously some
// of these were scattered ~2800 lines further down, after several top-level
// db.prepare() calls that referenced 'signals' — so a brand-new deploy with no
// existing data/precisiontrader.db crashed instantly with "no such table:
// signals". Keep all schema setup consolidated in this one block.
// ═════════════════════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_pnl (
    date TEXT PRIMARY KEY,
    realized_pl REAL NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// signals table — every signal (pending, approved, rejected, executed, failed)
db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    actioned_at    DATETIME,
    pair           TEXT NOT NULL,
    direction      TEXT NOT NULL,
    confidence     INTEGER NOT NULL,
    entry_price    REAL,
    stop_loss      REAL,
    take_profit    REAL,
    sl_pips        REAL,
    tp_pips        REAL,
    units          INTEGER,
    risk_pct       REAL,
    risk_amount    REAL,
    lots           TEXT,
    status         TEXT DEFAULT 'PENDING',
    oanda_order_id TEXT,
    trade_id       TEXT,
    filled_price   REAL,
    realized_pl    REAL,
    exit_price     REAL,
    exit_reason    TEXT,
    closed_at      DATETIME,
    duration_mins  INTEGER,
    actual_pips    REAL,
    analysis       TEXT,
    ema_align      TEXT,
    rsi            REAL,
    h4_trend       TEXT,
    tg_message_id  INTEGER
  );
`);

// Keep old table for compat (ignore if already exists)
db.exec(`CREATE TABLE IF NOT EXISTS auto_trades (id INTEGER PRIMARY KEY, timestamp DATETIME, pair TEXT, direction TEXT, confidence INTEGER, units INTEGER, entry_price REAL, stop_loss REAL, take_profit REAL, oanda_order_id TEXT, status TEXT, pl REAL, notes TEXT);`);

// ── Execution fill quality log ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS execution_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    signal_id       INTEGER,
    pair            TEXT,
    session         TEXT,
    expected_px     REAL,
    actual_px       REAL,
    slippage_pips   REAL,
    slippage_dir    TEXT,
    spread_at_entry REAL,
    latency_ms      INTEGER,
    oanda_trade_id  TEXT,
    partial_closed  INTEGER DEFAULT 0
  );
`);
// Migrate older execution_log tables that lack the new columns
['oanda_trade_id TEXT', 'partial_closed INTEGER DEFAULT 0'].forEach(col => {
  try { db.exec(`ALTER TABLE execution_log ADD COLUMN ${col}`); } catch {}
});

// Migrate existing DBs — add columns that were added after initial deploy
[
  'trade_id TEXT',
  'exit_price REAL',
  'exit_reason TEXT',
  'closed_at DATETIME',
  'duration_mins INTEGER',
  'actual_pips REAL',
].forEach(col => { try { db.exec(`ALTER TABLE signals ADD COLUMN ${col}`); } catch {} });

// ── Risk events log — every governor block or circuit breaker fire ───────────
db.exec(`
  CREATE TABLE IF NOT EXISTS risk_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type   TEXT NOT NULL,
    detail       TEXT,
    blocked_pair TEXT,
    action       TEXT
  );
`);

// ── Trade psychology (mood + behavior tags logged per journal note) ──────────
['stress INTEGER', 'confidence INTEGER', 'fear INTEGER', 'greed INTEGER',
 'followed_plan INTEGER', 'mistake_tags TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE journal_notes ADD COLUMN ${col}`); } catch {}
});

// ── AI Coach reports — generated reviews of trade history + psychology data ──
db.exec(`
  CREATE TABLE IF NOT EXISTS coach_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    trade_count INTEGER,
    win_rate    REAL,
    report      TEXT,
    stats_json  TEXT
  );
`);

// ── Indexes — fast lookups on large signals table ─────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_signals_status     ON signals(status);
  CREATE INDEX IF NOT EXISTS idx_signals_created    ON signals(created_at);
  CREATE INDEX IF NOT EXISTS idx_signals_closed     ON signals(closed_at);
  CREATE INDEX IF NOT EXISTS idx_signals_trade_id   ON signals(trade_id);
  CREATE INDEX IF NOT EXISTS idx_risk_events_date   ON risk_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_daily_pnl_date     ON daily_pnl(date);
`);

// OANDA instrument map (label → OANDA format)
const LABEL_TO_OANDA = {
  // Major USD pairs
  'EUR/USD':'EUR_USD','GBP/USD':'GBP_USD','USD/JPY':'USD_JPY',
  'USD/CHF':'USD_CHF','USD/CAD':'USD_CAD','AUD/USD':'AUD_USD','NZD/USD':'NZD_USD',
  // EUR crosses
  'EUR/GBP':'EUR_GBP','EUR/JPY':'EUR_JPY','EUR/CHF':'EUR_CHF',
  'EUR/AUD':'EUR_AUD','EUR/CAD':'EUR_CAD','EUR/NZD':'EUR_NZD',
  // GBP crosses
  'GBP/JPY':'GBP_JPY','GBP/CHF':'GBP_CHF','GBP/AUD':'GBP_AUD',
  'GBP/CAD':'GBP_CAD','GBP/NZD':'GBP_NZD',
  // AUD crosses
  'AUD/JPY':'AUD_JPY','AUD/CAD':'AUD_CAD','AUD/CHF':'AUD_CHF','AUD/NZD':'AUD_NZD',
  // Other crosses
  'CAD/JPY':'CAD_JPY','NZD/JPY':'NZD_JPY','CHF/JPY':'CHF_JPY',
  'NZD/CAD':'NZD_CAD','NZD/CHF':'NZD_CHF',
  // Commodities
  'XAU/USD':'XAU_USD','XAG/USD':'XAG_USD',
  // Scandinavian
  'USD/SEK':'USD_SEK','USD/NOK':'USD_NOK','USD/DKK':'USD_DKK',
  'EUR/SEK':'EUR_SEK','EUR/NOK':'EUR_NOK',
  // Emerging markets
  'USD/ZAR':'USD_ZAR','USD/MXN':'USD_MXN','USD/TRY':'USD_TRY',
  'USD/SGD':'USD_SGD','USD/HKD':'USD_HKD','USD/CNH':'USD_CNH',
  'USD/PLN':'USD_PLN','EUR/PLN':'EUR_PLN','EUR/TRY':'EUR_TRY',
  'GBP/ZAR':'GBP_ZAR','EUR/ZAR':'EUR_ZAR',
  // Asian crosses
  'SGD/JPY':'SGD_JPY','AUD/SGD':'AUD_SGD',
  // Platinum / Palladium
  'XPT/USD':'XPT_USD','XPD/USD':'XPD_USD',
  // Compact aliases
  'EURUSD':'EUR_USD','GBPUSD':'GBP_USD','USDJPY':'USD_JPY',
  'USDCHF':'USD_CHF','USDCAD':'USD_CAD','AUDUSD':'AUD_USD','NZDUSD':'NZD_USD',
  'XAUUSD':'XAU_USD','XAGUSD':'XAG_USD',
};

// OANDA instrument → display label
const PAIR_LABELS = {
  EUR_USD:'EUR/USD', GBP_USD:'GBP/USD', USD_JPY:'USD/JPY',
  USD_CHF:'USD/CHF', USD_CAD:'USD/CAD', AUD_USD:'AUD/USD', NZD_USD:'NZD/USD',
  EUR_GBP:'EUR/GBP', EUR_JPY:'EUR/JPY', EUR_CHF:'EUR/CHF',
  EUR_AUD:'EUR/AUD', EUR_CAD:'EUR/CAD', EUR_NZD:'EUR/NZD',
  GBP_JPY:'GBP/JPY', GBP_CHF:'GBP/CHF', GBP_AUD:'GBP/AUD',
  GBP_CAD:'GBP/CAD', GBP_NZD:'GBP/NZD',
  AUD_JPY:'AUD/JPY', AUD_CAD:'AUD/CAD', AUD_CHF:'AUD/CHF', AUD_NZD:'AUD/NZD',
  CAD_JPY:'CAD/JPY', NZD_JPY:'NZD/JPY', CHF_JPY:'CHF/JPY',
  NZD_CAD:'NZD/CAD', NZD_CHF:'NZD/CHF',
  XAU_USD:'XAU/USD', XAG_USD:'XAG/USD',
  // Scandinavian
  USD_SEK:'USD/SEK', USD_NOK:'USD/NOK', USD_DKK:'USD/DKK',
  EUR_SEK:'EUR/SEK', EUR_NOK:'EUR/NOK',
  // Emerging markets
  USD_ZAR:'USD/ZAR', USD_MXN:'USD/MXN', USD_TRY:'USD/TRY',
  USD_SGD:'USD/SGD', USD_HKD:'USD/HKD', USD_CNH:'USD/CNH',
  USD_PLN:'USD/PLN', EUR_PLN:'EUR/PLN', EUR_TRY:'EUR/TRY',
  GBP_ZAR:'GBP/ZAR', EUR_ZAR:'EUR/ZAR',
  // Asian crosses
  SGD_JPY:'SGD/JPY', AUD_SGD:'AUD/SGD',
  // Precious metals
  XPT_USD:'XPT/USD', XPD_USD:'XPD/USD',
};

// Pip sizes
const PIP = {
  // Major USD
  EUR_USD:0.0001, GBP_USD:0.0001, USD_JPY:0.01,
  USD_CHF:0.0001, USD_CAD:0.0001, AUD_USD:0.0001, NZD_USD:0.0001,
  // EUR crosses
  EUR_GBP:0.0001, EUR_JPY:0.01, EUR_CHF:0.0001,
  EUR_AUD:0.0001, EUR_CAD:0.0001, EUR_NZD:0.0001,
  // GBP crosses
  GBP_JPY:0.01, GBP_CHF:0.0001, GBP_AUD:0.0001,
  GBP_CAD:0.0001, GBP_NZD:0.0001,
  // AUD crosses
  AUD_JPY:0.01, AUD_CAD:0.0001, AUD_CHF:0.0001, AUD_NZD:0.0001,
  // Other crosses
  CAD_JPY:0.01, NZD_JPY:0.01, CHF_JPY:0.01,
  NZD_CAD:0.0001, NZD_CHF:0.0001,
  // Commodities
  XAU_USD:0.1, XAG_USD:0.01,
  // Scandinavian (large price levels — pip = 0.0001)
  USD_SEK:0.0001, USD_NOK:0.0001, USD_DKK:0.0001,
  EUR_SEK:0.0001, EUR_NOK:0.0001,
  // Emerging markets
  USD_ZAR:0.0001, USD_MXN:0.0001, USD_TRY:0.0001,
  USD_SGD:0.0001, USD_HKD:0.0001, USD_CNH:0.0001,
  USD_PLN:0.0001, EUR_PLN:0.0001, EUR_TRY:0.0001,
  GBP_ZAR:0.0001, EUR_ZAR:0.0001,
  // Asian crosses
  SGD_JPY:0.01, AUD_SGD:0.0001,
  // Precious metals
  XPT_USD:0.01, XPD_USD:0.1,
};

// FIX 4 — OANDA latency telemetry
let oandaLatencyLog = [];
let oandaFailCount  = 0;
function getOandaAvgLatency() {
  if (!oandaLatencyLog.length) return 0;
  return oandaLatencyLog.reduce((s, v) => s + v, 0) / oandaLatencyLog.length;
}

// Order OANDA hosts by the configured environment so we hit the correct one
// FIRST (and avoid burning a full timeout on the wrong host). Defaults to
// practice. The other host stays as a fallback for misconfiguration.
function oandaBases() {
  const env = (process.env.OANDA_ENV || '').toLowerCase();
  const practice = 'https://api-fxpractice.oanda.com';
  const live     = 'https://api-fxtrade.oanda.com';
  return (env === 'live' || env === 'trade') ? [live, practice] : [practice, live];
}

async function oandaRequest(path, method = 'GET', data = null, timeout = 12000) {
  const keys = getApiKeys();
  if (!keys.oanda_key) throw new Error('OANDA key not configured');
  const bases = oandaBases();
  for (const base of bases) {
    const t0 = Date.now();
    try {
      const r = await axios({
        method, url: base + path,
        data: data || undefined,
        headers: { Authorization: `Bearer ${keys.oanda_key}`, 'Content-Type': 'application/json' },
        timeout,
      });
      const ms = Date.now() - t0;
      oandaLatencyLog.push(ms);
      if (oandaLatencyLog.length > 20) oandaLatencyLog.shift();
      return r.data;
    } catch (e) {
      oandaFailCount++;
      if (e.response) return e.response.data;
    }
  }
  oandaFailCount++;
  throw new Error('OANDA unreachable');
}

// Merge freshly fetched closed trades into the persistent cache (dedupe by id,
// newest first). Because OANDA's history endpoints are flaky, each successful
// (even partial) fetch ACCUMULATES into the cache, so the journal fills in
// progressively across loads and survives outages.
const CLOSED_CACHE_KEY = 'closed_trades_cache';
function mergeClosedCache(newTrades) {
  const cached = getStorageValue(CLOSED_CACHE_KEY);
  const byId = {};
  (cached?.trades || []).forEach(t => { byId[t.id] = t; });
  (newTrades || []).forEach(t => { if (t && t.id) byId[t.id] = t; });
  const merged = Object.values(byId)
    .sort((a, b) => new Date(b.closeTime || 0) - new Date(a.closeTime || 0))
    .slice(0, 500);
  setStorageValue(CLOSED_CACHE_KEY, { at: Date.now(), trades: merged });
  return merged;
}

// Reconstruct CLOSED trades from the transactions API. OANDA's
// /trades?state=CLOSED and /trades?state=ALL routinely 504 (they scan the full
// closed-trade set) while /transactions/idrange over a SMALL id window stays
// responsive. We page backward from the last transaction id in small chunks,
// pairing each ORDER_FILL's tradeOpened with its tradesClosed to rebuild the
// same shape buildJournalData/history already consume. Partial results are fine
// — mergeClosedCache accumulates them.
function reduceFillsToClosedTrades(fills, count) {
  const opens = {}, closes = {}, fullyClosed = new Set();
  fills.forEach(tx => {
    if (tx.type !== 'ORDER_FILL') return;
    if (tx.tradeOpened) {
      const o = tx.tradeOpened;
      opens[o.tradeID] = { instrument: tx.instrument, price: o.price || tx.price, units: o.units, openTime: tx.time };
    }
    (tx.tradesClosed || []).forEach(c => fullyClosed.add(c.tradeID));
    const arr = [...(tx.tradesClosed || [])];
    if (tx.tradeReduced) arr.push(tx.tradeReduced);
    arr.forEach(c => {
      const cur = closes[c.tradeID] || { pl: 0, price: tx.price, closeTime: tx.time };
      cur.pl += parseFloat(c.realizedPL || 0);
      cur.price = c.price || tx.price;
      cur.closeTime = tx.time;
      closes[c.tradeID] = cur;
    });
  });
  return Object.keys(closes)
    .filter(id => opens[id] && fullyClosed.has(id))
    .map(id => {
      const o = opens[id], c = closes[id];
      return {
        id, instrument: o.instrument, price: o.price, averageClosePrice: c.price,
        realizedPL: c.pl.toFixed(4), initialUnits: o.units, openTime: o.openTime, closeTime: c.closeTime,
      };
    })
    .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime))
    .slice(0, count);
}

async function reconstructClosedFromTransactions(count = 200, budgetMs = 14000) {
  const keys = getApiKeys();
  const base = oandaBases()[0];
  const acct = keys.oanda_account;
  const auth = { headers: { Authorization: `Bearer ${keys.oanda_key}` } };

  let lastId = 0;
  try {
    const sum = await axios.get(`${base}/v3/accounts/${acct}/summary`, { ...auth, timeout: 6000 });
    lastId = parseInt(sum.data?.account?.lastTransactionID || sum.data?.lastTransactionID || 0);
  } catch { return []; }
  if (!lastId) return [];

  const CHUNK = 40; // small windows survive OANDA degradation (wide ranges 504)
  const deadline = Date.now() + budgetMs;
  const fills = [];
  for (let to = lastId; to > 0 && Date.now() < deadline; to -= (CHUNK + 1)) {
    const from = Math.max(1, to - CHUNK);
    let got = false;
    for (let attempt = 0; attempt < 2 && !got && Date.now() < deadline; attempt++) {
      try {
        const resp = await axios.get(
          `${base}/v3/accounts/${acct}/transactions/idrange?from=${from}&to=${to}&type=ORDER_FILL`,
          { ...auth, timeout: 5000 }
        );
        (resp.data?.transactions || []).forEach(t => fills.push(t));
        got = true;
      } catch { oandaFailCount++; /* retry once, then move on */ }
    }
  }
  return reduceFillsToClosedTrades(fills, count);
}

// Fetch CLOSED trades resiliently: serve a fresh cache instantly, else try the
// fast /trades endpoint, else reconstruct from transactions, else fall back to
// any cached data — so Journal/Analytics never hang and history accumulates
// even while OANDA's history endpoints are degraded.
async function fetchClosedTrades(count = 200) {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) {
    return { ok: false, trades: [], error: 'OANDA not configured', cachedAt: null };
  }
  const cached = getStorageValue(CLOSED_CACHE_KEY);
  // Fresh cache (<5 min) → instant.
  if (cached?.trades?.length && (Date.now() - (cached.at || 0) < 5 * 60 * 1000)) {
    return { ok: true, trades: cached.trades.slice(0, count), cachedAt: cached.at };
  }

  const base = oandaBases()[0];
  // 1) Fast path — the normal closed-trades endpoint (when OANDA is healthy).
  try {
    const resp = await axios.get(
      `${base}/v3/accounts/${keys.oanda_account}/trades?state=CLOSED&count=${count}`,
      { headers: { Authorization: `Bearer ${keys.oanda_key}` }, timeout: 5000 }
    );
    if (Array.isArray(resp.data?.trades) && resp.data.trades.length) {
      return { ok: true, trades: mergeClosedCache(resp.data.trades).slice(0, count) };
    }
  } catch { oandaFailCount++; }

  // 2) Fallback — reconstruct from the transactions API (works while /trades 504s).
  try {
    const recon = await reconstructClosedFromTransactions(count);
    if (recon.length) {
      return { ok: true, trades: mergeClosedCache(recon).slice(0, count), source: 'transactions' };
    }
  } catch { oandaFailCount++; }

  // 3) Anything we have cached, even if stale.
  if (cached?.trades?.length) {
    return { ok: true, trades: cached.trades.slice(0, count), cachedAt: cached.at, stale: true };
  }
  return { ok: false, trades: [], error: 'OANDA trade history is temporarily unavailable (OANDA servers are degraded). It will load automatically as their service recovers.', cachedAt: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — 4-Timeframe Precision Engine
// ═════════════════════════════════════════════════════════════════════════════
function calcEMA(closes, period) {
  if (!closes.length) return 0;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  let sum = 0, cnt = 0;
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const h = parseFloat(candles[i].mid.h), l = parseFloat(candles[i].mid.l), pc = parseFloat(candles[i-1].mid.c);
    sum += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)); cnt++;
  }
  return cnt ? sum/cnt : 0;
}

function calcMACD(closes) {
  if (closes.length < 26) return 0;
  return parseFloat((calcEMA(closes, 12) - calcEMA(closes, 26)).toFixed(6));
}

// ADX — Wilder's smoothed Average Directional Index (matches charting platforms)
// Uses Wilder's RMA (Recursive Moving Average) for TR/+DM/-DM smoothing
function calcADX(candles, period = 14) {
  const needed = period * 2 + 2;
  if (candles.length < needed) return 0;
  const slice = candles.slice(-needed);

  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < slice.length; i++) {
    const h  = parseFloat(slice[i].mid.h),   l  = parseFloat(slice[i].mid.l);
    const ph = parseFloat(slice[i-1].mid.h), pl = parseFloat(slice[i-1].mid.l);
    const pc = parseFloat(slice[i-1].mid.c);
    const tr  = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up  = h - ph, dn = pl - l;
    trs.push(tr);
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }

  // Initial Wilder sum (first `period` bars)
  let trW  = trs.slice(0, period).reduce((s, v) => s + v, 0);
  let pdmW = plusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let mdmW = minusDMs.slice(0, period).reduce((s, v) => s + v, 0);

  const dxValues = [];
  const addDX = () => {
    if (!trW) return;
    const diP = (pdmW / trW) * 100;
    const diM = (mdmW / trW) * 100;
    const sum = diP + diM;
    if (sum > 0) dxValues.push(Math.abs(diP - diM) / sum * 100);
  };
  addDX();

  // Continue Wilder smoothing
  for (let i = period; i < trs.length; i++) {
    trW  = trW  - trW  / period + trs[i];
    pdmW = pdmW - pdmW / period + plusDMs[i];
    mdmW = mdmW - mdmW / period + minusDMs[i];
    addDX();
  }

  if (!dxValues.length) return 0;
  // ADX = Wilder average of DX
  const adx = dxValues.reduce((s, v) => s + v, 0) / dxValues.length;
  return parseFloat(adx.toFixed(1));
}

// Spread acceptable? — reject if spread > 25% of ATR (thin market / news spike)
function isSpreadAcceptable(pair, atr) {
  const spread = spreadCache[pair];
  if (!spread || !atr) return true; // no data → allow (fail open)
  return (spread / atr) <= 0.25;
}

// ATR expanded? — true if recent ATR is > threshold × historical ATR
// Detects volatility explosions that make trend systems unreliable
function isATRExpanded(candles, threshold = 1.8) {
  if (candles.length < 35) return false;
  const recentATR  = calcATR(candles.slice(-14), 14);
  const historicATR = calcATR(candles.slice(-35, -14), 14);
  if (!historicATR || !recentATR) return false;
  return (recentATR / historicATR) > threshold;
}

// FIX 1 — Only use completed candles; also deduplicate by timestamp
// Dedup prevents duplicate candles (OANDA retries / race conditions) from
// corrupting EMA/RSI/ATR calculations with phantom repeated bars
function completedCandles(candles) {
  const seen = new Set();
  return candles
    .filter(c => c.complete !== false)
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
}

// Position size factor: day-of-week + session quality
function getTimeBasedSizeFactor() {
  const now = new Date();
  const day = now.getUTCDay(), h = now.getUTCHours();
  if (day === 0 || day === 6)     return 0;    // Weekend — no trading
  if (day === 5 && h >= 20)       return 0.5;  // Friday close — gap risk
  if (day === 1 && h < 2)        return 0.5;  // Monday open — gap risk
  if (h >= 22 || h < 1)          return 0.5;  // Late NY / dead zone — thin liquidity
  if (h >= 1  && h < 6)         return 0.7;  // Asian session — lower liquidity
  if (h >= 6  && h < 7)         return 0.8;  // Pre-London — waiting for open
  return 1.0; // London + NY = full size
}

// Returns human-readable reason for any size reduction
function getSizeFactorNote(factor) {
  const now = new Date();
  const day = now.getUTCDay(), h = now.getUTCHours();
  if (factor === 0) return 'weekend';
  if (day === 5 && h >= 20) return 'Friday close';
  if (day === 1 && h < 2)  return 'Monday gap risk';
  if (h >= 22 || h < 1)   return 'thin liquidity (late NY)';
  if (h >= 1  && h < 6)   return 'Asian session';
  if (h >= 6  && h < 7)   return 'pre-London';
  return '';
}

// EMA convergence: EMA9 and EMA21 closing together = trend momentum draining
// Called before entry — flat/converging EMAs in a trend = structure about to break
function detectEMAConvergence(h4Ind) {
  const price = h4Ind.ema21 || 1;
  const separation = Math.abs(h4Ind.ema9 - h4Ind.ema21);
  const relSep = (separation / price) * 10000; // in bps

  if (relSep < 3)  return { converging: true,  severity: 'HIGH',   note: 'EMA9/21 nearly crossed — trend exhausting, avoid entry' };
  if (relSep < 8)  return { converging: true,  severity: 'MEDIUM', note: 'EMA9/21 converging — momentum draining, wait for separation' };
  return           { converging: false, severity: 'NONE',   note: null };
}

// FIX 7 — Market gap detection (candle open gaps > 2× ATR = abnormal)
function hasMarketGap(candles, atr) {
  if (candles.length < 2 || !atr) return false;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const gap  = Math.abs(parseFloat(curr.mid.o) - parseFloat(prev.mid.c));
  return gap > atr * 2.0;
}

// FIX 9 — Stale data feed tracker
let priceLastChanged = {}, pricePrevCache = {};
function isFeedStale(pair) {
  const lastChange = priceLastChanged[pair];
  if (!lastChange) return false;
  const h = new Date().getUTCHours();
  const isMarketHours = h >= 7 && h <= 20;
  return isMarketHours && (Date.now() - lastChange) > 120000; // >2min unchanged
}

// Stochastic (for overbought/oversold confirmation)
function calcStoch(candles, kPeriod = 14) {
  if (candles.length < kPeriod) return { k:50, d:50 };
  const slice = candles.slice(-kPeriod);
  const highs = slice.map(c => parseFloat(c.mid.h));
  const lows  = slice.map(c => parseFloat(c.mid.l));
  const close = parseFloat(slice[slice.length-1].mid.c);
  const hh = Math.max(...highs), ll = Math.min(...lows);
  const k  = hh===ll ? 50 : ((close-ll)/(hh-ll))*100;
  return { k: parseFloat(k.toFixed(1)), d: parseFloat(k.toFixed(1)) }; // simplified
}

// Candle pattern detection
function detectPattern(candles) {
  const last = candles.slice(-3);
  if (last.length < 2) return 'NONE';
  const prev = last[last.length-2], curr = last[last.length-1];
  const co = parseFloat(curr.mid.o), cc = parseFloat(curr.mid.c);
  const ch = parseFloat(curr.mid.h), cl = parseFloat(curr.mid.l);
  const po = parseFloat(prev.mid.o), pc = parseFloat(prev.mid.c);
  const body = Math.abs(cc-co), range = ch-cl;
  const lowerWick = Math.min(co,cc)-cl, upperWick = ch-Math.max(co,cc);

  if (lowerWick > body*2 && body < range*0.3) return cc > co ? 'BULLISH_PIN_BAR' : 'BEARISH_PIN_BAR';
  if (cc > co && pc < po && cc > po && co < pc) return 'BULLISH_ENGULFING';
  if (cc < co && pc > po && cc < po && co > pc) return 'BEARISH_ENGULFING';
  if (body < range*0.1) return 'DOJI';
  if (cc > co) return 'BULLISH_CANDLE';
  return 'BEARISH_CANDLE';
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────
function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return { upper:0, middle:0, lower:0, bw:0, pct:0.5, squeezing:false };
  const slice = closes.slice(-period);
  const sma   = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
  const upper = sma + mult * std;
  const lower = sma - mult * std;
  const bw    = sma > 0 ? (upper - lower) / sma * 100 : 0;
  const pct   = (upper - lower) > 0 ? (closes[closes.length - 1] - lower) / (upper - lower) : 0.5;
  // Compare bandwidth to 5-bar-ago bandwidth to detect squeeze
  const prevBW = closes.length >= period + 5 ? (() => {
    const ps = closes.slice(-period - 5, -5);
    const pm = ps.reduce((a, b) => a + b, 0) / period;
    const pv = Math.sqrt(ps.reduce((s, v) => s + (v - pm) ** 2, 0) / period);
    return pm > 0 ? (pm + mult * pv - (pm - mult * pv)) / pm * 100 : bw;
  })() : bw;
  return {
    upper:     parseFloat(upper.toFixed(6)),
    middle:    parseFloat(sma.toFixed(6)),
    lower:     parseFloat(lower.toFixed(6)),
    bw:        parseFloat(bw.toFixed(4)),
    pct:       parseFloat(pct.toFixed(3)),   // 0 = at lower band, 1 = at upper band
    squeezing: bw < prevBW * 0.75,           // bandwidth contracting = squeeze building
    std,
  };
}

// ── Weighted Moving Average (WMA) ─────────────────────────────────────────────
function calcWMA(values, period) {
  const slice = values.slice(-period);
  if (!slice.length) return 0;
  let num = 0, den = 0;
  for (let i = 0; i < slice.length; i++) { const w = i + 1; num += slice[i] * w; den += w; }
  return den > 0 ? num / den : 0;
}

// ── Hull Moving Average (HMA) — faster, smoother EMA ─────────────────────────
// Formula: WMA(sqrt(n)) of [ 2·WMA(n/2) − WMA(n) ]
function calcHMA(closes, period = 21) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const half  = Math.floor(period / 2);
  const sqrtp = Math.round(Math.sqrt(period));
  const rawLen = sqrtp + period;
  const src    = closes.slice(-rawLen);
  const diff   = [];
  for (let i = period - 1; i < src.length; i++) {
    const sl = src.slice(0, i + 1);
    diff.push(2 * calcWMA(sl, half) - calcWMA(sl, period));
  }
  return parseFloat(calcWMA(diff, sqrtp).toFixed(6));
}

// ── VWAP — tick-volume weighted average price ─────────────────────────────────
// OANDA provides tick volume per candle; used to approximate institutional VWAP.
function calcVWAP(candles) {
  if (!candles.length) return 0;
  let tpv = 0, vol = 0;
  for (const c of candles) {
    const tp = (parseFloat(c.mid.h) + parseFloat(c.mid.l) + parseFloat(c.mid.c)) / 3;
    const v  = c.volume || 1;
    tpv += tp * v; vol += v;
  }
  return vol > 0 ? parseFloat((tpv / vol).toFixed(6)) : 0;
}

// ── Fibonacci Retracement Levels ─────────────────────────────────────────────
// Drawn from the most recent significant swing high/low in last `lookback` candles.
// Key zones: 0.382, 0.500, 0.618 (golden), 0.786 (deep). Extensions: 1.272, 1.618.
function calcFibLevels(candles, lookback = 60) {
  if (candles.length < 10) return null;
  const slice    = candles.slice(-Math.min(lookback, candles.length));
  const highs    = slice.map(c => parseFloat(c.mid.h));
  const lows     = slice.map(c => parseFloat(c.mid.l));
  const swingHigh = Math.max(...highs);
  const swingLow  = Math.min(...lows);
  const range     = swingHigh - swingLow;
  if (range <= 0) return null;
  return {
    high:  swingHigh,
    low:   swingLow,
    range,
    // Retracement levels (drawn from high downward for BUY setups)
    f236:  parseFloat((swingHigh - range * 0.236).toFixed(6)),
    f382:  parseFloat((swingHigh - range * 0.382).toFixed(6)),
    f500:  parseFloat((swingHigh - range * 0.500).toFixed(6)),
    f618:  parseFloat((swingHigh - range * 0.618).toFixed(6)),
    f786:  parseFloat((swingHigh - range * 0.786).toFixed(6)),
    // Extension levels (drawn from low upward — TP targets)
    e127:  parseFloat((swingHigh + range * 0.272).toFixed(6)),
    e162:  parseFloat((swingHigh + range * 0.618).toFixed(6)),
  };
}

// Returns the nearest fib level to price and how close (in ATR units)
function nearestFibLevel(fib, price, atr) {
  if (!fib || !atr) return { level: null, distance: Infinity, key: null };
  const levels = [
    { key:'0.236', val: fib.f236 },
    { key:'0.382', val: fib.f382 },
    { key:'0.500', val: fib.f500 },
    { key:'0.618', val: fib.f618 },
    { key:'0.786', val: fib.f786 },
  ];
  let nearest = levels[0];
  for (const l of levels) {
    if (Math.abs(l.val - price) < Math.abs(nearest.val - price)) nearest = l;
  }
  return { level: nearest.val, key: nearest.key, distance: Math.abs(nearest.val - price) / atr };
}

// ── Classic Pivot Points (previous 6 H4 bars ≈ 24 h) ─────────────────────────
function calcPivotPoints(h4Candles) {
  if (h4Candles.length < 7) return null;
  const prev  = h4Candles.slice(-7, -1);
  const high  = Math.max(...prev.map(c => parseFloat(c.mid.h)));
  const low   = Math.min(...prev.map(c => parseFloat(c.mid.l)));
  const close = parseFloat(prev[prev.length - 1].mid.c);
  const pp    = (high + low + close) / 3;
  return { pp, r1: 2*pp - low, r2: pp + (high-low), r3: high + 2*(pp-low),
                s1: 2*pp - high, s2: pp - (high-low), s3: low - 2*(high-pp) };
}

// Build full indicator set for any timeframe
function buildIndicators(candles, refCandles = []) {
  if (!candles?.length) return null;
  const closes = candles.map(c => parseFloat(c.mid.c));
  const highs  = candles.map(c => parseFloat(c.mid.h));
  const lows   = candles.map(c => parseFloat(c.mid.l));

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes.slice(-50), 50);
  const ema200= calcEMA(closes, Math.min(200, closes.length));
  const rsi14 = calcRSI(closes, 14);
  const atr14 = calcATR(candles, 14);
  const macd  = calcMACD(closes);
  const adx   = calcADX(candles, 14);
  const stoch = calcStoch(candles, 14);

  const recentHighs = highs.slice(-20);
  const recentLows  = lows.slice(-20);
  const resistance  = Math.max(...recentHighs);
  const support     = Math.min(...recentLows);

  // Strong S/R (50-candle lookback)
  const strongHighs = highs.slice(-50);
  const strongLows  = lows.slice(-50);
  const strongResist = Math.max(...strongHighs);
  const strongSupport= Math.min(...strongLows);

  const currentClose = closes[closes.length-1];
  const prevClose    = closes[closes.length-2] || currentClose;
  const momentum     = ((currentClose - prevClose) / prevClose) * 100;

  const trend = currentClose > ema21 ? 'BULLISH' : 'BEARISH';
  const emaAlignment =
    (ema9>ema21 && ema21>ema50) ? 'BULLISH' :
    (ema9<ema21 && ema21<ema50) ? 'BEARISH' : 'MIXED';

  // Reference timeframe trend (e.g. H4 context for H1)
  let refTrend = 'UNKNOWN', refEma = 0;
  if (refCandles?.length > 2) {
    const rc = refCandles.map(c => parseFloat(c.mid.c));
    refEma  = calcEMA(rc, 21);
    refTrend= rc[rc.length-1] > refEma ? 'BULLISH' : 'BEARISH';
  }

  const last5 = candles.slice(-5).map(c => ({
    open:  parseFloat(c.mid.o).toFixed(5),
    high:  parseFloat(c.mid.h).toFixed(5),
    low:   parseFloat(c.mid.l).toFixed(5),
    close: parseFloat(c.mid.c).toFixed(5),
    bull:  parseFloat(c.mid.c) >= parseFloat(c.mid.o),
  }));

  const pattern = detectPattern(candles);

  // Advanced indicators
  const bb      = calcBB(closes, 20);
  const hma     = calcHMA(closes, 21);
  const vwap    = calcVWAP(candles);
  const fib     = calcFibLevels(candles, 60);

  // FIX 6 — EMA slope: how steeply EMA21 is moving (flat = fake trend)
  const ema21Prev = closes.length >= 26
    ? calcEMA(closes.slice(0, -5), 21) : ema21;
  const emaSlope = closes.length > 0
    ? (ema21 - ema21Prev) / closes[closes.length - 1] * 10000 : 0; // bps/bar

  // MACD histogram slope (momentum weakening detection)
  const macdPrev = closes.length >= 31
    ? parseFloat((calcEMA(closes.slice(0,-3),12) - calcEMA(closes.slice(0,-3),26)).toFixed(6)) : macd;
  const macdSlope = macd - macdPrev;

  return {
    ema9, ema21, ema50, ema200, rsi14, atr14, macd, adx, stoch,
    resistance, support, strongResist, strongSupport,
    trend, emaAlignment, refTrend, last5, pattern, momentum,
    emaSlope, macdSlope,
    bb, hma, vwap, fib,
    // Derived
    h4Trend: refTrend + ' (ref EMA21)',
    emaAlignmentFull: emaAlignment === 'BULLISH' ? 'BULLISH ALIGNMENT (EMA9>EMA21>EMA50)' :
                      emaAlignment === 'BEARISH' ? 'BEARISH ALIGNMENT (EMA9<EMA21<EMA50)' : 'MIXED',
  };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 1 — MARKET REGIME CLASSIFIER
// Returns regime type + tradeability flag based on ADX, EMA slope, ATR
// ═══════════════════════════════════════════════════════════════════
function classifyRegime(h4Ind, m30Ind, h4Candles = []) {
  const adx      = h4Ind.adx;
  const emaSlope = Math.abs(h4Ind.emaSlope || 0);
  const macdSlope= h4Ind.macdSlope || 0;
  const rsi      = m30Ind.rsi14;

  // ATR expansion ratio: is volatility currently expanding vs recent history?
  let atrRatio = 1;
  if (h4Candles.length >= 35) {
    const recentATR  = calcATR(h4Candles.slice(-14), 14);
    const historicATR= calcATR(h4Candles.slice(-35, -14), 14);
    if (historicATR > 0) atrRatio = recentATR / historicATR;
  }

  // VOLATILE_EXHAUSTION: RSI extreme + high ADX + momentum fading
  if (adx >= 25 && (rsi > 75 || rsi < 25) && macdSlope !== 0) {
    return { regime:'VOLATILE_EXHAUSTION', tradeable:false, atrRatio,
      note:'RSI exhaustion + elevated ADX — momentum reversal risk, avoid entry' };
  }

  // EXPANSION: ATR exploding > 2× historical average — news or breakout chaos
  if (atrRatio > 2.0) {
    return { regime:'EXPANSION', tradeable:false, atrRatio,
      note:`ATR ${atrRatio.toFixed(1)}× historical — volatility explosion, wait for settle` };
  }

  // DISTRIBUTION: price at highs, compression forming, momentum dying
  // Hallmarks: ADX > 20, EMA slope flattening, RSI diverging downward from overbought
  if (adx >= 20 && emaSlope < 0.8 && rsi > 65 && h4Ind.trend === 'BULLISH') {
    return { regime:'DISTRIBUTION', tradeable:false, atrRatio,
      note:'Price extended + EMA flattening at highs — distribution phase, BUY entries dangerous' };
  }

  // ACCUMULATION: price at lows, compression, RSI recovering from oversold
  if (adx >= 15 && emaSlope < 0.8 && rsi < 35 && h4Ind.trend === 'BEARISH') {
    return { regime:'ACCUMULATION', tradeable:false, atrRatio,
      note:'Price compressed at lows — accumulation phase, SELL entries dangerous' };
  }

  // TRENDING_STRONG — ideal for trend-following entries
  if (adx >= 28 && emaSlope >= 2.0) {
    return { regime:'TRENDING_STRONG', tradeable:true, atrRatio,
      note:'Strong directional momentum — ideal entry conditions' };
  }

  // TRENDING — acceptable with confirmation
  if (adx >= 20 && emaSlope >= 1.0) {
    return { regime:'TRENDING', tradeable:true, atrRatio,
      note:'Moderate trend — entry acceptable with full confirmation' };
  }

  // RANGING — very low ADX
  if (adx < 15) {
    return { regime:'RANGING', tradeable:false, atrRatio,
      note:'Price ranging without direction — false signals likely' };
  }

  // CHOPPY — ADX low + flat EMA
  if (adx < 20 && emaSlope < 1.0) {
    return { regime:'CHOPPY', tradeable:false, atrRatio,
      note:'Flat EMA + weak ADX — trend-following systems fail here' };
  }

  return { regime:'MIXED', tradeable:true, atrRatio,
    note:'Mixed conditions — proceed with extra caution' };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 1 — CANDLE QUALITY INSPECTOR
// Rejects: manipulation spikes, doji exhaustion, abnormal wicks
// ═══════════════════════════════════════════════════════════════════
function inspectCandleQuality(candles, atr) {
  if (!candles || candles.length < 3 || !atr) return { ok:true, issues:[] };
  const issues = [];

  // Check last 3 candles for abnormal expansion
  const last3 = candles.slice(-3);
  let expandCount = 0;
  for (const c of last3) {
    const range = parseFloat(c.mid.h) - parseFloat(c.mid.l);
    if (range > atr * 2.5) expandCount++;
  }
  if (expandCount >= 2) issues.push('Candle expansion: 2+ candles exceed 2.5×ATR (spike/news residue)');

  // Check last candle wick dominance
  const last  = last3[last3.length - 1];
  const co    = parseFloat(last.mid.o), cc = parseFloat(last.mid.c);
  const ch    = parseFloat(last.mid.h), cl = parseFloat(last.mid.l);
  const body  = Math.abs(cc - co);
  const range = ch - cl;
  if (range > 0 && body / range < 0.15) {
    issues.push('Doji/spinning top: body < 15% of range — strong indecision');
  }

  // Check for exhaustion wick (wick > 3× body)
  const upperWick = ch - Math.max(co, cc);
  const lowerWick = Math.min(co, cc) - cl;
  if (body > 0 && (upperWick > body * 3 || lowerWick > body * 3)) {
    issues.push('Exhaustion wick: wick > 3× body — possible rejection or trap');
  }

  // Average body check: current body vs 20-candle average
  // A body 3× the average is an exhaustion candle — usually means a news spike or end of move
  if (candles.length >= 20) {
    const bodies = candles.slice(-20).map(c =>
      Math.abs(parseFloat(c.mid.c) - parseFloat(c.mid.o))
    );
    const avgBody = bodies.reduce((s, b) => s + b, 0) / bodies.length;
    if (avgBody > 0 && body > avgBody * 3) {
      issues.push(`Exhaustion body: current body ${(body/avgBody).toFixed(1)}× average — likely news spike or climax`);
    }
    // Three consecutive expanding bodies = trend may be exhausting
    if (candles.length >= 5) {
      const last3Bodies = candles.slice(-3).map(c =>
        Math.abs(parseFloat(c.mid.c) - parseFloat(c.mid.o))
      );
      const allExpanding = last3Bodies[2] > last3Bodies[1] && last3Bodies[1] > last3Bodies[0];
      if (allExpanding && last3Bodies[2] > avgBody * 2) {
        issues.push('Climax sequence: 3 consecutive expanding bodies above average — exhaustion risk');
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 2 — RSI DIVERGENCE DETECTOR
// Bullish div: price lower low + RSI higher low (hidden strength)
// Bearish div: price higher high + RSI lower high (hidden weakness)
// ═══════════════════════════════════════════════════════════════════
function detectRSIDivergence(candles, direction) {
  if (candles.length < 20) return 'NONE';
  const recent = candles.slice(-20);
  const closes = recent.map(c => parseFloat(c.mid.c));
  const highs  = recent.map(c => parseFloat(c.mid.h));
  const lows   = recent.map(c => parseFloat(c.mid.l));

  const quickRSI = (arr) => {
    if (arr.length < 15) return 50;
    let g = 0, l = 0;
    for (let i = arr.length - 14; i < arr.length; i++) {
      const d = arr[i] - arr[i-1];
      if (d > 0) g += d; else l += Math.abs(d);
    }
    const ag = g / 14, al = l / 14;
    return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag/al)).toFixed(1));
  };

  const rsiNow  = quickRSI(closes);
  const rsiPrev = quickRSI(closes.slice(0, -5));

  if (direction === 'BUY') {
    const lowNow  = Math.min(...lows.slice(-5));
    const lowPrev = Math.min(...lows.slice(-15, -5));
    if (lowNow < lowPrev && rsiNow > rsiPrev + 4) return 'BULLISH_DIVERGENCE';  // positive — price weak, RSI strong
    if (lowNow > lowPrev && rsiNow > rsiPrev + 2) return 'BULLISH_HIDDEN_DIV';  // trend continuation
  } else {
    const highNow  = Math.max(...highs.slice(-5));
    const highPrev = Math.max(...highs.slice(-15, -5));
    if (highNow > highPrev && rsiNow < rsiPrev - 4) return 'BEARISH_DIVERGENCE'; // positive — price strong, RSI weak
    if (highNow < highPrev && rsiNow < rsiPrev - 2) return 'BEARISH_HIDDEN_DIV'; // trend continuation
  }
  return 'NONE';
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 2 — COMPRESSION DETECTOR (volatility squeeze → expansion)
// Institutional systems love entering AFTER a compression period
// ═══════════════════════════════════════════════════════════════════
function detectCompression(candles) {
  if (candles.length < 30) return { compressing:false, ratio:1 };
  const recentATR   = calcATR(candles.slice(-8),  8);
  const historicATR = calcATR(candles.slice(-28, -8), 14);
  if (!historicATR || !recentATR) return { compressing:false, ratio:1 };
  const ratio = recentATR / historicATR;
  return {
    compressing: ratio < 0.70,
    ratio:       parseFloat(ratio.toFixed(2)),
    note:        ratio < 0.70 ? 'Volatility squeeze active — breakout imminent' : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 2 — MACD MOMENTUM WEAKENING DETECTOR
// Detects when price continues but momentum fades (fake breakout)
// ═══════════════════════════════════════════════════════════════════
function detectMomentumWeakening(h4Ind, m30Ind) {
  const issues = [];
  // H4 MACD slope decreasing despite trend
  if (h4Ind.macdSlope < -0.000005 && h4Ind.trend === 'BULLISH') {
    issues.push('H4 MACD histogram declining while price bullish — momentum fade');
  }
  if (h4Ind.macdSlope > 0.000005 && h4Ind.trend === 'BEARISH') {
    issues.push('H4 MACD histogram rising while price bearish — momentum fade');
  }
  // M30 RSI diverging from H4 direction
  if (h4Ind.trend === 'BULLISH' && m30Ind.rsi14 > 70) {
    issues.push('M30 RSI overbought while H4 bullish — exhaustion risk');
  }
  if (h4Ind.trend === 'BEARISH' && m30Ind.rsi14 < 30) {
    issues.push('M30 RSI oversold while H4 bearish — exhaustion risk');
  }
  return { weakening: issues.length > 0, issues };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 2 — LIQUIDITY INTELLIGENCE
// Identifies likely stop cluster zones and sweep probability
// ═══════════════════════════════════════════════════════════════════
function analyzeLiquidity(h4Ind, price, direction, atr) {
  const pip = atr > 1 ? 0.1 : 0.0001; // XAU vs forex
  const resistGap  = ((h4Ind.strongResist - price) / price) * 100;
  const supportGap = ((price - h4Ind.strongSupport) / price) * 100;
  const nearSupport = price - h4Ind.strongSupport < atr * 1.5;
  const nearResist  = h4Ind.strongResist - price < atr * 1.5;

  let sweepRisk = 'LOW';
  let note = '';

  if (direction === 'BUY') {
    if (nearSupport) {
      sweepRisk = 'HIGH';
      note = 'Price near strong support — BUY stops cluster just below, sweep likely before move up';
    } else if (resistGap < 0.3) {
      sweepRisk = 'HIGH';
      note = 'Strong resistance directly above — liquidity void, not a high-probability entry';
    } else {
      note = `Support ${supportGap.toFixed(2)}% away, resistance ${resistGap.toFixed(2)}% away — clear path`;
    }
  } else {
    if (nearResist) {
      sweepRisk = 'HIGH';
      note = 'Price near strong resistance — SELL stops cluster just above, sweep likely before move down';
    } else if (supportGap < 0.3) {
      sweepRisk = 'HIGH';
      note = 'Strong support directly below — liquidity void, not a high-probability entry';
    } else {
      note = `Resistance ${resistGap.toFixed(2)}% away, support ${supportGap.toFixed(2)}% away — clear path`;
    }
  }

  return {
    sweep_risk:    sweepRisk,
    support_gap:   supportGap.toFixed(2) + '%',
    resist_gap:    resistGap.toFixed(2) + '%',
    stop_pool:     direction === 'BUY' ? 'BELOW_SUPPORT' : 'ABOVE_RESISTANCE',
    target_pool:   direction === 'BUY' ? 'ABOVE_RESISTANCE' : 'BELOW_SUPPORT',
    note,
    favorable:     sweepRisk === 'LOW',
  };
}

// ═══════════════════════════════════════════════════════════════════
// MARKET STRUCTURE ENGINE
// Swing Highs/Lows → BOS → CHOCH → Liquidity Zones
// ═══════════════════════════════════════════════════════════════════

// Find significant swing highs and lows in candle data
function detectSwings(candles, lookback = 3) {
  const highs = [], lows = [];
  const len = candles.length;
  if (len < lookback * 2 + 1) return { highs, lows };

  for (let i = lookback; i < len - lookback; i++) {
    const currH = parseFloat(candles[i].mid.h);
    const currL = parseFloat(candles[i].mid.l);

    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (parseFloat(candles[j].mid.h) >= currH) isHigh = false;
      if (parseFloat(candles[j].mid.l) <= currL)  isLow  = false;
    }
    if (isHigh) highs.push({ idx: i, price: currH });
    if (isLow)  lows.push({ idx: i, price: currL });
  }
  return { highs, lows };
}

// BOS = Break of Structure (continuation signal)
// CHOCH = Change of Character (reversal warning)
function detectMarketStructure(candles, direction) {
  if (candles.length < 30) return { bos:'NONE', choch:'NONE', structureBias:'NEUTRAL', swingHigh:null, swingLow:null };

  const slice = candles.slice(-60);
  const { highs, lows } = detectSwings(slice, 3);
  const price = parseFloat(candles[candles.length - 1].mid.c);

  const lastHigh = highs[highs.length - 1] || null;
  const prevHigh = highs[highs.length - 2] || null;
  const lastLow  = lows[lows.length  - 1] || null;
  const prevLow  = lows[lows.length  - 2] || null;

  let bos = 'NONE', choch = 'NONE';

  // Structure bias: higher highs + higher lows = bullish structure
  const higherHighs = lastHigh && prevHigh && lastHigh.price > prevHigh.price;
  const higherLows  = lastLow  && prevLow  && lastLow.price  > prevLow.price;
  const lowerHighs  = lastHigh && prevHigh && lastHigh.price < prevHigh.price;
  const lowerLows   = lastLow  && prevLow  && lastLow.price  < prevLow.price;
  const structureBias =
    (higherHighs && higherLows) ? 'BULLISH' :
    (lowerHighs  && lowerLows)  ? 'BEARISH' : 'NEUTRAL';

  if (direction === 'BUY') {
    // BOS bullish: price breaks above the last swing high (structure continuation)
    if (lastHigh && price > lastHigh.price) bos = 'BULLISH';
    // CHOCH: market was bullish but last low broke below previous low (structure flip)
    if (lastLow && prevLow && lastLow.price < prevLow.price) choch = 'BEARISH';
  } else {
    // BOS bearish: price breaks below the last swing low
    if (lastLow && price < lastLow.price) bos = 'BEARISH';
    // CHOCH: market was bearish but last high broke above previous high
    if (lastHigh && prevHigh && lastHigh.price > prevHigh.price) choch = 'BULLISH';
  }

  return {
    bos,
    choch,
    structureBias,
    swingHigh: lastHigh?.price || null,
    swingLow:  lastLow?.price  || null,
    prevSwingHigh: prevHigh?.price || null,
    prevSwingLow:  prevLow?.price  || null,
    higherHighs, higherLows, lowerHighs, lowerLows,
  };
}

// Liquidity zones: stop clusters above swing highs (buy-side) and below swing lows (sell-side)
// These are where institutional orders hunt before reversing
function detectLiquidityZones(candles, atr) {
  if (candles.length < 20 || !atr) return { buySide:[], sellSide:[], nearBuySide:false, nearSellSide:false };

  const slice = candles.slice(-100);
  const { highs, lows } = detectSwings(slice, 3);
  const price     = parseFloat(candles[candles.length - 1].mid.c);
  const threshold = atr * 0.8; // "near" = within 0.8 ATR

  const buySide  = highs.filter(h => h.price > price).map(h => h.price).sort((a,b) => a - b).slice(0, 3);
  const sellSide = lows.filter(l => l.price < price).map(l => l.price).sort((a,b) => b - a).slice(0, 3);

  return {
    buySide,
    sellSide,
    nearestBuySide:  buySide[0]  || null,
    nearestSellSide: sellSide[0] || null,
    nearBuySide:  buySide[0]  != null && (buySide[0]  - price) < threshold,
    nearSellSide: sellSide[0] != null && (price - sellSide[0]) < threshold,
  };
}

// Structure confidence adjustment — called after calcTradeSetup
// Returns a delta to add/subtract from confidence
function scoreMarketStructure(structure, direction, liquidity) {
  let delta = 0;
  const isBuy = direction === 'BUY';

  // BOS confirmed in trade direction = strong continuation signal
  if (structure.bos === (isBuy ? 'BULLISH' : 'BEARISH')) delta += 8;

  // CHOCH against trade direction = structure is flipping — dangerous
  if (structure.choch !== 'NONE' && structure.choch !== (isBuy ? 'BULLISH' : 'BEARISH')) delta -= 15;

  // Structure bias agrees with trade = extra confidence
  if (structure.structureBias === (isBuy ? 'BULLISH' : 'BEARISH')) delta += 5;

  // Opposing structure bias = penalty
  if (structure.structureBias !== 'NEUTRAL' &&
      structure.structureBias !== (isBuy ? 'BULLISH' : 'BEARISH')) delta -= 8;

  // Near buy-side liquidity on a BUY = smart money may sweep before reversal
  if (isBuy  && liquidity.nearBuySide)  delta -= 6;
  // Near sell-side liquidity on a SELL = sweep risk
  if (!isBuy && liquidity.nearSellSide) delta -= 6;

  return delta;
}

// ═══════════════════════════════════════════════════════════════════
// ICT SMART MONEY CONCEPTS
// Fair Value Gaps, Order Blocks, Turtle Soup, AMD Power of 3
// ═══════════════════════════════════════════════════════════════════

// ── FAIR VALUE GAP (FVG) ─────────────────────────────────────────────────────
// 3-candle imbalance: gap between candle[i-2] extremity and candle[i] extremity.
// Bullish FVG: candle[i].low  > candle[i-2].high  (unfilled gap above price action)
// Bearish FVG: candle[i].high < candle[i-2].low   (unfilled gap below price action)
function detectFVG(candles, direction) {
  if (candles.length < 3) return { found:false, zones:[], nearest:null, testing:false, count:0 };
  const slice = candles.slice(-40);
  const price = parseFloat(candles[candles.length - 1].mid.c);
  const zones = [];

  for (let i = 2; i < slice.length; i++) {
    const h0 = parseFloat(slice[i-2].mid.h), l0 = parseFloat(slice[i-2].mid.l);
    const h2 = parseFloat(slice[i].mid.h),   l2 = parseFloat(slice[i].mid.l);
    if (direction === 'BUY'  && l2 > h0) zones.push({ type:'BULL_FVG', top:l2, bottom:h0, size:l2-h0 });
    if (direction === 'SELL' && h2 < l0) zones.push({ type:'BEAR_FVG', top:l0, bottom:h2, size:l0-h2 });
  }

  // Is price currently inside a FVG (testing imbalance)?
  const testing = zones.some(z => price >= z.bottom * 0.9998 && price <= z.top * 1.0002);
  const nearest = zones[zones.length - 1] || null;
  return { found:zones.length > 0, zones:zones.slice(-5), nearest, testing, count:zones.length };
}

// ── ORDER BLOCKS ─────────────────────────────────────────────────────────────
// Last opposing candle before a significant impulsive move.
// Bullish OB: last bearish candle before ≥2 bullish candles that break above its high
// Bearish OB: last bullish candle before ≥2 bearish candles that break below its low
function detectOrderBlocks(candles, direction, lookback = 60) {
  if (candles.length < 6) return { found:false, blocks:[], testing:false, nearest:null };
  const slice = candles.slice(-Math.min(lookback, candles.length));
  const price = parseFloat(candles[candles.length - 1].mid.c);
  const blocks = [];

  for (let i = 1; i < slice.length - 3; i++) {
    const c  = slice[i];
    const co = parseFloat(c.mid.o), cc = parseFloat(c.mid.c);
    const ch = parseFloat(c.mid.h), cl = parseFloat(c.mid.l);
    const after = slice.slice(i + 1, i + 4);

    if (direction === 'BUY' && cc < co) {
      const bullCount  = after.filter(ac => parseFloat(ac.mid.c) > parseFloat(ac.mid.o)).length;
      const breakHigh  = after.some(ac => parseFloat(ac.mid.h) > ch);
      if (bullCount >= 2 && breakHigh) blocks.push({ type:'BULL_OB', top:ch, bottom:cl, mid:(ch+cl)/2 });
    }
    if (direction === 'SELL' && cc > co) {
      const bearCount  = after.filter(ac => parseFloat(ac.mid.c) < parseFloat(ac.mid.o)).length;
      const breakLow   = after.some(ac => parseFloat(ac.mid.l) < cl);
      if (bearCount >= 2 && breakLow) blocks.push({ type:'BEAR_OB', top:ch, bottom:cl, mid:(ch+cl)/2 });
    }
  }

  // Price testing the order block zone?
  const testing = blocks.some(b => price >= b.bottom * 0.9998 && price <= b.top * 1.0002);
  const nearest = blocks[blocks.length - 1] || null;
  return { found:blocks.length > 0, blocks:blocks.slice(-3), testing, nearest };
}

// ── ICT TURTLE SOUP — stop hunt reversal ──────────────────────────────────────
// Price sweeps a previous N-bar extreme then immediately recovers — classic stop hunt.
// Bullish: sweeps below 20-bar low → closes back above → BUY confluence
// Bearish: sweeps above 20-bar high → closes back below → SELL confluence
function detectTurtleSoup(candles, direction, lookback = 20) {
  if (candles.length < lookback + 3) return { found:false, signal:null };
  const hist  = candles.slice(-(lookback + 3));
  const prior = hist.slice(0, lookback);
  const last3 = hist.slice(-3);
  const dp    = 5;

  if (direction === 'BUY') {
    const prevLow = Math.min(...prior.map(c => parseFloat(c.mid.l)));
    if (parseFloat(last3[0].mid.l) < prevLow && parseFloat(last3[last3.length-1].mid.c) > prevLow)
      return { found:true, signal:'BULL_TURTLE_SOUP', level:prevLow,
        note:`Stop sweep below ${lookback}-bar low ${prevLow.toFixed(dp)} — reversal confirmed` };
  } else {
    const prevHigh = Math.max(...prior.map(c => parseFloat(c.mid.h)));
    if (parseFloat(last3[0].mid.h) > prevHigh && parseFloat(last3[last3.length-1].mid.c) < prevHigh)
      return { found:true, signal:'BEAR_TURTLE_SOUP', level:prevHigh,
        note:`Stop sweep above ${lookback}-bar high ${prevHigh.toFixed(dp)} — reversal confirmed` };
  }
  return { found:false, signal:null };
}

// ── AMD / POWER OF 3 — session cycle phase ───────────────────────────────────
// Accumulation (Asia 00-07): price builds range, institutions load positions
// Manipulation (Early London 07-09 / NY open 12-14): false break, stops swept
// Distribution (London body 09-12 / NY body 14-17): real directional move
function detectAMDPhase() {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 7)  return { phase:'ACCUMULATION',    tradeable:false, note:'Asian range building — wait for sweep' };
  if (h >= 7  && h < 9)  return { phase:'MANIPULATION',    tradeable:false, note:'Early London — watch for false break / stop sweep' };
  if (h >= 9  && h < 12) return { phase:'DISTRIBUTION',    tradeable:true,  note:'London distribution — directional move underway' };
  if (h >= 12 && h < 14) return { phase:'MANIPULATION_NY', tradeable:false, note:'NY open re-sweep — wait for direction to confirm' };
  if (h >= 14 && h < 17) return { phase:'DISTRIBUTION_NY', tradeable:true,  note:'NY distribution — carry London direction or reversal' };
  return                  { phase:'DEAD_ZONE',             tradeable:false, note:'Off-hours — no institutional activity expected' };
}

// ── SUPPLY & DEMAND ZONES ─────────────────────────────────────────────────────
// Demand zone: base (tight consolidation) → strong bullish impulse upward
// Supply zone: base (tight consolidation) → strong bearish impulse downward
// Fresh = price has never returned to the zone since it formed (highest probability)
// Tested = zone has been visited once (still valid, but weaker)
function detectSupplyDemandZones(candles, direction) {
  if (candles.length < 10) return { zones:[], freshZones:[], nearFresh:false, nearest:null, freshCount:0 };
  const slice = candles.slice(-100);
  const price = parseFloat(candles[candles.length - 1].mid.c);
  const atr   = calcATR(candles.slice(-14), 14) || 0.001;
  const zones = [];

  for (let i = 2; i < slice.length - 1; i++) {
    const impulse  = slice[i];
    const iOpen    = parseFloat(impulse.mid.o), iClose = parseFloat(impulse.mid.c);
    const iHigh    = parseFloat(impulse.mid.h), iLow   = parseFloat(impulse.mid.l);
    const iRange   = iHigh - iLow;
    const isBull   = iClose > iOpen;
    const isBear   = iClose < iOpen;

    // Impulse must be large (>1.5× ATR) and directional (body > 60% of range)
    if (iRange < atr * 1.5) continue;
    if (Math.abs(iClose - iOpen) < iRange * 0.55) continue;

    // Base: 1-2 candles immediately before the impulse (tight consolidation)
    const base = slice.slice(Math.max(0, i - 2), i);
    const baseHigh   = Math.max(...base.map(c => parseFloat(c.mid.h)));
    const baseLow    = Math.min(...base.map(c => parseFloat(c.mid.l)));
    const baseRange  = baseHigh - baseLow;

    // Base must be tighter than the impulse (consolidation, not another impulse)
    if (baseRange > iRange * 0.85) continue;

    // Check if price returned to zone after formation (tested or fresh)
    const futureSlice  = slice.slice(i + 1);
    const wasTested    = futureSlice.some(c =>
      parseFloat(c.mid.l) <= baseHigh * 1.0002 && parseFloat(c.mid.h) >= baseLow * 0.9998
    );

    if (direction === 'BUY' && isBull) {
      zones.push({ type:'DEMAND', top:baseHigh, bottom:baseLow, mid:(baseHigh+baseLow)/2,
        impulseSize: parseFloat((iRange / atr).toFixed(1)), fresh:!wasTested });
    }
    if (direction === 'SELL' && isBear) {
      zones.push({ type:'SUPPLY', top:baseHigh, bottom:baseLow, mid:(baseHigh+baseLow)/2,
        impulseSize: parseFloat((iRange / atr).toFixed(1)), fresh:!wasTested });
    }
  }

  const freshZones = zones.filter(z => z.fresh);
  // Price near or inside a fresh zone (within 1.2 ATR)?
  const nearFresh  = freshZones.some(z =>
    price >= z.bottom - atr * 1.2 && price <= z.top + atr * 1.2
  );
  const nearest    = freshZones[freshZones.length - 1] || zones[zones.length - 1] || null;

  return { zones: zones.slice(-6), freshZones: freshZones.slice(-3), nearFresh, nearest, freshCount: freshZones.length };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 4 — PORTFOLIO HEAT CALCULATOR
// getPortfolioHeat() defined after CORR_WEIGHTS (further down)

// ═══════════════════════════════════════════════════════════════════
// STAGE 5 — CONFIDENCE DRIFT MONITOR
// Detects AI/calc engine confidence inflation over time
// ═══════════════════════════════════════════════════════════════════
function checkConfidenceDrift() {
  const recent = db.prepare(`
    SELECT confidence FROM signals WHERE created_at >= datetime('now','-7 days') ORDER BY created_at DESC LIMIT 20
  `).all();
  const allTime = db.prepare(`SELECT AVG(confidence) as avg, COUNT(*) as cnt FROM signals`).get();
  if (recent.length < 5 || !allTime?.cnt || allTime.cnt < 10) return { drift:false, recent_avg:null };

  const recentAvg = recent.reduce((s, r) => s + r.confidence, 0) / recent.length;
  const allAvg    = parseFloat(allTime.avg);
  const drift     = recentAvg > allAvg + 12; // >12 point inflation = drift

  return {
    drift,
    recent_avg:    parseFloat(recentAvg.toFixed(1)),
    all_time_avg:  parseFloat(allAvg.toFixed(1)),
    gap:           parseFloat((recentAvg - allAvg).toFixed(1)),
    warning:       drift ? `Confidence inflation: recent avg ${recentAvg.toFixed(0)}% vs historical ${allAvg.toFixed(0)}%` : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 5 — SIGNAL FREQUENCY ANOMALY DETECTOR
// Detects sudden spike in signal count (system behaving oddly)
// ═══════════════════════════════════════════════════════════════════
function checkSignalFrequencyAnomaly() {
  const today = _stmtTodaySent.get().c;
  const week  = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as c FROM signals
    WHERE created_at >= date('now','-7 days') GROUP BY date(created_at)
  `).all();
  if (week.length < 3) return { anomaly:false, today, avg_per_day:null };

  const avg     = week.reduce((s, r) => s + r.c, 0) / week.length;
  const anomaly = avg > 0 && today > avg * 4;
  return {
    anomaly,
    today,
    avg_per_day: parseFloat(avg.toFixed(1)),
    warning:     anomaly ? `Signal frequency spike: ${today} today vs avg ${avg.toFixed(1)}/day` : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 4 — DRAWDOWN VELOCITY MONITOR
// Detects rapidly accelerating drawdown (system degradation signal)
// ═══════════════════════════════════════════════════════════════════
function checkDrawdownVelocity() {
  const recent = db.prepare(`
    SELECT realized_pl FROM signals WHERE status='CLOSED'
    AND closed_at >= datetime('now','-72 hours') ORDER BY closed_at ASC
  `).all();
  if (recent.length < 2) return { velocity:'NORMAL', daily_rate:0 };

  const totalLoss = recent.filter(t => t.realized_pl < 0).reduce((s, t) => s + t.realized_pl, 0);
  const dailyRate = Math.abs(totalLoss) / 3;
  const velocity  = dailyRate > 50 ? 'RAPID' : dailyRate > 20 ? 'ELEVATED' : 'NORMAL';

  return {
    velocity,
    daily_rate:    parseFloat(dailyRate.toFixed(2)),
    total_loss_3d: parseFloat(Math.abs(totalLoss).toFixed(2)),
    warning:       velocity !== 'NORMAL' ? `DD velocity ${velocity}: losing ~${dailyRate.toFixed(0)}/day over last 3 days` : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// QUANTITATIVE LEARNING ENGINE
//
// Design principle: learn statistically, not emotionally.
// A single losing trade proves nothing. 30+ trades on a condition
// begins to reveal real edge (or lack of it).
//
// Thresholds (conservative — avoids false conclusions):
//   MIN_LEARN  = 20  — minimum trades before applying score adjustment
//   MIN_LESSON = 10  — minimum trades before flagging a pattern
//   ANALYSIS   = 25  — run full pattern analysis every N closed trades
// ═══════════════════════════════════════════════════════════════════

const LEARN_MIN_ADJUST  = 20;  // trades needed before changing future scoring
const LEARN_MIN_LESSON  = 10;  // trades needed before generating a lesson
const LEARN_ANALYSIS_N  = 25;  // run full analysis every N closed trades

function _upsertConditionStat(condition, isWin, pl) {
  try {
    const existing = db.prepare('SELECT * FROM condition_stats WHERE condition=?').get(condition);
    if (existing) {
      const t = existing.trades + 1;
      const w = existing.wins    + (isWin ? 1 : 0);
      const l = existing.losses  + (isWin ? 0 : 1);
      db.prepare(`UPDATE condition_stats SET trades=?,wins=?,losses=?,win_rate=?,total_pl=?,updated_at=CURRENT_TIMESTAMP WHERE condition=?`)
        .run(t, w, l, parseFloat((w/t*100).toFixed(1)), parseFloat((existing.total_pl+(pl||0)).toFixed(2)), condition);
    } else {
      db.prepare(`INSERT INTO condition_stats (condition,trades,wins,losses,win_rate,total_pl) VALUES (?,1,?,?,?,?)`)
        .run(condition, isWin?1:0, isWin?0:1, isWin?100:0, pl||0);
    }
  } catch(e) { console.error('[LEARN]', e.message); }
}

function _getConditionStat(condition) {
  return db.prepare('SELECT * FROM condition_stats WHERE condition=?').get(condition) ||
         { condition, trades:0, wins:0, losses:0, win_rate:50, total_pl:0 };
}

// ── LOSS ATTRIBUTION ─────────────────────────────────────────────────
// Classify WHY a trade likely lost based on its entry conditions.
// This is not blame — it is categorisation for pattern detection.
// Each reason is a hypothesis. It becomes a fact only after 20+ samples.
function classifyLossReasons(attr, realizedPL, exitReason) {
  const reasons = [];
  if (!attr) return reasons;

  // Execution / timing reasons
  if (exitReason === 'SL_HIT') {
    if (attr.spread_pips > 2.0)  reasons.push({ code:'SPREAD_HIGH',    note:`Spread was ${attr.spread_pips} pips — high spread eats into edge before trade moves` });
    if (attr.atr_pips && attr.spread_pips / attr.atr_pips > 0.15)
                                  reasons.push({ code:'SPREAD_VS_ATR',  note:`Spread was ${(attr.spread_pips/attr.atr_pips*100).toFixed(0)}% of ATR — cost too large relative to volatility` });
  }

  // Market condition reasons
  if (attr.adx < 20)            reasons.push({ code:'ADX_WEAK',       note:`ADX was ${attr.adx} at entry — market was not strongly trending (< 20)` });
  if (attr.regime === 'TRENDING' && attr.adx < 22)
                                  reasons.push({ code:'WEAK_TREND',     note:`Regime TRENDING but ADX marginal (${attr.adx}) — borderline trending conditions` });
  if (attr.rsi_m30 > 70)        reasons.push({ code:'RSI_OVERBOUGHT', note:`RSI M30 was ${attr.rsi_m30} at BUY entry — overbought zone, mean reversion risk` });
  if (attr.rsi_m30 < 30)        reasons.push({ code:'RSI_OVERSOLD',   note:`RSI M30 was ${attr.rsi_m30} at SELL entry — oversold zone, bounce risk` });

  // Structure reasons
  if (attr.sweep_risk === 'HIGH') reasons.push({ code:'SWEEP_RISK',    note:`Entry was near liquidity zone — price likely swept stops before reversing` });
  if (attr.bos === 'NONE')       reasons.push({ code:'NO_BOS',        note:`No Break of Structure confirmed — entry lacked structural confirmation` });
  if (attr.structure_bias !== 'NEUTRAL' &&
      attr.structure_bias !== (attr.direction === 'BUY' ? 'BULLISH' : 'BEARISH'))
                                  reasons.push({ code:'STRUCTURE_BIAS', note:`Market structure bias was ${attr.structure_bias} — against trade direction` });

  // Timing / session reasons
  if (attr.session === 'OFF_HOURS') reasons.push({ code:'OFF_HOURS',   note:`Trade entered during off-hours — lower liquidity, wider spreads, weaker moves` });
  if (attr.session === 'ASIAN')   reasons.push({ code:'ASIAN_SESSION', note:`Asian session entry — historically lower directional follow-through` });

  // Confidence / score reasons
  if (attr.score === 9)          reasons.push({ code:'MIN_SCORE',     note:`Score was exactly 9/12 — minimum threshold, lowest-confidence entry band` });
  if (attr.confidence < 80)      reasons.push({ code:'LOW_CONF',      note:`Confidence was ${attr.confidence}% — below 80% threshold, weaker setup` });

  // W1 alignment
  if (attr.w1_trend && attr.w1_trend !== 'UNKNOWN' &&
      attr.w1_trend !== (attr.direction === 'BUY' ? 'BULLISH' : 'BEARISH'))
                                  reasons.push({ code:'HTF_MISALIGNED', note:`W1 trend was ${attr.w1_trend} — trade was partially against higher timeframe` });

  return reasons;
}

// ── POST-TRADE MESSAGE ───────────────────────────────────────────────
// Called after every closed trade. Records conditions, generates attribution.
// Only draws pattern conclusions from statistically sufficient samples.
async function generateTradeLessons(sig, outcome, realizedPL, exitReason) {
  try {
    const isWin = outcome === 'WIN';
    const attr  = db.prepare('SELECT * FROM trade_attribution WHERE signal_id=?').get(sig.id);

    // Update condition stats regardless of whether attr exists (use signal data)
    const attrForStats = attr || {
      session: 'UNKNOWN', regime: 'UNKNOWN', pair: sig.pair,
      direction: sig.direction, score: 0, bos: 'NONE',
      sweep_risk: 'LOW', w1_trend: 'UNKNOWN', structure_bias: 'NEUTRAL',
    };
    const conditions = [
      `session:${attrForStats.session}:${attrForStats.direction}`,
      `regime:${attrForStats.regime}`,
      `pair:${attrForStats.pair}:${attrForStats.direction}`,
      `score:${attrForStats.score}`,
      `bos:${attrForStats.bos}`,
      `sweep_risk:${attrForStats.sweep_risk}`,
      `w1_trend:${attrForStats.w1_trend}:${attrForStats.direction}`,
      `structure:${attrForStats.structure_bias}:${attrForStats.direction}`,
    ];
    if (attr?.rsi_divergence && attr.rsi_divergence !== 'NONE') {
      conditions.push(`rsi_div:${attr.rsi_divergence}`);
    }
    // ADX band — this is the most important single predictor
    if (attr?.adx != null) {
      const adxBand = attr.adx < 18 ? 'adx:<18' : attr.adx < 22 ? 'adx:18-22' :
                      attr.adx < 26 ? 'adx:22-26' : attr.adx < 30 ? 'adx:26-30' : 'adx:30+';
      conditions.push(adxBand);
    }
    // Spread band
    if (attr?.spread_pips != null) {
      const spBand = attr.spread_pips < 1 ? 'spread:<1' : attr.spread_pips < 2 ? 'spread:1-2' : 'spread:2+';
      conditions.push(spBand);
    }
    // Confidence band
    if (attr?.confidence != null) {
      const confBand = attr.confidence < 80 ? 'conf:<80' : attr.confidence < 88 ? 'conf:80-88' : 'conf:88+';
      conditions.push(confBand);
    }
    conditions.forEach(c => _upsertConditionStat(c, isWin, realizedPL));

    // ── Loss attribution (categorise, don't blame) ────────────────────
    const lossReasons = (!isWin && attr) ? classifyLossReasons(attr, realizedPL, exitReason) : [];

    // ── Statistically-grounded lessons (LEARN_MIN_LESSON+ samples only) ─
    const lessons = [];
    for (const c of conditions) {
      const stat = _getConditionStat(c);
      if (stat.trades < LEARN_MIN_LESSON) continue;
      if (stat.win_rate < 38) {
        lessons.push({ type:'AVOID', condition: c,
          lesson: `${c}: ${stat.win_rate}% win rate over ${stat.trades} trades (${stat.wins}W/${stat.losses}L)`,
          impact: stat.win_rate < 30 ? 'HIGH' : 'MEDIUM' });
      } else if (stat.win_rate > 68) {
        lessons.push({ type:'REINFORCE', condition: c,
          lesson: `${c}: ${stat.win_rate}% win rate over ${stat.trades} trades (${stat.wins}W/${stat.losses}L)`,
          impact: 'POSITIVE' });
      }
    }
    for (const l of lessons) {
      try {
        db.prepare(`INSERT INTO trade_lessons (signal_id,pair,direction,outcome,lesson_type,condition,lesson,impact,delta) VALUES (?,?,?,?,?,?,?,?,0)`)
          .run(sig.id, sig.pair, sig.direction, outcome, l.type, l.condition, l.lesson, l.impact);
      } catch(e) {}
    }

    // ── Telegram close message ────────────────────────────────────────
    const plStr  = `${realizedPL >= 0 ? '+' : ''}$${realizedPL.toFixed(2)}`;
    const durStr = sig.duration_mins
      ? (sig.duration_mins < 60 ? `${sig.duration_mins}m` : `${(sig.duration_mins/60).toFixed(1)}h`) : '';
    const exitStr = (exitReason || '').replace(/_/g, ' ');
    const icon   = isWin ? '✅' : '❌';

    // Get MFE/MAE if tracked
    const mfe = _tradeMfeCache[sig.trade_id];
    const mae = _tradeMaeCache[sig.trade_id];

    const totalClosed = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='CLOSED'`).get().c;

    let msg =
`${icon} TRADE CLOSED — #${sig.id} ${sig.pair} ${sig.direction}
P&L: ${plStr}  |  Exit: ${exitStr}  |  Duration: ${durStr}`;

    if (mfe != null || mae != null) {
      msg += `\nMFE: ${mfe != null ? '+'+mfe.toFixed(1) : '?'} pips  |  MAE: ${mae != null ? mae.toFixed(1) : '?'} pips`;
      if (!isWin && mfe != null && mfe > 10) {
        msg += `\n⚠️ Trade reached +${mfe.toFixed(1)} pips before reversing — TP may be too conservative`;
      }
    }

    msg += `\n\n📊 ENTRY CONDITIONS RECORDED:`;
    if (attr) {
      msg += `\nSession: ${attr.session} | Regime: ${attr.regime} | ADX: ${attr.adx}`;
      msg += `\nScore: ${attr.score}/12 | Confidence: ${attr.confidence}% | Spread: ${attr.spread_pips} pips`;
      msg += `\nBOS: ${attr.bos} | W1: ${attr.w1_trend} | Structure: ${attr.structure_bias}`;
    }

    if (!isWin && lossReasons.length > 0) {
      msg += `\n\n🔍 POSSIBLE LOSS REASONS (${lossReasons.length} factor${lossReasons.length>1?'s':''}):`;
      for (const r of lossReasons.slice(0, 3)) {
        msg += `\n• ${r.note}`;
      }
      msg += `\n\n⚠️ Note: A single loss does not confirm these are problems.`;
      msg += `\nPatterns only become real after ${LEARN_MIN_LESSON}+ similar trades.`;
    }

    if (lessons.length > 0) {
      msg += `\n\n📚 STATISTICALLY CONFIRMED PATTERNS:`;
      for (const l of lessons) {
        const bullet = l.impact === 'POSITIVE' ? '✅' : l.impact === 'HIGH' ? '🔴' : '🟡';
        msg += `\n${bullet} ${l.lesson}`;
      }
    }

    // Milestones
    const milestoneMsg = {
      10: `\n\n🎯 10 trades closed — early data forming. Type REPORT for analysis.`,
      25: `\n\n🎯 25 trades closed — running full pattern analysis now...`,
      50: `\n\n🎯 50 trades closed — system has meaningful statistical data. Type REPORT.`,
      100:`\n\n🎯 100 trades — system now has institutional-level self-knowledge. Type REPORT.`,
    }[totalClosed] || '';
    msg += milestoneMsg;

    await sendTelegramMsg(msg).catch(() => {});
    console.log(`[LEARN] #${sig.id} ${outcome}: ${lossReasons.length} reasons, ${lessons.length} lessons`);

    // Clean up MFE/MAE cache for closed trade
    if (sig.trade_id) {
      delete _tradeMfeCache[sig.trade_id];
      delete _tradeMaeCache[sig.trade_id];
    }

    // Trigger pattern analysis every LEARN_ANALYSIS_N trades
    if (totalClosed > 0 && totalClosed % LEARN_ANALYSIS_N === 0) {
      setTimeout(() => runPatternAnalysis(totalClosed).catch(() => {}), 5000);
    }

  } catch(e) { console.error('[LEARN]', e.message); }
}

// ── MFE / MAE IN-MEMORY CACHE ────────────────────────────────────────
// runTrailingStops() updates these every 30s while the trade is open
const _tradeMfeCache = {};  // trade_id → max pips reached (positive)
const _tradeMaeCache = {};  // trade_id → max adverse pips (negative)

// ── PATTERN ANALYSIS — runs every 25 trades and on REPORT command ────
async function runPatternAnalysis(totalClosed) {
  try {
    const attrs = db.prepare(`SELECT * FROM trade_attribution WHERE outcome IS NOT NULL ORDER BY created_at DESC`).all();
    if (attrs.length < 10) return;

    const wins   = attrs.filter(a => a.outcome === 'WIN');
    const losses = attrs.filter(a => a.outcome === 'LOSS');
    const winRate = Math.round(wins.length / attrs.length * 100);
    const totalPL = attrs.reduce((s, a) => s + (a.realized_pl || 0), 0);
    const avgWin  = wins.length   ? wins.reduce((s,a)   => s+(a.realized_pl||0), 0)/wins.length   : 0;
    const avgLoss = losses.length ? losses.reduce((s,a) => s+(a.realized_pl||0), 0)/losses.length : 0;
    const pf      = avgLoss < 0 ? Math.abs(avgWin / avgLoss) : null;

    // Find all conditions with MIN_LEARN+ samples, sorted by deviation from 50%
    const stats = db.prepare(`
      SELECT condition, trades, wins, losses, win_rate, total_pl
      FROM condition_stats WHERE trades >= ${LEARN_MIN_ADJUST}
      ORDER BY ABS(win_rate - 50) DESC
    `).all();

    const avoid    = stats.filter(s => s.win_rate < 40).slice(0, 5);
    const reinforce= stats.filter(s => s.win_rate > 65).slice(0, 5);

    // ADX analysis (most important single factor)
    const adxStats = db.prepare(`
      SELECT condition, trades, wins, win_rate FROM condition_stats
      WHERE condition LIKE 'adx:%' ORDER BY condition
    `).all();

    // Build the report
    let report =
`📊 PATTERN ANALYSIS REPORT
${totalClosed} closed trades analysed
━━━━━━━━━━━━━━━━━━━━━━━
Overall: ${winRate}% WR | P&L: ${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(0)}
Avg Win: +$${avgWin.toFixed(0)} | Avg Loss: $${avgLoss.toFixed(0)}
${pf ? `Profit Factor: ${pf.toFixed(2)}` : ''}`;

    if (adxStats.length > 0) {
      report += `\n\n📈 ADX IMPACT (${LEARN_MIN_ADJUST}+ samples):`;
      for (const s of adxStats) {
        if (s.trades >= LEARN_MIN_ADJUST) {
          const bar = s.win_rate >= 60 ? '✅' : s.win_rate <= 40 ? '🔴' : '➖';
          report += `\n${bar} ${s.condition.replace('adx:','ADX ')}: ${s.win_rate}%WR (${s.wins}W/${s.losses}L)`;
        }
      }
    }

    if (avoid.length > 0) {
      report += `\n\n🔴 AVOID (statistically weak, ${LEARN_MIN_ADJUST}+ trades):`;
      for (const s of avoid) {
        report += `\n• ${s.condition}: ${s.win_rate}%WR (${s.trades} trades, $${s.total_pl.toFixed(0)} P&L)`;
      }
    }

    if (reinforce.length > 0) {
      report += `\n\n✅ REINFORCE (statistically strong):`;
      for (const s of reinforce) {
        report += `\n• ${s.condition}: ${s.win_rate}%WR (${s.trades} trades, $${s.total_pl.toFixed(0)} P&L)`;
      }
    }

    if (stats.length === 0) {
      report += `\n\nInsufficient data for condition analysis (need ${LEARN_MIN_ADJUST}+ per condition).`;
      report += `\nAll entry conditions logged — patterns will emerge after more trades.`;
    }

    report += `\n\nNext analysis at ${totalClosed + LEARN_ANALYSIS_N} trades.`;

    await sendTelegramMsg(report).catch(() => {});
    console.log(`[LEARN] Pattern analysis sent (${totalClosed} trades)`);

  } catch(e) { console.error('[LEARN] Analysis failed:', e.message); }
}

// ── DYNAMIC CONFIDENCE DELTA ─────────────────────────────────────────
// Applied during scan AFTER calcTradeSetup.
// Only adjusts when a condition has LEARN_MIN_ADJUST+ data points.
// Key insight: 45% win rate on 8 trades = noise. 45% on 30 trades = signal.
function getLearningDelta(attrs) {
  let delta = 0;
  const applied = [];

  const conditions = [
    `session:${attrs.session}:${attrs.direction}`,
    `regime:${attrs.regime}`,
    `pair:${attrs.pair}:${attrs.direction}`,
    `bos:${attrs.bos}`,
    `sweep_risk:${attrs.sweep_risk}`,
    `w1_trend:${attrs.w1Trend}:${attrs.direction}`,
  ];
  if (attrs.adx != null) {
    const adxBand = attrs.adx < 18 ? 'adx:<18' : attrs.adx < 22 ? 'adx:18-22' :
                    attrs.adx < 26 ? 'adx:22-26' : attrs.adx < 30 ? 'adx:26-30' : 'adx:30+';
    conditions.push(adxBand);
  }

  for (const cond of conditions) {
    const stat = _getConditionStat(cond);
    if (stat.trades < LEARN_MIN_ADJUST) continue; // not enough data — no adjustment

    // Statistically meaningful deviation from expected ~50%
    if (stat.win_rate > 68) {
      // Strong historical edge for this condition
      const bonus = Math.min(8, Math.round((stat.win_rate - 58) / 4));
      delta += bonus;
      applied.push(`+${bonus} (${cond}: ${stat.win_rate}%WR n=${stat.trades})`);
    } else if (stat.win_rate < 38) {
      // This condition historically underperforms
      const penalty = -Math.min(12, Math.round((48 - stat.win_rate) / 3));
      delta += penalty;
      applied.push(`${penalty} (${cond}: ${stat.win_rate}%WR n=${stat.trades})`);
    }
    // 38-68% win rate = normal variance, no adjustment (avoids false learning)
  }

  if (applied.length > 0) {
    console.log(`[LEARN] Delta ${delta>0?'+':''}${delta}: ${applied.join(', ')}`);
  }
  return delta;
}

// ═══════════════════════════════════════════════════════════════════
// 12-CHECK PRECISION SCORING ENGINE — top-down: H4 → H2 → M30 → M5
// Each check = 1 point. Signal only fires if score >= minScore
// ═══════════════════════════════════════════════════════════════════
function scoreSignal({ direction, price, h4, h2, m30, m5, newsEvents = [], fvg = null, ob = null, turtle = null, pair = '' }) {
  const isBuy = direction === 'BUY';
  const checks = [];

  const pass = (name, cond, weight=1) => checks.push({ name, pass:!!cond, weight });

  // ── CHECK 1: H4 EMA full stack alignment (master timeframe) ──────
  pass('H4 EMA Stack',
    isBuy ? (h4.ema9>h4.ema21 && h4.ema21>h4.ema50) :
             (h4.ema9<h4.ema21 && h4.ema21<h4.ema50), 2);

  // ── CHECK 2: H4 trend — master trend must agree ───────────────────
  pass('H4 Master Trend',
    isBuy ? h4.trend==='BULLISH' : h4.trend==='BEARISH', 2);

  // ── CHECK 3: H2 trend agrees with H4 ─────────────────────────────
  pass('H2 Trend Match',
    isBuy ? h2.trend==='BULLISH' : h2.trend==='BEARISH', 2);

  // ── CHECK 4: M30 EMA confirms direction (entry prep) ─────────────
  pass('M30 EMA Confirms',
    isBuy ? m30.ema9 > m30.ema21 : m30.ema9 < m30.ema21, 1);

  // ── CHECK 5: RSI on M30 in healthy zone (not over-extended) ──────
  const rsi = m30.rsi14;
  pass('RSI Zone Safe',
    isBuy ? (rsi > 40 && rsi < 68) : (rsi > 32 && rsi < 60), 1);

  // ── CHECK 6: RSI on M30 NOT extreme ──────────────────────────────
  pass('RSI Not Extreme',
    isBuy ? rsi < 75 : rsi > 25, 1);

  // ── CHECK 7: MACD on M30 confirms direction ───────────────────────
  pass('MACD Direction',
    isBuy ? m30.macd > 0 : m30.macd < 0, 1);

  // ── CHECK 8: ADX on H4 shows trending market (not ranging) ───────
  pass('ADX Trending', h4.adx >= 20, 1);

  // ── CHECK 9: Market session — London (7-12) or NY (12-17) UTC ────
  const utcHour = new Date().getUTCHours();
  pass('Prime Session', utcHour >= 7 && utcHour <= 17, 1);

  // ── CHECK 10: Price close to H4 EMA21 (not overextended) ─────────
  const h4Dist = Math.abs(price - h4.ema21) / price * 100;
  pass('Not Overextended H4', h4Dist < 0.8, 1); // within 0.8% of H4 EMA21

  // ── CHECK 11: No HIGH-impact news affecting THIS pair's currencies ──────────
  // Extract the two currencies from the pair label (e.g. "EUR/USD" → ['EUR','USD'])
  const pairCurrencies = pair
    ? pair.replace('_','/').split('/').map(c => c.toUpperCase())
    : [];
  const nowUTC  = new Date();
  const hasNews = newsEvents.some(e => {
    if (e.impact !== 'HIGH') return false;
    // If we know the pair, only block when news affects that pair's currencies
    if (pairCurrencies.length === 2) {
      const newsCur = (e.currency || '').toUpperCase();
      if (newsCur && !pairCurrencies.includes(newsCur)) return false; // different currency — ignore
    }
    const [hh, mm] = (e.time || '99:99').split(':').map(Number);
    const eventMin = hh * 60 + mm;
    const nowMin   = nowUTC.getUTCHours() * 60 + nowUTC.getUTCMinutes();
    const diff     = nowMin - eventMin;
    return diff >= -45 && diff <= 60;  // 45 min before, 60 min after
  });
  pass('No News Blackout', !hasNews, 2);

  // ── CHECK 12: M5 candle pattern confirms direction (entry trigger) ─
  const bullishPatterns = ['BULLISH_PIN_BAR','BULLISH_ENGULFING','BULLISH_CANDLE'];
  const bearishPatterns = ['BEARISH_PIN_BAR','BEARISH_ENGULFING','BEARISH_CANDLE'];
  pass('M5 Entry Pattern',
    isBuy ? bullishPatterns.includes(m5.pattern) :
             bearishPatterns.includes(m5.pattern), 1);

  // ── CHECK 13: Bollinger Band setup — price at correct band or in squeeze ──
  const bb = h4.bb;
  pass('BB Setup',
    bb && (isBuy ? bb.pct < 0.35 || bb.squeezing : bb.pct > 0.65 || bb.squeezing), 1);

  // ── CHECK 14: HMA direction agrees ────────────────────────────────────────
  pass('HMA Direction',
    h4.hma ? (isBuy ? price > h4.hma : price < h4.hma) : false, 1);

  // ── CHECK 15: VWAP alignment — price on correct side of institutional average ─
  pass('VWAP Alignment',
    h4.vwap ? (isBuy ? price > h4.vwap : price < h4.vwap) : false, 1);

  // ── CHECK 16: Fair Value Gap or Order Block present in trade direction ─────
  pass('FVG / Order Block',
    (fvg?.found || ob?.found || turtle?.found), 1);

  // ── CHECK 17: Price near a key Fibonacci level (0.382–0.786) ─────────────
  const fibNear = h4.fib ? nearestFibLevel(h4.fib, price, h4.atr14) : null;
  pass('Fibonacci Confluence',
    fibNear != null && fibNear.distance <= 1.2 &&
    ['0.382','0.500','0.618','0.786'].includes(fibNear.key), 1);

  const totalWeight  = checks.reduce((s,c) => s + c.weight, 0);
  const passedWeight = checks.reduce((s,c) => s + (c.pass ? c.weight : 0), 0);
  const score        = checks.filter(c => c.pass).length;
  const maxScore     = checks.length;
  const pct          = Math.round(passedWeight / totalWeight * 100);

  return { score, maxScore, pct, checks };
}

// ═══════════════════════════════════════════════════════════════════
// PURE CALCULATION ENGINE — replaces AI API
// Institutional-grade rule-based analysis: S/R, confidence, SL/TP
// ═══════════════════════════════════════════════════════════════════
function calcTradeSetup({ direction, price, h4, h2, m30, m5, scored, session, fvg = null, ob = null, turtle = null, amd = null, sd = null }) {
  const isBuy = direction === 'BUY';
  const dp    = price > 100 ? 2 : 5;
  const atr   = h4.atr14 || m30.atr14 || 0.001;

  // ── CONFIDENCE CALCULATION ─────────────────────────────────────────
  // Start from weighted score percentage
  let conf = scored.pct;

  // +8  all 3 main TFs trend-aligned
  if (h4.trend === h2.trend && h2.trend === m30.trend &&
      (isBuy ? h4.trend === 'BULLISH' : h4.trend === 'BEARISH')) conf += 8;

  // +7  H4 ADX strong trend (> 25)
  if (h4.adx >= 25) conf += 7;
  // -12 ADX weak — ranging market
  else if (h4.adx < 20) conf -= 12;

  // +5  M30 RSI in the ideal entry zone (not overbought/oversold)
  const rsi = m30.rsi14;
  if (isBuy  && rsi >= 42 && rsi <= 60) conf += 5;
  if (!isBuy && rsi >= 40 && rsi <= 58) conf += 5;

  // +7  Price near H4 EMA21 — pullback entry (best timing)
  const h4Dist = Math.abs(price - h4.ema21) / price * 100;
  if (h4Dist < 0.25) conf += 7;      // very close to EMA — ideal
  else if (h4Dist > 0.65) conf -= 6; // over-extended — penalty

  // +8  H4 EMA200 confirms direction (only trade with the big trend)
  if (h4.ema200) {
    if ( isBuy && price > h4.ema200) conf += 8;
    if (!isBuy && price < h4.ema200) conf += 8;
    if ( isBuy && price < h4.ema200) conf -= 12; // against EMA200 — big penalty
    if (!isBuy && price > h4.ema200) conf -= 12;
  }

  // +5  Strong M5 reversal pattern (entry trigger candle)
  const m5BullPat = ['BULLISH_PIN_BAR','BULLISH_ENGULFING'];
  const m5BearPat = ['BEARISH_PIN_BAR','BEARISH_ENGULFING'];
  if ( isBuy && m5BullPat.includes(m5.pattern)) conf += 5;
  if (!isBuy && m5BearPat.includes(m5.pattern)) conf += 5;

  // +4  M30 MACD momentum agrees
  if ( isBuy && m30.macd > 0) conf += 4;
  if (!isBuy && m30.macd < 0) conf += 4;

  // +3  H4 EMA stack fully aligned
  const h4FullStack = isBuy
    ? (h4.ema9 > h4.ema21 && h4.ema21 > h4.ema50 && h4.ema50 > h4.ema200)
    : (h4.ema9 < h4.ema21 && h4.ema21 < h4.ema50 && h4.ema50 < h4.ema200);
  if (h4FullStack) conf += 3;

  // +3  H2 EMA9 agrees with direction
  if ( isBuy && h2.ema9 > h2.ema21) conf += 3;
  if (!isBuy && h2.ema9 < h2.ema21) conf += 3;

  // ── ICT Smart Money Concept bonuses ───────────────────────────────
  // +5  Fair Value Gap imbalance exists in trade direction (price drawn to it)
  if (fvg?.found) conf += 5;
  // +8  FVG is being actively tested right now (price inside the gap)
  if (fvg?.testing) conf += 8;
  // +6  Price is retesting a key Order Block
  if (ob?.testing) conf += 6;
  // +5  Order Block confirmed in direction (even if not testing yet)
  else if (ob?.found) conf += 5;
  // +9  ICT Turtle Soup — institutional stop hunt confirmed (high-probability)
  if (turtle?.found) conf += 9;
  // -8  AMD Manipulation phase — false breakout risk, avoid entry
  if (amd?.phase === 'MANIPULATION' || amd?.phase === 'MANIPULATION_NY') conf -= 8;
  // +4  BB squeeze — volatility about to expand, momentum trade loading
  if (h4.bb?.squeezing) conf += 4;
  // +4  Price on correct side of VWAP (institutional average price)
  if (h4.vwap) {
    if ( isBuy && price > h4.vwap) conf += 4;
    if (!isBuy && price < h4.vwap) conf += 4;
  }
  // +3  HMA direction confirms — fast trend filter
  if (h4.hma) {
    if ( isBuy && price > h4.hma) conf += 3;
    if (!isBuy && price < h4.hma) conf += 3;
  }
  // +7  Price at golden ratio (0.618) — highest-probability fib zone
  // +5  Price at 0.5 or 0.786 fib level
  // +3  Price at 0.382 fib level
  if (h4.fib && h4.atr14) {
    const fn = nearestFibLevel(h4.fib, price, h4.atr14);
    if (fn.distance <= 1.0) {
      if (fn.key === '0.618') conf += 7;
      else if (fn.key === '0.500' || fn.key === '0.786') conf += 5;
      else if (fn.key === '0.382') conf += 3;
    }
  }

  // Cap: never claim 100% (markets always have uncertainty)
  conf = Math.min(95, Math.max(10, Math.round(conf)));

  // ── STOP LOSS — prefer S/D zone boundary, fall back to ATR ──────────
  let stopLoss, slMethod = 'ATR';
  if (isBuy) {
    // Best SL: just below the nearest fresh demand zone bottom
    const demandZone = sd?.freshZones?.[sd.freshZones.length - 1] ||
                       sd?.zones?.filter(z => z.type === 'DEMAND' && z.top < price)?.[0];
    if (demandZone) {
      const candidate = demandZone.bottom - atr * 0.15;
      const dist = price - candidate;
      if (dist >= atr * 0.5 && dist <= atr * 3.5) { stopLoss = candidate; slMethod = 'S/D Zone'; }
    }
    if (!stopLoss) {
      const candidate = h4.strongSupport - atr * 0.2;
      const dist = price - candidate;
      stopLoss = (dist >= atr * 0.6 && dist <= atr * 3.0) ? candidate : price - atr * 1.6;
    }
  } else {
    // Best SL: just above nearest fresh supply zone top
    const supplyZone = sd?.freshZones?.[sd.freshZones.length - 1] ||
                       sd?.zones?.filter(z => z.type === 'SUPPLY' && z.bottom > price)?.[0];
    if (supplyZone) {
      const candidate = supplyZone.top + atr * 0.15;
      const dist = candidate - price;
      if (dist >= atr * 0.5 && dist <= atr * 3.5) { stopLoss = candidate; slMethod = 'S/D Zone'; }
    }
    if (!stopLoss) {
      const candidate = h4.strongResist + atr * 0.2;
      const dist = candidate - price;
      stopLoss = (dist >= atr * 0.6 && dist <= atr * 3.0) ? candidate : price + atr * 1.6;
    }
  }

  // ── TAKE PROFIT — prefer opposing S/D zone, fall back to R:R ──────────
  const slDist = Math.abs(price - stopLoss);
  let takeProfit, tpMethod = 'RR';

  // Look for opposing S/D zone as TP target (supply for BUY, demand for SELL)
  if (isBuy && sd?.zones) {
    const supplyAbove = sd.zones.filter(z => z.type === 'SUPPLY' && z.bottom > price + slDist * 1.5);
    if (supplyAbove.length > 0) {
      takeProfit = supplyAbove[supplyAbove.length - 1].bottom - atr * 0.1;
      tpMethod   = 'Supply Zone';
    }
  } else if (!isBuy && sd?.zones) {
    const demandBelow = sd.zones.filter(z => z.type === 'DEMAND' && z.top < price - slDist * 1.5);
    if (demandBelow.length > 0) {
      takeProfit = demandBelow[demandBelow.length - 1].top + atr * 0.1;
      tpMethod   = 'Demand Zone';
    }
  }

  if (!takeProfit) {
    // Fallback: H4 S/R if it gives ≥1:2, else 2.5× SL
    if (isBuy) {
      const tpSR = h4.resistance > price + slDist ? h4.resistance : null;
      takeProfit = (tpSR && tpSR - price >= slDist * 2) ? tpSR : price + slDist * 2.5;
    } else {
      const tpSR = h4.support < price - slDist ? h4.support : null;
      takeProfit = (tpSR && price - tpSR >= slDist * 2) ? tpSR : price - slDist * 2.5;
    }
  }

  stopLoss   = parseFloat(stopLoss.toFixed(dp));
  takeProfit = parseFloat(takeProfit.toFixed(dp));
  const rr   = Math.abs(price - takeProfit) / Math.abs(price - stopLoss);

  // ── ANALYSIS TEXT ──────────────────────────────────────────────────
  const tfAgree = h4.trend === h2.trend && h2.trend === m30.trend;
  const analysis =
`Market Bias: ${isBuy ? 'BULLISH' : 'BEARISH'}
Confidence Score: ${conf}%
Entry Zone: ${price.toFixed(dp)}
Stop Loss: ${stopLoss.toFixed(dp)} [${slMethod}]
Take Profit: ${takeProfit.toFixed(dp)} [${tpMethod}]
Risk/Reward: 1:${rr.toFixed(1)}

TIMEFRAME ANALYSIS:
H4 (Master): ${h4.emaAlignment} | EMA9/21/50 ${h4FullStack ? 'FULLY STACKED ✓' : 'partial'} | ADX ${h4.adx} ${h4.adx>=25?'(STRONG)':h4.adx>=20?'(OK)':'(WEAK ⚠)'}
H2 (Confirm): ${h2.trend} trend | RSI ${h2.rsi14} | EMA ${h2.ema9>h2.ema21?'bullish':'bearish'} cross
M30 (Entry): ${m30.trend} | RSI ${rsi} | MACD ${m30.macd>0?'▲ positive':'▼ negative'} | ${m30.pattern}
M5 (Trigger): ${m5.pattern} | RSI ${m5.rsi14}
All timeframes aligned: ${tfAgree ? 'YES ✓' : 'PARTIAL'}
Session: ${session} | Calc Engine v1 (rule-based)`;

  return { direction, confidence: conf, stopLoss, takeProfit, rr, analysis };
}

// ── Market session name ──────────────────────────────────────────────────────
function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 7)  return 'ASIAN';
  if (h >= 7  && h < 12) return 'LONDON';
  if (h >= 12 && h < 17) return 'NY';
  return 'OFF_HOURS';
}

// ═════════════════════════════════════════════════════════════════════════════
// RISK GOVERNORS — hard enforced limits before every execution
// ═════════════════════════════════════════════════════════════════════════════

// USD directional correlation groups (who profits when USD moves which way)
const USD_CORR_GROUP = {
  // USD quote (long = short USD)
  'EUR/USD': { BUY:'USD_SHORT', SELL:'USD_LONG'  },
  'GBP/USD': { BUY:'USD_SHORT', SELL:'USD_LONG'  },
  'AUD/USD': { BUY:'USD_SHORT', SELL:'USD_LONG'  },
  'NZD/USD': { BUY:'USD_SHORT', SELL:'USD_LONG'  },
  // USD base (long = long USD)
  'USD/JPY': { BUY:'USD_LONG',  SELL:'USD_SHORT' },
  'USD/CAD': { BUY:'USD_LONG',  SELL:'USD_SHORT' },
  'USD/CHF': { BUY:'USD_LONG',  SELL:'USD_SHORT' },
  // Cross pairs and commodities — no USD directional limit applied
};

const _stmtWeeklyPL = db.prepare(`
  SELECT COALESCE(SUM(realized_pl), 0) as total, COUNT(*) as cnt
  FROM signals WHERE status='CLOSED' AND date(closed_at) >= ?
`);

function getWeeklyPL() {
  const now = new Date();
  const daysFromMonday = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
  const monday = new Date(now.getTime() - daysFromMonday * 86400000).toISOString().slice(0, 10);
  const row = _stmtWeeklyPL.get(monday);
  return { realized_pl: row?.total || 0, trade_count: row?.cnt || 0, week_start: monday };
}

function getConsecutiveLosses() {
  const recent = _stmtConsecLosses.all();
  let count = 0;
  for (const t of recent) {
    if ((t.realized_pl || 0) < 0) count++;
    else break;
  }
  return count;
}

function getCorrelatedOpenCount(pair, direction) {
  const myGroup = USD_CORR_GROUP[pair]?.[direction];
  if (!myGroup) return 0;
  const open = _stmtOpenTrades.all();
  return open.filter(s => USD_CORR_GROUP[s.pair]?.[s.direction] === myGroup).length;
}

async function checkRiskGovernors(signal) {
  const keys = getApiKeys();
  const blocks = [];

  // 1 — Daily/weekly loss warnings (notify only — never block) + HARD 10% DD stop
  try {
    if (keys.oanda_key && keys.oanda_account) {
      const acct    = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
      const balance = parseFloat(acct?.account?.balance || 0);
      if (balance > 0) {
        const today = new Date().toISOString().slice(0, 10);

        // Daily loss warning — notify once per day when 3% hit, but keep trading
        const daily = getDailyPL();
        if (daily.realized_pl < 0 && Math.abs(daily.realized_pl) >= balance * 0.03) {
          const dailyAlertKey = `daily_warn_${today}`;
          if (!getStorageValue(dailyAlertKey)) {
            setStorageValue(dailyAlertKey, true);
            const dayRows = db.prepare(`SELECT realized_pl FROM signals WHERE status='CLOSED' AND date(closed_at)=?`).all(today);
            const dayWins = dayRows.filter(r => (r.realized_pl||0) > 0).length;
            const dayLoss = dayRows.filter(r => (r.realized_pl||0) <= 0).length;
            sendTelegramMsg(
`⚠️ DAILY LOSS NOTICE — ${today}
Daily P&L:  $${daily.realized_pl.toFixed(2)} (3% limit: -$${(balance*0.03).toFixed(2)})
Trades:     ${dayWins}W / ${dayLoss}L

Trading continues — this is info only.`
            ).catch(() => {});
          }
        }

        // Weekly loss warning — notify once per week when 6% hit, but keep trading
        const weekly = getWeeklyPL();
        if (weekly.realized_pl < 0 && Math.abs(weekly.realized_pl) >= balance * 0.06) {
          const weekKey = `week_warn_${today}`;
          if (!getStorageValue(weekKey)) {
            setStorageValue(weekKey, true);
            sendTelegramMsg(
`⚠️ WEEKLY LOSS NOTICE
Weekly P&L: $${weekly.realized_pl.toFixed(2)} (limit: -${(balance*0.06).toFixed(2)})

Trading continues — this is info only.`
            ).catch(() => {});
          }
        }

        // Hard 10% drawdown from peak — track peak equity in storage
        const storedPeak = getStorageValue('peak_balance') || 0;
        const peak = Math.max(storedPeak, balance);
        if (peak > storedPeak) setStorageValue('peak_balance', peak); // update peak
        const ddPct = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
        if (ddPct >= 10) {
          blocks.push(`HARD STOP: Account down ${ddPct.toFixed(1)}% from peak $${peak.toFixed(0)} → current $${balance.toFixed(0)} — trading halted until manual review`);
          // Send urgent alert only once per day
          const ddAlertKey = `dd_alert_${new Date().toISOString().slice(0,10)}`;
          if (!getStorageValue(ddAlertKey)) {
            setStorageValue(ddAlertKey, true);
            sendTelegramMsg(
`🚨 HARD DRAWDOWN STOP TRIGGERED
Account dropped ${ddPct.toFixed(1)}% from peak

Peak balance:    $${peak.toFixed(2)}
Current balance: $${balance.toFixed(2)}
Drawdown:        -$${(peak - balance).toFixed(2)} (${ddPct.toFixed(1)}%)

ALL TRADING SUSPENDED.
Review your strategy before re-enabling.
Type STATUS to check system state.`
            ).catch(() => {});
          }
        }
      }
    }
  } catch {}

  // 2 — Consecutive loss circuit breaker (≥3 losses = pause)
  const consec = getConsecutiveLosses();
  if (consec >= 3)
    blocks.push(`${consec} consecutive losses — circuit breaker active. Review before resuming.`);

  // 3 — Correlated exposure (max 2 same-direction USD trades open at once)
  if (signal) {
    const corrOpen = getCorrelatedOpenCount(signal.pair, signal.direction);
    if (corrOpen >= 2)
      blocks.push(`Correlated exposure: ${corrOpen} same-direction USD trades already open`);
  }

  // FIX 10 — Extended kill switches
  // 4. OANDA API instability (daily loss count kill switch removed)
  const avgLat = getOandaAvgLatency();
  if (avgLat > 5000 && oandaLatencyLog.length >= 5)
    blocks.push(`OANDA API unstable: avg latency ${avgLat.toFixed(0)}ms`);

  // 6. Stale data feed
  if (signal && isFeedStale(signal.pair))
    blocks.push(`Data feed stale for ${signal.pair} — price unchanged >2min during market hours`);

  if (blocks.length > 0) {
    blocks.forEach(detail => {
      _stmtInsertRiskEvent.run('GOVERNOR_BLOCK', detail, signal?.pair || null, 'BLOCKED_EXECUTION');
    });
  }

  return { allowed: blocks.length === 0, reasons: blocks };
}

// ═════════════════════════════════════════════════════════════════════════════
// TRADE RECONCILIATION — broker is authoritative source of truth
// 1. Reconcile closed trades from OANDA → update local outcomes
// 2. FIX 2: Ghost position detection — broker open trades not in local DB
// ═════════════════════════════════════════════════════════════════════════════
async function reconcileTrades() {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return;

  try {
    // ── Part 1: Close reconciliation (existing logic, enhanced) ─────────────
    const pending = _stmtPendingReconcile.all();
    if (pending.length) {
      const closed = (await fetchClosedTrades(50)).trades;

      for (const sig of pending) {
        const oTrade = closed.find(t => t.id === sig.trade_id);
        if (!oTrade) continue;

        const oInstr     = LABEL_TO_OANDA[sig.pair] || sig.pair.replace('/', '_');
        const pipSize    = PIP[oInstr] || 0.0001;
        const dp         = ['XAU_USD','XAG_USD'].includes(oInstr) ? 2 : oInstr.includes('JPY') ? 3 : 5;
        const entry      = parseFloat(sig.entry_price);
        const exitPx     = parseFloat(oTrade.averageClosePrice || oTrade.price);
        const realizedPL = parseFloat(oTrade.realizedPL || 0);
        const isBuy      = sig.direction === 'BUY';
        const actualPips = ((isBuy ? exitPx - entry : entry - exitPx) / pipSize).toFixed(1);

        let exitReason = 'MANUAL';
        if (oTrade.stopLossOrder?.state   === 'FILLED') exitReason = 'SL_HIT';
        if (oTrade.takeProfitOrder?.state === 'FILLED') exitReason = 'TP_HIT';

        const openMs  = new Date(oTrade.openTime).getTime();
        const closeMs = new Date(oTrade.closeTime).getTime();
        const durMins = Math.round((closeMs - openMs) / 60000);

        db.prepare(`
          UPDATE signals SET
            realized_pl=?, exit_price=?, exit_reason=?,
            closed_at=?, duration_mins=?, actual_pips=?, status='CLOSED'
          WHERE id=?
        `).run(realizedPL, exitPx, exitReason, oTrade.closeTime, durMins, actualPips, sig.id);

        recordTradePL(realizedPL);
        writeAudit('TRADE_CLOSED', { signal_id: sig.id, pair: sig.pair, pl: realizedPL, exitReason });
        checkAndSetPairBreaker(sig.pair);

        // Fill in attribution outcome for post-trade analysis
        try {
          db.prepare(`
            UPDATE trade_attribution SET
              realized_pl=?, actual_pips=?, exit_reason=?, duration_mins=?,
              outcome=CASE WHEN ? > 0 THEN 'WIN' WHEN ? < 0 THEN 'LOSS' ELSE 'BE' END
            WHERE signal_id=?
          `).run(realizedPL, actualPips, exitReason, durMins, realizedPL, realizedPL, sig.id);
        } catch(e) { console.error('[ATTR]', e.message); }

        const outcome = realizedPL > 0 ? 'WIN' : realizedPL < 0 ? 'LOSS' : 'BE';
        console.log(`[RECONCILE] #${sig.id} ${sig.pair} ${sig.direction} → ${exitReason} | P&L: ${realizedPL >= 0 ? '+' : ''}${realizedPL.toFixed(2)} | ${actualPips} pips | ${durMins}m`);

        // Attach outcome to sig object for generateTradeLessons
        const closedSig = { ...sig, duration_mins: durMins, actual_pips: actualPips };
        generateTradeLessons(closedSig, outcome, realizedPL, exitReason).catch(() => {});
      }
    }

    // ── Part 2: FIX 2 — Ghost position detection ─────────────────────────────
    // Broker is authoritative — find open broker trades not in local DB
    const openR = await oandaRequest(`/v3/accounts/${keys.oanda_account}/openTrades`);
    const brokerOpen = openR?.trades || [];
    if (!brokerOpen.length) return;

    // Get all trade IDs we know about locally
    const localTradeIds = new Set(
      db.prepare(`SELECT trade_id FROM signals WHERE status='EXECUTED' AND closed_at IS NULL AND trade_id IS NOT NULL`)
        .all().map(r => r.trade_id)
    );

    for (const bt of brokerOpen) {
      if (localTradeIds.has(bt.id)) continue; // known — all good

      // Ghost position: broker has open trade we don't know about
      const exists = db.prepare(`SELECT id FROM ghost_positions WHERE oanda_trade_id=?`).get(bt.id);
      if (exists) continue; // already logged

      db.prepare(`
        INSERT OR IGNORE INTO ghost_positions
          (oanda_trade_id, instrument, units, open_price, unrealized_pl)
        VALUES (?,?,?,?,?)
      `).run(bt.id, bt.instrument, parseFloat(bt.currentUnits), parseFloat(bt.price), parseFloat(bt.unrealizedPL || 0));

      const ghostMsg =
`🚨 GHOST POSITION DETECTED
OANDA trade ID: ${bt.id}
Instrument: ${bt.instrument}
Units: ${bt.currentUnits}
Open Price: ${bt.price}
Unrealized P&L: ${bt.unrealizedPL}

This trade is NOT in local database.
Manually review and close if needed.`;

      console.error(`[GHOST] ${bt.instrument} trade ${bt.id} not in local DB — ghost position`);
      writeAudit('GHOST_POSITION_DETECTED', { oanda_trade_id: bt.id, instrument: bt.instrument });
      sendTelegramMsg(ghostMsg).catch(() => {});
    }

  } catch(e) {
    console.error('[RECONCILE]', e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DATABASE BACKUP — daily automatic copy, keep last 7
// ═════════════════════════════════════════════════════════════════════════════
function backupDatabase() {
  const src     = path.join(__dirname, 'data', 'precisiontrader.db');
  const backDir = path.join(__dirname, 'data', 'backups');
  try {
    if (!fs.existsSync(backDir)) fs.mkdirSync(backDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest  = path.join(backDir, `precisiontrader_${stamp}.db`);
    fs.copyFileSync(src, dest);
    // Keep newest 7, delete the rest
    const files = fs.readdirSync(backDir).filter(f => f.endsWith('.db')).sort();
    files.slice(0, Math.max(0, files.length - 7)).forEach(f =>
      fs.unlinkSync(path.join(backDir, f))
    );
    console.log(`[BACKUP] DB saved → ${dest}`);
  } catch(e) {
    console.error('[BACKUP]', e.message);
  }
}

// ── Partial-TP state — in-memory Set of trade IDs already partially closed ───
// Persisted across restarts via the execution_log table flag
const _partialClosedSet = new Set(
  (() => { try { return db.prepare(`SELECT oanda_trade_id FROM execution_log WHERE partial_closed=1`).all().map(r => r.oanda_trade_id); } catch { return []; } })()
);

// ── Trailing stop monitor — protects open profits ────────────────────────────
let _tslBackoffUntil = 0;
async function runTrailingStops() {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return;
  if (Date.now() < _tslBackoffUntil) return; // skip when we know no trades are open
  try {
    const r = await oandaRequest(`/v3/accounts/${keys.oanda_account}/openTrades`);
    const trades = r?.trades || [];
    if (!trades.length) { _tslBackoffUntil = Date.now() + 120000; return; } // 2 min backoff
    for (const trade of trades) {
      const pl   = parseFloat(trade.unrealizedPL || 0);
      const units= parseFloat(trade.currentUnits || 0);
      const entry= parseFloat(trade.price || 0);
      const instr= trade.instrument;
      const isBuy= units > 0;
      const pipSize = PIP[instr] || 0.0001;
      const dp    = ['XAU_USD','XAG_USD'].includes(instr) ? 2 : instr.includes('JPY') ? 3 : 5;

      // Current SL
      const currentSL = parseFloat(trade.stopLossOrder?.price || 0);
      if (!currentSL) continue;

      const currentPx = parseFloat(priceCache[instr.replace('_','/')] || entry);
      const plPips = isBuy
        ? (currentPx - entry) / pipSize
        : (entry - currentPx) / pipSize;
      const slPips = isBuy
        ? (entry - currentSL) / pipSize
        : (currentSL - entry) / pipSize;

      // ── Partial TP at 1:1 R:R — close 50% once trade equals SL distance ────
      // Locks realized profit before going for full TP; reduces average loss on runners
      if (plPips >= slPips * 1.0 && !_partialClosedSet.has(trade.id)) {
        try {
          const partialUnits = String(Math.floor(Math.abs(units) * 0.5));
          if (parseInt(partialUnits) >= 100) {
            await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/close`, 'PUT', { units: partialUnits });
            _partialClosedSet.add(trade.id);
            try { db.prepare(`UPDATE execution_log SET partial_closed=1 WHERE signal_id IN (SELECT id FROM signals WHERE trade_id=?)`).run(trade.id); } catch {}
            console.log(`[TSL] Partial TP: ${instr} trade ${trade.id} — closed ${partialUnits} units at +${plPips.toFixed(1)} pips`);
            sendTelegramMsg(
              `📤 PARTIAL TP — ${PAIR_LABELS[instr] || instr}\nClosed 50% at +${plPips.toFixed(1)} pips (1:1 R:R)\nRemainder running to full TP`
            ).catch(() => {});
          }
        } catch(e) { console.warn(`[TSL] Partial close failed ${trade.id}:`, e.message); }
      }

      // Move SL to breakeven once +1:1 reached
      const beThreshold = slPips * 1.0;
      if (plPips >= beThreshold && currentSL) {
        const bePrice = isBuy
          ? (entry + pipSize * 3).toFixed(dp)  // 3 pip above entry
          : (entry - pipSize * 3).toFixed(dp);
        const newSL = parseFloat(bePrice);
        const shouldMove = isBuy ? newSL > currentSL : newSL < currentSL;
        if (shouldMove) {
          await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/orders`, 'PUT', {
            stopLoss: { price: bePrice, timeInForce:'GTC' }
          });
          console.log(`[TSL] Moved SL to breakeven: ${instr} trade ${trade.id} → ${bePrice}`);
        }
      }

      // Trail SL at 1.5× ATR behind price once +1.5:1 reached
      if (plPips >= slPips * 1.5) {
        const atr = h1AtrCache[instr] || slPips * pipSize;
        const trailSL = isBuy
          ? (currentPx - atr * 1.5).toFixed(dp)
          : (currentPx + atr * 1.5).toFixed(dp);
        const trailPrice = parseFloat(trailSL);
        const shouldTrail = isBuy ? trailPrice > currentSL : trailPrice < currentSL;
        if (shouldTrail) {
          await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/orders`, 'PUT', {
            stopLoss: { price: trailSL, timeInForce:'GTC' }
          });
          console.log(`[TSL] Trailing SL moved: ${instr} → ${trailSL}`);
        }
      }

      // ── MFE / MAE TRACKING ───────────────────────────────────────────
      // Track max favorable and max adverse excursion for post-trade analysis
      if (plPips > 0) {
        _tradeMfeCache[trade.id] = Math.max(_tradeMfeCache[trade.id] || 0, plPips);
      } else if (plPips < 0) {
        _tradeMaeCache[trade.id] = Math.min(_tradeMaeCache[trade.id] || 0, plPips);
      }

      // ── STAGNATION EXIT — trade going nowhere ────────────────────────
      // If trade has been open 8+ hours with < 0.2R profit, it is wasting margin
      // and overnight risk. Close it.
      const hoursOpen = (Date.now() - new Date(trade.openTime).getTime()) / 3600000;
      const rrReached = slPips > 0 ? plPips / slPips : 0;
      if (hoursOpen > 8 && rrReached < 0.2 && !_stagnationChecked.has(trade.id)) {
        _stagnationChecked.add(trade.id);
        console.warn(`[TSL] Stagnation: ${instr} trade ${trade.id} — ${hoursOpen.toFixed(1)}h open at ${rrReached.toFixed(2)}R`);
        try {
          await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/close`, 'PUT');
          sendTelegramMsg(
`⏱ STAGNATION EXIT — ${PAIR_LABELS[instr] || instr}
Trade open ${hoursOpen.toFixed(1)}h with only ${rrReached.toFixed(2)}R profit
Capital freed. No overnight drift risk.`
          ).catch(() => {});
          console.log(`[TSL] Stagnation exit executed: ${instr} trade ${trade.id}`);
        } catch(e) { console.error(`[TSL] Stagnation close failed ${trade.id}:`, e.message); }
      }

      // ── DYNAMIC TRADE HEALTH — close if structure flips against position ──
      // Fetch fresh M30 indicators every 5 minutes (not every 30s — rate limit safe)
      const healthKey = `${trade.id}_health`;
      const lastHealthCheck = _tradeHealthCache[healthKey] || 0;
      if (Date.now() - lastHealthCheck > 300000) { // 5-min cooldown
        _tradeHealthCache[healthKey] = Date.now();
        try {
          const m30r = await oandaRequest(`/v3/instruments/${instr}/candles?count=50&granularity=M30&price=M`);
          const m30c  = completedCandles(m30r?.candles || []);
          const h4r   = await oandaRequest(`/v3/instruments/${instr}/candles?count=60&granularity=H4&price=M`);
          const h4c   = completedCandles(h4r?.candles || []);
          if (m30c.length >= 10 && h4c.length >= 26) {
            const indM30live = buildIndicators(m30c, h4c);
            const indH4live  = buildIndicators(h4c, []);
            let healthScore = 100;

            // H4 trend flip against position — most serious
            if (isBuy  && indH4live.trend === 'BEARISH') healthScore -= 35;
            if (!isBuy && indH4live.trend === 'BULLISH') healthScore -= 35;

            // M30 EMA cross against position
            if (isBuy  && indM30live.ema9 < indM30live.ema21) healthScore -= 20;
            if (!isBuy && indM30live.ema9 > indM30live.ema21) healthScore -= 20;

            // RSI extreme against direction
            if (isBuy  && indM30live.rsi14 < 35) healthScore -= 15;
            if (!isBuy && indM30live.rsi14 > 65) healthScore -= 15;

            // ATR expanding dangerously (volatility explosion)
            if (isATRExpanded(h4c, 2.0)) healthScore -= 15;

            console.log(`[HEALTH] ${instr} trade ${trade.id}: score ${healthScore}/100`);

            if (healthScore <= 30) {
              // Emergency exit — structure has completely flipped
              await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/close`, 'PUT');
              const dir = isBuy ? 'BUY' : 'SELL';
              sendTelegramMsg(
`🔴 HEALTH EXIT — ${PAIR_LABELS[instr] || instr} ${dir}
Health score: ${healthScore}/100
P&L: ${pl >= 0 ? '+' : ''}${pl.toFixed(2)}
Market structure flipped against position — closed to protect capital.`
              ).catch(() => {});
              console.warn(`[HEALTH] Emergency exit: ${instr} trade ${trade.id} (health ${healthScore})`);
            } else if (healthScore <= 55 && currentSL) {
              // Tighten stop to 0.5× ATR from current price — reduce exposure
              const atr = h1AtrCache[instr] || indM30live.atr14;
              const tightSL = isBuy
                ? (currentPx - atr * 0.5).toFixed(dp)
                : (currentPx + atr * 0.5).toFixed(dp);
              const tightPrice = parseFloat(tightSL);
              const shouldTighten = isBuy ? tightPrice > currentSL : tightPrice < currentSL;
              if (shouldTighten) {
                await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/orders`, 'PUT', {
                  stopLoss: { price: tightSL, timeInForce:'GTC' }
                });
                console.log(`[HEALTH] SL tightened: ${instr} → ${tightSL} (health ${healthScore})`);
              }
            }
          }
        } catch(e) { /* health check failed silently — don't block trailing stop */ }
      }
    }
  } catch(e) { /* silent */ }
}
const _stagnationChecked = new Set();
const _tradeHealthCache  = {};
const h1AtrCache = {};
setInterval(runTrailingStops, 30000); // check every 30s

// ═════════════════════════════════════════════════════════════════════════════
// STORAGE API
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/storage/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM storage WHERE key = ?').get(req.params.key);
  res.json({ value: row?.value ?? null });
});

app.post('/api/storage/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  _stmtSetStorage.run(req.params.key, value);
  if (req.params.key === 'ptp_keys') invalidateKeysCache();
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRICES — Primary: OANDA (free, unlimited) | Fallback: Twelve Data
// Server-side cache → frontend gets instant response, no rate limits ever
// ═════════════════════════════════════════════════════════════════════════════
const PAIRS = [
  // ── Major USD pairs ──────────────────────────────────────────────
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF','USD/CAD','AUD/USD','NZD/USD',
  // ── EUR crosses ──────────────────────────────────────────────────
  'EUR/GBP','EUR/JPY','EUR/CHF','EUR/AUD','EUR/CAD','EUR/NZD','EUR/SGD','EUR/HKD',
  // ── GBP crosses ──────────────────────────────────────────────────
  'GBP/JPY','GBP/CHF','GBP/AUD','GBP/CAD','GBP/NZD','GBP/SGD','GBP/HKD','GBP/PLN',
  // ── AUD crosses ──────────────────────────────────────────────────
  'AUD/JPY','AUD/CAD','AUD/CHF','AUD/NZD','AUD/SGD','AUD/HKD',
  // ── NZD crosses ──────────────────────────────────────────────────
  'NZD/JPY','NZD/CAD','NZD/CHF','NZD/SGD','NZD/HKD',
  // ── CAD crosses ──────────────────────────────────────────────────
  'CAD/JPY','CAD/CHF','CAD/SGD','CAD/HKD',
  // ── CHF crosses ──────────────────────────────────────────────────
  'CHF/JPY','CHF/HKD','CHF/ZAR',
  // ── Other crosses ────────────────────────────────────────────────
  'SGD/JPY','SGD/CHF','HKD/JPY','ZAR/JPY','TRY/JPY',
  // ── Scandinavian ─────────────────────────────────────────────────
  'USD/SEK','USD/NOK','USD/DKK','EUR/SEK','EUR/NOK','EUR/DKK',
  // ── Central Europe ───────────────────────────────────────────────
  'EUR/CZK','EUR/HUF','EUR/PLN','USD/CZK','USD/HUF','USD/PLN',
  // ── Emerging markets ─────────────────────────────────────────────
  'USD/ZAR','USD/MXN','USD/TRY','USD/SGD','USD/HKD','USD/CNH','USD/THB','USD/SAR',
  'EUR/TRY','EUR/ZAR','GBP/ZAR',
  // ── Precious metals ──────────────────────────────────────────────
  'XAU/USD','XAG/USD','XPT/USD','XPD/USD',
];
// OANDA instrument codes are derived from PAIRS at poll time (slash → underscore).
// Prices are fetched in resilient chunks (see fetchOandaPricing) so that one
// unsupported instrument can never 400 the whole request and wipe all prices.

let priceCache = {}, priceCacheTime = 0, priceSource = 'none';
let spreadCache = {}; // pair → live spread (ask - bid)

// Fetch OANDA pricing for a list of instruments. OANDA returns HTTP 400 for the
// *entire* request if any single instrument is unsupported, so on failure we
// binary-split the list and retry each half — this isolates the bad instrument
// (dropping only it) while keeping every valid pair. O(log n) extra calls, and
// only when a failure actually occurs.
async function fetchOandaPricing(base, account, key, instruments) {
  if (instruments.length === 0) return [];
  try {
    const r = await axios.get(
      `${base}/v3/accounts/${account}/pricing?instruments=${instruments.join(',')}`,
      { headers:{ Authorization:`Bearer ${key}` }, timeout:8000 }
    );
    return r.data?.prices || [];
  } catch {
    if (instruments.length === 1) return []; // lone unsupported/erroring instrument — drop it
    const mid = Math.ceil(instruments.length / 2);
    const [a, b] = await Promise.all([
      fetchOandaPricing(base, account, key, instruments.slice(0, mid)),
      fetchOandaPricing(base, account, key, instruments.slice(mid)),
    ]);
    return [...a, ...b];
  }
}

async function pollPrices() {
  const keys = getApiKeys();
  if (keys.oanda_key && keys.oanda_account) {
    const instruments = PAIRS.map(p => p.replace('/', '_'));
    // Chunk to keep each request URL/response reasonable; chunks merge into one snapshot.
    const chunks = [];
    for (let i = 0; i < instruments.length; i += 25) chunks.push(instruments.slice(i, i + 25));
    const bases = oandaBases();
    for (const base of bases) {
      try {
        const results = await Promise.all(
          chunks.map(c => fetchOandaPricing(base, keys.oanda_account, keys.oanda_key, c))
        );
        const prices = results.flat();
        if (prices.length > 0) {
          const m = {};
          prices.forEach(p => {
            const sym = p.instrument.replace('_','/');
            const bid = parseFloat(p.bids?.[0]?.price||0);
            const ask = parseFloat(p.asks?.[0]?.price||0);
            if (bid && ask) {
              const mid = ((bid+ask)/2).toFixed(p.instrument==='XAU_USD'?2:5);
              m[sym] = mid;
              spreadCache[sym] = parseFloat((ask - bid).toFixed(p.instrument==='XAU_USD'?2:5));
              // FIX 9 — track when price last changed (stale feed detection)
              if (priceCache[sym] !== mid) priceLastChanged[sym] = Date.now();
            }
          });
          if (Object.keys(m).length > 0) { priceCache=m; priceCacheTime=Date.now(); priceSource='OANDA'; return; }
        }
      } catch {}
    }
  }
  // Fallback: Twelve Data (only if OANDA unavailable)
  // Clear spread cache — TwelveData has no spread data; stale OANDA spreads would
  // mislead spread-efficiency and execution-block checks if left from the last OANDA poll
  spreadCache = {};
  if (keys.twelve_key) {
    try {
      const r = await axios.get(
        `https://api.twelvedata.com/price?symbol=${PAIRS.join(',')}&apikey=${keys.twelve_key}`,
        { timeout:10000 }
      );
      if (r.data && !r.data.code) {
        const m = {};
        PAIRS.forEach(p => { if (r.data[p]?.price) m[p] = r.data[p].price; });
        if (Object.keys(m).length > 0) { priceCache=m; priceCacheTime=Date.now(); priceSource='TwelveData'; }
      }
    } catch {}
  }
}

pollPrices().catch(e => console.error('[POLL] Initial price poll error:', e.message));
setInterval(() => pollPrices().catch(e => console.error('[POLL] Price poll error:', e.message)), 5000);

app.get('/api/prices', (req, res) => {
  if (!Object.keys(priceCache).length) return res.status(503).json({ error:'Prices loading...' });
  const out = {};
  PAIRS.forEach(p => { if (priceCache[p]) out[p] = { price: priceCache[p] }; });
  res.json(out);
});

app.get('/api/prices/source', (req, res) => {
  res.json({ source:priceSource, cached_at:priceCacheTime?new Date(priceCacheTime).toISOString():null, pairs:priceCache });
});

// ═════════════════════════════════════════════════════════════════════════════
// OANDA PROXY
// ═════════════════════════════════════════════════════════════════════════════
app.all('/api/oanda/*', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.oanda_key) return res.status(400).json({ error:'OANDA key not configured' });
  const oandaPath = req.path.replace('/api/oanda','');
  const bases = oandaBases();
  for (const base of bases) {
    try {
      const r = await axios({
        method: req.method, url: base+oandaPath, params: req.query,
        data: req.method!=='GET' ? req.body : undefined,
        headers: { Authorization:`Bearer ${keys.oanda_key}`, 'Content-Type':'application/json' },
        timeout: 12000,
      });
      return res.json(r.data);
    } catch (e) {
      if (e.response) return res.status(e.response.status).json(e.response.data);
    }
  }
  res.status(502).json({ error:'OANDA unreachable' });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 1 — AI ANALYSIS WITH REAL CANDLE DATA + INDICATORS
// Fetches 50 H1 candles + 20 H4 candles from OANDA, calculates:
// EMA9, EMA21, EMA50, RSI14, ATR14, MACD, Support, Resistance, H4 trend
// All fed into GPT-4o for a REAL chart-based analysis
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/analyze', async (req, res) => {
  const { pair, price } = req.body;
  const keys = getApiKeys();
  if (!keys.openai_key) return res.status(400).json({ error:'OpenAI key not configured' });

  // Step 1 — Fetch real candle data from OANDA
  let indCtx = '';
  let indicators = null;
  const oandaInstr = LABEL_TO_OANDA[pair] || pair;

  if (keys.oanda_key) {
    try {
      const [h1Res, h4Res] = await Promise.allSettled([
        oandaRequest(`/v3/instruments/${oandaInstr}/candles?count=50&granularity=H1&price=M`),
        oandaRequest(`/v3/instruments/${oandaInstr}/candles?count=20&granularity=H4&price=M`),
      ]);

      const h1 = h1Res.status==='fulfilled' ? h1Res.value?.candles || [] : [];
      const h4 = h4Res.status==='fulfilled' ? h4Res.value?.candles || [] : [];

      if (h1.length >= 10) {
        indicators = buildIndicators(h1, h4);
        const dp = ['XAU_USD','XAG_USD'].includes(oandaInstr) ? 2 : oandaInstr.includes('JPY') ? 3 : 5;
        const last5Str = indicators.last5.map((c,i) =>
          `  C${i+1}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} [${c.bull?'▲':'▼'}]`
        ).join('\n');

        indCtx = `

REAL OANDA CANDLE DATA (H1 — last 50 candles):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Price : ${price}
EMA 9         : ${indicators.ema9.toFixed(dp)}
EMA 21        : ${indicators.ema21.toFixed(dp)}
EMA 50        : ${indicators.ema50.toFixed(dp)}
RSI (14)      : ${indicators.rsi14} ${indicators.rsi14>70?'— OVERBOUGHT ⚠️':indicators.rsi14<30?'— OVERSOLD ⚠️':'— NEUTRAL'}
ATR (14)      : ${indicators.atr14.toFixed(dp)} (avg volatility per candle)
MACD          : ${indicators.macd} ${indicators.macd>0?'(bullish momentum)':'(bearish momentum)'}
EMA Alignment : ${indicators.emaAlignment}
H1 Trend      : ${indicators.trend}
H4 Trend      : ${indicators.h4Trend}
Resistance    : ${indicators.resistance.toFixed(dp)} (20-candle high)
Support       : ${indicators.support.toFixed(dp)} (20-candle low)

Last 5 H1 Candles:
${last5Str}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      }
    } catch {}
  }

  // Step 2 — GPT-4o analysis with full indicator context
  try {
    const openai = new OpenAI({ apiKey: keys.openai_key });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1200,
      messages: [{
        role: 'system',
        content: `You are a professional forex trading analyst for PrecisionTraderPro.
You receive REAL live candle data and technical indicators directly from OANDA.
Base your analysis ENTIRELY on this real data — not on general assumptions.
Be precise with price levels. Use ATR for realistic SL/TP distances.
Flag overbought/oversold RSI conditions. Respect EMA alignment for trend direction.
Never give a "BULLISH" bias if price is below EMA21 and EMA alignment is bearish.`,
      }, {
        role: 'user',
        content: `Analyze ${pair} at price ${price}.${indCtx}

Return EXACTLY these 10 lines (no extra text):
1. Market Bias: BULLISH / BEARISH / NEUTRAL
2. Confidence Score: X% (base on RSI, EMA alignment, H4 trend agreement)
3. Entry Zone: [specific price or range based on real support/resistance]
4. Stop Loss: [price — use ATR×1.5 distance minimum]
5. Take Profit: [price — aim for 1:2 or better R:R]
6. Risk/Reward: 1:X
7. Pattern: [name the H1 candle pattern or chart structure you see]
8. Key Support: [from real candle data]
9. Key Resistance: [from real candle data]
10. Recommendation: [one sentence — MUST reference the RSI/EMA data above]`,
      }],
    });
    res.json({ analysis: completion.choices[0].message.content, indicators });
  } catch (e) {
    res.status(500).json({ error: 'OpenAI error: ' + (e.response?.data?.error?.message || e.message) });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 2A — POSITION SIZER
// Auto-calculates lot size from: account balance + risk % + stop loss pips
// Uses real account balance from OANDA
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/trade/size', async (req, res) => {
  const { pair, entryPrice, stopLossPrice, riskPercent = 1 } = req.body;
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return res.status(400).json({ error:'OANDA not configured' });

  try {
    // Get real account balance
    const acctData = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
    const account  = acctData?.account;
    if (!account) return res.status(400).json({ error:'Could not fetch account data' });

    const balance  = parseFloat(account.balance);
    const currency = account.currency; // e.g. 'GBP'

    // Calculate pip distance of stop loss
    const oandaInstr = LABEL_TO_OANDA[pair] || pair;
    const pipSize    = PIP[oandaInstr] || 0.0001;
    const slPips     = Math.abs(parseFloat(entryPrice) - parseFloat(stopLossPrice)) / pipSize;
    if (slPips <= 0) return res.status(400).json({ error:'Invalid stop loss distance' });

    // Risk amount
    const riskAmount = balance * (parseFloat(riskPercent) / 100);

    // Pip value per unit (approximate — accurate for USD quote pairs)
    // For USD quote pairs: pip value = pipSize per unit
    // For JPY pairs: pip value = pipSize per unit (different scale)
    // XAU/USD: pip = 0.1, pip value per oz = $0.1
    let pipValuePerUnit = pipSize; // USD per unit per pip (approximate)
    if (oandaInstr === 'USD_JPY') pipValuePerUnit = 0.01 / parseFloat(entryPrice);
    if (oandaInstr === 'USD_CAD') pipValuePerUnit = 0.0001 / parseFloat(entryPrice);
    if (oandaInstr === 'XAU_USD') pipValuePerUnit = 0.1;

    // Units = Risk Amount / (SL pips × pip value per unit)
    const units = Math.floor(riskAmount / (slPips * pipValuePerUnit));

    // Round to nearest lot sizes
    const standardLots = (units / 100000).toFixed(2);
    const miniLots     = (units / 10000).toFixed(1);
    const microLots    = (units / 1000).toFixed(0);

    res.json({
      pair, entry: entryPrice, stopLoss: stopLossPrice,
      slPips: slPips.toFixed(1),
      riskPercent, riskAmount: riskAmount.toFixed(2), currency,
      balance: balance.toFixed(2),
      recommendedUnits: units,
      standardLots, miniLots, microLots,
      note: `Risk ${riskPercent}% of ${currency}${balance.toFixed(0)} = ${currency}${riskAmount.toFixed(2)} on ${slPips.toFixed(1)} pip stop`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 2B — DAILY LOSS LIMIT (protect account from blowing up in one day)
// Tracks daily realized P&L — warns and can block trades if limit hit
// ═════════════════════════════════════════════════════════════════════════════

// daily_pnl table is created in the DATABASE SCHEMA block near the top of this file
function getTodayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDailyPL() {
  const today = getTodayDate();
  const row = _stmtDailyPL.get(today);
  return row || { date: today, realized_pl: 0, trade_count: 0 };
}

function recordTradePL(pl) {
  const today = getTodayDate();
  _stmtRecordPL.run(today, pl, pl);
}

app.get('/api/trade/daily', async (req, res) => {
  try {
    const keys = getApiKeys();
    const daily = getDailyPL();

    let balance = 0, maxDailyLoss = 0;
    if (keys.oanda_key && keys.oanda_account) {
      try {
        const d = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
        balance = parseFloat(d?.account?.balance || 0);
      } catch {}
    }

    maxDailyLoss = balance * 0.03;
    const currentLoss = Math.min(0, daily.realized_pl);
    const limitHit    = Math.abs(currentLoss) >= maxDailyLoss && maxDailyLoss > 0;
    const usedPercent = maxDailyLoss > 0 ? Math.abs(currentLoss / maxDailyLoss * 100) : 0;

    res.json({
      date:         daily.date,
      realized_pl:  daily.realized_pl.toFixed(2),
      trade_count:  daily.trade_count,
      balance:      balance.toFixed(2),
      max_daily_loss: (-maxDailyLoss).toFixed(2),
      used_percent: usedPercent.toFixed(1),
      limit_hit:    limitHit,
      safe_to_trade: !limitHit,
      warning:      limitHit ? `⛔ Daily loss limit of ${maxDailyLoss.toFixed(2)} (3%) reached. Stop trading for today.` : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record P&L when frontend reports a closed trade
app.post('/api/trade/record', (req, res) => {
  const { pl } = req.body;
  if (isNaN(parseFloat(pl))) return res.status(400).json({ error:'Invalid pl value' });
  recordTradePL(parseFloat(pl));
  const daily = getDailyPL();
  res.json({ ok: true, today_pl: daily.realized_pl.toFixed(2), trade_count: daily.trade_count });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 3 — NEWS CALENDAR (Forex Factory + 2 fallback sources)
// ═════════════════════════════════════════════════════════════════════════════
let newsCache = [], newsCacheTime = 0;

async function fetchRealNews() {
  // Source 1: Forex Factory (best — real economic calendar)
  try {
    const r = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrecisionTraderPro/1.0)' },
    });
    const impactMap = { 'High Impact Expected':'HIGH', 'Medium Impact Expected':'MED', 'Low Impact Expected':'LOW' };
    const events = (r.data || [])
      .filter(e => ['High Impact Expected','Medium Impact Expected'].includes(e.impact))
      .sort((a,b) => new Date(a.date) - new Date(b.date))
      .slice(0, 15)
      .map(e => {
        const dt = new Date(e.date);
        return {
          time:     `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`,
          currency: e.country,
          impact:   impactMap[e.impact] || 'LOW',
          event:    e.title,
          forecast: e.forecast || '—',
          previous: e.previous || '—',
          actual:   e.actual   || '—',
          notes:    `${e.title} for ${e.country}.`,
          source:   'ForexFactory',
        };
      });
    if (events.length > 0) { newsCache = events; newsCacheTime = Date.now(); return events; }
  } catch {}

  // Source 2: investing.com calendar via open proxy (fallback)
  try {
    const r = await axios.get('https://economic-calendar.tradingview.com/events', {
      params: { from: new Date().toISOString().slice(0,10), to: new Date(Date.now()+7*86400000).toISOString().slice(0,10), countries: 'US,GB,EU,JP,AU,CA', importance: '2,3' },
      timeout: 6000, headers: { 'User-Agent':'Mozilla/5.0' }
    });
    if (r.data?.result?.length > 0) {
      const events = r.data.result.slice(0,12).map(e => ({
        time:     new Date(e.date).toUTCString().slice(17,22),
        currency: e.country,
        impact:   e.importance === 3 ? 'HIGH' : e.importance === 2 ? 'MED' : 'LOW',
        event:    e.title,
        forecast: e.forecast_value || '—',
        previous: e.previous_value || '—',
        actual:   e.actual_value   || '—',
        notes:    e.comment || `${e.title} for ${e.country}.`,
        source:   'TradingView',
      }));
      if (events.length > 0) { newsCache = events; newsCacheTime = Date.now(); return events; }
    }
  } catch {}

  // Return last cache if fresh enough (< 4 hours)
  if (newsCache.length > 0 && Date.now() - newsCacheTime < 4 * 3600 * 1000) return newsCache;

  // Static fallback (last resort)
  return [
    { time:'08:30', currency:'USD', impact:'HIGH', event:'Core CPI m/m',       forecast:'0.3%', previous:'0.4%', actual:'—', notes:'Key inflation gauge.', source:'Static' },
    { time:'09:00', currency:'EUR', impact:'MED',  event:'ECB President Speech',forecast:'—',   previous:'—',   actual:'—', notes:'Rate guidance signals.', source:'Static' },
    { time:'12:30', currency:'GBP', impact:'HIGH', event:'GDP q/q',            forecast:'0.1%', previous:'0.0%',actual:'—', notes:'Growth data.', source:'Static' },
    { time:'14:00', currency:'USD', impact:'HIGH', event:'FOMC Meeting Minutes',forecast:'—',   previous:'—',   actual:'—', notes:'Fed rate path signals.', source:'Static' },
    { time:'14:30', currency:'USD', impact:'MED',  event:'Crude Oil Inventories',forecast:'-1.2M',previous:'2.1M',actual:'—',notes:'Commodity impact.', source:'Static' },
    { time:'18:00', currency:'JPY', impact:'MED',  event:'BOJ Policy Rate',    forecast:'0.1%', previous:'0.1%',actual:'—', notes:'BOJ rate decision.', source:'Static' },
  ];
}

// Refresh news every 30 minutes (Forex Factory updates rarely)
fetchRealNews();
setInterval(fetchRealNews, 30 * 60 * 1000);

app.get('/api/news', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    if (force) { const data = await fetchRealNews(); return res.json(data); }
    res.json(newsCache.length > 0 ? newsCache : await fetchRealNews());
  } catch (e) {
    res.status(500).json({ error: e.message, events: [] });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TELEGRAM — Send alert + auto-detect chat ID
// ═════════════════════════════════════════════════════════════════════════════
// Send Telegram via native https (force IPv4 — axios IPv6 fails in this env)
function sendTelegramMsg(text) {
  const keys = getApiKeys();
  if (!keys.tg_token || !keys.tg_chat) return Promise.resolve({ ok:false, error:'Telegram not configured' });
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: keys.tg_chat, text });
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${keys.tg_token}/sendMessage`,
      method:   'POST',
      family:   4,           // ← force IPv4 (IPv6 blocked on this host)
      timeout:  10000,
      headers:  { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ ok:!!j.ok, result:j }); }
        catch { resolve({ ok:false, error: d }); }
      });
    });
    req.on('error',   (e) => resolve({ ok:false, error:e.message }));
    req.on('timeout', ()  => { req.destroy(); resolve({ ok:false, error:'timeout' }); });
    req.write(body);
    req.end();
  });
}

app.post('/api/telegram/send', async (req, res) => {
  try {
    const { message } = req.body;
    const r = await sendTelegramMsg(message);
    if (!r.ok) return res.status(r.error==='Telegram not configured'?400:500).json({ error:r.error });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auto-detect chat ID from getUpdates (call after user messages bot)
app.post('/api/telegram/setup', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.tg_token) return res.status(400).json({ error:'Telegram token not set' });
  try {
    const r = await axios.get(`https://api.telegram.org/bot${keys.tg_token}/getUpdates?offset=-5`, { timeout:8000 });
    const updates = r.data?.result || [];
    if (!updates.length) return res.status(404).json({ error:'No messages yet — send a message to your bot first' });
    const chatId = String(updates[updates.length-1].message?.chat?.id || updates[updates.length-1].channel_post?.chat?.id || '');
    if (!chatId) return res.status(404).json({ error:'Could not find chat ID' });
    // Save chat ID
    const stored = getStorageValue('ptp_keys') || {};
    stored.tg_chat = chatId;
    setStorageValue('ptp_keys', stored);
    invalidateKeysCache();
    // Send welcome message
    await sendTelegramMsg('✅ PrecisionTraderPro\nTelegram alerts ACTIVE! You will receive trade signals here automatically.');
    res.json({ ok:true, chat_id:chatId });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SIGNAL ENGINE — Scan → Telegram alert with APPROVE/REJECT → Execute
// Flow: AI scan every 5 min → send signal to Telegram with buttons
//       User taps ✅ APPROVE → trade placed on OANDA automatically
//       User taps ❌ REJECT  → signal logged as rejected, not traded
// ═════════════════════════════════════════════════════════════════════════════

// signals, auto_trades, execution_log, risk_events, journal_notes migrations,
// coach_reports and all indexes are created in the DATABASE SCHEMA block near
// the top of this file (before anything below could prepare statements against them)

// ── Frequently-used prepared statements (compiled once) ───────────────────────
const _stmtDailyPL = db.prepare('SELECT * FROM daily_pnl WHERE date = ?');
const _stmtRecordPL = db.prepare(`
  INSERT INTO daily_pnl (date, realized_pl, trade_count, updated_at)
  VALUES (?, ?, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    realized_pl = realized_pl + ?,
    trade_count = trade_count + 1,
    updated_at  = CURRENT_TIMESTAMP
`);
const _stmtConsecLosses = db.prepare(`
  SELECT realized_pl FROM signals WHERE status='CLOSED'
  ORDER BY closed_at DESC LIMIT 10
`);
const _stmtTodaySent = db.prepare(`
  SELECT COUNT(*) as c FROM signals
  WHERE date(created_at)=date('now') AND status IN ('PENDING','EXECUTED','APPROVED')
`);
const _stmtOpenTrades = db.prepare(
  `SELECT pair, direction FROM signals WHERE status='EXECUTED' AND closed_at IS NULL`
);
const _stmtPendingReconcile = db.prepare(
  `SELECT * FROM signals WHERE status='EXECUTED' AND closed_at IS NULL AND trade_id IS NOT NULL`
);
const _stmtOpenTradeCount = db.prepare(
  `SELECT COUNT(*) as c FROM signals WHERE status='EXECUTED' AND closed_at IS NULL`
);
const _stmtInsertRiskEvent = db.prepare(
  `INSERT INTO risk_events (event_type, detail, blocked_pair, action) VALUES (?,?,?,?)`
);
const _stmtTodayLosses = db.prepare(
  `SELECT COUNT(*) as c FROM signals WHERE status='CLOSED' AND realized_pl < 0 AND date(closed_at)=date('now')`
);

// ── Fix 3: Pair breaker prepared statements ───────────────────────────────────
const _stmtGetPairBreaker = db.prepare(
  `SELECT * FROM pair_breakers WHERE pair=? AND blocked_until > datetime('now')`
);
const _stmtSetPairBreaker = db.prepare(`
  INSERT INTO pair_breakers (pair, blocked_until, reason, loss_count)
  VALUES (?, datetime('now', '+24 hours'), ?, ?)
  ON CONFLICT(pair) DO UPDATE SET
    blocked_until = datetime('now', '+24 hours'),
    reason = excluded.reason,
    loss_count = excluded.loss_count,
    created_at = CURRENT_TIMESTAMP
`);
const _stmtPairConsecLosses = db.prepare(`
  SELECT realized_pl FROM signals WHERE status='CLOSED' AND pair=?
  ORDER BY closed_at DESC LIMIT 5
`);

// ── Fix 7: Immutable audit log ────────────────────────────────────────────────
let _lastAuditHash = '';
function writeAudit(action, data, actor = 'SYSTEM', entityId = null) {
  try {
    const payload  = JSON.stringify({ action, actor, entityId, data, ts: Date.now() });
    const rowHash  = crypto.createHash('sha256').update(_lastAuditHash + payload).digest('hex').slice(0, 16);
    db.prepare(
      `INSERT INTO audit_log (action, actor, entity_id, data, prev_hash, row_hash)
       VALUES (?,?,?,?,?,?)`
    ).run(action, actor, String(entityId || ''), JSON.stringify(data), _lastAuditHash, rowHash);
    _lastAuditHash = rowHash;
  } catch {}
}

// ── Fix 6: Structured AI decision logger ─────────────────────────────────────
const _stmtInsertAIDecision = db.prepare(`
  INSERT INTO ai_decisions
    (signal_id, pair, direction, model, calc_confidence, ai_confidence, ai_direction,
     ai_sl, ai_tp, decision, regime, session, adx, rsi_m30, spread_pips, score, flags,
     prompt_hash, latency_ms)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
function logAIDecision(fields) {
  try {
    _stmtInsertAIDecision.run(
      fields.signal_id || null, fields.pair, fields.direction, fields.model || 'gpt-4o',
      fields.calc_confidence, fields.ai_confidence, fields.ai_direction,
      fields.ai_sl || null, fields.ai_tp || null, fields.decision,
      fields.regime || null, fields.session || null, fields.adx || null,
      fields.rsi_m30 || null, fields.spread_pips || null, fields.score || null,
      JSON.stringify(fields.flags || []), fields.prompt_hash || null, fields.latency_ms || null
    );
  } catch {}
}

// ── Fix 8: Execution deduplication — in-memory lock ──────────────────────────
const _executingSignals = new Set();

// ── Fix 10: Regime persistence tracker ───────────────────────────────────────
const _regimeHistory = []; // rolling window of last 20 regime reads
function recordRegime(pair, regime) {
  _regimeHistory.push({ pair, regime, ts: Date.now() });
  if (_regimeHistory.length > 120) _regimeHistory.shift(); // keep ~10 pairs × 12 scans
}
function getRegimePersistence(pair, currentRegime) {
  const history = _regimeHistory.filter(r => r.pair === pair).slice(-8);
  if (history.length < 3) return {
    stable: false, count: history.length, score: 'LOW',
    note: `${currentRegime} too new — only ${history.length} reading(s), need 3+`,
  };
  const consecutive = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].regime === currentRegime) consecutive.push(history[i]);
    else break;
  }
  const count = consecutive.length;
  return {
    stable: count >= 3,
    count,
    score: count >= 6 ? 'HIGH' : count >= 3 ? 'MEDIUM' : 'LOW',
    note:  count >= 6 ? `${currentRegime} stable for ${count} scans` :
           count >= 3 ? `${currentRegime} emerging (${count} scans)` :
           `${currentRegime} new — low persistence`,
  };
}

// ── Fix 3: Pair-level circuit breaker ────────────────────────────────────────
function isPairBlocked(pair) {
  const row = _stmtGetPairBreaker.get(pair);
  return row ? { blocked: true, until: row.blocked_until, reason: row.reason } : { blocked: false };
}
function checkAndSetPairBreaker(pair) {
  const recent = _stmtPairConsecLosses.all(pair);
  let consec = 0;
  for (const t of recent) {
    if ((t.realized_pl || 0) < 0) consec++;
    else break;
  }
  if (consec >= 3) {
    _stmtSetPairBreaker.run(pair, `${consec} consecutive losses on ${pair}`, consec);
    writeAudit('PAIR_BREAKER_SET', { pair, consec }, 'SYSTEM', pair);
    sendTelegramMsg(`⚠️ Pair Breaker: ${pair} blocked 24h — ${consec} consecutive losses`)
      .catch(() => {});
    console.log(`[BREAKER] ${pair} blocked 24h — ${consec} consecutive losses`);
    return true;
  }
  return false;
}

// ── Fix 4: Correlation weights matrix ────────────────────────────────────────
// Empirical forex correlation for USD direction exposure
const CORR_WEIGHTS = {
  'EUR/USD': { USD_SHORT: 1.00 },
  'GBP/USD': { USD_SHORT: 0.85 },
  'AUD/USD': { USD_SHORT: 0.75 },
  'NZD/USD': { USD_SHORT: 0.65 },
  'USD/JPY': { USD_LONG:  1.00 },
  'USD/CAD': { USD_LONG:  0.80 },
  'USD/CHF': { USD_LONG:  0.85 },
  'XAU/USD': { USD_SHORT: 0.70 },
};

function getPortfolioHeat() {
  const open = db.prepare(`
    SELECT pair, direction, risk_pct FROM signals
    WHERE status='EXECUTED' AND closed_at IS NULL
  `).all();

  let totalPct = 0, usdLongEff = 0, usdShortEff = 0;
  for (const s of open) {
    const pct    = parseFloat(s.risk_pct || 1);
    const weights = CORR_WEIGHTS[s.pair] || {};
    const group   = USD_CORR_GROUP[s.pair]?.[s.direction];
    totalPct += pct;
    if (group === 'USD_LONG') {
      const w = weights.USD_LONG || 1.0;
      usdLongEff += pct * w;
    } else if (group === 'USD_SHORT' || (s.pair === 'XAU/USD' && s.direction === 'BUY')) {
      const w = weights.USD_SHORT || 1.0;
      usdShortEff += pct * w;
    }
  }

  const effectiveMax  = Math.max(usdLongEff, usdShortEff);
  const heatLevel     = effectiveMax > 4 ? 'CRITICAL' : effectiveMax > 2.5 ? 'HIGH' :
                        totalPct > 1.5 ? 'MEDIUM' : 'LOW';
  return {
    total_risk_pct:      parseFloat(totalPct.toFixed(2)),
    usd_long_effective:  parseFloat(usdLongEff.toFixed(2)),
    usd_short_effective: parseFloat(usdShortEff.toFixed(2)),
    open_positions:      open.length,
    heat_level:          heatLevel,
    safe_to_add:         heatLevel !== 'CRITICAL',
    warning:             heatLevel === 'CRITICAL' ?
      `Portfolio heat CRITICAL: ${effectiveMax.toFixed(1)}% effective exposure — DO NOT add positions` :
      heatLevel === 'HIGH' ?
      `Portfolio heat HIGH: ${effectiveMax.toFixed(1)}% effective exposure — trade smaller` : null,
  };
}

// ── Parse AI response ────────────────────────────────────────────────────────
function parseAIResponse(analysis) {
  const lines = analysis.split('\n').map(l => l.trim()).filter(Boolean);
  const result = { direction:'NEUTRAL', confidence:0, stopLoss:null, takeProfit:null };
  for (const line of lines) {
    const lo = line.toLowerCase();
    if (lo.includes('market bias')) {
      if (line.toUpperCase().includes('BULLISH')) result.direction = 'BUY';
      else if (line.toUpperCase().includes('BEARISH')) result.direction = 'SELL';
      else result.direction = 'NEUTRAL';
    }
    if (lo.includes('confidence score')) {
      const m = line.match(/(\d+)%/); if (m) result.confidence = parseInt(m[1]);
    }
    if (lo.startsWith('4') && lo.includes('stop loss')) {
      const m = line.match(/[\d]{1,5}\.[\d]{2,6}/g); if (m) result.stopLoss = parseFloat(m[0]);
    }
    if (lo.startsWith('5') && lo.includes('take profit')) {
      const m = line.match(/[\d]{1,5}\.[\d]{2,6}/g); if (m) result.takeProfit = parseFloat(m[0]);
    }
  }
  return result;
}

// ── Generic Telegram API call (IPv4, JSON body) ──────────────────────────────
function tgCall(endpoint, body) {
  const keys = getApiKeys();
  if (!keys.tg_token) return Promise.resolve({ ok:false });
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const opts = {
      hostname:'api.telegram.org', method:'POST', family:4, timeout:10000,
      path:`/bot${keys.tg_token}/${endpoint}`,
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(bodyStr) },
    };
    const req = https.request(opts, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch{ resolve({ok:false}); } });
    });
    req.on('error',()=>resolve({ok:false}));
    req.on('timeout',()=>{ req.destroy(); resolve({ok:false}); });
    req.write(bodyStr); req.end();
  });
}

// Helpers
const tgAnswerCbq = (id, text) => tgCall('answerCallbackQuery', { callback_query_id:id, text });
const tgEditMsg   = (msgId, text) => {
  const keys = getApiKeys();
  return tgCall('editMessageText', { chat_id:keys.tg_chat, message_id:msgId, text });
};
const tgSendButtons = (text, buttons) => {
  const keys = getApiKeys();
  return tgCall('sendMessage', { chat_id:keys.tg_chat, text, reply_markup:{ inline_keyboard:buttons } });
};

// ── FIX 1: Recalculate risk at execution time ─────────────────────────────────
// Fetches fresh quote, checks price drift, recalculates SL/TP/lots with current data
async function recalcAtExecution(signal, keys) {
  const oandaInstr = LABEL_TO_OANDA[signal.pair] || signal.pair.replace('/','_');
  const dp         = ['XAU_USD','XAG_USD'].includes(oandaInstr) ? 2 : oandaInstr.includes('JPY') ? 3 : 5;
  const pipSize    = PIP[oandaInstr] || 0.0001;
  const isBuy      = signal.direction === 'BUY';

  // Max allowable drift before rejection (pips)
  const maxDriftPips = oandaInstr === 'XAU_USD' ? 150 : 20;

  // 1 — Fresh quote from OANDA pricing
  const priceR = await oandaRequest(
    `/v3/accounts/${keys.oanda_account}/pricing?instruments=${oandaInstr}`
  );
  const priceData = priceR?.prices?.[0];
  if (!priceData) return { blocked: true, reason: 'Could not fetch fresh quote at execution time' };

  const freshBid   = parseFloat(priceData.bids?.[0]?.price || 0);
  const freshAsk   = parseFloat(priceData.asks?.[0]?.price || 0);
  if (!freshBid || !freshAsk) return { blocked: true, reason: 'Invalid fresh quote (bid/ask zero)' };

  const freshMid   = (freshBid + freshAsk) / 2;
  const freshSpread = freshAsk - freshBid;
  const freshEntry  = isBuy ? freshAsk : freshBid; // fill price direction
  const spreadPips  = freshSpread / pipSize;

  // 2 — Price drift check
  const signalPrice = parseFloat(signal.entry_price);
  const driftPips   = Math.abs(freshMid - signalPrice) / pipSize;
  if (driftPips > maxDriftPips) {
    return {
      blocked: true,
      reason: `Price drift too large: ${driftPips.toFixed(1)} pips (max ${maxDriftPips}). Signal stale — regenerate.`,
      driftPips,
    };
  }

  // 3 — Spread check at execution moment
  // ATR from scan cache, fallback to SL distance / 2.0 (SL is ~1.5-2× ATR by design)
  const slDistRaw   = Math.abs(parseFloat(signal.stop_loss) - signalPrice);
  const atrFallback = slDistRaw > 0 ? slDistRaw / 1.8 : pipSize * 15;
  const atr = h1AtrCache[oandaInstr] || atrFallback;
  if (atr > 0 && freshSpread / atr > 0.30) {
    return {
      blocked: true,
      reason: `Spread ${spreadPips.toFixed(1)} pips too wide at execution (>30% of ATR ${(atr/pipSize).toFixed(1)} pips)`,
      spreadPips,
    };
  }

  // 4 — Shift SL/TP by the same delta as price moved (preserves risk structure)
  const priceDelta   = freshMid - signalPrice;
  const newSL        = parseFloat((signal.stop_loss  + priceDelta).toFixed(dp));
  const newTP        = parseFloat((signal.take_profit + priceDelta).toFixed(dp));
  const newSlPips    = Math.abs(freshEntry - newSL) / pipSize;
  if (newSlPips < 2) return { blocked: true, reason: 'SL distance < 2 pips after price drift adjustment' };

  // 5 — Fresh balance + recalculate lot size
  const acctR   = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
  const balance = parseFloat(acctR?.account?.balance || 0);
  if (!balance) return { blocked: true, reason: 'Could not fetch account balance at execution time' };

  const riskPct    = parseFloat(signal.risk_pct || 1);
  const riskAmt    = balance * (riskPct / 100);
  let   pipVal     = pipSize;
  if (oandaInstr === 'USD_JPY') pipVal = 0.01 / freshMid;
  if (oandaInstr === 'USD_CAD') pipVal = 0.0001 / freshMid;
  if (oandaInstr === 'XAU_USD') pipVal = 0.1;

  const consecLoss = getConsecutiveLosses();
  const timeFactor = getTimeBasedSizeFactor();
  const lossFactor = consecLoss === 1 ? 0.50 : consecLoss >= 2 ? 0.25 : 1.0;
  const sizeFactor = Math.min(lossFactor, timeFactor);
  const newUnits   = Math.floor(riskAmt / (newSlPips * pipVal) * sizeFactor);
  if (newUnits < 100) return { blocked: true, reason: `Calculated units (${newUnits}) too small after recalculation` };

  const newLots = (newUnits / 100000).toFixed(2);
  const newRR   = Math.abs(freshEntry - newTP) / Math.abs(freshEntry - newSL);
  if (newRR < 1.5) return { blocked: true, reason: `R:R ${newRR.toFixed(2)} too low after price drift` };

  return {
    blocked:    false,
    entry:      freshEntry,
    stopLoss:   newSL,
    takeProfit: newTP,
    units:      newUnits,
    lots:       newLots,
    riskAmt,
    balance,
    driftPips,
    spreadPips,
    slPips:     newSlPips.toFixed(1),
    tpPips:     (Math.abs(freshEntry - newTP) / pipSize).toFixed(1),
    dp,
  };
}

// ── Execute an approved signal on OANDA ──────────────────────────────────────
async function executeSignal(signal) {
  // FIX 8: Deduplication — in-memory lock prevents double execution
  if (_executingSignals.has(signal.id)) {
    console.log(`[EXEC] Signal #${signal.id} already executing — duplicate prevented`);
    return;
  }
  _executingSignals.add(signal.id);

  try {
    await _doExecuteSignal(signal);
  } finally {
    _executingSignals.delete(signal.id);
  }
}

async function _doExecuteSignal(signal) {
  const keys       = getApiKeys();
  const oandaInstr = LABEL_TO_OANDA[signal.pair] || signal.pair.replace('/','_');

  // ── RISK GOVERNOR CHECK — hard block before execution ────────────────────
  const gov = await checkRiskGovernors(signal);
  if (!gov.allowed) {
    db.prepare(`UPDATE signals SET status='BLOCKED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(signal.id);
    const reasons = gov.reasons.join('\n• ');
    const blockMsg =
`⛔ EXECUTION BLOCKED — Signal #${signal.id}
${signal.pair} ${signal.direction} ${signal.confidence}%

Risk Governor:
• ${reasons}

Review your risk position before resuming.`;
    if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id, blockMsg).catch(() => sendTelegramMsg(blockMsg));
    else await sendTelegramMsg(blockMsg);
    writeAudit('EXECUTION_BLOCKED', { signal_id: signal.id, pair: signal.pair, reasons: gov.reasons });
    console.log(`[GOVERNOR] ⛔ Blocked #${signal.id} ${signal.pair}: ${reasons}`);
    return;
  }

  // ── FIX 1: Recalculate SL/TP/lots with CURRENT market data ───────────────
  let exec;
  try {
    exec = await recalcAtExecution(signal, keys);
  } catch(e) {
    exec = { blocked: true, reason: `Recalc error: ${e.message}` };
  }

  if (exec.blocked) {
    db.prepare(`UPDATE signals SET status='BLOCKED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(signal.id);
    const msg = `⛔ BLOCKED AT EXECUTION — Signal #${signal.id}\n${signal.pair} ${signal.direction}\n\n${exec.reason}`;
    if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id, msg).catch(() => sendTelegramMsg(msg));
    else await sendTelegramMsg(msg);
    writeAudit('EXECUTION_RECALC_BLOCKED', { signal_id: signal.id, pair: signal.pair, reason: exec.reason });
    console.log(`[EXEC] Blocked #${signal.id} at recalc: ${exec.reason}`);
    return;
  }

  const dp       = exec.dp;
  const pipSize  = PIP[oandaInstr] || 0.0001;
  const isBuy    = signal.direction === 'BUY';
  const driftNote = exec.driftPips > 0.5 ? ` [drift ${exec.driftPips.toFixed(1)} pips]` : '';

  try {
    const tradeUnits  = isBuy ? exec.units : -exec.units;
    const orderResult = await oandaRequest(`/v3/accounts/${keys.oanda_account}/orders`, 'POST', {
      order: {
        type:'MARKET', instrument:oandaInstr, units:String(tradeUnits),
        stopLossOnFill:  { price: exec.stopLoss.toFixed(dp),  timeInForce:'GTC' },
        takeProfitOnFill:{ price: exec.takeProfit.toFixed(dp), timeInForce:'GTC' },
      }
    });

    const filled   = orderResult?.orderFillTransaction;
    // If no fill transaction, OANDA may have rejected or queued — record but flag
    const orderId  = filled?.id || orderResult?.orderCreateTransaction?.id || 'UNKNOWN';
    const tradeId  = filled?.tradeOpened?.tradeID || null;
    const filledPx = parseFloat(filled?.price || exec.entry);

    // Detect if order was rejected (no fill, but also no trade opened)
    if (!filled && !orderResult?.orderFillTransaction) {
      const rejectReason = orderResult?.orderRejectTransaction?.rejectReason || 'UNKNOWN_REJECTION';
      db.prepare(`UPDATE signals SET status='FAILED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(signal.id);
      const failMsg = `❌ ORDER REJECTED — Signal #${signal.id}\n${signal.pair} ${signal.direction}\nReason: ${rejectReason}`;
      if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id, failMsg).catch(() => sendTelegramMsg(failMsg));
      else await sendTelegramMsg(failMsg);
      writeAudit('ORDER_REJECTED', { signal_id: signal.id, pair: signal.pair, reason: rejectReason });
      console.error(`[EXEC] Order rejected #${signal.id}: ${rejectReason}`);
      return;
    }

    // Update local DB with execution-time values
    db.prepare(`
      UPDATE signals SET
        status='EXECUTED', oanda_order_id=?, trade_id=?, filled_price=?,
        stop_loss=?, take_profit=?, units=?, lots=?, risk_amount=?,
        sl_pips=?, tp_pips=?, actioned_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(orderId, tradeId, filledPx, exec.stopLoss, exec.takeProfit, exec.units,
           exec.lots, exec.riskAmt, exec.slPips, exec.tpPips, signal.id);

    recordTradePL(0);
    writeAudit('TRADE_EXECUTED', {
      signal_id: signal.id, pair: signal.pair, direction: signal.direction,
      entry: filledPx, sl: exec.stopLoss, tp: exec.takeProfit,
      units: exec.units, drift_pips: exec.driftPips,
    });

    // Slippage tracking
    const slippagePips = Math.abs(filledPx - exec.entry) / pipSize;
    const slippageDir  = (isBuy ? filledPx > exec.entry : filledPx < exec.entry) ? 'NEGATIVE' : 'POSITIVE';
    db.prepare(`INSERT INTO execution_log
      (signal_id, pair, session, expected_px, actual_px, slippage_pips, slippage_dir, spread_at_entry, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      signal.id, signal.pair, getSession(),
      exec.entry, filledPx, slippagePips, slippageDir,
      exec.spreadPips, Math.round(getOandaAvgLatency())
    );
    if (slippagePips > 3) console.warn(`[SLIPPAGE] ${signal.pair} ${slippageDir} ${slippagePips.toFixed(1)} pips`);

    const msg =
`✅ TRADE EXECUTED — Signal #${signal.id}

Pair:       ${signal.pair}
Direction:  ${signal.direction} ${signal.direction==='BUY'?'▲':'▼'}
Confidence: ${signal.confidence}%
Entry:      ${filledPx.toFixed(dp)}${driftNote}
Stop Loss:  ${exec.stopLoss.toFixed(dp)} (-${exec.slPips} pips)
Take Profit:${exec.takeProfit.toFixed(dp)} (+${exec.tpPips} pips)
Size:       ${exec.lots} lots (${exec.units.toLocaleString()} units)
Risk:       ${signal.risk_pct}% = $${exec.riskAmt.toFixed(0)} of $${exec.balance.toFixed(0)}
Spread:     ${exec.spreadPips.toFixed(1)} pips at fill
OANDA ID:   ${orderId}`;
    if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id, msg).catch(() => sendTelegramMsg(msg));
    else await sendTelegramMsg(msg);
    console.log(`[SIGNAL] ✅ Executed #${signal.id} ${signal.pair} ${signal.direction} @ ${filledPx.toFixed(dp)}${driftNote}`);

  } catch(e) {
    db.prepare(`UPDATE signals SET status='FAILED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(signal.id);
    const errMsg = `❌ EXECUTION FAILED — Signal #${signal.id}\n${signal.pair} ${signal.direction}\nError: ${e.message}`;
    if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id, errMsg).catch(() => sendTelegramMsg(errMsg));
    else await sendTelegramMsg(errMsg);
    writeAudit('EXECUTION_ERROR', { signal_id: signal.id, pair: signal.pair, error: e.message });
    console.error(`[SIGNAL] Execute failed #${signal.id}:`, e.message);
  }
}

// ── Telegram callback poller — listens for button taps ───────────────────────
let tgOffset = 0;
async function pollTgCallbacks() {
  const keys = getApiKeys();
  if (!keys.tg_token || !keys.tg_chat) return;
  return new Promise((resolve) => {
    const qs = `offset=${tgOffset}&timeout=0&allowed_updates=%5B%22callback_query%22%2C%22message%22%5D`;
    const opts = {
      hostname:'api.telegram.org', method:'GET', family:4, timeout:12000,
      path:`/bot${keys.tg_token}/getUpdates?${qs}`,
    };
    const req = https.request(opts, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end', async () => {
        try {
          const data = JSON.parse(d);
          if (!data.ok || !data.result?.length) { resolve(); return; }
          for (const upd of data.result) {
            tgOffset = Math.max(tgOffset, upd.update_id+1);

            // FIX 8 — Handle text commands from Telegram
            const txtMsg = upd.message?.text?.trim().toUpperCase();
            if (txtMsg === 'FLATTEN ALL' || txtMsg === 'EMERGENCY STOP') {
              await sendTelegramMsg('🚨 Emergency command received. Flattening all positions...');
              emergencyFlatten('Telegram command').catch(console.error);
              continue;
            }
            if (txtMsg === 'STATUS') {
              const daily  = getDailyPL();
              const consec = getConsecutiveLosses();
              const avgLat = getOandaAvgLatency();
              const s = getStorageValue('autotrade_settings') || {};
              await sendTelegramMsg(
`📊 PrecisionTraderPro Status
Scanner: ${s.enabled ? 'ON' : 'OFF'}
Mode: ${s.auto_execute ? '⚡ AUTO-EXECUTE' : '👤 Manual approval'}
Daily P&L: ${daily.realized_pl.toFixed(2)}
Consecutive losses: ${consec}
OANDA latency: ${avgLat.toFixed(0)}ms
Price source: ${priceSource}`
              );
              continue;
            }
            if (txtMsg === 'AUTO ON') {
              const s = getStorageValue('autotrade_settings') || {};
              s.auto_execute = true;
              setStorageValue('autotrade_settings', s);
              writeAudit('SETTINGS_CHANGED', { auto_execute: true }, 'TELEGRAM');
              await sendTelegramMsg('⚡ Auto-execute ENABLED\nThe system will now trade automatically without asking for approval.');
              continue;
            }
            if (txtMsg === 'AUTO OFF') {
              const s = getStorageValue('autotrade_settings') || {};
              s.auto_execute = false;
              setStorageValue('autotrade_settings', s);
              writeAudit('SETTINGS_CHANGED', { auto_execute: false }, 'TELEGRAM');
              await sendTelegramMsg('👤 Auto-execute DISABLED\nThe system will now send APPROVE / REJECT buttons for every signal.');
              continue;
            }

            // RESULTS / RESULTS 48 / RESULTS 7
            if (txtMsg.startsWith('RESULTS')) {
              const parts = txtMsg.split(' ');
              const hours = parseInt(parts[1]) * (parts[1] === '7' ? 24 : 1) || 24;
              const label = hours <= 24 ? '24h' : hours <= 48 ? '48h' : `${hours/24}d`;

              const trades = db.prepare(`
                SELECT pair, direction, confidence, realized_pl, actual_pips,
                       exit_reason, duration_mins, entry_price, exit_price,
                       stop_loss, take_profit
                FROM signals
                WHERE status='CLOSED'
                  AND closed_at >= datetime('now', '-${hours} hours')
                ORDER BY closed_at DESC
              `).all();

              if (!trades.length) {
                await sendTelegramMsg(`📊 No closed trades in the last ${label}.`);
                continue;
              }

              const wins   = trades.filter(t => (t.realized_pl || 0) > 0);
              const losses = trades.filter(t => (t.realized_pl || 0) < 0);
              const totalPL= trades.reduce((s, t) => s + (t.realized_pl || 0), 0);
              const winRate= Math.round(wins.length / trades.length * 100);
              const avgDur = trades.length
                ? Math.round(trades.reduce((s,t) => s + (t.duration_mins||0), 0) / trades.length)
                : 0;
              const durStr = avgDur < 60 ? `${avgDur}m` : `${(avgDur/60).toFixed(1)}h`;

              const tradeLines = trades.map(t => {
                const icon = (t.realized_pl||0) > 0 ? '✅' : (t.realized_pl||0) < 0 ? '❌' : '➖';
                const pl   = t.realized_pl != null ? `${t.realized_pl >= 0 ? '+' : ''}${parseFloat(t.realized_pl).toFixed(2)}` : 'pending';
                const pips = t.actual_pips != null ? ` (${parseFloat(t.actual_pips) >= 0 ? '+' : ''}${parseFloat(t.actual_pips).toFixed(1)} pips)` : '';
                const exit = t.exit_reason ? ` — ${t.exit_reason.replace(/_/g,' ')}` : '';
                const dur  = t.duration_mins ? ` [${t.duration_mins < 60 ? t.duration_mins+'m' : (t.duration_mins/60).toFixed(1)+'h'}]` : '';
                return `${icon} ${t.pair} ${t.direction} ${t.confidence}%  $${pl}${pips}${exit}${dur}`;
              }).join('\n');

              await sendTelegramMsg(
`📊 RESULTS — Last ${label}
━━━━━━━━━━━━━━━━━━━━
Trades:   ${trades.length}  (${wins.length}W / ${losses.length}L)
Win Rate: ${winRate}%
Total P&L: ${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}
Avg Duration: ${durStr}

${tradeLines}`
              );
              continue;
            }

            // LESSONS — show what the system has learned so far
            if (txtMsg === 'LESSONS') {
              const totalClosed = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='CLOSED'`).get().c;
              if (totalClosed === 0) {
                await sendTelegramMsg('📚 No closed trades yet.\n\nEvery time a trade closes the system records all entry conditions and updates its statistical model.\n\nPatterns emerge after:\n• 10+ trades: early observations\n• 20+ trades per condition: confirmed adjustments\n• 50+ trades: reliable analysis\n\nType REPORT anytime to see current state.');
                continue;
              }
              // Show conditions with meaningful data (LEARN_MIN_LESSON+)
              const meaningful = db.prepare(`
                SELECT condition, trades, wins, losses, win_rate, total_pl
                FROM condition_stats WHERE trades >= ${LEARN_MIN_LESSON}
                ORDER BY ABS(win_rate - 50) DESC LIMIT 12
              `).all();
              const allCount = db.prepare(`SELECT COUNT(*) as c FROM condition_stats`).get().c;

              let msg = `📚 LEARNING ENGINE STATUS\n━━━━━━━━━━━━━━━━━━━━\n`;
              msg += `Closed trades: ${totalClosed}\n`;
              msg += `Conditions tracked: ${allCount}\n`;
              msg += `Conditions with ${LEARN_MIN_LESSON}+ data: ${meaningful.length}\n`;
              msg += `Adjustment threshold: ${LEARN_MIN_ADJUST} trades\n`;

              if (meaningful.length > 0) {
                msg += `\n🔬 PATTERNS EMERGING (${LEARN_MIN_LESSON}+ trades):\n`;
                for (const c of meaningful) {
                  const icon = c.win_rate >= 65 ? '✅' : c.win_rate <= 40 ? '🔴' : '➖';
                  const adj  = c.trades >= LEARN_MIN_ADJUST
                    ? (c.win_rate > 68 ? ' → +bonus' : c.win_rate < 38 ? ' → -penalty' : ' → no adj')
                    : ` → (${LEARN_MIN_ADJUST - c.trades} more needed)`;
                  msg += `${icon} ${c.condition}: ${c.win_rate}%WR (${c.trades} trades)${adj}\n`;
                }
              } else {
                msg += `\nNo condition has ${LEARN_MIN_LESSON}+ trades yet.\nAll conditions are being tracked — keep trading.\n`;
              }
              msg += `\nType REPORT for full statistical analysis.`;
              await sendTelegramMsg(msg);
              continue;
            }

            if (txtMsg === 'REPORT') {
              const totalClosed = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='CLOSED'`).get().c;
              await sendTelegramMsg(`📊 Running pattern analysis on ${totalClosed} trades...`);
              await runPatternAnalysis(totalClosed);
              continue;
            }

            const cbq = upd.callback_query;
            if (!cbq?.data) continue;
            const parts    = cbq.data.split('_');
            const action   = parts[0];              // 'approve' or 'reject'
            const signalId = parseInt(parts[1]);
            if (!signalId) continue;
            const sig = db.prepare('SELECT * FROM signals WHERE id=?').get(signalId);
            if (!sig || sig.status !== 'PENDING') {
              await tgAnswerCbq(cbq.id, 'Signal already processed');
              continue;
            }
            if (action === 'approve') {
              await tgAnswerCbq(cbq.id, '✅ Executing trade...');
              writeAudit('SIGNAL_APPROVE', { signal_id: sig.id, pair: sig.pair, confidence: sig.confidence }, 'TELEGRAM', sig.id);
              await executeSignal(sig);
            } else if (action === 'reject') {
              await tgAnswerCbq(cbq.id, '❌ Signal rejected');
              db.prepare(`UPDATE signals SET status='REJECTED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(sig.id);
              writeAudit('SIGNAL_REJECT', { signal_id: sig.id, pair: sig.pair, confidence: sig.confidence }, 'TELEGRAM', sig.id);
              if (sig.tg_message_id) await tgEditMsg(sig.tg_message_id,
`❌ REJECTED — Signal #${sig.id}

Pair:       ${sig.pair}
Direction:  ${sig.direction}
Confidence: ${sig.confidence}%
Entry:      ${sig.entry_price?.toFixed(5)}
Stop Loss:  ${sig.stop_loss?.toFixed(5)}
Take Profit:${sig.take_profit?.toFixed(5)}

You rejected this trade.`);
              console.log(`[SIGNAL] ❌ Rejected #${sig.id} ${sig.pair}`);
            }
          }
        } catch(e) { console.error('[TG POLL]', e.message); }
        resolve();
      });
    });
    req.on('error', ()=>resolve());
    req.on('timeout',()=>{ req.destroy(); resolve(); });
    req.end();
  });
}
// Poll for button taps every 4 seconds
setInterval(()=>{ pollTgCallbacks().catch(()=>{}); }, 4000);

// ── AI Scanner — finds high-confidence setups every 5 min ────────────────────
let autoScanning = false;

async function runAutoScan() {
  if (autoScanning) return;
  const settings = getStorageValue('autotrade_settings') || { enabled:true, auto_execute:true, threshold:85, risk_pct:1, min_score:9 };
  if (!settings.enabled) return;

  const minScore  = parseInt(settings.min_score  || 9);   // out of 17 checks
  const riskPct   = parseFloat(settings.risk_pct || 1);
  // No daily signal cap — every valid setup is sent

  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return; // only OANDA needed now

  autoScanning = true;
  const session = getSession();
  console.log(`[SCAN] Starting precision scan — session: ${session}`);

  // ── Pre-scan system health checks ────────────────────────────────────────
  const ddVelocity = checkDrawdownVelocity();
  if (ddVelocity.velocity === 'RAPID') {
    console.log(`[SCAN] ⛔ Rapid drawdown detected — ${ddVelocity.warning}`);
    autoScanning = false; return; // halt scan during rapid DD
  }
  const freqCheck = checkSignalFrequencyAnomaly();
  if (freqCheck.anomaly) console.log(`[SCAN] ⚠️ ${freqCheck.warning}`);
  const confDrift = checkConfidenceDrift();
  if (confDrift.drift) console.log(`[SCAN] ⚠️ ${confDrift.warning}`);

  // Pre-fetch news for blackout check
  const currentNews = newsCache || [];

  const scanPairs = [
    // ── Tier 1: Major USD (highest liquidity) ────────────────────────
    'EUR_USD','GBP_USD','USD_JPY','USD_CHF','USD_CAD','AUD_USD','NZD_USD',
    // ── Tier 1: EUR crosses ──────────────────────────────────────────
    'EUR_GBP','EUR_JPY','EUR_CHF','EUR_AUD','EUR_CAD','EUR_NZD',
    // ── Tier 1: GBP crosses ──────────────────────────────────────────
    'GBP_JPY','GBP_CHF','GBP_AUD','GBP_CAD','GBP_NZD',
    // ── Tier 1: AUD crosses ──────────────────────────────────────────
    'AUD_JPY','AUD_CAD','AUD_CHF','AUD_NZD',
    // ── Tier 1: Other liquid crosses ─────────────────────────────────
    'CAD_JPY','NZD_JPY','CHF_JPY','NZD_CAD','NZD_CHF',
    // ── Tier 1: Commodities ───────────────────────────────────────────
    'XAU_USD','XAG_USD',
    // ── Tier 2: Scandinavian ─────────────────────────────────────────
    'USD_SEK','USD_NOK','USD_DKK','EUR_SEK','EUR_NOK',
    // ── Tier 2: Emerging markets ──────────────────────────────────────
    'USD_ZAR','USD_MXN','USD_TRY','USD_SGD','USD_HKD','USD_CNH',
    'USD_PLN','EUR_PLN','EUR_TRY','GBP_ZAR','EUR_ZAR',
    // ── Tier 2: Asian crosses ─────────────────────────────────────────
    'SGD_JPY','AUD_SGD',
    // ── Tier 2: Precious metals ───────────────────────────────────────
    'XPT_USD','XPD_USD',
  ];

  for (const instr of scanPairs) {
    try {

      const existPending = db.prepare(`SELECT id FROM signals WHERE pair=? AND status='PENDING'`).get(instr.replace('_','/'));
      if (existPending) continue;

      const label = instr.replace('_', '/');

      // FIX 3: Per-pair circuit breaker check
      const pairBlock = isPairBlocked(label);
      if (pairBlock.blocked) {
        console.log(`[SCAN] ${label}: Pair breaker active until ${pairBlock.until} — ${pairBlock.reason}`);
        continue;
      }
      const price = parseFloat(priceCache[label] || 0);
      if (!price) continue;

      // ── Fetch all 6 timeframes in parallel: W1 → D1 → H4 → H2 → M30 → M5 ──
      const [w1r, d1r, h4r, h2r, m30r, m5r] = await Promise.allSettled([
        oandaRequest(`/v3/instruments/${instr}/candles?count=30&granularity=W&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=60&granularity=D&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=250&granularity=H4&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=100&granularity=H2&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=100&granularity=M30&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=50&granularity=M5&price=M`),
      ]);
      const w1c  = w1r.status==='fulfilled'  ? w1r.value?.candles||[]  : [];
      const d1c  = d1r.status==='fulfilled'  ? d1r.value?.candles||[]  : [];
      const h4c  = h4r.status==='fulfilled'  ? h4r.value?.candles||[]  : [];
      const h2c  = h2r.status==='fulfilled'  ? h2r.value?.candles||[]  : [];
      const m30c = m30r.status==='fulfilled' ? m30r.value?.candles||[] : [];
      const m5c  = m5r.status==='fulfilled'  ? m5r.value?.candles||[]  : [];
      if (h4c.length < 26) continue;

      // FIX 1 — Only build indicators on COMPLETED candles
      const h4cc  = completedCandles(h4c);
      const h2cc  = completedCandles(h2c);
      const m30cc = completedCandles(m30c);
      const m5cc  = completedCandles(m5c);
      if (h4cc.length < 26) continue;

      // FIX 9 — Stale feed check before scanning this pair
      if (isFeedStale(label)) {
        console.log(`[SCAN] ${label}: Data feed stale — skipped`);
        continue;
      }

      // ── Build indicators for each timeframe (top-down) ───────────────
      const indH4  = buildIndicators(h4cc, []);
      const indH2  = buildIndicators(h2cc.length>5 ? h2cc : h4cc, h4cc);
      const indM30 = buildIndicators(m30cc.length>5 ? m30cc : h2cc, h2cc);
      const indM5  = buildIndicators(m5cc.length>5 ? m5cc : m30cc.slice(-15), m30cc);

      // Cache ATR (use M30 ATR for trailing stops — entry timeframe)
      h1AtrCache[instr] = indM30.atr14;

      // ── FILTER 1: ATR expansion — reject during volatility explosions ─
      if (isATRExpanded(h4cc, 1.8)) {
        console.log(`[SCAN] ${label}: H4 ATR expanded (volatility spike) — skipped`);
        continue;
      }

      // ── FILTER 2: Spread check — reject if spread > 25% of H4 ATR ───
      if (!isSpreadAcceptable(label, indH4.atr14)) {
        const sp = spreadCache[label]?.toFixed(5) || '?';
        console.log(`[SCAN] ${label}: Spread ${sp} too wide vs ATR ${indH4.atr14.toFixed(5)} — skipped`);
        continue;
      }

      // ── FIX 7: Market gap — abnormal candle open vs previous close ────
      if (hasMarketGap(h4cc, indH4.atr14)) {
        console.log(`[SCAN] ${label}: H4 market gap detected — skipped`);
        continue;
      }

      // ── FIX 6: EMA slope — flat EMA = fake trend ─────────────────────
      const emaSlope = Math.abs(indH4.emaSlope || 0);
      if (emaSlope < 1.0) {
        console.log(`[SCAN] ${label}: H4 EMA flat (slope ${emaSlope.toFixed(2)}) — skipped`);
        continue;
      }

      // ── Determine direction from H4 EMA alignment (master TF) ────────
      const aiDirection = indH4.emaAlignment === 'BULLISH' ? 'BUY'
                        : indH4.emaAlignment === 'BEARISH' ? 'SELL'
                        : null;
      if (!aiDirection) {
        console.log(`[SCAN] ${label}: H4 EMA mixed — skipped`);
        continue;
      }

      // ── STAGE 1: Market Regime — reject untradeable states ───────────
      const regime = classifyRegime(indH4, indM30, h4cc);
      if (!regime.tradeable) {
        console.log(`[SCAN] ${label}: Regime ${regime.regime} — ${regime.note}`);
        continue;
      }
      console.log(`[SCAN] ${label}: Regime ${regime.regime} (ATR ratio ${regime.atrRatio?.toFixed(2)}) ✓`);

      // ── STAGE 1: Candle Quality — reject spike/doji/exhaustion ───────
      const candleQuality = inspectCandleQuality(h4cc, indH4.atr14);
      if (!candleQuality.ok) {
        console.log(`[SCAN] ${label}: Candle quality fail — ${candleQuality.issues.join('; ')}`);
        continue;
      }

      // ── STAGE 1: EMA Convergence — trend draining, EMAs closing together ─
      const emaConv = detectEMAConvergence(indH4);
      if (emaConv.converging && emaConv.severity === 'HIGH') {
        console.log(`[SCAN] ${label}: EMA convergence (HIGH) — ${emaConv.note}`);
        continue;
      }

      // ── STAGE 2: Momentum weakening check ────────────────────────────
      const momentum = detectMomentumWeakening(indH4, indM30);
      if (momentum.weakening) {
        console.log(`[SCAN] ${label}: Momentum weakening — ${momentum.issues.join('; ')}`);
        continue;
      }

      // ── STAGE 4: Portfolio heat check — don't add risk to hot book ───
      const heat = getPortfolioHeat();
      if (!heat.safe_to_add) {
        console.log(`[SCAN] ${label}: Portfolio heat CRITICAL (${heat.total_risk_pct}%) — scan blocked`);
        continue;
      }

      // ── PIPELINE STAGE 1: HTF Trend — W1 + D1 + H4 must agree (≥2/3) ───
      let w1Trend = 'UNKNOWN', d1Trend = 'UNKNOWN';

      if (w1c.length >= 5) {
        const w1cc = completedCandles(w1c);
        if (w1cc.length >= 5) {
          const cls = w1cc.map(c => parseFloat(c.mid.c));
          w1Trend   = cls[cls.length - 1] > calcEMA(cls, Math.min(21, cls.length)) ? 'BULLISH' : 'BEARISH';
        }
      }
      if (d1c.length >= 10) {
        const d1cc = completedCandles(d1c);
        if (d1cc.length >= 10) {
          const cls = d1cc.map(c => parseFloat(c.mid.c));
          d1Trend   = cls[cls.length - 1] > calcEMA(cls, Math.min(21, cls.length)) ? 'BULLISH' : 'BEARISH';
        }
      }

      // Count HTF votes: W1, D1, H4
      const htfBull = [w1Trend, d1Trend, indH4.trend].filter(t => t === 'BULLISH').length;
      const htfBear = [w1Trend, d1Trend, indH4.trend].filter(t => t === 'BEARISH').length;
      const htfVotes = aiDirection === 'BUY' ? htfBull : htfBear;

      if (htfVotes < 2) {
        console.log(`[SCAN] ${label}: HTF misaligned — W1:${w1Trend} D1:${d1Trend} H4:${indH4.trend} (${htfVotes}/3 for ${aiDirection}) — skipped`);
        continue;
      }
      console.log(`[SCAN] ${label}: HTF ✓ ${htfVotes}/3 aligned — W1:${w1Trend} D1:${d1Trend} H4:${indH4.trend}`);

      // ── STAGE 2: Supplementary intelligence (logged, not blocking) ───
      const rsiDiv      = detectRSIDivergence(m30cc, aiDirection);
      const compression = detectCompression(h4cc);
      const liquidity   = analyzeLiquidity(indH4, price, aiDirection, indH4.atr14);

      // ── MARKET STRUCTURE ENGINE ───────────────────────────────────────
      const structure     = detectMarketStructure(h4cc, aiDirection);
      const liqZones      = detectLiquidityZones(h4cc, indH4.atr14);
      const structureDelta= scoreMarketStructure(structure, aiDirection, liqZones);

      // ── PIPELINE STAGE 3: Supply & Demand zones ──────────────────────
      const sd = detectSupplyDemandZones(h4cc, aiDirection);
      console.log(`[SCAN] ${label}: S/D — ${sd.freshCount} fresh ${aiDirection==='BUY'?'demand':'supply'} zone(s)${sd.nearFresh?' — NEAR PRICE ✓':''}`);

      // ── ICT SMART MONEY CONCEPTS ──────────────────────────────────────
      const fvg    = detectFVG(h4cc, aiDirection);
      const ob     = detectOrderBlocks(h4cc, aiDirection);
      const turtle = detectTurtleSoup(h4cc, aiDirection);
      const amd    = detectAMDPhase();
      const pivots = calcPivotPoints(h4cc);

      // ── PIPELINE STAGE 4: Institutional confirmation gate ─────────────
      // At least ONE institutional zone must exist: S/D zone, FVG, Order Block, or Turtle Soup
      // This ensures we only trade from where institutions are positioned
      const hasInstitutionalZone = sd.freshCount > 0 || fvg.found || ob.found || turtle.found;
      if (!hasInstitutionalZone) {
        console.log(`[SCAN] ${label}: No institutional zone (S/D=${sd.freshCount} FVG=${fvg.found} OB=${ob.found} Turtle=${turtle.found}) — skipped`);
        continue;
      }
      console.log(`[SCAN] ${label}: Institutional zone ✓ — S/D:${sd.freshCount} FVG:${fvg.found} OB:${ob.found} Turtle:${turtle.found}`);

      console.log(`[SCAN] ${label}: Structure ${structure.structureBias} | BOS ${structure.bos} | CHOCH ${structure.choch} | delta ${structureDelta > 0 ? '+' : ''}${structureDelta}`);

      // ── HARD QUALITY FILTERS — skip before expensive scoring ────────────

      // 1. ASIAN session (except JPY pairs) — low liquidity, fake moves
      const isJpyPair = label.includes('JPY');
      if (session === 'ASIAN' && !isJpyPair) {
        console.log(`[SCAN] ${label}: ASIAN session non-JPY — low liquidity, skip`);
        continue;
      }

      // 2. ADX < 18 — market is ranging, trend signals fail
      if (indH4.adx < 18) {
        console.log(`[SCAN] ${label}: ADX ${indH4.adx.toFixed(1)} < 18 — ranging market, skip`);
        continue;
      }

      // 3. EMA200 mandatory — never trade against the big trend
      if (indH4.ema200) {
        const isBuyDir = aiDirection === 'BUY';
        if (isBuyDir && price < indH4.ema200) {
          console.log(`[SCAN] ${label}: BUY below EMA200 (${indH4.ema200.toFixed(5)}) — against big trend, skip`);
          continue;
        }
        if (!isBuyDir && price > indH4.ema200) {
          console.log(`[SCAN] ${label}: SELL above EMA200 (${indH4.ema200.toFixed(5)}) — against big trend, skip`);
          continue;
        }
      }

      // 4. High sweep risk — institutional liquidity grab likely, skip
      if (liquidity.sweep_risk === 'HIGH') {
        console.log(`[SCAN] ${label}: HIGH sweep risk — ${liquidity.note}, skip`);
        continue;
      }

      // ── END HARD QUALITY FILTERS ─────────────────────────────────────────

      // CHOCH against trade direction is a hard block — structure is flipping
      if (structure.choch !== 'NONE' && structure.choch !== (aiDirection === 'BUY' ? 'BULLISH' : 'BEARISH')) {
        console.log(`[SCAN] ${label}: CHOCH ${structure.choch} against ${aiDirection} — structure change, rejected`);
        continue;
      }

      if (liqZones.nearBuySide || liqZones.nearSellSide) {
        console.log(`[SCAN] ${label}: Near liquidity zone — sweep risk`);
      }
      if (compression.compressing) {
        console.log(`[SCAN] ${label}: Compression detected (ATR ratio ${compression.ratio}) — breakout potential ✓`);
      }
      if (rsiDiv !== 'NONE') {
        console.log(`[SCAN] ${label}: RSI divergence: ${rsiDiv}`);
      }

      // ── Run 17-check scoring engine ───────────────────────────────────
      const scored = scoreSignal({
        direction: aiDirection, price, pair: label,
        h4: indH4, h2: indH2, m30: indM30, m5: indM5,
        newsEvents: currentNews, fvg, ob, turtle,
      });
      console.log(`[SCAN] ${label}: ${aiDirection} score ${scored.score}/${scored.maxScore} (${scored.pct}%) — need ${minScore}`);

      // Reject if score too low
      if (scored.score < minScore) {
        const failed = scored.checks.filter(c=>!c.pass).map(c=>c.name).join(', ');
        console.log(`[SCAN] ${label}: REJECTED — failed: ${failed}`);
        continue;
      }

      // ── STEP 1: Calc engine — instant rule-based scoring ─────────────
      const dp = ['XAU_USD','XAG_USD'].includes(instr) ? 2 : instr.includes('JPY') ? 3 : 5;
      const setup = calcTradeSetup({
        direction: aiDirection, price,
        h4: indH4, h2: indH2, m30: indM30, m5: indM5,
        scored, session, fvg, ob, turtle, amd, sd,
      });
      console.log(`[SCAN] ${label}: Calc Engine → ${aiDirection} ${setup.confidence}%`);

      // ── Apply learning delta — from accumulated trade history ────────
      const learningDelta = getLearningDelta({
        session, regime: regime.regime, pair: label, direction: aiDirection,
        bos: structure.bos, sweep_risk: liquidity.sweep_risk, w1Trend,
        adx: indH4.adx,
      });

      const totalDelta = structureDelta + learningDelta;
      let analysis  = setup.analysis;
      let parsed    = {
        direction:  setup.direction,
        confidence: Math.min(95, Math.max(10, setup.confidence + totalDelta)),
        stopLoss:   setup.stopLoss,
        takeProfit: setup.takeProfit,
      };
      if (totalDelta !== 0) {
        console.log(`[SCAN] ${label}: Total delta ${totalDelta > 0 ? '+' : ''}${totalDelta} (structure ${structureDelta > 0?'+':''}${structureDelta}, learning ${learningDelta > 0?'+':''}${learningDelta}) → confidence ${setup.confidence}% → ${parsed.confidence}%`);
      }

      // ── FIX 10: Regime persistence — bonus filter ─────────────────────
      recordRegime(label, regime.regime);
      const regimePersist = getRegimePersistence(label, regime.regime);
      if (!regimePersist.stable && regime.regime !== 'TRENDING_STRONG') {
        console.log(`[SCAN] ${label}: Regime ${regime.regime} not yet stable (${regimePersist.count} scans) — ${regimePersist.note}`);
        // Not a hard block — reduce confidence instead of rejecting
        // Unstable regime = treat like one less check passed
      }
      console.log(`[SCAN] ${label}: Regime persistence ${regimePersist.score} (${regimePersist.count} scans)`);

      // ── STEP 2: GPT-4o final validation — only if calc passed ────────
      const aiThreshold = parseInt(settings.threshold || 80);
      const spreadAtScanPips = (spreadCache[label] || 0) / (PIP[instr] || 0.0001);
      const aiFlags = [];
      if (spreadAtScanPips > 3)        aiFlags.push(`spread_elevated_${spreadAtScanPips.toFixed(1)}_pips`);
      if (indH4.adx < 22)              aiFlags.push('adx_marginal');
      if (!regimePersist.stable)       aiFlags.push('regime_emerging');
      if (liquidity.sweep_risk==='HIGH') aiFlags.push('sweep_risk_high');
      if (rsiDiv !== 'NONE')           aiFlags.push(`rsi_div_${rsiDiv.toLowerCase()}`);
      if (compression.compressing)    aiFlags.push('volatility_compression');

      let aiDecisionLogged = false;
      const aiLogBase = {
        pair: label, direction: aiDirection, calc_confidence: setup.confidence,
        regime: regime.regime, session, adx: indH4.adx, rsi_m30: indM30.rsi14,
        spread_pips: spreadAtScanPips, score: scored.score, flags: aiFlags,
      };

      if (keys.openai_key && setup.confidence >= aiThreshold) {
        const t0 = Date.now();
        try {
          const openai = new OpenAI({ apiKey: keys.openai_key });
          const promptCtx =
`PAIR: ${label} | PRICE: ${price.toFixed(dp)} | SESSION: ${session} | REGIME: ${regime.regime} (${regimePersist.score} persistence)
PRECISION SCORE: ${scored.score}/${scored.maxScore} checks | CALC CONFIDENCE: ${setup.confidence}%
FLAGS: ${aiFlags.join(', ') || 'none'}

H4 (MASTER): EMA9=${indH4.ema9.toFixed(dp)} EMA21=${indH4.ema21.toFixed(dp)} EMA50=${indH4.ema50.toFixed(dp)} RSI=${indH4.rsi14} ADX=${indH4.adx} ATR=${indH4.atr14.toFixed(dp)} Trend=${indH4.trend}
H2 (CONFIRM): EMA9=${indH2.ema9.toFixed(dp)} EMA21=${indH2.ema21.toFixed(dp)} RSI=${indH2.rsi14} Trend=${indH2.trend}
M30 (ENTRY):  EMA9=${indM30.ema9.toFixed(dp)} EMA21=${indM30.ema21.toFixed(dp)} RSI=${indM30.rsi14} MACD=${indM30.macd} Pattern=${indM30.pattern}
M5 (TRIGGER): RSI=${indM5.rsi14} Pattern=${indM5.pattern}
H4 Strong Support: ${indH4.strongSupport.toFixed(dp)} | H4 Strong Resistance: ${indH4.strongResist.toFixed(dp)}
BB: BW=${indH4.bb?.bw.toFixed(2)}% %B=${((indH4.bb?.pct||0.5)*100).toFixed(0)}%${indH4.bb?.squeezing?' SQUEEZE':''} | VWAP: ${indH4.vwap?.toFixed(dp)} | HMA21: ${indH4.hma?.toFixed(dp)}
FVG: ${fvg.found?`${fvg.count} gaps${fvg.testing?' (TESTING)':''}`:' none'} | OrderBlock: ${ob.found?`${ob.blocks.length} blocks${ob.testing?' (IN ZONE)':''}`:' none'} | TurtleSoup: ${turtle.found?turtle.signal:'none'}
AMD Phase: ${amd.phase} (tradeable: ${amd.tradeable})
Pivots: ${pivots?`PP=${pivots.pp.toFixed(dp)} R1=${pivots.r1.toFixed(dp)} S1=${pivots.s1.toFixed(dp)}`:'N/A'}
Calc Engine SL: ${setup.stopLoss.toFixed(dp)} | Calc Engine TP: ${setup.takeProfit.toFixed(dp)}
Checks PASSED: ${scored.checks.filter(c=>c.pass).map(c=>c.name).join(', ')}
Checks FAILED: ${scored.checks.filter(c=>!c.pass).map(c=>c.name).join(', ')||'NONE'}`;

          const promptHash = crypto.createHash('sha256').update(promptCtx).digest('hex').slice(0,12);

          const completion = await openai.chat.completions.create({
            model: 'gpt-4o', max_tokens: 300, temperature: 0.1,
            messages: [
              { role: 'system', content:
`You are a professional forex risk manager verifying a trade signal.
A rule-based engine already passed this setup through 12 strict checks.
Your job: validate the direction, then set PRECISE SL/TP at actual S/R levels.
RULES:
- Only BULLISH if H4+H2+M30 all bullish. Only BEARISH if all bearish. Otherwise NEUTRAL.
- RSI > 75 on M30 = reject BUY. RSI < 25 on M30 = reject SELL.
- ADX on H4 must be >= 20.
- SL must be at a real H4 support/resistance level (use the levels provided).
- TP minimum 1:2 R:R. Target the next S/R level.
- If the calc engine SL/TP look correct, you may keep them.
- Confidence 90%+ only if ALL 4 timeframes perfectly aligned.` },
              { role: 'user', content:
`${promptCtx}

Return EXACTLY 6 lines, no other text:
1. Market Bias: BULLISH / BEARISH / NEUTRAL
2. Confidence Score: X%
3. Entry Zone: ${price.toFixed(dp)}
4. Stop Loss: price
5. Take Profit: price
6. Risk/Reward: 1:X` },
            ],
          });

          const latencyMs = Date.now() - t0;
          const gptText   = completion.choices[0].message.content;
          const gptParsed = parseAIResponse(gptText);
          console.log(`[SCAN] ${label}: GPT-4o → ${gptParsed.direction} ${gptParsed.confidence}% (${latencyMs}ms)`);

          if (gptParsed.direction === aiDirection &&
              gptParsed.stopLoss && gptParsed.takeProfit &&
              gptParsed.confidence >= aiThreshold) {

            // FIX 6: Log structured AI decision — APPROVED
            logAIDecision({ ...aiLogBase, model:'gpt-4o', ai_confidence: gptParsed.confidence,
              ai_direction: gptParsed.direction, ai_sl: gptParsed.stopLoss, ai_tp: gptParsed.takeProfit,
              decision:'APPROVED', prompt_hash: promptHash, latency_ms: latencyMs });
            aiDecisionLogged = true;

            parsed.confidence = gptParsed.confidence;
            parsed.stopLoss   = gptParsed.stopLoss;
            parsed.takeProfit = gptParsed.takeProfit;
            analysis = `${gptText}\n\n[Rule Engine] ${setup.analysis.split('\n').slice(1).join('\n')}`;
            console.log(`[SCAN] ${label}: GPT-4o validated ✓ — using GPT SL/TP`);

          } else if (gptParsed.direction === 'NEUTRAL' || gptParsed.direction !== aiDirection) {
            logAIDecision({ ...aiLogBase, model:'gpt-4o', ai_confidence: gptParsed.confidence,
              ai_direction: gptParsed.direction, decision:'REJECTED_DIRECTION',
              prompt_hash: promptHash, latency_ms: latencyMs });
            console.log(`[SCAN] ${label}: GPT-4o REJECTED — direction mismatch or NEUTRAL`);
            continue;

          } else if (gptParsed.confidence < aiThreshold) {
            logAIDecision({ ...aiLogBase, model:'gpt-4o', ai_confidence: gptParsed.confidence,
              ai_direction: gptParsed.direction, decision:'REJECTED_LOW_CONF',
              prompt_hash: promptHash, latency_ms: latencyMs });
            console.log(`[SCAN] ${label}: GPT-4o confidence ${gptParsed.confidence}% too low — skipped`);
            continue;
          }
        } catch(e) {
          logAIDecision({ ...aiLogBase, model:'gpt-4o', ai_confidence: null,
            ai_direction: null, decision:'API_ERROR', latency_ms: Date.now() - t0,
            flags: [...aiFlags, `error_${e.message?.slice(0,30)}`] });
          console.log(`[SCAN] ${label}: GPT-4o error — using calc engine: ${e.message}`);
        }
      } else if (setup.confidence < aiThreshold) {
        logAIDecision({ ...aiLogBase, model:'calc_only', ai_confidence: setup.confidence,
          ai_direction: aiDirection, decision:'REJECTED_CALC_LOW_CONF' });
        console.log(`[SCAN] ${label}: Calc confidence ${setup.confidence}% < ${aiThreshold}% — skipped`);
        continue;
      }

      // Log calc-only decision if AI was not called or fell through
      if (!aiDecisionLogged) {
        logAIDecision({ ...aiLogBase, model:'calc_only', ai_confidence: setup.confidence,
          ai_direction: aiDirection, ai_sl: setup.stopLoss, ai_tp: setup.takeProfit,
          decision:'CALC_FALLBACK' });
      }

      if (!parsed.stopLoss || !parsed.takeProfit) continue;

      // Validate R:R >= 1.5
      const pipSize = PIP[instr] || 0.0001;
      const slPips  = Math.abs(price - parsed.stopLoss)  / pipSize;
      const tpPips  = Math.abs(price - parsed.takeProfit) / pipSize;
      if (slPips < 2) continue;
      const rr = tpPips / slPips;
      if (rr < 2.0) {
        console.log(`[SCAN] ${label}: R:R ${rr.toFixed(1)} too low (need ≥2.0) — skipped`);
        continue;
      }

      // ── FIX 2: Spread efficiency — SL must be ≥ 5× the spread ────────
      const spreadPips = (spreadCache[label] || 0) / pipSize;
      if (spreadPips > 0 && slPips / spreadPips < 5) {
        console.log(`[SCAN] ${label}: Spread efficiency ${(slPips/spreadPips).toFixed(1)}x too low (min 5x) — skipped`);
        continue;
      }

      // ── Position sizing — scaled down after losses ────────────────────
      const acctData = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
      const balance  = parseFloat(acctData?.account?.balance || 0);
      const riskAmt  = balance * (riskPct / 100);
      let pipVal     = pipSize;
      if (instr==='USD_JPY') pipVal = 0.01 / price;
      if (instr==='USD_CAD') pipVal = 0.0001 / price;
      if (instr==='XAU_USD') pipVal = 0.1;

      // Dynamic risk reduction: consecutive losses + Friday/weekend
      const consecLoss   = getConsecutiveLosses();
      const timeFactor   = getTimeBasedSizeFactor();
      const lossFactor   = consecLoss === 1 ? 0.50 : consecLoss >= 2 ? 0.25 : 1.0;
      const sizeFactor   = Math.min(lossFactor, timeFactor);
      const sizeReasons  = [];
      if (consecLoss > 0) sizeReasons.push(`${consecLoss} consec loss`);
      const timeNote = getSizeFactorNote(timeFactor);
      if (timeNote) sizeReasons.push(timeNote);
      const sizeNote     = sizeFactor < 1 ? ` [REDUCED to ${(sizeFactor*100).toFixed(0)}% — ${sizeReasons.join(', ')}]` : '';
      // Medium EMA convergence → soft warning (not a block, logged in message)
      if (emaConv.converging && emaConv.severity === 'MEDIUM') {
        console.log(`[SCAN] ${label}: EMA convergence (MEDIUM) — ${emaConv.note} — proceeding with caution`);
      }

      const units = Math.floor(riskAmt / (slPips * pipVal) * sizeFactor);
      if (units < 100) continue;
      const lots = (units / 100000).toFixed(2);

      // ── Save signal with full scoring data ────────────────────────────
      const signalId = db.prepare(`
        INSERT INTO signals (pair,direction,confidence,entry_price,stop_loss,take_profit,sl_pips,tp_pips,units,risk_pct,risk_amount,lots,analysis,ema_align,rsi,h4_trend)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        label, parsed.direction, parsed.confidence, price,
        parsed.stopLoss, parsed.takeProfit,
        slPips.toFixed(1), tpPips.toFixed(1),
        units, riskPct, riskAmt, lots,
        `${analysis}\n\nSCORE: ${scored.score}/${scored.maxScore} | SESSION: ${session} | ADX(H4): ${indH4.adx} | M5 Pattern: ${indM5.pattern} | STRUCTURE: ${structure.bos}/${structure.choch}`,
        indH4.emaAlignment, indM30.rsi14, indH2.trend
      ).lastInsertRowid;

      // ── Save post-trade attribution context (outcome filled in by reconcileTrades) ──
      try {
        db.prepare(`
          INSERT OR IGNORE INTO trade_attribution
            (signal_id, pair, direction, session, regime, atr_ratio, score, confidence,
             spread_pips, atr_pips, adx, rsi_m30, w1_trend, structure_bias, bos, choch,
             rsi_divergence, compressing, sweep_risk, size_factor)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          signalId, label, parsed.direction, session, regime.regime,
          parseFloat((regime.atrRatio || 1).toFixed(2)),
          scored.score, parsed.confidence,
          parseFloat(spreadPips.toFixed(2)),
          parseFloat((indH4.atr14 / pipSize).toFixed(1)),
          indH4.adx, indM30.rsi14, w1Trend,
          structure.structureBias, structure.bos, structure.choch,
          rsiDiv, compression.compressing ? 1 : 0,
          liquidity.sweep_risk, sizeFactor
        );
      } catch(e) { console.error('[ATTR]', e.message); }

      // ── Build Telegram message — full decision brief ─────────────────
      const passedStr  = scored.checks.filter(c=>c.pass).map(c=>`  ✅ ${c.name}`).join('\n');
      const failedStr  = scored.checks.filter(c=>!c.pass).map(c=>`  ❌ ${c.name}`).join('\n');
      const dirArrow   = parsed.direction==='BUY' ? '▲' : '▼';
      const ema200dir  = price > indH4.ema200 ? 'ABOVE ✓' : 'BELOW ⚠️';
      const atrPips    = (indH4.atr14 / pipSize).toFixed(0);
      const spreadDisp = spreadPips > 0 ? `${spreadPips.toFixed(1)} pips (${(slPips/spreadPips).toFixed(1)}× SL)` : 'N/A';
      const heatDisp   = `${heat.heat_level} (${heat.open_positions} open, ${heat.total_risk_pct}% risk on book)`;
      const consecDisp = consecLoss > 0 ? `⚠️ ${consecLoss} consecutive loss(es)` : '✅ None';
      const regimeDisp = `${regime.regime} (${regime.atrRatio?.toFixed(1)}× ATR) — ${regimePersist.score} persistence`;
      const emaConvDisp   = emaConv.converging ? `⚠️ ${emaConv.severity}: ${emaConv.note}` : '✅ EMAs separated — trend intact';
      const learningDisp  = learningDelta !== 0
        ? `${learningDelta > 0 ? '+' : ''}${learningDelta} from ${Math.abs(learningDelta) > 4 ? 'strong' : 'moderate'} historical pattern`
        : 'Neutral (insufficient history or no pattern yet)';
      // Market structure display
      const bosDisp    = structure.bos   !== 'NONE' ? `BOS ${structure.bos} ✓`   : 'No BOS';
      const chochDisp  = structure.choch !== 'NONE' ? `CHOCH ${structure.choch} ⚠️` : 'No CHOCH';
      const nearLiqDisp= (liqZones.nearBuySide || liqZones.nearSellSide)
        ? `⚠️ NEAR ${liqZones.nearBuySide ? 'BUY-SIDE' : 'SELL-SIDE'} LIQUIDITY`
        : `Buy-side: ${liqZones.nearestBuySide?.toFixed(dp) || 'N/A'} | Sell-side: ${liqZones.nearestSellSide?.toFixed(dp) || 'N/A'}`;

      // ICT display strings
      const fvgDisp    = fvg.found    ? `✅ ${fvg.count} gap(s)${fvg.testing ? ' — TESTING NOW' : ''}` : '—';
      const obDisp     = ob.found     ? `✅ ${ob.blocks.length} block(s)${ob.testing ? ' — PRICE IN ZONE' : ''}` : '—';
      const turtleDisp = turtle.found ? `⚡ ${turtle.signal} — ${turtle.note}` : '—';
      const amdDisp    = `${amd.phase}${amd.tradeable ? ' ✓' : ' ⚠️'} — ${amd.note}`;
      const pivotsDisp = pivots ? `PP=${pivots.pp.toFixed(dp)} | R1=${pivots.r1.toFixed(dp)} | S1=${pivots.s1.toFixed(dp)}` : '—';
      const fibNear    = indH4.fib ? nearestFibLevel(indH4.fib, price, indH4.atr14) : null;
      const fibDisp    = indH4.fib
        ? `H:${indH4.fib.high.toFixed(dp)} L:${indH4.fib.low.toFixed(dp)} | 0.618=${indH4.fib.f618.toFixed(dp)} 0.382=${indH4.fib.f382.toFixed(dp)}${fibNear && fibNear.distance <= 1.2 ? ` ← price near ${fibNear.key} ✅` : ''}`
        : '—';
      const bbDisp     = indH4.bb ? `BW=${indH4.bb.bw.toFixed(2)}% %B=${(indH4.bb.pct*100).toFixed(0)}%${indH4.bb.squeezing?' SQUEEZE':''}` : '—';
      const vwapDisp   = indH4.vwap ? `${indH4.vwap.toFixed(dp)} (price ${price > indH4.vwap ? 'ABOVE ✓' : 'BELOW ⚠️'})` : '—';
      const hmaDisp    = indH4.hma  ? `${indH4.hma.toFixed(dp)} (price ${price > indH4.hma ? 'ABOVE ✓' : 'BELOW ⚠️'})` : '—';
      const sdDisp     = sd.freshCount > 0 ? `✅ ${sd.freshCount} fresh zone(s)${sd.nearFresh ? ' — PRICE AT ZONE' : ''}` : sd.zones.length > 0 ? `⚠️ ${sd.zones.length} tested zone(s)` : '—';
      // Pipeline summary line
      const newsOk   = newsCache.filter(n => { if(n.impact!=='HIGH') return false; const nm=new Date().getUTCHours()*60+new Date().getUTCMinutes(); const [h,m]=(n.time||'99:99').split(':').map(Number); const d=nm-(h*60+m); return d>=-45&&d<=60; }).length === 0;
      const pipelineDisp = [
        `${newsOk?'✅':'❌'} News`,
        `✅ HTF(${htfVotes}/3)`,
        `✅ Structure`,
        `${sd.freshCount>0||fvg.found||ob.found?'✅':'⚠️'} S/D`,
        `${liquidity.sweep_risk!=='HIGH'?'✅':'⚠️'} Liq`,
        `✅ Score(${scored.score}/${scored.maxScore})`,
        `✅ R:R(1:${rr.toFixed(1)})`,
      ].join(' | ');

      const tgText =
`🎯 SIGNAL #${signalId} — ${label} ${parsed.direction} ${dirArrow}
━━━━━━━━━━━━━━━━━━━━━━━
📋 PIPELINE: ${pipelineDisp}
━━━━━━━━━━━━━━━━━━━━━━━
SCORE: ${scored.score}/${scored.maxScore} checks | Confidence: ${parsed.confidence}%

📌 TRADE SETUP
Entry:       ${price.toFixed(dp)}
Stop Loss:   ${parsed.stopLoss.toFixed(dp)}  (${slPips.toFixed(1)} pips)
Take Profit: ${parsed.takeProfit.toFixed(dp)}  (${tpPips.toFixed(1)} pips)
R:R Ratio:   1:${rr.toFixed(1)}
Size:        ${lots} lots  (${units.toLocaleString()} units)${sizeFactor < 1 ? ` ⚠️ scaled ${sizeFactor*100}%` : ''}
Risk:        ${riskPct}% = $${riskAmt.toFixed(0)} of $${balance.toFixed(0)}${sizeNote}

📊 MARKET CONTEXT
Session:     ${session}
Regime:      ${regimeDisp}
W1 Trend:    ${w1Trend}
EMA200 (H4): ${ema200dir}  (${indH4.ema200?.toFixed(dp)})
ATR (H4):    ${atrPips} pips
Spread:      ${spreadDisp}
EMA Conv:    ${emaConvDisp}
Learning:    ${learningDisp}
${rsiDiv !== 'NONE' ? `RSI Signal:  ${rsiDiv}\n` : ''}${compression.compressing ? `Compress:    ✓ Squeeze (${compression.ratio}x ATR) — breakout loading\n` : ''}Liquidity:   ${liquidity.sweep_risk === 'HIGH' ? `⚠️ HIGH SWEEP RISK — ${liquidity.note}` : liquidity.note}

🏗 MARKET STRUCTURE
Bias:        ${structure.structureBias}
${bosDisp}  |  ${chochDisp}
Swing High:  ${structure.swingHigh?.toFixed(dp) || 'N/A'}
Swing Low:   ${structure.swingLow?.toFixed(dp) || 'N/A'}
Stop Pools:  ${nearLiqDisp}

🧠 ICT SMART MONEY
AMD Phase:   ${amdDisp}
S/D Zone:    ${sdDisp}
FVG:         ${fvgDisp}
Order Block: ${obDisp}
Turtle Soup: ${turtleDisp}
Fibonacci:   ${fibDisp}
Pivots:      ${pivotsDisp}
BB:          ${bbDisp}
VWAP:        ${vwapDisp}
HMA(21):     ${hmaDisp}

💼 ACCOUNT STATE
Balance:     $${balance.toFixed(2)}
Portfolio:   ${heatDisp}
Consec loss: ${consecDisp}

📈 TIMEFRAME BREAKDOWN
W1:          ${w1Trend}
D1:          ${d1Trend}
H4 (Master): ${indH4.emaAlignment} | RSI ${indH4.rsi14} | ADX ${indH4.adx} | ${indH4.trend}
H2 (Confirm):${indH2.trend} | RSI ${indH2.rsi14} | EMA ${indH2.ema9>indH2.ema21?'bullish▲':'bearish▼'}
M30 (Entry): ${indM30.trend} | RSI ${indM30.rsi14} | MACD ${indM30.macd>0?'▲':'▼'} | ${indM30.pattern}
M5 (Trigger):${indM5.trend} | RSI ${indM5.rsi14} | ${indM5.pattern}

✅ CHECKS PASSED
${passedStr}
${failedStr ? `\n❌ CHECKS FAILED\n${failedStr}` : ''}`;

      // ── AUTO-EXECUTE or send for manual approval ──────────────────────
      if (settings.auto_execute) {
        console.log(`[SCAN] ⚡ Auto-executing #${signalId}: ${label} ${parsed.direction} ${parsed.confidence}%`);
        try {
          const tgRes = await sendTelegramMsg(`⚡ AUTO-EXECUTING SIGNAL #${signalId}\n${tgText}`);
          const tgMsgId = tgRes?.result?.message_id || null;
          if (tgMsgId) db.prepare('UPDATE signals SET tg_message_id=? WHERE id=?').run(tgMsgId, signalId);
        } catch {}
        const sigRow = db.prepare('SELECT * FROM signals WHERE id=?').get(signalId);
        await executeSignal(sigRow);
      } else {
        const r = await tgSendButtons(tgText, [[
          { text:'✅ APPROVE', callback_data:`approve_${signalId}` },
          { text:'❌ REJECT',  callback_data:`reject_${signalId}`  },
        ]]);
        if (r?.result?.message_id) {
          db.prepare('UPDATE signals SET tg_message_id=? WHERE id=?').run(r.result.message_id, signalId);
        }
      }
      console.log(`[SCAN] ✅ Signal #${signalId}: ${label} ${parsed.direction} ${parsed.confidence}% score=${scored.score}/${scored.maxScore}`);

    } catch(e) {
      console.error(`[SCAN] Error ${instr}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  autoScanning = false;
  console.log('[SCAN] Scan complete.');
}

// Scan every 5 minutes
setInterval(runAutoScan, 5 * 60 * 1000);
// Run once 20s after startup if enabled
setTimeout(runAutoScan, 20000);

// ─── WEEKLY PERFORMANCE REPORT — every Sunday 08:00 UTC ──────────────────────
async function sendWeeklyReport() {
  const keys = getApiKeys();
  if (!keys.tg_token || !keys.tg_chat) return;

  // Guard: only send once per Sunday (store last sent date)
  const today = new Date().toISOString().slice(0, 10);
  const lastSent = getStorageValue('weekly_report_sent');
  if (lastSent === today) return;

  const now = new Date();
  if (now.getUTCDay() !== 0) return;           // only Sunday
  if (now.getUTCHours() < 8 || now.getUTCHours() > 9) return; // 08:00–09:00 window

  setStorageValue('weekly_report_sent', today);

  try {
    // Closed trades this week
    const daysFromMon = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
    const monday = new Date(now.getTime() - daysFromMon * 86400000).toISOString().slice(0, 10);
    const weekTrades = db.prepare(`
      SELECT pair, direction, realized_pl, actual_pips, confidence, exit_reason, duration_mins
      FROM signals WHERE status='CLOSED' AND date(closed_at) >= ?
      ORDER BY closed_at ASC
    `).get ? db.prepare(`
      SELECT pair, direction, realized_pl, actual_pips, confidence, exit_reason, duration_mins
      FROM signals WHERE status='CLOSED' AND date(closed_at) >= ?
      ORDER BY closed_at ASC
    `).all(monday) : [];

    const wins   = weekTrades.filter(t => (t.realized_pl||0) > 0);
    const losses = weekTrades.filter(t => (t.realized_pl||0) < 0);
    const totalPL= weekTrades.reduce((s,t) => s + (t.realized_pl||0), 0);
    const winRate= weekTrades.length ? Math.round(wins.length / weekTrades.length * 100) : 0;
    const avgWin = wins.length   ? wins.reduce((s,t)   => s+(t.realized_pl||0), 0)/wins.length   : 0;
    const avgLoss= losses.length ? losses.reduce((s,t) => s+(t.realized_pl||0), 0)/losses.length : 0;
    const pf     = avgLoss < 0 && avgWin > 0 ? Math.abs(avgWin/avgLoss).toFixed(2) : '—';

    // Best/worst pair this week
    const pairMap = {};
    weekTrades.forEach(t => {
      if (!pairMap[t.pair]) pairMap[t.pair] = { pl:0, n:0 };
      pairMap[t.pair].pl += (t.realized_pl||0); pairMap[t.pair].n++;
    });
    const pairArr    = Object.entries(pairMap).sort((a,b) => b[1].pl - a[1].pl);
    const bestPair   = pairArr[0]  ? `${pairArr[0][0]}  +$${pairArr[0][1].pl.toFixed(2)}` : '—';
    const worstPair  = pairArr.slice(-1)[0] && pairArr.slice(-1)[0][1].pl < 0
      ? `${pairArr.slice(-1)[0][0]}  -$${Math.abs(pairArr.slice(-1)[0][1].pl).toFixed(2)}` : '—';

    // All-time advanced metrics
    const allClosed  = db.prepare(`SELECT realized_pl FROM signals WHERE status='CLOSED' ORDER BY closed_at ASC`).all();
    const allPLs     = allClosed.map(t => t.realized_pl||0);
    const allAvg     = allPLs.length ? allPLs.reduce((s,p)=>s+p,0)/allPLs.length : 0;
    const allStd     = allPLs.length > 1
      ? Math.sqrt(allPLs.reduce((s,p)=>s+(p-allAvg)**2,0)/allPLs.length) : 1;
    const sharpe     = allStd > 0 ? (allAvg/allStd).toFixed(2) : '—';

    // Current streak
    const recentPLs = db.prepare(`SELECT realized_pl FROM signals WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 10`).all();
    let streak = 0;
    for (const t of recentPLs) {
      const w = (t.realized_pl||0) > 0;
      if (streak === 0) { streak = w ? 1 : -1; continue; }
      if (streak > 0 && w) streak++;
      else if (streak < 0 && !w) streak--;
      else break;
    }
    const streakStr = streak > 1 ? `🔥 ${streak} wins in a row` : streak < -1 ? `❄️ ${Math.abs(streak)} losses in a row` : 'Neutral';

    const peakBal  = getStorageValue('peak_balance') || 0;
    let balLine = '';
    try {
      if (keys.oanda_key && keys.oanda_account) {
        const a = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
        const b = parseFloat(a?.account?.balance || 0);
        const ddPct = peakBal > 0 ? ((peakBal - b) / peakBal * 100).toFixed(1) : '0.0';
        balLine = `Balance:      $${b.toFixed(2)}  (DD from peak: ${ddPct}%)`;
      }
    } catch {}

    const report =
`📊 WEEKLY PERFORMANCE REPORT
Week of ${monday}
━━━━━━━━━━━━━━━━━━━━━━━
Trades:       ${weekTrades.length}  (${wins.length}W / ${losses.length}L)
Win Rate:     ${winRate}%
Weekly P&L:   ${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}
Profit Factor:${pf}
Avg Win:      +$${avgWin.toFixed(2)}
Avg Loss:     $${avgLoss.toFixed(2)}

Best Pair:    ${bestPair}
Worst Pair:   ${worstPair}
Streak:       ${streakStr}

All-Time Sharpe: ${sharpe}
${balLine}
━━━━━━━━━━━━━━━━━━━━━━━
${totalPL >= 0 ? '✅ Profitable week.' : '❌ Losing week — review conditions.'}
Type REPORT for full pattern analysis.`;

    await sendTelegramMsg(report);
    console.log(`[WEEKLY] Report sent for week of ${monday}`);
  } catch(e) {
    console.error('[WEEKLY]', e.message);
  }
}

// ── Daily Report ─────────────────────────────────────────────────────────────
async function sendDailyReport() {
  const keys = getApiKeys();
  if (!keys.tg_token || !keys.tg_chat) return;

  const today = new Date().toISOString().slice(0, 10);
  const lastSent = getStorageValue('daily_report_sent');
  if (lastSent === today) return;

  const now = new Date();
  if (now.getUTCHours() < 21 || now.getUTCHours() > 22) return; // 21:00–22:00 UTC (NY session close)

  setStorageValue('daily_report_sent', today);

  try {
    // Today's closed trades
    const todayTrades = db.prepare(`
      SELECT pair, direction, realized_pl, actual_pips, confidence, exit_reason, duration_mins
      FROM signals WHERE status='CLOSED' AND date(closed_at) = ?
      ORDER BY closed_at ASC
    `).all(today);

    // Pending signals
    const pending = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='PENDING'`).get();

    const wins    = todayTrades.filter(t => (t.realized_pl||0) > 0);
    const losses  = todayTrades.filter(t => (t.realized_pl||0) < 0);
    const totalPL = todayTrades.reduce((s,t) => s + (t.realized_pl||0), 0);
    const winRate = todayTrades.length ? Math.round(wins.length / todayTrades.length * 100) : 0;
    const avgWin  = wins.length   ? wins.reduce((s,t)   => s+(t.realized_pl||0),0)/wins.length   : 0;
    const avgLoss = losses.length ? losses.reduce((s,t) => s+(t.realized_pl||0),0)/losses.length : 0;

    // Best/worst trade today
    const sorted   = [...todayTrades].sort((a,b) => (b.realized_pl||0)-(a.realized_pl||0));
    const bestStr  = sorted[0]  ? `${sorted[0].pair} ${sorted[0].direction}  +$${(sorted[0].realized_pl||0).toFixed(2)}` : '—';
    const worstStr = sorted.slice(-1)[0] && (sorted.slice(-1)[0].realized_pl||0) < 0
      ? `${sorted.slice(-1)[0].pair} ${sorted.slice(-1)[0].direction}  -$${Math.abs(sorted.slice(-1)[0].realized_pl||0).toFixed(2)}` : '—';

    // Current streak
    const recentPLs = db.prepare(`SELECT realized_pl FROM signals WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 10`).all();
    let streak = 0;
    for (const t of recentPLs) {
      const w = (t.realized_pl||0) > 0;
      if (streak === 0) { streak = w ? 1 : -1; continue; }
      if (streak > 0 && w) streak++;
      else if (streak < 0 && !w) streak--;
      else break;
    }
    const streakStr = streak > 1 ? `🔥 ${streak}W streak` : streak < -1 ? `❄️ ${Math.abs(streak)}L streak` : 'Neutral';

    // OANDA balance + open trades
    let balLine = '', openLine = '';
    try {
      if (keys.oanda_key && keys.oanda_account) {
        const [summary, trades] = await Promise.all([
          oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`),
          oandaRequest(`/v3/accounts/${keys.oanda_account}/openTrades`)
        ]);
        const bal = parseFloat(summary?.account?.balance || 0);
        const unreal = parseFloat(summary?.account?.unrealizedPL || 0);
        const peakBal = getStorageValue('peak_balance') || bal;
        const ddPct = peakBal > 0 ? ((peakBal - bal) / peakBal * 100).toFixed(1) : '0.0';
        balLine = `Balance:      $${bal.toFixed(2)}  (DD: ${ddPct}%)`;
        if (unreal !== 0) balLine += `\nUnrealized:   ${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)}`;
        const openCount = (trades?.trades || []).length;
        if (openCount > 0) {
          const openSummary = (trades.trades || []).slice(0,5).map(t => `  ${t.instrument.replace('_','/')} ${parseFloat(t.unrealizedPL||0)>=0?'+':''}$${parseFloat(t.unrealizedPL||0).toFixed(2)}`).join('\n');
          openLine = `\nOpen Trades:  ${openCount}\n${openSummary}`;
        } else {
          openLine = `\nOpen Trades:  0`;
        }
      }
    } catch {}

    // Autotrade settings
    const settings = getStorageValue('autotrade_settings') || {};
    const scannerStatus = settings.enabled ? '✅ Active' : '⏸ Disabled';
    const execMode = settings.auto_execute ? 'Auto-execute' : 'Telegram approval';

    const plSign = totalPL >= 0 ? '+' : '';
    const verdict = todayTrades.length === 0
      ? '📭 No trades today.'
      : totalPL >= 0
        ? `✅ Profitable day  ${plSign}$${totalPL.toFixed(2)}`
        : `❌ Losing day  $${totalPL.toFixed(2)} — review conditions.`;

    const tradeLines = todayTrades.length > 0
      ? todayTrades.slice(-5).map(t =>
          `  ${t.pair} ${t.direction}  ${(t.realized_pl||0)>=0?'+':''}$${(t.realized_pl||0).toFixed(2)}  (${t.actual_pips||0}p)`
        ).join('\n')
      : '  —';

    const report =
`📅 DAILY REPORT — ${today}
━━━━━━━━━━━━━━━━━━━━━━━
Trades:       ${todayTrades.length}  (${wins.length}W / ${losses.length}L)
Win Rate:     ${winRate}%
Daily P&L:    ${plSign}$${totalPL.toFixed(2)}
Avg Win:      +$${avgWin.toFixed(2)}
Avg Loss:     $${avgLoss.toFixed(2)}

Best Trade:   ${bestStr}
Worst Trade:  ${worstStr}
Streak:       ${streakStr}
Pending:      ${pending?.c || 0} signals awaiting approval
${balLine}${openLine}

Scanner:      ${scannerStatus}
Mode:         ${execMode}
Threshold:    ${settings.threshold || 85}% confidence

Last Trades:
${tradeLines}
━━━━━━━━━━━━━━━━━━━━━━━
${verdict}`;

    await sendTelegramMsg(report);
    console.log(`[DAILY] Report sent for ${today}`);
  } catch(e) {
    console.error('[DAILY]', e.message);
  }
}

// Check every 30 minutes if it's time to send weekly report
setInterval(() => { sendWeeklyReport().catch(() => {}); }, 30 * 60 * 1000);
setTimeout(() => { sendWeeklyReport().catch(() => {}); }, 60000); // check 1 min after startup

// Check every 30 minutes if it's time to send daily report
setInterval(() => { sendDailyReport().catch(() => {}); }, 30 * 60 * 1000);

// Reconcile closed trades every 2 minutes
setInterval(() => { reconcileTrades().catch(() => {}); }, 2 * 60 * 1000);
setTimeout(() => { reconcileTrades().catch(() => {}); }, 15000); // initial run 15s after start

// Daily DB backup on startup + every 24h
backupDatabase();
setInterval(backupDatabase, 24 * 60 * 60 * 1000);

// ── Signal API endpoints ──────────────────────────────────────────────────────
app.get('/api/autotrade/settings', (req, res) => {
  const s = getStorageValue('autotrade_settings') || { enabled:true, auto_execute:true, threshold:85, risk_pct:1, min_score:9 };
  res.json(s);
});

app.post('/api/autotrade/settings', (req, res) => {
  const { enabled, auto_execute, threshold, risk_pct, min_score } = req.body;
  const prev = getStorageValue('autotrade_settings') || {};
  const s = {
    enabled:      !!enabled,
    auto_execute: !!auto_execute,
    threshold:    parseInt(threshold  || 85),
    risk_pct:     parseFloat(risk_pct || 1),
    min_score:    parseInt(min_score  || 9),
  };
  setStorageValue('autotrade_settings', s);
  writeAudit('SETTINGS_CHANGED', { new: s, prev }, 'WEB_UI');
  const onOff    = s.enabled ? 'ON' : 'OFF';
  const execMode = s.auto_execute ? '⚡ AUTO-EXECUTE (trades fire automatically)' : '👤 MANUAL APPROVAL (Telegram buttons)';
  sendTelegramMsg(
    `Signal Scanner: ${onOff}\nMode: ${execMode}\nScore filter: ${s.min_score}/17 checks required\nAI threshold: ${s.threshold}%\nRisk/trade: ${s.risk_pct}%\nSignals: unlimited (all valid setups)`
  );
  res.json({ ok:true, settings:s });
});

app.post('/api/autotrade/scan', (req, res) => {
  runAutoScan().catch(console.error);
  res.json({ ok:true, msg:'Scan started — check Telegram for signals' });
});

app.post('/api/reports/daily', async (req, res) => {
  try {
    // Bypass the time-window guard for manual triggers
    setStorageValue('daily_report_sent', '');
    await sendDailyReport();
    // Restore today's date so the scheduler doesn't fire again tonight
    setStorageValue('daily_report_sent', new Date().toISOString().slice(0, 10));
    res.json({ ok: true, msg: 'Daily report sent to Telegram' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Day-by-day report history — aggregates every closed trade by calendar day so
// the frontend can browse each trading day's P/L, win rate, pips and trade list.
app.get('/api/reports/history', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT pair, direction, realized_pl, actual_pips, confidence, exit_reason,
             duration_mins, closed_at, date(closed_at) AS day
      FROM signals
      WHERE status='CLOSED' AND closed_at IS NOT NULL
      ORDER BY closed_at ASC
    `).all();

    const byDay = {};
    for (const t of rows) {
      const d = t.day;
      if (!d) continue;
      if (!byDay[d]) byDay[d] = { date:d, trades:[], total_pl:0, total_pips:0, wins:0, losses:0 };
      const pl = t.realized_pl || 0;
      byDay[d].trades.push({
        pair:t.pair, direction:t.direction, realized_pl:pl, actual_pips:t.actual_pips||0,
        confidence:t.confidence, exit_reason:t.exit_reason, duration_mins:t.duration_mins, closed_at:t.closed_at,
      });
      byDay[d].total_pl   += pl;
      byDay[d].total_pips += (t.actual_pips || 0);
      if (pl > 0) byDay[d].wins++; else if (pl < 0) byDay[d].losses++;
    }

    const days = Object.values(byDay).map(d => ({
      ...d,
      trade_count: d.trades.length,
      win_rate:    d.trades.length ? Math.round(d.wins / d.trades.length * 100) : 0,
      total_pl:    +d.total_pl.toFixed(2),
      total_pips:  +d.total_pips.toFixed(1),
      best:        +d.trades.reduce((m,t) => Math.max(m, t.realized_pl||0), 0).toFixed(2),
      worst:       +d.trades.reduce((m,t) => Math.min(m, t.realized_pl||0), 0).toFixed(2),
    })).sort((a,b) => b.date.localeCompare(a.date));

    res.json({ days });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/autotrade/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/autotrade/status', (req, res) => {
  const s = getStorageValue('autotrade_settings') || { enabled:true, auto_execute:true, threshold:85, risk_pct:1, min_score:9 };
  const pending = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='PENDING'`).get();
  const today   = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE date(created_at)=date('now')`).get();
  const total   = db.prepare(`SELECT COUNT(*) as c FROM signals`).get();
  res.json({ enabled:s.enabled, threshold:s.threshold||80, risk_pct:s.risk_pct||1,
    pending_signals:pending.c, today_signals:today.c, total_signals:total.c, scanning:autoScanning });
});

// Approve/reject from web UI (fallback if Telegram not available)
app.post('/api/autotrade/approve/:id', async (req, res) => {
  try {
    const sig = db.prepare('SELECT * FROM signals WHERE id=?').get(parseInt(req.params.id));
    if (!sig) return res.status(404).json({ error:'Signal not found' });
    if (sig.status !== 'PENDING') return res.status(400).json({ error:'Signal already processed: '+sig.status });
    writeAudit('SIGNAL_APPROVE', { signal_id: sig.id, pair: sig.pair, confidence: sig.confidence }, 'WEB_UI', sig.id);
    await executeSignal(sig);
    res.json({ ok:true, signal_id:sig.id });
  } catch (e) {
    console.error('[APPROVE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/autotrade/reject/:id', (req, res) => {
  const sig = db.prepare('SELECT * FROM signals WHERE id=?').get(parseInt(req.params.id));
  if (!sig) return res.status(404).json({ error:'Signal not found' });
  if (sig.status !== 'PENDING') return res.status(400).json({ error:'Already processed: '+sig.status });
  db.prepare(`UPDATE signals SET status='REJECTED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(sig.id);
  writeAudit('SIGNAL_REJECT', { signal_id: sig.id, pair: sig.pair, confidence: sig.confidence }, 'WEB_UI', sig.id);
  if (sig.tg_message_id) tgEditMsg(sig.tg_message_id, `❌ REJECTED via web — Signal #${sig.id}\n${sig.pair} ${sig.direction} ${sig.confidence}%`);
  res.json({ ok:true });
});

// ═════════════════════════════════════════════════════════════════════════════
// RISK STATUS API — live view of all governor states
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/risk/status', async (req, res) => {
  const keys = getApiKeys();
  let balance = 0;
  try {
    if (keys.oanda_key && keys.oanda_account) {
      const d = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
      balance = parseFloat(d?.account?.balance || 0);
    }
  } catch {}

  const daily  = getDailyPL();
  const weekly = getWeeklyPL();
  const consec = getConsecutiveLosses();
  const maxDaily  = balance > 0 ? balance * 0.03 : 0;
  const maxWeekly = balance > 0 ? balance * 0.06 : 0;

  // Open position correlation snapshot
  const openSigs = _stmtOpenTrades.all();
  const usdLong  = openSigs.filter(s => USD_CORR_GROUP[s.pair]?.[s.direction] === 'USD_LONG').length;
  const usdShort = openSigs.filter(s => USD_CORR_GROUP[s.pair]?.[s.direction] === 'USD_SHORT').length;

  const recentEvents = db.prepare(`SELECT * FROM risk_events ORDER BY created_at DESC LIMIT 10`).all();

  res.json({
    balance: balance.toFixed(2),
    daily_loss: {
      realized: daily.realized_pl.toFixed(2),
      limit:    (-maxDaily).toFixed(2),
      used_pct: maxDaily > 0 ? Math.abs(Math.min(0, daily.realized_pl) / maxDaily * 100).toFixed(1) : '0',
      breached: maxDaily > 0 && daily.realized_pl < 0 && Math.abs(daily.realized_pl) >= maxDaily,
    },
    weekly_loss: {
      realized:   weekly.realized_pl.toFixed(2),
      limit:      (-maxWeekly).toFixed(2),
      used_pct:   maxWeekly > 0 ? Math.abs(Math.min(0, weekly.realized_pl) / maxWeekly * 100).toFixed(1) : '0',
      breached:   maxWeekly > 0 && weekly.realized_pl < 0 && Math.abs(weekly.realized_pl) >= maxWeekly,
      week_start: weekly.week_start,
    },
    consecutive_losses: {
      count:    consec,
      breached: consec >= 3,
    },
    correlation: {
      usd_long_open:  usdLong,
      usd_short_open: usdShort,
      limit: 2,
      long_breached:  usdLong  >= 2,
      short_breached: usdShort >= 2,
    },
    trading_allowed: maxDaily > 0
      ? (daily.realized_pl >= 0 || Math.abs(daily.realized_pl) < maxDaily) && consec < 3
      : consec < 3,
    peak_balance: {
      peak:    parseFloat((getStorageValue('peak_balance') || balance).toFixed(2)),
      current: parseFloat(balance.toFixed(2)),
      dd_pct:  getStorageValue('peak_balance')
        ? parseFloat((((getStorageValue('peak_balance') - balance) / getStorageValue('peak_balance')) * 100).toFixed(1))
        : 0,
      hard_stop_at: '10%',
    },
    recent_events: recentEvents,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TRADE OUTCOMES API — reconciled results with expectancy stats
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/trade/outcomes', (req, res) => {
  const closed = db.prepare(`SELECT * FROM signals WHERE status='CLOSED' ORDER BY closed_at DESC`).all();
  const wins   = closed.filter(t => (t.realized_pl || 0) > 0);
  const losses = closed.filter(t => (t.realized_pl || 0) < 0);

  const avgWinPL  = wins.length   ? wins.reduce((s, t)   => s + t.realized_pl, 0) / wins.length   : 0;
  const avgLossPL = losses.length ? losses.reduce((s, t) => s + t.realized_pl, 0) / losses.length : 0;
  const winRate   = closed.length ? wins.length / closed.length : 0;
  const expectancy = closed.length ? (winRate * avgWinPL) + ((1 - winRate) * avgLossPL) : null;

  const avgWinPips  = wins.length   ? wins.reduce((s, t)   => s + parseFloat(t.actual_pips || 0), 0) / wins.length   : 0;
  const avgLossPips = losses.length ? losses.reduce((s, t) => s + parseFloat(t.actual_pips || 0), 0) / losses.length : 0;
  const realRR      = avgLossPips < 0 ? Math.abs(avgWinPips / avgLossPips).toFixed(2) : null;

  // Max drawdown from equity curve
  let peak = 0, maxDD = 0, cum = 0;
  [...closed].reverse().forEach(t => {
    cum += (t.realized_pl || 0);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  });

  res.json({
    trades: closed,
    stats: {
      total:        closed.length,
      wins:         wins.length,
      losses:       losses.length,
      win_rate_pct: closed.length ? Math.round(winRate * 100) : null,
      avg_win_pl:   avgWinPL.toFixed(2),
      avg_loss_pl:  avgLossPL.toFixed(2),
      expectancy_per_trade: expectancy !== null ? expectancy.toFixed(2) : null,
      real_rr:      realRR,
      total_pl:     closed.reduce((s, t) => s + (t.realized_pl || 0), 0).toFixed(2),
      max_drawdown: maxDD.toFixed(2),
      avg_duration_mins: closed.length
        ? Math.round(closed.reduce((s, t) => s + (t.duration_mins || 0), 0) / closed.length)
        : null,
      consecutive_losses_now: getConsecutiveLosses(),
    },
    by_exit_reason: {
      SL_HIT:  closed.filter(t => t.exit_reason === 'SL_HIT').length,
      TP_HIT:  closed.filter(t => t.exit_reason === 'TP_HIT').length,
      MANUAL:  closed.filter(t => t.exit_reason === 'MANUAL').length,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 8 — EMERGENCY FLATTEN-ALL + SAFE MODE
// Closes all open OANDA positions, disables scanner, sends Telegram alert
// Triggered via: POST /api/emergency/flatten  OR  Telegram message "FLATTEN ALL"
// ═════════════════════════════════════════════════════════════════════════════
async function emergencyFlatten(triggeredBy = 'API') {
  const keys = getApiKeys();
  console.error(`[EMERGENCY] Flatten-all triggered by: ${triggeredBy}`);

  // 1. Disable scanner immediately
  const settings = getStorageValue('autotrade_settings') || {};
  settings.enabled = false;
  setStorageValue('autotrade_settings', settings);

  let closed = 0, errors = 0;
  try {
    const r = await oandaRequest(`/v3/accounts/${keys.oanda_account}/openTrades`);
    const trades = r?.trades || [];

    for (const trade of trades) {
      try {
        await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades/${trade.id}/close`, 'PUT');
        closed++;
        console.log(`[EMERGENCY] Closed trade ${trade.id} ${trade.instrument}`);
      } catch(e) {
        errors++;
        console.error(`[EMERGENCY] Failed to close ${trade.id}:`, e.message);
      }
    }
  } catch(e) {
    console.error('[EMERGENCY] Could not fetch open trades:', e.message);
  }

  _stmtInsertRiskEvent.run('EMERGENCY_FLATTEN', `Triggered by ${triggeredBy}. Closed ${closed} position(s).`, null, 'ALL_CLOSED_SAFE_MODE');
  writeAudit('EMERGENCY_FLATTEN', { triggered_by: triggeredBy, closed, errors }, triggeredBy);

  const msg =
`🚨 EMERGENCY FLATTEN EXECUTED
Triggered by: ${triggeredBy}
Positions closed: ${closed}
Errors: ${errors}
Scanner: DISABLED

System is in SAFE MODE.
Review conditions before re-enabling.`;
  await sendTelegramMsg(msg).catch(() => {});
  return { closed, errors };
}

app.post('/api/emergency/flatten', async (req, res) => {
  try {
    const result = await emergencyFlatten('API');
    res.json({ ok: true, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger manual reconciliation
app.post('/api/trade/reconcile', async (req, res) => {
  try {
    await reconcileTrades();
    res.json({ ok: true, msg: 'Reconciliation complete — check /api/trade/outcomes' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TRADE HISTORY — Closed trades from OANDA + auto-trade log
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/history', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return res.status(400).json({ error:'OANDA not configured' });
  try {
    const count = parseInt(req.query.count || 50);
    const closedRes = await fetchClosedTrades(count);
    const trades = (closedRes.trades || []).map(t => ({
      id:          t.id,
      pair:        (PAIR_LABELS[t.instrument] || t.instrument),
      direction:   parseFloat(t.initialUnits) > 0 ? 'BUY' : 'SELL',
      units:       Math.abs(parseFloat(t.initialUnits)),
      openTime:    t.openTime?.slice(0,16).replace('T',' '),
      closeTime:   t.closeTime?.slice(0,16).replace('T',' '),
      entryPrice:  parseFloat(t.price).toFixed(5),
      closePrice:  parseFloat(t.averageClosePrice || t.price).toFixed(5),
      pl:          parseFloat(t.realizedPL || 0),
      pips:        null, // calculated below
      sl:          t.stopLossOrder?.price || null,
      tp:          t.takeProfitOrder?.price || null,
    }));
    // Calculate pip P&L
    trades.forEach(t => {
      const oInstr = Object.keys(PAIR_LABELS).find(k => PAIR_LABELS[k] === t.pair) || t.pair.replace('/','_');
      const pipSize = PIP[oInstr] || 0.0001;
      const priceDiff = Math.abs(parseFloat(t.closePrice) - parseFloat(t.entryPrice));
      t.pips = (priceDiff / pipSize * (t.pl >= 0 ? 1 : -1)).toFixed(1);
    });

    // Summary stats
    const won     = trades.filter(t => t.pl > 0);
    const lost    = trades.filter(t => t.pl < 0);
    const be      = trades.filter(t => t.pl === 0);
    const totalPL = trades.reduce((s, t) => s + t.pl, 0);
    const winRate = trades.length ? Math.round(won.length / trades.length * 100) : 0;
    const avgWin  = won.length  ? won.reduce((s,t) => s + t.pl, 0)  / won.length  : 0;
    const avgLoss = lost.length ? lost.reduce((s,t) => s + t.pl, 0) / lost.length : 0;
    const rr      = avgLoss < 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : '—';

    res.json({ trades, historyError: closedRes.ok ? null : closedRes.error,
      stale: !closedRes.ok && trades.length > 0,
      stats: { total:trades.length, won:won.length, lost:lost.length, be:be.length,
      total_pl:totalPL.toFixed(2), win_rate:winRate, avg_win:avgWin.toFixed(2),
      avg_loss:avgLoss.toFixed(2), rr } });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/backtest', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.oanda_key) return res.status(400).json({ error: 'OANDA not configured' });

  const { pair = 'EUR_USD', from, to, minScore = 9, direction = 'BOTH', minConf = 70 } = req.body;
  const oInstr = pair.replace('/', '_');
  const pip    = PIP[oInstr] || 0.0001;
  const dp     = ['XAU_USD','XAG_USD'].includes(oInstr) ? 2 : oInstr.includes('JPY') ? 3 : 5;

  try {
    const fromDt = new Date(from);
    const toDt   = new Date(to);
    if (isNaN(fromDt) || isNaN(toDt)) return res.status(400).json({ error: 'Invalid date range' });

    // Fetch 14-day warmup before 'from' so indicators have enough history
    const warmupFrom = new Date(fromDt.getTime() - 14 * 24 * 3600000).toISOString();
    const toStr      = toDt.toISOString();

    console.log(`[BACKTEST] ${oInstr} ${from} → ${to} | direction=${direction} minScore=${minScore}`);

    const [h4r, h2r, m30r] = await Promise.all([
      oandaRequest(`/v3/instruments/${oInstr}/candles?granularity=H4&from=${warmupFrom}&to=${toStr}&price=M`),
      oandaRequest(`/v3/instruments/${oInstr}/candles?granularity=H2&from=${warmupFrom}&to=${toStr}&price=M`),
      oandaRequest(`/v3/instruments/${oInstr}/candles?granularity=M30&from=${warmupFrom}&to=${toStr}&price=M`),
    ]);

    const h4All  = h4r?.candles  || [];
    const h2All  = h2r?.candles  || [];
    const m30All = m30r?.candles || [];

    if (m30All.length < 30) return res.status(400).json({ error: 'Not enough candle data — try a longer date range' });

    // Precompute timestamps as ms for fast filtering
    const h4Times  = h4All.map(c  => new Date(c.time).getTime());
    const h2Times  = h2All.map(c  => new Date(c.time).getTime());

    const signals = [];
    let skipUntil = 0;

    for (let i = 50; i < m30All.length; i++) {
      if (i < skipUntil) continue;

      const barMs = new Date(m30All[i].time).getTime();
      if (barMs < fromDt.getTime()) continue;  // still in warmup
      if (barMs > toDt.getTime())  break;

      // Slice indicators up to this bar time (walk-forward: no future data)
      const h4End  = h4Times.findIndex(t => t > barMs);
      const h2End  = h2Times.findIndex(t => t > barMs);
      const h4Slice  = (h4End === -1 ? h4All : h4All.slice(0, h4End)).slice(-250); // 250 needed for real EMA200
      const h2Slice  = (h2End === -1 ? h2All : h2All.slice(0, h2End)).slice(-100);
      const m30Slice = m30All.slice(Math.max(0, i - 100), i + 1);

      if (h4Slice.length < 26) continue;

      const indH4  = buildIndicators(h4Slice, []);
      const indH2  = buildIndicators(h2Slice.length > 5 ? h2Slice : h4Slice, h4Slice);
      const indM30 = buildIndicators(m30Slice, h2Slice);

      const price = parseFloat(m30All[i].mid.c);

      // Determine direction
      const autoDir = indH4.emaAlignment === 'BULLISH' ? 'BUY'
                    : indH4.emaAlignment === 'BEARISH' ? 'SELL' : null;
      const dir = direction === 'BOTH' ? autoDir
                : direction === 'BUY'  ? (autoDir === 'BUY'  ? 'BUY'  : null)
                :                        (autoDir === 'SELL' ? 'SELL' : null);
      if (!dir) continue;

      const utcHour = new Date(m30All[i].time).getUTCHours();
      const session = utcHour >= 7 && utcHour < 12 ? 'LONDON'
                    : utcHour >= 12 && utcHour < 17 ? 'NY'
                    : utcHour >= 0  && utcHour < 7  ? 'ASIAN' : 'OFF_HOURS';

      // Use M30 as M5 proxy (backtest: no M5 candles fetched for speed)
      const indM5 = indM30;

      const scored = scoreSignal({
        direction: dir, price, h4: indH4, h2: indH2, m30: indM30, m5: indM5,
        newsEvents: [],  // no historical news data
      });

      if (scored.score < minScore) continue;

      const setup = calcTradeSetup({
        direction: dir, price, h4: indH4, h2: indH2, m30: indM30, m5: indM5,
        scored, session,
      });

      if (setup.confidence < minConf) continue;

      // ── Simulate outcome on future M30 OHLC ──────────────────────────
      const MAX_BARS = 96; // max 2 days forward
      let result = 'TIMEOUT', exitPrice = price, exitBars = MAX_BARS;

      for (let j = i + 1; j < Math.min(i + MAX_BARS + 1, m30All.length); j++) {
        const hi = parseFloat(m30All[j].mid.h);
        const lo = parseFloat(m30All[j].mid.l);
        if (dir === 'BUY') {
          if (lo <= setup.stopLoss)   { result = 'LOSS'; exitPrice = setup.stopLoss;   exitBars = j - i; break; }
          if (hi >= setup.takeProfit) { result = 'WIN';  exitPrice = setup.takeProfit; exitBars = j - i; break; }
        } else {
          if (hi >= setup.stopLoss)   { result = 'LOSS'; exitPrice = setup.stopLoss;   exitBars = j - i; break; }
          if (lo <= setup.takeProfit) { result = 'WIN';  exitPrice = setup.takeProfit; exitBars = j - i; break; }
        }
      }
      if (result === 'TIMEOUT') {
        const lastIdx = Math.min(i + MAX_BARS, m30All.length - 1);
        exitPrice = parseFloat(m30All[lastIdx].mid.c);
      }

      const rawPips = dir === 'BUY'
        ? (exitPrice - price) / pip
        : (price - exitPrice) / pip;

      signals.push({
        i,
        time:       m30All[i].time?.slice(0, 16).replace('T', ' '),
        pair:       PAIR_LABELS[oInstr] || oInstr,
        direction:  dir,
        score:      scored.score,
        maxScore:   scored.maxScore,
        confidence: setup.confidence,
        entry:      price.toFixed(dp),
        sl:         setup.stopLoss.toFixed(dp),
        tp:         setup.takeProfit.toFixed(dp),
        rr:         setup.rr.toFixed(2),
        result,
        exitPrice:  exitPrice.toFixed(dp),
        exitBars,
        pips:       rawPips.toFixed(1),
        session,
        failedChecks: scored.checks.filter(c => !c.pass).map(c => c.name),
      });

      // Skip forward past this simulated trade's exit so signals don't overlap
      skipUntil = i + exitBars + 1;
    }

    // ── Stats ──────────────────────────────────────────────────────────
    const won     = signals.filter(s => s.result === 'WIN');
    const lost    = signals.filter(s => s.result === 'LOSS');
    const timeout = signals.filter(s => s.result === 'TIMEOUT');
    const totalPips = signals.reduce((s, t) => s + parseFloat(t.pips), 0);
    const avgWin  = won.length  ? won.reduce((s, t) => s + parseFloat(t.pips), 0) / won.length  : 0;
    const avgLoss = lost.length ? lost.reduce((s, t) => s + parseFloat(t.pips), 0) / lost.length : 0;
    const avgRR   = avgLoss < 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : '—';
    const winRate = signals.length ? Math.round(won.length / signals.length * 100) : 0;

    // Max drawdown in pips
    let peak = 0, maxDD = 0, cumPips = 0;
    signals.forEach(s => {
      cumPips += parseFloat(s.pips);
      if (cumPips > peak) peak = cumPips;
      const dd = peak - cumPips;
      if (dd > maxDD) maxDD = dd;
    });

    // Equity curve in pips
    let cum = 0;
    const equityCurve = signals.map(s => {
      cum += parseFloat(s.pips);
      return { time: s.time, pips: parseFloat(cum.toFixed(1)) };
    });

    res.json({
      signals,
      equityCurve,
      stats: {
        total: signals.length, won: won.length, lost: lost.length, timeout: timeout.length,
        winRate, totalPips: totalPips.toFixed(1), avgWin: avgWin.toFixed(1), avgLoss: avgLoss.toFixed(1),
        avgRR, maxDD: maxDD.toFixed(1),
        bestTrade:  won.length  ? Math.max(...won.map(s => parseFloat(s.pips))).toFixed(1)  : '0',
        worstTrade: lost.length ? Math.min(...lost.map(s => parseFloat(s.pips))).toFixed(1) : '0',
      },
    });
  } catch (e) {
    console.error('[BACKTEST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TRADE JOURNAL API
// ═════════════════════════════════════════════════════════════════════════════

// Shared by /api/journal and /api/ai/coach — closed OANDA trades merged with
// our signals + journal notes (including psychology data), plus stats
async function buildJournalData(count = 200) {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return null;

  const closedRes = await fetchClosedTrades(count);
  const rawTrades = closedRes.trades;

  // Pull our signals for this account (to merge confidence, score)
  const ourSignals = db.prepare(`SELECT * FROM signals WHERE status='EXECUTED' ORDER BY created_at DESC`).all();
  const sigMap = {};
  ourSignals.forEach(s => { if (s.oanda_order_id) sigMap[s.oanda_order_id] = s; });

  // Pull notes + psychology data
  const noteRows = db.prepare('SELECT * FROM journal_notes').all();
  const noteMap = {};
  noteRows.forEach(n => { noteMap[n.trade_id] = n; });

    const trades = rawTrades.map(t => {
      const sig      = sigMap[t.id] || null;
      const oInstr   = t.instrument;
      const pipSize  = PIP[oInstr] || 0.0001;
      const entry    = parseFloat(t.price);
      const close    = parseFloat(t.averageClosePrice || t.price);
      const pl       = parseFloat(t.realizedPL || 0);
      const units    = Math.abs(parseFloat(t.initialUnits));
      const isBuy    = parseFloat(t.initialUnits) > 0;
      const sl       = t.stopLossOrder ? parseFloat(t.stopLossOrder.price) : (sig?.stop_loss || null);
      const tp       = t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : (sig?.take_profit || null);
      const slPips   = sl ? Math.abs(entry - sl) / pipSize : null;
      const tpPips   = tp ? Math.abs(tp - entry) / pipSize : null;
      const rr       = slPips && tpPips ? (tpPips / slPips).toFixed(2) : null;
      const result   = pl > 0.01 ? 'WIN' : pl < -0.01 ? 'LOSS' : 'BE';
      const priceDiff = Math.abs(close - entry);
      const pips     = (priceDiff / pipSize * (pl >= 0 ? 1 : -1)).toFixed(1);
      const noteRow  = noteMap[t.id] || null;

      return {
        id:           t.id,
        pair:         PAIR_LABELS[oInstr] || oInstr,
        direction:    isBuy ? 'BUY' : 'SELL',
        openTime:     t.openTime?.slice(0, 16).replace('T', ' '),
        closeTime:    t.closeTime?.slice(0, 16).replace('T', ' '),
        entryPrice:   entry.toFixed(5),
        closePrice:   close.toFixed(5),
        pl:           pl,
        pips:         pips,
        sl:           sl ? sl.toFixed(5) : null,
        tp:           tp ? tp.toFixed(5) : null,
        rr:           rr,
        units:        units,
        result:       result,
        confidence:   sig?.confidence || null,
        signal_id:    sig?.id || null,
        note:         noteRow?.note || '',
        psych: noteRow ? {
          stress:       noteRow.stress,
          confidence:   noteRow.confidence,
          fear:         noteRow.fear,
          greed:        noteRow.greed,
          followedPlan: noteRow.followed_plan === 1 ? true : noteRow.followed_plan === 0 ? false : null,
          mistakeTags:  noteRow.mistake_tags ? JSON.parse(noteRow.mistake_tags) : [],
        } : null,
      };
    });

    // Sort by closeTime ascending for equity curve
    const sorted = [...trades].sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));

    // Equity curve (cumulative P&L)
    let cum = 0;
    const equityCurve = sorted.map(t => {
      cum += t.pl;
      return { date: t.closeTime?.slice(0, 10), pl: cum };
    });

    // Monthly breakdown
    const monthMap = {};
    sorted.forEach(t => {
      const m = t.closeTime?.slice(0, 7) || 'Unknown';
      if (!monthMap[m]) monthMap[m] = { month: m, pl: 0, trades: 0, won: 0 };
      monthMap[m].pl     += t.pl;
      monthMap[m].trades += 1;
      if (t.result === 'WIN') monthMap[m].won += 1;
    });
    const monthlyPL = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    // Stats
    const won   = trades.filter(t => t.result === 'WIN');
    const lost  = trades.filter(t => t.result === 'LOSS');
    const be    = trades.filter(t => t.result === 'BE');
    const winPLs  = won.map(t => t.pl);
    const lossPLs = lost.map(t => t.pl);
    const avgWin  = won.length  ? winPLs.reduce((a, b) => a + b, 0)  / won.length  : 0;
    const avgLoss = lost.length ? lossPLs.reduce((a, b) => a + b, 0) / lost.length : 0;
    const avgRR   = avgLoss < 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : '—';
    const totalPL = trades.reduce((s, t) => s + t.pl, 0);
    const bestTrade  = trades.length ? Math.max(...trades.map(t => t.pl)) : 0;
    const worstTrade = trades.length ? Math.min(...trades.map(t => t.pl)) : 0;
    // Max drawdown from equity curve
    let peak = 0, maxDD = 0, running = 0;
    sorted.forEach(t => {
      running += t.pl;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    });
    // Current streak
    let streak = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted.length === 0) break;
      const last = sorted[sorted.length - 1];
      const cur  = sorted[i];
      if (streak === 0) { streak = cur.result === 'WIN' ? 1 : cur.result === 'LOSS' ? -1 : 0; }
      else if (streak > 0 && cur.result === 'WIN') streak++;
      else if (streak < 0 && cur.result === 'LOSS') streak--;
      else break;
    }

    return {
      trades,
      equityCurve,
      monthlyPL,
      historyError: closedRes.ok ? null : closedRes.error,
      stale:        !closedRes.ok && trades.length > 0,
      stats: {
        total:      trades.length,
        won:        won.length,
        lost:       lost.length,
        be:         be.length,
        winRate:    trades.length ? Math.round(won.length / trades.length * 100) : 0,
        totalPL:    totalPL.toFixed(2),
        avgWin:     avgWin.toFixed(2),
        avgLoss:    avgLoss.toFixed(2),
        avgRR,
        bestTrade:  bestTrade.toFixed(2),
        worstTrade: worstTrade.toFixed(2),
        maxDD:      maxDD.toFixed(2),
        streak,
      },
    };
}

// GET /api/journal — closed trades from OANDA merged with our signals, plus stats
app.get('/api/journal', async (req, res) => {
  try {
    const data = await buildJournalData(parseInt(req.query.count || 200));
    if (!data) return res.status(400).json({ error: 'OANDA not configured' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/journal/note — save a note + psychology data for a trade
app.post('/api/journal/note', (req, res) => {
  const { tradeId, note, stress, confidence, fear, greed, followedPlan, mistakeTags } = req.body;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });
  db.prepare(`
    INSERT INTO journal_notes (trade_id, note, stress, confidence, fear, greed, followed_plan, mistake_tags, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(trade_id) DO UPDATE SET
      note=excluded.note, stress=excluded.stress, confidence=excluded.confidence,
      fear=excluded.fear, greed=excluded.greed, followed_plan=excluded.followed_plan,
      mistake_tags=excluded.mistake_tags, updated_at=CURRENT_TIMESTAMP
  `).run(
    String(tradeId), note || '',
    stress ?? null, confidence ?? null, fear ?? null, greed ?? null,
    followedPlan === true ? 1 : followedPlan === false ? 0 : null,
    mistakeTags && mistakeTags.length ? JSON.stringify(mistakeTags) : null
  );
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// AI COACH — psychology-aware performance review (GPT-4o reasons over
// pre-aggregated stats, never raw trade dumps — same validator-not-oracle
// pattern used by the scan engine's AI layer)
// ═════════════════════════════════════════════════════════════════════════════
function summarizeCoachInput(trades) {
  const tagged = trades.filter(t => t.psych && (
    t.psych.stress != null || t.psych.followedPlan !== null || (t.psych.mistakeTags || []).length
  ));
  const won  = trades.filter(t => t.result === 'WIN');
  const lost = trades.filter(t => t.result === 'LOSS');

  const avg = (arr, pick) => {
    const vals = arr.map(pick).filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const planFollowed = tagged.filter(t => t.psych.followedPlan === true);
  const planBroken   = tagged.filter(t => t.psych.followedPlan === false);

  const tagStats = {};
  tagged.forEach(t => {
    (t.psych.mistakeTags || []).forEach(tag => {
      if (!tagStats[tag]) tagStats[tag] = { count: 0, wins: 0, pl: 0 };
      tagStats[tag].count++;
      if (t.result === 'WIN') tagStats[tag].wins++;
      tagStats[tag].pl += t.pl;
    });
  });

  return {
    sampleSize: trades.length,
    psychSampleSize: tagged.length,
    avgStressWin:      avg(won,  t => t.psych?.stress),
    avgStressLoss:     avg(lost, t => t.psych?.stress),
    avgConfidenceWin:  avg(won,  t => t.psych?.confidence),
    avgConfidenceLoss: avg(lost, t => t.psych?.confidence),
    avgFearWin:        avg(won,  t => t.psych?.fear),
    avgFearLoss:       avg(lost, t => t.psych?.fear),
    avgGreedWin:       avg(won,  t => t.psych?.greed),
    avgGreedLoss:      avg(lost, t => t.psych?.greed),
    planFollowedWinRate: planFollowed.length ? planFollowed.filter(t => t.result === 'WIN').length / planFollowed.length : null,
    planBrokenWinRate:   planBroken.length   ? planBroken.filter(t => t.result === 'WIN').length   / planBroken.length   : null,
    tagStats,
  };
}

app.post('/api/ai/coach', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.openai_key) return res.status(400).json({ error: 'OpenAI key not configured' });

  try {
    const count = parseInt(req.body?.count || 50);
    const data = await buildJournalData(count);
    if (!data) return res.status(400).json({ error: 'OANDA not configured' });
    if (data.trades.length < 5) {
      return res.status(400).json({ error: `Need at least 5 closed trades to generate a coaching report — you have ${data.trades.length}.` });
    }

    const summary = summarizeCoachInput(data.trades);
    const recentNotes = data.trades.filter(t => t.note).slice(-10)
      .map(t => `- ${t.pair} ${t.direction} ${t.result} (${t.pl >= 0 ? '+' : ''}${t.pl.toFixed(2)}): "${t.note}"`)
      .join('\n') || 'None logged';

    const tagLines = Object.entries(summary.tagStats)
      .map(([tag, s]) => `  ${tag}: ${s.count} trades, ${Math.round(s.wins / s.count * 100)}% win rate, $${s.pl.toFixed(2)} total P&L`)
      .join('\n') || '  No mistake tags logged yet';

    const prompt = `You are reviewing a forex trader's recent performance.

PERFORMANCE SUMMARY (last ${data.trades.length} closed trades):
Win rate: ${data.stats.winRate}% | Total P&L: $${data.stats.totalPL} | Avg R:R: ${data.stats.avgRR}
Max drawdown: $${data.stats.maxDD} | Current streak: ${data.stats.streak}

PSYCHOLOGY DATA (${summary.psychSampleSize} of ${summary.sampleSize} trades logged with mood ratings, 1-5 scale):
Avg stress — wins: ${summary.avgStressWin?.toFixed(1) ?? 'n/a'} | losses: ${summary.avgStressLoss?.toFixed(1) ?? 'n/a'}
Avg confidence — wins: ${summary.avgConfidenceWin?.toFixed(1) ?? 'n/a'} | losses: ${summary.avgConfidenceLoss?.toFixed(1) ?? 'n/a'}
Avg fear — wins: ${summary.avgFearWin?.toFixed(1) ?? 'n/a'} | losses: ${summary.avgFearLoss?.toFixed(1) ?? 'n/a'}
Avg greed — wins: ${summary.avgGreedWin?.toFixed(1) ?? 'n/a'} | losses: ${summary.avgGreedLoss?.toFixed(1) ?? 'n/a'}
Win rate when plan followed: ${summary.planFollowedWinRate != null ? Math.round(summary.planFollowedWinRate * 100) + '%' : 'n/a'}
Win rate when plan broken: ${summary.planBrokenWinRate != null ? Math.round(summary.planBrokenWinRate * 100) + '%' : 'n/a'}

MISTAKE TAGS LOGGED:
${tagLines}

RECENT JOURNAL NOTES:
${recentNotes}

Based ONLY on this data, write a coaching report with these exact sections:
1. PATTERNS NOTICED — 2-3 bullets connecting psychology/behavior to outcomes, citing the actual numbers above. If sample size is too small for a pattern, say so explicitly rather than inventing one.
2. BIGGEST RISK HABIT — the single most costly behavioral pattern, with its $ impact if calculable.
3. WHAT'S WORKING — 1-2 bullets on what to keep doing.
4. THREE RECOMMENDATIONS — specific, actionable, tied to the data.
5. ONE-LINE VERDICT — a single blunt sentence.

Do not give generic trading advice unrelated to this data. Do not be falsely encouraging — if the data shows a real problem, say so plainly.`;

    const openai = new OpenAI({ apiKey: keys.openai_key });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 900,
      temperature: 0.4,
      messages: [
        { role: 'system', content: 'You are a blunt, data-driven trading psychology coach. You only reason from the numbers given to you — never invent statistics.' },
        { role: 'user', content: prompt },
      ],
    });

    const report = completion.choices[0].message.content;

    db.prepare(`
      INSERT INTO coach_reports (trade_count, win_rate, report, stats_json)
      VALUES (?, ?, ?, ?)
    `).run(data.trades.length, data.stats.winRate, report, JSON.stringify(summary));

    res.json({ report, summary, stats: data.stats });
  } catch (e) {
    res.status(500).json({ error: 'Coach error: ' + (e.response?.data?.error?.message || e.message) });
  }
});

app.get('/api/ai/coach/history', (req, res) => {
  const rows = db.prepare(`
    SELECT id, created_at, trade_count, win_rate, report, stats_json
    FROM coach_reports ORDER BY created_at DESC LIMIT 20
  `).all();
  const reports = rows.map(({ stats_json, ...r }) => ({ ...r, summary: stats_json ? JSON.parse(stats_json) : null }));
  res.json({ reports });
});

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC URL + HEALTH
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/url', (req, res) => {
  const urlFile = path.join(__dirname, 'data', 'current-url.txt');
  try { res.json({ url: fs.readFileSync(urlFile,'utf8').trim(), active:true }); }
  catch { res.json({ url:null, active:false }); }
});

// ── FIX 5: Keys status — return configured flags + masked values only ─────────
// No raw key values ever leave the server after this endpoint
app.get('/api/keys/status', (req, res) => {
  const k = getApiKeys();
  const mask = (v, show = 4) => v ? v.slice(0, show) + '…' + v.slice(-4) : null;
  res.json({
    oanda:    !!k.oanda_key,
    openai:   !!k.openai_key,
    telegram: !!k.tg_token,
    twelve:   !!k.twelve_key,
    masked: {
      oanda_account: k.oanda_account || null,
      openai_key:    k.openai_key  ? mask(k.openai_key,  7) : null,
      oanda_key:     k.oanda_key   ? mask(k.oanda_key,   5) : null,
      tg_token:      k.tg_token    ? mask(k.tg_token,    5) : null,
      twelve_key:    k.twelve_key  ? mask(k.twelve_key,  5) : null,
    },
    auth_enabled: !!APP_SECRET,
  });
});

// ── Audit log endpoint ────────────────────────────────────────────────────────
app.get('/api/audit', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || 100), 500);
  const offset = parseInt(req.query.offset || 0);
  const rows   = db.prepare(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
  const total  = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  res.json({ total, rows });
});

// ── Ghost positions endpoint ──────────────────────────────────────────────────
app.get('/api/ghosts', (req, res) => {
  const rows = db.prepare(`SELECT * FROM ghost_positions ORDER BY detected_at DESC LIMIT 50`).all();
  res.json(rows);
});
app.post('/api/ghosts/:id/resolve', (req, res) => {
  const { notes } = req.body;
  db.prepare(`UPDATE ghost_positions SET status='RESOLVED', resolved_at=CURRENT_TIMESTAMP, notes=? WHERE id=?`)
    .run(notes || 'Manually resolved', parseInt(req.params.id));
  writeAudit('GHOST_RESOLVED', { ghost_id: req.params.id, notes }, 'WEB_UI', req.params.id);
  res.json({ ok: true });
});

// ── Pair breakers endpoint ────────────────────────────────────────────────────
app.get('/api/pair-breakers', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM pair_breakers WHERE blocked_until > datetime('now') ORDER BY created_at DESC`
  ).all();
  res.json(rows);
});
app.delete('/api/pair-breakers/:pair', (req, res) => {
  const pair = decodeURIComponent(req.params.pair);
  db.prepare(`DELETE FROM pair_breakers WHERE pair=?`).run(pair);
  writeAudit('PAIR_BREAKER_CLEARED', { pair }, 'WEB_UI', pair);
  res.json({ ok: true });
});

// ── AI decisions log endpoint ─────────────────────────────────────────────────
app.get('/api/ai/decisions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || 50), 200);
  const rows  = db.prepare(`SELECT * FROM ai_decisions ORDER BY created_at DESC LIMIT ?`).all(limit);
  const stats = db.prepare(`
    SELECT
      decision,
      COUNT(*) as count,
      AVG(ai_confidence) as avg_conf,
      AVG(latency_ms) as avg_latency
    FROM ai_decisions GROUP BY decision
  `).all();
  res.json({ rows, stats });
});

// FIX 3 — Slippage analytics endpoint
app.get('/api/execution/slippage', (req, res) => {
  const rows = db.prepare(`SELECT * FROM execution_log ORDER BY created_at DESC LIMIT 100`).all();
  if (!rows.length) return res.json({ message: 'No execution data yet', rows: [] });

  const negSlip = rows.filter(r => r.slippage_dir === 'NEGATIVE');
  const posSlip = rows.filter(r => r.slippage_dir === 'POSITIVE');
  const avgSlip = rows.reduce((s, r) => s + (r.slippage_pips || 0), 0) / rows.length;
  const maxSlip = Math.max(...rows.map(r => r.slippage_pips || 0));

  const byPair = {};
  rows.forEach(r => {
    if (!byPair[r.pair]) byPair[r.pair] = { count: 0, totalSlip: 0 };
    byPair[r.pair].count++;
    byPair[r.pair].totalSlip += r.slippage_pips || 0;
  });
  Object.keys(byPair).forEach(p => {
    byPair[p].avgSlip = (byPair[p].totalSlip / byPair[p].count).toFixed(2);
  });

  res.json({
    total_fills: rows.length,
    avg_slippage_pips: avgSlip.toFixed(2),
    max_slippage_pips: maxSlip.toFixed(2),
    negative_slippage: negSlip.length,
    positive_slippage: posSlip.length,
    avg_latency_ms: rows.length ? (rows.reduce((s,r) => s+(r.latency_ms||0), 0) / rows.length).toFixed(0) : 0,
    by_pair: byPair,
    recent: rows.slice(0, 10),
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTELLIGENCE API — full institutional pre-trade report
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/intelligence', async (req, res) => {
  try {
    const keys = getApiKeys();

    // Portfolio heat
    const heat = getPortfolioHeat();

    // System health
    const ddVel    = checkDrawdownVelocity();
    const confDrift= checkConfidenceDrift();
    const freqAnom = checkSignalFrequencyAnomaly();

    // Session + news
    const session  = getSession();
    const newsCount= newsCache.filter(n => {
      if (n.impact !== 'HIGH') return false;
      const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      const [hh, mm] = (n.time || '99:99').split(':').map(Number);
      const diff = nowMin - (hh * 60 + mm);
      return diff >= -45 && diff <= 60; // 45 min before, 60 min after
    }).length;

    // Infrastructure
    const avgLat  = getOandaAvgLatency();
    const daily   = getDailyPL();
    const consec  = getConsecutiveLosses();

    // Recent signal quality
    const recentSignals = db.prepare(`
      SELECT pair, direction, confidence, status, realized_pl, created_at
      FROM signals ORDER BY created_at DESC LIMIT 10
    `).all();
    const closedRecent  = recentSignals.filter(s => s.status === 'CLOSED');
    const winRate7d     = closedRecent.length
      ? Math.round(closedRecent.filter(s => s.realized_pl > 0).length / closedRecent.length * 100) : null;

    // Per-pair win rates (all time)
    const pairStats = db.prepare(`
      SELECT pair,
        COUNT(*) as total,
        SUM(CASE WHEN realized_pl > 0 THEN 1 ELSE 0 END) as wins,
        AVG(confidence) as avg_conf,
        ROUND(AVG(realized_pl), 2) as avg_pl
      FROM signals WHERE status='CLOSED'
      GROUP BY pair ORDER BY total DESC
    `).all();

    // Per-session win rates
    const sessionStats = db.prepare(`
      SELECT
        CASE
          WHEN CAST(strftime('%H', created_at) AS INT) BETWEEN 7  AND 11 THEN 'LONDON'
          WHEN CAST(strftime('%H', created_at) AS INT) BETWEEN 12 AND 16 THEN 'NY'
          WHEN CAST(strftime('%H', created_at) AS INT) BETWEEN 0  AND 6  THEN 'ASIAN'
          ELSE 'OFF_HOURS'
        END as sess,
        COUNT(*) as total,
        SUM(CASE WHEN realized_pl > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(AVG(realized_pl), 2) as avg_pl
      FROM signals WHERE status='CLOSED'
      GROUP BY sess
    `).all();

    res.json({
      timestamp: new Date().toISOString(),

      // Stage 1 — Market Environment
      environment: {
        session,
        session_tradeable: ['LONDON','NY'].includes(session),
        high_impact_news_now: newsCount > 0,
        news_blackout: newsCount > 0 ? `${newsCount} HIGH-impact event(s) within ±45 min — DO NOT TRADE` : 'Clear',
        oanda_latency_ms: Math.round(avgLat),
        feed_healthy: avgLat < 3000 || avgLat === 0,
      },

      // Stage 4 — Risk
      risk: {
        daily_pl:          daily.realized_pl.toFixed(2),
        consecutive_losses: consec,
        circuit_breaker:   consec >= 3,
        drawdown_velocity: ddVel,
        portfolio_heat:    heat,
      },

      // Stage 5 — Statistical intelligence
      statistics: {
        win_rate_7d:    winRate7d,
        recent_signals: recentSignals.length,
        by_pair:        pairStats.map(p => ({
          pair: p.pair, total: p.total,
          win_rate: p.total ? Math.round(p.wins / p.total * 100) : null,
          avg_conf: parseFloat((p.avg_conf || 0).toFixed(1)),
          avg_pl:   p.avg_pl,
        })),
        by_session: sessionStats.map(s => ({
          session: s.sess, total: s.total,
          win_rate: s.total ? Math.round(s.wins / s.total * 100) : null,
          avg_pl:   s.avg_pl,
        })),
      },

      // Stage 5 — AI governance
      ai_governance: {
        confidence_drift:    confDrift,
        signal_frequency:    freqAnom,
      },

      // System verdict
      verdict: {
        safe_to_trade: !newsCount && consec < 3 && ddVel.velocity !== 'RAPID' && heat.safe_to_add,
        blockers: [
          newsCount > 0 ? 'High-impact news active' : null,
          consec >= 3 ? `Circuit breaker: ${consec} consecutive losses` : null,
          ddVel.velocity === 'RAPID' ? ddVel.warning : null,
          !heat.safe_to_add ? heat.warning : null,
        ].filter(Boolean),
      },
    });
  } catch (e) {
    console.error('[INTELLIGENCE] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Portfolio heat endpoint
app.get('/api/portfolio/heat', (req, res) => {
  res.json(getPortfolioHeat());
});

app.get('/api/health', (req, res) => {
  const keys   = getApiKeys();
  const daily  = getDailyPL();
  const consec = getConsecutiveLosses();
  const pending = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='PENDING'`).get();
  const closed  = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='CLOSED'`).get();
  const blocked = db.prepare(`SELECT COUNT(*) as c FROM risk_events WHERE date(created_at)=date('now')`).get();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    env:    isProd ? 'production' : 'development',
    price_source: priceSource,
    news_events:  newsCache.length,
    keys_configured: {
      oanda:    !!keys.oanda_key,
      twelve:   !!keys.twelve_key,
      telegram: !!keys.tg_token,
    },
    ai_engine: keys.openai_key ? 'Calc Engine → GPT-4o validation' : 'Rule-Based Calc Engine only',
    risk_governors: {
      daily_pl:           daily.realized_pl.toFixed(2),
      consecutive_losses: consec,
      circuit_breaker:    consec >= 3,
      blocks_today:       blocked.c,
    },
    infrastructure: {
      oanda_avg_latency_ms: Math.round(getOandaAvgLatency()),
      oanda_fail_count:     oandaFailCount,
      stale_pairs:          Object.keys(priceCache).filter(p => isFeedStale(p)),
      friday_size_factor:   getTimeBasedSizeFactor(),
    },
    signal_counts: {
      pending:  pending.c,
      closed_reconciled: closed.c,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST-TRADE ATTRIBUTION & CONFIDENCE CALIBRATION
// ═════════════════════════════════════════════════════════════════════════════

// Full attribution breakdown — after 50+ closed trades this reveals what works
app.get('/api/analytics/attribution', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM trade_attribution WHERE outcome IS NOT NULL ORDER BY created_at DESC
  `).all();

  if (rows.length < 5) return res.json({ message: `Need more closed trades (have ${rows.length}, need 5+)`, rows });

  const win  = rows.filter(r => r.outcome === 'WIN');
  const loss = rows.filter(r => r.outcome === 'LOSS');

  const winRate = r => r.length ? Math.round(win.filter(w => rows.filter(x => x[Object.keys(r[0])[0]] === w[Object.keys(r[0])[0]]).length > 0).length / r.length * 100) : null;

  // Group by dimension helper
  const groupBy = (field) => {
    const groups = {};
    for (const r of rows) {
      const k = r[field] ?? 'UNKNOWN';
      if (!groups[k]) groups[k] = { total:0, wins:0, totalPL:0, totalPips:0 };
      groups[k].total++;
      if (r.outcome === 'WIN') groups[k].wins++;
      groups[k].totalPL   += r.realized_pl   || 0;
      groups[k].totalPips += parseFloat(r.actual_pips || 0);
    }
    return Object.entries(groups).map(([k, v]) => ({
      [field]: k,
      total:    v.total,
      win_rate: Math.round(v.wins / v.total * 100),
      avg_pl:   parseFloat((v.totalPL / v.total).toFixed(2)),
      avg_pips: parseFloat((v.totalPips / v.total).toFixed(1)),
      total_pl: parseFloat(v.totalPL.toFixed(2)),
    })).sort((a, b) => b.total - a.total);
  };

  res.json({
    summary: {
      total:    rows.length,
      wins:     win.length,
      losses:   loss.length,
      win_rate: Math.round(win.length / rows.length * 100),
      total_pl: parseFloat(rows.reduce((s, r) => s + (r.realized_pl || 0), 0).toFixed(2)),
    },
    by_pair:       groupBy('pair'),
    by_session:    groupBy('session'),
    by_regime:     groupBy('regime'),
    by_structure:  groupBy('structure_bias'),
    by_bos:        groupBy('bos'),
    by_score:      groupBy('score'),
    by_w1_trend:   groupBy('w1_trend'),
    by_exit_reason:groupBy('exit_reason'),
    by_sweep_risk: groupBy('sweep_risk'),
    raw: rows.slice(0, 50),
  });
});

// Confidence calibration: does 90% confidence actually win 90%?
app.get('/api/analytics/calibration', (req, res) => {
  const rows = db.prepare(`
    SELECT confidence, outcome FROM trade_attribution WHERE outcome IS NOT NULL
  `).all();

  if (rows.length < 10) return res.json({ message: `Need 10+ closed trades (have ${rows.length})`, rows: [] });

  // Group into confidence bands: <70, 70-79, 80-89, 90-95
  const bands = { '<70':[70,0], '70-79':[70,80], '80-89':[80,90], '90+':[90,100] };
  const result = Object.entries(bands).map(([label, [lo, hi]]) => {
    const inBand = rows.filter(r => r.confidence >= lo && r.confidence < hi);
    const wins   = inBand.filter(r => r.outcome === 'WIN');
    const avgConf= inBand.length ? inBand.reduce((s,r) => s + r.confidence, 0) / inBand.length : 0;
    const actualWinPct = inBand.length ? Math.round(wins.length / inBand.length * 100) : null;
    return {
      band:           label,
      trade_count:    inBand.length,
      stated_conf_avg:parseFloat(avgConf.toFixed(1)),
      actual_win_pct: actualWinPct,
      gap:            actualWinPct !== null ? actualWinPct - Math.round(avgConf) : null,
      calibrated:     actualWinPct !== null && Math.abs(actualWinPct - avgConf) < 10,
    };
  }).filter(b => b.trade_count > 0);

  // Save snapshot to DB for trend tracking
  try {
    for (const b of result) {
      if (b.trade_count >= 5) {
        db.prepare(`
          INSERT INTO confidence_calibration
            (confidence_band, trade_count, win_count, actual_win_pct, stated_conf_avg, calibration_gap)
          VALUES (?,?,?,?,?,?)
        `).run(b.band, b.trade_count,
          rows.filter(r => r.outcome==='WIN' && r.confidence >= parseInt(b.band) || 0).length,
          b.actual_win_pct, b.stated_conf_avg, b.gap);
      }
    }
  } catch {}

  res.json({
    message: result.some(b => b.gap !== null && Math.abs(b.gap) > 15)
      ? '⚠️ Confidence is miscalibrated — stated % does not match actual win rate'
      : '✅ Confidence is roughly calibrated',
    calibration: result,
    total_trades: rows.length,
  });
});

// Operator approval analytics — detects if you're lowering your personal threshold
app.get('/api/analytics/operator', (req, res) => {
  const approved = db.prepare(`
    SELECT confidence, realized_pl, outcome FROM trade_attribution
    WHERE signal_id IN (SELECT id FROM signals WHERE status IN ('EXECUTED','CLOSED'))
    ORDER BY created_at DESC LIMIT 30
  `).all();
  const rejected = db.prepare(`
    SELECT confidence FROM signals WHERE status='REJECTED'
    ORDER BY actioned_at DESC LIMIT 30
  `).all();

  if (approved.length < 3) return res.json({ message: 'Need 3+ approved signals', approved: [], rejected: [] });

  const avgApproved = approved.reduce((s, r) => s + r.confidence, 0) / approved.length;
  const avgRejected = rejected.length ? rejected.reduce((s, r) => s + r.confidence, 0) / rejected.length : null;
  const closed      = approved.filter(r => r.outcome);
  const winRate     = closed.length ? Math.round(closed.filter(r => r.outcome === 'WIN').length / closed.length * 100) : null;

  const warnings = [];
  if (avgApproved < 82 && approved.length >= 5) {
    warnings.push(`⚠️ Avg approved confidence ${avgApproved.toFixed(0)}% is below 82% — you may be approving low-quality signals`);
  }
  if (avgRejected !== null && avgRejected > avgApproved) {
    warnings.push(`⚠️ Avg rejected confidence (${avgRejected.toFixed(0)}%) > avg approved (${avgApproved.toFixed(0)}%) — approving weaker signals than rejecting`);
  }

  res.json({
    approval_stats: {
      approved_count:    approved.length,
      rejected_count:    rejected.length,
      approval_rate:     Math.round(approved.length / (approved.length + rejected.length) * 100),
      avg_approved_conf: parseFloat(avgApproved.toFixed(1)),
      avg_rejected_conf: avgRejected !== null ? parseFloat(avgRejected.toFixed(1)) : null,
      win_rate_approved: winRate,
    },
    warnings,
    recent_approved: approved.slice(0, 10),
  });
});

// Trade distribution health — concentration risk detection
app.get('/api/analytics/distribution', (req, res) => {
  const recent = db.prepare(`
    SELECT pair, session, direction, confidence, outcome
    FROM trade_attribution ORDER BY created_at DESC LIMIT 50
  `).all();

  if (recent.length < 5) return res.json({ message: 'Need 5+ signals', data: [] });

  // Pair concentration
  const pairCounts = {};
  for (const r of recent) {
    pairCounts[r.pair] = (pairCounts[r.pair] || 0) + 1;
  }
  const topPair    = Object.entries(pairCounts).sort((a,b) => b[1]-a[1])[0];
  const topPairPct = Math.round(topPair[1] / recent.length * 100);

  // Session concentration
  const sessCounts = {};
  for (const r of recent) {
    sessCounts[r.session] = (sessCounts[r.session] || 0) + 1;
  }
  const topSess    = Object.entries(sessCounts).sort((a,b) => b[1]-a[1])[0];
  const topSessPct = Math.round(topSess[1] / recent.length * 100);

  // Direction bias
  const buys  = recent.filter(r => r.direction === 'BUY').length;
  const sells = recent.filter(r => r.direction === 'SELL').length;
  const dirBiasPct = Math.round(Math.max(buys, sells) / recent.length * 100);

  const alerts = [];
  if (topPairPct > 60)  alerts.push(`⚠️ ${topPair[0]} = ${topPairPct}% of recent signals — over-concentrated in one pair`);
  if (topSessPct > 80)  alerts.push(`⚠️ ${topSess[0]} = ${topSessPct}% of signals — all trades from one session`);
  if (dirBiasPct > 80)  alerts.push(`⚠️ ${dirBiasPct}% ${buys > sells ? 'BUY' : 'SELL'} bias — system heavily one-directional`);

  res.json({
    sample_size:  recent.length,
    by_pair:      Object.entries(pairCounts).map(([p,c]) => ({ pair:p, count:c, pct: Math.round(c/recent.length*100) })).sort((a,b)=>b.count-a.count),
    by_session:   Object.entries(sessCounts).map(([s,c]) => ({ session:s, count:c, pct: Math.round(c/recent.length*100) })).sort((a,b)=>b.count-a.count),
    direction_bias: { buys, sells, bias_pct: dirBiasPct },
    alerts,
  });
});

// ── Advanced professional metrics — Sharpe, Sortino, Calmar, Recovery Factor ──
app.get('/api/analytics/advanced', (req, res) => {
  const closed = db.prepare(`
    SELECT realized_pl, confidence, exit_reason, duration_mins, actual_pips
    FROM signals WHERE status='CLOSED' ORDER BY closed_at ASC
  `).all();

  if (closed.length < 5) return res.json({ message:`Need 5+ closed trades (have ${closed.length})`, trades:closed.length });

  const pls    = closed.map(t => t.realized_pl || 0);
  const wins   = pls.filter(p => p > 0);
  const losses = pls.filter(p => p < 0);

  // Core metrics
  const totalPL   = pls.reduce((s, p) => s + p, 0);
  const winRate   = pls.length ? wins.length / pls.length : 0;
  const avgWin    = wins.length   ? wins.reduce((s,p)  => s+p, 0) / wins.length   : 0;
  const avgLoss   = losses.length ? losses.reduce((s,p) => s+p, 0) / losses.length : 0;
  const grossWin  = wins.reduce((s,p) => s+p, 0);
  const grossLoss = Math.abs(losses.reduce((s,p) => s+p, 0));
  const profitFactor = grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(3)) : null;
  const expectancy   = parseFloat(((winRate * avgWin) + ((1 - winRate) * avgLoss)).toFixed(2));

  // Sharpe Ratio = avgReturn / stdDev (risk-free rate = 0 for forex)
  const avgReturn = totalPL / pls.length;
  const variance  = pls.reduce((s, p) => s + (p - avgReturn) ** 2, 0) / pls.length;
  const stdDev    = Math.sqrt(variance);
  const sharpe    = stdDev > 0 ? parseFloat((avgReturn / stdDev).toFixed(3)) : 0;

  // Sortino Ratio = avgReturn / downside deviation
  const downsidePLs  = pls.filter(p => p < 0);
  const downsideVar  = downsidePLs.length ? downsidePLs.reduce((s, p) => s + p ** 2, 0) / downsidePLs.length : 0;
  const downsideStd  = Math.sqrt(downsideVar);
  const sortino      = downsideStd > 0 ? parseFloat((avgReturn / downsideStd).toFixed(3)) : 0;

  // Max Drawdown ($) and % from peak equity
  let peak = 0, maxDD = 0, maxDDPct = 0, cum = 0;
  const equityCurve = [];
  for (const p of pls) {
    cum += p;
    equityCurve.push(parseFloat(cum.toFixed(2)));
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) { maxDD = dd; maxDDPct = peak > 0 ? dd / peak * 100 : 0; }
  }

  // Calmar Ratio = total_profit / max_drawdown (proxy for annualized / MDD)
  const calmar         = maxDD > 0 ? parseFloat((totalPL / maxDD).toFixed(3)) : null;
  // Recovery Factor = total_net_profit / max_drawdown
  const recoveryFactor = maxDD > 0 ? parseFloat((totalPL / maxDD).toFixed(2)) : null;

  // Average trade duration and pips
  const validDur  = closed.filter(t => t.duration_mins);
  const avgDurMin = validDur.length ? Math.round(validDur.reduce((s,t) => s + t.duration_mins, 0) / validDur.length) : null;
  const validPips = closed.filter(t => t.actual_pips != null);
  const avgPips   = validPips.length ? parseFloat((validPips.reduce((s,t) => s + parseFloat(t.actual_pips||0), 0) / validPips.length).toFixed(1)) : null;

  // Consecutive wins/losses (current streak)
  let streak = 0;
  for (let i = pls.length - 1; i >= 0; i--) {
    if (streak === 0) { streak = pls[i] > 0 ? 1 : pls[i] < 0 ? -1 : 0; continue; }
    if (streak > 0 && pls[i] > 0) streak++;
    else if (streak < 0 && pls[i] < 0) streak--;
    else break;
  }

  // Grade the system (simple scoring)
  const grade =
    (sharpe >= 1.5 && sortino >= 2 && profitFactor >= 2 && winRate >= 0.55) ? 'A — Institutional quality' :
    (sharpe >= 1.0 && sortino >= 1.5 && profitFactor >= 1.5 && winRate >= 0.50) ? 'B — Professional' :
    (profitFactor >= 1.2 && winRate >= 0.45) ? 'C — Developing edge' : 'D — Needs improvement';

  res.json({
    trades: pls.length,
    grade,
    performance: {
      total_pl:       parseFloat(totalPL.toFixed(2)),
      win_rate_pct:   Math.round(winRate * 100),
      profit_factor:  profitFactor,
      expectancy_per_trade: expectancy,
      avg_win:        parseFloat(avgWin.toFixed(2)),
      avg_loss:       parseFloat(avgLoss.toFixed(2)),
      avg_duration_mins: avgDurMin,
      avg_pips:       avgPips,
      current_streak: streak,
    },
    risk_metrics: {
      max_drawdown:     parseFloat(maxDD.toFixed(2)),
      max_dd_pct:       parseFloat(maxDDPct.toFixed(1)),
      recovery_factor:  recoveryFactor,
    },
    ai_metrics: {
      sharpe_ratio:   sharpe,
      sortino_ratio:  sortino,
      calmar_ratio:   calmar,
      interpretation: {
        sharpe:  sharpe >= 1.5 ? 'Excellent (>1.5)' : sharpe >= 1.0 ? 'Good (1.0-1.5)' : sharpe >= 0.5 ? 'Acceptable (0.5-1.0)' : 'Weak (<0.5)',
        sortino: sortino >= 2.0 ? 'Excellent (>2.0)' : sortino >= 1.0 ? 'Good (1.0-2.0)' : 'Weak (<1.0)',
        calmar:  calmar == null ? 'N/A' : calmar >= 3.0 ? 'Excellent (>3)' : calmar >= 1.0 ? 'Good (1-3)' : 'Weak (<1)',
      },
    },
    equity_curve: equityCurve,
  });
});

// Learning engine full state
app.get('/api/analytics/learning', (req, res) => {
  const stats   = db.prepare(`SELECT * FROM condition_stats WHERE trades >= 2 ORDER BY trades DESC`).all();
  const lessons  = db.prepare(`SELECT * FROM trade_lessons ORDER BY created_at DESC LIMIT 30`).all();
  const total    = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='CLOSED'`).get().c;

  // Find the strongest patterns (most impactful to act on)
  const avoid    = stats.filter(s => s.win_rate < 40 && s.trades >= 3).sort((a,b) => a.win_rate - b.win_rate);
  const reinforce= stats.filter(s => s.win_rate > 65 && s.trades >= 3).sort((a,b) => b.win_rate - a.win_rate);

  res.json({
    closed_trades: total,
    data_sufficient: total >= 10,
    strongest_avoid:    avoid.slice(0, 5),
    strongest_reinforce: reinforce.slice(0, 5),
    all_conditions:  stats,
    recent_lessons:  lessons,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SYNC ENV KEYS → DB so the frontend can read them via /api/storage/ptp_keys
// ═════════════════════════════════════════════════════════════════════════════
(function syncEnvKeysToDb() {
  const existing = getStorageValue('ptp_keys') || {};
  const merged = {
    ...existing,
    ...(process.env.OPENAI_API_KEY    ? { openai_key:    process.env.OPENAI_API_KEY }    : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { claude_key:    process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.OANDA_API_KEY     ? { oanda_key:     process.env.OANDA_API_KEY }     : {}),
    ...(process.env.OANDA_ACCOUNT_ID  ? { oanda_account: process.env.OANDA_ACCOUNT_ID }  : {}),
    ...(process.env.TWELVE_DATA_KEY   ? { twelve_key:    process.env.TWELVE_DATA_KEY }   : {}),
    ...(process.env.TELEGRAM_TOKEN    ? { tg_token:      process.env.TELEGRAM_TOKEN }    : {}),
    ...(process.env.TELEGRAM_CHAT_ID  ? { tg_chat:       process.env.TELEGRAM_CHAT_ID }  : {}),
  };
  setStorageValue('ptp_keys', merged);
  invalidateKeysCache();
  console.log('[KEYS] Env vars synced to DB — frontend will see all keys');
})();

// ═════════════════════════════════════════════════════════════════════════════
// SERVE REACT APP — always serve if dist folder exists (dev or prod)
// ═════════════════════════════════════════════════════════════════════════════
const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  // Hashed assets (JS/CSS) — cache 1 year, immutable (Vite content-hashes filenames)
  // This allows Cloudflare to cache at the edge so repeated requests never hit the origin
  app.use('/assets', express.static(path.join(clientDist, 'assets'), {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }));
  // index.html — never cache so deploys propagate immediately
  app.use(express.static(clientDist, { maxAge: 0, etag: false }));
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ┌──────────────────────────────────────────────┐
  │       PRECISION TRADER PRO — SERVER v2       │
  │  Port  : ${PORT}                               │
  │  Mode  : ${isProd ? 'PRODUCTION' : 'DEVELOPMENT     '}                    │
  │  Fixes : AI+Candles | PositionSizer | Limits │
  └──────────────────────────────────────────────┘
  `);
});
