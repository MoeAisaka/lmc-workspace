# 契约面改名迁移方案

代码内部与文案层的 happy→lmc 改名已完成。剩下的是**跨进程、跨版本可见的名字**：
换掉它们不是编辑源码，而是一次迁移。本文按"需不需要迁移窗口"分类，每条都带证据位置。

统一原则，和 metadata 双写一致：**先读后写**。任何一步都不要让新旧两端同时只认自己那套——
解析失败不是降级，客户端会直接从视野里消失。

---

## A 类：已完成（无契约，直接改）

产生方与消费方在同一构建产物里，或生命周期在一个进程 / 一次 CI 内闭合。

| 原名 → 新名 | 位置 | 为什么安全 |
|---|---|---|
| `sandboxManagedByHappy` → `sandboxManagedByLmc` | `lmc-cli/src/codex/executionPolicy.ts` | 函数形参，不出栈 |
| `happy-server-ci` / `happy-standalone-ci` → `lmc-*` | `.github/workflows/server.yml` | 同一 job 内 `docker run --name` 建、`docker rm -f` 删 |
| `happy-app-zoomed` / `--happy-app-zoom` → `lmc-*` | `lmc-app/sources/theme.css`、`hooks/useTauriZoom.ts` | 类名与 CSS 变量都由本 app 写、本 app 读，同一 bundle |


同时订正了一处事实错误：`docs/deployment.md` 原先引用
`packages/lmc-server/deploy/happy-redis.yaml`，**该文件不存在**，资源实际定义在
`deploy/handy.yaml`。资源名 `happy-redis` 是另一回事，见 C1。

**`happy-outline` 不能改**——它是 Ionicons 的图标名（一个笑脸），不是我们的 CSS 类。
曾误判为样式类改掉，被 typecheck 拦下（`TS2820: Did you mean "mic-outline"?`）。
同理 `happy-source` 也不是名字，是 `createSessionMetadata.test.ts` 里 `parentSessionId`
的夹具取值。凡是"看起来像我们的名字"的短横线标识符，先确认它属于谁。

---

## B 类：线上契约，需要双读→切换→下线

### B1 `happyClient` 握手字段与 `x-happy-client` 头

- **写**：`lmc-app/sources/sync/apiSocket.ts:103`、`lmc-cli/src/api/apiMachine.ts:480`、
  `lmc-cli/src/api/apiSession.ts:294`（socket.io `auth.happyClient`）
- **读**：`lmc-server/sources/app/api/socket.ts:123`，回退到 header
  `x-happy-client`（同文件 124 行）；`monitoring/metrics2.ts:30,38`
- **用途**：只喂监控标签（`parseClientLabels`）与事件路由字段，不参与鉴权或业务判断
- **风险**：低。取不到值时 `happyClient` 为 `undefined`，指标少一个维度，功能不受影响

步骤：
1. 服务端改为 `auth.lmcClient ?? auth.happyClient`，header 同样 `x-lmc-client ?? x-happy-client`
2. 服务端上线后，App 与 CLI 改写新名（两端都发新名即可，不必双写）
3. 四台设备都跑上新 CLI、web 发布后，服务端删掉旧名分支

因为它只影响指标，第 3 步可以拖很久，不急。

### B2 `spawn-happy-session` RPC 方法名

- **注册**：`lmc-cli/src/api/apiMachine.ts:169`（daemon 侧 `registerHandler`）
- **调用**：`lmc-app/sources/sync/ops.ts:338`、`lmc-agent/src/machineRpc.ts:96`
  （拼成 `${machine.id}:spawn-happy-session`）
- **文档**：`lmc-cli/src/daemon/CLAUDE.md:25,73,152`
- **风险**：**高**。这是"从 App 在某台机器上起会话"的主路径。老 daemon 只注册旧名，
  新 App 只调新名 → 起不了会话，且报错发生在远端机器上，不易定位

步骤：
1. daemon **同时注册两个名字**指向同一 handler（`spawn-lmc-session` 与
   `spawn-happy-session`），发布到全部设备
2. 确认四台设备的 `lmcCliVersion` 都已是含双注册的版本（核验办法见
   [[lmc-happy-to-lmc-rename]] 记忆里的解密步骤）
3. App 与 lmc-agent 改调新名
4. 观察一个版本周期后，daemon 删掉旧名注册

注意 `lmc-agent` 是**独立包**，可能滞后于 CLI 升级，第 3 步要把它算进去。

### B3 metadata 旧名字段

