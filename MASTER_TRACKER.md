# KAI-MIRROR / KAI-LIVE - MASTER TRACKER

**Last Updated:** 2026-10-29
**Purpose:** Single source of truth for what's built, what's working, and what's next. Use this to resume after any context loss.

---

## * REPOSITORY STRUCTURE

```
C:\Users\darri\Kai-Mirror\          # DRY server (port 8787)
|-- server.js                       # Main DRY server (~2715 lines)
|-- brain_dry.js                    # DRY brain (ensemble + 12 signals)
|-- kalshi.js                       # Kalshi HTTP client
|-- kalshi_ws.js                    # Kalshi WebSocket client
|-- coinbase_ws.js                  # Coinbase WebSocket client (authenticated)
|-- kilo.js                         # Kilo AI Gateway client
|-- index.html                      # DRY dashboard
|-- all-no-markets.html             # ALL NO MARKETS page
|-- kai.ps1                         # DRY control script
|-- kai.cmd                         # DRY shortcut
|-- state.json                      # Persisted state (all lanes, books)
|-- Dockerfile                      # Railway deployment
|-- railway.json                    # Railway config
|-- .env                            # Credentials (live/demo keys, Coinbase, Kilo)
|-- package.json / node_modules

C:\Users\darri\Kai-LIVE\            # LIVE server (port 8788)
|-- server.js                       # Main LIVE server (~2700 lines)
|-- brain_live.js                   # LIVE brain (different weights, 12 signals)
|-- kalshi.js                       # Kalshi HTTP client
|-- kalshi_ws.js                    # Kalshi WebSocket client
|-- coinbase_ws.js                  # Coinbase WebSocket client (authenticated)
|-- kilo.js                         # Kilo AI Gateway client
|-- live-home.html                  # LIVE dashboard
|-- all-no-markets.html             # ALL NO MARKETS page
|-- kai-live.ps1                    # LIVE control script
|-- kai.ps1                         # LIVE shortcut
|-- state.json                      # Persisted state
|-- Dockerfile                      # Railway deployment
|-- railway.json                    # Railway config
|-- .env                            # Credentials (live/demo keys, Coinbase, Kilo)
|-- package.json / node_modules
```

---

## [OK] WHAT'S BUILT & WORKING (HARD INFRASTRUCTURE)

### **Operator Law - Hard-Coded & Enforced**
| Location | Enforcement |
|----------|-------------|
| `server.js:1767-1768` (DRY) / `1829-1830` (LIVE) | Boot: `OPERATOR_LAW.assertNoSupervisor()` + `enforce('boot')` |
| `server.js:1342` (DRY) / `1402` (LIVE) | Toggle endpoint: only writer of `ls.running` |
| `server.js:573` (DRY) / `660` (LIVE) | Engine tick: mid-tick stop is absolute |
| Global `OPERATOR_LAW` object | Forbidden patterns: `supervisor`, `auto.start`, `auto.restart`, `keep.alive`, `watchdog`, `resurrect`, `reenable` |

**Result:** Button push = immediate absolute law. No supervisor, no auto-start, no auto-restart, no resurrection. Lane stays exactly as operator set it forever.

### **Single-Button Toggle (Both Dashboards)**
- Buttons: `<button id="btn-{name}" onclick="toggleStrategy('{name}')">Stop</button>`
- `paintNow()` paints intent instantly -> fetch -> server applies synchronously -> returns `{law: "OPERATOR_LAW_ENFORCED"}`
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
Persists to `state.json` - survives server restart.

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

### **Brain (Ensemble Signals) - 12 SIGNALS ACTIVE**
**Base 6 Signals (both `brain_dry.js` & `brain_live.js`):**
1. **Arbitrage** - risk-free when YES+NO < 1.0 (weight 1.0)
2. **Imbalance** - order book bid/ask size ratio (DRY 0.7 / LIVE 0.85)
3. **Volume** - volume spike momentum (DRY 0.6 / LIVE 0.75)
4. **Cross-Expiry** - per-minute cost across expirations (DRY 0.5 / LIVE 0.55)
5. **Whale** - follow large fills after 30s (DRY 0.3 / LIVE 0.55)
6. **Black-Scholes** - normal CDF fair value (DRY 0.15 / LIVE 0.2)

