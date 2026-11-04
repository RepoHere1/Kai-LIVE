# Kai instant server control v3 - 2026-11-03 (graceful stop, log-safe start)
#
# v2 -> v3 changes:
#   1. Do-Stop now asks the server to shut itself down cleanly
#      (POST /api/shutdown) so it flushes state.json ATOMICALLY before dying.
#      Force kill (taskkill /F) is only the fallback. The old force-first stop
#      is what tore state files and silently reset every lane + risk gate.
#   2. Do-Start rotates server.log / server.err before launching. A live log
#      file still held by a dying process makes Start-Process fail silently:
#      the child dies at once with empty stderr and nobody knows why.
#   3. Do-Start verifies the port is actually serving before returning, and
#      reports the real PID.
# Usage: kctl.ps1 mirror|live start|stop|restart|status
param(
  [Parameter(Position=0)][ValidateSet('mirror','live')][string]$Srv,
  [Parameter(Position=1)][ValidateSet('start','stop','restart','status')][string]$Act = 'status'
)
$Map = @{
  mirror = @{ Dir = 'C:\Users\darri\Kai-Mirror';  Port = 8787 }
  live   = @{ Dir = 'C:\Users\darri\Kai-LIVE';   Port = 8788 }
}
$C = $Map[$Srv]
$PidFile = Join-Path $C.Dir 'kai.pid'
$ServerJs = Join-Path $C.Dir 'server.js'
# HEAP CAP (2026-11-04, per-server): LIVE needs 448 (real working set ~556MB
# commit, ~370MB old-space; 256 OOM-boot-looped it). Mirror fits in 256.
# Both books can be restarted through either repo's kctl, so the cap is
# resolved per-server, never hardcoded.
$HeapCap = if ($Srv -eq 'live') { 448 } else { 256 }
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

function Test-Http([int]$Port, [int]$TimeoutSec = 8) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSec -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Test-PortListening([int]$Port) {
  # PROVEN ON THIS MACHINE (2026-11-03): the async TcpClient probe is BLIND.
  # On Windows a REFUSED loopback connect does NOT signal the WaitHandle
  # (measured: WaitOne(2000) returned False after 2087ms on a closed port),
  # so the old code took the "did not signal => assume alive" branch and
  # reported a DEAD server as ALIVE. The watchdog then never restarted
  # anything, and `kctl stop` never noticed the port had actually closed.
  #
  # The fix is to treat an explicit ConnectionRefused as DEAD and only treat
  # a timeout/unknown as alive (a slow server is never killed).
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    # SYNCHRONOUS connect: loopback returns at once - success, or
    # ConnectionRefused (DEAD). Any other error is treated as alive.
    $c.Connect('127.0.0.1', $Port)
    return $true
  } catch {
    $ex = $_.Exception
    if ($ex.InnerException) { $ex = $ex.InnerException }
    if ($ex -is [System.Net.Sockets.SocketException]) { return ($ex.SocketErrorCode -ne 'ConnectionRefused') }
    return $true
  } finally {
    try { $c.Close() } catch { }
  }
}

# ---------------------------------------------------------------------------
# OWNERSHIP-AWARE PID RESOLUTION  (v5 - 2026-11-03)
#
# WHY THIS EXISTS: a PID file alone is NOT proof of ownership. The OS recycles
# PIDs, and "Get-Process -Id <n>" only proves that SOME process now holds that
# number. Kai-LIVE/kai.pid and Kai-Mirror/kai.pid are different files, but a
# stale value in either one can name the OTHER repository's node server - and
# 'kctl live stop' would then kill the WRONG server. That is a real-money
# incident, not a cosmetic bug.
#
# OWNERSHIP REQUIRES ALL FOUR OF:
#   a. the PID file lives in THIS repository's directory,
#   b. the process is alive AND is a node process,
#   c. its command line contains THIS repository's server.js,
#   d. it owns THIS repository's listening port.
# A PID failing any check is NEVER killed and NEVER reported as ours.
# ---------------------------------------------------------------------------

