function Free-Port($port) {
  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -ExpandProperty OwningProcess -Unique
  if (-not $pids) { Write-Host "端口 $port 空闲" -ForegroundColor Green; return }
  foreach ($p in $pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    Write-Host "结束进程 $p ($($proc.ProcessName))" -ForegroundColor Yellow
    Stop-Process -Id $p -Force
  }
}

Free-Port 8765