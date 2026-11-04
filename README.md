# Chartsmith

Your own charting station. Live prices, your own indicators, backtests, alerts to your phone, and news. Free data, no subscription, no per-feature upsells.

You run it on your computer (or a $5 server) and open it in a browser.

## What you get

| | Chartsmith |
|---|---|
| Charts | Candlesticks + volume, 1m / 5m / 15m / 1h / 4h / 1D / 1W, pan, zoom, pinch on phone |
| Markets | US & global stocks, ETFs, indexes (`^GSPC`, `^IXIC`), forex (`EURUSD=X`), futures (`ES=F`), crypto (`CB:BTC-USD`) |
| Live updates | Chart refreshes every 5–20 s depending on timeframe. Crypto is real time. |
| Indicators | Unlimited per chart. Write them in a small script language (MA, EMA, RSI, ATR, VWAP, bands, crossovers…). 6 examples included. |
| Drawing | Horizontal lines and trend lines, saved per symbol. Click a line → one-click price alert. |
| Alerts | Unlimited. Price-level alerts and script alerts (`alert "RSI oversold" when rsi(close,14) < 30`). Run on the server, so they fire with the browser closed. |
| Alert delivery | In-app sound + toast, desktop notifications, phone push (ntfy), Discord, Telegram |
| Backtesting | Long and short, fees, win rate, drawdown, profit factor, equity curve, trade list |
| Watchlist | Live prices and daily change |
| News | Headlines for the symbol you're on, or the whole market |

## Setup (10 minutes)

1. Install **Node.js 20 or newer** from <https://nodejs.org> (the LTS button).
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
3. Open a terminal in the folder and run:
   ```bash
   npm start
   ```
4. Open <http://localhost:8787>.

No `npm install` needed. There are zero dependencies.

## Get alerts on your phone

1. Install the free **ntfy** app (iPhone or Android).
2. In Chartsmith, click ⚙, press **Generate** next to Topic, then **Save**.
3. In the ntfy app, tap **+** and subscribe to that same topic.
4. Press **Send test**. Your phone should buzz.

Discord and Telegram work too. Paste the webhook or bot details in ⚙.

## Run it 24/7

Alerts only fire while the server is running. If your computer sleeps, they stop. Options:

- **Leave a computer on.** An old laptop or a Raspberry Pi is plenty.
- **Railway / Render / Fly.io** (about $5/month): deploy this repo, set the start command to `npm start`, and set these variables:
  - `PASSWORD` = something long. **Required** once it's on the internet.
  - `DATA_DIR` = a persistent volume path, so alerts survive restarts.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 8787 | Port to listen on |
| `HOST` | 127.0.0.1 (0.0.0.0 if `PORT` is set) | Address to bind |
| `PASSWORD` | none | Browser login. Username can be anything. |
| `DATA_DIR` | `./data` | Where alerts, alert history and settings are saved |
| `ALERT_INTERVAL_MS` | 15000 | How often alerts are checked |

## Script language, quick tour

```
fast = ema(close, 12)
slow = sma(close, 34)
plot(fast, "EMA 12", "#f2b544")
plot(slow, "SMA 34", "#5aa9ff")
buy when crossover(fast, slow)
sell when crossunder(fast, slow)
alert "Fast MA crossed up" when crossover(fast, slow)
```

Full reference is in the app (Script tab → Language reference).

## Where the data comes from

- **Stocks, ETFs, indexes, forex, futures:** Yahoo Finance's public chart feed. It's unofficial and can be delayed (often 15 min for some exchanges). Fine for swing trading and alerts; don't scalp off it.
- **Crypto:** Coinbase's public API, real time.
- **News:** Yahoo Finance and Google News RSS.

None need an API key. If Yahoo ever blocks or changes its feed, the fix goes in `lib/providers.mjs`.

## Not trading advice

Backtests use past data, fill at the next bar's open, and ignore slippage beyond the fee you set. Past results don't predict future ones.

## Project layout

```
server.mjs          HTTP server, API routes, alert loop
lib/engine.mjs      Script language + indicators + backtester (shared by browser and server)
lib/providers.mjs   Yahoo / Coinbase / news adapters with caching
lib/alerts.mjs      Alert storage, checking, notifications
public/             The app (index.html, app.js, style.css)
test/               npm test
```
