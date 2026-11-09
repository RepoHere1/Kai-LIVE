# KAI TAPE (LIVE book) - event-driven terminal feed. The live screen is for
# TRADES ONLY (ENTER/CLOSE/LANE CLOSE/BAL) plus operational truth (SERVER
# DOWN/SLOW/RESTARTED). Everything that is not a trade - shadow events,
# vaccine, detective, backtest, pulse - buffers and prints ONCE PER HOUR as
# one block at the local top-of-the-hour (first block at startup).
# Run:  .\tape.ps1
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'   # kills the blue "Reading web response" popup
$Cfg = @{ Tag = 'LIVE'; Port = 8788 }

Write-Host "==== KAI TAPE - LIVE book (trades live + hourly report, Ctrl+C to stop) ====" -ForegroundColor White

$knownClosed = @{}   # trade id -> $true
$knownOpen = @{}     # position id -> $true
$knownRT = @{}       # lane trade composite key -> $true (recent-trades feed)
$lastAcct = $null    # real Kalshi account cash (catches DIRECT trades/deposits)
$lastLanePnl = $null # lane book aggregate pnl (from /api/recent-trades total_pnl)
$lastLaneCount = 0   # lane book total closed trades
$lastBal = $null; $lastPnl = $null; $lastUptime = $null
$balKnown = $false   # true only when the server reported a REAL balance

$knownShadow = @{}   # shadow event key -> seen
$shadowSeeded = $false
$lastShadowPoll = 0

# HOURLY REPORT (operator order 2026-11-08): everything that is not an actual
# trade buffers here during the hour and prints ONCE, together, at the local
# top-of-the-hour. The live screen stays chronological trades + server truth.
$hourlyBuffer = [System.Collections.Generic.List[object]]::new()
$shadowTally = @{ open = 0; win = 0; loss = 0; swept = 0 }
$lastHourReported = -1
function HourLine([string]$color, [string]$text) {
  $script:hourlyBuffer.Add([pscustomobject]@{ color = $color; text = $text })
}

function J([string]$u) {
  try { return (Invoke-WebRequest -Uri $u -TimeoutSec 15 -UseBasicParsing).Content | ConvertFrom-Json } catch { return $null }
}

# TRUE liveness: a refused TCP connect is the ONLY proof a server is DOWN.
# A slow answer (busy event loop, big snapshot) means the server is ALIVE.
# The old tape called every timeout "SERVER DOWN" - a lie that fired while the
# server was running fine.
function Test-PortRefused([int]$Port) {
  # SYNCHRONOUS connect on loopback: it returns at once with success or with
  # ConnectionRefused. (An async WaitOne never signals on a refused connect,
  # so it would report a dead server as merely slow.)
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $c.Connect('127.0.0.1', $Port)
    return $false
  } catch {
    $ex = $_.Exception
    if ($ex.InnerException) { $ex = $ex.InnerException }
    if ($ex -is [System.Net.Sockets.SocketException]) { return ($ex.SocketErrorCode -eq 'ConnectionRefused') }
    return $false
  } finally { try { $c.Close() } catch { } }
}

# ONE SNAPSHOT PER PASS. The tape used to poll /api/no-lanes/book,
# /api/recent-trades and /api/health as three separate requests, so a trade
# that closed between two of them could show up in one view and not the other:
# the tape printed a CLOSE with a balance that had already moved on. One
# atomic snapshot makes the feed self-consistent.
function Snap {
  $s = J "http://127.0.0.1:$($Cfg.Port)/api/tape-snapshot"
  if ($s -and $s.book -and $s.book.book) { return $s }
  # Older server without the snapshot endpoint: fall back to the three calls,
  # normalized to the SAME shape so the rest of the tape is identical.
  $nb = J "http://127.0.0.1:$($Cfg.Port)/api/no-lanes/book"
  if (-not $nb) { return $null }
  $rt = J "http://127.0.0.1:$($Cfg.Port)/api/recent-trades?per_page=200"
  $h  = J "http://127.0.0.1:$($Cfg.Port)/api/health"
  return [pscustomobject]@{
    generated_at = $nb.generated_at
    book         = $nb
    acct         = $nb.acct
    lanes        = $rt
    health       = $h
  }
}

