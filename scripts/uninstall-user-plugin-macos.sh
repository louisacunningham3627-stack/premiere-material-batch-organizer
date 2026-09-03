#!/bin/bash
set -euo pipefail

PLUGIN_ID="com.hechao.premiere.material-batch-organizer"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_ROOT="${HOME}/Library/Application Support/Adobe/UXP/Plugins/External"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-root) TARGET_ROOT="$2"; shift 2;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done
TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
UXP_ROOT="$(dirname "$(dirname "$TARGET_ROOT")")"
BACKUP_ROOT="$UXP_ROOT/PluginBackups"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(uuidgen | tr -d '-' | cut -c1-8)"
BACKUP_PATH="$BACKUP_ROOT/${PLUGIN_ID}-uninstalled-${RUN_ID}"

if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再卸载插件。" >&2
  exit 1
fi
if [[ ! -e "$TARGET_PATH" ]]; then echo "插件当前未安装：$TARGET_PATH"; exit 0; fi
[[ -d "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || { echo "安装目标不是普通插件文件夹，已拒绝移动。" >&2; exit 1; }
[[ -f "$TARGET_PATH/manifest.json" ]] || { echo "安装目标缺少 manifest.json，已拒绝移动。" >&2; exit 1; }
[[ "$(plutil -extract id raw -o - "$TARGET_PATH/manifest.json" 2>/dev/null)" == "$PLUGIN_ID" ]] || { echo "安装目标属于其他插件，已拒绝移动。" >&2; exit 1; }
mkdir -p "$BACKUP_ROOT"
mv "$TARGET_PATH" "$BACKUP_PATH"
RESTORE_SCRIPT="$SCRIPT_DIR/restore-user-plugin-macos.sh"
if [[ -f "$SCRIPT_DIR/恢复-macOS.sh" ]]; then RESTORE_SCRIPT="$SCRIPT_DIR/恢复-macOS.sh"; fi
echo "已卸载：$PLUGIN_ID"
echo "可恢复备份：$BACKUP_PATH"
echo "恢复方式：bash '$RESTORE_SCRIPT' --backup-path '$BACKUP_PATH' --target-root '$TARGET_ROOT'"
