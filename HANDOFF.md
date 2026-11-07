# HANDOFF.md — READ THIS FIRST (Cline resuming on new hardware)

**Written 2026-11-07 ~16:45 UTC by the previous Cline instance.**
**You are the successor. This file + `TRANSFORMATION.md` (also in repo root) are your
complete memory. Read both top to bottom before touching anything.**

---

## 0. What happened

The operator moved this project off the old PC (it was hard-killing node processes,
rebooting mid-session, and stalling shell spawns). You are on new hardware. The old
box's servers (LIVE pid 12312, Mirror pid 12704) are gone. Everything that matters is
in git (this push) plus the `handoff/` snapshot folder — plus TWO FILES git cannot
carry: see §5 "MANUAL COPY REQUIRED" before you start anything.

## 1. The project in one paragraph

Kai trades Kalshi crypto prediction markets (BTC/ETH/XRP/HYPE 15m + hourly series).
Two repos, two servers:
- **kai-LIVE** → `:8788`, real money, `start-live.ps1`
- **kai-mirror** → `:8787`, dry lab in **report-clamp mode** (same alpha-gate law,
  but verdicts clamp paper size to 1 instead of blocking), `start-dry.ps1`

On 2026-11-06/07 the system was transformed from "asserted edge" (which lost $33.37
over 190 live trades, winrate 33.7%, edge_at_entry with ZERO predictive power) into a
**measured-alpha machine**: trading rights are earned from settled-outcome verdicts.
The full story, law, and runbook are in `TRANSFORMATION.md`. Trust it.

## 2. Verified state at handoff

- **Git**: LIVE `a0143c4`, Mirror `f5e1dad`, both pushed, trees clean (+ this handoff
  commit). All transformation work (hold rule, cash ledger, alpha gate, parallel
  scanner, shadow tape) is committed and deployed on both.
- **Alpha verdicts (live-served, verified)**: midbook **REFUTED** on both repos;
  certainty **UNPROVEN** on both (0 settled — see the bug, §3).
- **Mirror dry certainty ledger**: 8 settled trades, 50% winrate, +$0.73 net. All
  NO-side. Pattern worth knowing: 3 of 4 losses were HYPE cheap-NO (0.21/0.086
  entries); BTC/ETH/XRP NOs at moderate prices won. n=8 << the ≥15 graduation bar.
- **Dry book (all_no)**: $358.69 from $303 start, 2014 lifetime entries, honest fill
  simulator (53% fill rate, 91% of misses adverse — no fantasy fills).
