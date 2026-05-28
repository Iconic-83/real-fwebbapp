# PrecisionTraderPro — Micro Quality Control Audit
**Date:** 2026-05-28
**Stage:** Pre-institutional micro-layer analysis
**Purpose:** Honest gap analysis of execution, behavioral, and infrastructure quality controls

---

## STATUS LEGEND
- ✅ BUILT — fully implemented
- 🟡 PARTIAL — exists but incomplete
- ❌ MISSING — not implemented
- 🔴 BUILD NOW — high value, low effort
- 🟠 BUILD PHASE 2 — needs closed trade data first
- 🟡 BUILD PHASE 3 — advanced, after statistical validation

---

## SECTION 1 — MARKET MICROSTRUCTURE CHECKS

### 1. Candle Quality Check
**Not all candles are trustworthy.**

| Feature | Status |
|---|---|
| Basic candle pattern detection (pin bar, engulf, doji) | ✅ BUILT — `detectPattern()` |
| Wick/body ratio calculation | ❌ MISSING |
| Abnormal candle size (manipulation spike) detection | ❌ MISSING |
| Exhaustion candle sequence (3 giant candles = reversal risk) | ❌ MISSING |
| Rejection wick detection (institutional rejection signal) | ❌ MISSING |

**Current gap:** `detectPattern()` classifies shape but never asks "is this candle abnormally large?" or "are 3 consecutive candles all > 2× average body size?" Those patterns often signal exhaustion — exactly when trend-following fails.

**What to build:**
```
avgBody = mean(abs(close-open)) over last 20 candles
currentBody = abs(close-open)
if currentBody > avgBody * 2.5 → EXHAUSTION_RISK → reject
if upperWick > body * 3 on BUY → REJECTION_SPIKE → reject
```
**Priority:** 🔴 BUILD NOW | Effort: 1–2 hours

---

### 2. Momentum Quality Check
**Checking RSI + MACD is not enough. Divergence is missing.**

| Feature | Status |
|---|---|
| RSI level check | ✅ BUILT |
| MACD direction check | ✅ BUILT |
| RSI divergence (price higher, RSI lower = bearish div) | ❌ MISSING |
| MACD histogram weakening | ❌ MISSING |
| Momentum deterioration detection | ❌ MISSING |

**Current gap:** The system checks RSI zone and MACD direction but never asks "is momentum agreeing with price?" A BUY signal during bearish RSI divergence is one of the most common reasons trend setups fail.

**What to build:**
```
// RSI divergence (last 3 swing highs on M30)
if price making new high AND rsi making lower high → BEARISH_DIVERGENCE → reject BUY
if price making new low  AND rsi making higher low → BULLISH_DIVERGENCE → reject SELL

// MACD histogram trend
histogramSlope = current_histogram - histogram_3_bars_ago
if isBUY  && histogramSlope < 0 → momentum weakening → -5 confidence
if isSELL && histogramSlope > 0 → momentum weakening → -5 confidence
```
**Priority:** 🔴 BUILD NOW | Effort: 2–3 hours

---

### 3. Trend Slope Strength
**ADX measures trend strength but not direction quality.**

| Feature | Status |
|---|---|
| ADX ≥ 20 for trending market | ✅ BUILT |
| EMA slope angle calculation | ❌ MISSING |
| Flat EMA detection (fake trend) | ❌ MISSING |
| EMA acceleration/deceleration | ❌ MISSING |

**Current gap:** A market can have ADX = 22 with a completely flat EMA — technically "trending" but going nowhere. Steep EMA angles indicate real momentum; flat EMAs indicate chop with a slight tilt.

**What to build:**
```
emaSlope = (ema21_now - ema21_5_bars_ago) / price * 10000  // pips per bar
if abs(emaSlope) < 2 → FLAT_EMA → -8 confidence (choppy, not trending)
if abs(emaSlope) > 8 → STEEP_EMA → +5 confidence (real momentum)
```
**Priority:** 🔴 BUILD NOW | Effort: 1 hour

---

### 4. Compression Before Breakout
**High-quality moves come from compression. Random entries do not.**

| Feature | Status |
|---|---|
| ATR expansion detection (volatility too high) | ✅ BUILT — just added |
| ATR compression detection (tight consolidation = setup loading) | ❌ MISSING |
| Bollinger Band squeeze equivalent | ❌ MISSING |
| Range contraction detection | ❌ MISSING |