function Get-PortOwner([int]$Port) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch { }
  # netstat fallback. On this machine the LISTENING row is not always visible
  # to Get-NetTCPConnection, but ESTABLISHED rows on the server port always
  # carry the real owner PID (proven 2026-11-04: 8787 -> 5232, 8788 -> 2236).
  # Only the server side of a connection has the server port as LOCAL port.
  try {
    $lines = netstat -ano -p TCP 2>$null
    foreach ($l in $lines) {
      if ($l -match "^\s*TCP\s+\S*:$Port\s+\S+\s+(LISTENING|ESTABLISHED)\s+(\d+)\s*$") { return [int]$Matches[2] }
    }
  } catch { }
  return 0
}

function Get-ProcCmdLine([int]$ProcessId) {
  try {
    $w = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if ($w) { return [string]$w.CommandLine }
  } catch { }
  return ''
}

# 'yes' | 'no' | 'unknown'
function Test-PidOwnership([int]$ProcId) {
  if ($ProcId -le 0) { return 'no' }
  $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if (-not $proc) { return 'no' }                    # dead -> stale file
  if ($proc.ProcessName -ne 'node') { return 'no' }  # PID recycled by something else
  $cmd = Get-ProcCmdLine $ProcId
  if (-not $cmd) { return 'unknown' }                # cannot read cmdline -> never kill
  if ($cmd -notmatch '(?i)server\.js') { return 'unknown' }
  if ($cmd.IndexOf($ServerJs, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return 'yes' }
  # RELATIVE launch ("node server.js" run from the repo folder - how kctl and the
  # old scheduled task start it): the command line has no repo path, so the
  # repo is proven by the PORT. Only this repo's server owns $C.Port.
  if ((Get-PortOwner $C.Port) -eq $ProcId) { return 'yes' }
  return 'no'                                         # a DIFFERENT repository's server
}

function Get-PidFilePid {
  if (-not (Test-Path $PidFile)) { return 0 }
  $raw = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $p = 0
  if ($raw -and [int]::TryParse($raw.Trim(), [ref]$p)) { return $p }
  return 0
}

# The PID of THIS repository's server, proven by cmdline + port ownership.
# If there is no PID file (a server started outside kctl), the port owner is
# used - but ONLY when it is a node process running this repo's server.js
# (Test-PidOwnership) and it owns this repo's port.
function Get-OwnedPid {
  $p = Get-PidFilePid
  if ($p -le 0) {
    $po = Get-PortOwner $C.Port
    if ($po -gt 0 -and (Test-PidOwnership $po) -eq 'yes') { return $po }
    return 0
  }
  if ((Test-PidOwnership $p) -ne 'yes') { return 0 }
  $owner = Get-PortOwner $C.Port
  if ($owner -and $owner -ne $p) { return 0 }   # our pid is not the one serving our port
  return $p
}

# Every node process whose command line names THIS repository's server.js.
# Safe to kill: no other repository can match this path.
function Get-RepoNodePids {
  $out = @()
  try {
    foreach ($w in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
      if ($w -and $w.ProcessId -and $w.CommandLine -and
          $w.CommandLine.IndexOf($ServerJs, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $out += [int]$w.ProcessId
      }
    }
  } catch { }
  # Relative-launch server (no repo path on its command line): include it when
  # it owns THIS repo's port. A different repo can never own this port.
  $po = Get-PortOwner $C.Port
  if ($po -gt 0 -and ($out -notcontains $po) -and ((Get-ProcCmdLine $po) -match '(?i)server\.js')) { $out += $po }
  return $out
}

# Remove a PID file that names a dead process or another repository's server.
function Clear-StalePidFile {
  $p = Get-PidFilePid
  if ($p -le 0) {
    if (Test-Path $PidFile) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue }
    return 'cleared'
  }
  $own = Test-PidOwnership $p
  if ($own -eq 'no') {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return "cleared stale pid file ($p)"
  }
  if ($own -eq 'yes') {
    $owner = Get-PortOwner $C.Port
    if ($owner -and $owner -ne $p) {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      return "cleared pid file ($p): port $($C.Port) is owned by $owner"
    }
  }
  return ''
}

function Get-SrvPids {
  $pids = @()
  $owned = Get-OwnedPid
  if ($owned -gt 0) { $pids += $owned }
  foreach ($p in (Get-RepoNodePids)) { if ($pids -notcontains $p) { $pids += $p } }
  return $pids
}

function Do-Stop {
  # A PID file that names a dead process or the OTHER repository's server is
  # garbage: clear it so it can never be reported as "our" process again.
  $stale = Clear-StalePidFile
  if ($stale) { "stop ${Srv}: $stale" }

  # REFUSE to touch a port owned by something that is not a $Srv server.
  # Otherwise 'stop live' could shut down the mirror (or any other service).
  $owned = @(Get-RepoNodePids)
  $portOwner = Get-PortOwner $C.Port
  if ($portOwner -and ($owned -notcontains $portOwner)) {
    "stop $Srv SKIPPED: port $($C.Port) is owned by pid $portOwner which is NOT a $Srv server - refusing to touch it"
    return
  }

  # 1) GRACEFUL: the server flushes state atomically and exits on its own.
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$($C.Port)/api/shutdown" -Method Post -TimeoutSec 8 | Out-Null
  } catch { }
  $gone = $false
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-PortListening $C.Port)) { $gone = $true; break }
  }
  if ($gone) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    "stopped $Srv (graceful: state flushed)"
    return
  }
  # 2) Fallback: force kill, but ONLY processes proven to be ours.
  $pids = @(Get-SrvPids)
  foreach ($p in $pids) { & taskkill.exe /PID $p /T /F 2>&1 | Out-Null }
  Start-Sleep -Milliseconds 600
  foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  "stopped $Srv (FORCE - graceful shutdown did not respond; state may be stale)"
}

