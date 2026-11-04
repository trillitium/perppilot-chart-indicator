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
| Alert delivery | Real notifications from the installed app (iPhone, Android, desktop), plus optional ntfy, Discord, Telegram. Tap one to open that chart. |
| Accounts | Sign-up and sign-in. Each person has their own alerts, bots, devices and settings. The owner invites people with one-time links and can reset passwords. |
| Backtesting | Long and short, fees, win rate, drawdown, profit factor, equity curve, trade list |
| Watchlist | Live prices and daily change |
| News | Headlines for the symbol you're on, or the whole market |
| Grid bots | Rebuilt PerpPilot dual-bot monitor for Hyperliquid: per-bot ranges, 12-level ladder maths, live funding, START / RANGE EXIT / RE-ENTRY alerts to Discord |

## Grid bots (PerpPilot)

The **Bots** tab is a rebuild of the *PerpPilot V3.1 Dual Bot* TradingView indicator, with the same logic and the same Discord message layout.

- **Bots and assets:** any number of bots, each with its own assets (`SOL`, `HYPE`, `xyz:TSLA`…) and its own pool, MIN–MAX range and fee. It starts with the values from the original indicator. Press **Edit bots** to change them.
- **Dashboard:** pool, MAX/MIN with distance from price, span, net per turnaround after fee and funding, ladder step, funding, ADX state, and whether price is in range. One column per bot.
- **Overview:** every active asset across all bots in one table. (The original had a "Multi-Overview" option it never got to.)
- **Chart:** EMA 20/50/200, each bot's MIN/MAX lines, and START, EXIT and RE-ENTRY markers through history.
- **START alert:** EMA 20 > 50 > 200, price above all of them, ADX between 22 and 45, DI+ > DI−, and MACD rising, all held for 2 closed bars on the signal timeframe (1h by default).
- **RANGE EXIT / ABOVE MAX / RE-ENTRY alerts:** fire as soon as the live Hyperliquid price drops below a bot's MIN, breaks out above its MAX (the grid is fully sold and stops earning), or comes back inside its range. ABOVE MAX is new; the original only watched the bottom. Each can be switched off in the settings.
- **Funding:** pulled live from Hyperliquid every check. Switch to manual in the settings to use a fixed number like the old indicator.
- **Test:** the **Send test** button sends a START preview right away, like the old "Test-Modus".

For Discord pings that actually notify someone, put a real mention in a bot's *Discord mention line*. That's `<@USER_ID>` for a person or `<@&ROLE_ID>` for a role. Plain `@name` text shows up but doesn't ping.

## Setup (10 minutes)

1. Install **Node.js 20 or newer** from <https://nodejs.org> (the LTS button).
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
3. Start it:
   - **Windows:** double-click **Start Chartsmith.bat**.
   - **Mac:** right-click **Start Chartsmith.command** → **Open**. You only need right-click the first time.
   - **Or** open a terminal *inside the folder* and run `npm start`.
4. Your browser opens <http://localhost:8787>. Keep the black terminal window open; closing it stops the app and its alerts.

No `npm install` needed. There are zero dependencies.

### If it won't start

| What you see | Fix |
|---|---|
| `npm` / `node` is not recognized / command not found | Node.js isn't installed. Get the **LTS** version from <https://nodejs.org>, then close and reopen the terminal. |
| `Chartsmith needs Node.js 20 or newer` | Install the current LTS from <https://nodejs.org>. |
| `Missing script: "start"` or `ENOENT … package.json` | You're in the wrong folder. The ZIP unpacks into `chartsmith-main`. `cd` into the folder that contains `package.json`. |
| `Port … is already in use` | Chartsmith is already running in another window. Use that one, or close it first. |
| Terminal says "running" but no browser window | Open <http://localhost:8787> yourself (or the port it printed). |
| Mac says the file "can't be opened" | Right-click → Open, then Open again. |

## Accounts

- **First sign-up becomes the owner.** On a fresh install, the first person to sign up is the owner. If you used an older single-user version, the owner's account takes over the existing alerts, bots and settings automatically.
- **Inviting people:** Settings ⚙ → **Team** → **Create invite link**. Each link works once. Set `OPEN_SIGNUP=1` to let anyone sign up without an invite.
- **Forgotten password:** the owner can make a temporary one under Team. Changing a password signs that account out everywhere else.
- **Sessions:** a sign-in lasts a year per device.

## Get alerts on your phone

Chartsmith sends real notifications itself. No extra app is needed.

1. **Make sure it's served over `https://`.** Railway does this for you.
2. **iPhone (iOS 16.4+):** open it in Safari, tap **Share → Add to Home Screen**, then open Chartsmith from the icon.
   **Android:** open it in Chrome and tap **Install app**, or just keep using it in Chrome.
3. Settings ⚙ → **Notifications** → **Turn on notifications** → **Allow**.
4. Press **Send test notification**.

Do this once on every phone or computer that should get alerts. Tapping a notification opens that chart.

ntfy, Discord and Telegram are still there under "Also send alerts to…". Discord is what the grid bots use for their full messages.

## Grid bots (PerpPilot)

The **Bots** tab is a rebuild of the *PerpPilot V3.1 Dual Bot* TradingView indicator, with the same logic and the same Discord message layout.