**Advanced 6 Signals (NEW - High Alpha):**
7. **Order Flow** - bid/ask size ratio + recent fill direction toxicity (DRY 0.65 / LIVE 0.85)
8. **Vol RP** - volatility risk premium: sell high-IV NO when realized < implied (DRY 0.55 / LIVE 0.7)
9. **Term Struct** - term structure arbitrage across expirations using BS fair (DRY 0.45 / LIVE 0.65)
10. **Funding Carry** - crypto carry: forward = spot * exp(r*tau) vs Kalshi price (DRY 0.5 / LIVE 0.6)
11. **Correlation Hedge** - portfolio heat: reduce size when BTC+ETH both signal same side (meta-signal)
12. **Settlement Alpha** - CF BRTI 60s TWAP vs Coinbase spot at settlement (DRY 0.7 / LIVE 0.8, final hour only)

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
- `kalshi_ws.js` in both folders - WebSocket client for markets/fills/orders
- Auto-reconnect, heartbeat, authentication
- Connected in `boot()` - subscribes to all lane series + fills + orders
- Updates `marketCache` with `source: 'ws'` for sub-second freshness

### **Coinbase WebSocket (Real-Time Spot) - NEW**
- `coinbase_ws.js` in both folders - HMAC-authenticated WebSocket client
- Channels: `ticker` for BTC-USD, ETH-USD, XRP-USD, HYPE-USD
- Connected in `boot()` - updates `spot` object in real-time
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

### **Dashboard Monitoring Panels (6 Panels) - NEW**
| Panel | Metrics | Endpoint |
|-------|---------|----------|
| Edge decay curve | edge at entry vs edge at exit per trade | `/api/monitoring` |
| Regime win rate | Win % by regime (arbitrage, high_vol, normal, etc.) | `/api/monitoring` |
| Signal attribution | Win % per signal source | `/api/monitoring` |
| Kelly efficiency | actual_return / kelly_return per trade | `/api/monitoring` |
| Execution quality | (fill - bid) / (ask - bid) - should be <= 0 for maker | `/api/monitoring` |
| ALL NO heatmap | Edge vs tau vs fair 3D surface | `/api/monitoring` |

### **Data Pipeline Upgrades - NEW**
| Upgrade | Implementation |
|---------|----------------|
| Options chain cache | `fetchOptionsChain(series)` - full chain per series (20 depths), 5s TTL |
| Settlement database | `state.settlement_db` - CF BRTI 60s TWAP proxy (Coinbase spot at settlement) |
| Fill quality tracker | `state.fill_quality_db` - tracks `(fill - bid) / (ask - bid)` at entry, maker <= 0 |

### **API Enhancements - NEW**
- **Rate limiting:** 120 req/min per IP (in-memory, skips health/static)
- **Webhooks:** CRUD at `/api/webhooks`, HMAC-signed payloads, fires on `trade_exit`

### **Railway Deployment Ready - NEW**
| Item | DRY (8787) | LIVE (8788) |
|------|-----------|-------------|
| Dockerfile | [OK] | [OK] |
| railway.json | [OK] | [OK] |
| Health check endpoint | [OK] `/api/health` | [OK] `/api/health` |
| Docker HEALTHCHECK | [OK] | [OK] |

### **Dashboard Buttons**
- All 9 lanes: `<button id="btn-{name}" onclick="toggleStrategy('{name}')">Stop</button>`
- `paintCards()` updates button text from snapshot (`Stop`/`Start`)
- Debug logging removed - clean production code

---

## * IMMEDIATE NEXT STEPS (NEW PRIORITIES)

### **1. Kalshi WebSocket Stabilization**
- Kalshi WS repeatedly disconnects (code 1006) - likely auth/permission issue
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

## * RESTART COMMANDS

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

## * HOW TO RESUME AFTER CONTEXT LOSS

1. **Read this file** - it's the single source of truth
2. **Check servers:** `curl http://127.0.0.1:8787/api/health` + `:8788/api/health`
3. **Verify buttons:** Open dashboard, click any "Stop" -> flips to "Start" instantly
4. **Check ALL NO:** `curl http://127.0.0.1:8787/api/no-lanes/book`
5. **Check monitoring:** `curl http://127.0.0.1:8787/api/monitoring`

