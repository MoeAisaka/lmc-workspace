# Claude 原生默认与既有会话迁移 · 2026-09-30

## 用户要求与交付

用户纠正了 v231 的手动开启方式：应由 LMC 迁移既有 Claude 会话，新建及恢复的 Mac 会话默认使用原生。仍在聊天框发送普通消息；原生窗口处理终端提示，关闭窗口不结束会话。原生桌面不注入 Peekaboo，保留 Chrome 显式选择。Linux 与启用沙盒的会话继续兼容通道。

最终 Agent **1.2.68**，三机选择版本均已更新；双站 Web **v233**。

- Agent release: `native-default-yn-20260930`
- Agent SHA256: `d25b4cf6e94ac05e201c35c5356ad602170f1b07d9e210078f8ea9da046675bf`
- Web marker: `lmc-redesign-20260908-v233`
- 两站主 bundle SHA256: `f386ae8c4ecc9f0ddaa3a83fa47bc90e15227b17fa85e5e69194ce26b8d4746b`

## 修复与保留能力

LMC 安全刷新附带的 `--resume UUID` 曾被当作不支持的自定义 CLI 参数。现在吸收并校验该参数与既有身份一致；未知或冲突参数仍保留原会话，不忽略限制。

macOS 远程 runner 在上一进程完成安全交接后默认进入原生。模型、effort 等配置在原生真实空闲边界用 `/exit` 和同 UUID 恢复应用，未投递消息保留。空白新会话尚无 JSONL 时使用同一 `--session-id`，避免把不存在的记录当作可恢复记录。权限收紧期间的原生工具请求会阻止旧策略继续执行。

原生安全刷新沿用 SDK 的 incoming cursor、认证及恢复记录预检、daemon reservation 和取消协议。后台作业、未确认投递、终端提示和运行回合均阻止自动退出。原生模式的后台生命周期判断仍保守：发现后台启动但不能确认结束时要求在原生窗口检查 `/tasks`。

原生 PreToolUse / PermissionRequest 桥接既有 PermissionHandler：执行单元的问题与计划按原有主控策略路由，普通原生应用控制提示仍由用户处理。hook 异常或断线不批准工具。输出格式核对 [Claude 官方 hooks 文档](https://code.claude.com/docs/en/hooks)。

既有 `/goal` 状态与动作、自动目标准备逻辑接入原生扫描器；官方 2.1.285 的交互 `/goal` 路径经真实隔离测试验证。队列消费只接受 UserPromptSubmit 或匹配的命令记录，超时不重发。原生 transcript 的 usage 按消息 ID 去重累计，不把 token 数当作订阅额度。

## 迁移发现与处理

不能把 `claudeNativeActive: true` 当作就绪证明。1.2.67 初次迁移后，业务会话停在 Claude 的项目信任提示。其屏幕阅读器模式要求字面 `y/n` 按键，bracketed paste 被忽略；因此 1.2.68 补齐直接按键和 UI 按钮。

只对当前迁移会话、显示路径与既有 metadata.path 完全一致的项目做信任确认。MacBook 的原生完全放行提示仅在 metadata 已经是 `yolo` / `bypassPermissions` 时确认，保留原策略。未批准任何新的桌面应用控制范围。

停在旧版启动信任提示的会话通过 Escape 返回原 runner 的 SDK，再走既有安全刷新接入 1.2.68；没有强杀活动进程。现场第一条恢复先建立了 daemon 交接记录，其余使用 SDK 的标准安全刷新路径。所有恢复保留原 LMC / Claude UUID。

最终只读 RPC 核验：Mac mini 6 个业务会话全部原生就绪；MacBook 6 个全部越过启动确认，其中一个已继续真实业务，其余到达原生输入框。12 个业务会话均为 `sessionConfigState: applied`、最终 Agent hash，且 provider UUID 与迁移前逐一一致。另有隔离探针，不计入这 12 个。Ubuntu 没有活跃 Claude 业务会话，Linux 不宣称有原生 macOS 桌面能力。

## 验证证据

- 53 项相关确定性测试，按变更范围复用：launcher 10、resume 参数 2、native permission bridge 2、native refresh 1、既有 PermissionHandler 14、SafeSessionRefresh 18、terminal relay 6。
- 显式 Agent 1.2.68 构建与最终 App TypeScript 检查退出 0。
- 两台 Mac 的 staged PTY/headless 实际运行通过；1.2.68 未改依赖，复用相同依赖工件的证据。
- 隔离会话 `cmunzyukq0ndj9aq8t6590yp2` 验证默认原生、普通消息、Low → High、同身份安全刷新；`cmuo03eme0nep9aq8aqys7ta6` 验证 `/goal`、目标完成、High 重启与无重复投递。后者 provider UUID 一直为 `647e35a8-5e05-4acc-990d-5f81720a96cb`，之后由正式发行版接管。
- 最终真实导出 UI：320/667/1280 像素 × 浅/深主题，尺寸约束、旧画面拒绝、双击去重、关闭保留进程、断线禁用及恢复通过。工件目录 `/var/folders/3x/8gprgtc53csd80qbgch0syc40000gn/T/lmc-native-ui-check-P93ozj`。
- 两站主 bundle 与本地 v233 导出逐字节相等。
- 最终迁移屏幕审计：`/tmp/lmc-native-yn-mini-screens.jsonl`、`/tmp/lmc-native-yn-macbook-screens.jsonl`；最后单独确认标签中台会话到达输入框。
- 无业务测试消息、无凭据复制、无源仓库 origin 推送、无 .85 生产写入。

## 回退与已知边界

前一稳定发行版 `native-claude-20260930`（Agent 1.2.66）及 catalog 备份保留；回退也必须等真实安全边界。v233 发布前的页面备份为 `index.previous-1790767260115.html`（v232）；原 v231 备份为 `index.previous-1790766601005.html`。

原生窗口关闭不代表退出；“切回兼容模式”作用于当前 runner。桌面应用许可仍需按实际提示授权，先前一次性 Finder 测试授权不能复用。用户接受的 macOS 通知中心透明窗口误判未修复，不宣称完整桌面点击能力已回归通过。
