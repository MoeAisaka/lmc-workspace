# DevSpace / LMC 源码对照与 Claude 诊断

范围：源码阅读及 MacBook 只读诊断；未安装 DevSpace，未进行模型调用、登录、凭据迁移或进程重启。
LMC 基线 6c548d0；DevSpace 基线 fb5e2ebbc7234d00fa15e94334d0be94895aac63。

## 可落地清单

| 优先级 | 改进 | LMC 现状与改动位置 | DevSpace 参考 | 验收 |
|---|---|---|---|---|
| P0 | 引擎认证状态独立于设备在线 | Claude 报错尚无统一认证失效状态；新增 authRequired 事件、设备级检查与中文引导，落点 claude/sdk/query.ts、runClaude.ts、api/types.ts、SessionStatusIndicator | local-agent-errors.ts 的结构化 code/operation/retryable 模式（认证分类是 LMC 自己需补的部分） | 未登录时显示“Claude 未登录”，不伪装成工作中、不无限自动重试；登录后重新检查，仅输出状态不输出凭据 |
| P0 | Claude 安全刷新 | useSessionQuickActions.ts 只对 codex 展示；daemon/sessionRefresh.ts 只接受 codex；configure-session RPC 仅注册于 codex/runCodex.ts。需拆出通用刷新协议并在 Claude 轮次安全边界接入 | local-agent-runtime.ts 分离可丢弃运行时与持久 providerSessionId | 空闲刷新保留同一 LMC ID、Claude ID和消息游标；生成/等待决策时排队；身份缺失和认证失败不得停止原进程；重复点击幂等，重连后显示结果 |
| P0 | 按能力显示菜单 | sessionConfiguration boolean 与 flavor 判断混用；sessionConfiguration.ts 的参数校验仍是 Codex 专用 | local-agent-adapters.ts + LocalAgentDriver | 元数据明确区分 refresh、resume、model、effort、context、serviceTier；旧 Agent 禁用并说明原因；Claude 不收到 Codex 专用参数 |
| P0 | 身份、运行时、轮次状态分别维护 | LMC 已有 resume store、daemon tracking、thinking 与错误恢复，应该补跨引擎一致性而非重写；入口 resume/localResumeStore.ts、daemon/run.ts、claude/runClaude.ts、codex/runCodex.ts | local-agent-store.ts、local-agent-runtime.ts、local-agent-runtime-pool.ts | 引擎启动后尽早持久化 providerSessionId；SDK 子进程退出不能因 wrapper 存活仍报正常；断线重连不把进行中/等待用户轮次降成空闲；不复制 DevSpace 较粗的五状态枚举 |
| P1 | 展示实际运行版本与启动来源 | MacBook独立 Claude 2.1.263，LMC SDK内置 Claude 2.1.179；设备安装版本不等于会话进程使用版本 | local-agent-daemon-protocol.ts 的 protocolVersion/activeTurns/runtimeCount | 设备页区分 Agent、引擎、SDK内置版本与会话启动版本；刷新后核验实际版本，不以安装完成冒充会话已更新 |
| P1 | 本轮文件变更审阅 | SessionResourceWindow.tsx 目前从已加载消息收集路径；缺少稳定轮次基线 | review-checkpoints.ts 的 workspace_open/last_shown 与 reviewRef | 支持本轮、上次查看后两种 diff；新增/删除/重命名可看；回收聊天 DOM 不丢资源索引；标为已查看不更改工作区和用户索引；并发会话同目录不能把所有文件修改归因给某个会话 |
| P1 | 统一引擎 Driver 契约 | 保留现有 Codex/Claude 适配实现，抽取健康检查、运行、继续、结束等共同行为 | local-agent-adapters.ts、local-agent-runtime.ts | 两个引擎运行同一套生命周期契约测试；引擎专属能力通过扩展字段保留；优先抽取，不一次性替换运行链路 |
| P2 | 可选 MCP 外部入口 | LMC 的中心+Agent+独立 WebUI继续作为主体 | server.ts、oauth-provider.ts、tool-surfaces | 默认关闭；授权绑定设备/项目，撤销后拒绝操作；明确 shell 不是文件目录沙箱；不增加对第三方认证服务的依赖 |

不照搬：DevSpace 的 SQLite 存储不替换 LMC MySQL；HeadTailBuffer/进程完成 TTL 不替换既定的 C 完成后回收 A 展示内存规则；嵌入工具卡片不替换已确认 Figma 主界面。MIT 代码复用保留相应许可证。

## MacBook 现场证据

SSH 通道可用。2026-09-07，在 yukina 用户 SSH 环境中：
- ~/.local/bin/claude：2.1.263；auth status --json 返回 loggedIn=false、authMethod=none、apiProvider=firstParty，退出码1。
- ~/.lmc/agent-releases/264176f/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude：2.1.179；同样返回未登录。
- 活动 LMC SDK Claude 的父进程 PID 66033；对应 2026-09-06-21-56-44-pid-66033.log 中找到8条 Not logged in 结果。
- 用户级 settings.json、settings.local.json 未配置 env 或 apiKeyHelper；.zshrc/.zprofile未检出 ANTHROPIC/CLAUDE变量赋值。未读取钥匙串密码或token。

可确认：实际失败的引擎没有可用认证，且刷新能力未接入 Claude。不能仅凭这些证据断言 token 过期、被删除，或排除 GUI钥匙串可访问性差异。

恢复步骤：MacBook 本机终端执行 ~/.local/bin/claude auth login，按浏览器流程由用户完成授权。之后分别检查独立 CLI 与 LMC 内置引擎认证状态，再验证原 LMC 会话能否继续。新 CLI 登录成功不等于旧 SDK 内置版本已验证；不强行重启活动会话，也不把网页登录 LMC 与引擎认证混为一谈。

建议实施顺序：先恢复/识别 Claude认证 → 通用能力与安全刷新 → 运行状态一致性及版本诊断 → 文件审阅 → Driver契约 → 可选MCP。
