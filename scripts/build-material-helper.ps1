param([string]$OutputDirectory = '', [switch]$TestHooks)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if ($TestHooks) {
  if ($OutputDirectory) { throw '故障注入版本只能写入固定的独立测试目录' }
  $OutputDirectory = Join-Path $project 'work\native-test-candidate'
} elseif (-not $OutputDirectory) { $OutputDirectory = Join-Path $project 'work\native-candidate' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '缺少 Windows C# 编译器，未生成回收助手' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$source = Join-Path $project 'native\windows\MaterialFileHelper.cs'
$output = Join-Path $OutputDirectory 'MaterialFileHelper.exe'
$compileOptions = @('/nologo', '/target:winexe', '/reference:System.Web.Extensions.dll', "/out:$output")
if ($TestHooks) { $compileOptions += '/define:MATERIAL_HELPER_TEST' }
& $compiler @compileOptions $source (Join-Path $project 'native\windows\MaterialBridgeService.cs')
if ($LASTEXITCODE -ne 0) { throw '素材回收助手编译失败' }
Write-Output $output
