# Precision Trader Pro

Professional AI-powered forex trading platform with real-time prices, OANDA trading, GPT-4o analysis, and Telegram alerts.

## Features
- **Live Prices** — Real-time via Twelve Data API
- **OANDA Trading** — Execute & close trades directly
- **GPT-4o AI Analysis** — Market bias, entry/SL/TP, confidence scores
- **Candlestick Charts** — OANDA candles with EMA9 & EMA21
- **Economic Calendar** — Real Forex Factory data
- **Price Alerts** — In-app + Telegram notifications
- **Trade Journal** — Notes on each open trade
- **Analytics** — Win rate, R:R, pair distribution

## Run Locally

```bash
# 1. Install backend deps
npm install

# 2. Install frontend deps  
cd client && npm install && cd ..

# 3. Start both (backend on :3001, frontend on :5173)
npm run dev

# Open http://localhost:5173
```

## Deploy to Railway (Free 24/7 Link)

1. Push to GitHub:
```bash
git init
git add .
git commit -m "Initial commit — PrecisionTraderPro"
git remote add origin https://github.com/YOUR_USERNAME/precisiontrader-pro.git
git push -u origin main
```

2. Go to **railway.app** → New Project → Deploy from GitHub → Select your repo

3. Set environment variables in Railway dashboard:
   - `NODE_ENV=production`
   - `PORT=3001` (Railway sets this automatically)

4. Railway builds and gives you a URL like: `https://precisiontrader-pro.up.railway.app`

5. Open that URL on any device — enter your API keys in Settings and they save to the database.

## API Keys Needed
| Key | Where to Get | Required |
|-----|-------------|---------|
| OpenAI API Key | platform.openai.com | Yes (for AI analysis) |
| OANDA API Key | OANDA account → API | Yes (for trading & charts) |
| OANDA Account ID | Your OANDA account | Yes |
| Twelve Data Key | twelvedata.com (free) | Yes (for live prices) |
| Telegram Bot Token | @BotFather on Telegram | Optional |
| Telegram Chat ID | @userinfobot | Optional |

## Architecture
```
Browser → Vite React App
            ↕ /api/*
          Express Backend (Node.js)
            ├── SQLite Database  (keys, journal, alerts — persistent)
            ├── OpenAI GPT-4o    (AI analysis)
            ├── OANDA API Proxy  (trading)
            ├── Twelve Data      (live prices)
            └── Forex Factory    (economic calendar)
```

Keys are stored securely in the server database — never exposed to the browser.