**Current gap:** The system rejects high-volatility entries but does not reward compression setups — the highest quality entries. Compression followed by expansion with trend alignment is the single most reliable price action pattern in institutional trading.

**What to build:**
```
// Compression = recent ATR shrinking vs historical
recentATR  = calcATR(candles.slice(-7), 7)
historicATR = calcATR(candles.slice(-28, -7), 14)
compressionRatio = recentATR / historicATR
if compressionRatio < 0.6 → COMPRESSED → +10 confidence (loading setup)
if compressionRatio < 0.4 → TIGHT_COMPRESSION → +15 confidence (high quality)
```
**Priority:** 🟠 BUILD PHASE 2 | Effort: 1 hour

---

## SECTION 2 — EXECUTION SAFETY CHECKS

### 5. Candle Close Confirmation
**This is CRITICAL and currently missing.**

| Feature | Status |
|---|---|
| Candle close confirmation before signal | ❌ MISSING |
| M5 candle incomplete check | ❌ MISSING |
| M30 candle incomplete check | ❌ MISSING |
| False signal on incomplete candle prevention | ❌ MISSING |

**Current gap:** The scanner runs every 5 minutes and reads whatever the current M5/M30 candle looks like at that moment. A candle that shows a pin bar at minute 2 may look completely different at close. This causes phantom signals that would never exist on a closed candle.

**OANDA candle API note:** OANDA returns `complete: true/false` on each candle. The last candle in any response is always `complete: false` (still forming). Currently the code processes it anyway.

**What to build:**
```javascript
// In buildIndicators() — filter to completed candles only
const completedCandles = candles.filter(c => c.complete === true);
// Always calculate indicators on completed candles
// The last (incomplete) candle is only used for live price reference
```
**Priority:** 🔴 BUILD NOW | Effort: 30 minutes | High impact

---

### 6. Entry Timing Quality
**Chasing vs. pullback entries.**

| Feature | Status |
|---|---|
| EMA21 distance check (not overextended) | ✅ BUILT |
| Price within 0.8% of H4 EMA21 | ✅ BUILT |
| Pullback confirmation | 🟡 PARTIAL |
| Entry after exhaustion detection | ❌ MISSING |
| Chasing entry (entering at candle top/bottom) | ❌ MISSING |

**Current gap:** The EMA21 distance check is a good proxy for "in value" but it doesn't detect whether price has just momentum-pushed away from value or is genuinely pulling back to it. These have very different outcomes.

---

### 7. Distance to SL vs Spread — Spread Efficiency Ratio
**A 5-pip SL with a 2-pip spread is a terrible trade.**

| Feature | Status |
|---|---|
| Spread check vs ATR | ✅ BUILT — just added |
| SL distance vs spread ratio | ❌ MISSING |
| Minimum SL/spread efficiency ratio | ❌ MISSING |

**Current gap:** A spread that is 25% of ATR might still be 40% of the actual SL distance. Professional desks require:

```
spreadEfficiency = slPips / spreadPips
Minimum acceptable: spreadEfficiency ≥ 5 (SL must be at least 5× the spread)
```

If SL = 8 pips and spread = 3 pips, you start the trade already 37% into your stop loss.

**What to build:**
```javascript
const spreadPips = (spreadCache[label] || 0) / pipSize;
if (spreadPips > 0 && slPips / spreadPips < 5) {
  console.log(`[SCAN] Spread efficiency ${(slPips/spreadPips).toFixed(1)}x too low — skipped`);
  continue;
}
```
**Priority:** 🔴 BUILD NOW | Effort: 20 minutes

---

## SECTION 3 — PORTFOLIO INTELLIGENCE

### 8. Portfolio Heat Score
**True risk exposure ≠ number of trades × 1%.**

| Feature | Status |
|---|---|
| USD directional correlation limit | ✅ BUILT |
| Total portfolio heat calculation | ❌ MISSING |
| Correlation-adjusted exposure | ❌ MISSING |
| Maximum total portfolio heat | ❌ MISSING |

**Current gap:** If EUR/USD and GBP/USD have 0.85 correlation, two 1% trades in the same direction is effectively ~1.85% real exposure — not 2%. But the opposite is also true: a USD/JPY BUY and EUR/USD SELL partially hedge each other. The system treats all as independent.

