#!/bin/bash
set -euo pipefail

PLUGIN_ID="com.hechao.premiere.material-batch-organizer"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_PATH="$PROJECT_ROOT/dist"
PACKAGE_MODE=0
if [[ -d "$SCRIPT_DIR/plugin" || -L "$SCRIPT_DIR/plugin" ]]; then
  BUILD_PATH="$SCRIPT_DIR/plugin"
  PACKAGE_MODE=1
fi
BUILD_PATH_OVERRIDDEN=0
TARGET_ROOT="${HOME}/Library/Application Support/Adobe/UXP/Plugins/External"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-path) BUILD_PATH="$2"; BUILD_PATH_OVERRIDDEN=1; shift 2;;
    --target-root) TARGET_ROOT="$2"; shift 2;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done

fail() { echo "安装失败：$1" >&2; exit 1; }
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
  [[ -d "$plugin_path" && ! -L "$plugin_path" ]] || fail "$label 不是普通插件文件夹：$plugin_path"
  reject_symlinks "$plugin_path" "$label"
  [[ -f "$plugin_path/manifest.json" && ! -L "$plugin_path/manifest.json" ]] || fail "$label 缺少普通 manifest.json。"
  [[ "$(manifest_value "$plugin_path/manifest.json" id)" == "$PLUGIN_ID" ]] || fail "$label 属于其他插件。"
  [[ "$(manifest_value "$plugin_path/manifest.json" host.app)" == "premierepro" ]] || fail "$label 不是 Premiere Pro 插件。"
  local plugin_version
  plugin_version="$(manifest_value "$plugin_path/manifest.json" version)" || fail "无法读取$label的版本号。"
  [[ -n "$plugin_version" ]] || fail "$label 缺少版本号。"
}

