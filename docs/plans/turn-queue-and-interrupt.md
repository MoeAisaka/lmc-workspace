# 生成中的插队与排队

会话正在生成时，用户发出的新消息应当能**排队**（等本轮结束再处理）或**插队**（立即
处理）。本文先记录代码里已经存在的机制——它比直觉多得多——再列出真正要定的取舍。

## 现状：后端已有排队，前端看不见

| 环节 | Claude Code | Codex |
|---|---|---|
| 生成中收到新消息 | 进 `MessageQueue2`（`claudeRemoteLauncher.ts:485`） | 先试 `turn/steer` 注入当前回合；不满足条件则进 `MessageQueue2`（`runCodex.ts:408-440`） |
| 队列如何消费 | 本轮结束后，**同模式的排队消息用 `\n` 合并成一条提示**，作为下一轮（`MessageQueue2.collectBatch`） | 同上 |
| 真正的回合中注入 | **无**。Claude Agent SDK 没有 steer 接口 | **有**：`turn/steer`，条件是设置未变、无附件、非斜杠命令、队列为空 |
| 中断当前回合 | `abort` RPC → `doAbort()`（`claudeRemoteLauncher.ts:99`）；**队列在中断后仍保留** | `turn/interrupt`（`codexAppServerClient.ts:1295`） |
| 队列长度上报给 App | **没有**。只在刷新等待原因里用（`等 N 条排队消息`） | 同样没有；只有 `emitReadyIfIdle` 内部用 |
| App 侧提示 | 无 | 一条聊天内事件：「回复已排队，将在当前轮次结束后发送…」 |

App 的输入框已经做了一半：`agentInputPrimaryAction.ts` 里，**生成中只要开始输入，主按钮就从
Stop 变成 Send**，注释写明"so the next message can be queued without aborting work"。
`blockSend` 只对不宣告 `steering` 能力的 Rig 会话生效。

所以今天的真实行为是：**生成中按发送 = 排队**，但用户既不知道消息在排队、不知道排在第几、
不知道它会和别的消息合并成一轮，也撤不回。"插队"则只能靠先按 Stop 再发——没人知道这条路。

## 要定的三件事

### 一、"插队"是哪种语义

| | 补充（steer） | 打断（interrupt） |
|---|---|---|
| 含义 | 把新消息塞进正在进行的回合，当前工作不停 | 中止当前回合，新消息立刻作为下一轮，排在队列最前 |
| Claude | **做不到**——SDK 无此接口 | 可以：`abort` 后把消息 `unshift` 到队首 |
| Codex | 可以：`turn/steer`（今天已在悄悄做） | 可以：`turn/interrupt` 后 `unshift` |
| 用户预期 | "顺便说一句，别停" | "别做了，改做这个" |

**建议**：把「插队」定义为**打断**——两个引擎行为一致，语义也最贴近字面。Codex 的 steer
保留为一种自动优化（满足条件时不打断、直接注入），并在 UI 上如实标注"已补充进当前回合"，
而不是把它冒充成插队。

### 二、"排队"是合并还是逐轮

今天是**合并**：同模式的排队消息拼成一条。省回合、但用户分不清哪句回复对应哪条消息。

| | 合并（现状） | 逐轮 |
|---|---|---|
| 改动 | CLI 零改动 | `collectBatch` 改为每次只取一条 |
| 体验 | 快；回复混在一起 | 慢；一问一答清楚 |
| 风险 | 无 | 引擎侧每轮开销叠加；hub 派单场景回合数翻倍 |

**建议**：保留合并，但 UI 必须**如实显示**"这 N 条将合并为下一轮"。要逐轮的话作为会话
级开关，不做默认。

### 三、UI 放在哪

记忆里的密度原则：列表只留必要状态、用已有三态图标、**不显示可数出来的计数**。

**建议形态**：
- **对话流内**：排队中的用户消息渲染为"等待"态（复用现有三态图标），不加文字标签。
  多条排队消息之间用一条细分隔线提示"以下合并为一轮"。
- **每条排队消息**可操作：撤回（从队列移除）、置顶（= 插队）。桌面端悬停出现，手机端长按。
- **输入框主按钮**：生成中且有内容时，主动作仍是「发送=排队」；**长按 / 分裂按钮**给出
  「插队」。空内容时维持 Stop。
- **不做**：队列条、计数徽章、独立的队列面板。

## 各层改动

**wire**：`MessageMetaSchema` 加 `intent?: 'queue' | 'interrupt'`；`agentState` 加
`queue?: Array<{ localKey: string; preview: string }>`（App 靠 `localKey` 对齐自己发出的消息）。

**CLI**（两引擎各一份）：
1. 每次队列变化，把 `queue` 写进 agentState 上报
2. 新 RPC `dequeue({ localKey })`
3. `meta.intent === 'interrupt'`：中断当前回合 → 消息 `unshift` 到队首。Codex 在满足
   steer 条件时可先试 steer，成功则发事件"已补充进当前回合"