**What to build:**
```
portfolioHeat = Σ(openTrades × 1% × correlationWeight)
if portfolioHeat > 3% → reject new trade
```
**Priority:** 🟠 BUILD PHASE 2 | Effort: 2 hours

---

### 9. Sector/Asset Clustering
**Over-concentration in one currency sector.**

| Feature | Status |
|---|---|
| USD correlation groups | ✅ BUILT |
| JPY concentration check | ❌ MISSING |
| Commodity currency clustering (AUD, CAD, NZD) | ❌ MISSING |
| Gold correlation tracking | ❌ MISSING |

**Current gap:** The system could fire USD/JPY + AUD/USD + EUR/USD simultaneously — all involving JPY, commodity currencies, and USD exposure. No sector concentration limit exists beyond the USD directional check.

**Priority:** 🟠 BUILD PHASE 2 | Effort: 1 hour

---

## SECTION 4 — BEHAVIORAL & AI GOVERNANCE CHECKS

### 10. Confidence Stability Monitor
**AI confidence drift is a real and dangerous problem.**

| Feature | Status |
|---|---|
| Confidence score per signal | ✅ BUILT |
| Confidence drift detection | ❌ MISSING |
| Scoring inflation alert | ❌ MISSING |
| "Too many 90%+ signals" anomaly | ❌ MISSING |

**Current gap:** If the market regime shifts and suddenly every scan produces 90%+ confidence scores, something is wrong — either the scoring formula is miscalibrated for the new regime, or conditions are being misread. No alert exists for this.

**What to build:**
```javascript
// Check last 20 signals
const recent = db.prepare(`SELECT confidence FROM signals ORDER BY created_at DESC LIMIT 20`).all();
const avgConf = recent.reduce((s,r) => s + r.confidence, 0) / recent.length;
if (avgConf > 88 && recent.length >= 10) {
  // Confidence inflation — send alert, don't block but warn
  sendTelegramMsg(`⚠️ Confidence inflation detected: avg ${avgConf.toFixed(0)}% over last ${recent.length} signals`);
}
```
**Priority:** 🟠 BUILD PHASE 2 | Effort: 1 hour (needs signal history first)

---

### 11. Signal Frequency Drift
**Sudden spike in signal frequency = system may be misfiring.**

| Feature | Status |
|---|---|
| Max signals per day cap (3) | ✅ BUILT |
| Signal frequency anomaly detection | ❌ MISSING |
| Sudden burst alert | ❌ MISSING |

**Current gap:** The 3/day cap prevents overtrading but doesn't detect the warning sign before the cap: if the system is generating 15 signals that are all getting stopped by the score filter, that abnormal scan behavior should be logged and investigated.

**What to build:**
```javascript
// Count rejected signals today (too low score) vs normal baseline
const rejectedToday = db.prepare(`SELECT COUNT(*) as c FROM scan_log WHERE date(created_at)=date('now') AND result='REJECTED'`).get();
// If rejection rate drops dramatically (scanner passing everything) = anomaly
```
**Priority:** 🟠 BUILD PHASE 2 | Effort: 2 hours

---

### 12. Strategy Degradation Detection
**The most important behavioral check missing.**

| Feature | Status |
|---|---|
| Signal logging | ✅ BUILT |
| Consecutive loss detection | ✅ BUILT |
| Strategy-type failure tracking | ❌ MISSING |
| Session-specific degradation | ❌ MISSING |
| Pair-specific degradation | ❌ MISSING |

**Current gap:** The system pauses after 3 consecutive losses but doesn't ask: "Are breakout entries specifically failing this week? Is EUR/USD specifically underperforming? Is the London session specifically weak?" Those distinctions would enable intelligent degradation response rather than a blunt full stop.

**This requires closed trade data — Phase 2.**

**Priority:** 🟠 BUILD PHASE 2 | Effort: 3 hours (after 30+ closed trades)

---

## SECTION 5 — INFRASTRUCTURE CHECKS

### 13. Data Feed Health
**Bad data = bad trading. Currently no validation.**

| Feature | Status |
|---|---|
| OANDA price polling every 5s | ✅ BUILT |
| Fallback to Twelve Data | ✅ BUILT |
| Stale price detection (price unchanged for too long) | ❌ MISSING |
| Frozen candle detection | ❌ MISSING |
| Missing tick detection | ❌ MISSING |

