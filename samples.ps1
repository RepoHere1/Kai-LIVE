# WIN-COLOR SAMPLES (operator order 2026-11-10): the aging panel renders
# Yellow ~ White (they differ only in the blue channel, which fades first),
# so shadow WINs are switching to TRUE ORANGE - zero blue, cannot wash out.
# Run this in the SAME console you run tape.ps1 in, pick a letter, then set
# $script:WinOrange (near the top of tape.ps1) to that 'R;G;B' string.
# Shipped default: C.
$ErrorActionPreference = 'SilentlyContinue'
$vt = $false
try {
  if (-not ('Win.KaiVT' -as [type])) {
    Add-Type -Namespace Win -Name KaiVT -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out int m); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, int m);'
  }
  $kh = [Win.KaiVT]::GetStdHandle(-11)
  $km = 0
  if ([Win.KaiVT]::GetConsoleMode($kh, [ref]$km)) { $vt = [Win.KaiVT]::SetConsoleMode($kh, ($km -bor 4)) }
} catch { $vt = $false }
$esc = [char]27
$sample = 'SHADOW WIN KXETHD-26NOV1017-T2099.99 NO @0.49 pnl=0.51'
Write-Host '==== SHADOW WIN color samples - pick a letter ====' -ForegroundColor White
if ($vt) {
  $cands = @(
    @{ L = 'A'; rgb = '255;165;0'; name = 'web orange' },
    @{ L = 'B'; rgb = '255;140;0'; name = 'darkorange1' },
    @{ L = 'C'; rgb = '255;128;0'; name = 'half-green orange (SHIPPED DEFAULT)' },
    @{ L = 'D'; rgb = '255;106;0'; name = 'darkorange' },
    @{ L = 'E'; rgb = '255;85;0';  name = 'deep orange (survives heavy washout)' },
    @{ L = 'F'; rgb = '255;64;0';  name = 'orange-red edge' }
  )
  foreach ($c in $cands) {
    Write-Host ("{0}  {1,-42} " -f $c.L, $c.name) -NoNewline -ForegroundColor Gray
    Write-Host ($esc + '[1m' + $esc + '[38;2;' + $c.rgb + 'm' + $sample + $esc + '[0m')
  }
  Write-Host 'Y  old Yellow (reads white on old panels)     ' -NoNewline -ForegroundColor Gray
  Write-Host $sample -ForegroundColor Yellow
  Write-Host 'L  LOSS (unchanged, white)                    ' -NoNewline -ForegroundColor Gray
  Write-Host 'SHADOW LOSS KXETHD-26NOV1017-T2099.99 NO @0.49 pnl=-0.49' -ForegroundColor White
  Write-Host 'Shipped default = C. To change: edit $WinOrange near the top of tape.ps1.' -ForegroundColor Cyan
} else {
  Write-Host 'This console refused 24-bit ANSI color (works in Windows Terminal / Win10+ console).' -ForegroundColor Red
  Write-Host 'Tape fallback in use - DarkYellow (olive-gold, dim but never white-like):' -ForegroundColor Gray
  Write-Host $sample -ForegroundColor DarkYellow
}