---

## * KEY FILES FOR NEXT WORK

| Task | DRY File | LIVE File |
|------|----------|-----------|
| Kalshi WS fix | `kalshi_ws.js` + `server.js` boot() | same |
| Performance | `server.js`, `kalshi.js` | same |
| Testing | new `test/` folder | same |
| New strategies | `brain_dry.js` | `brain_live.js` |
| Observability | `server.js` logging | same |

---

**This file = your recovery point. Everything in [OK] is done. Everything in * is next. No guessing needed.**

---

## 2026-11-02 EXIT + ENTRY SETTINGS DECISION (evidence-based, LIVE only)

**Method:** all closed trades in `state.json` were re-scored against Kalshi's
PUBLISHED settlement result (public market endpoint, cached). "hold_pnl" = what
the trade would have paid held to settlement (fee adj). This separates ENTRY
quality from EXIT behavior.

**Exit changes (code - persisted in git):**
- TRAIL STOP OFF on every lane (`runtime.trail_stop=false`, default in
  `defaultState`, gate in `markLivePositions`). Evidence: 15 trail exits won
  86.7% at settlement; holding = +$29.82 more. Commit 63bea0b.
- HARD STOP-LOSS stays ON (operator decision). Aggregate hold-vs-realized on
  stopped trades was only about +$8 - near neutral, kept as loss cap.

**Entry band change (RUNTIME config via POST /api/config - lives in
`state.json`, NOT in git; re-apply if the state file is ever deleted):**
`runtime.all_no` = { min_entry_price: 0.45, max_no_price: 0.65,
max_yes_price: 0.65, brain_max_price: 0.65, max_concurrent: 4 } (other gates
unchanged: min_fair 0.58, min_edge 0.015, max_edge 0.18, spread .005-.08,
tau 40-2100, allow_yes true, brain_mode true).

Evidence (settled LIVE trades, side x entry price, win% vs breakeven):
- .30-.45 band: NO n=16 win 18.8% vs be 38.9 (-$41.55 hold) - THE BLEEDER.
  Pre-change caps (max_no/max_yes 0.42, min 0.15) pointed straight at it.
- .45-.55: NO n=25 win 64.0 vs be 50.9 (+14.69); YES n=3 win 66.7 (+3.33)
- .55-.65: NO n=19 win 73.7 vs be 57.9 (+25.17); YES n=6 win 66.7 (+8.60)
- .15-.30: only positive via lottery-settling outliers; banned by the floor.
Proven profitable band = 0.45-0.65 either side. Old posts at px 0.36/0.41
(cap 0.42) now rejected; first post-cap order went out at 0.56 cap 0.65.

**BUG FIXED IN CONFIG:** LIVE `all_no.max_concurrent` was missing ->
`count >= undefined` is false -> the concurrent-position gate NEVER FIRED on
LIVE. Now 4.

**DIVERGENCE POLICY:** DRY/Mirror (the lab) intentionally keeps loose gates
(no floor, caps 0.42). Do NOT sync this band into Mirror - it generates the
stats that let this call be re-verified.

**Monitoring gaps noticed (not fixed):** in live mode the all_no lane
heartbeat/last_skip are only written by the DRY code path (stale ages shown on
/api/strategies); lanes skip last_tick when they have no quotable market.---

## 2026-11-03 THE STALE-HYPE INCIDENT: FROZEN LANE LOOP - FULL AUTOPSY + FIXES

Symptom: /api/strategies heartbeats stuck for days on eth_1h/xrp_1h/HYPE lanes
while the server 'looked healthy'. Truth: the 2s lane tick ran exactly ONCE per
restart and never again. It was NEVER about Kalshi rotating HYPE ids -
series_kind v3 finds HYPE books fine (KXHYPE15M discovered, evaluating, real
skip reasons like 'probability floor (0.30 < 0.65)').

