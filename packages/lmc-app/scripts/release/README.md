# Web 发布

脚本保存在仓库中，避免 `/tmp` 被系统清理后丢失发布流程。以下命令从仓库根目录运行，发布前先完成本次变更要求的测试。

## 导出 → 发布 → 校验

```bash
# 1. 导出；已有输出目录会改名保留。
bash packages/lmc-app/scripts/release/export-web.sh

# 2. 发布；请使用本次实际分配的标记。
python3 packages/lmc-app/scripts/release/publish-web.py --marker lmc-redesign-20260908-v129

# 3. 从线上验证标记（替换为本次标记及实际站点）。
WEB_URL="$LMC_WEBAPP_URL"   # 你的自托管站点
MARKER='lmc-redesign-20260908-v129'
curl --fail --silent --show-error -H 'Cache-Control: no-cache' "$WEB_URL/?release=$MARKER" \
  | grep -F "<meta name=\"lmc-release\" content=\"$MARKER\" />"
# 再对首页引用的图标和 /_expo/ 资源逐个检查 HTTP 状态，例：
curl --fail --silent --show-error -I "$WEB_URL/favicon.ico"
```

标记格式为 `lmc-redesign-20260908-v<N>`，在最近已发布标记的基础上递增末尾数字；示例 `v129` 不是每次固定使用的值。沿用该发布系列的前缀，不因执行日期变化而重置序号。标记通过参数传入，不再编辑脚本常量。

默认构建目录为 `/tmp/lmc-redesign-web-20260908`，live 目录取自 `$LMC_WEB_GATE_DIR`（未设置时必须用 `--live-dir` 指定）。覆盖目录时，两步使用同一构建路径：

```bash
bash packages/lmc-app/scripts/release/export-web.sh --out /path/to/web-build
python3 packages/lmc-app/scripts/release/publish-web.py \
  --marker lmc-redesign-20260908-v130 \
  --build-dir /path/to/web-build --live-dir /path/to/web-gate
```

## 保留旧产物

导出目录存在时，脚本通过 `mv` 将其改名为 `<dir>.old-<epoch 秒>`。不用 `rm -rf`，既保留可检查的旧产物，也避开执行器对强制删除命令的限制。目录归档不等于已完成备份清理，旧目录的后续清理由 Owner 另行安排。

发布脚本保留旧首页的 icon/apple-touch-icon 链接，检查资源存在和同名资产内容一致，备份为 `index.previous-<毫秒时间戳>.html`，先复制资产，最后原子替换首页。保留旧哈希资产，避免已打开的页面失去资源。发布输出 JSON 中的 `backup` 是本次旧首页备份名；需要回退时，用该备份恢复首页，并保留资产。

## 导出环境与路径

`export-web.sh` 从脚本自身位置推导仓库和 App 的绝对路径，再进入 App 目录；不依赖调用者的工作目录。它明确调用仓库根目录 `node_modules/.bin/expo` 的绝对路径。曾因相对路径从错误 cwd 解析而跑到 `~/.happy/webapp-local` 的旧 Expo，报 `WebSocketServer is not a constructor`，因此不要改成裸 `expo` 或按调用者 cwd 拼接路径。

导出固定使用 `APP_ENV=production`、`EXPO_PUBLIC_DISABLE_ANALYTICS=1` 和 `--max-workers 2`，并通过 `env -u` 清除 `LMC_SERVER_URL`、`LMC_HOME_DIR`、`LMC_WEBAPP_URL`，避免本机开发配置进入产物。PATH 前置 `/opt/homebrew/bin`。`--out` 的相对路径以调用时所在目录为基准；默认路径不变。

## 同名资源哈希不一致怎么办

默认拒绝同名不同内容的资产，且在任何线上写入前检查全部冲突。先比较新旧文件，确认它们确为同一模块，仅因依赖布局变化重新打包而内容不同、文件名未变，才可由发布负责人明确批准替换：

```bash
python3 packages/lmc-app/scripts/release/publish-web.py --marker lmc-redesign-20260908-v130 \
  --allow-replace exact-chunk-filename.js
```

`--allow-replace` 可重复，仅匹配完整文件名，不支持通配符；同一文件名在构建目录中不唯一时拒绝。不要把不同模块撞名或多个文件同时冲突当作普通发布问题：它们应视为构建错误，先核查依赖与构建一致性，重新导出并检查，不能批量放行来消除报错。

替换前将旧资产改名为 `<name>.pre-<marker>-<epoch 纳秒>`，再复制新资产；输出 JSON 的 `replaced` 列出文件及其备份路径。未批准的冲突仍失败。风险是旧标签页在刷新前可能无法懒加载这个分块；有旧文件备份并不能消除这项兼容风险，应告知用户刷新。

手动自测（不进 CI）：`bash packages/lmc-app/scripts/release/selftest-publish-web.sh`。它仅在脚本旁创建两个隔离临时目录，验证拒绝、重复参数、旧资产备份及覆盖，结束后清理自己的夹具，不访问线上或 `/tmp`。

## 依赖有变动后必须先跑一次 export-web.sh 再发版

依赖安装或布局变化后，必须先运行 `export-web.sh`，确认退出 0 且输出 `index.html`，再进行发布。类型检查与单测通过不能代替真实导出。

2026-09-13 的案例：仓库 node_modules 实际软链到 `~/.happy/webapp-local/src` 的共享 hoisted 布局；Expo 缺少局部 ws 8，回落到顶层 ws 7.5.10，导致 `WebSocketServer is not a constructor`。锁文件中 Expo 的 ws 版本没有变化，使用 Expo 绝对路径也不能解决依赖解析问题；恢复局部 ws 8.19.0 后真实导出才通过。安装后要从 `@expo/cli` 所在目录核对 ws 的实际解析路径、版本与 `WebSocketServer` 导出，不要仅看锁文件。
