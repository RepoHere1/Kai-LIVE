<#
  Kai-Mirror control script.
    .\kai.ps1 start     start the server (dashboard + Kalshi/Coinbase/Kilo bridge)
    .\kai.ps1 stop      stop the server
    .\kai.ps1 restart   stop then start
    .\kai.ps1 status    is it up, what mode, dry cash, lane count
    .\kai.ps1 reset     wipe the DRY book back to a clean $300 / zero trades
    .\kai.ps1 on        start every trading lane (paper)
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
$Base    = 'http://127.0.0.1:8787'
$Node    = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

function Get-KaiProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $raw) { return $null }
  $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
  if ($p) { return $p }
  return $null
}

function Test-KaiPort {
  try {
    $r = Invoke-WebRequest -Uri ($Base + '/api/health') -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Start-Kai {
  if (Get-KaiProcess) { Write-Host 'already running (pid ' + (Get-KaiProcess).Id + ')' -ForegroundColor Yellow; return }
  if (Test-KaiPort) { Write-Host 'a Kai-Mirror server is already answering on ' + $Base -ForegroundColor Yellow; return }
  Write-Host 'starting Kai-Mirror...' -ForegroundColor Cyan
  $p = Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $Here `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
  Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $h = Test-KaiPort
    if ($h) {
      Write-Host ('up  pid ' + $p.Id + '  mode ' + $h.mode + '  dry cash $' + [Math]::Round($h.dry_balance, 2)) -ForegroundColor Green
      Write-Host ('open  ' + $Base + '/') -ForegroundColor Green
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

function Stop-Kai {
  $p = Get-KaiProcess
  if (-not $p) { Write-Host 'not running' -ForegroundColor Yellow; Remove-Item $PidFile -ErrorAction SilentlyContinue; return }
  Write-Host ('stopping pid ' + $p.Id) -ForegroundColor Cyan
  # kill the whole tree so no node child survives
  & taskkill.exe /PID $p.Id /T /F | Out-Null
  Start-Sleep -Milliseconds 800
  $left = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if ($left) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host 'stopped' -ForegroundColor Green
}

function Show-Status {
  $h = Test-KaiPort
  $p = Get-KaiProcess
  if (-not $h) { Write-Host 'DOWN' -ForegroundColor Red; if ($p) { Write-Host ('stale pid file: ' + $p.Id) }; return }
  Write-Host 'UP' -ForegroundColor Green
  Write-Host ('  pid        : ' + $(if ($p) { $p.Id } else { '(not tracked)' }))
  Write-Host ('  mode       : ' + $h.mode)
  Write-Host ('  dry cash   : $' + [Math]::Round($h.dry_balance, 2))
  Write-Host ('  kalshi live: ' + $h.hosts.kalshi_live)
  Write-Host ('  kalshi demo: ' + $h.hosts.kalshi_demo + '  (fallback)')
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

function Reset-Dry {
  Stop-Kai
  $state = Join-Path $Here 'state.json'
  if (Test-Path $state) { Remove-Item $state -Force; Write-Host 'removed state.json (old dry book)' -ForegroundColor Cyan }
  Get-ChildItem $Here -Filter 'state.json.*' -ErrorAction SilentlyContinue | Remove-Item -Force
  Start-Kai
  Set-Lanes $false   # a clean book starts with nothing trading
  $h = Test-KaiPort
  if ($h) { Write-Host ('dry book reset: cash $' + [Math]::Round($h.dry_balance, 2) + ', 0 trades, 0 lanes running') -ForegroundColor Green }
}

function Set-Lanes([bool]$want) {
  $h = Test-KaiPort
  if (-not $h) { Write-Host 'server is down - run: .\kai.ps1 start' -ForegroundColor Red; return }
  $s = (Invoke-WebRequest -Uri ($Base + '/api/strategies') -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  $changed = 0
  foreach ($prop in $s.PSObject.Properties) {
    if ($prop.Value.running -ne $want) {
      $name = [uri]::EscapeDataString($prop.Name)
      Invoke-WebRequest -Uri ($Base + '/api/strategy/' + $name + '/toggle') -Method POST -UseBasicParsing -TimeoutSec 5 | Out-Null
      $changed++
    }
  }
  Write-Host (($(if ($want) { 'started' } else { 'stopped' })) + ' ' + $changed + ' lane(s)') -ForegroundColor Green
}

function Set-Lanes-Live {
  $h = Test-KaiPort
  if (-not $h) { Write-Host 'server is down - run: .\kai.ps1 start' -ForegroundColor Red; return }
  # Switch engine to LIVE mode
  $modeResp = Invoke-WebRequest -Uri ($Base + '/api/mode') -Method POST -UseBasicParsing -TimeoutSec 5 `
    -ContentType 'application/json' -Body '{"mode":"live"}'
  $modeData = $modeResp.Content | ConvertFrom-Json
  if (-not $modeData.ok) { Write-Host 'mode switch failed: ' + $modeData.error -ForegroundColor Red; return }
  Write-Host 'engine switched to LIVE mode' -ForegroundColor Cyan
  # Start all stopped lanes
  Set-Lanes $true
}

switch ($Action.ToLower()) {
  'start'   { Start-Kai }
  'stop'    { Stop-Kai }
  'restart' { Stop-Kai; Start-Kai }
  'status'  { Show-Status }
  'reset'   { Reset-Dry }
  'on'      { Set-Lanes $true }
  'onlive'  { Set-Lanes-Live }
  'off'     { Set-Lanes $false }
  'logs'    { if (Test-Path $LogFile) { Get-Content $LogFile -Tail 40 } else { Write-Host 'no log yet' } }
  'default' { Write-Host 'usage: .\kai.ps1 [start|stop|restart|status|reset|on|onlive|off|logs]' }
}
