import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PAIRS = ["EUR_USD","GBP_USD","USD_JPY","XAU_USD","AUD_USD","USD_CAD"];
const PAIR_LABELS = { EUR_USD:"EURUSD", GBP_USD:"GBPUSD", USD_JPY:"USDJPY", XAU_USD:"XAUUSD", AUD_USD:"AUDUSD", USD_CAD:"USDCAD" };
const NAV = [
  { id:"dashboard",     label:"Dashboard",      icon:"⬡" },
  { id:"opportunities", label:"Opportunities",  icon:"◈" },
  { id:"trading",       label:"Live Trading",   icon:"⚡" },
  { id:"charts",        label:"Charts",         icon:"◻" },
  { id:"journal",       label:"Journal",        icon:"▤" },
  { id:"news",          label:"News Calendar",  icon:"◉" },
  { id:"alerts",        label:"Alerts",         icon:"◬" },
  { id:"ai",            label:"AI Insights",    icon:"✦" },
  { id:"analytics",     label:"Analytics",      icon:"▦" },
  { id:"backtest",      label:"Backtest",       icon:"⏪" },
  { id:"settings",      label:"Settings",       icon:"⊙" },
];

// ─── STORAGE API  (backend SQLite — persistent across devices) ────────────────
async function storageGet(key) {
  try {
    const r = await fetch(`/api/storage/${key}`);
    const d = await r.json();
    return d.value ? JSON.parse(d.value) : null;
  } catch { return null; }
}
async function storageSet(key, value) {
  try {
    await fetch(`/api/storage/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
  } catch {}
}

async function loadKeys()           { return (await storageGet("ptp_keys")) || {}; }
async function saveKeys(k)          { await storageSet("ptp_keys", k); }
async function loadJournalNotes()   { return (await storageGet("ptp_journal_notes")) || {}; }
async function saveJournalNotes(n)  { await storageSet("ptp_journal_notes", n); }
async function loadPriceAlerts()    { return (await storageGet("ptp_price_alerts")) || []; }
async function savePriceAlerts(a)   { await storageSet("ptp_price_alerts", a); }

// ─── BACKEND API HELPERS ──────────────────────────────────────────────────────
// All real API calls go through the Express backend (keys are server-side)

async function oandaFetch(path, opts = {}) {
  // Proxy OANDA through backend — keys never exposed to browser
  const r = await fetch(`/api/oanda${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (r.ok) return r.json();
  const err = await r.json().catch(() => ({}));
  throw new Error(err.errorMessage || err.error || "OANDA request failed");
}

async function fetchPrices() {
  const r = await fetch("/api/prices");
  if (!r.ok) throw new Error("Price fetch failed");
  return r.json();
}

async function sendTelegram(msg, keys) {
  if (!keys.tg_token || !keys.tg_chat) return;
  return fetch(`https://api.telegram.org/bot${keys.tg_token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: keys.tg_chat, text: msg, parse_mode: "HTML" }),
  });
}

async function getPositionSize(pair, entry, stopLoss, riskPct) {
  const r = await fetch("/api/trade/size", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pair, entryPrice: entry, stopLossPrice: stopLoss, riskPercent: riskPct }),
  });
  return r.json();
}

async function getDailyStatus() {
  const r = await fetch("/api/trade/daily");
  return r.json();
}

async function recordPL(pl) {
  await fetch("/api/trade/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pl }),
  });
}

async function aiAnalyze(pairLabel, price, systemContext = "") {
  const r = await fetch("/api/ai/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pair: pairLabel, price, systemContext }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return { analysis: d.analysis || "No analysis returned.", indicators: d.indicators || null };
}

async function fetchNewsCalendar() {
  const r = await fetch("/api/news");
  if (!r.ok) throw new Error("News fetch failed");
  return r.json();
}

// ─── HOOKS ────────────────────────────────────────────────────────────────────
function useOanda(keys) {
  const [account, setAccount] = useState(null);
  const [trades, setTrades] = useState([]);
  const [connected, setConnected] = useState(false);

  const load = useCallback(async () => {
    if (!keys.oanda_key || !keys.oanda_account) return;
    try {
      const [a, t] = await Promise.all([
        oandaFetch(`/v3/accounts/${keys.oanda_account}/summary`),
        oandaFetch(`/v3/accounts/${keys.oanda_account}/openTrades`),
      ]);
      setAccount(a?.account || null);
      setTrades(t?.trades || []);
      setConnected(true);
    } catch { setConnected(false); }
  }, [keys.oanda_key, keys.oanda_account]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  return { account, trades, connected, refresh: load };
}

function useTwelve(keys) {
  const [prices, setPrices] = useState({});
  const [connected, setConnected] = useState(false);
  const prevPrices = useRef({});

  const load = useCallback(async () => {
    if (!keys.twelve_key) return;
    try {
      const d = await fetchPrices();
      const m = {};
      PAIRS.forEach(p => {
        const s = p.replace("_", "/");
        const v = d[s]?.price;
        if (v) m[p] = parseFloat(v);
      });
      if (Object.keys(m).length > 0) {
        prevPrices.current = { ...prices };
        setPrices(m);
        setConnected(true);
      }
    } catch { setConnected(false); }
  }, [keys.twelve_key]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  return { prices, prevPrices: prevPrices.current, connected };
}

// ─── UI ATOMS ────────────────────────────────────────────────────────────────
const S = {
  card:  { background:"#0b0b1f", border:"1px solid #13132b", borderRadius:12, padding:"15px 17px" },
  title: { fontSize:10, color:"#2a2a4a", letterSpacing:3, textTransform:"uppercase", marginBottom:12, fontWeight:800 },
  ph:    { fontSize:17, fontWeight:800, color:"#ccc", letterSpacing:3, marginBottom:18, textTransform:"uppercase" },
  badge: { display:"inline-block", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:800, letterSpacing:1 },
  btn:   { padding:"8px 18px", borderRadius:8, cursor:"pointer", fontSize:12, fontWeight:700, letterSpacing:1, border:"none" },
  lbl:   { display:"block", fontSize:10, color:"#333", textTransform:"uppercase", letterSpacing:2, marginBottom:4, fontWeight:700 },
  inp:   { display:"block", width:"100%", background:"#07071a", border:"1px solid #13132b", borderRadius:8, padding:"9px 12px", color:"#bbb", fontSize:13, fontFamily:"monospace", outline:"none", boxSizing:"border-box" },
};

function Pill({ ok, label }) {
  return (
    <span style={{ fontSize:10, padding:"3px 9px", borderRadius:20, background:ok?"#003322":"#1a0a0a", color:ok?"#00ff88":"#ff4466", border:`1px solid ${ok?"#00ff8833":"#ff446633"}`, letterSpacing:1 }}>
      ⬤ {label}
    </span>
  );
}

function Sparkline({ data, color = "#00ff88" }) {
  const w = 70, h = 26;
  if (!data || data.length < 2) return <svg width={w} height={h} />;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 0.0001;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - mn) / rng) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ overflow:"visible" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function PriceRow({ pair, prices, prevPrices = {}, alertPrices = [], onSetAlert }) {
  const [hist, setHist] = useState([]);
  const p = prices[pair];
  useEffect(() => { if (p) setHist(h => [...h.slice(-18), p]); }, [p]);
  const up = hist.length > 1 ? hist[hist.length - 1] >= hist[hist.length - 2] : true;
  const dp = pair === "XAU_USD" ? 2 : 5;
  const hasAlert = alertPrices.some(a => a.pair === pair && a.active);
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid #0d0d1e" }}>
      <div style={{ minWidth:58, fontSize:12, fontWeight:800, color:"#bbb" }}>{PAIR_LABELS[pair]}</div>
      <Sparkline data={hist} color={up ? "#00ff88" : "#ff4466"} />
      <div style={{ fontFamily:"monospace", fontSize:12, color:up?"#00ff88":"#ff4466", minWidth:82, textAlign:"right" }}>
        {p ? p.toFixed(dp) : "—"}
      </div>
      {onSetAlert && (
        <div onClick={() => onSetAlert(pair, p)} title="Set price alert"
          style={{ cursor:"pointer", fontSize:11, color:hasAlert?"#ffcc00":"#1a1a30", marginLeft:"auto" }}>◬</div>
      )}
    </div>
  );
}

function MiniChart({ data, width = 120, height = 40, color = "#00ccff" }) {
  if (!data || data.length < 2) return <div style={{ width, height, background:"#07071a", borderRadius:4 }} />;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 0.001;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - mn) / rng) * (height - 4) + 2}`).join(" ");
  const fill = `${pts} ${width},${height} 0,${height}`;
  return (
    <svg width={width} height={height} style={{ display:"block" }}>
      <defs>
        <linearGradient id={`g${color.replace("#","")}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fill} fill={`url(#g${color.replace("#","")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function Dashboard({ account, trades, prices, prevPrices, oConn, tConn, aiReady, priceAlerts, onSetAlert }) {
  const pl = account ? parseFloat(account.unrealizedPL) : 0;
  const [plHistory, setPlHistory] = useState([]);
  const [risk, setRisk]           = useState(null);
  const [infra, setInfra]         = useState(null);
  const [flattening, setFlattening] = useState(false);

  useEffect(() => { if (account) setPlHistory(h => [...h.slice(-30), pl]); }, [pl]);

  useEffect(() => {
    const load = async () => {
      const [r, h] = await Promise.all([
        fetch("/api/risk/status").then(x => x.json()).catch(() => null),
        fetch("/api/health").then(x => x.json()).catch(() => null),
      ]);
      if (r && !r.error) setRisk(r);
      if (h && h.infrastructure) setInfra(h.infrastructure);
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const doFlatten = async () => {
    if (!window.confirm("EMERGENCY: Close ALL open positions and disable scanner?")) return;
    setFlattening(true);
    try {
      const r = await fetch("/api/emergency/flatten", { method:"POST" }).then(x => x.json());
      alert(`Flatten complete. Closed: ${r.closed} position(s).`);
    } catch { alert("Flatten failed — check Telegram"); }
    setFlattening(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ ...S.card, display:"flex", gap:12, padding:"10px 15px", flexWrap:"wrap", alignItems:"center" }}>
        <Pill ok={oConn}   label="OANDA" />
        <Pill ok={tConn}   label="TWELVE DATA" />
        <Pill ok={aiReady} label="GPT-4o AI" />
        {account && <span style={{ marginLeft:"auto", fontSize:11, color:"#2a2a4a", fontFamily:"monospace" }}>ID: {account.id?.slice(-8)}</span>}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:13 }}>
        {[
          { l:"Balance",       v: account ? `$${parseFloat(account.balance).toLocaleString("en",{minimumFractionDigits:2})}` : "—", c:"#00ff88" },
          { l:"Net Asset Value", v: account ? `$${parseFloat(account.NAV).toLocaleString("en",{minimumFractionDigits:2})}` : "—", c:"#00ccff" },
          { l:"Unrealized P&L", v: account ? `${pl>=0?"+":""}$${pl.toFixed(2)}` : "—", c:pl>=0?"#00ff88":"#ff4466" },
          { l:"Open Trades",    v: trades.length, c:"#ffcc00" },
        ].map(k => (
          <div key={k.l} style={S.card}>
            <div style={S.title}>{k.l}</div>
            <div style={{ fontSize:20, fontFamily:"monospace", color:k.c, fontWeight:800 }}>{k.v}</div>
          </div>
        ))}
      </div>
      {/* ── Risk Governor + Infrastructure ─────────────────────────── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr auto", gap:13, alignItems:"start" }}>

        {/* Daily loss governor */}
        {risk && (
          <div style={{ ...S.card, borderLeft:`3px solid ${risk.daily_loss.breached?"#ff4466":parseFloat(risk.daily_loss.used_pct)>60?"#ffcc00":"#00ff88"}` }}>
            <div style={S.title}>Daily Loss Governor</div>
            <div style={{ height:5, background:"#0d0d1e", borderRadius:3, margin:"8px 0" }}>
              <div style={{ height:"100%", width:`${Math.min(100, parseFloat(risk.daily_loss.used_pct))}%`,
                background:risk.daily_loss.breached?"#ff4466":parseFloat(risk.daily_loss.used_pct)>60?"#ffcc00":"#00ff88",
                borderRadius:3, transition:"width 0.5s" }} />
            </div>
            {[
              ["Used",  `${risk.daily_loss.used_pct}%`,       risk.daily_loss.breached?"#ff4466":"#ffcc00"],
              ["P&L",   risk.daily_loss.realized,             parseFloat(risk.daily_loss.realized)>=0?"#00ff88":"#ff4466"],
              ["Limit", risk.daily_loss.limit,                "#ff446699"],
              ["Status",risk.daily_loss.breached?"⛔ BLOCKED":"✅ CLEAR", risk.daily_loss.breached?"#ff4466":"#00ff88"],
            ].map(([l,v,c]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"4px 0", borderBottom:"1px solid #0d0d1e" }}>
                <span style={{ color:"#444" }}>{l}</span>
                <span style={{ color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</span>
              </div>
            ))}
          </div>
        )}

        {/* Weekly loss + circuit breaker */}
        {risk && (
          <div style={{ ...S.card, borderLeft:`3px solid ${risk.weekly_loss.breached||risk.consecutive_losses.breached?"#ff4466":"#333"}` }}>
            <div style={S.title}>Weekly + Circuit Breaker</div>
            <div style={{ height:5, background:"#0d0d1e", borderRadius:3, margin:"8px 0" }}>
              <div style={{ height:"100%", width:`${Math.min(100, parseFloat(risk.weekly_loss.used_pct))}%`,
                background:risk.weekly_loss.breached?"#ff4466":parseFloat(risk.weekly_loss.used_pct)>60?"#ffcc00":"#333",
                borderRadius:3, transition:"width 0.5s" }} />
            </div>
            {[
              ["Weekly P&L",  risk.weekly_loss.realized, parseFloat(risk.weekly_loss.realized)>=0?"#00ff88":"#ff4466"],
              ["Weekly Limit",risk.weekly_loss.limit,    "#ff446699"],
              ["Week from",   risk.weekly_loss.week_start,"#666"],
              ["Consec. Losses", `${risk.consecutive_losses.count} / 3`,
                risk.consecutive_losses.count>=3?"#ff4466":risk.consecutive_losses.count>=2?"#ffcc00":"#00ff88"],
              ["Circuit Break", risk.consecutive_losses.breached?"⛔ ACTIVE":"✅ OFF",
                risk.consecutive_losses.breached?"#ff4466":"#00ff88"],
            ].map(([l,v,c]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"4px 0", borderBottom:"1px solid #0d0d1e" }}>
                <span style={{ color:"#444" }}>{l}</span>
                <span style={{ color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</span>
              </div>
            ))}
          </div>
        )}

        {/* Infrastructure */}
        {infra && (
          <div style={{ ...S.card, borderLeft:`3px solid ${infra.oanda_avg_latency_ms>3000?"#ffcc00":infra.stale_pairs?.length>0?"#ff4466":"#333"}` }}>
            <div style={S.title}>Infrastructure</div>
            <div style={{ marginTop:8 }}>
              {[
                ["OANDA Latency", `${infra.oanda_avg_latency_ms}ms`,
                  infra.oanda_avg_latency_ms>5000?"#ff4466":infra.oanda_avg_latency_ms>3000?"#ffcc00":"#00ff88"],
                ["API Failures",  infra.oanda_fail_count, infra.oanda_fail_count>10?"#ffcc00":"#666"],
                ["Stale Feeds",   infra.stale_pairs?.length>0?infra.stale_pairs.join(", "):"None",
                  infra.stale_pairs?.length>0?"#ff4466":"#00ff88"],
                ["Size Factor",   `${(infra.friday_size_factor*100).toFixed(0)}%`,
                  infra.friday_size_factor<1?"#ffcc00":"#00ff88"],
              ].map(([l,v,c]) => (
                <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"4px 0", borderBottom:"1px solid #0d0d1e" }}>
                  <span style={{ color:"#444" }}>{l}</span>
                  <span style={{ color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</span>
                </div>
              ))}
              {risk && (
                <div style={{ marginTop:10 }}>
                  <div style={{ fontSize:10, color:"#444", marginBottom:6 }}>Correlation Exposure</div>
                  {[
                    ["USD Long", `${risk.correlation.usd_long_open} / 2`, risk.correlation.long_breached?"#ff4466":"#00ff88"],
                    ["USD Short",`${risk.correlation.usd_short_open} / 2`, risk.correlation.short_breached?"#ff4466":"#00ff88"],
                  ].map(([l,v,c]) => (
                    <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"3px 0" }}>
                      <span style={{ color:"#444" }}>{l}</span>
                      <span style={{ color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Emergency stop */}
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={doFlatten} disabled={flattening} style={{
            padding:"14px 18px", borderRadius:8, border:"2px solid #ff4466",
            background:flattening?"#330011":"#1a000a", color:"#ff4466",
            fontFamily:"monospace", fontWeight:900, fontSize:12, cursor:"pointer",
            letterSpacing:1, lineHeight:1.5, opacity:flattening?0.6:1,
          }}>
            {flattening ? "CLOSING..." : "⛔ EMERGENCY\nFLATTEN ALL"}
          </button>
          <div style={{ fontSize:10, color:"#333", textAlign:"center", lineHeight:1.4 }}>
            Closes all positions<br/>+ disables scanner
          </div>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:13 }}>
        <div style={S.card}>
          <div style={S.title}>Live Prices</div>
          {PAIRS.map(p => <PriceRow key={p} pair={p} prices={prices} prevPrices={prevPrices} priceAlerts={priceAlerts} onSetAlert={onSetAlert} />)}
          {!tConn && <div style={{ color:"#2a2a4a", fontSize:12, marginTop:12, textAlign:"center" }}>Add Twelve Data key in Settings</div>}
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:13 }}>
          {plHistory.length > 1 && (
            <div style={S.card}>
              <div style={S.title}>P&L Trend (Session)</div>
              <MiniChart data={plHistory} width={320} height={60} color={pl >= 0 ? "#00ff88" : "#ff4466"} />
            </div>
          )}
          <div style={S.card}>
            <div style={S.title}>Open Positions ({trades.length})</div>
            {trades.length === 0 && (
              <div style={{ color:"#2a2a4a", fontSize:12, marginTop:20, textAlign:"center" }}>
                {oConn ? "No open trades" : "Add OANDA key in Settings"}
              </div>
            )}
            {trades.map(t => {
              const tpl = parseFloat(t.unrealizedPL), u = parseFloat(t.currentUnits);
              return (
                <div key={t.id} style={{ padding:"10px", background:"#08081a", borderRadius:8, marginBottom:8, border:"1px solid #0d0d1e" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontWeight:800, color:"#ccc", fontSize:13 }}>{PAIR_LABELS[t.instrument] || t.instrument}</span>
                      <span style={{ ...S.badge, color:u>0?"#00ff88":"#ff4466", background:u>0?"#003322":"#330011" }}>{u > 0 ? "BUY" : "SELL"}</span>
                    </div>
                    <span style={{ fontFamily:"monospace", color:tpl>=0?"#00ff88":"#ff4466", fontWeight:700 }}>{tpl >= 0 ? "+" : ""}{tpl.toFixed(2)}</span>
                  </div>
                  <div style={{ fontSize:11, color:"#333", marginTop:5 }}>
                    {Math.abs(u).toLocaleString()} units · Entry {parseFloat(t.price).toFixed(5)}
                    {t.stopLossOrder && <span style={{ color:"#ff446666" }}> · SL {t.stopLossOrder.price}</span>}
                    {t.takeProfitOrder && <span style={{ color:"#00ff8866" }}> · TP {t.takeProfitOrder.price}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SIGNAL ENGINE UI ─────────────────────────────────────────────────────────
function AutoTradePanel() {
  const [at,       setAt]       = useState({ enabled:false, threshold:85, risk_pct:1, max_per_day:3, min_score:9 });
  const [signals,  setSignals]  = useState([]);
  const [status,   setStatus]   = useState(null);
  const [scanning, setScanning] = useState(false);
  const [atSt,     setAtSt]     = useState(null);
  const [acting,   setActing]   = useState({});

  const load = async () => {
    const [s, l, st] = await Promise.all([
      fetch("/api/autotrade/settings").then(r=>r.json()).catch(()=>null),
      fetch("/api/autotrade/log").then(r=>r.json()).catch(()=>[]),
      fetch("/api/autotrade/status").then(r=>r.json()).catch(()=>null),
    ]);
    if (s) setAt(s);
    if (Array.isArray(l)) setSignals(l);
    if (st) setAtSt(st);
  };
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  const save = async (overrides={}) => {
    const updated = { ...at, ...overrides };
    setAt(updated);
    const r = await fetch("/api/autotrade/settings", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify(updated),
    }).then(res=>res.json());
    setStatus(r.ok ? "✅ Saved — Telegram notified" : "❌ " + r.error);
    setTimeout(()=>setStatus(null), 3000);
    load();
  };

  const scanNow = async () => {
    setScanning(true);
    await fetch("/api/autotrade/scan", { method:"POST" });
    setTimeout(()=>{ setScanning(false); load(); }, 10000);
  };

  const act = async (id, action) => {
    setActing(p=>({...p,[id]:action}));
    await fetch(`/api/autotrade/${action}/${id}`, { method:"POST" });
    setTimeout(()=>{ load(); setActing(p=>({...p,[id]:null})); }, 2000);
  };

  const pending  = signals.filter(s => s.status === "PENDING");
  const history  = signals.filter(s => s.status !== "PENDING");

  const statusColor = { EXECUTED:"#00ff88", REJECTED:"#ff4466", FAILED:"#ff8844", PENDING:"#ffcc00", APPROVED:"#00ccff" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      {/* Settings card */}
      <div style={{ ...S.card, borderLeft:`3px solid ${at.enabled?"#00ff88":"#1a1a30"}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div>
            <div style={S.title}>⚡ AI SIGNAL SCANNER</div>
            <div style={{ fontSize:10, color:"#333", marginTop:2 }}>
              Scans all pairs every 5 min → sends Telegram alert → you approve or reject
            </div>
          </div>
          <button onClick={()=>save({ enabled:!at.enabled })}
            style={{ padding:"8px 22px", borderRadius:20, border:"none", cursor:"pointer", fontWeight:800, fontSize:12, letterSpacing:2,
              background:at.enabled?"#003322":"#1a0808", color:at.enabled?"#00ff88":"#ff4466" }}>
            {at.enabled ? "● ON" : "○ OFF"}
          </button>
        </div>

        {at.enabled && (
          <div style={{ padding:"8px 12px", background:"#001a0a", borderRadius:7, marginBottom:12, fontSize:11, color:"#00ff88", border:"1px solid #00ff8822" }}>
            ⚡ ACTIVE — scanning every 5 min · alerts sent to @Precision_Trader_v3_Pro_Bot
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:9, marginBottom:12 }}>
          <div>
            <label style={S.lbl}>Min Score /12</label>
            <input type="number" value={at.min_score} min="7" max="12"
              onChange={e=>setAt(p=>({...p,min_score:parseInt(e.target.value)}))}
              style={{ ...S.inp, color:"#ff88ff" }} />
            <div style={{ fontSize:9, color:"#333", marginTop:2 }}>12-check filter</div>
          </div>
          <div>
            <label style={S.lbl}>Min AI Conf %</label>
            <input type="number" value={at.threshold} min="50" max="99"
              onChange={e=>setAt(p=>({...p,threshold:parseInt(e.target.value)}))}
              style={{ ...S.inp, color:"#00ccff" }} />
            <div style={{ fontSize:9, color:"#333", marginTop:2 }}>GPT-4o threshold</div>
          </div>
          <div>
            <label style={S.lbl}>Risk / Trade %</label>
            <input type="number" value={at.risk_pct} min="0.1" max="5" step="0.1"
              onChange={e=>setAt(p=>({...p,risk_pct:parseFloat(e.target.value)}))}
              style={{ ...S.inp, color:"#ffcc00" }} />
          </div>
          <div>
            <label style={S.lbl}>Max / Day</label>
            <input type="number" value={at.max_per_day} min="1" max="10"
              onChange={e=>setAt(p=>({...p,max_per_day:parseInt(e.target.value)}))}
              style={{ ...S.inp }} />
          </div>
        </div>

        {status && <div style={{ fontSize:11, color:status.startsWith("✅")?"#00ff88":"#ff4466", marginBottom:8 }}>{status}</div>}

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={()=>save()} style={{ ...S.btn, flex:1, color:"#00ccff", border:"1px solid #00ccff44", background:"#001a2e" }}>
            SAVE SETTINGS
          </button>
          <button onClick={scanNow} disabled={scanning || atSt?.scanning}
            style={{ ...S.btn, flex:1, color:"#ffcc00", border:"1px solid #ffcc0044", background:"#1a1500" }}>
            {scanning||atSt?.scanning ? "⟳ SCANNING..." : "▶ SCAN NOW"}
          </button>
        </div>

        {atSt && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, marginTop:12 }}>
            {[
              ["Pending",       atSt.pending_signals,  "#ffcc00"],
              ["Today Signals", atSt.today_signals+"/"+atSt.max_per_day, "#bbb"],
              ["Total Signals", atSt.total_signals,    "#00ccff"],
              ["Scanner",       atSt.scanning?"ACTIVE":"IDLE", atSt.scanning?"#ffcc00":"#333"],
            ].map(([l,v,c])=>(
              <div key={l} style={{ background:"#08081a", borderRadius:6, padding:"8px 6px", textAlign:"center" }}>
                <div style={{ fontSize:9, color:"#2a2a4a", letterSpacing:1, marginBottom:3 }}>{l}</div>
                <div style={{ fontSize:15, fontFamily:"monospace", color:c, fontWeight:800 }}>{v}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* PENDING signals — awaiting decision */}
      {pending.length > 0 && (
        <div style={{ ...S.card, borderLeft:"3px solid #ffcc00" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
            <div style={S.title}>⏳ PENDING SIGNALS ({pending.length})</div>
            <span style={{ fontSize:10, color:"#ffcc00", animation:"pulse 1s infinite" }}>● AWAITING YOUR DECISION</span>
          </div>
          <div style={{ fontSize:11, color:"#555", marginBottom:12 }}>
            Approve via Telegram or click the buttons below. Signal expires when market moves significantly.
          </div>
          {pending.map(sig => (
            <div key={sig.id} style={{ background:"#0a0a1a", borderRadius:10, padding:"14px", marginBottom:10, border:"1px solid #ffcc0033" }}>
              {/* Header */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontWeight:800, fontSize:15, color:"#fff" }}>{sig.pair}</span>
                  <span style={{ ...S.badge, fontSize:11, color:sig.direction==="BUY"?"#00ff88":"#ff4466",
                    background:sig.direction==="BUY"?"#003322":"#330011" }}>
                    {sig.direction} {sig.direction==="BUY"?"▲":"▼"}
                  </span>
                  <span style={{ ...S.badge, background:"#001a2e", color:"#00ccff", fontSize:11 }}>
                    {sig.confidence}% AI
                  </span>
                </div>
                <span style={{ fontSize:10, color:"#333" }}>#{sig.id} · {sig.created_at?.slice(11,16)}</span>
              </div>

              {/* Trade details grid */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:10 }}>
                {[
                  ["Entry",    sig.entry_price?.toFixed(5), "#bbb"],
                  ["Stop Loss",sig.stop_loss?.toFixed(5)+" (-"+sig.sl_pips+" pip)", "#ff4466"],
                  ["Take Profit",sig.take_profit?.toFixed(5)+" (+"+sig.tp_pips+" pip)", "#00ff88"],
                  ["Size",     sig.lots+" lots", "#ffcc00"],
                  ["Risk",     sig.risk_pct+"% = $"+parseFloat(sig.risk_amount||0).toFixed(0), "#ff8844"],
                  ["EMA",      sig.ema_align||"—", "#00ccff"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{ background:"#08081a", borderRadius:6, padding:"7px 9px" }}>
                    <div style={{ fontSize:9, color:"#2a2a4a", letterSpacing:1, marginBottom:3 }}>{l}</div>
                    <div style={{ fontSize:11, color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</div>
                  </div>
                ))}
              </div>

              {/* RSI + H4 inline */}
              <div style={{ display:"flex", gap:10, marginBottom:12, fontSize:11 }}>
                <span style={{ color:"#555" }}>RSI: <span style={{ color:sig.rsi>70?"#ff4466":sig.rsi<30?"#00ff88":"#bbb", fontFamily:"monospace" }}>{sig.rsi}</span></span>
                <span style={{ color:"#555" }}>H4: <span style={{ color:"#00ccff" }}>{sig.h4_trend}</span></span>
              </div>

              {/* APPROVE / REJECT buttons */}
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={()=>act(sig.id,"approve")} disabled={!!acting[sig.id]}
                  style={{ flex:1, padding:"11px 0", borderRadius:9, border:"1px solid #00ff8866",
                    background:"#003322", color:"#00ff88", cursor:"pointer", fontWeight:800, fontSize:13, letterSpacing:2 }}>
                  {acting[sig.id]==="approve" ? "EXECUTING..." : "✅ APPROVE"}
                </button>
                <button onClick={()=>act(sig.id,"reject")} disabled={!!acting[sig.id]}
                  style={{ flex:1, padding:"11px 0", borderRadius:9, border:"1px solid #ff446666",
                    background:"#1a0808", color:"#ff4466", cursor:"pointer", fontWeight:800, fontSize:13, letterSpacing:2 }}>
                  {acting[sig.id]==="reject" ? "REJECTING..." : "❌ REJECT"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Signal history */}
      <div style={S.card}>
        <div style={S.title}>Signal History ({history.length})</div>
        {history.length === 0 && (
          <div style={{ color:"#2a2a4a", fontSize:12, textAlign:"center", padding:"24px 0" }}>
            {at.enabled
              ? `Scanner active — signals appear here when AI finds ≥${at.threshold}% confidence setups`
              : "Enable the scanner above to start receiving trade signals"}
          </div>
        )}
        {history.slice(0,30).map((sig,i) => (
          <div key={sig.id} style={{ padding:"10px 12px", background:i%2===0?"#07071a":"#08081a",
            borderRadius:7, marginBottom:4, border:"1px solid #0d0d1e",
            borderLeft:`3px solid ${statusColor[sig.status]||"#333"}` }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:5 }}>
              <span style={{ fontWeight:800, color:"#bbb", fontSize:12, minWidth:52 }}>{sig.pair}</span>
              <span style={{ ...S.badge, fontSize:9, color:sig.direction==="BUY"?"#00ff88":"#ff4466",
                background:sig.direction==="BUY"?"#003322":"#330011" }}>{sig.direction}</span>
              <span style={{ ...S.badge, background:"#001a2e", color:"#00ccff", fontSize:9 }}>{sig.confidence}%</span>
              <span style={{ marginLeft:"auto", fontSize:10, fontWeight:700,
                color:statusColor[sig.status]||"#555" }}>{sig.status}</span>
              <span style={{ fontSize:9, color:"#2a2a4a", fontFamily:"monospace" }}>#{sig.id}</span>
            </div>
            <div style={{ display:"flex", gap:12, fontSize:10, color:"#333" }}>
              <span>Entry: <span style={{ color:"#555" }}>{sig.entry_price?.toFixed(5)}</span></span>
              <span>SL: <span style={{ color:"#ff446688" }}>{sig.stop_loss?.toFixed(5)}</span></span>
              <span>TP: <span style={{ color:"#00ff8888" }}>{sig.take_profit?.toFixed(5)}</span></span>
              {sig.filled_price && <span>Filled: <span style={{ color:"#00ccff88" }}>{sig.filled_price?.toFixed(5)}</span></span>}
              <span style={{ marginLeft:"auto" }}>{sig.created_at?.slice(0,16)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LIVE TRADING ─────────────────────────────────────────────────────────────
function LiveTrading({ account, trades, prices, keys, addAlert, refresh }) {
  const [pair, setPair]     = useState("EUR_USD");
  const [dir, setDir]       = useState("BUY");
  const [units, setUnits]   = useState("1000");
  const [sl, setSl]         = useState("");
  const [tp, setTp]         = useState("");
  const [status, setStatus] = useState(null);
  const [closing, setClosing] = useState(null);
  const [tab, setTab]       = useState("manual"); // "manual" | "auto"

  // Position Sizer state
  const [riskPct, setRiskPct]   = useState("1");
  const [sizeResult, setSizeResult] = useState(null);
  const [sizing, setSizing]         = useState(false);

  // Daily loss limit state
  const [daily, setDaily] = useState(null);
  useEffect(() => {
    getDailyStatus().then(setDaily);
    const t = setInterval(() => getDailyStatus().then(setDaily), 30000);
    return () => clearInterval(t);
  }, []);

  const calcSize = async () => {
    if (!sl) { alert("Enter a Stop Loss price first"); return; }
    const livePrice = prices[pair];
    if (!livePrice) { alert("No live price available"); return; }
    setSizing(true); setSizeResult(null);
    const res = await getPositionSize(PAIR_LABELS[pair], livePrice.toFixed(5), sl, riskPct);
    setSizeResult(res);
    if (res.recommendedUnits) setUnits(String(res.recommendedUnits));
    setSizing(false);
  };

  const execute = async () => {
    // Check daily loss limit first
    const d = await getDailyStatus();
    if (d.limit_hit) {
      setStatus({ ok:false, msg:`⛔ Daily loss limit reached (${d.used_percent}% used). Stop trading today.` });
      return;
    }
    if (!keys.oanda_key || !keys.oanda_account) { setStatus({ ok:false, msg:"OANDA keys not configured" }); return; }
    setStatus({ ok:null, msg:"Sending order to OANDA..." });
    const body = { order: { type:"MARKET", instrument:pair, units:dir==="BUY" ? units : `-${units}`, ...(sl?{stopLossOnFill:{price:sl}}:{}), ...(tp?{takeProfitOnFill:{price:tp}}:{}) } };
    try {
      const r = await oandaFetch(`/v3/accounts/${keys.oanda_account}/orders`, { method:"POST", body:JSON.stringify(body) });
      if (r.orderFillTransaction) {
        const filled = r.orderFillTransaction;
        setStatus({ ok:true, msg:`✓ Filled @ ${parseFloat(filled.price).toFixed(5)}` });
        addAlert({ type:"TRADE", icon:"✅", title:`${PAIR_LABELS[pair]} ${dir} Executed`, detail:`${units} units @ ${filled.price}`, color:"#00ff88" });
        sendTelegram(`🚀 <b>TRADE EXECUTED</b>\nPair: ${PAIR_LABELS[pair]}\nDirection: ${dir}\nUnits: ${units}\nPrice: ${filled.price}`, keys);
        refresh();
      } else {
        setStatus({ ok:false, msg:r.errorMessage || r.orderRejectTransaction?.rejectReason || "Order rejected" });
      }
    } catch(e) { setStatus({ ok:false, msg:e.message }); }
    setTimeout(() => setStatus(null), 4000);
  };

  const closeTrade = async (id) => {
    setClosing(id);
    try {
      const r = await oandaFetch(`/v3/accounts/${keys.oanda_account}/trades/${id}/close`, { method:"PUT", body:"{}" });
      if (r.orderFillTransaction) {
        const realized = parseFloat(r.orderFillTransaction.pl);
        // Record P&L for daily limit tracking
        await recordPL(realized);
        getDailyStatus().then(setDaily);
        addAlert({ type:"CLOSE", icon:"🔒", title:"Trade Closed", detail:`Realized P&L: ${realized >= 0 ? '+' : ''}${realized.toFixed(2)}`, color:"#00ccff" });
        fetch("/api/telegram/send", { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ message:`🔒 <b>TRADE CLOSED</b>\nP&L: ${realized >= 0 ? '+' : ''}${realized.toFixed(2)}\nPair: ${PAIR_LABELS[pair]}` })
        });
        refresh();
      }
    } catch {}
    setClosing(null);
  };

  const livePrice = prices[pair];
  const dp = pair === "XAU_USD" ? 2 : 5;
  const pipValue = pair === "XAU_USD" ? 0.5 : 0.0010;

  const autofill = () => {
    if (!livePrice) return;
    const slPrice = dir === "BUY" ? livePrice - pipValue * 20 : livePrice + pipValue * 20;
    const tpPrice = dir === "BUY" ? livePrice + pipValue * 40 : livePrice - pipValue * 40;
    setSl(slPrice.toFixed(dp)); setTp(tpPrice.toFixed(dp));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {/* Tab row */}
      <div style={{ display:"flex", gap:8 }}>
        {[["manual","📋 Manual Trade"],["auto","⚡ Auto-Trade Engine"]].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:"8px 18px", borderRadius:8, border:`1px solid ${tab===id?"#00ccff44":"#13132b"}`,
              background:tab===id?"#001a2e":"transparent", color:tab===id?"#00ccff":"#333",
              cursor:"pointer", fontWeight:800, fontSize:11, letterSpacing:2 }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "auto" && <AutoTradePanel />}
      {tab === "manual" && (
      <div style={{ display:"grid", gridTemplateColumns:"300px 1fr", gap:16 }}>
      <div style={{ display:"flex", flexDirection:"column", gap:13 }}>
        <div style={S.card}>
          <div style={S.title}>New Order</div>
          <label style={S.lbl}>Instrument</label>
          <select value={pair} onChange={e => setPair(e.target.value)} style={{ ...S.inp, marginBottom:11 }}>
            {PAIRS.map(p => <option key={p} value={p}>{PAIR_LABELS[p]}</option>)}
          </select>
          <div style={{ display:"flex", gap:7, marginBottom:11 }}>
            {["BUY","SELL"].map(d => (
              <button key={d} onClick={() => setDir(d)} style={{ flex:1, padding:"10px 0", borderRadius:8, border:`1px solid ${dir===d?(d==="BUY"?"#00ff88":"#ff4466"):"#13132b"}`, background:dir===d?(d==="BUY"?"#003322":"#330011"):"transparent", color:dir===d?(d==="BUY"?"#00ff88":"#ff4466"):"#333", cursor:"pointer", fontWeight:800, letterSpacing:2, fontFamily:"monospace" }}>
                {d}
              </button>
            ))}
          </div>
          <label style={S.lbl}>Units</label>
          <input value={units} onChange={e => setUnits(e.target.value)} style={{ ...S.inp, marginBottom:11 }} type="number" step="1000" />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, marginBottom:6 }}>
            <div><label style={S.lbl}>Stop Loss</label><input value={sl} onChange={e => setSl(e.target.value)} style={S.inp} placeholder="price" /></div>
            <div><label style={S.lbl}>Take Profit</label><input value={tp} onChange={e => setTp(e.target.value)} style={S.inp} placeholder="price" /></div>
          </div>
          <button onClick={autofill} style={{ ...S.btn, width:"100%", marginBottom:6, padding:"6px 0", fontSize:10, color:"#555", background:"transparent", border:"1px solid #13132b", letterSpacing:2 }}>
            AUTO-FILL SL/TP (20/40 pip)
          </button>
          {/* Position Sizer — Risk % → Auto Units */}
          <div style={{ display:"flex", gap:6, marginBottom:11, alignItems:"flex-end" }}>
            <div style={{ flex:1 }}>
              <label style={S.lbl}>Risk %</label>
              <input value={riskPct} onChange={e => setRiskPct(e.target.value)} style={{ ...S.inp, color:"#ffcc00" }} type="number" step="0.1" min="0.1" max="5" placeholder="1" />
            </div>
            <button onClick={calcSize} disabled={sizing} style={{ ...S.btn, padding:"9px 12px", color:"#ffcc00", border:"1px solid #ffcc0044", background:"#1a1500", fontSize:10, letterSpacing:1, whiteSpace:"nowrap" }}>
              {sizing ? "..." : "CALC SIZE"}
            </button>
          </div>
          {sizeResult && !sizeResult.error && (
            <div style={{ padding:"8px 10px", background:"#0d0d00", borderRadius:8, marginBottom:11, border:"1px solid #ffcc0022" }}>
              <div style={{ fontSize:10, color:"#ffcc00", letterSpacing:2, marginBottom:5 }}>POSITION SIZE</div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:3 }}>
                <span style={{ color:"#555" }}>Units</span>
                <span style={{ color:"#ffcc00", fontFamily:"monospace", fontWeight:800 }}>{sizeResult.recommendedUnits?.toLocaleString()}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:3 }}>
                <span style={{ color:"#555" }}>SL Pips</span>
                <span style={{ color:"#bbb", fontFamily:"monospace" }}>{sizeResult.slPips}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:3 }}>
                <span style={{ color:"#555" }}>Risk $</span>
                <span style={{ color:"#ff8844", fontFamily:"monospace" }}>{sizeResult.currency}{sizeResult.riskAmount}</span>
              </div>
              <div style={{ fontSize:10, color:"#2a2a4a", marginTop:4 }}>{sizeResult.note}</div>
            </div>
          )}
          {sizeResult?.error && (
            <div style={{ padding:"7px 10px", background:"#1a0808", borderRadius:8, marginBottom:11, fontSize:11, color:"#ff4466" }}>
              {sizeResult.error}
            </div>
          )}
          {livePrice && (
            <div style={{ padding:"7px 11px", background:"#07071a", borderRadius:8, marginBottom:11, fontSize:12, display:"flex", justifyContent:"space-between" }}>
              <span style={{ color:"#333" }}>Live Price</span>
              <span style={{ color:"#00ccff", fontFamily:"monospace" }}>{livePrice?.toFixed(dp)}</span>
            </div>
          )}
          {status && (
            <div style={{ padding:"8px 11px", borderRadius:8, marginBottom:11, fontSize:12, background:status.ok===null?"#001a2e":status.ok?"#003322":"#330011", color:status.ok===null?"#00ccff":status.ok?"#00ff88":"#ff4466" }}>
              {status.msg}
            </div>
          )}
          <button onClick={execute} style={{ ...S.btn, width:"100%", padding:"12px 0", fontWeight:800, letterSpacing:3, background:dir==="BUY"?"#003322":"#330011", color:dir==="BUY"?"#00ff88":"#ff4466", border:`1px solid ${dir==="BUY"?"#00ff8866":"#ff446666"}` }}>
            {dir} {PAIR_LABELS[pair]}
          </button>
        </div>
        {/* Daily Loss Limit Panel */}
        {daily && (
          <div style={{ ...S.card, borderLeft:`3px solid ${daily.limit_hit?"#ff4466":parseFloat(daily.used_percent)>60?"#ffcc00":"#00ff88"}` }}>
            <div style={S.title}>Daily Loss Limit (3% Rule)</div>
            {daily.limit_hit && (
              <div style={{ padding:"8px 10px", background:"#1a0808", borderRadius:7, marginBottom:10, fontSize:12, color:"#ff4466", fontWeight:700 }}>
                ⛔ STOP TRADING — limit reached
              </div>
            )}
            <div style={{ marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:4 }}>
                <span style={{ color:"#555" }}>Used</span>
                <span style={{ color:daily.limit_hit?"#ff4466":parseFloat(daily.used_percent)>60?"#ffcc00":"#00ff88", fontFamily:"monospace" }}>
                  {daily.used_percent}%
                </span>
              </div>
              <div style={{ height:5, background:"#0d0d1e", borderRadius:3 }}>
                <div style={{ height:"100%", width:`${Math.min(100, parseFloat(daily.used_percent))}%`, background:daily.limit_hit?"#ff4466":parseFloat(daily.used_percent)>60?"#ffcc00":"#00ff88", borderRadius:3, transition:"width 0.5s" }} />
              </div>
            </div>
            {[
              ["Today P&L",   `${parseFloat(daily.realized_pl)>=0?"+":""}${daily.realized_pl}`, parseFloat(daily.realized_pl)>=0?"#00ff88":"#ff4466"],
              ["Max Loss",    daily.max_daily_loss, "#ff4466"],
              ["Trades Today", daily.trade_count,   "#bbb"],
              ["Status",      daily.safe_to_trade?"✓ SAFE TO TRADE":"⛔ STOP", daily.safe_to_trade?"#00ff88":"#ff4466"],
            ].map(([l,v,c]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #0d0d1e", fontSize:11 }}>
                <span style={{ color:"#444" }}>{l}</span>
                <span style={{ color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</span>
              </div>
            ))}
          </div>
        )}

        {account && (
          <div style={S.card}>
            <div style={S.title}>Account</div>
            {[
              ["Balance",    `$${parseFloat(account.balance).toFixed(2)}`,             "#00ff88"],
              ["NAV",        `$${parseFloat(account.NAV).toFixed(2)}`,                 "#00ccff"],
              ["Margin Used",`$${parseFloat(account.marginUsed||0).toFixed(2)}`,       "#ffcc00"],
              ["Open P&L",   `${parseFloat(account.unrealizedPL)>=0?"+":""}$${parseFloat(account.unrealizedPL).toFixed(2)}`, parseFloat(account.unrealizedPL)>=0?"#00ff88":"#ff4466"],
            ].map(([l,v,c]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:"1px solid #0d0d1e", fontSize:12 }}>
                <span style={{ color:"#333" }}>{l}</span><span style={{ color:c, fontFamily:"monospace" }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={S.card}>
        <div style={S.title}>Open Positions ({trades.length})</div>
        {trades.length === 0 && <div style={{ color:"#2a2a4a", fontSize:12, marginTop:30, textAlign:"center" }}>No open trades</div>}
        {trades.map(t => {
          const tpl = parseFloat(t.unrealizedPL), u = parseFloat(t.currentUnits);
          return (
            <div key={t.id} style={{ padding:"12px", background:"#08081a", borderRadius:10, marginBottom:9, border:"1px solid #0d0d1e" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
                <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                  <span style={{ fontWeight:800, color:"#ccc" }}>{PAIR_LABELS[t.instrument] || t.instrument}</span>
                  <span style={{ ...S.badge, color:u>0?"#00ff88":"#ff4466", background:u>0?"#003322":"#330011" }}>{u > 0 ? "BUY" : "SELL"}</span>
                  <span style={{ fontSize:11, color:"#2a2a4a" }}>{Math.abs(u).toLocaleString()} units</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontFamily:"monospace", color:tpl>=0?"#00ff88":"#ff4466", fontWeight:700, fontSize:14 }}>{tpl >= 0 ? "+" : ""}{tpl.toFixed(2)}</span>
                  <button onClick={() => closeTrade(t.id)} disabled={closing === t.id} style={{ ...S.btn, padding:"5px 11px", color:"#ff4466", border:"1px solid #ff446633", background:"#1a0808", fontSize:11 }}>
                    {closing === t.id ? "..." : "Close"}
                  </button>
                </div>
              </div>
              <div style={{ fontSize:11, color:"#2a2a4a", display:"flex", gap:16 }}>
                <span>Entry: <span style={{ color:"#555" }}>{parseFloat(t.price).toFixed(5)}</span></span>
                {t.stopLossOrder   && <span>SL: <span style={{ color:"#ff446688" }}>{t.stopLossOrder.price}</span></span>}
                {t.takeProfitOrder && <span>TP: <span style={{ color:"#00ff8888" }}>{t.takeProfitOrder.price}</span></span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
      )}
    </div>
  );
}

// ─── OPPORTUNITIES ────────────────────────────────────────────────────────────
function Opportunities({ prices, keys, addAlert }) {
  const [scanning, setScanning] = useState(false);
  const [signals, setSignals]   = useState([]);

  const scan = async () => {
    setScanning(true); setSignals([]);
    const available = PAIRS.filter(p => prices[p]).slice(0, 4);
    const results = [];
    for (const pair of available) {
      try {
        const res  = await aiAnalyze(PAIR_LABELS[pair], prices[pair]);
        const text = res.analysis;
        const bm   = text.match(/Market Bias:\s*(BULLISH|BEARISH|NEUTRAL)/i);
        const cm   = text.match(/Confidence Score:\s*(\d+)/i);
        const slm  = text.match(/Stop Loss:\s*([0-9.]+)/i);
        const tpm  = text.match(/Take Profit:\s*([0-9.]+)/i);
        results.push({
          pair, label:PAIR_LABELS[pair], price:prices[pair],
          bias:bm?.[1]?.toUpperCase()||"NEUTRAL", conf:cm?parseInt(cm[1]):70,
          analysis:text, indicators: res.indicators,
          sl: slm?.[1], tp: tpm?.[1],
        });
      } catch {}
    }
    setSignals(results);
    if (results.length > 0) {
      const top = [...results].sort((a, b) => b.conf - a.conf)[0];
      const slLine = top.sl ? `SL: ${top.sl}` : '';
      const tpLine = top.tp ? `TP: ${top.tp}` : '';
      // Send to Telegram with full signal
      fetch("/api/telegram/send", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ message: `🔍 <b>AI MARKET SCAN — PrecisionTraderPro</b>\n\n📊 Top Signal: <b>${top.label}</b>\n📈 Bias: <b>${top.bias}</b>\n🎯 Confidence: <b>${top.conf}%</b>\n💰 Price: ${top.price}\n${slLine ? `🛑 ${slLine}\n` : ''}${tpLine ? `✅ ${tpLine}\n` : ''}\nReal candle data used ✓` })
      });
      addAlert({ type:"SCAN", icon:"◈", title:"AI Scan Complete", detail:`Best: ${top.label} ${top.bias} ${top.conf}%`, color:"#00ccff" });
    }
    setScanning(false);
  };

  const bColor = { BULLISH:"#00ff88", BEARISH:"#ff4466", NEUTRAL:"#ffcc00" };
  const bBg    = { BULLISH:"#003322", BEARISH:"#330011", NEUTRAL:"#332200" };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
        <div style={S.ph}>Trade Opportunities</div>
        <button onClick={scan} disabled={scanning} style={{ ...S.btn, padding:"10px 22px", color:"#00ccff", border:"1px solid #00ccff", background:"#001a2e", letterSpacing:2 }}>
          {scanning ? "⟳ SCANNING..." : "✦ AI SCAN"}
        </button>
      </div>
      {scanning && (
        <div style={{ ...S.card, textAlign:"center", padding:60 }}>
          <div style={{ color:"#00ccff", fontSize:13, letterSpacing:3, animation:"pulse 1s infinite" }}>GPT-4o ANALYZING MARKETS...</div>
          <div style={{ color:"#2a2a4a", marginTop:8, fontSize:11 }}>Analyzing up to 4 pairs simultaneously</div>
        </div>
      )}
      {!scanning && signals.length === 0 && (
        <div style={{ ...S.card, textAlign:"center", padding:60, color:"#2a2a4a" }}>
          <div style={{ fontSize:36, marginBottom:12 }}>◈</div>
          Click AI SCAN to analyze live market conditions with GPT-4o
        </div>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:11 }}>
        {signals.sort((a, b) => b.conf - a.conf).map(s => (
          <div key={s.pair} style={{ ...S.card, borderLeft:`3px solid ${bColor[s.bias]}` }}>
            <div style={{ display:"flex", gap:16, alignItems:"flex-start" }}>
              <div style={{ minWidth:88 }}>
                <div style={{ fontWeight:800, fontSize:15, color:"#ccc" }}>{s.label}</div>
                <span style={{ ...S.badge, marginTop:6, display:"block", color:bColor[s.bias], background:bBg[s.bias], border:`1px solid ${bColor[s.bias]}33` }}>{s.bias}</span>
                <div style={{ fontSize:11, color:"#2a2a4a", marginTop:5, fontFamily:"monospace" }}>{s.price?.toFixed?.(5)}</div>
              </div>
              <div style={{ flex:1, fontSize:12, color:"#666", lineHeight:1.8, whiteSpace:"pre-wrap" }}>{s.analysis.slice(0, 550)}</div>
              <div style={{ textAlign:"center", minWidth:64 }}>
                <div style={{ fontSize:10, color:"#333", marginBottom:4 }}>Confidence</div>
                <div style={{ fontSize:28, fontWeight:800, fontFamily:"monospace", color:s.conf>=80?"#00ff88":s.conf>=65?"#ffcc00":"#ff8844" }}>{s.conf}%</div>
                <div style={{ marginTop:8, width:48, height:3, borderRadius:2, background:"#0d0d1e", overflow:"hidden", margin:"8px auto 0" }}>
                  <div style={{ width:`${s.conf}%`, height:"100%", background:s.conf>=80?"#00ff88":s.conf>=65?"#ffcc00":"#ff8844" }} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CHARTS ───────────────────────────────────────────────────────────────────
function Charts({ keys }) {
  const [pair, setPair]     = useState("EUR_USD");
  const [tf, setTf]         = useState("H1");
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
  const cvs = useRef(null);

  useEffect(() => {
    if (!keys.oanda_key || !keys.oanda_account) { setCandles([]); return; }
    setLoading(true);
    oandaFetch(`/v3/instruments/${pair}/candles?count=80&granularity=${tf || "H1"}`)
      .then(d => { setCandles(d.candles || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [pair, tf, keys.oanda_key, keys.oanda_account]);

  useEffect(() => {
    const c = cvs.current;
    if (!c || candles.length < 2) return;
    const w = c.width, h = c.height;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const data = candles.map(x => ({ o:parseFloat(x.mid.o), h:parseFloat(x.mid.h), l:parseFloat(x.mid.l), c:parseFloat(x.mid.c) }));
    const mn = Math.min(...data.map(d => d.l)), mx = Math.max(...data.map(d => d.h));
    const toY = v => h * 0.05 + (h * 0.88) * (1 - (v - mn) / (mx - mn || 1));

    ctx.strokeStyle = "#0d0d1e"; ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) { ctx.beginPath(); ctx.moveTo(50, (h/6)*i); ctx.lineTo(w, (h/6)*i); ctx.stroke(); }
    for (let i = 1; i <= 10; i++) { ctx.beginPath(); ctx.moveTo(50+(w-50)/10*i, 0); ctx.lineTo(50+(w-50)/10*i, h); ctx.stroke(); }

    ctx.fillStyle = "#2a2a4a"; ctx.font = "9px monospace"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) { const pv = mn + (mx-mn)*i/4; ctx.fillText(pv.toFixed(pair==="XAU_USD"?2:5), 46, h*0.05+(h*0.88)*(1-i/4)+3); }

    const cw = Math.max(2, (w-50)/data.length*0.65);
    data.forEach((d, i) => {
      const x = 50 + (i/data.length)*(w-50) + (w-50)/data.length*0.15;
      const bull = d.c >= d.o;
      ctx.strokeStyle = bull ? "#00ff88" : "#ff4466"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x+cw/2, toY(d.h)); ctx.lineTo(x+cw/2, toY(d.l)); ctx.stroke();
      const by = Math.min(toY(d.o), toY(d.c)), bh = Math.max(1, Math.abs(toY(d.o)-toY(d.c)));
      ctx.fillStyle = bull ? "#003322" : "#330011"; ctx.fillRect(x, by, cw, bh);
      ctx.strokeRect(x, by, cw, bh);
    });

    ctx.strokeStyle = "#ffcc00"; ctx.lineWidth = 1.5; ctx.beginPath();
    let ema9 = data[0].c;
    data.forEach((d, i) => { ema9 = ema9*0.8 + d.c*0.2; const x = 50+(i/data.length)*(w-50)+(w-50)/data.length*0.5; i===0?ctx.moveTo(x,toY(ema9)):ctx.lineTo(x,toY(ema9)); });
    ctx.stroke();

    ctx.strokeStyle = "#ff88ff"; ctx.lineWidth = 1; ctx.setLineDash([3,3]); ctx.beginPath();
    let ema21 = data[0].c;
    data.forEach((d, i) => { ema21 = ema21*0.909 + d.c*0.091; const x = 50+(i/data.length)*(w-50)+(w-50)/data.length*0.5; i===0?ctx.moveTo(x,toY(ema21)):ctx.lineTo(x,toY(ema21)); });
    ctx.stroke(); ctx.setLineDash([]);
  }, [candles]);

  return (
    <div>
      <div style={{ display:"flex", gap:9, marginBottom:13, flexWrap:"wrap", alignItems:"center" }}>
        <select value={pair} onChange={e => setPair(e.target.value)} style={{ ...S.inp, width:130 }}>
          {PAIRS.map(p => <option key={p} value={p}>{PAIR_LABELS[p]}</option>)}
        </select>
        {["M5","M15","H1","H4","D"].map(t => (
          <button key={t} onClick={() => setTf(t)} style={{ padding:"6px 14px", borderRadius:7, border:`1px solid ${tf===t?"#00ccff":"#13132b"}`, background:tf===t?"#001a2e":"transparent", color:tf===t?"#00ccff":"#333", cursor:"pointer", fontSize:12, fontWeight:700 }}>
            {t}
          </button>
        ))}
        <div style={{ marginLeft:"auto", fontSize:10, color:"#2a2a4a", display:"flex", alignItems:"center", gap:9 }}>
          <span style={{ color:"#ffcc00" }}>─</span>EMA9 <span style={{ color:"#ff88ff" }}>┄</span>EMA21
          <span style={{ color:"#00ff88" }}>█</span>Bull <span style={{ color:"#ff4466" }}>█</span>Bear
        </div>
      </div>
      <div style={{ ...S.card, padding:0, overflow:"hidden" }}>
        {!keys.oanda_key && <div style={{ height:400, display:"flex", alignItems:"center", justifyContent:"center", color:"#2a2a4a", fontSize:13 }}>Add OANDA key in Settings to load real candles</div>}
        {keys.oanda_key && loading && <div style={{ height:400, display:"flex", alignItems:"center", justifyContent:"center", color:"#2a2a4a" }}>Loading candles from OANDA...</div>}
        {keys.oanda_key && !loading && candles.length === 0 && <div style={{ height:400, display:"flex", alignItems:"center", justifyContent:"center", color:"#2a2a4a" }}>No candle data returned</div>}
        <canvas ref={cvs} width={960} height={400} style={{ width:"100%", height:400, display:candles.length>0?"block":"none" }} />
      </div>
    </div>
  );
}

// ─── JOURNAL ──────────────────────────────────────────────────────────────────
// ─── SVG CHARTS ───────────────────────────────────────────────────────────────
function EquityCurve({ data }) {
  if (!data || data.length < 2) return (
    <div style={{ height:140, display:"flex", alignItems:"center", justifyContent:"center", color:"#2a2a4a", fontSize:12 }}>
      Not enough data for equity curve
    </div>
  );
  const W = 560, H = 120, PAD = 14;
  const pls = data.map(d => d.pl);
  const min = Math.min(...pls, 0), max = Math.max(...pls, 0);
  const range = max - min || 1;
  const toX = i => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const toY = v => H - PAD - ((v - min) / range) * (H - PAD * 2);
  const zero = toY(0);
  const pts = data.map((d, i) => `${toX(i)},${toY(d.pl)}`).join(' ');
  const last = data[data.length - 1].pl;
  const color = last >= 0 ? "#00ff88" : "#ff4466";
  const fillPts = `${toX(0)},${zero} ${pts} ${toX(data.length-1)},${zero}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:140, overflow:"visible" }}>
      <line x1={PAD} y1={zero} x2={W-PAD} y2={zero} stroke="#1a1a30" strokeWidth={1} strokeDasharray="3 3" />
      <polygon points={fillPts} fill={color} fillOpacity={0.08} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={toX(data.length-1)} cy={toY(last)} r={3} fill={color} />
      <text x={PAD} y={10} fill="#2a2a4a" fontSize={9}>${max.toFixed(0)}</text>
      <text x={PAD} y={H-2} fill="#2a2a4a" fontSize={9}>${min.toFixed(0)}</text>
    </svg>
  );
}

function MonthlyBars({ data }) {
  if (!data || data.length === 0) return null;
  const W = 560, H = 80, PAD = 12;
  const pls = data.map(d => d.pl);
  const absMax = Math.max(...pls.map(Math.abs), 1);
  const barW = Math.max(6, Math.floor((W - PAD * 2) / data.length) - 3);
  const zero = H / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:80 }}>
      <line x1={PAD} y1={zero} x2={W-PAD} y2={zero} stroke="#1a1a30" strokeWidth={1} />
      {data.map((d, i) => {
        const x = PAD + i * ((W - PAD * 2) / data.length);
        const barH = Math.abs(d.pl) / absMax * (H / 2 - 4);
        const isPos = d.pl >= 0;
        return (
          <g key={d.month}>
            <rect x={x} y={isPos ? zero - barH : zero} width={barW} height={barH} fill={isPos ? "#00ff88" : "#ff4466"} fillOpacity={0.7} rx={1} />
            <text x={x + barW / 2} y={H - 1} fill="#2a2a4a" fontSize={7} textAnchor="middle">{d.month?.slice(5)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── JOURNAL ──────────────────────────────────────────────────────────────────
function Journal() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("ALL");
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/journal?count=200');
      if (r.ok) setData(await r.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const saveNote = async (tradeId) => {
    setSaving(true);
    await fetch('/api/journal/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeId, note: editText }),
    });
    setData(prev => ({
      ...prev,
      trades: prev.trades.map(t => t.id === tradeId ? { ...t, note: editText } : t),
    }));
    setEditId(null);
    setSaving(false);
  };

  const trades  = data?.trades  || [];
  const stats   = data?.stats   || {};
  const equity  = data?.equityCurve || [];
  const monthly = data?.monthlyPL   || [];

  const filtered = filter === "ALL"  ? trades
    : filter === "WIN"  ? trades.filter(t => t.result === "WIN")
    : filter === "LOSS" ? trades.filter(t => t.result === "LOSS")
    : filter === "BUY"  ? trades.filter(t => t.direction === "BUY")
    : trades.filter(t => t.direction === "SELL");

  const plColor = v => parseFloat(v) >= 0 ? "#00ff88" : "#ff4466";
  const resColor = r => r === "WIN" ? "#00ff88" : r === "LOSS" ? "#ff4466" : "#ffcc00";

  const StatCard = ({ label, value, sub, color }) => (
    <div style={{ ...S.card, flex:1, minWidth:110, textAlign:"center", padding:"13px 10px" }}>
      <div style={{ fontSize:9, color:"#2a2a4a", letterSpacing:2, marginBottom:5, textTransform:"uppercase" }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:900, color: color || "#ccc", fontFamily:"monospace" }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:"#333", marginTop:3 }}>{sub}</div>}
    </div>
  );

  const streakStr = stats.streak > 0 ? `+${stats.streak}W` : stats.streak < 0 ? `${stats.streak}L` : "—";
  const streakColor = stats.streak > 0 ? "#00ff88" : stats.streak < 0 ? "#ff4466" : "#555";

  return (
    <div style={{ padding:"0 2px" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <div style={S.ph}>Trade Journal</div>
        <button onClick={load} disabled={loading} style={{ ...S.btn, padding:"8px 16px", color:"#00ccff", border:"1px solid #00ccff44", background:"#001a2e", fontSize:11 }}>
          {loading ? "Loading..." : "↻ Refresh"}
        </button>
      </div>

      {/* Stats cards */}
      {stats.total > 0 && (
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
          <StatCard label="Win Rate"  value={`${stats.winRate}%`}  sub={`${stats.won}W / ${stats.lost}L`} color={stats.winRate >= 50 ? "#00ff88" : "#ff4466"} />
          <StatCard label="Avg R:R"   value={stats.avgRR}          sub="reward:risk"                       color="#00ccff" />
          <StatCard label="Total P&L" value={`$${parseFloat(stats.totalPL) >= 0 ? "+" : ""}${stats.totalPL}`} color={plColor(stats.totalPL)} />
          <StatCard label="Best Trade" value={`+$${stats.bestTrade}`}  sub="single trade"                 color="#00ff88" />
          <StatCard label="Worst"     value={`-$${Math.abs(stats.worstTrade).toFixed(2)}`} sub="single trade" color="#ff4466" />
          <StatCard label="Max DD"    value={`-$${stats.maxDD}`}   sub="drawdown"                         color="#ff8844" />
          <StatCard label="Streak"    value={streakStr}            sub="current"                          color={streakColor} />
          <StatCard label="Trades"    value={stats.total}          sub={`${stats.be} breakeven`}          color="#ccc" />
        </div>
      )}

      {/* Charts row */}
      {equity.length > 1 && (
        <div style={{ display:"flex", gap:10, marginBottom:14 }}>
          <div style={{ ...S.card, flex:2, padding:"12px 14px" }}>
            <div style={{ fontSize:10, color:"#2a2a4a", letterSpacing:2, marginBottom:8, textTransform:"uppercase" }}>Equity Curve</div>
            <EquityCurve data={equity} />
          </div>
          {monthly.length > 0 && (
            <div style={{ ...S.card, flex:1, padding:"12px 14px" }}>
              <div style={{ fontSize:10, color:"#2a2a4a", letterSpacing:2, marginBottom:8, textTransform:"uppercase" }}>Monthly P&L</div>
              <MonthlyBars data={monthly} />
              <div style={{ display:"flex", flexDirection:"column", gap:3, marginTop:8 }}>
                {monthly.slice(-4).map(m => (
                  <div key={m.month} style={{ display:"flex", justifyContent:"space-between", fontSize:10 }}>
                    <span style={{ color:"#333" }}>{m.month}</span>
                    <span style={{ color:plColor(m.pl), fontFamily:"monospace" }}>{m.pl >= 0 ? "+" : ""}${m.pl.toFixed(0)}</span>
                    <span style={{ color:"#2a2a4a" }}>{m.won}/{m.trades}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display:"flex", gap:6, marginBottom:10 }}>
        {["ALL","WIN","LOSS","BUY","SELL"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ padding:"5px 12px", borderRadius:6, border:`1px solid ${filter===f?"#00ccff44":"#13132b"}`, background:filter===f?"#001a2e":"transparent", color:filter===f?"#00ccff":"#333", cursor:"pointer", fontSize:10, fontWeight:700 }}>
            {f} {f !== "ALL" ? `(${f==="WIN"?stats.won:f==="LOSS"?stats.lost:f==="BUY"?trades.filter(t=>t.direction==="BUY").length:trades.filter(t=>t.direction==="SELL").length})` : `(${trades.length})`}
          </button>
        ))}
      </div>

      {/* Trade table */}
      {loading && <div style={{ ...S.card, textAlign:"center", padding:40, color:"#2a2a4a" }}>Loading journal...</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ ...S.card, textAlign:"center", padding:60, color:"#2a2a4a" }}>
          {trades.length === 0 ? "Execute trades on OANDA to build your journal" : "No trades match this filter"}
        </div>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
        {filtered.map(t => {
          const isEdit = editId === t.id;
          return (
            <div key={t.id} style={{ ...S.card, borderLeft:`3px solid ${resColor(t.result)}`, padding:"11px 14px" }}>
              {/* Main row */}
              <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span style={{ fontWeight:800, color:"#ccc", minWidth:62, fontSize:12 }}>{t.pair}</span>
                <span style={{ ...S.badge, color:t.direction==="BUY"?"#00ff88":"#ff4466", background:t.direction==="BUY"?"#003322":"#330011", fontSize:9 }}>{t.direction}</span>
                <span style={{ ...S.badge, color:resColor(t.result), background:"#07071a", fontSize:9 }}>{t.result}</span>
                {t.confidence && <span style={{ ...S.badge, color:"#00ccff", background:"#001a2e", fontSize:9 }}>{t.confidence}%</span>}
                <span style={{ fontFamily:"monospace", color:plColor(t.pl), fontWeight:700, minWidth:72, fontSize:12 }}>
                  {t.pl >= 0 ? "+" : ""}${t.pl.toFixed(2)}
                </span>
                <span style={{ fontFamily:"monospace", fontSize:10, color:"#333", minWidth:48 }}>{t.pips > 0 ? "+" : ""}{t.pips}p</span>
                {t.rr && <span style={{ fontSize:10, color:"#555" }}>RR {t.rr}</span>}
                <span style={{ fontSize:10, color:"#2a2a4a", flex:1 }}>
                  {t.openTime?.slice(5)} → {t.closeTime?.slice(5)}
                </span>
                <button onClick={() => { setEditId(isEdit ? null : t.id); setEditText(t.note); }}
                  style={{ ...S.btn, padding:"3px 9px", background:"transparent", border:"1px solid #13132b", color:"#333", fontSize:9 }}>
                  {t.note ? "Edit" : "+ Note"}
                </button>
              </div>
              {/* Price row */}
              <div style={{ display:"flex", gap:16, marginTop:6, fontSize:10, color:"#2a2a4a" }}>
                <span>Entry {t.entryPrice}</span>
                <span>Exit {t.closePrice}</span>
                {t.sl && <span>SL {t.sl}</span>}
                {t.tp && <span>TP {t.tp}</span>}
                <span>{t.units?.toLocaleString()} units</span>
              </div>
              {/* Note display */}
              {t.note && !isEdit && (
                <div style={{ marginTop:8, padding:"7px 10px", background:"#07071a", borderRadius:6, fontSize:11, color:"#555", fontStyle:"italic", lineHeight:1.6 }}>
                  {t.note}
                </div>
              )}
              {/* Note edit */}
              {isEdit && (
                <div style={{ marginTop:9, display:"flex", gap:8 }}>
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2}
                    style={{ ...S.inp, flex:1, resize:"vertical", fontSize:11 }}
                    placeholder="Notes, rationale, lessons learned..." />
                  <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                    <button onClick={() => saveNote(t.id)} disabled={saving}
                      style={{ ...S.btn, padding:"6px 13px", color:"#00ff88", border:"1px solid #00ff8833", background:"#003322", fontSize:10 }}>
                      {saving ? "..." : "Save"}
                    </button>
                    <button onClick={() => setEditId(null)}
                      style={{ ...S.btn, padding:"6px 13px", color:"#555", border:"1px solid #13132b", background:"transparent", fontSize:10 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── NEWS ─────────────────────────────────────────────────────────────────────
function News() {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchNewsCalendar();
      setEvents(Array.isArray(data) && data.length > 0 ? data : []);
    } catch { setEvents([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const ic = { HIGH:"#ff4466", MED:"#ffcc00", LOW:"#00ccff" };
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
        <div style={S.ph}>Economic Calendar</div>
        <button onClick={load} disabled={loading} style={{ ...S.btn, padding:"9px 18px", color:"#00ccff", border:"1px solid #00ccff44", background:"#001a2e" }}>
          {loading ? "Fetching..." : "↻ Refresh"}
        </button>
      </div>
      <div style={{ marginBottom:12, padding:"7px 11px", background:"#07071a", borderRadius:8, fontSize:11, color:"#555" }}>
        ◉ Real-time data from Forex Factory Calendar
      </div>
      {events.length === 0 && !loading && (
        <div style={{ ...S.card, textAlign:"center", padding:40, color:"#2a2a4a" }}>No events found for this week</div>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
        {events.map((e, i) => (
          <div key={i} style={{ ...S.card, borderLeft:`3px solid ${ic[e.impact]||"#444"}`, display:"flex", alignItems:"flex-start", gap:14 }}>
            <div style={{ fontFamily:"monospace", fontSize:12, color:"#888", minWidth:48, paddingTop:2 }}>{e.time || "—"}</div>
            <div style={{ minWidth:32, fontWeight:800, fontSize:12, color:"#ccc", paddingTop:2 }}>{e.currency || "—"}</div>
            <span style={{ ...S.badge, color:ic[e.impact]||"#444", background:`${ic[e.impact]||"#444"}15`, border:`1px solid ${ic[e.impact]||"#444"}33`, minWidth:60, textAlign:"center", flexShrink:0 }}>{e.impact || "—"}</span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, color:"#aaa" }}>{e.event}</div>
              {e.notes && <div style={{ fontSize:11, color:"#2a2a4a", marginTop:3, lineHeight:1.5 }}>{e.notes}</div>}
            </div>
            <div style={{ fontSize:11, textAlign:"right", flexShrink:0 }}>
              <div style={{ color:"#2a2a4a" }}>FC <span style={{ color:"#00ccff" }}>{e.forecast || "—"}</span></div>
              <div style={{ color:"#2a2a4a" }}>Prev <span style={{ color:"#555" }}>{e.previous || "—"}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ALERTS ───────────────────────────────────────────────────────────────────
function Alerts({ alerts, keys, priceAlerts, setPriceAlerts }) {
  const [testing, setTesting] = useState(false);
  const [newAlertPair, setNewAlertPair]   = useState("EUR_USD");
  const [newAlertPrice, setNewAlertPrice] = useState("");
  const [newAlertDir, setNewAlertDir]     = useState("ABOVE");

  const test = async () => {
    setTesting(true);
    try { await sendTelegram("🤖 <b>Precision Trader Pro</b>\nTelegram connected ✓", keys); alert("Test message sent!"); }
    catch(e) { alert("Telegram error: " + e.message); }
    setTesting(false);
  };

  const addPriceAlert = () => {
    if (!newAlertPrice) return;
    const updated = [...priceAlerts, { id:Date.now(), pair:newAlertPair, price:parseFloat(newAlertPrice), dir:newAlertDir, active:true, created:new Date().toLocaleTimeString() }];
    setPriceAlerts(updated); savePriceAlerts(updated); setNewAlertPrice("");
  };

  const removeAlert = (id) => {
    const updated = priceAlerts.filter(a => a.id !== id);
    setPriceAlerts(updated); savePriceAlerts(updated);
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
        <div style={S.ph}>Alerts</div>
        <button onClick={test} disabled={testing || !keys.tg_token} style={{ ...S.btn, padding:"9px 18px", color:"#00ccff", border:"1px solid #00ccff44", background:"#001a2e" }}>
          {testing ? "Sending..." : "Test Telegram"}
        </button>
      </div>
      <div style={{ ...S.card, marginBottom:16 }}>
        <div style={S.title}>Price Alert — Set New</div>
        <div style={{ display:"flex", gap:9, alignItems:"flex-end", flexWrap:"wrap" }}>
          <div style={{ flex:"0 0 120px" }}>
            <label style={S.lbl}>Pair</label>
            <select value={newAlertPair} onChange={e => setNewAlertPair(e.target.value)} style={S.inp}>
              {PAIRS.map(p => <option key={p} value={p}>{PAIR_LABELS[p]}</option>)}
            </select>
          </div>
          <div style={{ flex:"0 0 80px" }}>
            <label style={S.lbl}>Direction</label>
            <select value={newAlertDir} onChange={e => setNewAlertDir(e.target.value)} style={S.inp}>
              <option value="ABOVE">Above</option>
              <option value="BELOW">Below</option>
            </select>
          </div>
          <div style={{ flex:1, minWidth:120 }}>
            <label style={S.lbl}>Target Price</label>
            <input value={newAlertPrice} onChange={e => setNewAlertPrice(e.target.value)} style={S.inp} type="number" step="0.00001" placeholder="e.g. 1.09500" />
          </div>
          <button onClick={addPriceAlert} style={{ ...S.btn, padding:"9px 20px", color:"#ffcc00", border:"1px solid #ffcc0044", background:"#1a1500", flexShrink:0 }}>
            Add Alert
          </button>
        </div>
        {priceAlerts.length > 0 && (
          <div style={{ marginTop:14 }}>
            <div style={{ fontSize:10, color:"#2a2a4a", letterSpacing:2, marginBottom:8 }}>ACTIVE PRICE ALERTS</div>
            {priceAlerts.map(a => (
              <div key={a.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderBottom:"1px solid #0d0d1e", fontSize:12 }}>
                <span style={{ color:"#ffcc00", minWidth:60 }}>{PAIR_LABELS[a.pair]}</span>
                <span style={{ color:"#555" }}>{a.dir}</span>
                <span style={{ color:"#ccc", fontFamily:"monospace" }}>{a.price.toFixed(5)}</span>
                <span style={{ color:"#2a2a4a", fontSize:10, flex:1 }}>set {a.created}</span>
                <button onClick={() => removeAlert(a.id)} style={{ ...S.btn, padding:"3px 9px", color:"#ff4466", border:"1px solid #ff446633", background:"transparent", fontSize:10 }}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {alerts.length === 0 && <div style={{ ...S.card, textAlign:"center", padding:40, color:"#2a2a4a" }}>Alerts appear when trades execute or AI scans complete</div>}
      <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
        {[...alerts].reverse().map((a, i) => (
          <div key={i} style={{ ...S.card, borderLeft:`3px solid ${a.color}`, display:"flex", alignItems:"center", gap:13 }}>
            <div style={{ fontSize:20 }}>{a.icon}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"#ccc" }}>{a.title}</div>
              <div style={{ fontSize:12, color:"#555", marginTop:2 }}>{a.detail}</div>
            </div>
            <div style={{ fontSize:10, color:"#2a2a4a" }}>{a.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── AI INSIGHTS ─────────────────────────────────────────────────────────────
function AIInsights({ prices }) {
  const [pair, setPair]       = useState("EUR_USD");
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [indicators, setIndicators] = useState(null);
  const [error, setError]     = useState(null);
  const [history, setHistory] = useState([]);

  const analyze = async () => {
    setLoading(true); setResult(null); setIndicators(null); setError(null);
    try {
      const res = await aiAnalyze(PAIR_LABELS[pair], prices[pair] || "unknown");
      setResult(res.analysis);
      setIndicators(res.indicators);
      setHistory(h => [{
        pair:PAIR_LABELS[pair], price:prices[pair],
        text:res.analysis, indicators:res.indicators,
        time:new Date().toLocaleTimeString()
      }, ...h.slice(0, 4)]);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const parseField = (text, label) => {
    if (!text) return null;
    const m = text.match(new RegExp(`${label}:\\s*(.+)`, "i"));
    return m ? m[1].trim() : null;
  };
  const bias   = result ? parseField(result, "Market Bias") : null;
  const conf   = result ? parseField(result, "Confidence Score") : null;
  const bColor = { BULLISH:"#00ff88", BEARISH:"#ff4466", NEUTRAL:"#ffcc00" };

  return (
    <div>
      <div style={S.ph}>AI Insights — GPT-4o Engine</div>
      <div style={{ display:"grid", gridTemplateColumns:"260px 1fr", gap:15 }}>
        <div style={{ display:"flex", flexDirection:"column", gap:13 }}>
          <div style={S.card}>
            <div style={S.title}>Analyze Pair</div>
            <label style={S.lbl}>Pair</label>
            <select value={pair} onChange={e => setPair(e.target.value)} style={{ ...S.inp, marginBottom:12 }}>
              {PAIRS.map(p => <option key={p} value={p}>{PAIR_LABELS[p]}</option>)}
            </select>
            {prices[pair] && <div style={{ fontSize:12, color:"#2a2a4a", marginBottom:12, fontFamily:"monospace" }}>Price: <span style={{ color:"#00ccff" }}>{prices[pair].toFixed(5)}</span></div>}
            <button onClick={analyze} disabled={loading} style={{ ...S.btn, width:"100%", padding:"11px 0", fontWeight:800, letterSpacing:2, background:"#001a2e", color:"#00ccff", border:"1px solid #00ccff55" }}>
              {loading ? "ANALYZING..." : "✦ RUN ANALYSIS"}
            </button>
          </div>
          {history.length > 0 && (
            <div style={S.card}>
              <div style={S.title}>Recent Analyses</div>
              {history.map((h, i) => (
                <div key={i} onClick={() => { setResult(h.text); setIndicators(h.indicators); }}
                  style={{ cursor:"pointer", padding:"8px 0", borderBottom:"1px solid #0d0d1e", fontSize:12 }}>
                  <div style={{ color:"#888", fontWeight:700 }}>{h.pair}</div>
                  <div style={{ color:"#2a2a4a", fontSize:10 }}>{h.time}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:13 }}>
          {/* Indicators Panel — shows real OANDA candle data used */}
          {indicators && (
            <div style={{ ...S.card, borderLeft:"3px solid #00ccff" }}>
              <div style={S.title}>📊 Real OANDA Indicators (H1 — 50 candles)</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 16px" }}>
                {[
                  ["EMA 9",    indicators.ema9?.toFixed?.(5)   || indicators.ema9,  "#ffcc00"],
                  ["EMA 21",   indicators.ema21?.toFixed?.(5)  || indicators.ema21, "#ffcc00"],
                  ["EMA 50",   indicators.ema50?.toFixed?.(5)  || indicators.ema50, "#ffcc00"],
                  ["RSI(14)",  indicators.rsi14, indicators.rsi14>70?"#ff4466":indicators.rsi14<30?"#00ff88":"#bbb"],
                  ["ATR(14)",  indicators.atr14?.toFixed?.(5)  || indicators.atr14, "#bbb"],
                  ["MACD",     indicators.macd,  indicators.macd>0?"#00ff88":"#ff4466"],
                  ["Support",  indicators.support?.toFixed?.(5)||indicators.support,"#00ff88"],
                  ["Resist.",  indicators.resistance?.toFixed?.(5)||indicators.resistance,"#ff4466"],
                ].map(([label, val, color]) => (
                  <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:"1px solid #0d0d1e", fontSize:11 }}>
                    <span style={{ color:"#444" }}>{label}</span>
                    <span style={{ color, fontFamily:"monospace", fontWeight:700 }}>{val}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:8, fontSize:10, padding:"5px 8px", background:"#07071a", borderRadius:6 }}>
                <span style={{ color:"#00ccff" }}>H1: </span><span style={{ color:"#555" }}>{indicators.trend}</span>
                <span style={{ color:"#00ccff", marginLeft:8 }}>H4: </span><span style={{ color:"#555" }}>{indicators.h4Trend}</span>
              </div>
              <div style={{ marginTop:4, fontSize:10, padding:"5px 8px", background:"#07071a", borderRadius:6, color:"#555" }}>
                EMA: {indicators.emaAlignment}
              </div>
              {indicators.rsi14 > 70 && (
                <div style={{ marginTop:6, padding:"5px 10px", background:"#330011", borderRadius:6, fontSize:11, color:"#ff4466" }}>
                  ⚠ RSI {indicators.rsi14} — OVERBOUGHT. High risk of pullback.
                </div>
              )}
              {indicators.rsi14 < 30 && (
                <div style={{ marginTop:6, padding:"5px 10px", background:"#003311", borderRadius:6, fontSize:11, color:"#00ff88" }}>
                  ⚠ RSI {indicators.rsi14} — OVERSOLD. Possible bounce zone.
                </div>
              )}
            </div>
          )}

          <div style={S.card}>
            {!result && !loading && !error && (
              <div style={{ height:220, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#1a1a30" }}>
                <div style={{ fontSize:44, marginBottom:12 }}>✦</div>
                <div style={{ fontSize:12 }}>Analysis uses real 50-candle OANDA data</div>
                <div style={{ fontSize:10, color:"#1a1a30", marginTop:6 }}>EMA, RSI, ATR, Support/Resistance all calculated live</div>
              </div>
            )}
            {loading && (
              <div style={{ height:220, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
                <div style={{ color:"#00ccff", letterSpacing:3, fontSize:12, animation:"pulse 1s infinite" }}>FETCHING CANDLES + ANALYZING...</div>
                <div style={{ color:"#2a2a4a", marginTop:10, fontSize:11 }}>50 H1 candles + 20 H4 candles from OANDA</div>
                <div style={{ color:"#1a1a30", marginTop:4, fontSize:11 }}>{PAIR_LABELS[pair]}</div>
              </div>
            )}
            {error && (
              <div style={{ padding:20, color:"#ff4466", fontSize:13, background:"#1a0808", borderRadius:8, margin:10 }}>
                ⚠ {error}
              </div>
            )}
            {result && (
              <div>
                <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
                  <div style={{ fontSize:10, color:"#00ccff", letterSpacing:2 }}>✦ GPT-4o + Real Candles — {PAIR_LABELS[pair]}</div>
                  {bias && <span style={{ ...S.badge, color:bColor[bias.toUpperCase()]||"#aaa", background:`${bColor[bias.toUpperCase()]||"#aaa"}20`, border:`1px solid ${bColor[bias.toUpperCase()]||"#aaa"}33` }}>{bias.toUpperCase()}</span>}
                  {conf && <span style={{ fontSize:11, fontFamily:"monospace", color:"#ffcc00" }}>{conf}</span>}
                  <span style={{ fontSize:9, color:"#2a2a4a", marginLeft:"auto" }}>based on real OANDA candles</span>
                </div>
                <div style={{ fontSize:12, color:"#bbb", lineHeight:2, whiteSpace:"pre-wrap", fontFamily:"monospace" }}>{result}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
function Analytics({ account, trades: openTrades }) {
  const [history,  setHistory]  = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [daily,    setDaily]    = useState(null);
  const [autoLog,  setAutoLog]  = useState([]);
  const [outcomes, setOutcomes] = useState(null);
  const [slippage, setSlippage] = useState(null);
  const [atab,     setAtab]     = useState("performance");

  const load = async () => {
    setLoading(true);
    const [h, d, a, o, sl] = await Promise.all([
      fetch("/api/history?count=100").then(r => r.json()).catch(() => null),
      fetch("/api/trade/daily").then(r => r.json()).catch(() => null),
      fetch("/api/autotrade/log").then(r => r.json()).catch(() => []),
      fetch("/api/trade/outcomes").then(r => r.json()).catch(() => null),
      fetch("/api/execution/slippage").then(r => r.json()).catch(() => null),
    ]);
    if (h && !h.error) setHistory(h);
    if (d) setDaily(d);
    setAutoLog(a || []);
    if (o && !o.error) setOutcomes(o);
    if (sl && !sl.error) setSlippage(sl);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const st = history?.stats || {};
  const wr = parseInt(st.win_rate || 0);

  // P&L bar chart from last 20 trades
  const plData = (history?.trades || []).slice(0, 20).reverse().map(t => t.pl);
  const maxAbs = Math.max(...plData.map(Math.abs), 1);

  // Pair stats from history
  const pairStats = {};
  (history?.trades || []).forEach(t => {
    if (!pairStats[t.pair]) pairStats[t.pair] = { total:0, won:0, pl:0 };
    pairStats[t.pair].total++;
    if (t.pl > 0) pairStats[t.pair].won++;
    pairStats[t.pair].pl += t.pl;
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={S.ph}>Trading Analytics</div>
        <button onClick={load} style={{ ...S.btn, color:"#00ccff", border:"1px solid #00ccff44", background:"#001a2e", padding:"6px 14px" }}>↻ Refresh</button>
      </div>

      {/* Tab bar */}
      <div style={{ display:"flex", gap:4, borderBottom:"1px solid #13132b", paddingBottom:0 }}>
        {[
          { id:"performance", label:"Performance" },
          { id:"outcomes",    label:"Trade Outcomes" },
          { id:"execution",   label:"Execution Quality" },
        ].map(t => (
          <div key={t.id} onClick={() => setAtab(t.id)} style={{
            padding:"8px 18px", fontSize:11, fontWeight:atab===t.id?700:400, cursor:"pointer",
            color:atab===t.id?"#00ccff":"#333", borderBottom:atab===t.id?"2px solid #00ccff":"2px solid transparent",
            letterSpacing:1, textTransform:"uppercase",
          }}>{t.label}</div>
        ))}
      </div>

      {/* ── TRADE OUTCOMES TAB ──────────────────────────────────────────── */}
      {atab === "outcomes" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {(!outcomes || outcomes.stats?.total === 0) && (
            <div style={{ ...S.card, textAlign:"center", padding:"40px 20px" }}>
              <div style={{ fontSize:28, marginBottom:12 }}>📊</div>
              <div style={{ color:"#bbb", fontSize:13, marginBottom:8 }}>No reconciled trade outcomes yet</div>
              <div style={{ color:"#444", fontSize:11 }}>Trades execute → OANDA closes them → reconciliation auto-syncs every 2 min</div>
            </div>
          )}
          {outcomes && outcomes.stats?.total > 0 && (() => {
            const s = outcomes.stats;
            return (
              <>
                {/* KPIs */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:11 }}>
                  {[
                    { l:"Win Rate",       v: s.win_rate_pct != null ? `${s.win_rate_pct}%` : "—",
                      c: s.win_rate_pct>=50?"#00ff88":"#ff4466" },
                    { l:"Expectancy/Trade", v: s.expectancy_per_trade ? `${parseFloat(s.expectancy_per_trade)>=0?"+":""}$${s.expectancy_per_trade}` : "—",
                      c: parseFloat(s.expectancy_per_trade||0)>=0?"#00ff88":"#ff4466" },
                    { l:"Real R:R",       v: s.real_rr ? `1:${s.real_rr}` : "—", c:"#ff88ff" },
                    { l:"Total P&L",      v: `${parseFloat(s.total_pl)>=0?"+":""}$${s.total_pl}`,
                      c: parseFloat(s.total_pl)>=0?"#00ff88":"#ff4466" },
                  ].map(k => (
                    <div key={k.l} style={S.card}>
                      <div style={S.title}>{k.l}</div>
                      <div style={{ fontSize:22, fontFamily:"monospace", color:k.c, fontWeight:800, marginTop:4 }}>{k.v}</div>
                    </div>
                  ))}
                </div>

                {/* Second row */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:11 }}>
                  {[
                    { l:"Wins",          v: s.wins,    c:"#00ff88" },
                    { l:"Losses",        v: s.losses,  c:"#ff4466" },
                    { l:"Max Drawdown",  v: `$${s.max_drawdown}`, c:"#ffcc00" },
                    { l:"Avg Duration",  v: s.avg_duration_mins ? `${s.avg_duration_mins}m` : "—", c:"#bbb" },
                  ].map(k => (
                    <div key={k.l} style={S.card}>
                      <div style={S.title}>{k.l}</div>
                      <div style={{ fontSize:20, fontFamily:"monospace", color:k.c, fontWeight:800, marginTop:4 }}>{k.v}</div>
                    </div>
                  ))}
                </div>

                {/* Exit reason breakdown */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:13 }}>
                  <div style={S.card}>
                    <div style={S.title}>Exit Reasons</div>
                    {[
                      ["TP Hit",  outcomes.by_exit_reason?.TP_HIT,  "#00ff88"],
                      ["SL Hit",  outcomes.by_exit_reason?.SL_HIT,  "#ff4466"],
                      ["Manual",  outcomes.by_exit_reason?.MANUAL,  "#ffcc00"],
                    ].map(([l, v, c]) => {
                      const total = s.total || 1;
                      const pct = Math.round((v||0) / total * 100);
                      return (
                        <div key={l} style={{ marginBottom:10 }}>
                          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:4 }}>
                            <span style={{ color:"#888" }}>{l}</span>
                            <span style={{ color:c, fontFamily:"monospace" }}>{v||0} ({pct}%)</span>
                          </div>
                          <div style={{ height:4, background:"#0d0d1e", borderRadius:2 }}>
                            <div style={{ height:"100%", width:`${pct}%`, background:c, borderRadius:2 }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Closed trades list */}
                  <div style={{ ...S.card, maxHeight:280, overflowY:"auto" }}>
                    <div style={S.title}>Closed Trades ({s.total})</div>
                    {outcomes.trades.map(t => {
                      const win = (t.realized_pl||0) > 0;
                      const dp  = t.pair?.includes("JPY")||t.pair?.includes("XAU") ? 2 : 5;
                      return (
                        <div key={t.id} style={{ padding:"8px 0", borderBottom:"1px solid #0d0d1e", fontSize:11 }}>
                          <div style={{ display:"flex", justifyContent:"space-between" }}>
                            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                              <span style={{ fontWeight:800, color:"#ccc" }}>{t.pair}</span>
                              <span style={{ ...S.badge, color:t.direction==="BUY"?"#00ff88":"#ff4466",
                                background:t.direction==="BUY"?"#003322":"#330011" }}>{t.direction}</span>
                              <span style={{ ...S.badge, color:win?"#00ff88":"#ff4466",
                                background:win?"#003322":"#330011" }}>{t.exit_reason?.replace("_"," ") || "?"}</span>
                            </div>
                            <span style={{ color:win?"#00ff88":"#ff4466", fontFamily:"monospace", fontWeight:700 }}>
                              {(t.realized_pl||0)>=0?"+":""}${parseFloat(t.realized_pl||0).toFixed(2)}
                            </span>
                          </div>
                          <div style={{ color:"#333", marginTop:3 }}>
                            {t.actual_pips ? `${parseFloat(t.actual_pips)>=0?"+":""}${t.actual_pips} pips` : ""}
                            {t.duration_mins ? ` · ${t.duration_mins}m` : ""}
                            {t.confidence ? ` · ${t.confidence}% conf` : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* ── EXECUTION QUALITY TAB ────────────────────────────────────────── */}
      {atab === "execution" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {(!slippage || slippage.total_fills === 0) && (
            <div style={{ ...S.card, textAlign:"center", padding:"40px 20px" }}>
              <div style={{ fontSize:28, marginBottom:12 }}>⚡</div>
              <div style={{ color:"#bbb", fontSize:13, marginBottom:8 }}>No execution data yet</div>
              <div style={{ color:"#444", fontSize:11 }}>Fill quality metrics appear after first executed trade</div>
            </div>
          )}
          {slippage && slippage.total_fills > 0 && (
            <>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:11 }}>
                {[
                  { l:"Total Fills",      v: slippage.total_fills,  c:"#ccc" },
                  { l:"Avg Slippage",     v: `${slippage.avg_slippage_pips} pips`,
                    c: parseFloat(slippage.avg_slippage_pips)>2?"#ff4466":parseFloat(slippage.avg_slippage_pips)>1?"#ffcc00":"#00ff88" },
                  { l:"Max Slippage",     v: `${slippage.max_slippage_pips} pips`,
                    c: parseFloat(slippage.max_slippage_pips)>5?"#ff4466":"#ffcc00" },
                  { l:"Avg Latency",      v: `${slippage.avg_latency_ms}ms`,
                    c: parseInt(slippage.avg_latency_ms)>3000?"#ffcc00":parseInt(slippage.avg_latency_ms)>5000?"#ff4466":"#00ff88" },
                ].map(k => (
                  <div key={k.l} style={S.card}>
                    <div style={S.title}>{k.l}</div>
                    <div style={{ fontSize:22, fontFamily:"monospace", color:k.c, fontWeight:800, marginTop:4 }}>{k.v}</div>
                  </div>
                ))}
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:13 }}>
                {/* Slippage direction */}
                <div style={S.card}>
                  <div style={S.title}>Fill Direction</div>
                  <div style={{ marginTop:12 }}>
                    {[
                      ["Positive slippage (better fill)", slippage.positive_slippage, "#00ff88"],
                      ["Negative slippage (worse fill)",  slippage.negative_slippage, "#ff4466"],
                    ].map(([l, v, c]) => {
                      const pct = Math.round((v||0) / slippage.total_fills * 100);
                      return (
                        <div key={l} style={{ marginBottom:14 }}>
                          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:5 }}>
                            <span style={{ color:"#666" }}>{l}</span>
                            <span style={{ color:c, fontFamily:"monospace" }}>{v} ({pct}%)</span>
                          </div>
                          <div style={{ height:6, background:"#0d0d1e", borderRadius:3 }}>
                            <div style={{ height:"100%", width:`${pct}%`, background:c, borderRadius:3 }} />
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ fontSize:11, color:"#444", marginTop:8, padding:"8px 0", borderTop:"1px solid #0d0d1e" }}>
                      Positive = filled better than market price (rare)<br/>
                      Negative = filled worse than expected (normal)
                    </div>
                  </div>
                </div>

                {/* Slippage by pair */}
                <div style={S.card}>
                  <div style={S.title}>Slippage by Pair</div>
                  {Object.entries(slippage.by_pair || {}).map(([pair, ps]) => (
                    <div key={pair} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid #0d0d1e", fontSize:11 }}>
                      <span style={{ color:"#888", fontWeight:700 }}>{pair}</span>
                      <div style={{ display:"flex", gap:12, fontFamily:"monospace" }}>
                        <span style={{ color:"#444" }}>{ps.count} fills</span>
                        <span style={{ color:parseFloat(ps.avgSlip)>2?"#ff4466":parseFloat(ps.avgSlip)>1?"#ffcc00":"#00ff88" }}>
                          avg {ps.avgSlip} pips
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent fills */}
              <div style={S.card}>
                <div style={S.title}>Recent Fills</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr", gap:6, fontSize:10, color:"#333", padding:"6px 0", borderBottom:"1px solid #0d0d1e", marginBottom:4 }}>
                  {["Pair","Session","Expected","Actual","Slippage","Direction"].map(h => <div key={h}>{h}</div>)}
                </div>
                {(slippage.recent || []).map((f, i) => (
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr", gap:6, fontSize:11, padding:"5px 0", borderBottom:"1px solid #0a0a18" }}>
                    <span style={{ color:"#bbb", fontWeight:700 }}>{f.pair}</span>
                    <span style={{ color:"#555" }}>{f.session}</span>
                    <span style={{ fontFamily:"monospace", color:"#888" }}>{parseFloat(f.expected_px||0).toFixed(5)}</span>
                    <span style={{ fontFamily:"monospace", color:"#888" }}>{parseFloat(f.actual_px||0).toFixed(5)}</span>
                    <span style={{ fontFamily:"monospace", color:parseFloat(f.slippage_pips)>2?"#ff4466":"#888" }}>
                      {parseFloat(f.slippage_pips||0).toFixed(1)}p
                    </span>
                    <span style={{ color:f.slippage_dir==="NEGATIVE"?"#ff4466":"#00ff88" }}>{f.slippage_dir}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PERFORMANCE TAB ─────────────────────────────────────────────── */}
      {atab === "performance" && (
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      {/* Top KPI row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:11 }}>
        {[
          { l:"Total Trades",  v: st.total || 0,                          c:"#ccc" },
          { l:"Won ✅",         v: st.won   || 0,                          c:"#00ff88" },
          { l:"Lost ❌",        v: st.lost  || 0,                          c:"#ff4466" },
          { l:"Win Rate",      v: `${wr}%`,                                c: wr>=50?"#00ff88":"#ff4466" },
          { l:"Total P&L",     v: st.total_pl ? `$${parseFloat(st.total_pl)>=0?"+":""}${st.total_pl}` : "—", c: parseFloat(st.total_pl||0)>=0?"#00ff88":"#ff4466" },
        ].map(k => (
          <div key={k.l} style={S.card}>
            <div style={S.title}>{k.l}</div>
            <div style={{ fontSize:22, fontFamily:"monospace", color:k.c, fontWeight:800, marginTop:4 }}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Second row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:11 }}>
        {[
          { l:"Avg Win",   v: st.avg_win  ? `+$${st.avg_win}`  : "—", c:"#00ff88" },
          { l:"Avg Loss",  v: st.avg_loss ? `$${st.avg_loss}`  : "—", c:"#ff4466" },
          { l:"R:R Ratio", v: st.rr || "—",                             c:"#ff88ff" },
          { l:"Today P&L", v: daily ? `${parseFloat(daily.realized_pl)>=0?"+":""}$${daily.realized_pl}` : "—",
                           c: parseFloat(daily?.realized_pl||0)>=0?"#00ff88":"#ff4466" },
        ].map(k => (
          <div key={k.l} style={S.card}>
            <div style={S.title}>{k.l}</div>
            <div style={{ fontSize:20, fontFamily:"monospace", color:k.c, fontWeight:800, marginTop:4 }}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* P&L bar chart + daily limit */}
      <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:13 }}>
        <div style={S.card}>
          <div style={S.title}>P&L per Trade (last 20 closed)</div>
          {plData.length === 0 && loading && <div style={{ color:"#2a2a4a", fontSize:12, padding:"20px 0", textAlign:"center" }}>Loading...</div>}
          {plData.length === 0 && !loading && <div style={{ color:"#2a2a4a", fontSize:12, padding:"20px 0", textAlign:"center" }}>No closed trades yet</div>}
          <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:80, marginTop:10 }}>
            {plData.map((pl, i) => {
              const h = Math.max(4, Math.abs(pl / maxAbs) * 76);
              const up = pl >= 0;
              return (
                <div key={i} title={`${up?"+":""}$${pl.toFixed(2)}`}
                  style={{ flex:1, height:h, background:up?"#00ff8888":"#ff446688",
                    borderRadius:up?"3px 3px 0 0":"0 0 3px 3px",
                    alignSelf:up?"flex-end":"flex-start",
                    border:`1px solid ${up?"#00ff8833":"#ff446633"}`,
                    cursor:"pointer", transition:"opacity 0.2s" }} />
              );
            })}
          </div>
        </div>
        {daily && (
          <div style={{ ...S.card, borderLeft:`3px solid ${daily.limit_hit?"#ff4466":parseFloat(daily.used_percent)>60?"#ffcc00":"#00ff88"}` }}>
            <div style={S.title}>Daily Limit (3% Rule)</div>
            <div style={{ height:6, background:"#0d0d1e", borderRadius:3, marginBottom:12, marginTop:6 }}>
              <div style={{ height:"100%", width:`${Math.min(100, parseFloat(daily.used_percent))}%`,
                background:daily.limit_hit?"#ff4466":parseFloat(daily.used_percent)>60?"#ffcc00":"#00ff88",
                borderRadius:3, transition:"width 0.5s" }} />
            </div>
            {[
              ["Used",   `${daily.used_percent}%`, daily.limit_hit?"#ff4466":parseFloat(daily.used_percent)>60?"#ffcc00":"#00ff88"],
              ["P&L",   `${parseFloat(daily.realized_pl)>=0?"+":""}$${daily.realized_pl}`, parseFloat(daily.realized_pl)>=0?"#00ff88":"#ff4466"],
              ["Limit", `$${daily.max_daily_loss}`, "#ff4466"],
              ["Trades", daily.trade_count, "#bbb"],
              ["Safe",  daily.safe_to_trade?"YES":"STOP", daily.safe_to_trade?"#00ff88":"#ff4466"],
            ].map(([l,v,c]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #0d0d1e", fontSize:11 }}>
                <span style={{ color:"#444" }}>{l}</span>
                <span style={{ color:c, fontFamily:"monospace", fontWeight:700 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pair breakdown */}
      {Object.keys(pairStats).length > 0 && (
        <div style={S.card}>
          <div style={S.title}>Performance by Pair</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
            {Object.entries(pairStats).map(([pair, ps]) => {
              const pWr = Math.round(ps.won / ps.total * 100);
              return (
                <div key={pair} style={{ background:"#08081a", borderRadius:8, padding:"10px 12px", border:"1px solid #0d0d1e" }}>
                  <div style={{ fontWeight:800, color:"#ccc", fontSize:12, marginBottom:7 }}>{pair}</div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:4 }}>
                    <span style={{ color:"#444" }}>Trades</span>
                    <span style={{ color:"#bbb", fontFamily:"monospace" }}>{ps.total}</span>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:4 }}>
                    <span style={{ color:"#444" }}>Win Rate</span>
                    <span style={{ color:pWr>=50?"#00ff88":"#ff4466", fontFamily:"monospace" }}>{pWr}%</span>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:6 }}>
                    <span style={{ color:"#444" }}>P&L</span>
                    <span style={{ color:ps.pl>=0?"#00ff88":"#ff4466", fontFamily:"monospace", fontWeight:700 }}>
                      {ps.pl>=0?"+":""}${ps.pl.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ height:3, background:"#0d0d1e", borderRadius:2 }}>
                    <div style={{ height:"100%", width:`${pWr}%`, background:pWr>=50?"#00ff88":"#ff4466", borderRadius:2 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Full closed trade history table */}
      <div style={S.card}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={S.title}>Closed Trade History ({history?.trades?.length || 0} trades)</div>
          {autoLog.length > 0 && (
            <span style={{ fontSize:10, color:"#00ccff", background:"#001a2e", padding:"3px 9px", borderRadius:12, border:"1px solid #00ccff33" }}>
              ⚡ {autoLog.length} auto-trades
            </span>
          )}
        </div>
        {loading && <div style={{ color:"#2a2a4a", fontSize:12, padding:"20px", textAlign:"center" }}>Loading trade history...</div>}
        {!loading && (!history?.trades || history.trades.length === 0) && (
          <div style={{ color:"#2a2a4a", fontSize:12, padding:"20px", textAlign:"center" }}>
            No closed trades found in your OANDA account
          </div>
        )}
        {(history?.trades || []).map((t, i) => {
          const isAuto = autoLog.some(a => Math.abs(a.entry_price - parseFloat(t.entryPrice)) < 0.0002 && a.pair === t.pair);
          return (
            <div key={t.id || i} style={{ padding:"10px 12px", background:i%2===0?"#07071a":"#08081a",
              borderRadius:7, marginBottom:4, border:"1px solid #0d0d1e",
              borderLeft:`3px solid ${t.pl>0?"#00ff88":t.pl<0?"#ff4466":"#333"}` }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                <span style={{ fontWeight:800, color:"#ccc", fontSize:12, minWidth:50 }}>{t.pair}</span>
                <span style={{ ...S.badge, color:t.direction==="BUY"?"#00ff88":"#ff4466",
                  background:t.direction==="BUY"?"#003322":"#330011", fontSize:9 }}>{t.direction}</span>
                {isAuto && <span style={{ ...S.badge, background:"#001a2e", color:"#00ccff", fontSize:9 }}>⚡AUTO</span>}
                <span style={{ flex:1 }} />
                <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:800,
                  color:t.pl>0?"#00ff88":t.pl<0?"#ff4466":"#555" }}>
                  {t.pl>0?"+":""}${t.pl.toFixed(2)}
                </span>
                <span style={{ fontSize:10, color:t.pl>0?"#00ff8866":t.pl<0?"#ff446666":"#333", fontFamily:"monospace" }}>
                  ({t.pips>0?"+":""}{t.pips} pips)
                </span>
              </div>
              <div style={{ display:"flex", gap:14, fontSize:10, color:"#333" }}>
                <span>Entry: <span style={{ color:"#555" }}>{t.entryPrice}</span></span>
                <span>Close: <span style={{ color:"#555" }}>{t.closePrice}</span></span>
                <span>Units: <span style={{ color:"#555" }}>{t.units?.toLocaleString()}</span></span>
                {t.sl && <span>SL: <span style={{ color:"#ff446688" }}>{t.sl}</span></span>}
                {t.tp && <span>TP: <span style={{ color:"#00ff8888" }}>{t.tp}</span></span>}
                <span style={{ marginLeft:"auto" }}>{t.closeTime}</span>
              </div>
            </div>
          );
        })}
      </div>
      </div>
      )}
    </div>
  );
}

// ─── BACKTEST ─────────────────────────────────────────────────────────────────
const PAIRS_BT = ["EUR_USD","GBP_USD","USD_JPY","XAU_USD","AUD_USD","USD_CAD"];

function BtEquityCurve({ data }) {
  if (!data || data.length < 2) return null;
  const W = 600, H = 130, PAD = 16;
  const pips = data.map(d => d.pips);
  const min  = Math.min(...pips, 0), max = Math.max(...pips, 0);
  const range = max - min || 1;
  const toX = i => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const toY = v => H - PAD - ((v - min) / range) * (H - PAD * 2);
  const zero = toY(0);
  const pts  = data.map((d, i) => `${toX(i)},${toY(d.pips)}`).join(' ');
  const last = data[data.length - 1].pips;
  const col  = last >= 0 ? "#00ff88" : "#ff4466";
  const fill = `${toX(0)},${zero} ${pts} ${toX(data.length - 1)},${zero}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:130 }}>
      <line x1={PAD} y1={zero} x2={W-PAD} y2={zero} stroke="#1a1a30" strokeWidth={1} strokeDasharray="3 3" />
      <polygon points={fill} fill={col} fillOpacity={0.07} />
      <polyline points={pts} fill="none" stroke={col} strokeWidth={1.5} />
      <circle cx={toX(data.length-1)} cy={toY(last)} r={3} fill={col} />
      <text x={PAD} y={12} fill="#2a2a4a" fontSize={9}>{max.toFixed(0)}p</text>
      <text x={PAD} y={H-3} fill="#2a2a4a" fontSize={9}>{min.toFixed(0)}p</text>
    </svg>
  );
}

function Backtest() {
  const today    = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [pair,    setPair]    = useState("EUR_USD");
  const [from,    setFrom]    = useState(monthAgo);
  const [to,      setTo]      = useState(today);
  const [dir,     setDir]     = useState("BOTH");
  const [minSc,   setMinSc]   = useState(9);
  const [minConf, setMinConf] = useState(70);
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState(null);
  const [expand,  setExpand]  = useState(null);

  const run = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair, from, to, direction: dir, minScore: minSc, minConf }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Backtest failed');
      setResult(d);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const s     = result?.stats || {};
  const sigs  = result?.signals || [];
  const curve = result?.equityCurve || [];

  const resColor = r => r === 'WIN' ? '#00ff88' : r === 'LOSS' ? '#ff4466' : '#ffcc00';
  const plColor  = v => parseFloat(v) >= 0 ? '#00ff88' : '#ff4466';

  const inp = { ...S.inp, padding:"7px 10px", fontSize:11 };
  const lbl = { fontSize:10, color:"#2a2a4a", marginBottom:4, letterSpacing:1, textTransform:"uppercase" };

  return (
    <div style={{ padding:"0 2px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <div style={S.ph}>Backtest Engine</div>
        <div style={{ fontSize:11, color:"#2a2a4a" }}>Walk-forward · M30 scan · SL/TP simulation</div>
      </div>

      {/* Config panel */}
      <div style={{ ...S.card, marginBottom:14 }}>
        <div style={{ display:"flex", gap:12, flexWrap:"wrap", alignItems:"flex-end" }}>
          <div style={{ flex:"1 1 120px" }}>
            <div style={lbl}>Pair</div>
            <select value={pair} onChange={e => setPair(e.target.value)} style={inp}>
              {PAIRS_BT.map(p => <option key={p} value={p}>{p.replace('_','/')}</option>)}
            </select>
          </div>
          <div style={{ flex:"1 1 120px" }}>
            <div style={lbl}>From</div>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
          </div>
          <div style={{ flex:"1 1 120px" }}>
            <div style={lbl}>To</div>
            <input type="date" value={to}   onChange={e => setTo(e.target.value)}   style={inp} />
          </div>
          <div style={{ flex:"1 1 100px" }}>
            <div style={lbl}>Direction</div>
            <select value={dir} onChange={e => setDir(e.target.value)} style={inp}>
              <option value="BOTH">Both</option>
              <option value="BUY">BUY only</option>
              <option value="SELL">SELL only</option>
            </select>
          </div>
          <div style={{ flex:"1 1 90px" }}>
            <div style={lbl}>Min Score (/12)</div>
            <input type="number" min={6} max={12} value={minSc} onChange={e => setMinSc(+e.target.value)} style={inp} />
          </div>
          <div style={{ flex:"1 1 90px" }}>
            <div style={lbl}>Min Conf %</div>
            <input type="number" min={50} max={95} value={minConf} onChange={e => setMinConf(+e.target.value)} style={inp} />
          </div>
          <button onClick={run} disabled={loading}
            style={{ ...S.btn, padding:"9px 22px", color:"#00ccff", border:"1px solid #00ccff44", background:"#001a2e", fontWeight:700, fontSize:12, flexShrink:0 }}>
            {loading ? "Running..." : "▶ Run Backtest"}
          </button>
        </div>
        {loading && (
          <div style={{ marginTop:12, fontSize:11, color:"#2a2a4a" }}>
            Fetching candles from OANDA and replaying signals... this takes 5-15 seconds.
          </div>
        )}
      </div>

      {error && <div style={{ ...S.card, color:"#ff4466", marginBottom:14 }}>{error}</div>}

      {result && (
        <>
          {/* Stats row */}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
            {[
              { label:"Signals",   value:s.total,           color:"#ccc" },
              { label:"Win Rate",  value:`${s.winRate}%`,   color:s.winRate >= 50 ? "#00ff88" : "#ff4466" },
              { label:"Total Pips",value:`${s.totalPips > 0 ? "+" : ""}${s.totalPips}p`, color:plColor(s.totalPips) },
              { label:"Avg Win",   value:`+${s.avgWin}p`,   color:"#00ff88" },
              { label:"Avg Loss",  value:`${s.avgLoss}p`,   color:"#ff4466" },
              { label:"Avg R:R",   value:s.avgRR,           color:"#00ccff" },
              { label:"Max DD",    value:`-${s.maxDD}p`,    color:"#ff8844" },
              { label:"Won/Lost",  value:`${s.won}/${s.lost}`, color:"#ccc" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ ...S.card, flex:1, minWidth:80, textAlign:"center", padding:"11px 8px" }}>
                <div style={{ fontSize:9, color:"#2a2a4a", letterSpacing:2, marginBottom:4, textTransform:"uppercase" }}>{label}</div>
                <div style={{ fontSize:18, fontWeight:900, color, fontFamily:"monospace" }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Equity curve */}
          {curve.length > 1 && (
            <div style={{ ...S.card, marginBottom:14, padding:"14px 16px" }}>
              <div style={{ fontSize:10, color:"#2a2a4a", letterSpacing:2, marginBottom:8, textTransform:"uppercase" }}>Equity Curve (pips)</div>
              <BtEquityCurve data={curve} />
            </div>
          )}

          {/* Signal list */}
          {sigs.length === 0 && (
            <div style={{ ...S.card, textAlign:"center", padding:40, color:"#2a2a4a" }}>
              No signals met the criteria — try lowering minScore or minConf
            </div>
          )}
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {sigs.map((s, idx) => {
              const isOpen = expand === idx;
              return (
                <div key={idx} style={{ ...S.card, borderLeft:`3px solid ${resColor(s.result)}`, padding:"10px 14px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:9, cursor:"pointer" }} onClick={() => setExpand(isOpen ? null : idx)}>
                    <span style={{ fontSize:10, color:"#2a2a4a", minWidth:115, fontFamily:"monospace" }}>{s.time}</span>
                    <span style={{ fontWeight:800, color:"#ccc", minWidth:60, fontSize:11 }}>{s.pair}</span>
                    <span style={{ ...S.badge, color:s.direction==="BUY"?"#00ff88":"#ff4466", background:s.direction==="BUY"?"#003322":"#330011", fontSize:9 }}>{s.direction}</span>
                    <span style={{ ...S.badge, color:resColor(s.result), background:"#07071a", fontSize:9 }}>{s.result}</span>
                    <span style={{ ...S.badge, color:"#00ccff", background:"#001a2e", fontSize:9 }}>{s.score}/{s.maxScore}</span>
                    <span style={{ ...S.badge, color:"#aaa", background:"#0a0a1e", fontSize:9 }}>{s.confidence}%</span>
                    <span style={{ fontFamily:"monospace", color:plColor(s.pips), fontWeight:700, minWidth:60, fontSize:11 }}>
                      {s.pips > 0 ? "+" : ""}{s.pips}p
                    </span>
                    <span style={{ fontSize:10, color:"#333" }}>RR {s.rr}</span>
                    <span style={{ fontSize:10, color:"#2a2a4a", flex:1 }}>{s.session}</span>
                    <span style={{ fontSize:10, color:"#2a2a4a" }}>{isOpen ? "▲" : "▼"}</span>
                  </div>
                  {isOpen && (
                    <div style={{ marginTop:10, display:"flex", gap:16, flexWrap:"wrap", fontSize:10 }}>
                      <div style={{ color:"#2a2a4a" }}>Entry <span style={{ color:"#ccc" }}>{s.entry}</span></div>
                      <div style={{ color:"#2a2a4a" }}>Exit <span style={{ color:"#ccc" }}>{s.exitPrice}</span></div>
                      <div style={{ color:"#2a2a4a" }}>SL <span style={{ color:"#ff4466" }}>{s.sl}</span></div>
                      <div style={{ color:"#2a2a4a" }}>TP <span style={{ color:"#00ff88" }}>{s.tp}</span></div>
                      <div style={{ color:"#2a2a4a" }}>Bars to exit <span style={{ color:"#ccc" }}>{s.exitBars}</span></div>
                      {s.failedChecks.length > 0 && (
                        <div style={{ color:"#ff446699" }}>Failed: {s.failedChecks.join(", ")}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function Settings({ keys, setKeys, aiReady }) {
  const [local, setLocal] = useState(keys);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setKeys(local);
    await saveKeys(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const field = (k, type = "password", ph = "") => ({
    value: local[k] || "",
    onChange: e => setLocal(p => ({ ...p, [k]: e.target.value })),
    style: { ...S.inp, marginBottom:10 },
    type,
    placeholder: ph || "Enter key...",
  });

  return (
    <div>
      <div style={S.ph}>Settings & API Keys</div>
      <div style={{ ...S.card, marginBottom:13, padding:"10px 15px", fontSize:12, color:"#555", borderLeft:"3px solid #ffcc00" }}>
        ⚠ Keys are stored in the server database — secure and accessible from any device.
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <div style={{ ...S.card, gridColumn:"1/-1", borderLeft:"3px solid #00ff88", background:"#001a0e" }}>
          <div style={{ ...S.title, color:"#00ff88" }}>🧠 Dual AI Engine — Calc + GPT-4o</div>
          <div style={{ fontSize:12, color:"#aaa", lineHeight:1.7 }}>
            Two-layer signal validation for maximum precision:<br/>
            <span style={{ color:"#00ccff" }}>① Rule Engine</span> — 12-check score (H4→H2→M30→M5), instant, no API. Blocks bad setups before spending credits.<br/>
            <span style={{ color:"#ffcc00" }}>② GPT-4o</span> — only called if Rule Engine passes. Validates direction, refines SL/TP at real S/R levels, sets final confidence.<br/>
            Signal fires only if <strong>both layers agree</strong>.<br/>
            <span style={{ color:"#00ff88" }}>If no OpenAI key → Rule Engine alone decides.</span>
          </div>
        </div>
        <div style={S.card}>
          <div style={S.title}>OpenAI — GPT-4o Validator</div>
          <label style={S.lbl}>API Key</label>
          <input {...field("openai_key")} />
          <div style={{ fontSize:10, color:"#2a2a4a", marginTop:5, lineHeight:1.6 }}>
            Used as the 2nd validation layer. Get at platform.openai.com
          </div>
        </div>
        <div style={S.card}>
          <div style={S.title}>OANDA</div>
          <label style={S.lbl}>API Key</label>
          <input {...field("oanda_key")} />
          <label style={S.lbl}>Account ID</label>
          <input {...field("oanda_account", "text", "101-004-XXXXXXX-XXX")} />
          <div style={{ fontSize:10, color:"#2a2a4a", marginTop:5, lineHeight:1.6 }}>Supports practice and live accounts.</div>
        </div>
        <div style={S.card}>
          <div style={S.title}>Twelve Data</div>
          <label style={S.lbl}>API Key</label>
          <input {...field("twelve_key")} />
          <div style={{ fontSize:10, color:"#2a2a4a", marginTop:5, lineHeight:1.6 }}>Free tier: 800 API calls/day. Used for live price feeds.</div>
        </div>
        <div style={S.card}>
          <div style={S.title}>Telegram Alerts</div>
          <label style={S.lbl}>Bot Token</label>
          <input {...field("tg_token")} />
          <label style={S.lbl}>Chat ID</label>
          <input {...field("tg_chat", "text", "-100XXXXXXXXX")} />
          <div style={{ fontSize:10, color:"#2a2a4a", marginTop:5, lineHeight:1.6 }}>Optional. Get token from @BotFather.</div>
        </div>
        <div style={S.card}>
          <div style={S.title}>Connection Status</div>
          {[
            ["AI Engine (built-in)", true],
            ["OANDA API Key",    !!local.oanda_key],
            ["OANDA Account ID", !!local.oanda_account],
            ["Twelve Data Key",  !!local.twelve_key],
            ["Telegram Token",   !!local.tg_token],
            ["Telegram Chat ID", !!local.tg_chat],
          ].map(([l, ok]) => (
            <div key={l} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #0d0d1e", fontSize:12 }}>
              <span style={{ color:"#444" }}>{l}</span>
              <Pill ok={ok} label={ok ? "SET" : "MISSING"} />
            </div>
          ))}
        </div>
      </div>
      <button onClick={save} style={{ ...S.btn, marginTop:14, padding:"12px 36px", color:"#00ff88", border:"1px solid #00ff8855", background:"#003322", fontWeight:800, letterSpacing:2 }}>
        {saved ? "✓ SAVED!" : "SAVE & CONNECT"}
      </button>
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage]   = useState("settings");
  const [col, setCol]     = useState(false);
  const [keys, setKeys]   = useState({});
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [sessionAlerts, setSessionAlerts] = useState([]);
  const [priceAlerts, setPriceAlerts]     = useState([]);
  const [time, setTime]   = useState(new Date());

  // Load persisted keys and alerts on mount
  useEffect(() => {
    Promise.all([loadKeys(), loadPriceAlerts()]).then(([k, pa]) => {
      setKeys(k || {});
      setPriceAlerts(pa || []);
      setKeysLoaded(true);
    });
  }, []);

  const addAlert = a => setSessionAlerts(p => [...p, { ...a, time:new Date().toLocaleTimeString() }]);

  const { account, trades, connected:oConn, refresh } = useOanda(keysLoaded ? keys : {});
  const { prices, prevPrices, connected:tConn }        = useTwelve(keysLoaded ? keys : {});
  const aiReady = !!(keys.claude_key || keys.openai_key);

  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (oConn || tConn) setPage("dashboard"); }, [oConn, tConn]);

  // Check price alerts
  useEffect(() => {
    if (!prices || priceAlerts.length === 0) return;
    priceAlerts.forEach(a => {
      if (!a.active) return;
      const cur = prices[a.pair];
      if (!cur) return;
      const triggered = (a.dir === "ABOVE" && cur >= a.price) || (a.dir === "BELOW" && cur <= a.price);
      if (triggered) {
        addAlert({ type:"PRICE", icon:"◬", title:`${PAIR_LABELS[a.pair]} Alert Triggered`, detail:`Price ${a.dir==="ABOVE"?"reached above":"fell below"} ${a.price.toFixed(5)} — Current: ${cur.toFixed(5)}`, color:"#ffcc00" });
        sendTelegram(`◬ <b>PRICE ALERT</b>\n${PAIR_LABELS[a.pair]} ${a.dir} ${a.price.toFixed(5)}\nCurrent: ${cur.toFixed(5)}`, keys);
        const updated = priceAlerts.map(x => x.id === a.id ? { ...x, active:false } : x);
        setPriceAlerts(updated); savePriceAlerts(updated);
      }
    });
  }, [prices]);

  const handleSetAlert = (pair, price) => {
    if (!price) return;
    const dp = pair === "XAU_USD" ? 2 : 5;
    const targetPrice = parseFloat(prompt(`Set alert for ${PAIR_LABELS[pair]} at ${price?.toFixed(dp)}. Enter target price:`) || "0");
    if (!targetPrice) return;
    const dir = targetPrice > price ? "ABOVE" : "BELOW";
    const updated = [...priceAlerts, { id:Date.now(), pair, price:targetPrice, dir, active:true, created:new Date().toLocaleTimeString() }];
    setPriceAlerts(updated); savePriceAlerts(updated);
    addAlert({ type:"PRICE", icon:"◬", title:"Price Alert Set", detail:`${PAIR_LABELS[pair]} ${dir} ${targetPrice.toFixed(dp)}`, color:"#ffcc00" });
  };

  if (!keysLoaded) {
    return (
      <div style={{ display:"flex", height:"100vh", alignItems:"center", justifyContent:"center", background:"#06061a", color:"#2a2a4a", fontFamily:"monospace", fontSize:13, letterSpacing:2, flexDirection:"column", gap:12 }}>
        <div style={{ fontSize:24, color:"#00ccff" }}>P</div>
        <div>PRECISION TRADER PRO</div>
        <div style={{ fontSize:11 }}>Connecting to server...</div>
      </div>
    );
  }

  const unread = sessionAlerts.filter(a => a.type === "PRICE").length;

  const pages = {
    dashboard:    <Dashboard account={account} trades={trades} prices={prices} prevPrices={prevPrices} oConn={oConn} tConn={tConn} aiReady={aiReady} priceAlerts={priceAlerts} onSetAlert={handleSetAlert} />,
    opportunities:<Opportunities prices={prices} keys={keys} addAlert={addAlert} />,
    trading:      <LiveTrading account={account} trades={trades} prices={prices} keys={keys} addAlert={addAlert} refresh={refresh} />,
    charts:       <Charts keys={keys} />,
    journal:      <Journal />,
    news:         <News />,
    alerts:       <Alerts alerts={sessionAlerts} keys={keys} priceAlerts={priceAlerts} setPriceAlerts={setPriceAlerts} />,
    ai:           <AIInsights prices={prices} />,
    analytics:    <Analytics account={account} trades={trades} />,
    backtest:     <Backtest />,
    settings:     <Settings keys={keys} setKeys={k => { setKeys(k); saveKeys(k); }} aiReady={aiReady} />,
  };

  return (
    <div style={{ display:"flex", height:"100vh", background:"#06061a", color:"#ccc", fontFamily:"'Courier New',monospace", overflow:"hidden" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-thumb{background:#13132b;border-radius:2px;}
        select option{background:#0b0b1f;}
        textarea{font-family:'Courier New',monospace;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.25}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

      {/* Sidebar */}
      <div style={{ width:col?50:192, background:"#05051a", borderRight:"1px solid #13132b", display:"flex", flexDirection:"column", transition:"width 0.2s", overflow:"hidden", flexShrink:0 }}>
        <div style={{ padding:"14px 11px", borderBottom:"1px solid #13132b", display:"flex", alignItems:"center", gap:9 }}>
          <div style={{ width:26, height:26, borderRadius:6, background:"linear-gradient(135deg,#00ff88,#00ccff)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#000", fontWeight:900, flexShrink:0 }}>P</div>
          {!col && <div style={{ fontSize:9, fontWeight:800, color:"#bbb", letterSpacing:1, whiteSpace:"nowrap", lineHeight:1.5 }}>PRECISION<br /><span style={{ color:"#00ccff" }}>TRADER PRO</span></div>}
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"7px 4px" }}>
          {NAV.map(item => {
            const active = page === item.id;
            const badge  = item.id === "alerts" && unread > 0 ? unread : null;
            return (
              <div key={item.id} onClick={() => setPage(item.id)} style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 9px", borderRadius:7, cursor:"pointer", marginBottom:1, background:active?"#0d0d2a":"transparent", borderLeft:active?"2px solid #00ccff":"2px solid transparent", color:active?"#00ccff":"#2a2a4a", transition:"all 0.12s", whiteSpace:"nowrap" }}>
                <span style={{ fontSize:14, flexShrink:0 }}>{item.icon}</span>
                {!col && <span style={{ fontSize:11, fontWeight:active?700:400, flex:1 }}>{item.label}</span>}
                {badge && !col && <span style={{ fontSize:9, padding:"2px 5px", borderRadius:10, background:"#ffcc00", color:"#000", fontWeight:800 }}>{badge}</span>}
              </div>
            );
          })}
        </div>
        <div onClick={() => setCol(!col)} style={{ padding:"11px 13px", borderTop:"1px solid #13132b", cursor:"pointer", color:"#1a1a30", fontSize:12, display:"flex", alignItems:"center", gap:7 }}>
          <span>{col ? "▶" : "◀"}</span>{!col && <span style={{ fontSize:10 }}>Collapse</span>}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {/* Top bar */}
        <div style={{ height:46, borderBottom:"1px solid #13132b", display:"flex", alignItems:"center", padding:"0 16px", gap:12, background:"#05051a", flexShrink:0 }}>
          <div style={{ fontSize:10, color:"#1a1a30", letterSpacing:3, textTransform:"uppercase", flex:1 }}>{NAV.find(n => n.id === page)?.label}</div>
          <div style={{ display:"flex", gap:12, alignItems:"center" }}>
            {Object.entries(prices).slice(0, 3).map(([p, v]) => (
              <div key={p} style={{ fontSize:10, fontFamily:"monospace", display:"flex", gap:4 }}>
                <span style={{ color:"#1a1a30" }}>{PAIR_LABELS[p]}</span>
                <span style={{ color:"#00ccff" }}>{v.toFixed?.(4)}</span>
              </div>
            ))}
            <div style={{ fontSize:10, color:"#1a1a30", fontFamily:"monospace" }}>{time.toUTCString().slice(17, 25)} UTC</div>
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:(oConn||tConn)?"#00ff88":"#ff4466", animation:(oConn||tConn)?"pulse 2s infinite":"none" }} />
              <span style={{ fontSize:10, color:(oConn||tConn)?"#00ff88":"#ff4466" }}>{(oConn||tConn) ? "LIVE" : "OFFLINE"}</span>
            </div>
          </div>
        </div>

        {!oConn && !tConn && page !== "settings" && (
          <div onClick={() => setPage("settings")} style={{ padding:"9px 16px", background:"#0b0a1a", borderBottom:"1px solid #13132b", fontSize:12, color:"#ffcc0099", cursor:"pointer" }}>
            ⚠ Enter your API keys in Settings → <span style={{ color:"#00ccff" }}>Go to Settings</span>
          </div>
        )}

        <div style={{ flex:1, overflowY:"auto", padding:16, animation:"fadeIn 0.2s ease" }}>
          {pages[page] || pages.dashboard}
        </div>
      </div>
    </div>
  );
}
