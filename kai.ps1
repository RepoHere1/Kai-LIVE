# Kai-LIVE shortcut (MASTER_TRACKER.md: "kai.ps1  # LIVE shortcut").
# The real control script is kai-live.ps1 - this shim forwards everything to
# it so `.\kai.ps1` in this repo behaves exactly like Kai-Mirror's `.\kai.ps1`.
#   .\kai.ps1              status (server + all lanes)
#   .\kai.ps1 on | off     all lanes (or one: .\kai.ps1 on btc_updown)
#   .\kai.ps1 start | stop | restart | dashboard
param(
  [Parameter(Position=0)][string]$Cmd = 'status',
  [Parameter(Position=1)][string]$Lane
)
$full = Join-Path $PSScriptRoot 'kai-live.ps1'
if (-not (Test-Path $full)) { Write-Error "missing $full"; exit 1 }
if ($Lane) { & $full $Cmd $Lane } else { & $full $Cmd }
exit $LASTEXITCODE
