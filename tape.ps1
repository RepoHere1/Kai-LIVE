# KAI TAPE (DRY book) - event-driven terminal feed. Silent until something
# happens: entries, closes, balance moves, server restarts. A PULSE line
# every 5 minutes proves the heart is beating. Run:  .\tape.ps1
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'   # kills the blue "Reading web response" popup
$Cfg = @{ Tag = 'LIVE'; Port = 8788 }

Write-Host "==== KAI TAPE - LIVE book (events + 5-min pulse, Ctrl+C to stop) ====" -ForegroundColor White

$knownClosed = @{}   # trade id -> $true
$knownOpen = @{}     # position id -> $true
$knownRT = @{}       # lane trade composite key -> $true (recent-trades feed)
$lastPulseSig = ''   # last pulse state signature (suppress identical pulses)
$lastAcct = $null    # real Kalshi account cash (catches DIRECT trades/deposits)
$lastLanePnl = $null # lane book aggregate pnl (from /api/recent-trades total_pnl)
$lastLaneCount = 0   # lane book total closed trades
$lastBal = $null; $lastPnl = $null; $lastUptime = $null; $lastPulse = 0

function J([string]$u) {
  try { return (Invoke-WebRequest -Uri $u -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json } catch { return $null }
}
function Line([string]$color, [string]$text) {
  Write-Host ("[{0}][{1}] " -f (Get-Date -Format 'HH:mm:ss'), $Cfg.Tag) -NoNewline -ForegroundColor DarkGray
  Write-Host $text -ForegroundColor $color
}

# Seed known state so the tape doesn't replay history on startup.
$seed = J "http://127.0.0.1:$($Cfg.Port)/api/no-lanes/book"
if ($seed) {
  foreach ($t in @($seed.closed_rows)) { $knownClosed[$t.id] = $true }
  foreach ($p in @($seed.open_rows)) { $knownOpen[$p.id] = $true }
  $lastBal = [double]$seed.book.balance; $lastPnl = [double]$seed.book.pnl
  if ($seed.acct -and $seed.acct.cash -ne $null) { $lastAcct = [double]$seed.acct.cash }
}
$seedRT = J "http://127.0.0.1:$($Cfg.Port)/api/recent-trades?per_page=200"
if ($seedRT -and $seedRT.trades) {
  foreach ($t in @($seedRT.trades)) { $knownRT["$($t.market_id)|$($t.exit_timestamp)|$($t.entry_price)|$($t.pnl)"] = $true }
  if ($seedRT.total_pnl -ne $null) { $lastLanePnl = [double]$seedRT.total_pnl }
  $lastLaneCount = [int]$seedRT.total
}

while ($true) {
  $nb = J "http://127.0.0.1:$($Cfg.Port)/api/no-lanes/book"
  if ($nb) {
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
        Line $col ("CLOSE {0} in={1} out={2} qty={3} pnl={4} [{5}]  book bal `${6}" -f $t.market_id, $t.entry_price, $t.exit_price, $t.quantity, $t.pnl, $t.exit_reason, [Math]::Round($nb.book.balance,2))
      }
    }
    $bal = [double]$nb.book.balance; $pnl = [double]$nb.book.pnl
    if ($lastBal -ne $null -and [Math]::Abs($bal - $lastBal) -ge 0.05) {
      Line 'Cyan' ("BAL `${0} -> `${1}  (pnl `${2})" -f [Math]::Round($lastBal,2), [Math]::Round($bal,2), [Math]::Round($pnl,2))
    }
    $lastBal = $bal; $lastPnl = $pnl

    # Real Kalshi account cash: moves here mean something happened OUTSIDE the bot
    # (direct trade on kalshi.com, deposit, withdrawal, manual settlement).
    if ($nb.acct -and $nb.acct.cash -ne $null) {
      $acct = [double]$nb.acct.cash
      if ($lastAcct -ne $null -and [Math]::Abs($acct - $lastAcct) -ge 0.01) {
        $d = $acct - $lastAcct
        $sign = if ($d -ge 0) { '+' } else { '' }
        Line 'Magenta' ("ACCT `${0} (${1}`${2}) EXTERNAL move - direct trade/deposit/settle detected" -f [Math]::Round($acct,2), $sign, [Math]::Round($d,2))
      }
      $lastAcct = $acct
    }
  }

  $rt = J "http://127.0.0.1:$($Cfg.Port)/api/recent-trades?per_page=200"
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

  $h = J "http://127.0.0.1:$($Cfg.Port)/api/health"
  if ($h) {
    $up = [int]$h.uptime_sec
    if ($lastUptime -ne $null -and $up -lt $lastUptime) { Line 'Magenta' 'SERVER RESTARTED (watchdog or deploy)' }
    $lastUptime = $up
  } elseif ($lastUptime -ne -1) {
    Line 'Magenta' 'SERVER DOWN - watchdog should restore within 60s'
    $lastUptime = -1
  }

  $nowSec = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $boots = if ($nb) { $nb.boots } else { '?' }
  $stateSig = "$([Math]::Round($lastBal,2))|$([Math]::Round($lastPnl,2))|$lastLanePnl|$lastLaneCount|$(if ($nb) { @($nb.open_rows).Count } else { '?' })|$(if ($nb) { $nb.book.entries } else { '?' })|$boots"
  if ($nowSec - $lastPulse -ge 300 -and ($stateSig -ne $lastPulseSig -or $nowSec - $lastPulse -ge 3600)) {
    $lastPulse = $nowSec
    $lastPulseSig = $stateSig
    $st = J "http://127.0.0.1:$($Cfg.Port)/api/strategies"
    $lanesOn = 0
    if ($st) { foreach ($p in $st.PSObject.Properties) { if ($p.Value.running) { $lanesOn++ } } }
    $totPnl = [Math]::Round($lastPnl + $lastLanePnl, 2)
    Line 'DarkCyan' ("PULSE alive | bal `${0} | all_no `${1} (n={2}) | lanes `${3} (n={4}) | TOTAL `${5} | acct `${6} | lanes {7} on | uptime {8}m | boots {9}" -f [Math]::Round($lastBal,2), [Math]::Round($lastPnl,2), ($(if ($nb) { $nb.book.entries } else { '?' })), [Math]::Round($lastLanePnl,2), $lastLaneCount, $totPnl, ($(if ($lastAcct -ne $null) { [Math]::Round($lastAcct,2) } else { '?' })), $lanesOn, [int]($lastUptime/60), $boots)
  }

  Start-Sleep -Seconds 5
}

