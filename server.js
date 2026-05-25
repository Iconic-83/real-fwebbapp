require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const axios   = require('axios');
const OpenAI  = require('openai');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getStorageValue(key) {
  const row = db.prepare('SELECT value FROM storage WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setStorageValue(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(`
    INSERT INTO storage (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, v);
}

function getApiKeys() {
  const stored = getStorageValue('ptp_keys') || {};
  return {
    openai_key:    process.env.OPENAI_API_KEY   || stored.openai_key   || '',
    oanda_key:     process.env.OANDA_API_KEY     || stored.oanda_key    || '',
    oanda_account: process.env.OANDA_ACCOUNT_ID  || stored.oanda_account|| '',
    twelve_key:    process.env.TWELVE_DATA_KEY   || stored.twelve_key   || '',
    tg_token:      process.env.TELEGRAM_TOKEN    || stored.tg_token     || '',
    tg_chat:       process.env.TELEGRAM_CHAT_ID  || stored.tg_chat      || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE API  (key-value store for frontend config)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/storage/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM storage WHERE key = ?').get(req.params.key);
  res.json({ value: row?.value ?? null });
});

app.post('/api/storage/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  db.prepare(`
    INSERT INTO storage (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(req.params.key, value);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRICES API  — Primary: OANDA (free, unlimited) | Fallback: Twelve Data
// Server-side cache: polls every 5s, frontend gets instant response every time
// ─────────────────────────────────────────────────────────────────────────────
const PAIRS      = ['EUR/USD','GBP/USD','USD/JPY','XAU/USD','AUD/USD','USD/CAD'];
const OANDA_INSTR = 'EUR_USD,GBP_USD,USD_JPY,XAU_USD,AUD_USD,USD_CAD';

let priceCache     = {};   // { 'EUR/USD': '1.08450', ... }
let priceCacheTime = 0;    // timestamp of last successful fetch
let priceSource    = 'none';

// Background price poller — runs every 5 seconds, uses OANDA first
async function pollPrices() {
  const keys = getApiKeys();

  // ── Try OANDA pricing endpoint (free, real-time, no rate limit) ──────────
  if (keys.oanda_key && keys.oanda_account) {
    const bases = ['https://api-fxpractice.oanda.com', 'https://api-fxtrade.oanda.com'];
    for (const base of bases) {
      try {
        const r = await axios.get(
          `${base}/v3/accounts/${keys.oanda_account}/pricing?instruments=${OANDA_INSTR}`,
          { headers: { Authorization: `Bearer ${keys.oanda_key}` }, timeout: 8000 }
        );
        if (r.data?.prices?.length > 0) {
          const newCache = {};
          r.data.prices.forEach(p => {
            const sym = p.instrument.replace('_', '/');
            const bid = parseFloat(p.bids?.[0]?.price || 0);
            const ask = parseFloat(p.asks?.[0]?.price || 0);
            if (bid && ask) newCache[sym] = ((bid + ask) / 2).toFixed(p.instrument === 'XAU_USD' ? 2 : 5);
          });
          if (Object.keys(newCache).length > 0) {
            priceCache     = newCache;
            priceCacheTime = Date.now();
            priceSource    = 'OANDA';
            return; // success — no need to try Twelve Data
          }
        }
      } catch {}
    }
  }

  // ── Fallback: Twelve Data (800 calls/day — only used if OANDA fails) ─────
  if (keys.twelve_key) {
    try {
      const syms = PAIRS.join(',');
      const r = await axios.get(
        `https://api.twelvedata.com/price?symbol=${syms}&apikey=${keys.twelve_key}`,
        { timeout: 10000 }
      );
      if (r.data && !r.data.code) { // code present = error (e.g. 429)
        const newCache = {};
        PAIRS.forEach(p => { if (r.data[p]?.price) newCache[p] = r.data[p].price; });
        if (Object.keys(newCache).length > 0) {
          priceCache     = newCache;
          priceCacheTime = Date.now();
          priceSource    = 'TwelveData';
        }
      }
    } catch {}
  }
}

// Start polling immediately and every 5 seconds
pollPrices();
setInterval(pollPrices, 5000);

// Price endpoint — instant response from cache (no rate limits hit per request)
app.get('/api/prices', (req, res) => {
  if (Object.keys(priceCache).length === 0) {
    return res.status(503).json({ error: 'Prices not yet loaded. Configure OANDA or Twelve Data keys.' });
  }
  // Convert to Twelve Data format so frontend works unchanged
  const out = {};
  PAIRS.forEach(p => { if (priceCache[p]) out[p] = { price: priceCache[p] }; });
  res.json(out);
});

// Price source info
app.get('/api/prices/source', (req, res) => {
  res.json({
    source:    priceSource,
    cached_at: priceCacheTime ? new Date(priceCacheTime).toISOString() : null,
    age_ms:    priceCacheTime ? Date.now() - priceCacheTime : null,
    pairs:     priceCache,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OANDA PROXY  (all OANDA v3 requests proxied through backend)
// ─────────────────────────────────────────────────────────────────────────────
app.all('/api/oanda/*', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.oanda_key) return res.status(400).json({ error: 'OANDA API key not configured' });

  const oandaPath = req.path.replace('/api/oanda', '');
  const bases = ['https://api-fxpractice.oanda.com', 'https://api-fxtrade.oanda.com'];

  for (const base of bases) {
    try {
      const r = await axios({
        method: req.method,
        url: base + oandaPath,
        params: req.query,
        data: req.method !== 'GET' ? req.body : undefined,
        headers: {
          Authorization: `Bearer ${keys.oanda_key}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      });
      return res.json(r.data);
    } catch (e) {
      if (e.response) {
        // Got a response (auth error, not connection error) — return it
        return res.status(e.response.status).json(e.response.data);
      }
      // Connection error — try next base
    }
  }
  res.status(502).json({ error: 'OANDA unreachable from both endpoints' });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYSIS  (OpenAI GPT-4o)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ai/analyze', async (req, res) => {
  const { pair, price, systemContext = '' } = req.body;
  const keys = getApiKeys();

  if (!keys.openai_key) {
    return res.status(400).json({ error: 'OpenAI API key not configured. Add it in Settings.' });
  }

  try {
    const openai = new OpenAI({ apiKey: keys.openai_key });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [{
        role: 'system',
        content: 'You are an expert forex trading analyst AI embedded in PrecisionTraderPro. Give concise, actionable analysis based on current price data. Be realistic and precise with numbers.',
      }, {
        role: 'user',
        content: `Analyze ${pair} at current price ${price}.${systemContext}

Provide structured analysis with exactly these 10 points, one per line:
1. Market Bias: BULLISH / BEARISH / NEUTRAL
2. Confidence Score: X%
3. Entry Zone: [price or range]
4. Stop Loss: [price]
5. Take Profit: [price]
6. Risk/Reward: 1:X
7. Pattern: [technical pattern name]
8. Key Support: [price]
9. Key Resistance: [price]
10. Recommendation: [one clear action sentence]`,
      }],
    });
    res.json({ analysis: completion.choices[0].message.content });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: 'OpenAI error: ' + msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWS CALENDAR  (Forex Factory real calendar + fallback)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    // Forex Factory public calendar JSON (free, no key needed)
    const r = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrecisionTraderPro/1.0)' },
    });

    const impactMap = {
      'High Impact Expected': 'HIGH',
      'Medium Impact Expected': 'MED',
      'Low Impact Expected': 'LOW',
      'Non-Economic': 'LOW',
    };

    const events = (r.data || [])
      .filter(e => ['High Impact Expected', 'Medium Impact Expected'].includes(e.impact))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 12)
      .map(e => {
        const dt = new Date(e.date);
        const hh = String(dt.getUTCHours()).padStart(2, '0');
        const mm = String(dt.getUTCMinutes()).padStart(2, '0');
        return {
          time: `${hh}:${mm}`,
          currency: e.country,
          impact: impactMap[e.impact] || 'LOW',
          event: e.title,
          forecast: e.forecast || '—',
          previous: e.previous || '—',
          notes: `${e.title} data release for ${e.country}.`,
        };
      });

    if (events.length === 0) throw new Error('Empty calendar');
    res.json(events);
  } catch {
    // Static fallback
    res.json([
      { time:'08:30', currency:'USD', impact:'HIGH', event:'Core CPI m/m',      forecast:'0.3%', previous:'0.4%', notes:'Key inflation gauge watched by the Fed.' },
      { time:'09:00', currency:'EUR', impact:'MED',  event:'ECB President Speech',forecast:'—',   previous:'—',   notes:'Markets watch for rate guidance signals.' },
      { time:'12:30', currency:'GBP', impact:'HIGH', event:'GDP q/q',           forecast:'0.1%', previous:'0.0%', notes:'Weak GDP could weigh on sterling.' },
      { time:'14:00', currency:'USD', impact:'HIGH', event:'FOMC Meeting Minutes',forecast:'—',   previous:'—',   notes:'Tone on rate path will drive USD moves.' },
      { time:'14:30', currency:'USD', impact:'LOW',  event:'Crude Oil Inventories',forecast:'-1.2M',previous:'2.1M',notes:'Surprise draw could boost commodity FX.' },
      { time:'18:00', currency:'JPY', impact:'MED',  event:'BOJ Policy Rate',   forecast:'0.1%', previous:'0.1%', notes:'Any hawkish shift may trigger JPY rally.' },
    ]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CURRENT PUBLIC URL  (reads from tunnel.sh output)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/url', (req, res) => {
  const fs = require('fs');
  const urlFile = path.join(__dirname, 'data', 'current-url.txt');
  try {
    const url = fs.readFileSync(urlFile, 'utf8').trim();
    res.json({ url, active: true });
  } catch {
    res.json({ url: null, active: false, message: 'Tunnel URL not yet available' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const keys = getApiKeys();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    env: isProd ? 'production' : 'development',
    keys_configured: {
      openai:    !!keys.openai_key,
      oanda:     !!keys.oanda_key,
      twelve:    !!keys.twelve_key,
      telegram:  !!keys.tg_token,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVE REACT APP  (production only — dev uses Vite HMR)
// ─────────────────────────────────────────────────────────────────────────────
if (isProd) {
  const clientDist = path.join(__dirname, 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ┌──────────────────────────────────────────────┐
  │       PRECISION TRADER PRO — SERVER          │
  │  Running on  http://localhost:${PORT}           │
  │  Mode: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT     '}                    │
  └──────────────────────────────────────────────┘
  `);
});
