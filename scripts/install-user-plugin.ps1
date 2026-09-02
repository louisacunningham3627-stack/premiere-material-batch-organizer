[CmdletBinding()]
param(
  [string]$BuildPath = "",
  [string]$TargetRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pluginId = "com.hechao.premiere.material-batch-organizer"

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-FileInventory {
  param([Parameter(Mandatory = $true)][string]$Root)

  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\")
  return @(
    Get-ChildItem -File -Recurse -LiteralPath $resolvedRoot | ForEach-Object {
      [pscustomobject]@{
        RelativePath = $_.FullName.Substring($resolvedRoot.Length).TrimStart("\")
        Hash = Get-Sha256 -Path $_.FullName
      }
    }
  )
}

if ([string]::IsNullOrWhiteSpace($BuildPath)) {
  $scriptDirectory = Split-Path -Parent $PSCommandPath
  $BuildPath = Join-Path (Split-Path -Parent $scriptDirectory) "dist"
}

if ([string]::IsNullOrWhiteSpace($TargetRoot) -and [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  throw "无法读取 APPDATA，不能确定用户级 UXP 插件目录。"
}
if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
  $TargetRoot = Join-Path $env:APPDATA "Adobe\UXP\Plugins\External"
}

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  throw "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再重新安装插件。"
}

if (-not (Test-Path -LiteralPath $BuildPath -PathType Container)) {
  throw "找不到构建目录：$BuildPath。请先运行 npm run check。"
}

$manifestPath = Join-Path $BuildPath "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "找不到插件清单：$manifestPath"
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.id -ne $pluginId) {
  throw "插件清单中的标识不正确：$($manifest.id)"
}
if ($manifest.host.app -ne "premierepro") {
  throw "当前构建并非 Premiere Pro 插件。"
}

$uxpRoot = Split-Path -Parent (Split-Path -Parent $TargetRoot)
$stagingRoot = Join-Path $uxpRoot "PluginStaging"
$backupRoot = Join-Path $uxpRoot "PluginBackups"
$targetPath = Join-Path $TargetRoot $pluginId
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$stagingPath = Join-Path $stagingRoot ("{0}-{1}" -f $pluginId, $runId)
$backupPath = Join-Path $backupRoot ("{0}-before-{1}" -f $pluginId, $runId)
$failedPath = Join-Path $backupRoot ("{0}-failed-{1}" -f $pluginId, $runId)

New-Item -ItemType Directory -Path $TargetRoot, $stagingRoot, $backupRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
Get-ChildItem -Force -LiteralPath $BuildPath | Copy-Item -Destination $stagingPath -Recurse -Force

$sourceInventory = Get-FileInventory -Root $BuildPath
$stagedInventory = Get-FileInventory -Root $stagingPath
$stageDiff = @(Compare-Object $sourceInventory $stagedInventory -Property RelativePath, Hash)
if ($sourceInventory.Count -eq 0 -or $stageDiff.Count -ne 0) {
  throw "暂存插件的文件数量或 SHA-256 校验失败，现场已保留在：$stagingPath"
}

$previousInstall = Test-Path -LiteralPath $targetPath -PathType Container
try {
  if ($previousInstall) {
    Move-Item -LiteralPath $targetPath -Destination $backupPath
  }

  Move-Item -LiteralPath $stagingPath -Destination $targetPath
  $installedInventory = Get-FileInventory -Root $targetPath
  $installDiff = @(Compare-Object $sourceInventory $installedInventory -Property RelativePath, Hash)
  if ($installDiff.Count -ne 0) {
    throw "已安装插件未通过 SHA-256 校验。"
  }
} catch {
  if (Test-Path -LiteralPath $targetPath) {
    Move-Item -LiteralPath $targetPath -Destination $failedPath
  }
  if ($previousInstall -and (Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $targetPath)) {
    Move-Item -LiteralPath $backupPath -Destination $targetPath
  }
  throw
}

[pscustomobject]@{
  状态 = "已安装"
  插件标识 = $pluginId
  版本 = [string]$manifest.version
  安装路径 = $targetPath
  文件数量 = $sourceInventory.Count
  旧版备份 = if ($previousInstall) { $backupPath } else { $null }
  下一步 = "启动 Premiere，然后在【窗口 > UXP 插件】中打开【赫朝素材自动整理】。"
}
