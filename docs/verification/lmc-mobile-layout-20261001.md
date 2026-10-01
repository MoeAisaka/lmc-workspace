# 手机旋转、恢复后的双栏错位修复

## 问题和改动

用户在 iPhone 浏览器横竖屏切换、从其他应用切回后，看到桌面侧栏常驻，正文和输入框被挤成窄条。旧版 `responsive.ts` 用 React Native Web 缓存的窗口尺寸判断 900px 断点；当前 RN Web 实现从 `visualViewport` 更新该缓存，仅监听其 resize 事件。

隔离浏览器页面保留 932px 的框架宽度、将真实页面恢复到 430px 后，v236 会选中桌面布局：360px 侧栏把聊天压到 70px。该模拟重现了截图中的布局故障；未在用户的 iPhone 上采集底层视口事件。

Web 现在通过 `matchMedia('(min-width: 900px)')` 读取 CSS 布局断点，使用 `useSyncExternalStore` 订阅变化，并在 pageshow、focus、resize 和恢复可见时复核。同步 `getDeviceType()` 使用相同来源。原生 iOS/Android 物理尺寸判断保留，不重新挂载导航或业务会话。

## 验证

- `pnpm exec vitest run sources/utils/responsive.test.ts sources/utils/deviceCalculations.test.ts`：34 项通过。其中 9 项新回归涵盖缓存仍为横屏、断点改变、错过变化事件后的四种恢复通知、SSR 初始值和原生平台隔离。
- `pnpm typecheck`：通过。
- `export-web.sh --out /tmp/lmc-mobile-layout-web-v237`：构建成功。
- Chromium 手机触屏模拟，加载导出产物中的真实响应式 hook、Drawer、SidebarView、FloatingSessionDrawer 和 SessionViewLoaded；外层隔离 shell 复用侧栏的 360px 配置，不是完整 Expo Router 端到端测试。合成会话、独立浏览器环境，阻断全部非回环网络请求。
- 同一故障条件修复后：真实宽度 430px、框架宽度仍为 932px，布局为 phone，聊天宽度 430px。旋转前草稿保留，聊天只挂载一次；浮层打开不挤压正文，点击遮罩正常关闭。
- 320、390、899、900、1280、430px 切换验证通过，无页面横向溢出；900px 起仍正常显示桌面双栏。Claude/Codex 合成会话均验证。
- 已检查恢复竖屏、浮层打开的截图。以上为桌面 Chromium 的手机模拟与确定性回归，未声称 iPhone/WebKit 实机验收。

本机证据：`/tmp/lmc-responsive-check.cjs`；旧版复现目录 `/var/folders/3x/8gprgtc53csd80qbgch0syc40000gn/T/lmc-responsive-check-DpYp11`；新版目录 `/var/folders/3x/8gprgtc53csd80qbgch0syc40000gn/T/lmc-responsive-check-7zyppa`（截图及 measurements.json）。

## 发布

- Web marker：`lmc-redesign-20260908-v237`。
- 正式与预览两个域名均已读取首页并校验实际新 bundle 的 SHA-256，与已测构建一致。
- 主 bundle：`index-176fd9c9efa7d26177954d8ed76470b4.js`。
- SHA-256：`c97f0d36cc7f784c13b32dcb9975086abef8bb51ec888741ff9688cfd2e18dbf`。
- 发布前首页备份：`index.previous-1790835550176.html`，旧 marker 为 v236；旧静态资源保留，可恢复备份首页回退。
- 线上校验记录：`/tmp/lmc-mobile-layout-live-v237.json`。

此轮只发布 Web。未刷新或中断业务 Agent、未给业务会话发送测试消息。
