# PrecisionTraderPro — Complete 10-Phase System Audit
### Source-verified. Code-honest. No assumptions.
*Generated 2026-05-29 from actual server.js, db.js, PrecisionTraderPro.jsx*

---

# PHASE 1 — MARKET DATA INTEGRITY

## Q1. Where does ALL market price data come from?

**Two completely separate pipelines:**

**Pipeline A — Live price cache** (used by frontend, spread checks, stale detection):
```
Every 5 seconds:
OANDA REST /v3/accounts/{id}/pricing?instruments=...
  → success → priceCache + spreadCache (priceSource = 'OANDA')
  → both base URLs fail (practice tried first, then live):
    → Twelve Data REST /price?symbol=...
      → success → priceCache only (NO spread data — gap)
      → fail → priceCache unchanged (last known values survive)
```

**Pipeline B — Candles for indicator calculation** (used only during scan):
```
Every 5 minutes per scan, per pair, 5 parallel requests:
W1: OANDA /v3/instruments/{pair}/candles?count=30&granularity=W
H4: count=100, granularity=H4
H2: count=100, granularity=H2
M30: count=100, granularity=M30
M5: count=50, granularity=M5
No fallback source. If OANDA fails → empty array → pair skipped.
```

No WebSocket. No streaming. No TradingView. Pure REST polling.

**Critical gap:** When Twelve Data fallback activates, `spreadCache` retains stale values from the last successful OANDA poll. Spread-based filters and spread efficiency checks operate on wrong data during fallback.

---

## Q2. How often is price data updated?

| Data | Frequency | Source |
|---|---|---|
| Live price cache | Every 5 seconds | `setInterval(pollPrices, 5000)` |
| Spread cache | Every 5 seconds, OANDA only | Same poll |
| All candles (H4/H2/M30/M5/W1) | Every 5 minutes at scan time | Fresh REST per scan |
| ATR | Every 5 minutes | Recalculated from candles |
| EMA / RSI / MACD / ADX / Stoch | Every 5 minutes | Recalculated from candles |
| h1AtrCache (trailing stops) | Every 5 minutes | Written from `indM30.atr14` |
| News calendar | Every 30 minutes | Forex Factory REST |

Between scans, all indicators are frozen at their last scan values. A candle closing between 10:00 and 10:05 does not affect indicators until the 10:05 scan fires.

---

## Q3. Does the scanner calculate on incomplete candles?

**Mostly no — but W1 is not filtered.**

Guard applied to H4, H2, M30, M5 before `buildIndicators()`:
```js
function completedCandles(candles) {
  return candles.filter(c => c.complete !== false);
}
```

**The W1 gap:** `w1c` (weekly candles) are used for trend direction check via raw EMA calculation directly in the scan body. `completedCandles()` is **never called on W1 data.** If run on Wednesday of a trading week, the current weekly candle's close is mid-week value, distorting W1 EMA21.

All other timeframes (H4, H2, M30, M5) correctly exclude the forming candle.

---

## Q4. What happens if OANDA returns stale/duplicate/missing/delayed candles?

| Scenario | What happens |
|---|---|
| Stale candles | No detection. Indicators recalculate to same values. Signal may fire on stale state. |
| Duplicate timestamps | No deduplication. Duplicate fed to all indicator math — slight RSI/EMA corruption. |
| Missing candles (gap) | No gap detection. Indicators calculated across gap as if continuous. ATR/EMA distorted. |
| Delayed candles | No timestamp freshness check. Only `priceCache` staleness is checked, not candle data. |
| HTTP error response | `?.candles||[]` guards null → returns empty array → pair skipped safely. |
| Malformed candle (no `mid` field) | `parseFloat(c.mid.c)` throws TypeError. Outer `catch(e)` per pair catches it. Pair skipped. |

---

## Q5. Does the system verify candle sequence continuity?

**No. Zero gap/sequence validation exists anywhere.**

If OANDA returns `10:00, 10:05, 10:15` (missing 10:10), the system processes all three as sequential. ATR for the 10:15 candle would include the 10:10 gap as an abnormal true range, inflating volatility readings.

`hasMarketGap()` checks price gap between adjacent candle open vs close — this is a price gap detector, not a timestamp sequence validator.

---

## Q6. How many candles are fetched per timeframe, and why?

| TF | Count | Covers | Purpose |
|---|---|---|---|
| W1 | 30 | ~7 months | EMA21 warm-up for weekly trend |
| H4 | 100 | ~17 days | EMA9/21/50/200, ADX, ATR, patterns |
| H2 | 100 | ~8.5 days | Confirmation timeframe indicators |
| M30 | 100 | ~50 hours | Entry timeframe — RSI, MACD, EMA |
| M5 | 50 | ~4 hours | Pattern detection for entry trigger |

**Critical problem:** H4 fetch is 100 candles. After filtering `complete:false`, approximately 99 usable candles. `calcEMA(closes, Math.min(200, closes.length))` therefore runs as EMA99, not EMA200. The "EMA200" displayed and used for institutional trend filter is actually an ~EMA99. It should use `count=250` minimum.

**ADX** uses only `period+2 = 16` candles — a simplified single-period ADX, not Wilder's full smoothed ADX. Values will differ from standard charting platforms.

---

## Q7. Indicators recalculated from scratch or incrementally?

**100% from scratch, every scan.**

No state is preserved between scans. Each run:
1. Fetches 30 fresh API requests (5 TF × 6 pairs)
2. Calls `buildIndicators()` 4× per pair
3. Recomputes every EMA, RSI, ATR, MACD, ADX from the full array
4. Discards everything

EMA is seeded from `closes[0]` as initial value with no true warm-up history. For EMA9/21, this error is negligible after ~30 bars. For EMA50/200, the limited candle history means seed error persists.

---

## Q8. Can one failed timeframe corrupt the whole scan?

**No corruption — but silent degradation happens on H2/M30/M5 failure.**

`Promise.allSettled()` ensures no throw. Each failure gives empty array. Then:

| Failure | Consequence |
|---|---|
| W1 fails | W1 trend filter skipped → more permissive without logging |
| H4 fails | `h4cc.length < 26` → pair skipped. Safe. |
| H2 fails | `buildIndicators(h4cc, h4cc)` → H4 data used as H2 proxy. **Silent degradation.** |
| M30 fails | `buildIndicators(h2cc, h2cc)` → H2 as M30. **Severely degraded, no warning.** |
| M5 fails | `buildIndicators(m30cc.slice(-15), m30cc)` → M30 as M5. **Pattern detection wrong.** |

Signals CAN fire with proxied data. The Telegram message contains no indicator of which timeframes used fallback data.

---

## Q9. Does the system timestamp fetch time / candle close time / calculation time?

| Data | Timestamped? | Detail |
|---|---|---|
| Price cache fetch | ✅ `priceCacheTime = Date.now()` | Wall time |
| Price last changed | ✅ `priceLastChanged[pair]` | For stale detection |
| Candle fetch time | ❌ Not recorded | No wall-time stamp on scan fetch |
| Candle close time | ❌ Not read | `candle.time` field exists in OANDA response but never validated against clock |
| Indicator calculation time | ❌ Not recorded | |
| Signal created | ✅ `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` | SQLite auto |
| Execution filled | ✅ `actioned_at` column | |

No check validates "is the most recent H4 candle within the last 4 hours?" — stale OANDA response passes undetected.

---

## Q10. Protections against rate limits, disconnects, malformed data, NaN, zero-volume?

| Risk | Protection | Verdict |
|---|---|---|
| API rate limits | None. No throttle, no backoff, no header reading. | ❌ No guard |
| Disconnects | Both OANDA base URLs tried. 12s timeout. Price cache survives. | ✅ Handled |
| Malformed candle response | `?.candles||[]` guards null. If `mid:null` → TypeError caught per pair. | ⚠️ Partial |
| NaN indicators | `parseFloat()` of undefined = NaN. No `isNaN()` check before arithmetic. Propagates silently. | ❌ No guard |
| Zero-volume candles | No filter. Holiday/off-hours flat candles reach pattern detection and may misclassify as DOJI. | ⚠️ No guard |
| Duplicate candles | No deduplication by timestamp. | ❌ No guard |
| Sequence gaps | No continuity validator. | ❌ No guard |

---

# PHASE 2 — INDICATOR & STRUCTURE ENGINE

## Q11. How exactly is BULLISH/BEARISH defined per timeframe?

**Three separate definitions coexist, used for different purposes:**

**Definition 1 — `trend` (price vs EMA21):**
```js
const trend = currentClose > ema21 ? 'BULLISH' : 'BEARISH';
```
Used in: Check 2 (H4 Master Trend), Check 3 (H2 Trend Match).

**Definition 2 — `emaAlignment` (EMA9/21/50 stack):**
```js
const emaAlignment =
  (ema9>ema21 && ema21>ema50) ? 'BULLISH' :
  (ema9<ema21 && ema21<ema50) ? 'BEARISH' : 'MIXED';
```
Used in: Check 1 (H4 EMA Stack), direction determination for entire trade (BUY/SELL). This is the **primary direction source** — if H4 emaAlignment is MIXED, no signal fires at all.

**Definition 3 — `refTrend` (reference timeframe price vs its EMA21):**
```js
refTrend = rc[rc.length-1] > refEma ? 'BULLISH' : 'BEARISH';
```
Used in: informational field only, not in scoring.