**Current gap:** If OANDA's feed freezes and returns the same price for 10 minutes, the system will happily scan on stale data. The last candle in the response would be incomplete and frozen — potentially triggering false signals on ghost data.

**What to build:**
```javascript
// In pollPrices() — detect stale feed
const prevCache = { ...priceCache };
// After update: if >3 pairs unchanged for 3+ polls in a row during market hours
const stalePairs = PAIRS.filter(p => priceCache[p] === prevCache[p]);
if (stalePairs.length > 3 && isMarketHours()) {
  console.error('[FEED] Stale data detected:', stalePairs);
  sendTelegramMsg(`⚠️ Data feed potentially frozen — ${stalePairs.join(', ')} unchanged`);
}
```
**Priority:** 🔴 BUILD NOW | Effort: 1 hour

---

### 14. Time Synchronization
**Underrated but system-critical.**

| Feature | Status |
|---|---|
| UTC-based session logic | ✅ BUILT |
| Server clock validation | ❌ MISSING |
| NTP sync check | ❌ MISSING |
| News timestamp alignment | ❌ MISSING |

**Current gap:** The news blackout runs on server time. If the server clock drifts even 2 minutes, a news blackout that should block 08:30 CPI might fire a signal at 08:29. On a local machine (not a VPS), clock drift is common and NTP sync is not guaranteed.

**What to build:**
```javascript
// On startup and every hour: compare server UTC to OANDA server time
// OANDA returns server timestamps on every candle response
// If drift > 60 seconds → alert
const serverTime = new Date();
const oandaTime = new Date(latestCandle.time);
const driftMs = Math.abs(serverTime - oandaTime);
if (driftMs > 60000) console.warn(`[TIME] Clock drift: ${driftMs}ms`);
```
**Priority:** 🟠 BUILD WITH VPS MIGRATION

---

### 15. Duplicate Signal Prevention
**Currently partially implemented.**

| Feature | Status |
|---|---|
| Block same pair if PENDING signal exists | ✅ BUILT |
| Block identical setup within same candle | 🟡 PARTIAL |
| Duplicate candle detection | ❌ MISSING |
| Signal deduplication by setup hash | ❌ MISSING |

**Current gap:** The `existPending` check prevents two PENDING signals for the same pair simultaneously, which is good. But it doesn't prevent a signal from firing on the same H4 candle twice if the first signal was rejected or expired — the same setup would re-trigger 5 minutes later.

**Priority:** 🟡 LOW — existing logic covers most cases

---

## SECTION 6 — PROFESSIONAL QUANT CHECKS

### 16. Trade Distribution Health
**Over-concentration is silent risk.**

| Feature | Status |
|---|---|
| Per-pair signal count | 🟡 PARTIAL — logged, not monitored |
| Session distribution check | ❌ MISSING |
| Pair dominance alert | ❌ MISSING |
| "All trades from one pair" detection | ❌ MISSING |

**Current gap:** No alert if 80% of trades come from USD/JPY or 90% come from London session. Concentration means the edge may be pair-specific or time-specific rather than systematic — important to know before scaling.

**Priority:** 🟠 BUILD PHASE 2 | Effort: 1 hour

---

### 17. Expectancy Stability Over Time
**Win rate is not enough. Expectancy drift is the real risk.**

| Feature | Status |
|---|---|
| Total win rate calculation | ✅ BUILT (no data yet) |
| Rolling 10-trade expectancy | ❌ MISSING |
| Expectancy trend (improving or degrading) | ❌ MISSING |
| Regime-adjusted expectancy | ❌ MISSING |

**Current gap:** A system with 60% win rate overall may have 40% win rate in the last 10 trades — indicating degradation. Static win rate hides this. Rolling expectancy reveals it.

```
expectancy_rolling = (winRate_last10 × avgWin_last10) - (lossRate_last10 × avgLoss_last10)
if expectancy_rolling drops below 0 for 2 consecutive windows → ALERT
```
**Priority:** 🟠 BUILD PHASE 2 | Effort: 2 hours (after 30+ closed trades)

---

### 18. Drawdown Velocity
**How fast drawdown grows matters as much as how large it gets.**

| Feature | Status |
|---|---|
| Total drawdown tracking | ✅ BUILT (no data yet) |
| Drawdown velocity (speed of decline) | ❌ MISSING |
| Accelerating drawdown alert | ❌ MISSING |

