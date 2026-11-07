# Kai-LIVE — the real-money book

Kalshi crypto (BTC/ETH/XRP/HYPE 15m + 1h up/down) live trading engine.
Node.js, zero build step, one process, one port: **8788**.

## Operator law (read first)

`OPERATOR_LAWS.md` is binding, not advisory:

1. **NO fee-attached exits, ever.** `stop_loss` / `take_profit` / `trail_stop`
   are forbidden — enforced at runtime by `OPERATOR_LAW.assertNoFeeExit()`
   placed at the single real-money exit chokepoint (`live_engine.exitPosition`).
   Positions ride to settlement. Size is the loss limit.
2. **Data-buy doctrine.** Per-order cap $0.50 (`effectiveClip`), ride to
   settlement, evidence is the product.

Removal or change of either requires the operator's express written order.

## Architecture (what each file is FOR)

| File | Purpose |
|---|---|
| `server.js` | HTTP API + dashboard + lane orchestration + boot wiring |
| `live_engine.js` | Real-money order path (entries, settlement exits, law chokepoint) |
| `kalshi.js` | Signed Kalshi REST client, cache + rate/429-aware |
| `kalshi_ws.js` | Kalshi market websocket feed |
| `kalshi_stream.js` | Kalshi account/order stream |
| `coinbase_ws.js` | Coinbase spot websocket (fair value / settlement truth) |
| `perp_feed.js` | Perp basis feed |
| `quote_stream.js` | Quote aggregation for scanners |
| `series_kind.js` | Series taxonomy (15m vs 1h etc.) |
| `certainty.js` | Certainty lane: WS-verdict favorite harvesting |
| `conviction.js` | Conviction press sizing from settled-trade evidence |
| `calibration.js` | The vaccine: model calibration vs outcomes |
| `data_facts.js` | Settled-trade fact store (detective input) |
| `alpha_gate.js` | Promotion gate: nothing runs live without dry evidence |
| `hold_rule.js` | Hold-window rules (allowed exit reasons) |
| `brain_live.js` + `kilo.js` | LLM advisor + its client (recommendations only) |
| `detective.js` | Always-on edge miner (own db + Kalshi/Polymarket/Manifold), walk-forward verified, NEVER trades |
| `live-home.html`, `chart.umd.min.js`, `static/` | Dashboard (10 lane cards incl. certainty) |
| `ops/kctl.ps1`, `ops/watchdog.ps1` | Canonical process control + watchdog |
| `tools/` | Operational probes + `fetch-shards.js` (shard account bootstrap) |

## Running

```powershell
# canonical control
powershell -File ops/kctl.ps1 live restart
# dashboard
http://127.0.0.1:8788/
# live tape (DETECTIVE line included)
powershell -File tape.ps1
```

## API highlights

`/api/health` · `/api/strategies` (10 lanes) · `/api/certainty` ·
`/api/detective` (edge-miner findings) · `/api/ops/sync-cash` ·
`/api/no-lanes/book`

## Tests

```bash
node hold_rule.test.js   # hold-window rules
node ledger.test.js      # ledger arithmetic
node alpha_gate.test.js  # promotion gate
```

## Hygiene law (2026-11-07)

Session debris (one-off fix scripts, probe droppings, snapshot dumps) is
never committed — `.gitignore` enforces the patterns. Git history keeps
everything removed in the 2026-11-07 purge if archaeology is ever needed.
The 190 losing trades and 136 calibration rows are DATA LAW: never delete.
