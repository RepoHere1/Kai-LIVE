<#
  Kai-LIVE (LIVE-only) control script.
    .\kai.ps1 start     start the LIVE server (port 8788, real trading)
    .\kai.ps1 stop      stop the LIVE server
    .\kai.ps1 restart   stop then start
    .\kai.ps1 status    is it up, what cash, lane count
    .\kai.ps1 on        start every trading lane (LIVE)
    .\kai.ps1 off       stop every trading lane
    .\kai.ps1 logs      tail the server log
  Shortcut: .\kai.cmd start   (same thing)
#>
param(
  [Parameter(Position = 0)][string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Here 'kai.pid'
$LogFile = Join-Path $Here 'server.log'
$ErrFile = Join-Path $Here 'server.err'
$Base    = 'http://127.0.0.1:8788'
$Mode    = 'LIVE'
$Node    = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

function Get-KaiLiveProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $raw) { return $null }
  $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
  if ($p) { return $p }
  return $null
}

function Test-KaiLivePort {
  try {
    $r = Invoke-WebRequest -Uri ($Base + '/api/health') -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Start-KaiLive {
  if (Get-KaiLiveProcess) { Write-Host 'already running (pid ' + (Get-KaiLiveProcess).Id + ')' -ForegroundColor Yellow; return }
  if (Test-KaiLivePort) { Write-Host 'a Kai-LIVE server is already answering on ' + $Base -ForegroundColor Yellow; return }
  Write-Host 'starting Kai-LIVE (LIVE, port 8788)...' -ForegroundColor Red
  $p = Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $Here `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
  Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $h = Test-KaiLivePort
    if ($h) {
      Write-Host ('✓ LIVE  pid ' + $p.Id + '  cash $' + [Math]::Round($h.live_balance, 2)) -ForegroundColor Red
      Write-Host ('open  ' + $Base + '/') -ForegroundColor Red
      return
    }
    if ($p.HasExited) {
      Write-Host 'server exited during startup. tail:' -ForegroundColor Red
      if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
      if (Test-Path $ErrFile) { Get-Content $ErrFile -Tail 20 }
      return
    }
  }
  Write-Host 'timed out waiting for ' + $Base -ForegroundColor Red
}

function Stop-KaiLive {
  $p = Get-KaiLiveProcess
  if (-not $p) { Write-Host 'not running' -ForegroundColor Yellow; Remove-Item $PidFile -ErrorAction SilentlyContinue; return }
  Write-Host ('stopping Kai-LIVE LIVE pid ' + $p.Id) -ForegroundColor Red
  & taskkill.exe /PID $p.Id /T /F | Out-Null
  Start-Sleep -Milliseconds 800
  $left = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if ($left) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host 'stopped' -ForegroundColor Green
}

function Show-Status {
  $h = Test-KaiLivePort
  $p = Get-KaiLiveProcess
  if (-not $h) { Write-Host 'DOWN' -ForegroundColor Red; if ($p) { Write-Host ('stale pid file: ' + $p.Id) }; return }
  Write-Host 'UP (LIVE mode, port 8788, REAL TRADING)' -ForegroundColor Red
  Write-Host ('  pid        : ' + $(if ($p) { $p.Id } else { '(not tracked)' }))
  Write-Host ('  live cash  : $' + [Math]::Round($h.live_balance, 2))
  Write-Host ('  kalshi     : ' + $h.hosts.kalshi_live + ' (live), ' + $h.hosts.kalshi_demo + ' (fallback)')
  Write-Host ('  spot       : ' + $h.hosts.spot)
  Write-Host ('  llm        : ' + $h.hosts.llm)
  Write-Host ('  uptime     : ' + [Math]::Round($h.uptime_sec / 60, 1) + ' min')
  try {
    $s = (Invoke-WebRequest -Uri ($Base + '/api/strategies') -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
    $run = @($s.PSObject.Properties | Where-Object { $_.Value.running }).Count
    Write-Host ('  lanes      : ' + $run + ' / ' + @($s.PSObject.Properties).Count + ' running')
  } catch { }
  Write-Host ('  open       : ' + $Base + '/')
}

function Set-Lanes([bool]$want) {
  $h = Test-KaiLivePort
  if (-not $h) { Write-Host 'LIVE server is down - run: .\kai.ps1 start' -ForegroundColor Red; return }
  $s = (Invoke-WebRequest -Uri ($Base + '/api/strategies') -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  $changed = 0
  foreach ($prop in $s.PSObject.Properties) {
    if ($prop.Value.running -ne $want) {
      $name = [uri]::EscapeDataString($prop.Name)
      Invoke-WebRequest -Uri ($Base + '/api/strategy/' + $name + '/toggle') -Method POST -UseBasicParsing -TimeoutSec 5 | Out-Null
      $changed++
    }
  }
  Write-Host (($(if ($want) { 'started' } else { 'stopped' })) + ' ' + $changed + ' lane(s) in LIVE mode') -ForegroundColor Red
}

switch ($Action.ToLower()) {
  'start'   { Start-KaiLive }
  'stop'    { Stop-KaiLive }
  'restart' { Stop-KaiLive; Start-KaiLive }
  'status'  { Show-Status }
  'on'      { Set-Lanes $true }
  'off'     { Set-Lanes $false }
  'logs'    { if (Test-Path $LogFile) { Get-Content $LogFile -Tail 40 } else { Write-Host 'no log yet' } }
  'default' { Write-Host 'usage: .\kai.ps1 [start|stop|restart|status|on|off|logs]' }
}
