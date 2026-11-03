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
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

function Test-Http([int]$Port, [int]$TimeoutSec = 8) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSec -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Test-PortListening([int]$Port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $true }
    $c.EndConnect($iar)
    return $true
  } catch { return $false } finally { try { $c.Close() } catch { } }
}

function Get-SrvPids {
  $pids = @()
  $pidFile = Join-Path $C.Dir 'kai.pid'
  if (Test-Path $pidFile) {
    $raw = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $p = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$p)) {
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') { $pids += $p }
    }
  }
  return $pids
}

function Do-Stop {
  # 1) GRACEFUL: the server flushes state atomically and exits on its own.
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$($C.Port)/api/shutdown" -Method Post -TimeoutSec 8 | Out-Null
  } catch { }
  $gone = $false
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-PortListening $C.Port)) { $gone = $true; break }
  }
  if ($gone) { "stopped $Srv (graceful: state flushed)"; return }
  # 2) Fallback: force kill, but only because the graceful path failed.
  $pids = Get-SrvPids
  foreach ($p in $pids) { & taskkill.exe /PID $p /T /F 2>&1 | Out-Null }
  Start-Sleep -Milliseconds 600
  foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  "stopped $Srv (FORCE - graceful shutdown did not respond; state may be stale)"
}

function Do-Start {
  if (Test-Http $C.Port 5) { "start $Srv skipped: port $($C.Port) already healthy"; return }
  # Rotate the logs: a file still held by a dying process makes the new child
  # die instantly with an empty error log (this really happened).
  foreach ($f in @('server.log', 'server.err')) {
    $lp = Join-Path $C.Dir $f
    try { if (Test-Path $lp) { Move-Item -LiteralPath $lp -Destination ($lp + '.prev') -Force -ErrorAction SilentlyContinue } } catch { }
  }
  $proc = Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $C.Dir `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $C.Dir 'server.log') `
    -RedirectStandardError  (Join-Path $C.Dir 'server.err')
  Set-Content -Path (Join-Path $C.Dir 'kai.pid') -Value $proc.Id -Encoding ascii
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Http $C.Port 5) { $ok = $true; break }
  }
  if ($ok) { "started $Srv pid $($proc.Id) port $($C.Port) - serving" }
  else { "started $Srv pid $($proc.Id) port $($C.Port) - NOT serving yet (check server.err)" }
}

switch ($Act) {
  'stop'    { Do-Stop }
  'start'   { Do-Start }
  'restart' { Do-Stop; Do-Start }
  'status'  {
    $up = Test-Http $C.Port 8
    $pids = (Get-SrvPids) -join ','
    if ($up) { "$Srv port $($C.Port) UP pid $pids" } else { "$Srv port $($C.Port) DOWN (node pids: $pids)" }
  }
}
