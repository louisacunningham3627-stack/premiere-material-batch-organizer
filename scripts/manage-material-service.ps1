param([Parameter(Mandatory=$true)][string]$PluginPath, [ValidateSet('Start','Stop','Unregister')][string]$Action)
$ErrorActionPreference = 'Stop'
$plugin = [IO.Path]::GetFullPath($PluginPath)
$helper = Join-Path $plugin 'native\windows\MaterialFileHelper.exe'
$locationPath = Join-Path $plugin 'native\windows\bridge-location.json'
if (-not (Test-Path -LiteralPath $locationPath)) { if ($Action -eq 'Start') { throw 'Bridge location is missing' }; return }
$bridge = (Get-Content -Raw -LiteralPath $locationPath | ConvertFrom-Json).directory
$cursor = [IO.Path]::GetFullPath($bridge)
while ($cursor) {
  if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bridge links are not allowed' }
  $cursor = [IO.Path]::GetDirectoryName($cursor)
}
$token = [IO.File]::ReadAllText((Join-Path $bridge 'token.txt')).Trim()
$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'HechaoMaterialFileService'
$command = '"' + $helper + '" --serve'
$runKey = Get-Item -LiteralPath $runPath -ErrorAction SilentlyContinue
$existing = if ($runKey) { $runKey.GetValue($runName) } else { $null }
if ($existing -and $existing -cne $command) { throw 'Service startup entry belongs to another path; not changed' }
if ($Action -eq 'Unregister') {
  if ($existing -ceq $command) { Remove-ItemProperty -LiteralPath $runPath -Name $runName }
  return
}
$currentFile = Join-Path $bridge 'service.current.json'
if ($Action -eq 'Stop') {
  if (-not (Test-Path -LiteralPath $currentFile)) { return }
  $current = Get-Content -Raw -LiteralPath $currentFile | ConvertFrom-Json
  if ($current.token -cne $token -or $current.executable -ine $helper -or $current.session -notmatch '^[0-9a-f]{32}$') { throw 'Service identity does not match installation' }
  $process = Get-Process -Id $current.pid -ErrorAction SilentlyContinue
  if (-not $process) { return }
  if ($process.Path -ine $helper) { throw 'Service process identity changed; not stopped' }
  $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
  if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds - $current.startedAt) -gt 2) { throw 'Service PID was reused; not stopped' }
  $stop = Join-Path $bridge ('service-' + $current.session + '.stop.json')
  if (-not (Test-Path -LiteralPath $stop)) {
    $bytes = [Text.Encoding]::UTF8.GetBytes((@{token=$token;session=$current.session} | ConvertTo-Json -Compress))
    $stream = [IO.File]::Open($stop, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  }
  if (-not $process.WaitForExit(15000)) { throw 'Service is draining an active operation; installation stopped without terminating it' }
  $stopped = Get-Content -Raw -LiteralPath (Join-Path $bridge ('service-' + $current.session + '.stopped.json')) | ConvertFrom-Json
  if ($stopped.session -cne $current.session -or $stopped.token -cne $token) { throw 'Service stop receipt mismatch' }
  return
}
$ready = $false
if (Test-Path -LiteralPath $currentFile) {
  $current = Get-Content -Raw -LiteralPath $currentFile | ConvertFrom-Json
  if ($current.token -cne $token -or $current.executable -ine $helper -or $current.session -notmatch '^[0-9a-f]{32}$') { throw 'Service identity does not match installation' }
  $running = Get-Process -Id $current.pid -ErrorAction SilentlyContinue
  $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
  if ($running -and $running.Path -ieq $helper -and [Math]::Abs(($running.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds - $current.startedAt) -le 2) {
    if (Test-Path -LiteralPath (Join-Path $bridge ('service-' + $current.session + '.stop.json'))) { throw 'Service is still draining; not restarted' }
    $ready = $true
  }
}
if (-not $ready) { $child = Start-Process -FilePath $helper -ArgumentList '--serve' -WindowStyle Hidden -PassThru }
for ($attempt=0; -not $ready -and $attempt -lt 80; $attempt++) {
  if (Test-Path -LiteralPath $currentFile) {
    try {
      $current = Get-Content -Raw -LiteralPath $currentFile | ConvertFrom-Json
      if ($current.token -ceq $token -and $current.executable -ieq $helper -and $current.pid -eq $child.Id) { $ready=$true; break }
    } catch { }
  }
  Start-Sleep -Milliseconds 100
}
if (-not $ready) { throw 'Local file service failed to start; installation not accepted' }
$probeId = [guid]::NewGuid().ToString('N')
$ticket = [guid]::NewGuid().ToString('N')
$epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
$expiresAt = [long](([DateTime]::UtcNow - $epoch).TotalMilliseconds + 15000)
foreach ($entry in @(
  @{name=($probeId+'.probe-request.json');value=@{id=$probeId;token=$token;version=1;expiresAt=$expiresAt}},
  @{name=($ticket+'.dispatch.json');value=@{id=$probeId;ticket=$ticket;verb='probe';session=$current.session;token=$token;expiresAt=$expiresAt}}
)) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($entry.value | ConvertTo-Json -Compress))
  $stream = [IO.File]::Open((Join-Path $bridge $entry.name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
$probeFile = Join-Path $bridge ($probeId+'.probe-result.json')
$healthy = $false
for ($attempt=0; $attempt -lt 120; $attempt++) {
  try {
    if (Test-Path -LiteralPath $probeFile) {
      $response = Get-Content -Raw -LiteralPath $probeFile | ConvertFrom-Json
      if ($response.id -ceq $probeId -and $response.token -ceq $token -and $response.status -ceq 'available') { $healthy=$true; break }
    }
  } catch { }
  Start-Sleep -Milliseconds 100
}
if (-not $healthy) { throw 'Local service probe failed; installation not accepted' }
if (-not (Test-Path -LiteralPath $runPath)) { New-Item -Path $runPath -Force | Out-Null }
New-ItemProperty -LiteralPath $runPath -Name $runName -Value $command -PropertyType String -Force | Out-Null
if ((Get-Item -LiteralPath $runPath).GetValue($runName) -cne $command) { throw 'Service startup registration failed' }
