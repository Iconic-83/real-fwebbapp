# PrecisionTraderPro — Full System Audit
**Date:** 2026-05-28
**Version:** server.js v2 (PM2 + Cloudflare tunnel)
**Status:** Live on local machine | 7 signals generated | 5 executed | 0 P&L recorded

---

## SECTION 1 — CORE EXECUTION

### Q1. Execution Mode?
**HYBRID**

The scanner auto-detects signals every 5 minutes. When a signal passes all filters, it is sent to Telegram with two inline buttons:
- ✅ APPROVE → OANDA executes the trade immediately
- ❌ REJECT → Signal logged, no trade placed

Zero auto-execution without human approval. You are always in the loop.

**Code reference:** `server.js:1177` — `executeSignal()` is only called on user APPROVE tap.

---

### Q2. Spread / Slippage / Latency Detection Before Execution?
**NO — None of these exist.**

`executeSignal()` fires a market order directly with no:
- Spread spike check
- Slippage protection
- Broker latency measurement
- Pre-trade quote validation

This is a real gap. A wide spread at news time could result in a worse fill than expected.

---

### Q3. If OANDA Fails?
**Stops safely. No retry. No fallback broker.**

`oandaRequest()` tries practice API first, then live API. If both fail:
- Throws `Error: OANDA unreachable`
- Signal is marked `FAILED` in the database
- Telegram is notified with the failure reason
- System does not retry or attempt another provider

**Code reference:** `server.js:74–93`

---

### Q4. Broker State ≠ Local Database — Automatic Reconciliation?
**NO.**

The system never pulls trade outcomes from OANDA back into the local database. Evidence: all 5 executed signals have `realized_pl = null` in the database right now. The system placed the trades but never confirmed what happened to them.

---

### Q5. Partial TPs / Trailing Stops / Breakeven / Dynamic Sizing?

| Feature | Status |
|---------|--------|
| Trailing stops | ✅ YES — runs every 30s |
| Breakeven logic | ✅ YES — SL moves to entry +3 pips at +1:1 profit |
| Trailing at +1.5:1 | ✅ YES — trails at 1.5×ATR behind price |
| Partial take profits | ❌ NO — single TP only |
| Dynamic position sizing | ✅ YES — from real account balance × risk % |

**Code reference:** `server.js:466–528` (`runTrailingStops`)

---

## SECTION 2 — MARKET INTELLIGENCE

### Q6. What Market States Can the AI Detect?

| Market State | Status | How |
|---|---|---|
| Trending | ✅ YES | ADX ≥ 20 on H4 |
| Ranging | ✅ PARTIAL | ADX < 20 → −12 confidence penalty, EMA mixed → signal skipped |
| Prime session | ✅ YES | London/NY only (07:00–17:00 UTC) |
| News chaos | ✅ YES | ±45 min blackout around HIGH-impact events |
| Volatile | ❌ NO | Not detected |
| Low liquidity | ❌ NO | Not detected |
| Accumulation/Distribution | ❌ NO | Not detected |

---

### Q7. Does the Scanner Analyze Multi-TF / Liquidity / Order Blocks / FVG?

| Feature | Status |
|---|---|
| Multi-timeframe structure (H4→H2→M30→M5) | ✅ YES |
| Session timing (London/NY) | ✅ YES |
| Liquidity sweeps | ❌ NO |
| Order blocks | ❌ NO |
| Imbalance / Fair Value Gaps (FVG) | ❌ NO |

---

### Q8. Can the System Detect When NOT to Trade?
**YES — this is the strongest part of the system.**

A signal is rejected unless ALL of the following pass:
1. H4 EMA fully aligned (not mixed)
2. H4 ADX ≥ 20 (not ranging)
3. No HIGH-impact news within ±45 minutes
4. M30 RSI not in extreme zone (not overbought/oversold)
5. Price not overextended beyond H4 EMA21 by >0.8%
6. Active trading session (07:00–17:00 UTC)
7. Score ≥ 9 out of 12 checks
8. Both calc engine AND GPT-4o must agree on direction