Root cause (a family of unbounded awaits in the tick's serial path):
  1. kalshi.js raw(): fetch() WITHOUT timeout - Node's fetch can wait forever
     on a stalled connection. One hung quote froze every lane behind it.
     -> AbortSignal.timeout(15s) (also in DRY).
  2. series_kind refreshCatalog: single SHARED in-flight catalog promise - one
     hung /series starved all 4 coin families. -> per-coin slot + 25s race
     deadline -> BOOT_DEFAULTS fallback (also in DRY).
  3. engineTick ran unguarded in a 2s interval body: any hung await blocked
     the loop forever. -> runTick wrapper: one tick in flight + 90s deadline.
  4. kilo.js chatOnce: LLM fetch un-timed. -> 20s AbortSignal (also in DRY).
  5. LIVE all_no scan cadence: state.runtime.all_no had NO scan_interval_ms ->
     setInterval(fn, undefined) fired ~every 1ms = request storm -> Kalshi 429s
     saturated the THROTTLE queue -> ticks starved. scan_interval_ms=10000 set
     via /api/config (RUNTIME - lives in state.json).
  6. live_engine balance: bal.at only stamped on SUCCESS -> refreshIfStale saw
     age=Infinity forever and ping-ponged the engine backoff at Kalshi's rate
     limit (~4x/min sustained). bal.at now stamps on every ATTEMPT.

Also in this package: TRAIL STOP EXTERMINATED (code deleted in LIVE+DRY -
trailArmed/trailStop/pos.hwm/trail_pct/runtime.trail_stop are gone; winners
ride to settlement; hard stop_loss + take_profit + time_decay remain), and
live-mode all_no heartbeat/last_tick written honestly.

EVIDENCE THE CURE WORKS (00:37Z): all 9 lanes ticking 2s-cadence with real
skip reasons; live_balance recovered; all_no scanning at 10s cadence; real
in-band orders placed (e.g. NO 0.58 cap 0.65). NOTE: DRY and LIVE share the
live Kalshi key's rate-limit pool - see recommendations.
---

## 2026-11-03 'LIVE LOVES TO FAIL' AUTOPSY (the exits, the deaths, the cash)

1) THE EXITS ATE THE EDGE. Fee-adjusted re-scoring of the SAME in-band entries
(0.44-0.66, 56 settled): win rate 67.9%, hold-to-settle EV +$48.06, realized
-$30.64. The -20% stop cut 69 band trades; 21 of them settled as WINNERS.
FIX (code, pushed): ALL NO positions now ride to settlement - take_profit
stays ~0.95, stop fires only at a -70% disaster floor (entry x 0.30),
time-decay only past 90% of life AND bid < 0.95x entry. Verified live: one
YES 0.62 -> mark 0.919 riding with no stop interference.

2) THE DEATHS WERE NOT SPONTANEOUS. 14 boots in the ring line up with the
session's intentional restarts; a taskkill /F death leaves NO handler output
and the old stderr is overwritten on relaunch (the silent-death mechanism).
FIX (code, both repos): crash.log witness - uncaughtException / unhandled
rejection / exit / SIGTERM / SIGINT stamped before death, plus a 30s
'ALIVE uptime=Ns' last-words heartbeat. Time of death = last ALIVE stamp.
Verified: crash.log ticking on both servers.

3) DRY NEVER TOUCHED THE LIVE KEY - audit: its 'live_balance' is dryCash().
(My earlier warning was wrong; corrected here.) The balance-429 loop was
LIVE's own (attempt-stamp fix, pushed). tape.ps1's DOWN line can fire on a
single failed health probe - crash.log is now the ground truth for death.

CASH: the tape's BAL/ACCT +- moves are settlements/fills of the ledger,
not mystery losses. Watch: capital now ties up until settlement (max 4
concurrent by design). Re-audit hold-vs-realized tonight to confirm the
bleed flipped; the 67.9% win number needs n>=100 in-band to be trusted.

---

## 2026-11-03 THE REAL REASON FOR THE LOSSES: THE MODEL WAS SELLING A FAKE EDGE

Calibration of claimed fair vs ACTUAL Kalshi settlement (LIVE trades):
  claimed fair 0.50-0.55  n=11  actual win 36.4%  (model 15 pts overconfident)
  claimed fair 0.55-0.60  n=8   actual win  0.0%  (pure fiction)
  claimed fair 0.60-0.65  n=13  actual win 69.2%  (honest)
  claimed fair 0.65-0.70  n=60  actual win 61.7%  (honest)
  claimed fair 0.70-0.80  n=38  actual win 71.1%  (honest)
