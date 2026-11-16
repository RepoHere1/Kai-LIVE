# Kai-LIVE control - the root operator handle (port 8788). REAL MONEY BOOK.
# 2026-11-14: MASTER_TRACKER.md has listed `kai-live.ps1` ("LIVE control
# script") and `kai.ps1` ("LIVE shortcut") since 2026-10-29, but neither
# existed in this repo - a bare `.\kai.ps1` did nothing. This is that script
# (`kai.ps1` in this repo forwards here). Sibling of Kai-Mirror\kai.ps1.
#
#   .\kai-live.ps1                    status: server + every lane (the default)
#   .\kai-live.ps1 on  [lane]         lanes ON  (all, or one by name); boots the
#                                     server first if it is down
#   .\kai-live.ps1 off [lane]         lanes OFF (all, or one by name)
#   .\kai-live.ps1 start|stop|restart server process - delegated 1:1 to
#                                     ops\kctl.ps1 live (graceful /api/shutdown
#                                     stop + log rotation live there)
#   .\kai-live.ps1 dashboard          open http://127.0.0.1:8788/ in the browser
#
# OPERATOR_LAW: this script never supervises, never auto-restarts anything, and
# keeps nothing alive. on/off are plain operator toggles through the server's
# own /api/strategy/:name/toggle endpoint (the legal writer of ls.running per
# LIVE's OPERATOR_LAW; it enforces the law server-side and persists state.json
# atomically); start/stop/restart are one-shot delegations. The lane list is
# fetched LIVE from /api/strategies so it can never drift from the LANES
# registry in server.js. Every action prints a REAL MONEY banner - this book
# pays real fees on real fills.
param(
  [Parameter(Position=0)][string]$Cmd = 'status',
  [Parameter(Position=1)][string]$Lane
)

$repo = $PSScriptRoot
$Port = 8788
$Base = "http://127.0.0.1:$Port"
$Kctl = Join-Path $repo 'ops\kctl.ps1'

function Test-Up {
  # TCP port probe, NOT /api/health: the health handler makes external Kalshi
  # calls and can stall for its full timeout during outbound flap waves (proven
  # on this box 2026-11-04 - see ops/kctl.ps1 Test-PortListening). The port
  # accepting connections is the up/down truth. Explicit ConnectionRefused =
  # DOWN (the ConnectAsync task faults instantly on loopback); a probe TIMEOUT
  # is treated as UP - a slow server is never assumed dead.
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $t = $c.ConnectAsync('127.0.0.1', $Port)
    if (-not $t.Wait(3000)) { return $true }   # timeout: slow != dead
    return $c.Connected
  } catch { return $false } finally { $c.Dispose() }
}

function Get-Lanes {
  try { Invoke-RestMethod -Uri "$Base/api/strategies" -TimeoutSec 8 } catch { $null }
}

