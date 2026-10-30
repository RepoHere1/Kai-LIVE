# KAI-MIRROR / KAI-LIVE — MASTER TRACKER

**Last Updated:** 2026-10-29
**Purpose:** Single source of truth for what's built, what's working, and what's next. Use this to resume after any context loss.

---

## 📁 REPOSITORY STRUCTURE

```
C:\Users\darri\Kai-Mirror\          # DRY server (port 8787)
├── server.js                       # Main DRY server (~2715 lines)
├── brain_dry.js                    # DRY brain (ensemble + 12 signals)
├── kalshi.js                       # Kalshi HTTP client
├── kalshi_ws.js                    # Kalshi WebSocket client
├── coinbase_ws.js                  # Coinbase WebSocket client (authenticated)
├── kilo.js                         # Kilo AI Gateway client
├── index.html                      # DRY dashboard
├── all-no-markets.html             # ALL NO MARKETS page
├── kai.ps1                         # DRY control script
├── kai.cmd                         # DRY shortcut
├── state.json                      # Persisted state (all lanes, books)
├── Dockerfile                      # Railway deployment
├── railway.json                    # Railway config
├── .env                            # Credentials (live/demo keys, Coinbase, Kilo)
└── package.json / node_modules

C:\Users\darri\Kai-LIVE\            # LIVE server (port 8788)
├── server.js                       # Main LIVE server (~2700 lines)
├── brain_live.js                   # LIVE brain (different weights, 12 signals)
├── kalshi.js                       # Kalshi HTTP client
├── kalshi_ws.js                    # Kalshi WebSocket client
├── coinbase_ws.js                  # Coinbase WebSocket client (authenticated)
├── kilo.js                         # Kilo AI Gateway client
├── live-home.html                  # LIVE dashboard
├── all-no-markets.html             # ALL NO MARKETS page
├── kai-live.ps1                    # LIVE control script
├── kai.ps1                         # LIVE shortcut
├── state.json                      # Persisted state
├── Dockerfile                      # Railway deployment
├── railway.json                    # Railway config
├── .env                            # Credentials (live/demo keys, Coinbase, Kilo)
└── package.json / node_modules
```

---

## ✅ WHAT'S BUILT & WORKING (HARD INFRASTRUCTURE)

### **Operator Law — Hard-Coded & Enforced**
| Location | Enforcement |
|----------|-------------|
| `server.js:1767-1768` (DRY) / `1829-1830` (LIVE) | Boot: `OPERATOR_LAW.assertNoSupervisor()` + `enforce('boot')` |
| `server.js:1342` (DRY) / `1402` (LIVE) | Toggle endpoint: only writer of `ls.running` |
| `server.js:573` (DRY) / `660` (LIVE) | Engine tick: mid-tick stop is absolute |
| Global `OPERATOR_LAW` object | Forbidden patterns: `supervisor`, `auto.start`, `auto.restart`, `keep.alive`, `watchdog`, `resurrect`, `reenable` |

**Result:** Button push = immediate absolute law. No supervisor, no auto-start, no auto-restart, no resurrection. Lane stays exactly as operator set it forever.

### **Single-Button Toggle (Both Dashboards)**
- Buttons: `<button id="btn-{name}" onclick="toggleStrategy('{name}')">Stop</button>`
- `paintNow()` paints intent instantly → fetch → server applies synchronously → returns `{law: "OPERATOR_LAW_ENFORCED"}`
- On failure: reverts button, logs error to trade feed
- Verified: `curl` toggles return `running: true/false` + `law: "OPERATOR_LAW_ENFORCED"`

### **Bulk ON/OFF via Scripts**
```powershell
# DRY
.\kai.ps1 on    # starts all 9 lanes
.\kai.ps1 off   # stops all 9 lanes

# LIVE
.\kai-live.ps1 on
.\kai-live.ps1 off
```
Persists to `state.json` — survives server restart.

### **ALL NO MARKETS Engine (Both Servers)**
| Function | Purpose |
|----------|---------|
| `runAllNoEngine()` | Every 10s: scans `noBook()`, auto-enters top-K by edge (Kelly-sized, maker at bid) |
| `runAllNoExits()` | Every 5s: monitors open positions, exits on TP/SL/time-decay |
| `noBook()` | Returns NO-side recommendations with real BS fair value, edge, Kelly |
| `createAllNoEntry()` / `closeAllNoPosition()` | Entry/exit with balance tracking |
| `postAllNoOrder()` | LIVE mode: posts real Kalshi NO-side orders |