`happyCliVersion` / `happyHomeDir` / `happyLibDir` / `happyToolsDir`。
双写已完成且四台设备实测通过，下线由 Owner 自行执行。两个已知的坑：

- `lmc-cli/src/api/types.ts:148,151,153` 旧名是 `z.string()` **必填**，新名是
  `.optional()`。只删写入点会直接触发校验失败，必须先对调
- 该 schema **无 passthrough**，未声明的 key 被静默剥掉，所以旧名的**声明**不能删
  （老 CLI 写的记录还要进得来）
- App 侧 `storageTypes.ts:644-647`（机器）与 `:291-292`（会话）有归一化层把新名折回旧名，
  所以 App 内部 6 个消费点仍读旧名。停写旧名**不需要动 App**

---

## C 类：运维动作，不是代码改动

### C1 `happy-redis` k8s 资源

上游的 Kubernetes 清单里把 Redis 的 Service / ConfigMap / StatefulSet 都命名为
`happy-redis`。**这套清单不在公开仓库里**——它部署 Postgres（而 Prisma 是 mysql）、
镜像指向私有 registry，对任何人都跑不通，已随其它上游 k8s 资产一并排除。

我们实际的部署路径（`deploy/lmc/compose.yaml`）**根本不跑 Redis**：它只在需要多进程
扇出时才需要，`socket.ts` 在 `REDIS_URL` 未设置时直接跳过适配器。

所以 C1 **没有东西要改**。保留这一条只为说明：曾以为它是一项待迁移的运维动作，
核查后发现前提不成立。

### C2 `/_happy-auth/login` 路径

`scripts/web-auth/server.mjs:23,25`、`auth.mjs:21`、`auth.test.mjs`。
这是自托管 web 前面的口令网关。

好消息：cookie 是 `Path=/`（`server.mjs:47`），**不绑登录路径**，
所以改路径不会踢掉已登录的人，只影响登录/登出这两个 URL 与任何书签。
风险低，随时可做，记得同步改 `auth.test.mjs` 里的断言。

---

## D 类：永不更改

改了会静默毁数据、破坏兼容，或把上游的东西认领成我们的。

- **deriveKey 三个盐** `'Happy EnCoder'` / `'Happy Coder'` / `'Happy Blobs'`
  —— 改了既有会话数据无法解密，**且不报错**
- **`HAPPY_*` 环境变量**——代码确实在读的那批（`HAPPY_VARIANT`、`HAPPY_EXPERIMENTAL`、
  `HAPPY_DISABLE_CAFFEINATE`、`HAPPY_PROJECT_DIR`、`HAPPY_RECONNECT_*` 等）。
  注意 `LMC_HOME_DIR` / `LMC_SERVER_URL` / `LMC_WEBAPP_URL` 这三个**已经是新名**，
  文档与夹具里的旧名已订正
- **`HAPPY_SYSTEM_BLOCK_OPEN` / `_CLOSE`**——写进会话记录里的标记串
- **MCP 工具名 `mcp__happy__*` 与 server 名 `'happy'`**——协议
- **bin 命令名** `happy.mjs` / `happy-mcp.mjs` / `happy-agent.mjs` / `happy-server.cjs`
- **`codex/happyMcpStdioBridge`**——`package.json` 的公开 `exports` 路径
- **`happySessionId`**——daemon HTTP 响应里被 lmc-agent 读取的跨包契约
- **Happy Agent / Happy Terminal 一族**——上游独立产品，`@slopus/happy-terminal` 是真实依赖
- **doctor 的进程匹配串**、**codium 的 `~/Happy` 路径**——匹配的是真实进程名与真实目录
- **真实 bundle ID** `com.slopus.happy.*` / `com.ex3ndr.happy`、签名身份、
  上游 CI 名 `Lab_HappyServer`
- **dated plans 与发布记录、`docs/competition/`、`docs/upstream/`**——改了等于篡改历史

---

## 建议顺序

1. **A 类**——随手做完，无需协调
2. **C2**（auth 路径）——风险低，独立
3. **B1**（客户端标识）——只影响指标，可以先拿它把"服务端双读→客户端切换"这条流程走一遍
4. **B3**（metadata 下线旧名）——Owner 自己做，前提已满足
5. **B2**（RPC 方法名）——最后做，且必须确认四台设备都升到双注册版本之后
6. **C1**（Redis 资源名）——挑低峰单独做，或者干脆不做：收益纯属整洁

B2 和 C1 收益最小、代价最大。**不做也完全合理**——它们不影响任何用户可见的东西。