**Hierarchy in scan:**
1. `indH4.emaAlignment` → BUY or SELL direction (MIXED = skip pair)
2. `indH4.trend` (price vs EMA21) → Check 2 weight 2
3. `indH2.trend` (price vs EMA21) → Check 3 weight 2
4. `indM30.ema9 vs ema21` → Check 4 weight 1
5. W1 EMA21 used only for counter-trend filter

No structure highs/lows. No DI+ vs DI-. No candle closes beyond prior swing.

---

## Q12. What happens if EMA9 bullish, EMA21 bearish, EMA50 flat?

`emaAlignment = 'MIXED'` because `(ema9>ema21 && ema21>ema50)` is false.

Consequence: `aiDirection = null` → `continue` → **pair completely skipped.** No score computed. No signal considered. This is the single most powerful early exit in the system.

Check 1 (H4 EMA Stack, weight 2) would also fail. There is no confidence reduction path — MIXED simply means no trade on that pair in that scan.

---

## Q13. How is EMA slope treated?

**Slope is calculated and used as a hard filter:**
```js
const emaSlope = (ema21 - ema21Prev) / closes[closes.length-1] * 10000; // bps/bar
```
Where `ema21Prev` = EMA21 calculated on closes shifted 5 bars back.

**Used in scan as rejection filter:**
```js
const emaSlope = Math.abs(indH4.emaSlope || 0);
if (emaSlope < 1.0) {
  console.log(`[SCAN] H4 EMA flat (slope ${emaSlope.toFixed(2)}) — skipped`);
  continue;
}
```

Also used in `classifyRegime()`:
- emaSlope ≥ 2.0 → TRENDING_STRONG
- emaSlope ≥ 1.0 → TRENDING
- emaSlope < 1.0 → CHOPPY (rejected)

**What's not done:** No slope acceleration detection (second derivative). No slope compared across timeframes. Slope is an absolute cutoff, not a continuous confidence modifier.

---

## Q14. Can the system detect trend exhaustion / weakening momentum?

**Yes — partially, via three mechanisms:**

**Mechanism 1 — `macdSlope` (in buildIndicators):**
```js
const macdPrev = closes.length >= 31
  ? calcEMA(closes.slice(0,-3), 12) - calcEMA(closes.slice(0,-3), 26) : macd;
const macdSlope = macd - macdPrev;
```
Used in `detectMomentumWeakening()`: H4 MACD histogram declining in bullish trend → rejection.

**Mechanism 2 — RSI overbought/oversold in `detectMomentumWeakening()`:**
- H4 BULLISH + M30 RSI > 70 → "exhaustion risk" → blocks scan
- H4 BEARISH + M30 RSI < 30 → "exhaustion risk" → blocks scan

**Mechanism 3 — RSI divergence in `detectRSIDivergence()`:**
- Price lower low + RSI higher low = BULLISH_DIVERGENCE
- Price higher high + RSI lower high = BEARISH_DIVERGENCE
- Detected but logged only, NOT a hard rejection.

**What's not detected:** Momentum acceleration/deceleration curves. Volume exhaustion (no volume data used anywhere). Candle body shrinkage over time.

---

## Q15. How does ADX influence logic?