**Config (`ALL_NO_CONFIG`):**
```javascript
{
  scan_interval_ms: 10000,
  max_concurrent: 10,
  max_exposure_pct: 0.3,
  kelly_cap: 0.4,
  min_edge: 0.001,
  min_vol: 0.00005,
  max_gap: 0.015,
  maker_only: true,
  trail_pct: 0.5,
  max_hold_pct: 0.8,
  stop_loss_pct: 0.25,
  take_profit_mult: 2,
}
```

### **Lane Engine Upgrades (Both Servers)**
| Feature | Code Location |
|---------|---------------|
| Maker entry (use bid not ask) | `engineTick` line 628 (DRY) / 629 (LIVE) |
| Kelly sizing check | `engineTick` line 640-641 |
| Portfolio heat limit (30% max exposure) | `engineTick` line 636-638 |
| Regime filter (skip wide_spread, arbitrage) | `engineTick` line 622-624 |
| Max hold time (5 min default) | `engineTick` line 651-654 |
| Mid-tick operator stop guard | `engineTick` line 573 / 660 |
| **Trailing stops (50% profit lock)** | `engineTick` line 1156 (DRY) / 1026 (LIVE) |
| **Time-decay exit (80% tau)** | `engineTick` line 1149 (DRY) / 1019 (LIVE) |

### **Brain (Ensemble Signals) — 12 SIGNALS ACTIVE**
**Base 6 Signals (both `brain_dry.js` & `brain_live.js`):**
1. **Arbitrage** — risk-free when YES+NO < 1.0 (weight 1.0)
2. **Imbalance** — order book bid/ask size ratio (DRY 0.7 / LIVE 0.85)
3. **Volume** — volume spike momentum (DRY 0.6 / LIVE 0.75)
4. **Cross-Expiry** — per-minute cost across expirations (DRY 0.5 / LIVE 0.55)
5. **Whale** — follow large fills after 30s (DRY 0.3 / LIVE 0.55)
6. **Black-Scholes** — normal CDF fair value (DRY 0.15 / LIVE 0.2)

**Advanced 6 Signals (NEW - High Alpha):**
7. **Order Flow** — bid/ask size ratio + recent fill direction toxicity (DRY 0.65 / LIVE 0.85)
8. **Vol RP** — volatility risk premium: sell high-IV NO when realized < implied (DRY 0.55 / LIVE 0.7)
9. **Term Struct** — term structure arbitrage across expirations using BS fair (DRY 0.45 / LIVE 0.65)
10. **Funding Carry** — crypto carry: forward = spot * exp(r*tau) vs Kalshi price (DRY 0.5 / LIVE 0.6)
11. **Correlation Hedge** — portfolio heat: reduce size when BTC+ETH both signal same side (meta-signal)
12. **Settlement Alpha** — CF BRTI 60s TWAP vs Coinbase spot at settlement (DRY 0.7 / LIVE 0.8, final hour only)

**LIVE weights** emphasize real-time signals; de-emphasize slow/noisy ones.

### **Real BS Fair Value (Replaces 0.5 Prior)**
`noBook()` lines 1025-1030 (DRY) / 1080-1085 (LIVE):
```javascript
if (sp && Number.isFinite(sp.price) && q.strike != null && q.close_time) {
  const perSec = perSecondVol(lane.spot, 900);
  const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
  if (perSec && tau > 20) fair = 1 - normCdf(Math.log(sp.price / q.strike) / (perSec * Math.sqrt(tau)));
}
```

### **Kalshi WebSocket (Real-Time Data)**
- `kalshi_ws.js` in both folders — WebSocket client for markets/fills/orders
- Auto-reconnect, heartbeat, authentication
- Connected in `boot()` — subscribes to all lane series + fills + orders
- Updates `marketCache` with `source: 'ws'` for sub-second freshness

### **Coinbase WebSocket (Real-Time Spot) — NEW**
- `coinbase_ws.js` in both folders — HMAC-authenticated WebSocket client
- Channels: `ticker` for BTC-USD, ETH-USD, XRP-USD, HYPE-USD
- Connected in `boot()` — updates `spot` object in real-time
- Replaces 2s HTTP polling with sub-second spot prices

### **Runtime Config (Both Servers)**
```javascript
runtime: {
  clip: 5,
  min_edge: 0.001,
  max_price: 0.90,
  min_price: 0.05,
  take_profit: 0.90,
  stop_loss: 0.25,
  kelly_cap: 0.4,
  min_hold_sec: 30,
  entry_cooldown_sec: 60,
  max_hold_sec: 300,
  max_exposure_pct: 0.3,
  maker_only: true,
}
```