The cheap entries on the tape (in=0.39 fair=0.55) live in the zone where the
gaussian digital model is demonstrably wrong. min_fair 0.58 let them through.

P&L BY PRICE PAID (settled trades, LIVE's real fee 1.15c/contract, held to settle):
  p<.40    n=19  win 21.1% vs 31.5% breakeven -> -$25.69   <- ALL OF THE LOSS
  .40-.50  n=16  win 50.0% vs 46.3%            ->  +$5.19
  .50-.60  n=39  win 71.8% vs 55.4%            -> +$43.99
  .60-.70  n=5   win 80.0% vs 61.1%            ->  +$5.66
LIVE lifetime -$29.46; the sub-40c population alone was -$25.69 of it.
Everything bought above 45c has been positive.

GATE CHOSEN BY COUNTERFACTUAL (hold-to-settle, real fees, LIVE history):
  NOW  .45/.65 fair>=.58 edge<=.18  n=70  win 67.1%  +$47.78
  G    .50/.70 fair>=.62 edge<=.30  n=85  win 70.6%  +$61.28   <- APPLIED
Applied via POST /api/config (RUNTIME - lives in state.json, not git):
  min_entry_price 0.50, max_no_price 0.70, max_yes_price 0.70,
  min_fair 0.62, max_edge 0.30, brain_max_price 0.70

WHY DRY LOOKED PROFITABLE WHILE LIVE LOST - two structural lies in the lab:
  1) FEES. DRY booked 1.75% of exit proceeds only (avg 0.60c/contract). LIVE
     actually pays 1.15c/contract; Kalshi's rule is 0.07*p*(1-p) per contract
     on BOTH legs. FIXED in Kai-Mirror (entry + exit legs, real formula).
  2) FILL REALISM. The paper book credits every resting bid as filled. Real
     post-only bids fill mostly on adverse moves - which is why LIVE's cheap
     entries won 21% while DRY's won 51% in the SAME band. NOT modelled yet;
     it is the next honesty fix for the lab.

STATUS: LIVE gate live (floor .50 caps .70 fair .62), 0 open positions,
crash.log witnessing on both servers (it recorded DRY's 04:09 restart).
n=85 is still small - this gate is evidence-backed, not a promise.
---

## 2026-11-03 SIZE GOVERNOR (operator decision: keep trading, cut size)

Applied to LIVE only; DRY keeps its own paper sizing.
  clip_state.base = 1.50, clip_state.max = 1.50   (ceiling == base)
  runtime.clip = 1.50, runtime.max_position_pct = 0.30
  all_no.max_concurrent = 2, all_no.max_exposure_pct = 0.6
Code defaults in server.js + live_engine.js changed from { base: 3, max: 25 }
to { base: 1.5, max: 1.5 } so a wiped state.json cannot silently restore the
auto-growing clip.
WHY THE CEILING MATTERS: noteClipOutcome() adds +1 to base every 3 wins up to
max (was 25). Setting only runtime.clip would have been climbed straight back
up by the first winning streak - the governor caps the grower itself.

OPS INCIDENTS DURING THIS CHANGE (all mine, all fixed):
  1) I put a // comment INSIDE a parenthesised expression, swallowing the
     closing ');' - LIVE refused to boot (SyntaxError). Reverted to the last
     good commit, re-applied as a pure value swap, node --check clean on both
     files, LIVE booted (boot_count 19, visible in crash.log).
     LESSON: comments never go on a line whose tail is required syntax.
  2) Scheduled task \KaiWatchdog (temp\opencode\watchdog.ps1 -> kctl.ps1)
     resurrected LIVE 43s after I stopped it; that stale process then saved
     state.json from its own memory and CLOBBERED my governor edit. Disabled
     the task, stopped LIVE cleanly, wrote state, started via kctl, proved
     the values survived saves, re-armed the task. Verified the watchdog only
     restarts the PROCESS - it never writes ls.running, so lane toggles still
     obey OPERATOR_LAW.
  3) kai.pid pointed at a dead pid while the real server ran under a
     different pid, so 'kctl stop live' could not stop the running server
     (that is what caused my 04:40 EADDRINUSE death). pidfile realigned.

