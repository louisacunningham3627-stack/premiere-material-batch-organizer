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

fail() { echo "卸载失败：$1" >&2; exit 1; }
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

if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再卸载插件。" >&2
  exit 1
fi
if ! path_present "$TARGET_PATH"; then echo "插件当前未安装：$TARGET_PATH"; exit 0; fi
[[ -d "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || fail "安装目标不是普通插件文件夹，已拒绝移动。"
reject_symlinks "$TARGET_PATH" "安装目标"
[[ -f "$TARGET_PATH/manifest.json" && ! -L "$TARGET_PATH/manifest.json" ]] || fail "安装目标缺少普通 manifest.json，已拒绝移动。"
[[ "$(manifest_value "$TARGET_PATH/manifest.json" id)" == "$PLUGIN_ID" ]] || fail "安装目标属于其他插件，已拒绝移动。"
if path_present "$TARGET_ROOT"; then
  [[ ! -L "$TARGET_ROOT" ]] || fail "安装目标根目录不能是符号链接：$TARGET_ROOT"
fi
mkdir -p "$BACKUP_ROOT"
[[ ! -L "$BACKUP_ROOT" ]] || fail "插件备份根目录不能是符号链接。"
path_present "$BACKUP_PATH" && fail "备份路径已存在，已拒绝覆盖：$BACKUP_PATH"
path_present "$TARGET_PATH" || fail "卸载切换前目标路径已消失，已停止卸载。"
mv "$TARGET_PATH" "$BACKUP_PATH"
RESTORE_SCRIPT="$SCRIPT_DIR/restore-user-plugin-macos.sh"
if [[ -f "$SCRIPT_DIR/恢复-macOS.sh" ]]; then RESTORE_SCRIPT="$SCRIPT_DIR/恢复-macOS.sh"; fi
echo "已卸载：$PLUGIN_ID"
echo "可恢复备份：$BACKUP_PATH"
echo "恢复方式：bash '$RESTORE_SCRIPT' --backup-path '$BACKUP_PATH' --target-root '$TARGET_ROOT'"
