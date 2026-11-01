# Kai-LIVE Server - Persistent Background Launcher
$serverPath = "C:\Users\darri\Kai-LIVE\server.js"
$outLog = "C:\Users\darri\Kai-LIVE\server-out.log"
$errLog = "C:\Users\darri\Kai-LIVE\server-err.log"
$port = 8788

# Kill any existing node on this port
$existing = netstat -ano | Select-String ":$port "
if ($existing) {
    $foundPids = $existing | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
    foreach ($foundPid in $foundPids) {
        if ($foundPid -ne '0') { taskkill /F /PID $foundPid 2>$null }
    }
    Start-Sleep 1
}

# Start server with redirected I/O (use separate files for stdout/stderr)
$process = Start-Process node -ArgumentList "`"$serverPath`"" -WorkingDirectory "C:\Users\darri\Kai-LIVE" -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

Write-Host "Kai-LIVE started (PID: $($process.Id)) on port $port"
Write-Host "Stdout: $outLog"
Write-Host "Stderr: $errLog"
$process.Id | Out-File "C:\Users\darri\Kai-LIVE\server.pid" -Encoding ascii

# Verify it's up
Start-Sleep 3
for ($i=0; $i -lt 10; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -UseBasicParsing
        if ($resp.StatusCode -eq 200) {
            Write-Host "[OK] Server healthy on port $port"
            exit 0
        }
    } catch { }
    Start-Sleep 1
}
Write-Warning "Server may not be fully ready yet"