**Current gap:** Losing 3% over 3 weeks is very different from losing 3% in 3 days. Same total drawdown, completely different risk signal. Fast drawdown velocity means the edge has broken down, not just hit a rough patch.

```
ddVelocity = dailyLoss / avgDailyLoss_20days
if ddVelocity > 3.0 → drawdown accelerating → reduce size 50% immediately
if ddVelocity > 5.0 → circuit breaker → halt trading
```
**Priority:** 🟠 BUILD PHASE 2 | Effort: 1 hour

---

## SECTION 7 — INSTITUTIONAL SAFETY CHECKS

### 19. Kill Switch Conditions
**Emergency stop infrastructure — currently incomplete.**

| Feature | Status |
|---|---|
| Daily loss limit (3%) | ✅ BUILT & ENFORCED |
| Weekly loss limit (6%) | ✅ BUILT & ENFORCED |
| Consecutive loss pause (3 losses) | ✅ BUILT & ENFORCED |
| Manual emergency stop (via API) | ✅ BUILT (disable scanner) |
| Spread explosion kill switch | ❌ MISSING |
| API instability kill switch | ❌ MISSING |
| Abnormal volatility kill switch | 🟡 PARTIAL (ATR expansion filter) |
| Stale feed kill switch | ❌ MISSING |
| 5-losses-in-one-day kill switch | ❌ MISSING |

**What to build:**
```javascript
// Hard kill switch — fires on any of these
const KILL_CONDITIONS = [
  { check: () => spreadCache[pair] > atr * 0.5,     reason: 'Spread explosion' },
  { check: () => oandaFailCount > 3,                reason: 'API instability' },
  { check: () => priceCacheAge > 120000,            reason: 'Stale data feed' },
  { check: () => todayLosses >= 5,                  reason: '5 losses today' },
];
// If ANY condition → halt ALL trading + Telegram emergency alert
```
**Priority:** 🔴 BUILD NOW | Effort: 2 hours

---

### 20. Market Abnormality Detection
**Sometimes the market itself becomes unsafe.**

| Feature | Status |
|---|---|
| ATR expansion filter | ✅ BUILT |
| Spread spike filter | ✅ BUILT |
| Flash crash detection | ❌ MISSING |
| Liquidity vacuum detection | ❌ MISSING |
| Disconnected candles (price gaps) | ❌ MISSING |
| Unusual broker pricing detection | ❌ MISSING |

**Current gap:** A flash crash or gap event creates candles that look like valid signals but aren't — price moved 200 pips in 30 seconds and is mean-reverting, not trending. No gap detection exists.

**What to build:**
```javascript
// Gap detection: if candle open differs from previous close by > 2× ATR
const prevClose = parseFloat(candles[candles.length-2].mid.c);
const currOpen  = parseFloat(candles[candles.length-1].mid.o);
const gapSize   = Math.abs(currOpen - prevClose) / atr;
if (gapSize > 2.0) → MARKET_GAP → reject signal → send alert
```
**Priority:** 🔴 BUILD NOW | Effort: 30 minutes

---

## THE MOST IMPORTANT MISSING CHECK

### Trade Quality Memory
**The system is still blind after execution.**

This is the foundational gap everything else depends on.

Before a trade, the system should ask:

> "Have similar conditions historically produced profitable outcomes?"

Currently it cannot answer this. Not because the architecture is wrong, but because:

1. Trade reconciliation was just built (today)
2. Zero closed trades with outcomes exist yet
3. Statistical memory requires data that doesn't exist yet

**This is the correct sequence:**
```
NOW        → Accumulate closed trade outcomes (reconciliation running ✅)
30 trades  → Build rolling win rate by pair and session
50 trades  → Build rolling win rate by score band (9/12 vs 10/12 vs 11/12)
70 trades  → Build rolling win rate by volatility regime
100 trades → Confidence calibration (does 90% confidence actually win 90%?)
150 trades → Adaptive weighting becomes statistically justified
```

---

## FULL MICRO-QC PIPELINE STATUS

