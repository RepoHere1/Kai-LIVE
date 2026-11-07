# Kai: From Asserted Edge to Measured Alpha

**Status: LIVE :8788 (real money) · MIRROR :8787 (dry, report-clamp mode)**

This document records the transformation of the Kai Kalshi trading system from a
machine that *asserted* edge into one that must *earn* the right to trade through
measured verdicts. If you are resuming work on this box after a gap, read this first.

---

## 1. The Autopsy That Started It (do not forget this)

A P&L post-mortem (`pnl_probe.js`, 190 trades) found:

| Metric | Value |
|---|---|
| Trades | 190 |
| Win rate | 33.7% |
| Net P&L | **−$33.37** |
| `edge_at_entry` predictive power | **ZERO** (edge_lift −0.0345) |

The headline metric the system traded on — "edge at entry" — had no correlation
with outcomes. Every trade was a coin flip with fees. That is the fact every rule
below exists to prevent repeating.

## 2. The Four Transformations

### 2.1 Cash Ledger — the 429 storm is dead (LIVE `e997553`)

**Root cause:** Kalshi WS v2 has **no balance channel** (verified: sub code 8).
So every fill, tick, and dashboard poll was demanding a REST balance read. The
result was a self-inflicted 429 storm.

**The fix — balance is computed, not fetched:**
- Balance = anchor + Σ booked money events (fills, settlements, fees).
- REST balance is demoted to a **validator**: jittered, single-flight,
  negative-cached (a timeout caches "don't ask again" for a cooldown window).
- Fills, ticks, and display can no longer trigger reads.
- No anchor → **fail-closed: no orders.** An unanchored ledger is a stopped lane,
  not a degraded one.
- Tests: `ledger.test.js` (green).

### 2.2 Alpha Gate — trading rights are earned (both repos, `9c973e3`)

`alpha_gate.js` encodes the autopsy as law. Every order intent passes through it:

| Verdict | Consequence |
|---|---|
| REFUTED (measured negative edge) | **Hard-blocked.** No order can be placed. |
| UNPROVEN (not enough settled evidence) | **Clamped to 1 contract.** |
| Thin/new lane (own sample too small) | **Pooled verdict applies.** |
| PROVEN (≥15 settled, positive lift) | Normal sizing. |

Plus:
- **Feed gate:** Coinbase spot stale >3s → no trade (price is the input to everything).
- `test_flag` orders are exempt (proof trades must always be able to run).
- Certainty-lane evidence recording is **decoupled from usable cash** — a $0 or
  unanchored account still records evidence; it just can't place orders.
- Surfaces: `GET /api/alpha`, `health.alpha`.
- **Mirror runs report-clamp mode:** the same verdict engine, but dry orders are
  clamped to 1 and *reported*, never blocked. Mirror is the proof ground.

### 2.3 Parallel Certainty Scanner (LIVE `de91399` / Mirror `67bb31d`)

The old serial scan took **>110s** — longer than the 20–300s life of the
opportunity it was scanning for. It scanned one coin at a time, one REST call at
a time, with no budget on anything.

**The new scan is two-stage and bounded:**
- **Stage 1** — all coins' series fetched **concurrently**, each under a **6s
  budget**; CPU z-pre-filter runs inside each worker.
- **Stage 2** — z-survivors sorted by |z| (strongest first), top **8** quoted in
  a **6-wide pool**, each quote under a **4s budget**.
- A hanging REST call resolves as `null` and becomes a **recorded refusal**
  (`quote failed (4s budget)` in the notes) — never a stall.
- `took_ms` telemetry in the response.

**Measured:** serial >110s → **1.2s–7s wall** (hard worst case ~14s by
construction). The first Mirror pass after the port found an in-window candidate
— something structurally impossible under the serial scan.

### 2.4 Shadow Tape — the evidence loop is now observable

Shadows (free paper bookings of blocked/unproven candidates) were being booked
internally but never written to the tape — `pushShadowEvent` filled a ring
buffer nothing read. Now `calibration.js` logs:
- `shadow_open` — every booking (ticker, side, strategy, price, claimed,
  adjusted, asset, horizon, tau, strike)