- **Kalshi REST was DOWN ALL DAY Nov 7** (balance reads time out at 20s; series/market
  reads return nothing — the settlement sweep's scan tally is empty). Everything
  degraded fail-closed exactly as designed. Coinbase WS was healthy.
- **Cash ledger on LIVE: UNANCHORED** → no orders possible (fail-closed law). The
  moment Kalshi REST recovers: `POST :8788/api/ops/sync-cash {"force":true}` then
  verify `health.cash_ledger.ledger_cash` is non-null.
- **Scanner**: parallel two-stage, 1–7s wall (was >110s serial). Budgets everywhere;
  a hanging REST call resolves as a recorded refusal, never a stall.
- **Shadow tape**: `shadow_open` events log correctly (verified on tape). But
  `shadow_settled` NEVER fires — see §3.

## 3. THE BUG — verified, root-caused, NOT yet fixed. THIS IS YOUR FIRST ACT.

`data_facts.js` line 172 (both repos) prunes the **cert certainty-verdict table**
with `LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000` — a retention policy written for the
tick cache (`facts` table) and copy-pasted onto the **verdict ledger**. Consequence,
verified by direct sqlite inspection: **`cert` = 0 rows in BOTH repos** despite a
full day of recorded candidates. Graduation needs ≥15 SETTLED rows; the ledger
forgets everything older than 6 hours while settlements stall for hours behind the
Kalshi REST outage → **the certainty lane can never graduate. Ever.**

Second half of the same jam: shadows settle ONLY via the `noBook()` sweep's REST
reads (`server.js` ~line 2350: `if (q.result === 'yes' || q.result === 'no')
CALIB.settleResult(...)`). With REST blind, nothing settles — 318 pending shadow rows
in Mirror's `trading.db` `calibration` table (136 settled), and the count only grows.

## 4. THE PLAN — presented to operator, direction approved, execution paused before "go"

The operator asked for: purge history that diverts from profitable trading, and
harden high-conviction trades against lying data sources. The plan (7 steps, both
repos, in order):

1. **Fix cert retention** (`data_facts.js`): cert gets its own policy — settled rows
   kept 90 days, pending rows never age-deleted, row cap 50k. (Highest priority:
   every hour the 6h amnesia stays, another 6h of evidence dies.)
2. **Extricate settlement from dead REST** (`calibration.js` + `server.js`): derived
   settlement from Coinbase WS spot-at-expiry vs strike, ONLY when confident
   (|spot−strike| > 2σ of remaining time; boundary cases stay pending for official).
   Later official results reconcile + log disagreements. Plus one budgeted,
   negative-cached REST retry per pending market per 10 min. No storm, ever.
3. **Zombie sweep** (`calibration.js`): pendings whose markets closed >7d ago with no
   resolvable result → `outcome='unknown'`, dropped from memory map, tombstone logged.
4. **High-conviction hardening** (`server.js`/`live_engine.js`/`alpha_gate.js`):
   quote-freshness gate at entry (WS quote >5s old → refuse); **exits become
   gate-exempt** (feed/cash fail-closed gates ENTRIES, never traps an open position —
   stale feed triggers flatten, not freeze); `health.data_quarantine` surfaces every
   quarantined source (stale spot, frozen quote, negative-cached REST).
5. **Dead artifact purge** (after mandatory reference grep): Mirror's
   `quant_*.json`, `cand_*.json`, `cf_*.json`, `quant_state_snapshot.json` (Nov-3
   offline analysis, ~7MB), `kai_sniper.log`, stale push logs. Same for LIVE's logs.
6. **NEVER DELETE** (this is the trap, explained): the 190 losing live trades (they
   ARE the midbook REFUTED verdict — deleting them un-refutes the lane and re-arms
   the exact strategy that lost $33), the 136 settled calibration rows, the 8 settled
   certainty dry trades. Settled evidence is truth. Pending-unresolvable is dead
   weight. That is the whole line.
7. **Restart both, verify, commit, push**: cert rows survive past 6h, first derived
   settlement lands on the next 15m expiry, zombie count drops, quarantine in health,
   `node --check` + tests green.

Operator's exact words driving this: "sweep all historical trades and remove them IF
they are diverting the objective of creating profitable trades... make an enhancement
on HIGH CONVICTION trade possibilities where we can get the poison out of them that
is lying data sources that kill us as soon as the trade is alive."

## 5. NEW-PC BRING-UP (do in this exact order)

**MANUAL COPY REQUIRED — git cannot carry these (gitignored):**
1. `.env` in EACH repo (Kalshi API credentials — servers cannot auth without it).
   The previous instance deliberately did NOT commit secrets.
2. For FULL continuity: `facts.db`, `trading.db`, `state.json` from each repo root
   (stop the old servers first, then copy; sqlite + hot copies don't mix). The new
   repos include a `handoff/` snapshot folder (state.json copy + calibration table
   export at handoff moment) as the FALLBACK if the DBs are lost — verdict evidence
   survives either way, but the DBs carry everything else (80k/27k trades, 93k/101k
   facts, fill quality).

**Then:**
```
git clone both repos; npm install in each
node --check server.js            # both repos, must be clean
# launch DETACHED (command windows tree-kill fresh servers):
Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','<repo>\start-live.ps1' -WorkingDirectory '<repo>' -WindowStyle Hidden
# (start-dry.ps1 for Mirror)
# VERIFY (never trust the launcher's own health check — it can pass against a
# stale process): /api/health pid must equal the netstat port-owner pid.
```
If `handoff/state.json` is being used (DBs not carried): copy it to repo root as
`state.json` BEFORE first launch. The boot backfill rebuilds in-memory structures.

**First acts after bring-up, in order:**
1. Confirm both servers healthy (health + a certainty-scan: expect 1–7s wall).
2. Check Kalshi REST: if recovered → `POST :8788/api/ops/sync-cash {"force":true}`,
   verify `health.cash_ledger.ledger_cash` non-null.
3. Execute the §4 plan, step 1 first (the cert retention fix).
4. Confirm with operator before §4 step 5 (artifact deletion is the only
   destructive step) — everything else is additive.

## 6. BOX GOTCHAS (mostly old-PC, keep them in mind anyway)

- Kill servers by pid from `/api/health`; verify port owner after relaunch.
- Launchers detached only; command-window closes tree-kill children.
- Shell commands on slow disks: keep them under ~25s, no long sleeps inline.
- `server.js` contains literal `\"` sequences in comments — editor old_text anchors
  on those lines fail; use .NET line-range splices (`[IO.File]::ReadAllLines`).
- Kalshi WS v2 has NO balance channel (verified, code 8) — balance is computed from
  the ledger, REST is only a validator. Do not "fix" balance by adding reads.

## 7. KEY FILE:LINE INDEX (both repos unless noted)

- `data_facts.js:44` — LEDGER_MAX_AGE_MS = 6h (THE BUG, §3); `:172` cert prune
- `data_facts.js:238-268` — certaintyRecord / flushCert / certaintyOutcome / stats
- `server.js:~2350` — settlement rides noBook() REST sweep only (Mirror; LIVE similar)
- `server.js:~3841-3871` — LIVE certainty pass: scan → record → THEN cash gate (the
  decoupling law, working; the "0 candidates recorded" skip text is just confusing)
- `alpha_gate.js:29-36` — verdict thresholds (PROOF_MIN_TRADES 30, CERT_PROOF_SETTLED 15)
- `calibration.js:42` — SHADOW_PENDING_CAP 2000; `:220` settleResult; `:408` boot reload
- Tables: trading.db{trades,positions,settlements,fill_quality,calibration};
  facts.db{facts,cert}. Mirror row counts at handoff: trades 80692, calibration
  454 (318 pending/136 settled), cert 0. LIVE: trades 27592, calibration 21, cert 0.

## 8. WATCH LIST (what "healthy" looks like after the §4 plan lands)

- `cert` rows survive past 6h; `settled` climbs toward 15 → first certainty verdict
- `shadow_settled` lines on `/api/logs` after each 15m expiry
- pending count drops by zombies (~318 → near-zero live-relevant)
- `health.data_quarantine` present and honest
- Mirror dry certainty winrate on growing n — HYPE cheap-NO is the suspect bucket

Good luck. Don't delete the evidence. The whole machine exists to earn the right to
trade — including the parts of history that hurt.


## 5. NEW-PC BRING-UP (do in this exact order)

**MANUAL COPY REQUIRED — git cannot carry these (gitignored):**
1. `.env` in EACH repo (Kalshi API credentials — servers cannot auth without it).
   The previous instance deliberately did NOT commit secrets.
2. For FULL continuity: `facts.db`, `trading.db`, `state.json` from each repo root
   (stop the old servers first, then copy; sqlite + hot copies don't mix). The new
   repos include a `handoff/` snapshot folder (state.json copy + calibration table
   export at handoff moment) as the FALLBACK if the DBs are lost — verdict evidence
   survives either way, but the DBs carry everything else (80k/27k trades, 93k/101k
   facts, fill quality).

**Then:**
```
git clone both repos; npm install in each
node --check server.js            # both repos, must be clean
# launch DETACHED (command windows tree-kill fresh servers):
Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','<repo>\start-live.ps1' -WorkingDirectory '<repo>' -WindowStyle Hidden
# (start-dry.ps1 for Mirror)
# VERIFY (never trust the launcher's own health check — it can pass against a
# stale process): /api/health pid must equal the netstat port-owner pid.
```
If `handoff/state.json` is being used (DBs not carried): copy it to repo root as
`state.json` BEFORE first launch. The boot backfill rebuilds in-memory structures.

**First acts after bring-up, in order:**
1. Confirm both servers healthy (health + a certainty-scan: expect 1–7s wall).
2. Check Kalshi REST: if recovered → `POST :8788/api/ops/sync-cash {"force":true}`,
   verify `health.cash_ledger.ledger_cash` non-null.
3. Execute the §4 plan, step 1 first (the cert retention fix).
4. Confirm with operator before §4 step 5 (artifact deletion is the only
   destructive step) — everything else is additive.

## 6. BOX GOTCHAS (mostly old-PC, keep them in mind anyway)

- Kill servers by pid from `/api/health`; verify port owner after relaunch.
- Launchers detached only; command-window closes tree-kill children.
- Shell commands on slow disks: keep them under ~25s, no long sleeps inline.
- `server.js` contains literal `\"` sequences in comments — editor old_text anchors
  on those lines fail; use .NET line-range splices (`[IO.File]::ReadAllLines`).
- Kalshi WS v2 has NO balance channel (verified, code 8) — balance is computed from
  the ledger, REST is only a validator. Do not "fix" balance by adding reads.

## 7. KEY FILE:LINE INDEX (both repos unless noted)

- `data_facts.js:44` — LEDGER_MAX_AGE_MS = 6h (THE BUG, §3); `:172` cert prune
- `data_facts.js:238-268` — certaintyRecord / flushCert / certaintyOutcome / stats
- `server.js:~2350` — settlement rides noBook() REST sweep only (Mirror; LIVE similar)
- `server.js:~3841-3871` — LIVE certainty pass: scan → record → THEN cash gate (the
  decoupling law, working; the "0 candidates recorded" skip text is just confusing)
- `alpha_gate.js:29-36` — verdict thresholds (PROOF_MIN_TRADES 30, CERT_PROOF_SETTLED 15)
- `calibration.js:42` — SHADOW_PENDING_CAP 2000; `:220` settleResult; `:408` boot reload
- Tables: trading.db{trades,positions,settlements,fill_quality,calibration};
  facts.db{facts,cert}. Mirror row counts at handoff: trades 80692, calibration
  454 (318 pending/136 settled), cert 0. LIVE: trades 27592, calibration 21, cert 0.

## 8. WATCH LIST (what "healthy" looks like after the §4 plan lands)

- `cert` rows survive past 6h; `settled` climbs toward 15 → first certainty verdict
- `shadow_settled` lines on `/api/logs` after each 15m expiry
- pending count drops by zombies (~318 → near-zero live-relevant)
- `health.data_quarantine` present and honest
- Mirror dry certainty winrate on growing n — HYPE cheap-NO is the suspect bucket

Good luck. Don't delete the evidence. The whole machine exists to earn the right to
trade — including the parts of history that hurt.



## 5. NEW-PC BRING-UP (do in this exact order)

**MANUAL COPY REQUIRED - git cannot carry these (gitignored):**
1. `.env` in EACH repo (Kalshi API credentials - servers cannot auth without it).
   The previous instance deliberately did NOT commit secrets.
2. For FULL continuity: `facts.db`, `trading.db`, `state.json` from each repo root
   (stop the old servers first, then copy; sqlite + hot copies dont mix). The new
   repos include a `handoff/` snapshot folder (state.json copy + calibration table
   export at handoff moment) as the FALLBACK if the DBs are lost - verdict evidence
   survives either way, but the DBs carry everything else (80k/27k trades, 93k/101k
   facts, fill quality).

**Then:**
- git clone both repos; npm install in each
- node --check server.js (both repos, must be clean)
- launch DETACHED (command windows tree-kill fresh servers):
  Start-Process powershell -ArgumentList -ExecutionPolicy,Bypass,-File,<repo>\start-live.ps1 -WorkingDirectory <repo> -WindowStyle Hidden
  (start-dry.ps1 for Mirror)
- VERIFY (never trust the launchers own health check - it can pass against a
  stale process): /api/health pid must equal the netstat port-owner pid.
- If handoff/state.json is the fallback path (DBs not carried): copy it to repo
  root as state.json BEFORE first launch. The boot backfill rebuilds memory state.

**First acts after bring-up, in order:**
1. Confirm both servers healthy (health + a certainty-scan: expect 1-7s wall).
2. Check Kalshi REST: if recovered, POST :8788/api/ops/sync-cash {"force":true},
   verify health.cash_ledger.ledger_cash non-null.
3. Execute the section-4 plan, step 1 first (the cert retention fix).
4. Confirm with operator before section-4 step 5 (artifact deletion is the only
   destructive step) - everything else is additive.

## 6. BOX GOTCHAS

See TRANSFORMATION.md section 6 (Ops Runbook) - kill-by-pid, detached launch,
port-owner verify, editor backslash-quote gotcha, no-balance-channel fact.

## 7. KEY FILE:LINE INDEX (both repos unless noted)

- data_facts.js:44 - LEDGER_MAX_AGE_MS = 6h (THE BUG, section 3); :172 cert prune
- data_facts.js:238-268 - certaintyRecord / flushCert / certaintyOutcome / stats
- server.js:~2350 - settlement rides noBook() REST sweep only (Mirror; LIVE similar)
- server.js:~3841-3871 - LIVE certainty pass: scan -> record -> THEN cash gate
- alpha_gate.js:29-36 - verdict thresholds (PROOF_MIN_TRADES 30, CERT_PROOF_SETTLED 15)
- calibration.js:42 - SHADOW_PENDING_CAP 2000; :220 settleResult; :408 boot reload
- Tables: trading.db{trades,positions,settlements,fill_quality,calibration};
  facts.db{facts,cert}. Mirror rows at handoff: trades 80692, calibration 454
  (318 pending / 136 settled), cert 0. LIVE: trades 27592, calibration 21, cert 0.

## 8. WATCH LIST (healthy after the section-4 plan lands)

- cert rows survive past 6h; settled climbs toward 15 -> first certainty verdict
- shadow_settled lines on /api/logs after each 15m expiry
- pending count drops by zombies (~318 -> near-zero live-relevant)
- health.data_quarantine present and honest
- Mirror dry certainty winrate on growing n - HYPE cheap-NO is the suspect bucket

Good luck. Do not delete the evidence. The whole machine exists to earn the right
 to trade - including the parts of history that hurt.