STATE: 9/9 lanes running, 0 open positions, 0 resting orders. Gate = price
.50-.70 either side, fair>=.62, edge<=.30. Exits = TP .95 / disaster floor
.30x entry / decay at 90% life. No trail stop anywhere.
## Addendum 2026-11-03 late: fill_sim is LIVE in the lab, with corrections

- /api/fill-realism reports intents, filled, unfilled, fill_rate, adverse_pct,
  avg_wait_ms; counters persist in state.fill_realism. Logs: sim_intent,
  sim_fill (with adverse flag and the print that hit us), sim_unfilled (reason).
- Crossing direction is side-aware because Kalshi prints in YES cents: a YES bid
  fills on a print <= our level; a NO bid fills on a print >= 1 - our level.
  (My first version had this backwards and produced a fake 0% fill rate.)
- A volume baseline is taken on the intent's FIRST observed quote, so a fill can
  never be proved by volume that already existed when the intent was created.
- First measurement under the corrected rule: 6 intents, 1 fill, and that fill
  was ADVERSE (100%) - the bid was hit because the market had moved through us.
- Confidence ceiling: LIVE enforces fair 0.62-0.75; DRY leaves the ceiling OFF so
  the lab keeps logging the loud-claim zone that calibration proved is fiction.
- Lab totals are still not evidence: fills are now honest, but queue position is
  still approximated (we assume we were next in line at our level).
## 2026-11-03 CRASH/BOOT ROOT CAUSE FIX (found, fixed, and TESTED - not theory)

What actually killed the servers (the "SERVER DOWN / boots 23 / lanes 0 on" tape):
  1. watchdog.ps1 probed /api/health with a 3 SECOND timeout. A merely SLOW
     server read as DOWN -> kctl restart -> taskkill /F = SIGKILL. SIGKILL runs
     no handler, so there was NO crash.log entry, and it could tear state.json.
  2. save() used a raw writeFileSync, so a kill mid-write left a corrupt file.
  3. loadState() swallowed the parse error and returned defaultState(), so the
     next boot silently ran on DEFAULT risk: 9 lanes -> 0, and the price floor,
     fair floor, clip and exposure cap were all gone. That is "lanes 0 on".
  The watchdog was not saving the machine, it was disarming it.

The permanent fix (both repos, every point verified by test):
  * state.json is written ATOMICALLY (temp -> fsync -> rename); a rolling
    state.backup.json keeps the last known good copy.
  * loadState(): primary -> backup -> FAIL CLOSED. If neither parses, the server
    boots with safe_mode=true, every lane off, and NO trading (LIVE order
    placement is hard-blocked in kalshi.js placeOrderV2), and it says so in
    /api/health (safe_mode, state_source) and in crash.log (BOOT ...).
  * config.json (NEW, version controlled) holds the operator risk gates and is
    overlaid on state at every boot, so a torn or deleted state file can never
    loosen the gates. Edit config.json, commit, restart.
  * POST /api/shutdown flushes state atomically and exits cleanly. kctl.ps1 now
    stops servers GRACEFULLY first and force-kills only as a fallback; it also
    rotates server.log/server.err, because a log still held by a dying process
    silently killed the new child with an empty error log.
  * watchdog.ps1 v2: a TCP REFUSED means down; a LISTENING but slow server is
    alive and is NEVER killed; two consecutive refusals before acting; 5 min
    cooldown; graceful stop. It never touches lane flags.
  * crash.log: every line now carries its PID, the exit handler records the
    STACK that ended the process, and the witness is registered at the very top
    of the module so an early boot failure cannot escape unrecorded.
  * ops/watchdog.ps1 and ops/kctl.ps1 are now in git (they used to live only
    in Temp, where a cleanup would have silently removed the fix).

TESTED by deliberately corrupting state.json: it recovered from the backup with
all 9 lanes and all gates intact (source=backup); with BOTH copies destroyed it
came up in safe_mode with trading blocked (source=none) instead of trading on
defaults - and it stayed up for inspection rather than vanishing.
