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
fail() { echo "恢复失败：$1" >&2; exit 1; }
path_present() { [[ -e "$1" || -L "$1" ]]; }
reject_symlinks() {
  local root="$1"
  local label="$2"
  [[ ! -L "$root" ]] || fail "$label 不能是符号链接：$root"
  local link
  link="$(find "$root" -type l -print -quit)"
  [[ -z "$link" ]] || fail "$label 包含符号链接：$link"
}
PLUTIL_BIN="${PLUTIL_BIN:-/usr/bin/plutil}"
[[ -x "$PLUTIL_BIN" ]] || fail "找不到 macOS 自带的 plutil，无法安全读取 manifest.json。"
manifest_value() {
  "$PLUTIL_BIN" -extract "$2" raw -o - "$1" 2>/dev/null
}
path_present "$BACKUP_PATH" || fail "请提供存在的插件备份路径。"
[[ -d "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]] || fail "备份路径必须是存在的普通目录，不能是符号链接。"
reject_symlinks "$BACKUP_PATH" "插件备份"
if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再恢复插件。" >&2
  exit 1
fi
TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
if path_present "$TARGET_ROOT"; then
  [[ ! -L "$TARGET_ROOT" ]] || fail "恢复目标根目录不能是符号链接：$TARGET_ROOT"
fi
! path_present "$TARGET_PATH" || fail "恢复目标已存在，为避免覆盖已拒绝：$TARGET_PATH"
[[ -f "$BACKUP_PATH/manifest.json" && ! -L "$BACKUP_PATH/manifest.json" ]] || fail "备份缺少普通 manifest.json，已拒绝恢复。"
[[ "$(manifest_value "$BACKUP_PATH/manifest.json" id)" == "$PLUGIN_ID" ]] || fail "备份不属于当前插件，已拒绝恢复。"
mkdir -p "$TARGET_ROOT"
path_present "$TARGET_PATH" && fail "恢复切换前目标路径再次出现，已停止恢复。"
mv "$BACKUP_PATH" "$TARGET_PATH"
echo "已恢复：$TARGET_PATH"