# A balance of $0.00 and an UNKNOWN balance are different facts. Print '?'
# for unknown rather than a fake zero.
function BalTxt($v) {
  if ($null -eq $v) { return '?' }
  return ([Math]::Round([double]$v, 2)).ToString()
}
function Line([string]$color, [string]$text) {
  Write-Host ("[{0}][{1}] " -f (Get-Date -Format 'HH:mm:ss'), $Cfg.Tag) -NoNewline -ForegroundColor DarkGray
  Write-Host $text -ForegroundColor $color
}

# Seed known state so the tape doesn't replay history on startup.
$seed = Snap
if ($seed) {
  foreach ($t in @($seed.book.closed_rows)) { $knownClosed[$t.id] = $true }
  foreach ($p in @($seed.book.open_rows)) { $knownOpen[$p.id] = $true }
  if ($seed.book.book -and $null -ne $seed.book.book.balance) {
    $lastBal = [double]$seed.book.book.balance
    $balKnown = $true
  }
  if ($seed.book.book -and $null -ne $seed.book.book.pnl) { $lastPnl = [double]$seed.book.book.pnl }
  if ($seed.acct -and $null -ne $seed.acct.cash) { $lastAcct = [double]$seed.acct.cash }
}
if ($seed -and $seed.lanes -and $seed.lanes.trades) {
  foreach ($t in @($seed.lanes.trades)) { $knownRT["$($t.market_id)|$($t.exit_timestamp)|$($t.entry_price)|$($t.pnl)"] = $true }
  if ($null -ne $seed.lanes.total_pnl) { $lastLanePnl = [double]$seed.lanes.total_pnl }
  $lastLaneCount = [int]$seed.lanes.total
}