The system rejects far more than it fires. That is by design.

---

### Q9. How Is Confidence Calculated?
**Static rule-based weighted formula. Not adaptive. Not historical.**

Process:
1. Starts at the weighted 12-check score percentage
2. Fixed point adjustments applied:
   - +8 if all 3 timeframes trend-aligned
   - +7 if ADX ≥ 25 (strong trend)
   - −12 if ADX < 20 (ranging)
   - +8 if price above EMA200 in direction
   - −12 if trading against EMA200
   - +7 if price very close to H4 EMA21 (ideal pullback)
   - +5 if RSI in ideal entry zone
   - +5 if strong M5 reversal pattern
   - +4 if MACD confirms
3. Capped at 95% (never 100%)

The formula is identical on every scan. Historical trade outcomes do not influence it.

---

### Q10. Does the System Learn from Winning/Losing Trades?
**NO.**

Trades are logged in SQLite. Statistics are displayed in the journal. But zero feedback goes back into the scoring weights. If the system loses 10 trades in a row, trade 11 uses the exact same formula with the exact same weights.

---

## SECTION 3 — STATISTICAL VALIDATION

### Q11. How Many Closed Paper Trades Are Stored Right Now?
**7 signals total. 5 executed. 0 with P&L recorded.**

| ID | Pair | Direction | Confidence | Score | Status |
|----|------|-----------|-----------|-------|--------|
| 1 | GBP/USD | BUY | 85% | — | EXECUTED |
| 2 | USD/JPY | SELL | 80% | — | EXECUTED |
| 3 | EUR/USD | BUY | 85% | — | EXECUTED |
| 4 | GBP/USD | BUY | 95% | 9/12 | PENDING |
| 5 | USD/CAD | BUY | 95% | 9/12 | EXECUTED |
| 6 | USD/JPY | BUY | 90% | 10/12 | EXECUTED |
| 7 | USD/CAD | BUY | 90% | 10/12 | PENDING |

The system never fetched what happened to the 5 executed trades from OANDA. `realized_pl` is null on all of them.

---

### Q12. Does the Expectancy Engine Stay Positive Consistently?
**Unknown. No outcome data exists to calculate this.**

Expectancy = (Win Rate × Avg Win) − (Loss Rate × Avg Loss)

This cannot be computed with zero completed trade outcomes.

---

### Q13. Can the System Prove Higher Scores = Higher Win Probability?
**Unproven on live data.**

The backtest engine exists (`/api/backtest`) and can test this hypothesis on historical OANDA candle data. But it has not been run with enough data to make a statistically valid claim.

---

### Q14. Monte Carlo / Drawdown Projections / Risk-of-Ruin?

| Feature | Status |
|---|---|
| Basic drawdown in pips (backtest) | ✅ YES |
| Equity curve in backtest | ✅ YES |
| Monte Carlo simulation | ❌ NO |
| Drawdown projections (live) | ❌ NO |
| Risk-of-ruin analysis | ❌ NO |

---

### Q15. Does Adaptive Weighting Run?
**DISABLED.**

All weights are hardcoded constants in `scoreSignal()` and `calcTradeSetup()`. No live, shadow, or partial adaptive mode is implemented.

---

## SECTION 4 — AI ARCHITECTURE

### Q16. Which AI Handles What?

| Function | Handler |
|---|---|
| Signal scoring (12 checks) | Rule-Based Calc Engine |
| Confidence calculation | Rule-Based Calc Engine |
| SL/TP calculation | Rule-Based Calc Engine |
| Final signal validation | GPT-4o (if OpenAI key configured + calc ≥ 80%) |
| Manual chart analysis | GPT-4o (`/api/ai/analyze`) |
| Analytics / journaling | Manual stats (no AI) |
| Claude (Anthropic SDK) | Imported but **never called** — dead import |

---

### Q17. AI Provider Fallback Routing?
**Partial.**

- If GPT-4o throws an error → falls back to calc engine result automatically
- If GPT-4o returns NEUTRAL or disagrees with direction → signal is **rejected** (not fallen back)
- No GPT-3.5 fallback
- No Claude fallback
- No Groq fallback

