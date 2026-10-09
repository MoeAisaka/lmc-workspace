# 引擎无响应、无进展与 macOS 系统权限

原生 Claude 写入 paste + Enter 后，5 秒内既没有新的屏幕输出 revision，也没有原生收件回执，会报告 `unresponsive`。输入已在 PTY 缓冲中，进程恢复后会自行接收并提交。LMC 不重发，也不把它放回队列。如果已有回显但缺少回执，仍报告 `unconfirmed`。部分写入异常同样按未知交付保护，不能据此推断输入没有到达。迟到的精确 `enqueue` 回执可以确认该条引导并解除保护；同一条队列释放回执只发一次。

会话内会显示诊断和下一步。检测到系统授权或安全窗口时，应到运行该引擎的那台 Mac 的屏幕上查看并处理弹窗。此结果表示存在屏上窗口，不能证明弹窗就是冻结原因，也不能知道用户应选择允许还是拒绝。没有检测到窗口也不能排除系统问题：窗口可能在其他桌面、用户登录会话或已隐藏。

Claude 原生回合和 Codex 回合都使用同一套无进展观察。默认 5 分钟没有新输出或运行活动时，发布 `agentState.engineDiagnostics.noProgress`，包括 `since`、阈值、观测时间、系统弹窗结果和子进程事实，并发一次会话提示。Claude 观察 PTY 字节、原生 JSONL 的变化和 Hook 活动；Codex 观察引擎事件、审批请求与 stderr 活动，额度查询/心跳回复不计作回合进展。恢复活动或结束回合后清除，旧诊断的迟到结果不能重新覆盖清除状态。

可用 `LMC_NO_PROGRESS_TIMEOUT_MS` 配置阈值（毫秒，至少 1000；无效值回到 300000）。配置到实际启动会话的进程环境中才生效，修改环境不会刷新现有活跃进程。测试可以缩短阈值；正式使用应按工具正常运行时间设置。无进展只陈述观察，不能证明卡死。`toolProcesses.liveCount` 是引擎的非僵尸后代进程数，可能包含工具、MCP 或辅助进程；不能据此判断某个工具的任务完成或内部进度。

诊断不启动模型回合，不发送/重发输入，不终止引擎。会话列表仍沿用原有三态图标，没有新增文字标签。详细说明只放在会话内。

## 探测边界

系统窗口诊断仅在 macOS 支持。每次在独立的 `/usr/bin/osascript -l JavaScript` 子进程里调用 `CGWindowListCopyWindowInfo`，仅查看屏上 `UserNotificationCenter`、`SecurityAgent`、`CoreServicesUIAgent` 的可见窗口，返回所有者和数量，不取窗口标题或屏幕图像。不请求录屏、辅助功能或自动化权限，不访问桌面、文稿、下载、音乐、废纸篓或临时项目目录。

窗口、完全磁盘访问和子进程探测都有 2 秒截止时间，超时只杀新建的探测子进程，并立即返回 `unknown`，不等待被内核阻塞的进程退出。失败、无有效结果或非 macOS 均不能阻塞交付。子进程探测只查询 PID、父 PID 和进程状态，不读取命令行参数。宿主会话和守护进程不执行探测的同步文件/窗口系统调用。

Apple 说明普通窗口元数据可以通过 Core Graphics 查询，窗口名称属于录屏权限保护的信息：[WWDC19 macOS Security](https://developer.apple.com/videos/play/wwdc2019/701/)。

## 完全磁盘访问预防

macOS 按进程的实际启动和责任链判断隐私权限。终端中手动启动的 Claude/Codex 可以具有终端的授权环境，GUI/launchd 守护进程启动的引擎未必具有相同权限。只给终端授权，不能保证后台 Agent 子进程访问受保护目录时不出现新的系统弹窗。系统弹窗没人处理时，同步文件调用可能长期等待，而远端仍能收到 LMC 心跳。

守护进程启动后，非阻塞地发布 `machine.metadata.systemDiagnostics.fullDiskAccess`，每分钟刷新。探测子进程只以只读、禁止跟随最终符号链接的方式打开并关闭用户 TCC 数据库哨兵；不读取其内容、不查询授权记录，不复制任何身份、密钥或设置。

| 状态 | 含义 |
| --- | --- |
| `readable` | 当前 Agent 探测责任链可以打开哨兵，属于经验性能力观察 |
| `denied` / `EPERM` | 此责任链访问被拒绝，应人工核对完全磁盘访问 |
| `unknown` | 超时、路径缺失、其他权限问题或探测失败，不能断言有/没有 FDA |
| `unsupported` | 非 macOS |

macOS 没有公开的完全磁盘访问授权查询 API；哨兵不是官方 API，`readable` 也不证明每个引擎二进制、所有路径和未来启动都已授权。Apple 推荐对实际操作处理权限错误，且提醒数据库权限并非稳定接口：[Apple DTS 说明](https://developer.apple.com/forums/thread/114452)。本检查是避免触发目录弹窗的保守预检，失败一律降级，不遍历更多私人目录寻找阳性结果。

人工授予步骤：

1. 到运行引擎的 Mac，打开“系统设置 → 隐私与安全性 → 完全磁盘访问”。
2. 核对 LMC 守护进程实际使用的可执行文件/责任应用及 Claude、Codex 的实际引擎位置，添加需要授权的项。GUI Agent 与终端的授权要分别核对，不能只根据终端测试结果判断后台权限。不要给无关程序授权。
3. 保存授权后，让已有回合在自然安全边界结束，再按现有刷新流程启动新的会话进程。不要为授权强停活跃回合。
4. 回读机器能力状态，并在自有实验会话核对行为；如果仍为 `unknown`，保留未知状态，按真实错误调查。无需也不应自动修改 TCC 数据库或系统设置。

本改动只提供诊断和可见性。agentMail 收件、可靠重试协议、原生热切模型、服务端、版本发布和生产会话恢复属于范围外。

## 独立实验

在 CLI 包目录执行，仅生成新的 `~/.lmc/switch-lab/native-freeze-*` 会话：

```sh
export PATH=/opt/homebrew/bin:$PATH
env -u HAPPY_RECONNECT_SESSION_ID -u HAPPY_RECONNECT_ENCRYPTION_KEY -u HAPPY_RECONNECT_ENCRYPTION_VARIANT \
  node scripts/switch-lab/e2e-native-freeze.mjs
env -u HAPPY_RECONNECT_SESSION_ID -u HAPPY_RECONNECT_ENCRYPTION_KEY -u HAPPY_RECONNECT_ENCRYPTION_VARIANT \
  node scripts/switch-lab/e2e-native-freeze.mjs --normal
```

实验先确认新 LMC PID、原生子进程、唯一工作目录和新 provider ID，再仅对自己的原生子进程执行 SIGSTOP/SIGCONT。失败清理始终恢复被本次实验暂停的引擎并释放自己的 HTTP 工具，不强停进程。实验不枚举账号会话，不读 `sessions.json`，不复制凭据，不触发真实权限弹窗，不使用 `/model`、`/effort`，不改全局 Claude 设置。输出不含授权 token 或会话加密密钥。