while ($true) {
  $snap = Snap
  $nb = $null
  if ($snap) {
    $nb = $snap.book
    foreach ($p in @($nb.open_rows)) {
      if (-not $knownOpen[$p.id]) {
        $knownOpen[$p.id] = $true
        Line 'Yellow' ("ENTER {0} {1} in={2} qty={3} fair={4} edge={5}" -f $p.market_id, $p.side, $p.entry_price, $p.quantity, $p.entry_fair, [Math]::Round([double]$p.edge, 4))
      }
    }
    foreach ($t in @($nb.closed_rows)) {
      if (-not $knownClosed[$t.id]) {
        $knownClosed[$t.id] = $true
        $knownOpen.Remove($t.id) | Out-Null
        $col = if ([double]$t.pnl -gt 0) { 'Green' } else { 'Red' }
        Line $col ("CLOSE {0} in={1} out={2} qty={3} pnl={4} [{5}]  book bal `${6}" -f $t.market_id, $t.entry_price, $t.exit_price, $t.quantity, $t.pnl, $t.exit_reason, (BalTxt $nb.book.balance))
      }
    }

    # BALANCE TRUTH: a null balance is UNKNOWN (the Kalshi balance read
    # failed), not $0.00. Never print a fake zero and never treat it as a
    # balance move - a false $0.00 is how a dead account looks like a
    # bankrupt one.
    $balRaw = $nb.book.balance
    if ($null -ne $balRaw) {
      $bal = [double]$balRaw
      if (-not $balKnown) {
        Line 'DarkYellow' ("BALANCE now known: `${0} (was unavailable)" -f [Math]::Round($bal,2))
      } elseif ($lastBal -ne $null -and [Math]::Abs($bal - $lastBal) -ge 0.05) {
        Line 'Cyan' ("BAL `${0} -> `${1}  (pnl `${2})" -f [Math]::Round($lastBal,2), [Math]::Round($bal,2), (BalTxt $nb.book.pnl))
      }
      $lastBal = $bal
      $balKnown = $true
    } elseif ($balKnown) {
      Line 'DarkYellow' 'BALANCE UNAVAILABLE (balance read failed - showing "?", NOT $0.00)'
      $balKnown = $false
    }
    if ($null -ne $nb.book.pnl) { $lastPnl = [double]$nb.book.pnl }

    # Real Kalshi account cash: moves here mean something happened OUTSIDE the bot
    # (direct trade on kalshi.com, deposit, withdrawal, manual settlement).
    if ($snap.acct -and $null -ne $snap.acct.cash) {
      $acct = [double]$snap.acct.cash
      if ($lastAcct -ne $null -and [Math]::Abs($acct - $lastAcct) -ge 0.01) {
        $d = $acct - $lastAcct
        $sign = if ($d -ge 0) { '+' } else { '' }
        Line 'Magenta' ("ACCT `${0} (${1}`${2}) EXTERNAL move - direct trade/deposit/settle detected" -f [Math]::Round($acct,2), $sign, [Math]::Round($d,2))
      }
      $lastAcct = $acct
    } elseif ($lastAcct -ne $null) {
      Line 'DarkYellow' 'ACCOUNT UNAVAILABLE (balance read failed - acct "?")'
      $lastAcct = $null
    }
  }

  $rt = if ($snap) { $snap.lanes } else { $null }
  if ($rt -and $rt.trades) {
    foreach ($t in @($rt.trades)) {
      $key = "$($t.market_id)|$($t.exit_timestamp)|$($t.entry_price)|$($t.pnl)"
      if (-not $knownRT[$key]) {
        $knownRT[$key] = $true
        if ($t.strategy -ne 'all_no_markets') {
          $col = if ([double]$t.pnl -gt 0) { 'Green' } else { 'Red' }
          Line $col ("LANE CLOSE [{0}] {1} {2} in={3} out={4} pnl={5} [{6}]" -f $t.strategy, $t.market_id, $t.side, $t.entry_price, $t.exit_price, $t.pnl, $t.exit_reason)
        }
      }
    }
    if ($rt.total_pnl -ne $null) { $lastLanePnl = [double]$rt.total_pnl }
    $lastLaneCount = [int]$rt.total
    if ($knownRT.Count -gt 400) { $knownRT.Clear(); foreach ($t in @($rt.trades)) { $knownRT["$($t.market_id)|$($t.exit_timestamp)|$($t.entry_price)|$($t.pnl)"] = $true } }
  }

  # SHADOW TRADES ON THE TAPE: every blocked or cold candidate the vaccine
  # paper-trades is printed when it opens and when it settles. Polled every 15s.
  $nowShadow = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if (($nowShadow - $lastShadowPoll) -ge 15) {
    $lastShadowPoll = $nowShadow
    $sc = J "http://127.0.0.1:$($Cfg.Port)/api/calibration"
    if ($sc -and $sc.shadow_events) {
      foreach ($e in @($sc.shadow_events)) {
        $sk = "$($e.at)|$($e.kind)|$($e.market_id)|$($e.side)"
        if ($knownShadow[$sk]) { continue }
        $knownShadow[$sk] = $true
        if (-not $shadowSeeded) { continue }
        if ($e.kind -eq 'SHADOW_OPEN') {
          $script:shadowTally.open++
          HourLine 'DarkMagenta' ("SHADOW OPEN {0} {1} @{2} claimed={3} adj={4} [{5}]" -f $e.market_id, $e.side, $e.price, $e.claimed, $e.adjusted, $e.strategy)
        } else {
          # OPERATOR SPEC (2026-11-07): a settled shadow keeps its full text, but
          # the color IS the verdict - WIN prints bright yellow, LOSS prints white.
          # A settle with no outcome/pnl is a sweep - real labels, never blanks.
          if ($e.outcome -eq 'WIN') { $script:shadowTally.win++ }
          elseif ($e.outcome -eq 'LOSS') { $script:shadowTally.loss++ }
          else { $script:shadowTally.swept++ }
          $outTxt = if ($e.outcome) { $e.outcome } else { 'SWEPT' }
          $pnlTxt = if ($null -ne $e.pnl) { $e.pnl } else { 'n/a' }
          $scol = if ($e.outcome -eq 'WIN') { 'Yellow' } else { 'White' }
          HourLine $scol ("SHADOW {0} {1} {2} @{3} pnl={4} [{5}]" -f $outTxt, $e.market_id, $e.side, $e.price, $pnlTxt, $e.strategy)
        }
      }
    }
    if ($sc) { $shadowSeeded = $true }
  }

  $h = if ($snap) { $snap.health } else { $null }
  if ($h -and $null -ne $h.uptime_sec) {
    $up = [int]$h.uptime_sec
    if ($lastUptime -ne $null -and $up -lt $lastUptime) { Line 'Magenta' 'SERVER RESTARTED (watchdog or deploy)' }
    $lastUptime = $up
  } elseif ($lastUptime -ne -1) {
    if (Test-PortRefused $Cfg.Port) {
      Line 'Magenta' 'SERVER DOWN (port refused) - watchdog should restore within 60s'
      $lastUptime = -1
    } else {
      Line 'DarkYellow' 'SERVER SLOW (no health answer, port still listening - NOT down)'
      $lastUptime = -1
    }
  }

  $nowSec = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $boots = if ($h -and $null -ne $h.boots) { $h.boots } elseif ($nb) { $nb.boots } else { '?' }
  # HOURLY REPORT TRIGGER: fires once at startup, then exactly once per hour,
  # on the LOCAL top-of-the-hour (matches the timestamps on screen).
  $curHour = [int](Get-Date -Format 'yyyyMMddHH')
  if ($curHour -ne $lastHourReported) {
    $lastHourReported = $curHour
    $st = J "http://127.0.0.1:$($Cfg.Port)/api/strategies"
    $lanesOn = 0
    if ($st) { foreach ($p in $st.PSObject.Properties) { if ($p.Value.running) { $lanesOn++ } } }
    $totPnl = if ($null -ne $lastPnl -and $null -ne $lastLanePnl) { [Math]::Round($lastPnl + $lastLanePnl, 2) } else { '?' }
    # THE VACCINE, on the tape: empirical calibration verdict. Green = the model
    # is calibrated or understates; Red = the death zone (it overstates favorites);
    # DarkYellow = not enough settled evidence yet (n < 20 per bucket).
    $cal = J "http://127.0.0.1:$($Cfg.Port)/api/calibration"
    if ($cal -and $cal.buckets) {
      $warm = @($cal.buckets | Where-Object { [int]$_.n -ge 20 })
      $over = @($warm | Where-Object { $_.status -eq 'overstated' })
      $okBk = @($warm | Where-Object { $_.status -ne 'overstated' })
      $worst = $null
      foreach ($bkt in $warm) { if ($null -eq $worst -or [double]$bkt.bias -gt [double]$worst.bias) { $worst = $bkt } }
      $vcol = if ($warm.Count -eq 0) { 'DarkYellow' } elseif ($over.Count -gt $okBk.Count) { 'Red' } else { 'Green' }
      $wtxt = 'no warm buckets (n>=20) yet'
      if ($worst) { $wtxt = ("worst {0}: model {1} real {2} (n={3})" -f $worst.bucket, [Math]::Round([double]$worst.center,2), [Math]::Round([double]$worst.realized,2), $worst.n) }
      HourLine $vcol ("VACCINE {0} warm buckets | {1} overstated / {2} ok | {3} | shadows {4} pending" -f $warm.Count, $over.Count, $okBk.Count, $wtxt, $(if ($null -ne $cal.pending_shadows_n) { $cal.pending_shadows_n } elseif ($null -ne $cal.pending_shadows -and $cal.pending_shadows -isnot [array]) { $cal.pending_shadows } else { 0 }))
    }
    # SHARDS: per-shard cash. Entries die with "shard funding" skips when the
    # target shard (2 = crypto/commodities) runs dry - this makes it visible.
    $sh = J "http://127.0.0.1:$($Cfg.Port)/api/shards"
    if ($sh -and $sh.shards) {
      $stxt = ($sh.shards | ForEach-Object { "s{0}:`${1}" -f $_.exchange_index, [Math]::Round([double]$_.balance,2) }) -join ' '
      Line 'Cyan' ("SHARDS {0}" -f $stxt)
    }
    # SUPER-DETECTIVE (operator commission 2026-11-07): factual-edge mining
    # across Kalshi/Polymarket/Manifold + our own settled trades. Yellow = a
    # walk-forward-confirmed edge is on the table right now.
    $dtv = J "http://127.0.0.1:$($Cfg.Port)/api/detective"
    if ($dtv -and $dtv.discovered) {
      $dtop = @($dtv.discovered)[0]
      $srcOk = 0
      if ($dtv.sources) { foreach ($sp in $dtv.sources.PSObject.Properties) { if ($sp.Value.ok) { $srcOk++ } } }
      $dcol = if ($dtop -and [double]$dtop.edge_per_contract -gt 0) { 'Yellow' } else { 'DarkCyan' }
      HourLine $dcol ("DETECTIVE {0} edges | {1} | sources ok {2}/4" -f @($dtv.discovered).Count, $(if ($dtop) { "{0} {1} edge={2}/ct n={3}" -f $dtop.source, $dtop.rule, $dtop.edge_per_contract, $dtop.n_test } else { 'no confirmed edge yet (mining)' }), $srcOk)
    }

    # BACKTESTER ON THE TAPE: latest settled-market verdict per strategy, plus live
    # progress while a run is writing its log (backtest.js lives in Kai-Mirror).
    # Portable sibling-repo path (was hardcoded C:\Users\darri\... from the old box).
    $btPath = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'Kai-Mirror') 'backtest_results.json'
    $bt = $null
    try { $bt = Get-Content -LiteralPath $btPath -Raw | ConvertFrom-Json } catch { }
    if ($bt -and $bt.strategies) {
      $vcount = @($bt.strategies | Group-Object verdict | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ' | '
      $provenN = @($bt.strategies | Where-Object { $_.verdict -eq 'PROVEN' }).Count
      $bcol = if ($provenN -gt 0) { 'Green' } else { 'DarkYellow' }
      HourLine $bcol ("BACKTEST {0} ({1}d, {2} strategies) | {3}" -f $bt.generated_at, $bt.window.days, @($bt.strategies).Count, $vcount)
    }
    $btLog = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'Kai-Mirror') 'backtest_progress.log'
    if (Test-Path -LiteralPath $btLog) {
      $btAge = ((Get-Date) - (Get-Item -LiteralPath $btLog).LastWriteTime).TotalMinutes
      if ($btAge -lt 10) { HourLine 'DarkCyan' ("BACKTEST RUNNING: {0}" -f (Get-Content -LiteralPath $btLog -Tail 1)) }
    }
    HourLine 'DarkCyan' ("PULSE alive | bal `${0} | all_no `${1} (n={2}) | lanes `${3} (n={4}) | TOTAL `${5} | acct `${6} | lanes {7} on | uptime {8}m | boots {9}" -f (BalTxt $lastBal), (BalTxt $lastPnl), ($(if ($nb) { $nb.book.entries } else { '?' })), (BalTxt $lastLanePnl), $lastLaneCount, $totPnl, ($(if ($lastAcct -ne $null) { [Math]::Round($lastAcct,2) } else { '?' })), $lanesOn, [int]($lastUptime/60), $boots)

    # ---- FLUSH: one block, once per hour - tally, then buffered shadow
    # events (oldest first), then the status lines just generated above. ----
    Line 'White' ("================ HOURLY REPORT {0}:00 | shadows buffered: {1} ================" -f (Get-Date -Format 'HH'), ($script:shadowTally.open + $script:shadowTally.win + $script:shadowTally.loss + $script:shadowTally.swept))
    Line 'DarkMagenta' ("SHADOWS this hour: {0} opened / {1} wins / {2} losses / {3} swept" -f $script:shadowTally.open, $script:shadowTally.win, $script:shadowTally.loss, $script:shadowTally.swept)
    foreach ($bl in $script:hourlyBuffer) { Line $bl.color $bl.text }
    Line 'White' ("================ end hourly report ================")
    $script:hourlyBuffer.Clear()
    $script:shadowTally = @{ open = 0; win = 0; loss = 0; swept = 0 }
  }

  Start-Sleep -Seconds 5
}

