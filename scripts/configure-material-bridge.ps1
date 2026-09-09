param([Parameter(Mandatory=$true)][string]$PluginPath)
$ErrorActionPreference = 'Stop'
function Assert-PlainAncestors([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝链接或挂载点：$cursor" }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) { throw '请正常关闭 Premiere 后再安装' }
$plugin = (Resolve-Path -LiteralPath $PluginPath).Path
Assert-PlainAncestors $plugin
$manifest = Get-Content -LiteralPath (Join-Path $plugin 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.id -ne 'com.hechao.premiere.material-batch-organizer') { throw '插件身份不匹配' }
$helper = Join-Path $plugin 'native\windows\MaterialFileHelper.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw '缺少素材回收助手' }
Assert-PlainAncestors $helper
$scheme = 'HKCU:\Software\Classes\hechao-material-recycle'
$commandKey = Join-Path $scheme 'shell\open\command'
$command = '"' + $helper + '" "%1"'
$schemeExisted = Test-Path -LiteralPath $scheme
if ($schemeExisted) {
  if (-not (Test-Path -LiteralPath $commandKey) -or (Get-Item -LiteralPath $commandKey).GetValue('') -cne $command) { throw '回收协议已被其他程序占用，未覆盖' }
  if ('URL Protocol' -notin (Get-Item -LiteralPath $scheme).GetValueNames()) { throw '现有回收协议缺少 URL Protocol 标记，未覆盖，请先核对登记' }
}
$bridge = Join-Path $env:APPDATA 'Adobe\UXP\MaterialBatchData\Bridge'
Assert-PlainAncestors $bridge
New-Item -ItemType Directory -Path $bridge -Force | Out-Null
Assert-PlainAncestors $bridge
$tokenPath = Join-Path $bridge 'token.txt'
Assert-PlainAncestors $tokenPath
if (-not (Test-Path -LiteralPath $tokenPath)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $tokenBytes = [Text.Encoding]::ASCII.GetBytes([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
  $stream = [IO.File]::Open($tokenPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($tokenBytes, 0, $tokenBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
if ([IO.File]::ReadAllText($tokenPath).Trim() -notmatch '^[0-9a-f]{64}$') { throw '现有回收凭据无效，未覆盖' }
$locationPath = Join-Path $plugin 'native\windows\bridge-location.json'
Assert-PlainAncestors $locationPath
[IO.File]::WriteAllText($locationPath, (@{directory=$bridge} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
if (-not $schemeExisted) {
  try {
    New-Item -Path $commandKey -Force | Out-Null
    Set-Item -LiteralPath $commandKey -Value $command
    Set-Item -LiteralPath $scheme -Value 'URL:素材回收'
    New-ItemProperty -LiteralPath $scheme -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    if ((Get-Item -LiteralPath $commandKey).GetValue('') -cne $command) { throw '回收协议写入核验失败' }
  } catch {
    $failure = $_
    if ((Test-Path -LiteralPath $commandKey) -and (Get-Item -LiteralPath $commandKey).GetValue('') -ceq $command) {
      [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\Classes\hechao-material-recycle', $false)
    }
    throw $failure
  }
}
& (Join-Path $PSScriptRoot 'manage-material-service.ps1') -PluginPath $plugin -Action Start
