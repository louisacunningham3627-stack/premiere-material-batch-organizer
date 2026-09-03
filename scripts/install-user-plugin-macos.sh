#!/bin/bash
set -euo pipefail

PLUGIN_ID="com.hechao.premiere.material-batch-organizer"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_PATH="$PROJECT_ROOT/dist"
if [[ -d "$SCRIPT_DIR/plugin" ]]; then BUILD_PATH="$SCRIPT_DIR/plugin"; fi
TARGET_ROOT="${HOME}/Library/Application Support/Adobe/UXP/Plugins/External"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-path) BUILD_PATH="$2"; shift 2;;
    --target-root) TARGET_ROOT="$2"; shift 2;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done

TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
UXP_ROOT="$(dirname "$(dirname "$TARGET_ROOT")")"
STAGING_ROOT="$UXP_ROOT/PluginStaging"
BACKUP_ROOT="$UXP_ROOT/PluginBackups"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(uuidgen | tr -d '-' | cut -c1-8)"
STAGING_PATH="$STAGING_ROOT/${PLUGIN_ID}-${RUN_ID}"
BACKUP_PATH="$BACKUP_ROOT/${PLUGIN_ID}-before-${RUN_ID}"
FAILED_PATH="$BACKUP_ROOT/${PLUGIN_ID}-failed-${RUN_ID}"

if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再安装插件。" >&2
  exit 1
fi
[[ -d "$BUILD_PATH" ]] || { echo "找不到构建目录：$BUILD_PATH，请先运行 npm run check。" >&2; exit 1; }
[[ -f "$BUILD_PATH/manifest.json" ]] || { echo "找不到插件清单：$BUILD_PATH/manifest.json" >&2; exit 1; }
[[ "$(plutil -extract id raw -o - "$BUILD_PATH/manifest.json" 2>/dev/null)" == "$PLUGIN_ID" ]] || { echo "插件清单身份不正确，已拒绝安装。" >&2; exit 1; }
[[ "$(plutil -extract host.app raw -o - "$BUILD_PATH/manifest.json" 2>/dev/null)" == "premierepro" ]] || { echo "插件清单宿主不正确，已拒绝安装。" >&2; exit 1; }

if [[ -e "$TARGET_PATH" ]]; then
  [[ -d "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || { echo "安装目标不是普通插件文件夹，已拒绝覆盖：$TARGET_PATH" >&2; exit 1; }
  [[ -f "$TARGET_PATH/manifest.json" ]] || { echo "安装目标缺少 manifest.json，已拒绝覆盖。" >&2; exit 1; }
  [[ "$(plutil -extract id raw -o - "$TARGET_PATH/manifest.json" 2>/dev/null)" == "$PLUGIN_ID" ]] || { echo "安装目标属于其他插件，已拒绝覆盖。" >&2; exit 1; }
fi

if [[ -f "$SCRIPT_DIR/SHA256SUMS.txt" ]]; then
  while read -r expected relative; do
    [[ -n "${expected:-}" && -n "${relative:-}" ]] || continue
    [[ "$relative" == plugin/* ]] || continue
    actual="$(shasum -a 256 -- "$SCRIPT_DIR/$relative" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || { echo "安装包内 plugin/ SHA-256 校验失败：$relative" >&2; exit 1; }
  done < "$SCRIPT_DIR/SHA256SUMS.txt"
fi

inventory() {
  local root="$1"
  (cd "$root" && find . -type f -print | sort | while IFS= read -r file; do
    rel="${file#./}"
    shasum -a 256 -- "$rel" | awk -v rel="$rel" '{print $1"  "rel}'
  done)
}

mkdir -p "$TARGET_ROOT" "$STAGING_ROOT" "$BACKUP_ROOT"
mkdir "$STAGING_PATH"
ditto "$BUILD_PATH/." "$STAGING_PATH/"
if ! diff -u <(inventory "$BUILD_PATH") <(inventory "$STAGING_PATH") >/dev/null; then
  echo "暂存插件 SHA-256 校验失败，现场已保留：$STAGING_PATH" >&2
  exit 1
fi

previous_moved=0
new_moved=0
rollback() {
  local status=$?
  if [[ "$status" -eq 0 ]]; then return; fi
  if [[ "$new_moved" -eq 1 && -e "$TARGET_PATH" ]]; then mv "$TARGET_PATH" "$FAILED_PATH" || true; fi
  if [[ "$previous_moved" -eq 1 && -e "$BACKUP_PATH" && ! -e "$TARGET_PATH" ]]; then mv "$BACKUP_PATH" "$TARGET_PATH" || true; fi
  echo "安装失败，旧版保留在：$BACKUP_PATH；失败新版本保留在：$FAILED_PATH" >&2
}
trap rollback EXIT

if [[ -e "$TARGET_PATH" ]]; then mv "$TARGET_PATH" "$BACKUP_PATH"; previous_moved=1; fi
mv "$STAGING_PATH" "$TARGET_PATH"; new_moved=1
diff -u <(inventory "$BUILD_PATH") <(inventory "$TARGET_PATH") >/dev/null || { echo "安装后 SHA-256 校验失败。" >&2; exit 1; }

trap - EXIT
echo "已安装：$PLUGIN_ID"
echo "安装路径：$TARGET_PATH"
[[ "$previous_moved" -eq 1 ]] && echo "旧版备份：$BACKUP_PATH"
echo "请启动 Premiere，在【窗口 > UXP 插件】中打开【赫朝素材自动整理】。"