**Code reference:** `server.js:1378–1381`

---

### Q18. Can the AI Explain Its Decisions?
**YES.**

Both engines produce full human-readable explanations:
- Calc engine: multi-line breakdown of all 4 timeframes, ADX, RSI, EMA alignment, S/R levels
- GPT-4o: 6-line structured validation with bias, confidence, SL, TP, R:R
- Every signal stores the full analysis text in the database

---

### Q19. Are All AI Decisions Logged / Auditable / Replayable?
**YES — logged. Partially auditable. Not replayable.**

- Full `analysis` text stored in `signals` table for every signal
- Pass/fail result for each of the 12 checks stored
- Signal history accessible via `/api/autotrade/log`
- NOT replayable: candle data at the time of signal is not stored, so you cannot exactly reproduce the signal calculation later

---

### Q20. Can the System Compare Baseline vs Adaptive vs Shadow AI?
**NO.**

Single pipeline only. No variant tracking, no A/B comparison, no shadow mode running in parallel.

---

## SECTION 5 — RISK ENGINE

### Q21. Maximum Daily Drawdown Allowed?
**3% is defined. It is NOT enforced.**

The limit is calculated as `balance × 0.03` and displayed via `/api/trade/daily`. However, `executeSignal()` — the function that actually places trades — never calls this check. You can blow through the 3% limit and the system will keep executing approved signals.

**Code reference:** `server.js:824–854` (defined) vs `server.js:1104–1145` (executeSignal — no limit check)

---

### Q22. Does the System Stop After Loss Clusters / Volatility / News?

| Trigger | Status |
|---|---|
| News blackout ±45 min | ✅ YES — blocks new signals |
| Abnormal spreads | ❌ NO |
| Volatility spikes | ❌ NO |
| Loss cluster (e.g. 3 losses in a row) | ❌ NO |
| Manual disable via settings | ✅ YES — scanner can be turned off |

---

### Q23. Dynamic Reduction of Lot Size / Frequency During Bad Performance?
**NO.**

Fixed 1% risk per trade regardless of recent performance. After 3 consecutive losses, trade 4 still risks 1%. No performance-based scaling exists.

---

### Q24. Correlated Risk — Multiple USD Trades Simultaneously?
**NO protection.**

The system has a max 3 signals/day cap but no instrument correlation check. It is possible to have:
- EUR/USD BUY
- GBP/USD BUY
- AUD/USD BUY

All three running at once = tripling USD exposure, but the system treats them as independent 1% risks.

---

### Q25. Protection Against Revenge Trading / Overtrading / Confidence Drift?

| Protection | Status |
|---|---|
| Max 3 signals per day | ✅ YES |
| Cooldown after a loss | ❌ NO |
| Pause after X consecutive losses | ❌ NO |
| Confidence drift detection | ❌ NO |
| Adaptation instability guard | ❌ NO |

---

## SECTION 6 — INFRASTRUCTURE

### Q26. Where Is the System Hosted?
**Local laptop + PM2 + Cloudflare tunnel.**

- Process manager: PM2 (keeps server alive after crashes)
- Public access: Cloudflare quick tunnel (URL changes on every restart)
- PM2 startup on reboot: **NOT configured**
- If laptop shuts down: entire system stops

---

### Q27. If Internet Disconnects — What Happens?
- **Open trades:** Safe. They exist on OANDA's servers and will run to SL/TP independently.
- **Trailing stop monitor:** Pauses until reconnected.
- **New signals:** Stop until reconnected.
- **Telegram callbacks:** Stop — APPROVE/REJECT buttons won't work.
- **Tunnel:** Auto-restarts when internet returns (tunnel.sh while-loop), but URL changes.

---

### Q28. Automatic Backups / Database Snapshots / Recovery?
**NO.**

- Database: `data/precisiontrader.db` (SQLite, single file)
- No cron backup
- No offsite copy
- No snapshot system
- One corrupted or deleted DB file = complete loss of all signals, keys, and settings

