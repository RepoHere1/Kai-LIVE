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
$balKnown = $false   # true only when the server reported a REAL balance

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
  $stateSig = "$(BalTxt $lastBal)|$(BalTxt $lastPnl)|$lastLanePnl|$lastLaneCount|$(if ($nb) { @($nb.open_rows).Count } else { '?' })|$(if ($nb) { $nb.book.entries } else { '?' })|$boots"
  if ($nowSec - $lastPulse -ge 300 -and ($stateSig -ne $lastPulseSig -or $nowSec - $lastPulse -ge 3600)) {
    $lastPulse = $nowSec
    $lastPulseSig = $stateSig
    $st = J "http://127.0.0.1:$($Cfg.Port)/api/strategies"
    $lanesOn = 0
    if ($st) { foreach ($p in $st.PSObject.Properties) { if ($p.Value.running) { $lanesOn++ } } }
    $totPnl = if ($null -ne $lastPnl -and $null -ne $lastLanePnl) { [Math]::Round($lastPnl + $lastLanePnl, 2) } else { '?' }
    Line 'DarkCyan' ("PULSE alive | bal `${0} | all_no `${1} (n={2}) | lanes `${3} (n={4}) | TOTAL `${5} | acct `${6} | lanes {7} on | uptime {8}m | boots {9}" -f (BalTxt $lastBal), (BalTxt $lastPnl), ($(if ($nb) { $nb.book.entries } else { '?' })), (BalTxt $lastLanePnl), $lastLaneCount, $totPnl, ($(if ($lastAcct -ne $null) { [Math]::Round($lastAcct,2) } else { '?' })), $lanesOn, [int]($lastUptime/60), $boots)
  }

  Start-Sleep -Seconds 5
}