- **Bots and assets:** any number of bots, each with its own assets (`SOL`, `HYPE`, `xyz:TSLA`…) and its own pool, MIN–MAX range and fee. It starts with the values from the original indicator. Press **Edit bots** to change them.
- **Dashboard:** pool, MAX/MIN with distance from price, span, net per turnaround after fee and funding, ladder step, funding, ADX state, and whether price is in range. One column per bot.
- **Overview:** every active asset across all bots in one table. (The original had a "Multi-Overview" option it never got to.)
- **Chart:** EMA 20/50/200, each bot's MIN/MAX lines, and START, EXIT and RE-ENTRY markers through history.
- **START alert:** EMA 20 > 50 > 200, price above all of them, ADX between 22 and 45, DI+ > DI−, and MACD rising, all held for 2 closed bars on the signal timeframe (1h by default).
- **RANGE EXIT / ABOVE MAX / RE-ENTRY alerts:** fire as soon as the live Hyperliquid price drops below a bot's MIN, breaks out above its MAX (the grid is fully sold and stops earning), or comes back inside its range. ABOVE MAX is new; the original only watched the bottom. Each can be switched off in the settings.
- **Funding:** pulled live from Hyperliquid every check. Switch to manual in the settings to use a fixed number like the old indicator.
- **Test:** the **Send test** button sends a START preview right away, like the old "Test-Modus".

For Discord pings that actually notify someone, put a real mention in a bot's *Discord mention line*. That's `<@USER_ID>` for a person or `<@&ROLE_ID>` for a role. Plain `@name` text shows up but doesn't ping.

## Setup (10 minutes)

1. Install **Node.js 20 or newer** from <https://nodejs.org> (the LTS button).
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
3. Start it:
   - **Windows:** double-click **Start Chartsmith.bat**.
   - **Mac:** right-click **Start Chartsmith.command** → **Open**. You only need right-click the first time.
   - **Or** open a terminal *inside the folder* and run `npm start`.
4. Your browser opens <http://localhost:8787>. Keep the black terminal window open; closing it stops the app and its alerts.

No `npm install` needed. There are zero dependencies.

### If it won't start

| What you see | Fix |
|---|---|
| `npm` / `node` is not recognized / command not found | Node.js isn't installed. Get the **LTS** version from <https://nodejs.org>, then close and reopen the terminal. |
| `Chartsmith needs Node.js 20 or newer` | Install the current LTS from <https://nodejs.org>. |
| `Missing script: "start"` or `ENOENT … package.json` | You're in the wrong folder. The ZIP unpacks into `chartsmith-main`. `cd` into the folder that contains `package.json`. |
| `Port … is already in use` | Chartsmith is already running in another window. Use that one, or close it first. |
| Terminal says "running" but no browser window | Open <http://localhost:8787> yourself (or the port it printed). |
| Mac says the file "can't be opened" | Right-click → Open, then Open again. |

## Get alerts on your phone

1. Install the free **ntfy** app (iPhone or Android).
2. In Chartsmith, click ⚙, press **Generate** next to Topic, then **Save**.
3. In the ntfy app, tap **+** and subscribe to that same topic.
4. Press **Send test**. Your phone should buzz.

Discord and Telegram work too. Paste the webhook or bot details in ⚙.

## Put it on your phone (Railway, about $5/month)

Alerts only fire while the server runs, so host it somewhere always on. Railway is the quickest.

1. Go to <https://railway.com>, sign in with GitHub, then **New Project → Deploy from GitHub repo → chartsmith**.
2. Go to **Settings → Volumes → Add Volume**, mount path `/data`. Then go to **Variables** and add `DATA_DIR` = `/data`. Accounts, alerts and bots then survive redeploys.
3. Go to **Settings → Networking → Generate Domain**. You get a `https://….up.railway.app` link.
4. Open that link right away and create the owner account. The first sign-up owns the app.
5. On the phone, open the link and sign in.
   - **iPhone:** use Safari. Tap **Share → Add to Home Screen**.
   - **Android:** use Chrome. Tap **⋮ → Install app**.
6. In the app, go to ⚙ → **Notifications** → **Turn on notifications**. Add the Discord webhook for the grid-bot messages. Press **Send test notification**.

It now opens full screen from its own icon, and stays signed in for a year. Every push to `main` redeploys automatically.

Why not Netlify: it only runs short-lived functions, with no always-on process and no saved files. The alert and bot watcher would stop between requests.

## Run it 24/7 somewhere else

- **Leave a computer on.** An old laptop or a Raspberry Pi is plenty.
- **Render or Fly.io** work like Railway: set the same variables and attach a disk at `DATA_DIR`. Avoid free tiers that sleep; alerts stop while it sleeps.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 8787 | Port to listen on |
| `HOST` | 127.0.0.1 (0.0.0.0 if `PORT` is set) | Address to bind |
| `OPEN_SIGNUP` | off | `1` = anyone can sign up without an invite |
| `PUSH_CONTACT` | alerts@chartsmith.app | Email push services can contact about your server. Use your own. |
| `DATA_DIR` | `./data` | Where accounts, alerts, bots and settings are saved. Back this folder up. |
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
- **Hyperliquid perps** (`HL:SOL`, `HL:xyz:TSLA`): Hyperliquid's public API, real time, including live funding.
- **News:** Yahoo Finance and Google News RSS.

None need an API key. If Yahoo ever blocks or changes its feed, the fix goes in `lib/providers.mjs`.

## Not trading advice

Backtests use past data, fill at the next bar's open, and ignore slippage beyond the fee you set. Past results don't predict future ones.

## Project layout

```
server.mjs          HTTP server, API routes, alert loop
lib/engine.mjs      Script language + indicators + backtester (shared by browser and server)
lib/providers.mjs   Yahoo / Coinbase / news adapters with caching
lib/accounts.mjs    Users, sessions, invites, one workspace per user
lib/webpush.mjs     Web Push (VAPID + RFC 8291 encryption), no dependencies
lib/alerts.mjs      Alert storage, checking, notifications
lib/gridbot.mjs     PerpPilot logic: indicators, ladder maths, Discord messages (shared)
lib/botmonitor.mjs  Server-side grid-bot watcher
public/             The app (index.html, app.js, style.css)
test/               npm test
```