```
MARKET MICROSTRUCTURE
  Candle Quality (wick/body ratio, exhaustion)   ❌ MISSING
  Momentum Divergence (RSI/MACD divergence)      ❌ MISSING
  EMA Slope Strength                             ❌ MISSING
  Compression Detection                          ❌ MISSING

EXECUTION SAFETY
  Candle Close Confirmation                      ❌ MISSING  ← HIGH IMPACT
  Entry Timing (pullback vs chase)               🟡 PARTIAL
  Spread Efficiency Ratio (SL/spread ≥ 5×)       ❌ MISSING

PORTFOLIO INTELLIGENCE
  Portfolio Heat Score                           🟡 PARTIAL (USD only)
  Sector/Asset Clustering                        ❌ MISSING

BEHAVIORAL GOVERNANCE
  Confidence Stability Monitor                   ❌ MISSING
  Signal Frequency Drift                         ❌ MISSING
  Strategy Degradation Detection                 ❌ MISSING

INFRASTRUCTURE
  Data Feed Health (stale detection)             ❌ MISSING
  Time Synchronization                           ❌ MISSING
  Duplicate Signal Prevention                    🟡 PARTIAL

QUANT CHECKS
  Trade Distribution Health                      ❌ MISSING
  Expectancy Stability (rolling)                 ❌ MISSING
  Drawdown Velocity                              ❌ MISSING

INSTITUTIONAL SAFETY
  Kill Switch (spread/API/feed/5-loss)           🟡 PARTIAL
  Market Abnormality (gaps/flash crash)          ❌ MISSING
```

---

## BUILD PRIORITY — EXACT ORDER

### Build Now (Phase 1 — no data needed)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 1 | **Candle close confirmation** (`complete: true` filter) | 30 min | 🔴 CRITICAL |
| 2 | **Spread efficiency ratio** (SL must be ≥ 5× spread) | 20 min | 🔴 HIGH |
| 3 | **EMA slope angle** (flat EMA = fake trend, reject) | 1 hr | 🔴 HIGH |
| 4 | **Market gap detection** (candle gap > 2× ATR = abnormal) | 30 min | 🔴 HIGH |
| 5 | **Stale data feed detection** (price frozen alert) | 1 hr | 🔴 HIGH |
| 6 | **Extended kill switch** (5 losses/day + API failure) | 2 hrs | 🔴 HIGH |
| 7 | **MACD histogram slope** (momentum weakening → penalty) | 1 hr | 🟠 MEDIUM |
| 8 | **Candle quality** (wick/body ratio, exhaustion sequence) | 2 hrs | 🟠 MEDIUM |

### Build Phase 2 (After 30–50 closed trades)

| # | Fix |
|---|---|
| 9 | Rolling expectancy by pair + session |
| 10 | Confidence inflation detection |
| 11 | Drawdown velocity alert |
| 12 | Trade distribution health report |
| 13 | Portfolio heat score (full correlation matrix) |
| 14 | RSI divergence detection |

### Build Phase 3 (After 100 closed trades)

| # | Fix |
|---|---|
| 15 | Strategy degradation by type |
| 16 | Adaptive confidence weighting |
| 17 | Expectancy stability over rolling windows |
| 18 | Compression detection (quality entry bonus) |
| 19 | Trade quality memory (historical condition matching) |
| 20 | Probability governance engine |

---

## THE REAL DESTINATION

**Current system asks:**
> "Is this setup valid?"

**Phase 2 system asks:**
> "Is this setup valid AND historically reliable in these conditions?"

**Phase 3 system asks:**
> "What is the statistical probability this specific combination of conditions produces positive expectancy, given all prior evidence?"

That evolution from rule validation → probability governance is the difference between an intelligent prototype and a genuine trading engine.

The foundation being built here is correct. The path is clear. The discipline to not skip steps is what separates this from the 99% of retail systems that collapse.

---

## CURRENT SYSTEM MATURITY SCORE

| Layer | Score |
|---|---|
| Signal Generation | 8/10 |
| Market Filters | 7/10 |
| Risk Governance | 7/10 |
| Execution Safety | 4/10 |
| Behavioral Governance | 2/10 |
| Infrastructure Resilience | 4/10 |
| Statistical Intelligence | 1/10 (no data yet) |
| **Overall** | **5/10 → Pre-institutional** |

Target after Phase 1 builds: **6.5/10**
Target after Phase 2 (50 trades): **7.5/10**
Target after Phase 3 (100 trades): **8.5/10**

*8.5/10 = genuine institutional-grade trading engine.*

---

*All answers verified against current server.js source. No assumptions.*