**App**：
1. `SendMessageOptions` 加 `intent`
2. 输入框：生成中的分裂/长按「插队」
3. 对话流：按 `agentState.queue` 给自己的消息打"等待"态，挂撤回/置顶
4. 撤回 → `dequeue`；置顶 → 重发同一 `localKey` 带 `intent: 'interrupt'`

**兼容**：`intent` 缺省即今天的行为；老 CLI 忽略未知 meta；`queue` 缺省时 App 不渲染等待态。
先读后写，和其它协议改动同一原则。

## 已定（2026-09-16，老大）

| 取舍 | 决定 | 对实现的含义 |
|---|---|---|
| 插队语义 | **补充与打断都做成显式按钮** | `intent: 'steer' \| 'interrupt'`。Claude 上「补充」灰掉（SDK 无 steer），并在 UI 上说明原因；Codex 两者都可用。不做"自动降级"——用户点了哪个就是哪个 |
| 排队语义 | **合并为默认，逐轮做会话开关** | `collectBatch` 支持两种模式；开关走 `configure-session`，落在 session configuration 里，随会话持久 |
| UI 形态 | **输入框上方队列条** | 一条横向列表，每条待发消息带 ✕（撤回）和 ↑（置顶=打断插队）；空队列时不占位 |

三个决定里有一处与密度原则有张力：队列条会常驻计数。处理方式是**只在队列非空时出现**，
且不显示数字、只列条目本身——列表就是计数。

## 已实现的契约（后端，2026-09-16）

以下是代码里实际落下的形状，App 接入以此为准。

**消息 meta**（`lmc-wire/src/messageMeta.ts`、CLI `api/types.ts`、App `typesMessageMeta.ts`）
`intent?: 'queue' | 'steer' | 'interrupt'`。App 发送时同时把 `localKey`（= 本地消息 id）
写进密文记录（`sync.ts` 的 `sendMessage`），CLI 用它做队列条目的 key。

| intent | Claude Code | Codex |
|---|---|---|
| 缺省（老 App） | 排队 | 满足条件时 steer（今天的行为），否则排队并发"已排队"事件 |
| `queue` | 排队 | 排队，**绝不** steer |
| `steer` | 排队 + 事件"Claude 无法补充进当前回合，已排队" | 满足条件 steer；否则排队 + 事件说明原因 |
| `interrupt` | `unshift` 到队首；引擎忙则 `abort()`，事件"已打断当前回合" | 同左，走 `handleAbort()`（含 3 秒强制重启兜底） |

steer 的条件不变：设置未变、非 hub 角色切换、队列为空、无附件、非斜杠命令。

**agentState.queue**（CLI `AgentState`、App `AgentStateSchema`）
`Array<{ key: string; preview: string; createdAt: number }>`，队列每次变化都整体上报；
空队列时字段缺省。`preview` 是单行、最长 120 字的摘录。`key` 是 App 的 `localKey`，
没有 `localKey` 的消息（hub 派单、agent mail、`/goal` 之类内部命令）由 CLI 自造 uuid。
进程启动时先清一次，避免上个进程崩溃留下的幽灵条目。

**RPC**（两引擎都注册，`utils/sessionQueueControl.ts`）
- `dequeue { key }` → `{ removed: boolean }`。false = 已经交给引擎了，撤不回
- `promote { key }` → `{ promoted, interrupted }`。置顶；引擎忙则同时打断当前回合。
  App 的「↑」按钮走这个，**不要**重发消息（会在记录里出现两条）

**逐轮开关**（`configure-session`）
`{ queueMode: 'batch' | 'sequential' }`，只能单独发，返回 `{ status: 'applied' }`，
立即生效不需要重启；落在 metadata `queueMode`，重启/刷新后由 CLI 读回。
App 的 `MetadataSchema` 已声明该字段。

**队列实现**（`utils/MessageQueue2.ts`）
条目带 `key`/`createdAt`；`removeByKey`、`promote`、`snapshot`、`setOnChange`、
`setQueueMode`；`unshift` 现在也接受附件与 key；`sequential` 模式下 `collectBatch`
每次只取一条。

## 顺序

1. ~~定上面三件事~~ 已定
2. ~~**wire + CLI**（队列上报、`dequeue`、`intent`、逐轮开关）~~ 已完成，见上
3. ~~**Figma 出稿**~~ 已出：D14 `node-id=97-1183`（四列：Codex 排两条 / Claude 补充灰掉 / 队列空 / 手机长按菜单），等验收
4. App 接入：`sendMessage` 已能带 `intent`；剩队列条组件、`agentState.queue` 的读取、
   `dequeue`/`promote` 调用、会话设置里的逐轮开关
