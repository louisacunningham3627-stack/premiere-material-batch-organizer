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
  [[ "$(manifest_value "$plugin_path/manifest.json" id)" == "$PLUGIN_ID" ]] || fail "$label 不属于当前插件。"
  [[ "$(manifest_value "$plugin_path/manifest.json" host.app)" == "premierepro" ]] || fail "$label 不是 Premiere Pro 插件。"
  local plugin_version
  plugin_version="$(manifest_value "$plugin_path/manifest.json" version)" || fail "无法读取$label的版本号。"
  [[ -n "$plugin_version" ]] || fail "$label 缺少版本号。"
}
while [[ "$TARGET_ROOT" != "/" && "$TARGET_ROOT" == */ ]]; do TARGET_ROOT="${TARGET_ROOT%/}"; done
case "$TARGET_ROOT" in
  ""|/|.|*//*|*/./*|*/../*|*/.|*/..) fail "恢复目标根目录过宽或包含不安全路径段，已拒绝：$TARGET_ROOT";;
  /*) ;;
  *) fail "恢复目标根目录必须是绝对路径：$TARGET_ROOT";;
esac
path_present "$BACKUP_PATH" || fail "请提供存在的插件备份路径。"
validate_plugin_directory "$BACKUP_PATH" "插件备份"
if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再恢复插件。" >&2
  exit 1
fi
TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
if path_present "$TARGET_ROOT"; then
  [[ ! -L "$TARGET_ROOT" ]] || fail "恢复目标根目录不能是符号链接：$TARGET_ROOT"
fi
! path_present "$TARGET_PATH" || fail "恢复目标已存在，为避免覆盖已拒绝：$TARGET_PATH"
mkdir -p "$TARGET_ROOT"
[[ -d "$TARGET_ROOT" && ! -L "$TARGET_ROOT" ]] || fail "恢复目标根目录必须是普通文件夹。"
validate_plugin_directory "$BACKUP_PATH" "恢复切换前插件备份"
path_present "$TARGET_PATH" && fail "恢复切换前目标路径再次出现，已停止恢复。"
mv "$BACKUP_PATH" "$TARGET_PATH"
validate_plugin_directory "$TARGET_PATH" "恢复结果"
echo "已恢复：$TARGET_PATH"
