# Yulor · 悠络

Yulor is the new product name of **LMC / Link my Cli**. This repository was previously **MoeAisaka/lmc-workspace**. It remains the same project and repository history, derived from Happy under its existing MIT attribution.

Yulor 是 **LMC / Link my Cli** 的新品牌名，中文为 **悠络**；GitHub 仓库旧名为 **MoeAisaka/lmc-workspace**。这是同一项目的更名，保留历史与上游 Happy 的 MIT 署名。

## Finding the project / 查找项目

- Canonical repository / 新地址: <https://github.com/MoeAisaka/yulor>
- Previous repository / 旧地址: <https://github.com/MoeAisaka/lmc-workspace> (GitHub redirect / GitHub 自动重定向)
- Update a public checkout / 更新公开仓库的远端: `git remote set-url origin https://github.com/MoeAisaka/yulor.git`
- Keep the old repository name unused so its redirect continues working. / 不复用旧库名，保留原链接的重定向。

## Compatible identifiers / 兼容标识

Use **Yulor** for the product, interface and documentation; `yulor` is the new executable alias. Existing `lmc` and `happy` commands continue to use the same implementation and state. A version/help probe does not authenticate, register a session, start an engine or create a separate home.

产品界面与介绍使用 **Yulor**；新的命令入口为 `yulor`。原有 `lmc`、`happy` 命令复用同一实现与状态，版本和帮助查询不触发登录、引擎启动或新设备身份。

The following are intentionally stable compatibility identifiers, not remaining product brands:

- `LMC_*` environment variables, `~/.lmc/agent`, device identities and existing credentials.
- `/v1/lmc/*` routes, `lmc` wire/MCP names, stored settings, release markers and database schemas.
- Workspace package names (`link-my-cli`, `lmc-app`, `lmc-wire`, etc.) and `packages/lmc-*` / `deploy/lmc` paths used by existing build and deployment scripts.
- Existing server hostnames, pairing URLs, native bundle/signing identities and update channels. No DNS, credential or native signing migration is implied.

以上变量、目录、协议、包名和部署路径继续保留，保障现有安装、配对、会话、数据与脚本兼容。更名不要求重新登录或迁移数据库；不代表原生应用已重新签名或已发布到应用商店。

## Mark / 图标

The editable source is [yulor-mark.svg](../brand/yulor-mark.svg). Converging strokes form a Y; the mint terminal represents continuing work at another endpoint. Raster application, browser and desktop icons are generated from the same source with [render-icons.cjs](../brand/render-icons.cjs). This geometric artwork is maintained as SVG, not an AI-generated raster.

SVG 源图用汇合成 Y 的线条表达协作，以薄荷色端点表达接续。应用、网页与桌面图标由同一源图生成，确保小尺寸识别一致。