function Invoke-Kctl([string]$Act) {
  if (-not (Test-Path $Kctl)) { Write-Error "missing $Kctl"; exit 1 }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Kctl live $Act
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Set-Lane([string]$Name, [bool]$Running) {
  Invoke-RestMethod -Uri "$Base/api/strategy/$Name/toggle" -Method Post `
    -ContentType 'application/json' `
    -Body ('{"running":' + $(if ($Running) { 'true' } else { 'false' }) + '}') `
    -TimeoutSec 10
}

function Wait-Up([int]$Tries = 10) {
  # kctl start already boot-verifies by TCP port; this only waits for the port
  # to answer for us (HTTP handlers follow within moments of the listener).
  for ($i = 0; $i -lt $Tries; $i++) { if (Test-Up) { return $true }; Start-Sleep 2 }
  $false
}

function Show-Status {
  if (-not (Test-Up)) {
    "LIVE DOWN on port $Port  -  bring it up:  .\kai-live.ps1 start"
    return
  }
  $lanes = Get-Lanes
  if (-not $lanes) { "LIVE port $Port UP but /api/strategies failed"; return }
  $rows = @($lanes.PSObject.Properties | ForEach-Object {
    $v = $_.Value
    [pscustomobject]@{
      lane      = $v.name
      state     = if ($v.running) { 'ON ' } else { 'off' }
      entries   = $v.entries
      last_skip = $v.last_skip
      heartbeat = $v.heartbeat
    }
  })
  $on = @($rows | Where-Object { $_.state -eq 'ON ' }).Count
  "LIVE port $Port UP  -  REAL MONEY book  -  dashboard: $Base/"
  $rows | Format-Table -AutoSize | Out-String -Width 220
  "$on/$($rows.Count) lanes ON"
}

function Resolve-Targets {
  # Returns the lane names to toggle: the one named by -Lane, or all of them.
  # /api/strategies is a local-only handler, but during boot the server may be
  # mid calibration-backfill - retry instead of failing on the first miss.
  $lanes = $null
  for ($i = 0; $i -lt 15 -and -not $lanes; $i++) {
    $lanes = Get-Lanes
    if (-not $lanes -and $i -lt 14) { Start-Sleep 4 }
  }
  if (-not $lanes) { Write-Error "cannot read $Base/api/strategies - server up but API not answering; check server.err"; exit 1 }
  $all = @($lanes.PSObject.Properties | ForEach-Object { $_.Value.name })
  if ($Lane) {
    if ($all -notcontains $Lane) {
      Write-Error "unknown lane '$Lane'. valid: $($all -join ', ')"
      exit 1
    }
    return @($Lane)
  }
  return $all
}

switch ($Cmd.ToLower()) {
  'on' {
    "*** LIVE book - REAL MONEY - turning lanes ON ***"
    if (-not (Test-Up)) {
      "server down - starting it first (ops/kctl.ps1 live start)"
      Invoke-Kctl 'start'
      if (-not (Wait-Up)) { Write-Error "server never answered on port $Port - check server.err"; exit 1 }
    }
    $targets = Resolve-Targets
    foreach ($n in $targets) {
      $r = Set-Lane $n $true
      '{0,-24} ON     {1}' -f $r.name, $r.law
    }
    if ($targets.Count -gt 1) { "all $($targets.Count) lanes ON (persisted to state.json)" }
  }
  'off' {
    "*** LIVE book - REAL MONEY - turning lanes OFF ***"
    if (-not (Test-Up)) {
      "LIVE is DOWN - every lane is already inert. The persisted lane flags"
      "stay exactly as the operator last set them (OPERATOR_LAW). To also clear"
      "the flags:  .\kai-live.ps1 start  then  .\kai-live.ps1 off"
      exit 0
    }
    $targets = Resolve-Targets
    foreach ($n in $targets) {
      $r = Set-Lane $n $false
      '{0,-24} off    {1}' -f $r.name, $r.law
    }
    if ($targets.Count -gt 1) { "all $($targets.Count) lanes OFF (persisted to state.json)" }
  }
  'start'   { "*** LIVE book - REAL MONEY - start ***"; Invoke-Kctl 'start' }
  'stop'    { "*** LIVE book - REAL MONEY - stop ***"; Invoke-Kctl 'stop' }
  'restart' { "*** LIVE book - REAL MONEY - restart ***"; Invoke-Kctl 'restart' }
  'status'  { Show-Status }
  'dashboard' { Start-Process $Base }
  default {
    "kai-live.ps1 - Kai-LIVE control, REAL MONEY book (port $Port)"
    "(.\kai.ps1 in this repo forwards here)"
    ""
    "  .\kai-live.ps1                    status (default when run bare)"
    "  .\kai-live.ps1 on  [lane]         lanes ON (all, or one by name)"
    "  .\kai-live.ps1 off [lane]         lanes OFF (all, or one by name)"
    "  .\kai-live.ps1 start|stop|restart server process (delegates to ops/kctl.ps1 live)"
    "  .\kai-live.ps1 dashboard          open $Base/ in the browser"
    exit 1
  }
}
