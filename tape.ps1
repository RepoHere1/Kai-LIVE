# KAI TAPE (DRY book) - event-driven terminal feed. Silent until something
# happens: entries, closes, balance moves, server restarts. A PULSE line
# every 5 minutes proves the heart is beating. Run:  .\tape.ps1
$ErrorActionPreference = 'SilentlyContinue'
$Cfg = @{ Tag = 'LIVE'; Port = 8788 }

Write-Host "==== KAI TAPE - LIVE book (events + 5-min pulse, Ctrl+C to stop) ====" -ForegroundColor White

$knownClosed = @{}   # trade id -> $true
$knownOpen = @{}     # position id -> $true
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
}

while ($true) {
  $nb = J "http://127.0.0.1:$($Cfg.Port)/api/no-lanes/book"
  if ($nb) {
    foreach ($p in @($nb.open_rows)) {
      if (-not $knownOpen[$p.id]) {
        $knownOpen[$p.id] = $true
        Line 'Yellow' ("ENTER {0} {1} in={2} qty={3} fair={4} edge={5}" -f $p.market_id, $p.side, $p.entry_price, $p.quantity, $p.entry_fair, $p.edge)
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
  if ($nowSec - $lastPulse -ge 300) {
    $lastPulse = $nowSec
    $st = J "http://127.0.0.1:$($Cfg.Port)/api/strategies"
    $lanesOn = 0
    if ($st) { foreach ($p in $st.PSObject.Properties) { if ($p.Value.running) { $lanesOn++ } } }
    Line 'DarkCyan' ("PULSE alive | bal `${0} pnl `${1} open {2} entries {3} | lanes {4} on | uptime {5}m" -f [Math]::Round($lastBal,2), [Math]::Round($lastPnl,2), (@($nb.open_rows).Count), $nb.book.entries, $lanesOn, [int]($lastUptime/60))
  }

  Start-Sleep -Seconds 5
}

