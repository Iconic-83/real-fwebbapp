require('dotenv').config();
// Force IPv4 DNS — Telegram & some APIs fail on IPv6 in this environment
const dns   = require('dns');
const https = require('https');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
const OpenAI    = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');

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
    claude_key:    process.env.ANTHROPIC_API_KEY  || stored.claude_key   || '',
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

// OANDA instrument → display label
const PAIR_LABELS = {
  EUR_USD:'EURUSD', GBP_USD:'GBPUSD', USD_JPY:'USDJPY',
  XAU_USD:'XAUUSD', AUD_USD:'AUDUSD', USD_CAD:'USDCAD',
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

// ADX — Average Directional Index (trend strength)
function calcADX(candles, period = 14) {
  if (candles.length < period + 2) return 0;
  const slice = candles.slice(-(period + 2));
  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = 1; i < slice.length; i++) {
    const h  = parseFloat(slice[i].mid.h),   l  = parseFloat(slice[i].mid.l);
    const ph = parseFloat(slice[i-1].mid.h), pl = parseFloat(slice[i-1].mid.l), pc = parseFloat(slice[i-1].mid.c);
    const upMove = h - ph, downMove = pl - l;
    plusDM  += (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
    trSum   += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  if (!trSum) return 0;
  const diPlus  = (plusDM  / trSum) * 100;
  const diMinus = (minusDM / trSum) * 100;
  const diSum   = diPlus + diMinus;
  if (!diSum) return 0;
  return parseFloat((Math.abs(diPlus - diMinus) / diSum * 100).toFixed(1));
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

  return {
    ema9, ema21, ema50, ema200, rsi14, atr14, macd, adx, stoch,
    resistance, support, strongResist, strongSupport,
    trend, emaAlignment, refTrend, last5, pattern, momentum,
    // Derived
    h4Trend: refTrend + ' (ref EMA21)',
    emaAlignmentFull: emaAlignment === 'BULLISH' ? 'BULLISH ALIGNMENT (EMA9>EMA21>EMA50)' :
                      emaAlignment === 'BEARISH' ? 'BEARISH ALIGNMENT (EMA9<EMA21<EMA50)' : 'MIXED',
  };
}

// ═══════════════════════════════════════════════════════════════════
// 12-CHECK PRECISION SCORING ENGINE — top-down: H4 → H2 → M30 → M5
// Each check = 1 point. Signal only fires if score >= minScore
// ═══════════════════════════════════════════════════════════════════
function scoreSignal({ direction, price, h4, h2, m30, m5, newsEvents = [] }) {
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

  // ── CHECK 11: NO high-impact news in next 45 minutes ─────────────
  const nowUTC  = new Date();
  const hasNews = newsEvents.some(e => {
    if (e.impact !== 'HIGH') return false;
    const [hh, mm] = (e.time || '99:99').split(':').map(Number);
    const eventMin = hh * 60 + mm;
    const nowMin   = nowUTC.getUTCHours() * 60 + nowUTC.getUTCMinutes();
    return Math.abs(eventMin - nowMin) <= 45;
  });
  pass('No News Blackout', !hasNews, 2);

  // ── CHECK 12: M5 candle pattern confirms direction (entry trigger) ─
  const bullishPatterns = ['BULLISH_PIN_BAR','BULLISH_ENGULFING','BULLISH_CANDLE'];
  const bearishPatterns = ['BEARISH_PIN_BAR','BEARISH_ENGULFING','BEARISH_CANDLE'];
  pass('M5 Entry Pattern',
    isBuy ? bullishPatterns.includes(m5.pattern) :
             bearishPatterns.includes(m5.pattern), 1);

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
function calcTradeSetup({ direction, price, h4, h2, m30, m5, scored, session }) {
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

  // Cap: never claim 100% (markets always have uncertainty)
  conf = Math.min(95, Math.max(10, Math.round(conf)));

  // ── STOP LOSS — at nearest H4 strong S/R ──────────────────────────
  let stopLoss;
  if (isBuy) {
    // Below strong H4 support, +0.2 ATR buffer
    const candidate = h4.strongSupport - (atr * 0.2);
    const dist = price - candidate;
    if (dist >= atr * 0.6 && dist <= atr * 3.0) {
      stopLoss = candidate;
    } else {
      stopLoss = price - (atr * 1.6); // fallback: 1.6× ATR
    }
  } else {
    // Above strong H4 resistance, +0.2 ATR buffer
    const candidate = h4.strongResist + (atr * 0.2);
    const dist = candidate - price;
    if (dist >= atr * 0.6 && dist <= atr * 3.0) {
      stopLoss = candidate;
    } else {
      stopLoss = price + (atr * 1.6);
    }
  }

  // ── TAKE PROFIT — at H4 S/R or minimum 1:2.5 R:R ─────────────────
  const slDist = Math.abs(price - stopLoss);
  let takeProfit;
  if (isBuy) {
    const tpSR  = h4.resistance > price + slDist ? h4.resistance : null;
    const tpRR  = price + slDist * 2.5;
    // Use H4 resistance if it gives at least 1:2 R:R, else use 2.5× SL
    takeProfit = (tpSR && tpSR - price >= slDist * 2) ? tpSR : tpRR;
  } else {
    const tpSR  = h4.support < price - slDist ? h4.support : null;
    const tpRR  = price - slDist * 2.5;
    takeProfit = (tpSR && price - tpSR >= slDist * 2) ? tpSR : tpRR;
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
Stop Loss: ${stopLoss.toFixed(dp)} (${isBuy ? 'below' : 'above'} H4 ${isBuy ? 'Support' : 'Resistance'} + ATR buffer)
Take Profit: ${takeProfit.toFixed(dp)} (H4 ${isBuy ? 'Resistance' : 'Support'} level)
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
  if (h >= 12 && h < 17) return 'LONDON+NY';
  return 'OFF_HOURS';
}

// ── Trailing stop monitor — protects open profits ────────────────────────────
async function runTrailingStops() {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return;
  try {
    const r = await oandaRequest(`/v3/accounts/${keys.oanda_account}/openTrades`);
    const trades = r?.trades || [];
    for (const trade of trades) {
      const pl   = parseFloat(trade.unrealizedPL || 0);
      const units= parseFloat(trade.currentUnits || 0);
      const entry= parseFloat(trade.price || 0);
      const instr= trade.instrument;
      const isBuy= units > 0;
      const pipSize = PIP[instr] || 0.0001;
      const dp    = instr==='XAU_USD' ? 2 : 5;

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
    }
  } catch(e) { /* silent */ }
}
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
  const { message } = req.body;
  const r = await sendTelegramMsg(message);
  if (!r.ok) return res.status(r.error==='Telegram not configured'?400:500).json({ error:r.error });
  res.json({ ok:true });
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

// signals table — every signal (pending, approved, rejected, executed, failed)
db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    actioned_at   DATETIME,
    pair          TEXT NOT NULL,
    direction     TEXT NOT NULL,
    confidence    INTEGER NOT NULL,
    entry_price   REAL,
    stop_loss     REAL,
    take_profit   REAL,
    sl_pips       REAL,
    tp_pips       REAL,
    units         INTEGER,
    risk_pct      REAL,
    risk_amount   REAL,
    lots          TEXT,
    status        TEXT DEFAULT 'PENDING',
    oanda_order_id TEXT,
    filled_price  REAL,
    realized_pl   REAL,
    analysis      TEXT,
    ema_align     TEXT,
    rsi           REAL,
    h4_trend      TEXT,
    tg_message_id INTEGER
  );
`);

// Keep old table for compat (ignore if already exists)
db.exec(`CREATE TABLE IF NOT EXISTS auto_trades (id INTEGER PRIMARY KEY, timestamp DATETIME, pair TEXT, direction TEXT, confidence INTEGER, units INTEGER, entry_price REAL, stop_loss REAL, take_profit REAL, oanda_order_id TEXT, status TEXT, pl REAL, notes TEXT);`);

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

// ── Execute an approved signal on OANDA ──────────────────────────────────────
async function executeSignal(signal) {
  const keys = getApiKeys();
  const oandaInstr = LABEL_TO_OANDA[signal.pair] || signal.pair.replace('/','_');
  const dp = oandaInstr==='XAU_USD' ? 2 : 5;
  try {
    const tradeUnits = signal.direction==='BUY' ? signal.units : -signal.units;
    const orderResult = await oandaRequest(`/v3/accounts/${keys.oanda_account}/orders`, 'POST', {
      order: {
        type:'MARKET', instrument:oandaInstr, units:String(tradeUnits),
        stopLossOnFill:  { price: signal.stop_loss.toFixed(dp) },
        takeProfitOnFill:{ price: signal.take_profit.toFixed(dp) },
      }
    });
    const filled    = orderResult?.orderFillTransaction;
    const orderId   = filled?.id || 'unknown';
    const filledPx  = parseFloat(filled?.price || signal.entry_price);

    db.prepare(`UPDATE signals SET status='EXECUTED', oanda_order_id=?, filled_price=?, actioned_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(orderId, filledPx, signal.id);
    recordTradePL(0);

    const msg =
`✅ TRADE EXECUTED — Signal #${signal.id}

Pair:       ${signal.pair}
Direction:  ${signal.direction} ${signal.direction==='BUY'?'▲':'▼'}
Confidence: ${signal.confidence}%
Entry:      ${filledPx.toFixed(dp)}
Stop Loss:  ${signal.stop_loss.toFixed(dp)} (${signal.sl_pips} pips)
Take Profit:${signal.take_profit.toFixed(dp)} (${signal.tp_pips} pips)
Size:       ${signal.lots} lots (${signal.units?.toLocaleString()} units)
Risk:       ${signal.risk_pct}% = $${signal.risk_amount?.toFixed(0)}
OANDA ID:   ${orderId}`;
    if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id, msg);
    console.log(`[SIGNAL] ✅ Executed #${signal.id} ${signal.pair} ${signal.direction}`);
  } catch(e) {
    db.prepare(`UPDATE signals SET status='FAILED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(signal.id);
    if (signal.tg_message_id) await tgEditMsg(signal.tg_message_id,
      `❌ EXECUTION FAILED — Signal #${signal.id}\n${signal.pair} ${signal.direction}\nError: ${e.message}`);
    console.error(`[SIGNAL] Execute failed #${signal.id}:`, e.message);
  }
}

// ── Telegram callback poller — listens for button taps ───────────────────────
let tgOffset = 0;
async function pollTgCallbacks() {
  const keys = getApiKeys();
  if (!keys.tg_token || !keys.tg_chat) return;
  return new Promise((resolve) => {
    const qs = `offset=${tgOffset}&timeout=0&allowed_updates=%5B%22callback_query%22%5D`;
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
              await executeSignal(sig);
            } else if (action === 'reject') {
              await tgAnswerCbq(cbq.id, '❌ Signal rejected');
              db.prepare(`UPDATE signals SET status='REJECTED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(sig.id);
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
  const settings = getStorageValue('autotrade_settings');
  if (!settings?.enabled) return;

  const minScore  = parseInt(settings.min_score  || 9);   // out of 12 checks
  const riskPct   = parseFloat(settings.risk_pct || 1);
  const maxPerDay = parseInt(settings.max_per_day || 3);

  const todaySent = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE date(created_at)=date('now') AND status IN ('PENDING','EXECUTED','APPROVED')`).get();
  if (todaySent.c >= maxPerDay) return;

  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return; // only OANDA needed now

  autoScanning = true;
  const session = getSession();
  console.log(`[SCAN] Starting precision scan — session: ${session}`);

  // Pre-fetch news for blackout check
  const currentNews = newsCache || [];

  const scanPairs = ['EUR_USD','GBP_USD','USD_JPY','XAU_USD','AUD_USD','USD_CAD'];

  for (const instr of scanPairs) {
    try {
      const fresh = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE date(created_at)=date('now') AND status IN ('PENDING','EXECUTED','APPROVED')`).get();
      if (fresh.c >= maxPerDay) break;

      const existPending = db.prepare(`SELECT id FROM signals WHERE pair=? AND status='PENDING'`).get(instr.replace('_','/'));
      if (existPending) continue;

      const label = instr.replace('_', '/');
      const price = parseFloat(priceCache[label] || 0);
      if (!price) continue;

      // ── Fetch all 4 timeframes in parallel: H4 → H2 → M30 → M5 ───
      const [h4r, h2r, m30r, m5r] = await Promise.allSettled([
        oandaRequest(`/v3/instruments/${instr}/candles?count=100&granularity=H4&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=100&granularity=H2&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=100&granularity=M30&price=M`),
        oandaRequest(`/v3/instruments/${instr}/candles?count=50&granularity=M5&price=M`),
      ]);
      const h4c  = h4r.status==='fulfilled'  ? h4r.value?.candles||[]  : [];
      const h2c  = h2r.status==='fulfilled'  ? h2r.value?.candles||[]  : [];
      const m30c = m30r.status==='fulfilled' ? m30r.value?.candles||[] : [];
      const m5c  = m5r.status==='fulfilled'  ? m5r.value?.candles||[]  : [];
      if (h4c.length < 26) continue;

      // ── Build indicators for each timeframe (top-down) ───────────────
      const indH4  = buildIndicators(h4c, []);
      const indH2  = buildIndicators(h2c.length>5 ? h2c : h4c, h4c);
      const indM30 = buildIndicators(m30c.length>5 ? m30c : h2c, h2c);
      const indM5  = buildIndicators(m5c.length>5 ? m5c : m30c.slice(-15), m30c);

      // Cache ATR (use M30 ATR for trailing stops — entry timeframe)
      h1AtrCache[instr] = indM30.atr14;

      // ── Determine direction from H4 EMA alignment (master TF) ────────
      const aiDirection = indH4.emaAlignment === 'BULLISH' ? 'BUY'
                        : indH4.emaAlignment === 'BEARISH' ? 'SELL'
                        : null;
      if (!aiDirection) {
        console.log(`[SCAN] ${label}: H4 EMA mixed — skipped`);
        continue;
      }

      // ── Run 12-check scoring engine ───────────────────────────────────
      const scored = scoreSignal({
        direction: aiDirection, price,
        h4: indH4, h2: indH2, m30: indM30, m5: indM5,
        newsEvents: currentNews,
      });
      console.log(`[SCAN] ${label}: ${aiDirection} score ${scored.score}/${scored.maxScore} (${scored.pct}%) — need ${minScore}`);

      // Reject if score too low
      if (scored.score < minScore) {
        const failed = scored.checks.filter(c=>!c.pass).map(c=>c.name).join(', ');
        console.log(`[SCAN] ${label}: REJECTED — failed: ${failed}`);
        continue;
      }

      // ── Pure calculation engine — no API, instant, deterministic ────
      const dp = instr==='XAU_USD' ? 2 : 5;
      const setup = calcTradeSetup({
        direction: aiDirection, price,
        h4: indH4, h2: indH2, m30: indM30, m5: indM5,
        scored, session,
      });
      const analysis = setup.analysis;
      const parsed   = {
        direction:  setup.direction,
        confidence: setup.confidence,
        stopLoss:   setup.stopLoss,
        takeProfit: setup.takeProfit,
      };
      console.log(`[SCAN] ${label}: Calc Engine → ${parsed.direction} ${parsed.confidence}%`);

      // Only signal if confidence meets threshold
      const aiThreshold = parseInt(settings.threshold || 80);
      if (parsed.confidence < aiThreshold) {
        console.log(`[SCAN] ${label}: Confidence ${parsed.confidence}% < threshold ${aiThreshold}% — skipped`);
        continue;
      }
      if (!parsed.stopLoss || !parsed.takeProfit) continue;

      // Validate R:R >= 1.5
      const pipSize = PIP[instr] || 0.0001;
      const slPips  = Math.abs(price - parsed.stopLoss)  / pipSize;
      const tpPips  = Math.abs(price - parsed.takeProfit) / pipSize;
      if (slPips < 2) continue;
      const rr = tpPips / slPips;
      if (rr < 1.5) {
        console.log(`[SCAN] ${label}: R:R ${rr.toFixed(1)} too low — skipped`);
        continue;
      }

      // ── Position sizing from real balance ─────────────────────────────
      const acctData = await oandaRequest(`/v3/accounts/${keys.oanda_account}/summary`);
      const balance  = parseFloat(acctData?.account?.balance || 0);
      const riskAmt  = balance * (riskPct / 100);
      let pipVal     = pipSize;
      if (instr==='USD_JPY') pipVal = 0.01 / price;
      if (instr==='USD_CAD') pipVal = 0.0001 / price;
      if (instr==='XAU_USD') pipVal = 0.1;
      const units = Math.floor(riskAmt / (slPips * pipVal));
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
        `${analysis}\n\nSCORE: ${scored.score}/${scored.maxScore} | SESSION: ${session} | ADX(H4): ${indH4.adx} | M5 Pattern: ${indM5.pattern}`,
        indH4.emaAlignment, indM30.rsi14, indH2.trend
      ).lastInsertRowid;

      // ── Build Telegram message with full 4-TF breakdown ──────────────
      const passedStr = scored.checks.filter(c=>c.pass).map(c=>`✅ ${c.name}`).join('\n');
      const failedStr = scored.checks.filter(c=>!c.pass).map(c=>`❌ ${c.name}`).join('\n');
      const dirArrow  = parsed.direction==='BUY' ? '▲' : '▼';

      const tgText =
`🎯 HIGH-PRECISION SIGNAL #${signalId}
Score: ${scored.score}/${scored.maxScore} checks passed

Pair:        ${label}
Direction:   ${parsed.direction} ${dirArrow}
AI Confidence: ${parsed.confidence}%
Entry:       ${price.toFixed(dp)}
Stop Loss:   ${parsed.stopLoss.toFixed(dp)} (-${slPips.toFixed(1)} pips)
Take Profit: ${parsed.takeProfit.toFixed(dp)} (+${tpPips.toFixed(1)} pips)
R:R Ratio:   1:${rr.toFixed(1)}
Risk:        ${riskPct}% = $${riskAmt.toFixed(0)}
Size:        ${lots} lots
Session:     ${session}

Checks:
${passedStr}
${failedStr ? failedStr : ''}

H4 (Master):  ${indH4.emaAlignment} | RSI ${indH4.rsi14} | ADX ${indH4.adx}
H2 (Confirm): ${indH2.trend} | RSI ${indH2.rsi14}
M30 (Entry):  ${indM30.trend} | RSI ${indM30.rsi14} | MACD ${indM30.macd}
M5 (Trigger): ${indM5.trend} | Pattern: ${indM5.pattern}`;

      const r = await tgSendButtons(tgText, [[
        { text:'✅ APPROVE', callback_data:`approve_${signalId}` },
        { text:'❌ REJECT',  callback_data:`reject_${signalId}`  },
      ]]);
      if (r?.result?.message_id) {
        db.prepare(`UPDATE signals SET tg_message_id=? WHERE id=?`).run(r.result.message_id, signalId);
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

// ── Signal API endpoints ──────────────────────────────────────────────────────
app.get('/api/autotrade/settings', (req, res) => {
  const s = getStorageValue('autotrade_settings') || { enabled:false, threshold:85, risk_pct:1, max_per_day:3, min_score:9 };
  res.json(s);
});

app.post('/api/autotrade/settings', (req, res) => {
  const { enabled, threshold, risk_pct, max_per_day, min_score } = req.body;
  const s = {
    enabled:   !!enabled,
    threshold: parseInt(threshold  || 85),
    risk_pct:  parseFloat(risk_pct || 1),
    max_per_day: parseInt(max_per_day || 3),
    min_score: parseInt(min_score || 9),
  };
  setStorageValue('autotrade_settings', s);
  const onOff = s.enabled ? 'ON' : 'OFF';
  sendTelegramMsg(
    `Signal Scanner: ${onOff}\nScore filter: ${s.min_score}/12 checks required\nAI threshold: ${s.threshold}%\nRisk/trade: ${s.risk_pct}%\nMax/day: ${s.max_per_day}\n\nOnly the highest-confidence setups will be signalled.`
  );
  res.json({ ok:true, settings:s });
});

app.post('/api/autotrade/scan', (req, res) => {
  runAutoScan().catch(console.error);
  res.json({ ok:true, msg:'Scan started — check Telegram for signals' });
});

app.get('/api/autotrade/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/autotrade/status', (req, res) => {
  const s = getStorageValue('autotrade_settings') || { enabled:false };
  const pending = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE status='PENDING'`).get();
  const today   = db.prepare(`SELECT COUNT(*) as c FROM signals WHERE date(created_at)=date('now')`).get();
  const total   = db.prepare(`SELECT COUNT(*) as c FROM signals`).get();
  res.json({ enabled:s.enabled, threshold:s.threshold||80, risk_pct:s.risk_pct||1, max_per_day:s.max_per_day||3,
    pending_signals:pending.c, today_signals:today.c, total_signals:total.c, scanning:autoScanning });
});

// Approve/reject from web UI (fallback if Telegram not available)
app.post('/api/autotrade/approve/:id', async (req, res) => {
  const sig = db.prepare('SELECT * FROM signals WHERE id=?').get(parseInt(req.params.id));
  if (!sig) return res.status(404).json({ error:'Signal not found' });
  if (sig.status !== 'PENDING') return res.status(400).json({ error:'Signal already processed: '+sig.status });
  await executeSignal(sig);
  res.json({ ok:true, signal_id:sig.id });
});

app.post('/api/autotrade/reject/:id', (req, res) => {
  const sig = db.prepare('SELECT * FROM signals WHERE id=?').get(parseInt(req.params.id));
  if (!sig) return res.status(404).json({ error:'Signal not found' });
  if (sig.status !== 'PENDING') return res.status(400).json({ error:'Already processed: '+sig.status });
  db.prepare(`UPDATE signals SET status='REJECTED', actioned_at=CURRENT_TIMESTAMP WHERE id=?`).run(sig.id);
  if (sig.tg_message_id) tgEditMsg(sig.tg_message_id, `❌ REJECTED via web — Signal #${sig.id}\n${sig.pair} ${sig.direction} ${sig.confidence}%`);
  res.json({ ok:true });
});

// ═════════════════════════════════════════════════════════════════════════════
// TRADE HISTORY — Closed trades from OANDA + auto-trade log
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/history', async (req, res) => {
  const keys = getApiKeys();
  if (!keys.oanda_key || !keys.oanda_account) return res.status(400).json({ error:'OANDA not configured' });
  try {
    const count = parseInt(req.query.count || 50);
    const r = await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades?state=CLOSED&count=${count}`);
    const trades = (r?.trades || []).map(t => ({
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

    res.json({ trades, stats: { total:trades.length, won:won.length, lost:lost.length, be:be.length,
      total_pl:totalPL.toFixed(2), win_rate:winRate, avg_win:avgWin.toFixed(2),
      avg_loss:avgLoss.toFixed(2), rr } });
  } catch(e) {
    res.status(500).json({ error:e.message });
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
      oanda:    !!keys.oanda_key,
      twelve:   !!keys.twelve_key,
      telegram: !!keys.tg_token,
    },
    ai_engine: 'Rule-Based Calc Engine (no API needed)',
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
