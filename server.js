require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
const OpenAI  = require('openai');
const db      = require('./db');

const app    = express();
const PORT   = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
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
    openai_key:    process.env.OPENAI_API_KEY    || stored.openai_key    || '',
    oanda_key:     process.env.OANDA_API_KEY      || stored.oanda_key     || '',
    oanda_account: process.env.OANDA_ACCOUNT_ID   || stored.oanda_account || '',
    twelve_key:    process.env.TWELVE_DATA_KEY    || stored.twelve_key    || '',
    tg_token:      process.env.TELEGRAM_TOKEN     || stored.tg_token      || '',
    tg_chat:       process.env.TELEGRAM_CHAT_ID   || stored.tg_chat       || '',
  };
}

// OANDA instrument map (label → OANDA format)
const LABEL_TO_OANDA = {
  'EURUSD':'EUR_USD','GBPUSD':'GBP_USD','USDJPY':'USD_JPY',
  'XAUUSD':'XAU_USD','AUDUSD':'AUD_USD','USDCAD':'USD_CAD',
  'EUR/USD':'EUR_USD','GBP/USD':'GBP_USD','USD/JPY':'USD_JPY',
  'XAU/USD':'XAU_USD','AUD/USD':'AUD_USD','USD/CAD':'USD_CAD',
};

// Pip sizes
const PIP = {
  EUR_USD:0.0001, GBP_USD:0.0001, USD_JPY:0.01,
  XAU_USD:0.1,   AUD_USD:0.0001, USD_CAD:0.0001,
};

async function oandaRequest(path, method = 'GET', data = null) {
  const keys = getApiKeys();
  if (!keys.oanda_key) throw new Error('OANDA key not configured');
  const bases = ['https://api-fxpractice.oanda.com', 'https://api-fxtrade.oanda.com'];
  for (const base of bases) {
    try {
      const r = await axios({
        method, url: base + path,
        data: data || undefined,
        headers: { Authorization: `Bearer ${keys.oanda_key}`, 'Content-Type': 'application/json' },
        timeout: 12000,
      });
      return r.data;
    } catch (e) {
      if (e.response) return e.response.data; // auth/logic error — return it
      // network error — try next base
    }
  }
  throw new Error('OANDA unreachable');
}

// ═════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS  (calculated server-side from real candle data)
// ═════════════════════════════════════════════════════════════════════════════
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  let gains = 0, losses = 0;
  const start = Math.max(1, closes.length - period);
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));
}

function calcATR(candles, period = 14) {
  let sum = 0;
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const h = parseFloat(candles[i].mid.h);
    const l = parseFloat(candles[i].mid.l);
    const pc = parseFloat(candles[i - 1].mid.c);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  return parseFloat((ema12 - ema26).toFixed(5));
}

