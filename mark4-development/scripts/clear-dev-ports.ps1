param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$managed = @{
  8642 = @("hermes_cli.main", "gateway", "run")
  8787 = @("services/gateway/src/server.mjs")
  5174 = @("vite.js", "--port 5174")
}

foreach ($port in $managed.Keys) {
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $command = [string]$process.CommandLine
    $owned = $true
    foreach ($token in $managed[$port]) {
      if ($command -notlike "*$token*") { $owned = $false; break }
    }
    if (-not $owned) {
      throw "Port $port is occupied by an unrelated process $($process.ProcessId): $command"
    }

    $target = $process.ProcessId
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($parent -and ([string]$parent.CommandLine) -like "*scripts/dev.mjs*") {
      $target = $parent.ProcessId
    }
    & taskkill.exe /PID $target /T /F 2>$null | Out-Null
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $busy = @($managed.Keys | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
  if ($busy.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 120
} while ([DateTime]::UtcNow -lt $deadline)

throw "Managed ULTRON ports did not clear: $($busy -join ', ')"
