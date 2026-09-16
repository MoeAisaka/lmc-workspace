# LMC 自托管候选版

基于 Happy 71ec0d7。WebUI 与设备 Agent 连接同一中心，中心使用 MySQL 8.4；不需要 Happy 官方账号或手机 App。此候选版尚未替换现有生产入口。

## 一条命令起中心

需要 Node 22.18+、pnpm 10.11（或 corepack）、Docker Compose。在独立检出目录中，从仓库根目录执行：

```sh
deploy/lmc/up.sh https://your-lmc.example
```

脚本会依次安装依赖、构建 wire 与 Prisma 客户端、导出 Web 包、生成 `.env`、拉起 MySQL、构建中心镜像、执行数据库迁移，首次运行时再交互式创建一个登录账号。之后重复执行同一条命令即为更新：`.env` 不会被覆盖，Web 包先构建到旁边的目录再原子切换，因此构建期间已打开的标签页仍能取到旧资源。

追加账号：

```sh
deploy/lmc/up.sh --add-account
```

停止（保留数据卷）：

```sh
docker compose --env-file deploy/lmc/.env -f deploy/lmc/compose.yaml stop
```

`compose.yaml` 现在包含 MySQL 与中心两个服务，中心用仓库根目录的 `Dockerfile.server` 构建，`restart: unless-stopped`，因此重启机器后会自动恢复。中心在容器内监听 `0.0.0.0`（`LMC_BIND_HOST`），但端口只发布到宿主机的 `127.0.0.1`，仍然不对公网开放；裸机直接运行时 `LMC_BIND_HOST` 默认仍是 `127.0.0.1`。

Web 包在构建时打进镜像（`/srv/web`），运行时数据放在命名卷 `center-data`（`/srv/data`），两者都不使用宿主机 bind mount —— macOS 上 Docker Desktop 只共享部分路径，仓库若放在外置盘等未共享位置，bind mount 会静默挂成空目录，中心就只会返回 404。代价是更新 Web 包必须重建镜像并重启中心，`up.sh` 已经包含这两步。

镜像里只安装服务端及其依赖（`--filter lmc-server... --config.node-linker=isolated`）。仓库 `.npmrc` 为了 App 设了 `node-linker=hoisted`，而 hoisted 安装天然是全工作区的，会把 Anthropic SDK、Skia、Electron、Expo 一起装进镜像；也不要改成多阶段拷贝 `node_modules`，pnpm 的硬链接跨阶段 COPY 会被实体化，几 GB 会膨胀到撑爆磁盘。

**脚本不负责公网访问。** 你需要自备域名、证书和反向代理，把流量转发到 `127.0.0.1:PORT`，并保留 Host、Origin 与 WebSocket Upgrade。`LMC_PUBLIC_ORIGIN` 与 `PUBLIC_URL` 必须是浏览器实际访问的 HTTPS 源（含非默认端口）。数据库不要开放到公网。

端口冲突时，在启动前同时修改 `.env` 的 `LMC_MYSQL_PORT`、`DATABASE_URL` 与 `PORT`。

密码至少 12 位。不提供公开注册接口。账号密码使用 scrypt；持久登录为 HttpOnly/SameSite Cookie；设备授权可以在账号页撤销。账号加密密钥由自托管中心用 `LMC_MASTER_KEY` 加密保存，因此中心管理员属于信任边界。备份数据库时必须另行安全保管该主密钥，不能丢失或随意轮换。

### 手工步骤（排查或裸机运行时）

`up.sh` 等价于下面这串命令；只在需要单独排查某一步，或不想让中心跑在容器里时才手工执行。

```sh
pnpm install --frozen-lockfile
pnpm --filter @lmc/wire build
pnpm --filter lmc-server generate
pnpm --filter link-my-cli typecheck
pnpm --filter link-my-cli exec pkgroll
pnpm --filter lmc-app exec tsc --noEmit
APP_ENV=production EXPO_PUBLIC_DISABLE_ANALYTICS=1 pnpm --filter lmc-app exec expo export --platform web --output-dir ../../deploy/lmc/web --max-workers 2
node deploy/lmc/init.mjs deploy/lmc https://your-lmc.example
docker compose --env-file deploy/lmc/.env -f deploy/lmc/compose.yaml up -d --wait mysql
cd packages/lmc-server
node --env-file=../../deploy/lmc/.env ../../node_modules/prisma/build/index.js migrate deploy
node --env-file=../../deploy/lmc/.env --import tsx sources/lmc/setup.ts
# 上一条命令从标准输入读取 {"username":"...","password":"..."}，完成输入后发送 EOF。
node --env-file=../../deploy/lmc/.env --import tsx sources/lmc/main.ts
```

初始化只创建新的 `.env`，若已有文件会拒绝覆盖。

## 设备 Agent

包提供 `lmc` 命令，但请使用独立目录，避免全局安装覆盖已有 Happy。直接从检出目录运行 `node packages/lmc-cli/bin/happy.mjs` 即可；也可仅为这个文件建立名为 `lmc` 的独立入口。不要将整套候选 bin 目录置于生产 Happy 命令之前。

```sh
export LMC_HOME_DIR="$HOME/.lmc/agent"
export LMC_SERVER_URL="https://your-lmc.example"
export LMC_WEBAPP_URL="$LMC_SERVER_URL"
lmc auth login
lmc daemon start
# 或直接启动引擎
lmc codex
lmc claude
```

在浏览器登录并批准 CLI 打开的链接。也可在账号设置中粘贴同一中心的配对链接。不要复制 Happy 的 access.key、settings.json、设备身份或私人会话目录。其他引擎适配接口保留。

## 更新与回退

重复执行 `deploy/lmc/up.sh <同一个源>` 即可更新：Web 包先导出到 `web-next`，确认产出 `index.html` 后才替换 `web`，随后重建中心镜像、执行迁移、重启中心。失败的导出不会留下半个包。中心重启期间连接会短暂中断。Agent 更新应等待其活动回合结束。

候选回退只停止本候选的中心、Agent 和 `lmc-center` Compose 项目；`docker compose stop` 保留卷。不要 `down -v`，不要终止 Happy 进程，不改现有公网入口。

历史迁移须另行执行：清点旧账号与加密方式 → 在获得授权后导出必要数据 → 转换 ID/seq/版本/归属并校验数量及密文可解 → 双端只读核验 → 停写切换 → 保留旧入口回退。当前初始化脚本不迁移历史，不接管生产。

---

[English](README.md)
