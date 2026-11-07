# OPERATOR_LAWS.md — ABSOLUTE. Not suggestions, not preferences. LAWS.
# Any AI (Cline, successor, or future agent) reading this file is BOUND by it.
# Changing or removing a law requires the operator's EXPRESS written say-so.

## LAW 2026-11-07 — NO FEE-ATTACHED EXITS. EVER. (operator express order)

`stop_loss`, `take_profit`, and `trail_stop` exits are FORBIDDEN on every
book (LIVE and dry/mirror). No AI may add, re-add, revive, or re-enable any
of them — in this repo or any future edit — without the operator's EXPRESS
written say-so recorded in this file first.

**The evidence that made this law** (LIVE book, 190 trades through 2026-11-07):

| exit type      | n   | wins | PnL      |
|----------------|-----|------|----------|
| take_profit+trail | 59 | 59   | +$149.17 |
| stop_loss      | 119 | 0    | -$175.36 |

Stop exits paid a second taker fee to sell noise at the worst moment and
converted bounded 15-minute positions into realized losses. Positions now
RIDE TO SETTLEMENT. The per-order size is the loss limit.

**Runtime enforcement:** `OPERATOR_LAW.assertNoFeeExit(reason)` (server.js)
throws on any exit reason outside: `settled`, `manual`, `hold_rule*`,
`flatten_feed_death`. The guard lives at the only real-money exit chokepoint
(`live_engine.js exitPosition`). Paper book mirrors the live law exactly.

## LAW 2026-11-07 — DATA-BUY DOCTRINE (operator express order)

The LIVE book is a DATA-COLLECTION instrument. Entries are intelligent small
buys that are non-painful to lose entirely: per-order cap $0.50 (OPERATOR
ORDER 2026-11-04, `effectiveClip()`), hold to settlement, total loss bounded
by entry cost. The product is EVIDENCE — settled facts that calibrate the
vaccine, graduate the certainty lane, and feed the super-detective. Wins are
the byproduct of knowing what not to do.

## Pre-existing standing laws (unchanged)

- **Operator button law (2026-10-27):** lane button push is immediate,
  absolute, forever. No supervisor/auto-restart/watchdog may contravene.
  See `OPERATOR_LAW` in server.js.
- **Evidence law (TRANSFORMATION.md):** trading rights are EARNED from
  settled-outcome verdicts. Settled evidence is NEVER deleted (the 190 losing
  live trades ARE the midbook-REFUTED verdict).
- **Git is manual (2026-11-07):** no auto-push tasks. Pushes are an operator-
  supervised ritual, both repos together.
