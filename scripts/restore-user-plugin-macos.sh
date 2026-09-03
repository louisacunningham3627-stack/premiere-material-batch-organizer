#!/bin/bash
set -euo pipefail

PLUGIN_ID="com.hechao.premiere.material-batch-organizer"
BACKUP_PATH=""
TARGET_ROOT="${HOME}/Library/Application Support/Adobe/UXP/Plugins/External"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-path) BACKUP_PATH="$2"; shift 2;;
    --target-root) TARGET_ROOT="$2"; shift 2;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done
[[ -n "$BACKUP_PATH" && -d "$BACKUP_PATH" ]] || { echo "请提供可恢复的插件备份目录。" >&2; exit 1; }
if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再恢复插件。" >&2
  exit 1
fi
TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
[[ ! -e "$TARGET_PATH" ]] || { echo "恢复目标已存在，为避免覆盖已拒绝：$TARGET_PATH" >&2; exit 1; }
[[ -f "$BACKUP_PATH/manifest.json" ]] || { echo "备份缺少 manifest.json，已拒绝恢复。" >&2; exit 1; }
[[ "$(plutil -extract id raw -o - "$BACKUP_PATH/manifest.json" 2>/dev/null)" == "$PLUGIN_ID" ]] || { echo "备份不属于当前插件，已拒绝恢复。" >&2; exit 1; }
mkdir -p "$TARGET_ROOT"
mv "$BACKUP_PATH" "$TARGET_PATH"
echo "已恢复：$TARGET_PATH"