function Do-Start {
  if (Test-Http $C.Port 5) { "start $Srv skipped: port $($C.Port) already healthy"; return }
  # A stale PID file from a previous life would make the next stop target the
  # wrong process. Clear it before we launch anything.
  $stale = Clear-StalePidFile
  if ($stale) { "start ${Srv}: $stale" }
  # Rotate the logs: a file still held by a dying process makes the new child
  # die instantly with an empty error log (this really happened).
  foreach ($f in @('server.log', 'server.err')) {
    $lp = Join-Path $C.Dir $f
    try { if (Test-Path $lp) { Move-Item -LiteralPath $lp -Destination ($lp + '.prev') -Force -ErrorAction SilentlyContinue } } catch { }
  }
  # HIDDEN launch: a visible console window flashing on every watchdog restart
  # is what the operator saw as "blank PowerShell windows". The server is a
  # background service - it must never own a console.
  $proc = Start-Process -FilePath $Node -ArgumentList ('--max-old-space-size=' + $HeapCap),'server.js' -WorkingDirectory $C.Dir `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $C.Dir 'server.log') `
    -RedirectStandardError  (Join-Path $C.Dir 'server.err')
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Http $C.Port 5) { $ok = $true; break }
  }
  if ($ok) {
    $owned = Get-OwnedPid
    "started $Srv pid $owned port $($C.Port) - serving"
  } else {
    "started $Srv pid $($proc.Id) port $($C.Port) - NOT serving yet (check server.err)"
  }
}

switch ($Act) {
  'stop'    { Do-Stop }
  'start'   { Do-Start }
  'restart' { Do-Stop; Do-Start }
  'status'  {
    $up = Test-Http $C.Port 8
    $owned = Get-OwnedPid
    $repoPids = @(Get-RepoNodePids) -join ','
    $portOwner = Get-PortOwner $C.Port
    $stale = Clear-StalePidFile
    if ($up) { "$Srv port $($C.Port) UP pid $owned (repo node pids: $repoPids, port owner: $portOwner)" }
    else { "$Srv port $($C.Port) DOWN (repo node pids: $repoPids, port owner: $portOwner) $stale" }
  }
}
