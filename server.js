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
// PRICES API  (Twelve Data proxy)
// ─────────────────────────────────────────────────────────────────────────────
const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','XAU/USD','AUD/USD','USD/CAD'];

app.get('/api/prices', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.twelve_key) return res.status(400).json({ error: 'Twelve Data key not configured' });
  try {
    const syms = PAIRS.join(',');
    const r = await axios.get(
      `https://api.twelvedata.com/price?symbol=${syms}&apikey=${keys.twelve_key}`,
      { timeout: 10000 }
    );
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'Twelve Data fetch failed: ' + e.message });
  }
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
