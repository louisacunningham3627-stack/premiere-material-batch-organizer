[CmdletBinding()]
param(
  [string]$TargetRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pluginId = "com.hechao.premiere.material-batch-organizer"

if ([string]::IsNullOrWhiteSpace($TargetRoot) -and [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  throw "无法读取 APPDATA，不能确定用户级 UXP 插件目录。"
}
if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
  $TargetRoot = Join-Path $env:APPDATA "Adobe\UXP\Plugins\External"
}

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  throw "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再卸载插件。"
}

$targetPath = Join-Path $TargetRoot $pluginId
if (-not (Test-Path -LiteralPath $targetPath)) {
  [pscustomobject]@{
    状态 = "未安装"
    插件标识 = $pluginId
    安装路径 = $targetPath
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
  throw "安装目标已存在但不是文件夹，已拒绝处理：$targetPath"
}

$targetItem = Get-Item -Force -LiteralPath $targetPath
if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "安装目标是重解析点，已拒绝移动：$targetPath"
}

$manifestPath = Join-Path $targetPath "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "安装目标不是可识别的当前插件，缺少 manifest.json：$targetPath"
}
try {
  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
} catch {
  throw "安装目标的 manifest.json 无法读取，已拒绝移动：$targetPath"
}
if ($manifest.id -ne $pluginId) {
  throw "安装目标属于其他插件，已拒绝移动：$($manifest.id)"
}

$uxpRoot = Split-Path -Parent (Split-Path -Parent $TargetRoot)
$backupRoot = Join-Path $uxpRoot "PluginBackups"
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$backupPath = Join-Path $backupRoot ("{0}-uninstalled-{1}" -f $pluginId, $runId)

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Move-Item -LiteralPath $targetPath -Destination $backupPath

[pscustomobject]@{
  状态 = "已卸载"
  插件标识 = $pluginId
  原安装路径 = $targetPath
  可恢复备份 = $backupPath
  恢复命令 = "Move-Item -LiteralPath '$backupPath' -Destination '$targetPath'"
}