function buildIndicators(h1Candles, h4Candles) {
  const closes = h1Candles.map(c => parseFloat(c.mid.c));
  const highs   = h1Candles.map(c => parseFloat(c.mid.h));
  const lows    = h1Candles.map(c => parseFloat(c.mid.l));

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes.slice(-50), 50);
  const rsi14 = calcRSI(closes, 14);
  const atr14 = calcATR(h1Candles, 14);
  const macd  = calcMACD(closes);

  // Swing highs/lows (last 20 candles)
  const recentHighs = highs.slice(-20);
  const recentLows  = lows.slice(-20);
  const resistance  = Math.max(...recentHighs);
  const support     = Math.min(...recentLows);

  // Last 5 candle summary
  const last5 = h1Candles.slice(-5).map(c => ({
    open:  parseFloat(c.mid.o).toFixed(5),
    high:  parseFloat(c.mid.h).toFixed(5),
    low:   parseFloat(c.mid.l).toFixed(5),
    close: parseFloat(c.mid.c).toFixed(5),
    bull:  parseFloat(c.mid.c) >= parseFloat(c.mid.o),
  }));

  // H4 trend
  let h4Trend = 'N/A';
  if (h4Candles?.length > 0) {
    const h4Closes = h4Candles.map(c => parseFloat(c.mid.c));
    const h4ema21 = calcEMA(h4Closes, 21);
    h4Trend = h4Closes[h4Closes.length - 1] > h4ema21 ? 'BULLISH (above H4 EMA21)' : 'BEARISH (below H4 EMA21)';
  }

  // Trend strength
  const currentClose = closes[closes.length - 1];
  const trend = currentClose > ema21 ? 'ABOVE EMA21 (bullish bias)' : 'BELOW EMA21 (bearish bias)';
  const emaAlignment = (ema9 > ema21 && ema21 > ema50) ? 'BULLISH ALIGNMENT (EMA9>EMA21>EMA50)' :
                       (ema9 < ema21 && ema21 < ema50) ? 'BEARISH ALIGNMENT (EMA9<EMA21<EMA50)' : 'MIXED (no clear alignment)';

  return { ema9, ema21, ema50, rsi14, atr14, macd, resistance, support, trend, emaAlignment, h4Trend, last5 };
}

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
  db.prepare(`
    INSERT INTO storage (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(req.params.key, value);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRICES — Primary: OANDA (free, unlimited) | Fallback: Twelve Data
// Server-side cache → frontend gets instant response, no rate limits ever
// ═════════════════════════════════════════════════════════════════════════════
const PAIRS       = ['EUR/USD','GBP/USD','USD/JPY','XAU/USD','AUD/USD','USD/CAD'];
const OANDA_INSTR = 'EUR_USD,GBP_USD,USD_JPY,XAU_USD,AUD_USD,USD_CAD';

let priceCache = {}, priceCacheTime = 0, priceSource = 'none';

async function pollPrices() {
  const keys = getApiKeys();
  if (keys.oanda_key && keys.oanda_account) {
    const bases = ['https://api-fxpractice.oanda.com','https://api-fxtrade.oanda.com'];
    for (const base of bases) {
      try {
        const r = await axios.get(
          `${base}/v3/accounts/${keys.oanda_account}/pricing?instruments=${OANDA_INSTR}`,
          { headers:{ Authorization:`Bearer ${keys.oanda_key}` }, timeout:8000 }
        );
        if (r.data?.prices?.length > 0) {
          const m = {};
          r.data.prices.forEach(p => {
            const sym = p.instrument.replace('_','/');
            const bid = parseFloat(p.bids?.[0]?.price||0);
            const ask = parseFloat(p.asks?.[0]?.price||0);
            if (bid && ask) m[sym] = ((bid+ask)/2).toFixed(p.instrument==='XAU_USD'?2:5);
          });
          if (Object.keys(m).length > 0) { priceCache=m; priceCacheTime=Date.now(); priceSource='OANDA'; return; }
        }
      } catch {}
    }
  }
  // Fallback: Twelve Data (only if OANDA unavailable)
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

pollPrices();
setInterval(pollPrices, 5000);

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
  const bases = ['https://api-fxpractice.oanda.com','https://api-fxtrade.oanda.com'];
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
        const dp = oandaInstr === 'XAU_USD' ? 2 : 5;
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

// Ensure daily_pnl table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_pnl (
    date TEXT PRIMARY KEY,
    realized_pl REAL NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function getTodayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDailyPL() {
  const today = getTodayDate();
  const row = db.prepare('SELECT * FROM daily_pnl WHERE date = ?').get(today);
  return row || { date: today, realized_pl: 0, trade_count: 0 };
}

function recordTradePL(pl) {
  const today = getTodayDate();
  db.prepare(`
    INSERT INTO daily_pnl (date, realized_pl, trade_count, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(date) DO UPDATE SET
      realized_pl = realized_pl + ?,
      trade_count = trade_count + 1,
      updated_at  = CURRENT_TIMESTAMP
  `).run(today, pl, pl);
}

app.get('/api/trade/daily', async (req, res) => {
  const keys = getApiKeys();
  const daily = getDailyPL();

  // Also get real account data for context
  let balance = 0, maxDailyLoss = 0;
  if (keys.oanda_key && keys.oanda_account) {
    try {
      const d = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
      balance = parseFloat(d?.account?.balance || 0);
    } catch {}
  }

  // Daily loss limit = 3% of balance (professional standard)
  maxDailyLoss = balance * 0.03;
  const currentLoss = Math.min(0, daily.realized_pl); // only negative values
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
  const force = req.query.refresh === 'true';
  if (force) { const data = await fetchRealNews(); return res.json(data); }
  // Return cache (already fresh from background polling)
  res.json(newsCache.length > 0 ? newsCache : await fetchRealNews());
});

// ═════════════════════════════════════════════════════════════════════════════
// TELEGRAM SIGNAL BROADCAST
// Sends formatted signal to Telegram when AI finds high-confidence trade
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/telegram/send', async (req, res) => {
  const { message } = req.body;
  const keys = getApiKeys();
  if (!keys.tg_token || !keys.tg_chat) return res.status(400).json({ error:'Telegram not configured' });
  try {
    await axios.post(`https://api.telegram.org/bot${keys.tg_token}/sendMessage`, {
      chat_id: keys.tg_chat, text: message, parse_mode: 'HTML',
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC URL + HEALTH
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/url', (req, res) => {
  const urlFile = path.join(__dirname, 'data', 'current-url.txt');
  try { res.json({ url: fs.readFileSync(urlFile,'utf8').trim(), active:true }); }
  catch { res.json({ url:null, active:false }); }
});

app.get('/api/health', (req, res) => {
  const keys = getApiKeys();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    env:    isProd ? 'production' : 'development',
    price_source: priceSource,
    news_events:  newsCache.length,
    keys_configured: {
      openai:   !!keys.openai_key,
      oanda:    !!keys.oanda_key,
      twelve:   !!keys.twelve_key,
      telegram: !!keys.tg_token,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SERVE REACT APP (production)
// ═════════════════════════════════════════════════════════════════════════════
if (isProd) {
  const clientDist = path.join(__dirname, 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
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