### **Dashboard Monitoring Panels (6 Panels) — NEW**
| Panel | Metrics | Endpoint |
|-------|---------|----------|
| Edge decay curve | edge at entry vs edge at exit per trade | `/api/monitoring` |
| Regime win rate | Win % by regime (arbitrage, high_vol, normal, etc.) | `/api/monitoring` |
| Signal attribution | Win % per signal source | `/api/monitoring` |
| Kelly efficiency | actual_return / kelly_return per trade | `/api/monitoring` |
| Execution quality | (fill - bid) / (ask - bid) — should be ≤ 0 for maker | `/api/monitoring` |
| ALL NO heatmap | Edge vs tau vs fair 3D surface | `/api/monitoring` |

### **Data Pipeline Upgrades — NEW**
| Upgrade | Implementation |
|---------|----------------|
| Options chain cache | `fetchOptionsChain(series)` — full chain per series (20 depths), 5s TTL |
| Settlement database | `state.settlement_db` — CF BRTI 60s TWAP proxy (Coinbase spot at settlement) |
| Fill quality tracker | `state.fill_quality_db` — tracks `(fill - bid) / (ask - bid)` at entry, maker ≤ 0 |

### **API Enhancements — NEW**
- **Rate limiting:** 120 req/min per IP (in-memory, skips health/static)
- **Webhooks:** CRUD at `/api/webhooks`, HMAC-signed payloads, fires on `trade_exit`

### **Railway Deployment Ready — NEW**
| Item | DRY (8787) | LIVE (8788) |
|------|-----------|-------------|
| Dockerfile | ✅ | ✅ |
| railway.json | ✅ | ✅ |
| Health check endpoint | ✅ `/api/health` | ✅ `/api/health` |
| Docker HEALTHCHECK | ✅ | ✅ |

### **Dashboard Buttons**
- All 9 lanes: `<button id="btn-{name}" onclick="toggleStrategy('{name}')">Stop</button>`
- `paintCards()` updates button text from snapshot (`Stop`/`Start`)
- Debug logging removed — clean production code

---

## 🎯 IMMEDIATE NEXT STEPS (NEW PRIORITIES)

### **1. Kalshi WebSocket Stabilization**
- Kalshi WS repeatedly disconnects (code 1006) — likely auth/permission issue
- Need to verify Kalshi WebSocket API permissions for market data channels

### **2. Performance Optimizations**
- DB indexing for trades/positions queries
- Connection pooling for Kalshi HTTP client
- Caching layer for frequently accessed endpoints

### **3. Testing & Validation**
- Unit tests for brain signals
- Integration tests for engine tick
- Backtesting framework for strategy validation

### **4. New Trading Strategies**
- Additional signal generators (funding rate arb, basis trading)
- Multi-venue arbitrage (Kalshi vs other prediction markets)
- Options Greeks-based signals

### **5. Operational Improvements**
- Structured logging (JSON) for observability
- Metrics export (Prometheus/Grafana)
- Alerting on critical failures

---

## 🔧 RESTART COMMANDS

```powershell
# DRY (port 8787)
cd C:\Users\darri\Kai-Mirror
.\kai.ps1 start

# LIVE (port 8788)
cd C:\Users\darri\Kai-LIVE
.\kai-live.ps1 start
```

**URLs:**
- DRY: `http://127.0.0.1:8787/`
- LIVE: `http://127.0.0.1:8788/`

---

## 📝 HOW TO RESUME AFTER CONTEXT LOSS

1. **Read this file** — it's the single source of truth
2. **Check servers:** `curl http://127.0.0.1:8787/api/health` + `:8788/api/health`
3. **Verify buttons:** Open dashboard, click any "Stop" → flips to "Start" instantly
4. **Check ALL NO:** `curl http://127.0.0.1:8787/api/no-lanes/book`
5. **Check monitoring:** `curl http://127.0.0.1:8787/api/monitoring`

---

## 📌 KEY FILES FOR NEXT WORK

| Task | DRY File | LIVE File |
|------|----------|-----------|
| Kalshi WS fix | `kalshi_ws.js` + `server.js` boot() | same |
| Performance | `server.js`, `kalshi.js` | same |
| Testing | new `test/` folder | same |
| New strategies | `brain_dry.js` | `brain_live.js` |
| Observability | `server.js` logging | same |

---

**This file = your recovery point. Everything in ✅ is done. Everything in 🎯 is next. No guessing needed.**