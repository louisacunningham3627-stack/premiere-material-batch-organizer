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
fail() { echo "卸载失败：$1" >&2; exit 1; }
path_present() { [[ -e "$1" || -L "$1" ]]; }
make_run_suffix() {
  local suffix=""
  if command -v uuidgen >/dev/null 2>&1; then
    suffix="$(uuidgen 2>/dev/null | tr -d '-' | cut -c1-8)" || suffix=""
  fi
  [[ -n "$suffix" ]] || suffix="$$-$RANDOM"
  printf '%s' "$suffix"
}
reject_symlinks() {
  local root="$1"
  local label="$2"
  [[ ! -L "$root" ]] || fail "$label 不能是符号链接：$root"
  local link
  link="$(find "$root" -type l -print | LC_ALL=C sed -n '1p')"
  [[ -z "$link" ]] || fail "$label 包含符号链接：$link"
}
PLUTIL_BIN="${PLUTIL_BIN:-$(command -v plutil || true)}"
[[ -x "$PLUTIL_BIN" ]] || fail "找不到 macOS 自带的 plutil，无法安全读取 manifest.json。"
manifest_value() {
  "$PLUTIL_BIN" -extract "$2" raw -o - "$1" 2>/dev/null
}
validate_plugin_directory() {
  local plugin_path="$1"
  local label="$2"
  [[ -d "$plugin_path" && ! -L "$plugin_path" ]] || fail "$label 不是普通插件文件夹。"
  reject_symlinks "$plugin_path" "$label"
  [[ -f "$plugin_path/manifest.json" && ! -L "$plugin_path/manifest.json" ]] || fail "$label 缺少普通 manifest.json。"
  [[ "$(manifest_value "$plugin_path/manifest.json" id)" == "$PLUGIN_ID" ]] || fail "$label 属于其他插件。"
  [[ "$(manifest_value "$plugin_path/manifest.json" host.app)" == "premierepro" ]] || fail "$label 不是 Premiere Pro 插件。"
  local plugin_version
  plugin_version="$(manifest_value "$plugin_path/manifest.json" version)" || fail "无法读取$label的版本号。"
  [[ -n "$plugin_version" ]] || fail "$label 缺少版本号。"
}

case "$TARGET_ROOT" in
  ""|/|.) fail "卸载目标根目录过宽或为空，已拒绝：$TARGET_ROOT";;
  /*) ;;
  *) fail "卸载目标根目录必须是绝对路径：$TARGET_ROOT";;
esac
[[ -n "$UXP_ROOT" && "$UXP_ROOT" != "/" && "$UXP_ROOT" != "." ]] || fail "无法从卸载目标安全派生备份目录。"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(make_run_suffix)"
BACKUP_PATH="$BACKUP_ROOT/${PLUGIN_ID}-uninstalled-${RUN_ID}"

if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再卸载插件。" >&2
  exit 1
fi
if ! path_present "$TARGET_PATH"; then echo "插件当前未安装：$TARGET_PATH"; exit 0; fi
validate_plugin_directory "$TARGET_PATH" "安装目标"
if path_present "$TARGET_ROOT"; then
  [[ ! -L "$TARGET_ROOT" ]] || fail "安装目标根目录不能是符号链接：$TARGET_ROOT"
fi
mkdir -p "$BACKUP_ROOT"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || fail "插件备份根目录必须是普通文件夹。"
path_present "$BACKUP_PATH" && fail "备份路径已存在，已拒绝覆盖：$BACKUP_PATH"
validate_plugin_directory "$TARGET_PATH" "卸载切换前安装目标"
path_present "$BACKUP_PATH" && fail "卸载切换前备份路径再次出现，已停止卸载：$BACKUP_PATH"
mv "$TARGET_PATH" "$BACKUP_PATH"
RESTORE_SCRIPT="$SCRIPT_DIR/restore-user-plugin-macos.sh"
if [[ -f "$SCRIPT_DIR/恢复-macOS.sh" ]]; then RESTORE_SCRIPT="$SCRIPT_DIR/恢复-macOS.sh"; fi
echo "已卸载：$PLUGIN_ID"
echo "可恢复备份：$BACKUP_PATH"
echo "恢复方式：bash '$RESTORE_SCRIPT' --backup-path '$BACKUP_PATH' --target-root '$TARGET_ROOT'"