---

### Q29. Can the System Run 24/7 Without Your Laptop Being Open?
**NO.**

This is the most critical infrastructure gap. The system requires your laptop to remain powered on and connected. `pm2 startup` has not been configured, so a system reboot kills everything.

---

### Q30. Monitoring / Uptime Alerts / Error Tracking / Performance Telemetry?

| Feature | Status |
|---|---|
| PM2 process monitoring (local) | ✅ YES |
| PM2 logs | ✅ YES |
| External uptime alerts | ❌ NO |
| Error tracking (Sentry etc.) | ❌ NO |
| Performance telemetry | ❌ NO |
| Alert if server crashes | ❌ NO |

You would only know the system crashed by manually checking.

---

## SECTION 7 — REAL PROFESSIONAL QUESTIONS

### Q31. Real Current Win Rate?
**Unknown — 0% of trade outcomes are recorded.**

5 trades executed. `realized_pl = null` on all of them. The system placed orders but never checked back to see if they hit SL or TP.

---

### Q32. Real Average R:R?
**Unknown.**

No closed trade data with outcomes exists in the database to calculate this.

---

### Q33. Largest Drawdown Observed?
**Unknown.**

Cannot be calculated with zero recorded P&L values.

---

### Q34. Does the System Make Money Because Edge Exists or Market Temporarily Favorable?
**Cannot be answered yet.**

You need a minimum of 30–50 completed trades with recorded outcomes before this question has a meaningful answer. The backtest engine exists and can run simulations, but live validation is zero.

---

### Q35. If Volatility Completely Changes Tomorrow — Will the System Adapt?
**NO.**

- No market regime detection beyond ADX
- No volatility regime switching
- Fixed weights regardless of market conditions
- If market shifts from strongly trending to choppy ranging, the system will continue generating signals — they will just fail more often, with the same confidence scores

---

## FINAL QUESTION — Q36: What Protects Capital If AI Is Wrong for 2 Weeks Straight?

**Honestly: very little right now.**

### What DOES protect capital:
| Protection | Value |
|---|---|
| Max 3 signals/day | Limits frequency |
| 1% risk per trade | Limits per-trade loss |
| 9/12 score filter | Reduces low-quality signals |
| Manual APPROVE required | Human override on every trade |

### What is MISSING:
| Missing | Impact |
|---|---|
| Daily loss limit NOT enforced in execution | Could lose >3% in one day |
| No consecutive loss circuit breaker | System keeps firing after 5/6/7 losses |
| No correlated risk check | 3 USD trades = 3× real exposure |
| No adaptive lot size reduction | Same risk on trade 10 as trade 1 |
| No weekly/monthly drawdown kill switch | No automatic full stop |

**Worst-case scenario with current system:**
2 weeks of bad signals, you approve a few, each loses 1%. No automatic stop engages. If correlated (3 USD pairs simultaneously), real loss per day could be 3%. Over 10 trading days = potential 30% drawdown with no circuit breaker firing.

---

## PRIORITY FIX LIST

| Priority | Fix | Effort |
|---|---|---|
| 🔴 CRITICAL | Move to VPS for true 24/7 operation | Medium |
| 🔴 CRITICAL | Enforce daily loss limit inside `executeSignal()` | 30 min |
| 🔴 CRITICAL | Fetch & record trade outcomes from OANDA (realized_pl) | 1 hour |
| 🔴 CRITICAL | Consecutive loss circuit breaker (pause after 3 losses) | 1 hour |
| 🟠 HIGH | Correlated risk check before execution | 1 hour |
| 🟠 HIGH | Automatic DB backup (daily cron) | 30 min |
| 🟠 HIGH | Configure `pm2 startup` for reboot survival | 15 min |
| 🟡 MEDIUM | Spread check before execution | 45 min |
| 🟡 MEDIUM | Run backtest to validate score vs win-rate hypothesis | 1 hour |
| 🟡 MEDIUM | Weekly drawdown kill switch | 1 hour |

---

*Generated by code audit — all answers verified against server.js source, not assumptions.*