[[ "$PACKAGE_MODE" -eq 0 || "$BUILD_PATH_OVERRIDDEN" -eq 0 ]] || fail "自包含安装包不允许改用外部构建目录。"
while [[ "$TARGET_ROOT" != "/" && "$TARGET_ROOT" == */ ]]; do TARGET_ROOT="${TARGET_ROOT%/}"; done
case "$TARGET_ROOT" in
  ""|/|.|*//*|*/./*|*/../*|*/.|*/..) fail "安装目标根目录过宽或包含不安全路径段，已拒绝：$TARGET_ROOT";;
  /*) ;;
  *) fail "安装目标根目录必须是绝对路径：$TARGET_ROOT";;
esac
TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
UXP_ROOT="$(dirname "$(dirname "$TARGET_ROOT")")"
STAGING_ROOT="$UXP_ROOT/PluginStaging"
BACKUP_ROOT="$UXP_ROOT/PluginBackups"
[[ -n "$UXP_ROOT" && "$UXP_ROOT" != "/" && "$UXP_ROOT" != "." ]] || fail "无法从安装目标安全派生暂存与备份目录。"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(make_run_suffix)"
STAGING_PATH="$STAGING_ROOT/${PLUGIN_ID}-${RUN_ID}"
BACKUP_PATH="$BACKUP_ROOT/${PLUGIN_ID}-before-${RUN_ID}"
FAILED_PATH="$BACKUP_ROOT/${PLUGIN_ID}-failed-${RUN_ID}"

if /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro 正在运行。请先保存工程并正常关闭 Premiere，再安装插件。" >&2
  exit 1
fi
[[ -d "$BUILD_PATH" ]] || fail "找不到构建目录：$BUILD_PATH，请先运行 npm run check。"
reject_symlinks "$BUILD_PATH" "构建目录"
[[ -f "$BUILD_PATH/manifest.json" && ! -L "$BUILD_PATH/manifest.json" ]] || fail "找不到普通插件清单：$BUILD_PATH/manifest.json"
[[ "$(manifest_value "$BUILD_PATH/manifest.json" id)" == "$PLUGIN_ID" ]] || fail "插件清单身份不正确，已拒绝安装。"
[[ "$(manifest_value "$BUILD_PATH/manifest.json" host.app)" == "premierepro" ]] || fail "插件清单宿主不正确，已拒绝安装。"
VERSION="$(manifest_value "$BUILD_PATH/manifest.json" version)" || fail "无法解析插件清单版本。"
[[ -n "$VERSION" ]] || fail "插件清单缺少版本号。"
if [[ "$PACKAGE_MODE" -eq 0 ]]; then
  [[ -f "$PROJECT_ROOT/package.json" && ! -L "$PROJECT_ROOT/package.json" ]] || fail "源码仓库缺少普通 package.json。"
  EXPECTED_VERSION="$(manifest_value "$PROJECT_ROOT/package.json" version)" || fail "无法解析 package.json 版本。"
  [[ "$VERSION" == "$EXPECTED_VERSION" ]] || fail "构建版本 $VERSION 与项目版本 $EXPECTED_VERSION 不一致，请先重新构建。"
fi

if path_present "$TARGET_PATH"; then
  validate_plugin_directory "$TARGET_PATH" "既有安装目标"
fi

verify_package_checksums() {
  local checksum_file="$SCRIPT_DIR/SHA256SUMS.txt"
  if ! path_present "$checksum_file"; then
    [[ "$PACKAGE_MODE" -eq 0 ]] || fail "自包含安装包缺少 SHA256SUMS.txt，已拒绝安装。"
    return 0
  fi
  [[ -f "$checksum_file" && ! -L "$checksum_file" ]] || fail "SHA-256 清单必须是普通文件。"
  reject_symlinks "$SCRIPT_DIR" "安装包"

  local listed_paths=""
  local package_file_count=0
  local checksum_line expected_hash relative_path actual_hash
  while IFS= read -r checksum_line || [[ -n "$checksum_line" ]]; do
    [[ -z "$checksum_line" ]] && continue
    expected_hash="$(printf '%s\n' "$checksum_line" | awk '{ print $1 }')"
    relative_path="$(printf '%s\n' "$checksum_line" | cut -c 67-)"
    [[ "$checksum_line" == "$expected_hash  $relative_path" ]] || fail "安装包 SHA-256 清单格式不正确。"
    [[ "$expected_hash" =~ ^[0-9A-Fa-f]{64}$ ]] || fail "安装包 SHA-256 哈希格式不正确。"
    case "$relative_path" in
      ""|/*|\\*|.|..|./*|../*|*/.|*/..|*/./*|*/../*) fail "安装包 SHA-256 清单包含不安全路径：$relative_path";;
    esac
    [[ "$relative_path" != *\\* ]] || fail "安装包 SHA-256 清单不能使用反斜杠路径：$relative_path"
    [[ ! "$relative_path" =~ ^[A-Za-z]:[\\/] ]] || fail "安装包 SHA-256 清单包含绝对路径：$relative_path"
    [[ "$relative_path" != *"//"* ]] || fail "安装包 SHA-256 清单包含不安全路径：$relative_path"
    [[ -f "$SCRIPT_DIR/$relative_path" && ! -L "$SCRIPT_DIR/$relative_path" ]] || fail "安装包 SHA-256 清单指向缺失文件或符号链接：$relative_path"
    case $'\n'"$listed_paths" in
      *$'\n'"$relative_path"$'\n'*) fail "安装包 SHA-256 清单存在重复文件：$relative_path";;
    esac
    actual_hash="$(shasum -a 256 -- "$SCRIPT_DIR/$relative_path" | awk '{ print $1 }')"
    [[ "$actual_hash" == "$expected_hash" ]] || fail "安装包文件 SHA-256 校验失败：$relative_path"
    listed_paths="$listed_paths$relative_path"$'\n'
    package_file_count=$((package_file_count + 1))
  done < "$checksum_file"
  [[ "$package_file_count" -gt 0 ]] || fail "安装包 SHA-256 清单不能为空。"

  local actual_path actual_file_count=0
  while IFS= read -r actual_path || [[ -n "$actual_path" ]]; do
    actual_path="$(printf '%s' "$actual_path" | sed 's#^\./##')"
    case $'\n'"$listed_paths" in
      *$'\n'"$actual_path"$'\n'*) ;;
      *) fail "安装包普通文件未列入 SHA-256 清单：$actual_path";;
    esac
    actual_file_count=$((actual_file_count + 1))
  done < <(cd "$SCRIPT_DIR" && find . -type f ! -path './SHA256SUMS.txt' -print | LC_ALL=C sort)
  [[ "$actual_file_count" -eq "$package_file_count" ]] || fail "SHA-256 清单没有完整覆盖安装包普通文件。"
}

verify_package_checksums

inventory() {
  local root="$1"
  (cd "$root" && find . -type f -print | sort | while IFS= read -r file; do
    rel="${file#./}"
    shasum -a 256 -- "$rel" | awk -v rel="$rel" '{print $1"  "rel}'
  done)
}

if path_present "$TARGET_ROOT"; then
  [[ ! -L "$TARGET_ROOT" ]] || fail "安装目标根目录不能是符号链接：$TARGET_ROOT"
fi
mkdir -p "$TARGET_ROOT" "$STAGING_ROOT" "$BACKUP_ROOT"
[[ -d "$TARGET_ROOT" && ! -L "$TARGET_ROOT" ]] || fail "安装目标根目录必须是普通文件夹。"
[[ -d "$STAGING_ROOT" && ! -L "$STAGING_ROOT" && -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || fail "插件暂存或备份根目录必须是普通文件夹。"
path_present "$STAGING_PATH" && fail "暂存路径已存在，已拒绝覆盖：$STAGING_PATH"
path_present "$BACKUP_PATH" && fail "备份路径已存在，已拒绝覆盖：$BACKUP_PATH"
path_present "$FAILED_PATH" && fail "失败备份路径已存在，已拒绝覆盖：$FAILED_PATH"
mkdir "$STAGING_PATH"
if ! ditto "$BUILD_PATH/." "$STAGING_PATH/"; then
  fail "无法复制插件到暂存目录，现场已保留：$STAGING_PATH"
fi
reject_symlinks "$STAGING_PATH" "暂存目录"
if ! diff -u <(inventory "$BUILD_PATH") <(inventory "$STAGING_PATH") >/dev/null; then
  echo "暂存插件 SHA-256 校验失败，现场已保留：$STAGING_PATH" >&2
  exit 1
fi

previous_moved=0
new_moved=0
rollback() {
  local status=$?
  if [[ "$status" -eq 0 ]]; then return; fi
  if [[ "$new_moved" -eq 1 ]] && path_present "$TARGET_PATH"; then
    if ! path_present "$FAILED_PATH"; then mv "$TARGET_PATH" "$FAILED_PATH" || true; fi
  fi
  if [[ "$previous_moved" -eq 1 ]] && path_present "$BACKUP_PATH" && ! path_present "$TARGET_PATH"; then mv "$BACKUP_PATH" "$TARGET_PATH" || true; fi
  echo "安装失败，旧版保留在：$BACKUP_PATH；失败新版本保留在：$FAILED_PATH" >&2
}
trap rollback EXIT

path_present "$BACKUP_PATH" && fail "切换前备份路径再次出现，已停止安装：$BACKUP_PATH"
if path_present "$TARGET_PATH"; then
  validate_plugin_directory "$TARGET_PATH" "切换前安装目标"
  path_present "$BACKUP_PATH" && fail "切换前备份路径再次出现，已停止安装：$BACKUP_PATH"
  mv "$TARGET_PATH" "$BACKUP_PATH"
  previous_moved=1
fi
path_present "$TARGET_PATH" && fail "安装切换前目标路径再次出现，已停止安装：$TARGET_PATH"
mv "$STAGING_PATH" "$TARGET_PATH"; new_moved=1
diff -u <(inventory "$BUILD_PATH") <(inventory "$TARGET_PATH") >/dev/null || { echo "安装后 SHA-256 校验失败。" >&2; exit 1; }

trap - EXIT
echo "已安装：$PLUGIN_ID"
echo "安装路径：$TARGET_PATH"
[[ "$previous_moved" -eq 1 ]] && echo "旧版备份：$BACKUP_PATH"
echo "请启动 Premiere，在【窗口 > UXP 插件】中打开【赫朝素材自动整理】。"
