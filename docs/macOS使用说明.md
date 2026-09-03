# 赫朝素材自动整理 macOS 版

## 安装

1. 保存工程并完全退出 Premiere Pro。
2. 双击打开本文件所在文件夹，在终端执行：

```bash
cd "本文件夹路径"
chmod +x 安装-macOS.sh
bash 安装-macOS.sh
```

安装脚本默认把本文件夹的 `plugin/` 放到 `~/Library/Application Support/Adobe/UXP/Plugins/External/`。安装完成后启动 Premiere，在“窗口 > UXP 插件”中打开“赫朝素材自动整理”。

## 卸载与恢复

退出 Premiere 后执行 `bash 卸载-macOS.sh`。脚本只移动插件目录到 `PluginBackups`，不会直接删除。

卸载输出的备份路径可用以下命令恢复：

```bash
chmod +x 恢复-macOS.sh
bash 恢复-macOS.sh --backup-path "备份路径"
```

若安装校验失败，旧版会自动回到原安装位置；失败的新版本会留在 `PluginBackups` 供检查。

## 使用与限制

插件只整理开启自动整理之后新导入的单文件素材，不会移动、改名或打包 `.prproj`。`/Users/...` 和 `/Volumes/...` 路径保留大小写。只有源文件和已创建目标目录的 `lstat.dev` 均存在且相同，才使用同卷移动；无法证明时会使用复制事务并在状态中记录实际模式。

macOS Premiere 的真实素材搬运、外置卷权限、重链接和工程保存仍需在临时工程中人工验收，静态包校验不能替代这一步。