- `shadow_settled` — every settlement (WIN/LOSS, pnl, price, claimed)

These appear on the tape (`/api/logs`) next to real fills. The certainty ledger
graduates on these settled shadows.

## 3. Also Shipped

- **Hold rule fail-closed** (`hold_rule.js`, Mirror `cf27705` / LIVE `8849a30`).
- **`/api/test-trade`** — 1-contract proof endpoint on LIVE; bypasses sizing but
  not the gate's safety rails; flagged `test_flag`.
- **`/api/certainty-scan`** — manual scan trigger w/ timing telemetry.
- **`pnl_probe.js`** — the autopsy tool. Re-run it whenever you wonder if the
  system is actually working.

## 4. Operating Invariants (the law)

1. **No anchor, no orders.** Ledger fail-closed beats "probably fine."
2. **REFUTED means blocked.** Not "sized down." Blocked.
3. **UNPROVEN means 1 contract** — and only if the lane's own ledger says so.
4. **Stale feed means no trade.** A 3s-old price is a guess.
5. **Every REST call has a budget.** A timeout is data, not an emergency.
6. **Evidence records even when money can't move.** The verdict loop never sleeps.
7. **Mirror proves, LIVE earns.** Nothing trades real size until Mirror's verdicts
   say it should.

## 5. Graduation Path (how a lane earns size)

```
new lane ──▶ UNPROVEN (clamped to 1)
              │  shadows booked on every blocked candidate, settled on expiry
              ▼
        ≥15 settled candidates ──▶ compute verdict (win-rate vs claimed edge)
              │                        │
        negative lift             positive lift
              │                        │
              ▼                        ▼
           REFUTED                 PROVEN ──▶ normal sizing, watch the drift
        (hard-blocked)
```

## 6. Ops Runbook

**Restart (the safe way):**
```powershell
# 1. kill by pid (never "by port" — launcher health checks can pass against
#    the OLD process; silent swap)
taskkill /F /PID <pid from /api/health>
# 2. launch detached (command windows tree-kill fresh servers)
Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','C:\Users\darri\Kai-LIVE\start-live.ps1' -WorkingDirectory 'C:\Users\darri\Kai-LIVE' -WindowStyle Hidden
# 3. verify: port owner pid == /api/health pid
netstat -ano | findstr :8788
```

**Anchor the cash ledger** (when Kalshi REST recovers):
```
POST /api/ops/sync-cash  {"force": true}
→ verify health.cash_ledger.ledger_cash is non-null
```

**Watch (in priority order):**
- `health.alpha` — verdicts per lane
- `health.cash_ledger` — anchored? balance sane?
- `/api/certainty` — candidates > 0 as rounds near expiry; settled count
- `/api/logs` — `shadow_open` / `shadow_settled` lines appearing
- scan `took_ms` — should be low four figures, not six

**Known gotchas on this box:**
- Kalshi REST intermittently times out / 429s. The ledger absorbs it; do not
  "fix" it by adding reads.
- Shell spawns occasionally stall (suspected AV/disk churn). Commands have a
  30s cap here; detached anything must be launched in a command that returns
  immediately, or the tree-kill takes it down.
- `server.js` contains literal `\"` sequences in comments; editor anchors on
  those lines fail — use .NET line-range splices.

## 7. State at Time of Writing (2026-11-07 ~05:45 UTC)

- Both servers restarted on the new code after a hard box event (~04:45–05:07
  UTC, no graceful exit — crash.log NULs). Verified: port owners match health
  pids (LIVE 3720 :8788, Mirror 8920 :8787).
- Scan timings verified post-restart: LIVE 2.7s wall, Mirror 6.7s wall (one
  quote burned its 4s budget — by design).
- Cash ledger: **unanchored** (Kalshi balance REST still timing out). Lane is
  fail-closed. `sync-cash force` fired; awaiting a clean read.
- Certainty ledger: candidates were being caught (Mirror found one on its first
  fast scan); graduation needs ≥15 settled.
- Both repos' transformation commits pushed (LIVE `de91399`, Mirror `67bb31d`
  + this document).

