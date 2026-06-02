const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use /data directory on Railway (persistent volume) or local data/ folder
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'precisiontrader.db');
const db = new Database(dbPath);

// Performance pragmas
db.pragma('journal_mode = WAL');      // concurrent reads + writes
db.pragma('synchronous = NORMAL');    // safe with WAL, much faster than FULL
db.pragma('cache_size = -16000');     // 16 MB page cache
db.pragma('temp_store = MEMORY');     // temp tables in RAM
db.pragma('mmap_size = 268435456');   // 256 MB memory-mapped I/O
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS storage (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS journal_notes (
    trade_id TEXT PRIMARY KEY,
    note     TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS price_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pair       TEXT NOT NULL,
    target_price REAL NOT NULL,
    direction  TEXT NOT NULL CHECK(direction IN ('ABOVE','BELOW')),
    active     INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Fix 3: Per-pair circuit breakers
  CREATE TABLE IF NOT EXISTS pair_breakers (
    pair         TEXT PRIMARY KEY,
    blocked_until DATETIME NOT NULL,
    reason       TEXT,
    loss_count   INTEGER DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Fix 6: Structured AI decision log
  CREATE TABLE IF NOT EXISTS ai_decisions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    signal_id    INTEGER,
    pair         TEXT,
    direction    TEXT,
    model        TEXT,
    calc_confidence INTEGER,
    ai_confidence   INTEGER,
    ai_direction    TEXT,
    ai_sl        REAL,
    ai_tp        REAL,
    decision     TEXT,
    regime       TEXT,
    session      TEXT,
    adx          REAL,
    rsi_m30      REAL,
    spread_pips  REAL,
    score        INTEGER,
    flags        TEXT,
    prompt_hash  TEXT,
    latency_ms   INTEGER
  );

  -- Fix 7: Immutable append-only audit log with hash chain
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    action     TEXT NOT NULL,
    actor      TEXT DEFAULT 'SYSTEM',
    entity_id  TEXT,
    data       TEXT,
    prev_hash  TEXT,
    row_hash   TEXT
  );

  -- Fix 2: Ghost position tracker
  CREATE TABLE IF NOT EXISTS ghost_positions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    oanda_trade_id TEXT UNIQUE,
    instrument   TEXT,
    units        REAL,
    open_price   REAL,
    unrealized_pl REAL,
    status       TEXT DEFAULT 'DETECTED',
    resolved_at  DATETIME,
    notes        TEXT
  );

  -- Post-trade attribution: rich entry context stored at signal time,
  -- joined with outcome after close for "what actually works" analysis
  CREATE TABLE IF NOT EXISTS trade_attribution (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id       INTEGER UNIQUE,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    pair            TEXT,
    direction       TEXT,
    session         TEXT,
    regime          TEXT,
    atr_ratio       REAL,
    score           INTEGER,
    confidence      INTEGER,
    spread_pips     REAL,
    atr_pips        REAL,
    adx             REAL,
    rsi_m30         REAL,
    w1_trend        TEXT,
    structure_bias  TEXT,
    bos             TEXT,
    choch           TEXT,
    rsi_divergence  TEXT,
    compressing     INTEGER,
    sweep_risk      TEXT,
    size_factor     REAL,
    realized_pl     REAL,
    actual_pips     REAL,
    exit_reason     TEXT,
    duration_mins   INTEGER,
    outcome         TEXT
  );

  -- Confidence calibration: after N trades, compare stated confidence vs actual win rate
  CREATE TABLE IF NOT EXISTS confidence_calibration (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence_band TEXT,
    trade_count     INTEGER,
    win_count       INTEGER,
    actual_win_pct  REAL,
    stated_conf_avg REAL,
    calibration_gap REAL
  );
`);

console.log(`[DB] SQLite ready at: ${dbPath}`);

module.exports = db;