ADX is calculated via simplified single-period formula (not Wilder's smoothed), using 16 candles.

| ADX Value | Effect |
|---|---|
| < 20 | Check 8 fails (weight 1), confidence −12 in calcTradeSetup |
| 20–24 | Check 8 passes, no confidence bonus |
| ≥ 25 | Check 8 passes, confidence +7 in calcTradeSetup |
| ≥ 28 + EMA slope ≥ 2.0 | classifyRegime → TRENDING_STRONG |

ADX has no directional component (DI+/DI- not used). It measures trend strength only, not direction. The system cannot tell if ADX 30 = strong bullish vs strong bearish using ADX alone — it relies on EMA stack for direction.

---

## Q16. Which timeframe has final authority?

**H4 has unconditional final authority.**

Decision hierarchy:
1. H4 `emaAlignment` → determines trade direction (BUY/SELL). MIXED = no trade.
2. W1 → veto only (counter-trend filter).
3. H2 → confirmation score (Check 3, weight 2).
4. M30 → entry scoring (Checks 4, 5, 6, 7).
5. M5 → entry trigger (Check 12, weight 1).

If H4=BULLISH, H2=BULLISH, M30=BEARISH: the trade is still BUY. M30 bearishness reduces score (Checks 3, 4, 7 may fail) and confidence, but does not veto the direction. The signal may still fire if score ≥ 9 via the weighted checks.

**H4 direction cannot be overridden by any lower timeframe.**

---

## Q17. Can lower timeframes override higher timeframe bias?

**No hard override. Only score reduction.**

A strong M30 bearish reversal against H4 bullish:
- Check 3 (H2 Trend Match) fails if H2 also flips: −2 weight
- Check 4 (M30 EMA Confirms) fails: −1 weight
- Check 5 (RSI Zone Safe) likely fails: −1 weight
- Check 7 (MACD Direction) likely fails: −1 weight

Total potential score reduction: 5 points. Since minimum is 9/12, this combination likely drops score below threshold → signal rejected via score, not direction.

But there is no explicit "lower TF bearish reversal = automatic reject" logic. It is implicit through the scoring math.

---

## Q18. What exactly qualifies as multi-timeframe alignment?

**Three separate definitions:**

**In scoring (`scoreSignal`):** All three checks must pass:
- Check 1: H4 EMA9>EMA21>EMA50 (weight 2)
- Check 2: H4 price > EMA21 (weight 2)
- Check 3: H2 price > EMA21 (weight 2)

**In confidence (`calcTradeSetup`):**
```js
if (h4.trend === h2.trend && h2.trend === m30.trend && ...) conf += 8;
```
All three timeframes must share `trend` value (price vs EMA21). +8 confidence.

**In regime (`classifyRegime`):** Not used. Regime only reads H4 ADX + EMA slope.

Full alignment (W1+H4+H2+M30+M5 all agree) produces maximum confidence but is never explicitly required — it emerges from passing multiple checks simultaneously.

---

## Q19. Can the system detect pullback within trend vs actual reversal?

**Partially — via H4 EMA21 distance check.**

Check 10: `h4Dist = |price - h4.ema21| / price * 100 < 0.8%`

This identifies "price near EMA21" as a pullback zone. In a healthy uptrend, price pulling back to EMA21 is the ideal entry point. This check passes when price is within 0.8% of EMA21.

`calcTradeSetup` adds: +7 confidence if h4Dist < 0.25% (very close = deep pullback to value).

**What's not implemented:**
- No higher high / lower low sequence comparison
- No detection of "trend intact vs trend broken"
- No BOS (Break of Structure) detection
- No CHOCH (Change of Character) detection
- No swing point identification

A genuine reversal where all EMAs flip will naturally cause `emaAlignment` to become MIXED → no trade. But a reversal in progress (price declining but EMAs not yet crossed) cannot be distinguished from a pullback.

---

## Q20. Does the system recognize higher highs / lower lows / BOS / CHOCH?

**No. None of these are implemented.**

Support and resistance are computed as:
```js
const resistance  = Math.max(...highs.slice(-20));   // 20-candle highest high
const support     = Math.min(...lows.slice(-20));    // 20-candle lowest low
const strongResist = Math.max(...highs.slice(-50));  // 50-candle
const strongSupport= Math.min(...lows.slice(-50));   // 50-candle
```

This is purely the highest high and lowest low of recent candles. There is:
- No swing point detection algorithm
- No counting of touches on a level
- No "fresh zone vs tested zone" distinction
- No reaction quality scoring
- No BOS (price closing beyond prior swing high/low)
- No CHOCH (lower high after prior higher highs)

Trend structure is entirely EMA-based.

---

## Q21. How exactly is RSI used?

**Three separate purposes, all on M30:**

**Purpose 1 — Zone check (Check 5, weight 1):**
```js
isBuy  ? (rsi > 40 && rsi < 68)   // ideal BUY zone
isSell ? (rsi > 32 && rsi < 60)   // ideal SELL zone
```
Checks that RSI is in a healthy zone, not extreme in either direction.

**Purpose 2 — Extreme rejection (Check 6, weight 1):**
```js
isBuy  ? rsi < 75    // BUY blocked at RSI ≥ 75
isSell ? rsi > 25    // SELL blocked at RSI ≤ 25
```

**Purpose 3 — Confidence modifier (calcTradeSetup):**
```js
isBuy  && rsi >= 42 && rsi <= 60 → conf += 5   // ideal zone
isSell && rsi >= 40 && rsi <= 58 → conf += 5
```

RSI is calculated only on M30 closes for all scoring purposes. H4 RSI is calculated and logged but not used in `scoreSignal()`. M5 RSI is calculated but used only in informational display.

RSI divergence exists as `detectRSIDivergence()` but is **informational only** — it does not affect score or confidence.

---

## Q22. What RSI values automatically reject trades?

| Trade Direction | RSI Threshold | Effect |
|---|---|---|
| BUY | RSI ≥ 75 on M30 | Check 6 fails (weight 1) |
| BUY | RSI outside 40–68 on M30 | Check 5 fails (weight 1) |
| SELL | RSI ≤ 25 on M30 | Check 6 fails (weight 1) |
| SELL | RSI outside 32–60 on M30 | Check 5 fails (weight 1) |
| BUY (GPT-4o) | RSI > 75 on M30 | GPT instructed to reject |
| SELL (GPT-4o) | RSI < 25 on M30 | GPT instructed to reject |

Both checks failing reduces score by 2 points. Since minimum score is 9/12, losing 2 points makes passing much harder but does not automatically block.

A trade can technically fire with RSI = 74 (Check 6 passes) and RSI outside ideal zone (Check 5 fails = -1 weight) if all other 10 checks pass.

---

## Q23. How is MACD used?

**Only as zero-line direction signal on M30.**

```js
function calcMACD(closes) {
  if (closes.length < 26) return 0;
  return parseFloat((calcEMA(closes, 12) - calcEMA(closes, 26)).toFixed(6));
}
```

MACD = EMA12 − EMA26. A single value, no signal line, no histogram as a separate object.

**Usage in scoring (Check 7):**
```js
isBuy  ? m30.macd > 0   // above zero line = bullish
isSell ? m30.macd < 0   // below zero line = bearish
```

**Usage in confidence:**
```js
isBuy  && m30.macd > 0 → conf += 4
isSell && m30.macd < 0 → conf += 4
```

**MACD slope** (`macdSlope = macd - macdPrev`) is calculated in `buildIndicators` and used in `detectMomentumWeakening()` and `classifyRegime()`.

**What's NOT used:** MACD signal line (EMA9 of MACD). Signal line crossovers. Histogram divergence. Zero-line crossover timing. Histogram slope for trend strength.

---

## Q24. Can momentum disagreement block trades?

**Yes — via `detectMomentumWeakening()` (new function, hard block):**

```js
if (h4Ind.macdSlope < -0.000005 && h4Ind.trend === 'BULLISH') → block
if (h4Ind.trend === 'BULLISH' && m30Ind.rsi14 > 70) → block
if (h4Ind.trend === 'BEARISH' && m30Ind.rsi14 < 30) → block
```

This is a `continue` in the scan loop — a hard rejection before scoring even runs.

**RSI + MACD both wrong but below thresholds:** Scores reduce by −1 to −2 points each. May still pass at 9/12.

---

## Q25. Can the system detect divergence types?

| Type | Detected? | Used How? |
|---|---|---|
| Regular Bullish Divergence | ✅ `detectRSIDivergence()` BULLISH_DIVERGENCE | Logged, informational only |
| Regular Bearish Divergence | ✅ `detectRSIDivergence()` BEARISH_DIVERGENCE | Logged, informational only |
| Hidden Bullish Divergence | ✅ BULLISH_HIDDEN_DIV | Logged, informational only |
| Hidden Bearish Divergence | ✅ BEARISH_HIDDEN_DIV | Logged, informational only |
| Exhaustion divergence | ❌ Not implemented | — |
| MACD divergence | ❌ Not detected, only slope trend | — |
| Multi-timeframe divergence | ❌ Single timeframe (M30) only | — |

**Key gap:** Divergence is detected and logged in scan output and Telegram message but has **zero effect on score or confidence.** A perfect bullish divergence does not increase confidence by even 1 point.

---

## Q26. Which candle patterns are recognized?

**Exactly 7, from `detectPattern()` using last 2 candles:**

| Pattern | Condition |
|---|---|
| BULLISH_PIN_BAR | lowerWick > body×2 AND body < range×0.3 AND close > open |
| BEARISH_PIN_BAR | lowerWick > body×2 AND body < range×0.3 AND close < open |
| BULLISH_ENGULFING | Bullish candle closes above prior bearish open, opens below prior close |
| BEARISH_ENGULFING | Bearish candle closes below prior bullish open, opens above prior close |
| DOJI | body < range×0.1 |
| BULLISH_CANDLE | close > open (fallback) |
| BEARISH_CANDLE | close ≤ open (fallback) |

**Not implemented:** Hammer, shooting star, morning/evening star, harami, three soldiers/crows, inside bar, outside bar.

---

## Q27. How much influence do candle patterns have?

**Optional confirmation — weight 1 in 12-check engine:**

- M5 pattern confirming direction = Check 12 (weight 1 of 17 total weight)
- Strong M5 pattern (pin bar or engulfing) = +5 confidence bonus in calcTradeSetup
- Patterns classified as BULLISH_CANDLE or BEARISH_CANDLE (the generic fallbacks) do pass Check 12 — a single green M5 candle counts as "entry pattern."

In practice, Check 12 is the softest check. A plain BULLISH_CANDLE at the right time counts equally to a BULLISH_ENGULFING.

---

## Q28. Does pattern quality matter?

**No. All patterns of the same type are treated identically.**

A tiny 2-pip BULLISH_ENGULFING at no significant level receives the same Check 12 pass and +5 confidence as a massive 20-pip engulfing at major H4 support with volume confirmation.

The only quality filter that exists is the new `inspectCandleQuality()` which rejects:
- Body < 15% of range (doji-like)
- Wick > 3× body (exhaustion)
- 2+ candles > 2.5×ATR (spike environment)

These reject the environment rather than scoring the quality within acceptable patterns.

---

## Q29. Can the system detect rejection wicks / liquidity grabs / stop hunts / failed breakouts?

| Feature | Status |
|---|---|
| Rejection wicks | ⚠️ Detected only as BULLISH/BEARISH_PIN_BAR — no magnitude, no zone context |
| Liquidity grabs | ❌ Not implemented — no spike-and-reverse detection |
| Stop hunts | ❌ Not implemented — `analyzeLiquidity()` identifies where stops likely cluster but doesn't detect whether they've been swept |
| Failed breakouts | ❌ Not implemented — no breakout then close-back detection |

---

## Q30. Does the system analyze S/R strength, touch count, reaction quality?

**No — only nearest extreme price levels:**

```js
resistance  = Math.max(...highs.slice(-20));   // highest high, last 20 bars
support     = Math.min(...lows.slice(-20));     // lowest low, last 20 bars
strongResist = Math.max(...highs.slice(-50));  // highest high, last 50 bars
strongSupport= Math.min(...lows.slice(-50));   // lowest low, last 50 bars
```

These are single extreme values — the highest/lowest candle wick in the lookback window. There is:
- No touch count (1 touch vs 5 touches = same)
- No reaction quality (strong rejection vs marginal pause = same)
- No fresh vs tested zone distinction
- No zone width (a 1-pip exact level vs a 10-pip zone = same)
- No horizontal level clustering

---

## Q31. Exactly how is ATR used?

| Use | Location | Detail |
|---|---|---|
| SL calculation | calcTradeSetup() | Primary: strongSupport − 0.2×ATR (BUY). Fallback: price ± 1.6×ATR |
| TP calculation | calcTradeSetup() | Via slDist × 2.5 if no clear S/R |
| Volatility filter | isATRExpanded() | Recent ATR > 1.8× historical ATR → reject scan |
| Spread filter | isSpreadAcceptable() | Spread > 25% of ATR → reject |
| Market gap | hasMarketGap() | Open gap > 2×ATR → reject |
| Trailing stop | runTrailingStops() | Trail at 1.5×ATR behind current price |
| Candle quality | inspectCandleQuality() | Candle range > 2.5×ATR → quality issue |
| Regime check | classifyRegime() | Not directly — uses EMA slope/ADX instead |

---

## Q32. Can high volatility reject a trade?

**Yes — multiple paths:**

- `isATRExpanded()` (recent > 1.8× historical) → hard reject (FILTER 1, scan)
- `inspectCandleQuality()` (2+ candles > 2.5×ATR) → hard reject (post-regime)
- `detectMomentumWeakening()` (RSI exhaustion) → hard reject
- `classifyRegime()` VOLATILE_EXHAUSTION → hard reject

High volatility does NOT widen SL automatically. SL is based on ATR at scan time — if ATR is expanded when signal fires, the SL will be wider, which reduces lot size proportionally (risk is %-based).

---

## Q33. Can low volatility reject trades?

**Yes — via `classifyRegime()` and EMA slope filter:**

- Low volatility typically accompanies ranging markets → ADX < 15 → RANGING → rejected
- Flat EMA slope (< 1.0 bps/bar) → rejected
- `detectCompression()` identifies ATR ratio < 0.70 — this is flagged as **positive** (breakout potential) and logged, but does NOT reject the trade

Low volatility compression is treated as opportunity, not danger.

---

## Q34. Does the system distinguish healthy expansion vs chaotic volatility?

**Partially:**

- `isATRExpanded()` threshold 1.8× catches chaotic expansion
- `inspectCandleQuality()` catches 2+ abnormal candles
- `detectMomentumWeakening()` catches RSI exhaustion during expansion

**Not distinguished:**
- Trending expansion (price moving cleanly in one direction) vs news-spike expansion (random)
- Sustained healthy volatility vs brief spike then return to normal
- Volatility regime duration (just started expanding vs been expanding 3 days)

---

## Q35. Can the system identify breakout conditions / compression / squeeze?

| Feature | Status |
|---|---|
| Compression detection | ✅ `detectCompression()` — ATR ratio < 0.70. Logged but not a hard entry trigger. |
| Breakout conditions | ❌ No specific breakout pattern detection |
| Volatility expansion cycle | ⚠️ Detected post-hoc via ATR expansion rejection |
| Squeeze (Bollinger/Keltner style) | ❌ Not implemented |

The system identifies compression and logs it as favorable context but does not use it to specifically target breakout entries. It still requires EMA alignment and trend structure.

---

# PHASE 3 — SIGNAL SCORING & DECISION ENGINE

## 12-Check Engine: Complete Specification

**Input:** direction, price, h4/h2/m30/m5 indicators, news events  
**Output:** score (count), pct (weighted %), checks array

| Check | Condition | Weight | Hard reject? |
|---|---|---|---|
| 1. H4 EMA Stack | EMA9 > EMA21 > EMA50 (BUY) | 2 | No |
| 2. H4 Master Trend | price > EMA21 on H4 | 2 | No |
| 3. H2 Trend Match | price > EMA21 on H2 | 2 | No |
| 4. M30 EMA Confirms | EMA9 > EMA21 on M30 | 1 | No |
| 5. RSI Zone Safe | M30 RSI 40–68 (BUY) | 1 | No |
| 6. RSI Not Extreme | M30 RSI < 75 (BUY) | 1 | No |
| 7. MACD Direction | M30 MACD > 0 (BUY) | 1 | No |
| 8. ADX Trending | H4 ADX ≥ 20 | 1 | No |
| 9. Prime Session | UTC hour 7–17 | 1 | No |
| 10. Not Overextended | |price − H4 EMA21| < 0.8% | 1 | No |
| 11. No News Blackout | No HIGH event ±45/30 min | 2 | No |
| 12. M5 Entry Pattern | Bullish pattern on M5 | 1 | No |

**Thresholds:**
- Score threshold: `min_score` (default 9, configurable 7–12)
- Total weight: 17 (2+2+2+1+1+1+1+1+1+1+2+1)
- Pct = passedWeight / 17 × 100
- Score = count of passing checks (unweighted count)

**Important discrepancy:** The `score` metric counts checks, not weight. You could pass 9 checks (all weight-1 checks) for score=9 but only pct≈53%. You could pass 6 checks including the three weight-2 checks for score=6 but pct≈71%. The system filters on score (count), but uses pct for confidence calculation.

---

# PHASE 4 — AI VALIDATION LAYER

## Q61. When exactly is AI called?

**GPT-4o is called only if calc engine passes first:**

```
Scan → 15 pre-filters → 12-check score ≥ minScore → calcTradeSetup()
→ if (openai_key exists AND setup.confidence ≥ aiThreshold): call GPT-4o
→ else if (setup.confidence < aiThreshold): skip pair
```

AI is called: after score filter, after calc engine, only when confidence ≥ threshold (default 80%). If no OpenAI key: falls back to calc-only if confidence ≥ threshold.

---

## Q62. What data is sent to AI?

**Pre-processed indicator summaries only. No raw candles, no OHLC, no images.**

```
PAIR: EUR/USD | PRICE: 1.08422 | SESSION: LONDON
PRECISION SCORE: 10/12 checks | CALC CONFIDENCE: 87%

H4 (MASTER): EMA9=1.08215 EMA21=1.08180 EMA50=1.08010 RSI=58 ADX=24 ATR=0.00420 Trend=BULLISH
H2 (CONFIRM): EMA9=1.08320 EMA21=1.08290 RSI=55 Trend=BULLISH
M30 (ENTRY): EMA9=1.08401 EMA21=1.08380 RSI=52 MACD=0.000045 Pattern=BULLISH_ENGULFING
M5 (TRIGGER): RSI=48 Pattern=BULLISH_CANDLE
H4 Strong Support: 1.07890 | H4 Strong Resistance: 1.09100
Calc Engine SL: 1.07810 | Calc Engine TP: 1.09000
Checks PASSED: [list] | Checks FAILED: [list]
```

AI never sees: raw price bars, volume, tick data, charts, screenshots, previous trades.

---

## Q63. Does AI independently analyze the market or validate calc engine conclusions?

**It validates, not independently analyzes.**

The prompt is explicit: *"A rule-based engine already passed this setup through 12 strict checks. Your job: validate the direction, then set PRECISE SL/TP at actual S/R levels."*

AI receives the calc engine's direction, confidence, and SL/TP pre-calculated. It can agree or disagree with direction and refine SL/TP — but it works from pre-filtered, pre-labeled data. It is a validator, not an originator.

---

## Q64. Can AI disagree with the calc engine?

**Yes, and it is a hard reject.**

```js
if (gptParsed.direction === 'NEUTRAL' || gptParsed.direction !== aiDirection) {
  console.log(`GPT-4o REJECTED — direction mismatch`);
  continue;  // pair skipped entirely
}
```

If AI returns NEUTRAL or opposite direction → signal dies. No override path.
If AI agrees on direction but confidence < threshold → signal dies.
If AI agrees + valid SL/TP + confidence ≥ threshold → AI SL/TP used, AI confidence used.

---

## Q65. What happens if AI returns NEUTRAL/UNCERTAIN/LOW CONFIDENCE?

| AI Response | Outcome |
|---|---|
| NEUTRAL | Hard rejection → pair skipped |
| Direction disagrees | Hard rejection → pair skipped |
| Confidence < threshold | Hard rejection → pair skipped |
| Malformed / no parse | `parseAIResponse()` returns direction='NEUTRAL' → rejection |
| API timeout/error | `catch(e)` → calc engine result used as fallback |

---

## Q66. What exact AI models are active?

**GPT-4o only in the scan pipeline.**

```js
const openai = new OpenAI({ apiKey: keys.openai_key });
const completion = await openai.chat.completions.create({
  model: 'gpt-4o', max_tokens: 300, ...
});
```

`@anthropic-ai/sdk` is installed as a package dependency and `Anthropic` is imported at the top of server.js, but it is **never called in any live execution path.** Claude is unused dead code in the codebase.

---

## Q67. What role is AI instructed to play?

**Risk manager / validator.** System prompt:
> "You are a professional forex risk manager verifying a trade signal. A rule-based engine already passed this setup through 12 strict checks. Your job: validate the direction, then set PRECISE SL/TP at actual S/R levels."

Explicit hard rules given: RSI > 75 = reject BUY. ADX < 20 = reject. 90%+ confidence only if all 4 TF perfectly aligned.

---

## Q68. What exact output does AI return?

**Exactly 6 lines — structured text, not JSON:**

```
1. Market Bias: BULLISH / BEARISH / NEUTRAL
2. Confidence Score: X%
3. Entry Zone: [price]
4. Stop Loss: [price]
5. Take Profit: [price]
6. Risk/Reward: 1:X
```

Parsed by `parseAIResponse()` using string matching (`.match(/(\d+)%/)`). No schema validation. No JSON. If GPT adds any extra text or changes line numbering, the parser returns `direction:'NEUTRAL'` → rejection.

---

## Q69. Can AI hallucinate invalid setups?

**Yes — three paths exist:**

1. **Inconsistent SL/TP:** If GPT returns SL above entry for a BUY, `slPips < 2` guard will catch it → pair skipped.
2. **Wrong R:R:** If TP gives R:R < 1.5 → `rr < 1.5` guard catches it.
3. **Contradictory reasoning with valid numbers:** GPT says "bearish momentum" but returns BULLISH bias. The text is stored in `analysis` field but the parsed direction drives the actual decision. No contradiction check.
4. **Bullish explanation on bearish chart:** The prompt strictly binds AI — but LLMs can still produce inconsistent outputs. The system only validates parsed numeric fields, not the reasoning quality.

---

## Q70. Does AI reasoning influence score numerically?

**No — pass/fail only.**

The 12-check score is fully calculated by `scoreSignal()` before AI is called. AI cannot modify the score. AI can only: agree/reject direction, refine SL/TP, provide a new confidence number. The confidence from AI replaces the calc engine confidence in the signal — but not the 12-check score.

---

## Q71. If OpenAI API fails completely?

**Falls through to calc engine — no crash:**

```js
} catch(e) {
  console.log(`GPT-4o error — using calc engine: ${e.message}`);
  // Fall through: use calc engine result
}
```

The `parsed` object retains calc engine values. Scan continues with `parsed.confidence = setup.confidence`. The signal may still fire if calc confidence ≥ threshold.

**No alert, no logging of the failure to SQLite, no degraded-mode flag in the Telegram message.**

---

## Q72. Can the system trade without AI?

**Yes, two paths:**

1. No OpenAI key configured → `keys.openai_key` empty → calc-only branch runs
2. OpenAI API error → `catch` falls through to calc engine

In both cases, the signal uses calc engine confidence and SL/TP. The system is fully functional without AI — AI is an optional second validation layer.

---

## Q73. Does AI have memory between trades?

**Zero memory. Fully stateless.**

Every GPT-4o call is a fresh API request with no session context, no prior trade history, no loss awareness. GPT-4o sees only the current signal's indicator snapshot. It cannot learn from past outcomes or adapt to recent performance.

---

## Q74. Are AI responses logged?

**No. Nothing is persisted.**

The GPT response text (`gptText`) is:
- Partially stored in `analysis` column if trade is signaled
- Never stored in full if signal is rejected
- Prompt sent to GPT is never stored
- Token usage is never logged
- Timestamps not logged

You cannot reconstruct what was sent or received for any historical signal.

---

## Q75. Can AI decisions be replayed exactly?

**No — impossible for two reasons:**

1. **Temperature:** GPT-4o temperature is not set → defaults to 1.0 (random). Same prompt can produce different outputs on different calls.
2. **Incomplete logging:** Prompt, response, and market state at call time are not persisted together.

You can reconstruct the indicator values from stored signal fields (ema_align, rsi, h4_trend columns) but not the full market state or the exact GPT response.

---

## Q76. Has AI been proven statistically better than calc alone?

**No evidence yet. Zero closed trades in system.**

The system has no comparative data. No A/B test. No split-sample. No period where calc-only ran vs calc+AI ran on identical conditions. This question cannot be answered until sufficient closed trade history exists.

---

## Q80. Is AI edge generation or edge filtration?

**Filtration — with SL/TP refinement.**

AI does not discover trades. It receives a pre-filtered setup and either validates it or kills it. The primary value is preventing false positives that the calc engine would have approved. Secondary value is more precise SL/TP placement using the S/R levels provided in the prompt.

---

## Q84. Is AI temperature fixed?

**No. Default temperature (1.0) is used — outputs are non-deterministic.**

Same market conditions + same prompt can produce different responses on different runs. This means:
- A signal rejected today might be approved tomorrow under identical conditions
- No reproducibility guarantee
- Cannot be debugged by replay

Setting `temperature: 0` would make it deterministic. This has not been done.

---

## Q85. Single biggest AI weakness?

**Non-determinism + zero logging = unauditable black box.**

When a trade loses, there is no way to determine whether:
- Calc engine was responsible
- AI was responsible  
- AI agreed when it shouldn't have
- AI added value or hurt performance

The AI layer is currently unaccountable.

---

# PHASE 5 — EXECUTION ENGINE

## Q86. Full execution sequence step-by-step

```
1. User taps ✅ APPROVE in Telegram
2. Telegram sends callback_query to getUpdates (polled every 4s)
3. pollTgCallbacks() receives update
4. tgOffset advances (deduplication via offset)
5. DB query: SELECT * FROM signals WHERE id=? AND status='PENDING'
   → if status ≠ 'PENDING': "already processed" → abort
6. tgAnswerCbq(cbq.id, '✅ Executing trade...')
7. executeSignal(sig) called
8. checkRiskGovernors(signal):
   - OANDA balance fetch
   - Daily/weekly limit check
   - Consecutive loss check
   - Correlation check
   - Today's loss count check
   - OANDA latency check
   - Feed staleness check
   → if any block: DB update status='BLOCKED', Telegram alert, return
9. Build OANDA market order body with SL + TP from original signal values
10. oandaRequest() POST /v3/accounts/{id}/orders
11. Parse orderFillTransaction from response
12. DB update: status='EXECUTED', oanda_order_id, trade_id, filled_price
13. Log slippage to execution_log table
14. Edit Telegram message to show execution confirmation
```

---

## Q87. At what exact moment are SL/TP/lot size calculated?

**All calculated at signal generation time (step 3 of scan), NOT at execution time.**

| Value | When calculated | Who calculates |
|---|---|---|
| SL | During `calcTradeSetup()` at scan time | Calc engine |
| TP | During `calcTradeSetup()` at scan time | Calc engine |
| Lot size | At scan time (account balance fetch in scan) | Risk calculator |
| Risk validation | At execution time (step 8) | Risk governors |

When you press APPROVE 3 minutes after signal was generated, the price may have moved significantly. The SL/TP sent to OANDA are the original values from scan time, not recalculated for current price.

---

## Q88. Is execution market orders only?

**Yes. Market orders only.**

```js
order: {
  type: 'MARKET',
  instrument: oandaInstr,
  units: String(tradeUnits),
  stopLossOnFill: { price: signal.stop_loss.toFixed(dp) },
  takeProfitOnFill: { price: signal.take_profit.toFixed(dp) },
}
```

No limit orders, no stop entries, no pending orders, no time-in-force beyond GTC for SL/TP.

---

## Q89. Can the system retry failed executions?

**No retry logic exists.**

If execution fails:
```js
} catch(e) {
  db.prepare(`UPDATE signals SET status='FAILED', ...`).run(signal.id);
  tgEditMsg(signal.tg_message_id, '❌ EXECUTION FAILED...');
}
```

Status = FAILED. No retry. User must manually trigger a new scan or approve again from web UI. No automatic reattempt.

---

## Q90. How does the system verify order filled?

**Checks `orderFillTransaction` field in OANDA response:**

```js
const filled = orderResult?.orderFillTransaction;
const orderId  = filled?.id || 'unknown';
const tradeId  = filled?.tradeOpened?.tradeID || null;
const filledPx = parseFloat(filled?.price || signal.entry_price);
```

If `orderFillTransaction` is absent (order queued but not yet filled, or rejected): `orderId = 'unknown'`, `tradeId = null`, `filledPx = signal.entry_price` (wrong value).

Status is set to EXECUTED regardless of whether `orderFillTransaction` was present. **A rejected order can be recorded as EXECUTED with price = signal.entry_price.**

---

## Q91. Does the system fetch live spread immediately before execution?

**No. Uses cached spread from last 5-second price poll.**

`spreadCache[signal.pair]` may be up to 5 seconds stale. No fresh spread fetch occurs at execution time. If news just hit and spread widened to 20× normal, the execution will proceed with the cached narrow spread value in the execution_log — but the actual order will fill at the widened spread.

---

## Q92. Can spread invalidate a trade AFTER approval?

**No. There is no post-approval spread check in the execution path.**

`isSpreadAcceptable()` runs at scan time. Between scan and execution (up to several minutes), spread can explode. The only protection is the 5-second-cached `spreadCache` which `checkRiskGovernors` does not re-check.

---

## Q93. How is slippage handled?

**Detected and logged post-fill. Not rejected or adapted.**

```js
const slippagePips = Math.abs(filledPx - signal.entry_price) / pipSize;
const slippageDir  = (isBuy ? filledPx > signal.entry_price : ...) ? 'NEGATIVE' : 'POSITIVE';
db.prepare(`INSERT INTO execution_log ...`).run(slippagePips, slippageDir, ...);
if (slippagePips > 3) console.warn(`[SLIPPAGE] ... pips`);
```

Slippage is logged. A warning is printed if > 3 pips. But there is no:
- Rejection of fills with excessive slippage
- SL/TP adjustment after slippage
- Trade cancellation

The trade proceeds regardless of slippage amount.

---

## Q96. How is lot size calculated exactly?

```js
const riskAmt = balance * (riskPct / 100);      // e.g., $10,000 × 1% = $100

let pipVal = pipSize;   // default 0.0001
if (instr==='USD_JPY') pipVal = 0.01 / price;   // JPY pip value approximation
if (instr==='USD_CAD') pipVal = 0.0001 / price; // CAD pip value approximation
if (instr==='XAU_USD') pipVal = 0.1;            // Gold: $0.10 per oz per pip

// Dynamic risk reduction
const lossFactor = consecLoss === 1 ? 0.50 : consecLoss >= 2 ? 0.25 : 1.0;
const sizeFactor = Math.min(lossFactor, timeFactor);

units = Math.floor(riskAmt / (slPips * pipVal) * sizeFactor);
```

**Critical gap:** `pipVal` approximations are not exact for cross pairs (EUR/USD, AUD/USD, GBP/USD). For these, `pipVal = pipSize = 0.0001`. This is approximately correct for USD-quoted pairs (where 1 pip = $10 per 100,000 units), but ignores EUR-to-USD conversion for the account's base currency. If the account is GBP-denominated, all pip value calculations are in USD rather than GBP.

---

## Q99. How does breakeven logic work exactly?

**Trigger: unrealized P&L ≥ initial SL distance in pips (1:1 RR reached)**

```js
const beThreshold = slPips * 1.0;  // exactly 1:1
if (plPips >= beThreshold && currentSL) {
  const bePrice = isBuy ? (entry + pipSize * 3) : (entry - pipSize * 3); // 3 pips above entry
  const shouldMove = isBuy ? newSL > currentSL : newSL < currentSL;
  if (shouldMove) { /* PUT order to OANDA */ }
}
```

Moves SL to entry + 3 pips (not exactly entry) when pnl in pips ≥ original SL distance. Runs every 30 seconds.

---

## Q100. How does trailing stop work exactly?

**Trigger: unrealized pips ≥ 1.5× original SL pips**

```js
if (plPips >= slPips * 1.5) {
  const atr = h1AtrCache[instr] || slPips * pipSize;
  const trailSL = isBuy ? (currentPx - atr * 1.5) : (currentPx + atr * 1.5);
  const shouldTrail = isBuy ? trailPrice > currentSL : trailPrice < currentSL;
  if (shouldTrail) { /* PUT order to OANDA */ }
}
```

Trail distance = 1.5×ATR behind current price. ATR sourced from `h1AtrCache[instr]` which is populated during scan cycles with `indM30.atr14`. Updated only when scanner runs — not in real-time.

**Key risk:** If price moves rapidly between scan cycles, the ATR cached is stale. Also, trail only moves in favor — correctly implemented.

---

## Q102. Can a manually approved trade still be blocked automatically?

**Yes. `checkRiskGovernors()` runs regardless of how approval was triggered.**

Whether approval comes from Telegram button or web UI APPROVE endpoint, `executeSignal()` always calls `checkRiskGovernors()` first. If blocked:
- DB status = 'BLOCKED'
- Telegram message edited to show block reason
- Trade never sent to OANDA

This is the primary protection against emotional override.

---

## Q105. How does the system prevent duplicate execution?

**Via database status check only:**

```js
const sig = db.prepare('SELECT * FROM signals WHERE id=?').get(signalId);
if (!sig || sig.status !== 'PENDING') {
  await tgAnswerCbq(cbq.id, 'Signal already processed');
  continue;
}
```

If user double-taps Telegram APPROVE:
- First tap: status = PENDING → execution starts → status set to EXECUTED
- Second tap (if polled before status update): status might still be PENDING → second execution fires

**Race condition exists:** The status is updated to EXECUTED only AFTER the OANDA order is sent. If two taps arrive in the same 4-second poll cycle, both will see status=PENDING and both will attempt execution. No mutex/lock. This is a real duplicate execution risk with double-tap or rapid approval.

---

## Q109. If internet disconnects during open trades?

| Component | Behavior during disconnect |
|---|---|
| Trailing stop | Stops running — OANDA broker SL remains as protection |
| Reconciliation | Stops — trades remain status='EXECUTED' until reconnect |
| Scanner | Stops — no signals during disconnect |
| Price polling | Stops — `priceCache` frozen at last value |
| Telegram alerts | Stop — no notifications |
| OANDA SL/TP | Remain active on broker side — they don't require local connection |

Trades are protected by broker-side SL/TP. The dangerous period is when trailing stop has moved SL to breakeven but internet disconnects before the PUT order reaches OANDA — in that case, original SL remains on OANDA and the modified breakeven level is lost.

---

# PHASE 6 — RISK GOVERNORS & CAPITAL DEFENSE

## Q111. What is the maximum risk allowed?

| Level | Limit | Enforced? | Block type |
|---|---|---|---|
| Per trade | `risk_pct` setting (default 1%) of balance | ✅ Hard | Lot calculation |
| Daily loss | 3% of balance | ✅ Hard | checkRiskGovernors() |
| Weekly loss | 6% of balance | ✅ Hard | checkRiskGovernors() |
| Monthly loss | Not implemented | ❌ None | — |
| Consecutive losses | ≥ 3 | ✅ Hard | checkRiskGovernors() |
| Today's total losses | ≥ 5 | ✅ Hard | checkRiskGovernors() |
| Correlated exposure | 2 same-direction USD trades | ✅ Hard | checkRiskGovernors() |

---

## Q112. What exactly happens when daily DD limit is hit?

1. `checkRiskGovernors()` called at execution time
2. Fetches current OANDA balance
3. Compares `daily.realized_pl` (from local `daily_pnl` table) vs `balance × 0.03`
4. If breached: adds block reason to array
5. Execution blocked → status='BLOCKED' in DB
6. Telegram alert sent with block reason

**Gap:** The scanner is NOT stopped. It continues scanning and sending Telegram alerts. Only execution is blocked. Signals continue to appear in the app with APPROVE buttons. Pressing APPROVE will be blocked by governors, but the visual UX doesn't clearly communicate why the button won't work until you try.

---

## Q116. How are consecutive losses tracked?

**Globally across all pairs, all sessions:**

```js
function getConsecutiveLosses() {
  const recent = _stmtConsecLosses.all(); // last 10 closed signals
  let count = 0;
  for (const t of recent) {
    if ((t.realized_pl || 0) < 0) count++;
    else break;
  }
  return count;
}
```

Counts losses from the most recent closed trade backward until a winner is found. No pair-specific tracking. No session-specific tracking. No date boundary — a loss from last week counts if it's the most recent result.

---

## Q117. What triggers circuit breaker?

**3 consecutive losses (globally, rolling, regardless of date).**

```js
const consec = getConsecutiveLosses();
if (consec >= 3)
  blocks.push(`${consec} consecutive losses — circuit breaker active.`);
```

Active until: a winning trade is recorded in SQLite (manually or via reconciliation).

No auto-reset timer. No "end of day" reset. 3 losses on Monday and 2 more on Tuesday = still blocked because the Tuesday losses continue the streak.

---

## Q119. Does system reduce risk BEFORE full shutdown?

**Yes — via dynamic sizing in scan:**

```js
const lossFactor = consecLoss === 1 ? 0.50 : consecLoss >= 2 ? 0.25 : 1.0;
```

| Consecutive losses | Position size |
|---|---|
| 0 | 100% |
| 1 | 50% |
| 2 | 25% |
| 3+ | Execution blocked (circuit breaker) |

This is applied at scan time (lot calculation). It does not affect already-open trades.

---

## Q122. Can system detect EURUSD BUY + GBPUSD BUY + AUDUSD BUY as one massive USD short?

**Yes — via `USD_CORR_GROUP`:**

```js
const USD_CORR_GROUP = {
  'EUR/USD': { BUY:'USD_SHORT', ... },
  'GBP/USD': { BUY:'USD_SHORT', ... },
  'AUD/USD': { BUY:'USD_SHORT', ... },
  ...
};
```

If EUR/USD BUY and GBP/USD BUY are open, `getCorrelatedOpenCount('AUD/USD', 'BUY')` returns 2 → blocked.

**Gap:** XAU/USD is explicitly omitted from `USD_CORR_GROUP`. XAUUSD trades are invisible to the correlation system. XAU/USD BUY + EUR/USD BUY + GBP/USD BUY = effectively 3 USD shorts (gold rises when USD falls) but only 2 are detected. The correlation system misses gold entirely.

---

## Q125. Does the system calculate portfolio heat?

**Yes — added recently via `getPortfolioHeat()`:**

```js
for (const s of open) {
  const pct = parseFloat(s.risk_pct || 1);
  totalPct += pct;
  ...
}
heatLevel = totalPct > 5 ? 'CRITICAL' : totalPct > 3 ? 'HIGH' : ...
```

Critical heat blocks new signals at scan time. Available via `/api/portfolio/heat` endpoint.

---

## Q131. Can the operator override risk limits?

**Yes — via direct database manipulation or API calls.**

There is no authentication on any endpoint. Anyone can call:
- `POST /api/autotrade/approve/:id` — bypasses Telegram, executes directly
- `POST /api/storage/autotrade_settings` — change risk thresholds
- `POST /api/trade/reconcile` — manipulate reconciliation

The risk governors run during execution. But `risk_pct` is a stored setting that can be changed at any time. Nothing prevents setting `risk_pct = 50` before approving a trade, then setting it back.

---

## Q135. Biggest capital defense weakness?

**No post-approval price drift validation.**

Signal generated at 10:00 with EUR/USD=1.0840.
User approves at 10:04. Price now 1.0865.
System executes at 1.0865.
SL calculated for entry at 1.0840 is now 25 pips away instead of the intended 15 pips.
Actual risk = 67% higher than intended.
No detection. No rejection. No recalculation.

---

# PHASE 7 — TRADE LIFECYCLE & POST-TRADE INTELLIGENCE

## Q1 (Phase 7). Exact execution timeline from APPROVE to live trade

```
T+0:   User taps ✅ in Telegram
T+0-4s: Server polls getUpdates (every 4s)
T+4s:  tgAnswerCbq() — "Executing..." shown in Telegram
T+4s:  checkRiskGovernors() called
T+5s:  OANDA balance fetch (inside governors)
T+6s:  Governors complete
T+7s:  OANDA market order POST
T+8s:  Fill received or error
T+8s:  DB updated, slippage logged
T+9s:  Telegram message edited to execution confirmation
```

Actual time from tap to live trade: approximately 4–12 seconds, dominated by Telegram polling latency and OANDA latency.

---

## Q3 (Phase 7). Is price refreshed before execution?

**No. Original signal price used.**

`signal.entry_price` = price at scan time. No fresh quote fetch in `executeSignal()`. The OANDA market order executes at current market price regardless — but SL/TP are calculated from the stale signal price.

---

## Q11 (Phase 7). How does system know trade closed?

**Polling reconciliation every 2 minutes:**

```js
const r = await oandaRequest(`/v3/accounts/${keys.oanda_account}/trades?state=CLOSED&count=50`);
```

Matches by `trade_id` (OANDA's ID). Updates `realized_pl`, `exit_price`, `exit_reason`, `closed_at`, `duration_mins`, `actual_pips`. Runs at startup (15s delay) then every 2 minutes.

---

## Q12 (Phase 7). Reconciliation frequency?

Every 2 minutes: `setInterval(() => { reconcileTrades() }, 2 * 60 * 1000)`

---

## Q13 (Phase 7). What trade data gets stored after closure?

| Metric | Stored? |
|---|---|
| Entry price | ✅ `entry_price` |
| Exit price | ✅ `exit_price` |
| SL/TP hit | ✅ `exit_reason` (SL_HIT / TP_HIT / MANUAL) |
| Realized P&L | ✅ `realized_pl` |
| Slippage at entry | ✅ In `execution_log` table |
| Spread at entry | ✅ In `execution_log` table |
| Duration | ✅ `duration_mins` |
| Actual pips | ✅ `actual_pips` |
| Max favorable excursion | ❌ Not tracked |
| Max adverse excursion | ❌ Not tracked |

---

## Q14 (Phase 7). Can reconciliation recover after outage?

**Yes — partially.**

On reconnect, reconciliation runs and fetches OANDA's closed trades. If a trade closed during outage, it will be matched by `trade_id` and status updated to CLOSED.

**Gap:** OANDA's closed trades API returns `count=50`. If more than 50 trades closed during a very long outage, older ones are not fetched and remain as status='EXECUTED' orphans.

---

## Q19 (Phase 7). Does system know WHY trades lose?

**Exit reason only (SL_HIT, TP_HIT, MANUAL). No causal analysis.**

No classification of: "lost due to entry during volatility," "wrong regime," "spread expansion," "late entry," "news aftermath." The `analysis` field contains the reasoning at signal time but it's plain text, never parsed post-hoc for loss attribution.

---

## Q31 (Phase 7). Top 5 realistic failure paths over 90 days unattended

1. **Price drift + stale SL/TP:** Signal at 1.0840, approved at 1.0870 (30-pip drift), SL meant to be 15 pips is now 45 pips → 3× intended risk on every approved trade
2. **Duplicate execution race condition:** Double-tap on Telegram fires two market orders for same signal → 2× position size, double risk
3. **Balance stale in lot calculation:** If OANDA balance fetch fails in scan, `balance=0`, `riskAmt=0`, `units=0`, then `units < 100` → pair skipped. Fine. But if the response returns partial data, balance could be incorrect → wrong lot size
4. **Reconciliation misses close:** More than 50 trades close during outage → orphaned EXECUTED records → daily P&L tracker never updated → limits appear to have more headroom than actual → governor allows new trades that should be blocked
5. **Trailing stop ATR stale:** Price moves 200 pips in 30 minutes. ATR was 12 pips at last scan. Trailing stop places SL 18 pips behind price (1.5×12). In volatile conditions this is hit immediately → premature trailing stop close on otherwise valid trade

---

# PHASE 8 — SECURITY, RESILIENCE & INSTITUTIONAL SURVIVABILITY

## Q1 (Phase 8). Where are API keys stored?

| Key | Storage | Encrypted? |
|---|---|---|
| OANDA API key | SQLite `storage` table, `ptp_keys` row | ❌ Plaintext |
| OpenAI key | Same SQLite row | ❌ Plaintext |
| Telegram token | Same SQLite row | ❌ Plaintext |
| Telegram chat ID | Same SQLite row | ❌ Plaintext |
| Twelve Data key | Same SQLite row | ❌ Plaintext |
| Cloudflare tokens | Not in codebase | N/A |

Secondary path: environment variables in `.env` file (plaintext on disk).

---

## Q2. Are secrets encrypted at rest?

**No. Plaintext in SQLite database file.**

`data/precisiontrader.db` contains all API keys in the `storage` table as plain JSON strings. If laptop is stolen or the database file is copied, all credentials are immediately readable with any SQLite browser.

---

## Q3. Are secrets ever exposed to frontend?

**Yes — by design.**

`loadKeys()` in frontend calls `GET /api/storage/ptp_keys` → receives JSON containing all API keys → stores in React `useState` → used directly in the browser.

The Telegram token (`tg_token`) and `tg_chat` are used in the frontend to send Telegram messages directly from the browser:
```js
async function sendTelegram(msg, keys) {
  return fetch(`https://api.telegram.org/bot${keys.tg_token}/sendMessage`, { ... });
}
```

Anyone who opens browser DevTools on the Settings page or inspects network requests can extract the OANDA key, OpenAI key, Telegram token, and Telegram chat ID.

---

## Q4. Are backend endpoints authenticated?

**No. Zero authentication on any endpoint.**

```js
app.use(cors());  // all origins allowed
app.use(express.json());
// No auth middleware
app.post('/api/autotrade/approve/:id', ...)  // accessible to anyone
app.post('/api/emergency/flatten', ...)      // accessible to anyone
app.get('/api/storage/:key', ...)            // accessible to anyone
```

Anyone on the same network as the server, or anyone who knows the Cloudflare tunnel URL, can:
- Approve or reject any pending signal
- Trigger emergency flatten (close all trades)
- Read all API keys from storage
- Change risk settings
- Enable/disable the scanner

---

## Q6. Telegram callback verification?

**Status check only — no cryptographic verification.**

```js
if (!sig || sig.status !== 'PENDING') {
  await tgAnswerCbq(cbq.id, 'Signal already processed');
  continue;
}
```

If someone crafts `callback_data: "approve_5"` and submits it via any means (replay, manual API call), the system processes it if signal 5 is PENDING. There is no HMAC secret verification of Telegram's `X-Telegram-Bot-Api-Secret-Token`.

---

## Q9. Can duplicated scanners occur?

**Yes if PM2 spawns more than one process.**

The only singleton protection is:
```js
let autoScanning = false;
if (autoScanning) return;
```

This is an in-memory flag — it dies on process restart. If PM2 restarts the server while a scan is running (crash mid-scan), `autoScanning` resets to false on the new process. Two scans cannot run simultaneously in the same process. But if PM2 forks multiple instances (misconfiguration), each instance has its own `autoScanning` flag and both will scan independently → duplicate signals.

---

## Q10. Is the database transaction-safe?

**Partially — WAL mode enabled, but no explicit transaction wrapping.**

```js
db.pragma('journal_mode = WAL');
```

WAL mode protects against corruption from crash during write. Individual `db.prepare().run()` calls are atomic. But sequences like:
```
INSERT INTO signals ...
UPDATE signals SET tg_message_id=? ...
```
Are NOT wrapped in a transaction. If crash occurs between them, signal exists without tg_message_id. Not catastrophic but inconsistent state.

The reconciliation update (multiple fields) uses a single UPDATE statement → atomic.

---

## Q38 (Phase 8). OANDA fills order but API response lost

**Most dangerous scenario — ghost position:**

```js
const r = await axios({ ... });
// If timeout fires after OANDA sent order but before response arrives:
// catch block runs → status = 'FAILED'
// But OANDA has a live trade open
```

In `oandaRequest()`, if the request times out at 12 seconds, `oandaFailCount++` and the catch block fires. The order may or may not have been received by OANDA. If it was received, OANDA has an open position. Local DB says FAILED.

Reconciliation only matches by `trade_id`, which was never stored. The ghost position will never be reconciled. It will be open on OANDA indefinitely until manually closed. The local system believes it has no position.

This is the single most dangerous technical failure mode in the system.

---

## Q40 (Phase 8). Worst-case realistic catastrophic failure today

**Scenario: Network timeout during execution of a max-size gold position.**

1. XAUUSD signal approved. Units = 50 oz (typical for $5K account, 1% risk, 50-pip SL)
2. `oandaRequest()` sends order. OANDA receives and fills it.
3. Network drops for 12 seconds. `oandaRequest()` times out.
4. `catch(e)` → status = 'FAILED'
5. System believes no position exists
6. Scanner runs 5 minutes later. Same conditions → new signal generated
7. User approves again (thinking first attempt failed)
8. Second execution: OANDA has 2× XAUUSD positions now
9. Price moves 200 pips against → both positions lose → 4× intended risk
10. No duplicate detection. No ghost position detection.

---

# PHASE 9 — INSTITUTIONAL QUANT GOVERNANCE & CAPITAL SCALING

## Q1 (Phase 9). What exactly is the edge?

The honest edge hypothesis:

> **"Multi-timeframe EMA trend continuation signals with institutional structure filters, entered after pullback to value (EMA21 proximity), in trending market regimes during high-liquidity sessions, produce asymmetric reward:risk because the trend's continuation probability exceeds 50% when all timeframes align directionally."**

This is a classic trend-following edge. Its validity depends on: markets trending more than they range (true historically ~40% of the time for major forex pairs), and the multi-TF filter being selective enough to isolate those trending periods.

---

## Q2 (Phase 9). Which condition destroys the edge fastest?

**Rotational range-bound markets and post-news whipsaw.**

When central banks switch between tightening and easing without commitment, EUR/USD can range 100 pips for weeks. All EMA alignments appear then disappear. The EMA slope filter and ADX check should catch this — but the transition period (regime changing from trending to ranging) will produce losses before the filters adapt.

---

## Q5 (Phase 9). Which session produces best quality? (Hypothesis only — no data)

| Session | Expected Quality | Reasoning |
|---|---|---|
| London Open (07:00–09:00 UTC) | HIGH | Institutional participation begins, trends establish |
| London Mid (09:00–12:00) | HIGH | Peak liquidity, cleanest trends |
| NY Open (12:00–15:00) | HIGH | Second liquidity surge, continuation of London moves |
| NY Afternoon (15:00–17:00) | MEDIUM | Profit-taking begins, direction less reliable |

*No statistical evidence from actual closed trades yet.*

---

## Q16 (Phase 9). Current sizing model?

**Fixed fractional risk with adaptive scaling:**

```
units = floor(balance × risk_pct/100 ÷ (slPips × pipVal) × sizeFactor)
```

Where `sizeFactor` = min(lossFactor, timeFactor).

Not volatility-normalized. EUR/USD with ATR 70 pips and GBP/JPY with ATR 200 pips receive the same risk percentage but different pip values. This means ATR-normalized risk is implicit (larger ATR = wider SL = fewer units) but pip value adjustment is approximate.

---

## Q19 (Phase 9). Can correlated exposure exceed intended risk?

**Yes — three gaps:**

1. XAU/USD is excluded from USD correlation tracking
2. No inter-pair correlation beyond USD direction (e.g., EUR/USD and EUR/GBP are 60% correlated but EUR/GBP is not scanned)
3. Post-execution size changes (manual trade on broker) not tracked

---

## Q22 (Phase 9). Maximum leverage possible today?

**Theoretical maximum with current constraints:**

- Max 3 signals/day
- 1% risk per trade default
- Max 2 correlated USD trades
- Portfolio heat CRITICAL at >5% total

Worst case (3 simultaneous trades, all at 2% risk): 6% total exposure. At OANDA's 1:30 leverage (EU retail) or 1:50 (non-EU), 6% capital × 50× leverage = 300% gross position exposure.

In practice with 1% × 3 trades = 3% total risk → manageable. But the **max** depends on `risk_pct` setting which has no hard upper bound validation (only UI max=5).

---

## Q23 (Phase 9). How many trades before trusting metrics?

**Statistical minimums:**

| Metric | Minimum trades | Notes |
|---|---|---|
| Win rate | 50+ | ±14% confidence interval at 50 trades, 95% CI |
| Expectancy | 100+ | Must cross zero with statistical significance |
| Per-pair win rate | 50+ per pair | Need 300+ total for meaningful 6-pair breakdown |
| Confidence calibration | 50+ per confidence bucket | 85–90% signals need 50 trades to verify |
| Session performance | 30+ per session | Need 120+ for London/NY split |

**Current status: 0 closed trades from the automated system.** All metrics are theoretical.

---

## Q26 (Phase 9). Walk-forward validation exists?

**Yes — in backtest engine only.**

`/api/backtest` implements walk-forward: it trains indicators on historical data up to bar `i`, never looking ahead. This is correct walk-forward methodology.

But: the system has not been run through a multi-month out-of-sample test on known data. The backtest only covers periods the user explicitly requests. No automated ongoing walk-forward monitoring.

---

## Q36 (Phase 9). What role SHOULD AI play?

**Validator + regime classifier. Not oracle.**

Current role (validator) is correct. Future ideal: AI as regime classifier (using news context, macro narrative, time-of-year patterns not in technical indicators) that can reduce confidence in technically valid setups when macro context is contradictory.

AI should NEVER: override hard risk governors. Generate its own trade ideas from scratch. Auto-approve without human in the loop. Modify lot sizes.

---

## Q38 (Phase 9). What layer is currently overbuilt?

**The number of pre-scan filters relative to statistical evidence.**

15 sequential filters with zero historical performance data to justify each one. Filters may be rejecting valid trades that would have won, or catching invisible risk — no way to know without data. The architecture is sound in theory but cannot be optimized without actual trade outcomes.

---

## Q39 (Phase 9). What layer is dangerously underbuilt?

**Post-trade intelligence and price-drift-at-execution.**

The system generates excellent pre-trade analysis but has almost no post-trade learning capability. Combined with the stale SL/TP at execution gap, this is the highest-risk combination: entries occur at incorrect risk, and the system cannot learn from the pattern.

---

# PHASE 10 — INSTITUTIONAL OPERATIONS, HUMAN FAILURE & LONG-TERM EVOLUTION

## Q1 (Phase 10). Most dangerous manual action currently possible?

**Changing `risk_pct` from 1% to 10%, then approving 3 correlated signals before changing it back.**

The risk governor blocks at trade-level, but lot size is calculated in the scan using the stored risk_pct. If you change it to 10% before a scan, the next scan will calculate lots at 10× normal size. All three daily signals could be sent with 10% risk each = 30% total exposure before circuit breaker fires.

No confirmation dialog. No rate limiting on settings changes. No audit log.

---

## Q2 (Phase 10). Can operator bypass protections?

**Yes — multiple paths:**

1. Change `risk_pct` setting → immediate effect on next scan lot calculation
2. Change `min_score` to 1 → every scan produces signals
3. Change `threshold` to 10% → AI always passes
4. Disable scanner → re-enable immediately after circuit breaker fires (circuit breaker resets with fresh scan data if a winner was recorded)
5. Use `POST /api/autotrade/approve/:id` directly → governors still run, cannot bypass those
6. Edit SQLite database directly → can set any signal to PENDING, change `realized_pl` to positive, clear consecutive losses

---

## Q5 (Phase 10). Are operator mistakes separated from strategy mistakes?

**No.** All executed signals go into the same analytics pool regardless of whether they were approved by the system normally or forced through unusual circumstances. A trade approved despite a spread warning, or approved on a day after manual settings change, is indistinguishable from a clean system signal in the performance stats.

---

## Q8 (Phase 10). How are new features introduced?

**Directly into production. No staging environment.**

The workflow has been:
- Write code → build → `pm2 restart` → live in production

No sandbox environment. No paper trading mode (signals are logged but only actually executed when OANDA key is configured and scanner enabled). No A/B testing. No shadow mode where new logic runs alongside old logic.

---

## Q11 (Phase 10). Is there feature rollback capability?

**Via git only.**

```bash
git checkout previous_commit server.js
pm2 restart precisiontrader-pro
```

No versioned strategy parameters. No feature flags. If adaptive weighting is added later and becomes unstable, rollback requires a full deploy of previous code.

---

## Q14 (Phase 10). Are config changes tracked?

**No.** There is no audit log of when settings changed, who changed them, or what the previous value was. The `storage` table stores the current value with an `updated_at` timestamp — but no history of prior values.

---

## Q29 (Phase 10). Can audit history be tampered with?

**Yes, easily.** The SQLite database has no cryptographic integrity. Any user with file system access can:
- Delete signal records
- Edit `realized_pl` values to show positive performance
- Remove losing trades from the database
- Change `exit_reason` from SL_HIT to TP_HIT

There is no immutable audit layer. No cryptographic signatures. No append-only log.

---

## Q40 (Phase 10). What is the REAL bottleneck now?

**Zero closed trades = zero evidence.**

Every architectural decision, every filter threshold, every confidence weight, every ADX cutoff is currently theoretical. The system cannot be improved, optimized, or trusted until it has enough closed trade history to distinguish:
- Filters that are genuinely useful vs filters that just reduce frequency
- True edge vs survivorship bias in parameter selection
- Sessions/pairs/regimes that actually outperform vs those assumed to

The real bottleneck is not code quality (high), not risk governance (solid), not AI sophistication (reasonable) — it is the absence of real performance data.

---

## Q41 (Phase 10). If this succeeds long-term, WHY?

**Exceptional rejection discipline.**

The system's genuine strength is that it was built from the beginning with the philosophy of rejecting bad trades rather than finding more trades. The 15-gate pipeline, the ADX/regime filters, the session restrictions, the news blackouts — these do not generate alpha. They prevent alpha destruction. If the underlying trend-following edge is real (which historically it is for major forex pairs in trending conditions), this system's strict filtering should deliver a higher percentage of that edge than a looser system.

---

## Q42 (Phase 10). If this fails long-term, WHY?

**Overfitting via complexity with insufficient data.**

The system has ~20+ parameters that control signal generation (ADX thresholds, RSI zones, EMA slope cutoffs, confidence thresholds, score minimums, ATR multipliers). Each was set based on logic, not statistical evidence from this system's actual trades. Adding more intelligence layers (regime detection, compression, momentum weakening) increases the risk that the system is pattern-matching to theoretical market behavior rather than proven statistical edge.

A simpler system with fewer parameters, run long enough to accumulate statistical significance, would be more honest about its actual edge than a complex system that looks sophisticated but has never been validated on real outcomes.

The second failure mode: **operator interference.** The approval workflow creates a human bottleneck that introduces behavioral bias. Bad weeks → more conservative approvals → misses winners. Good streaks → overconfident approvals → takes marginal setups. No mechanism prevents or detects this.

---

# FINAL CLASSIFICATION

Based on this complete audit:

| Dimension | Score | Verdict |
|---|---|---|
| Data pipeline integrity | 6/10 | NaN propagation, no gap validation, stale execution |
| Indicator accuracy | 7/10 | EMA200 underhistory, approximate ADX, no structure |
| Signal quality filters | 9/10 | 15 gates, regime detection, momentum checks |
| AI layer | 6/10 | Non-deterministic, unlogged, no memory |
| Execution quality | 5/10 | No price refresh, race condition, ghost position risk |
| Risk governance | 8/10 | Comprehensive limits, circuit breakers, portfolio heat |
| Trade lifecycle | 7/10 | Good reconciliation, missing MAE/MFE, no causal learning |
| Security | 3/10 | No auth, plaintext keys, full frontend exposure |
| Statistical maturity | 1/10 | Zero closed trades from system |
| Operational resilience | 5/10 | PM2 recovery good, no sandbox, no audit trail |

**Current Classification: AI-Assisted Trading Framework**

Not yet: Quantitative Risk Platform (requires statistical evidence base)
Not yet: Institutional-Grade Autonomous Engine (requires auth, audit trail, validated edge)
Not: Retail Signal Bot (architecture is well beyond retail)

The intelligence architecture is genuinely institutional-grade. The operational and security layer is not. The statistical foundation does not exist yet.

**Priority order for next phases:**
1. Fix ghost position risk (Q38 Phase 8) — catastrophic failure risk
2. Add price drift validation at execution — most consistent risk
3. Add backend authentication — security prerequisite for any scaling
4. Encrypt keys at rest — basic security hygiene
5. Accumulate 100+ closed trades — cannot improve what cannot be measured

---

*Document generated 2026-05-29 | PrecisionTraderPro v2 | All answers sourced from server.js, db.js, PrecisionTraderPro.jsx | No assumptions or extrapolations*
