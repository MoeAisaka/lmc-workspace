# 正文复制图片检查

对实际Expo导出组件运行隔离浏览器夹具，仅本地静态请求，剪贴板写入使用stub。验证双引擎、主题、长正文、宽表及拒绝后的下载，不代表实体iPhone验收。

构建：`CI=1 pnpm --filter lmc-app exec expo export --platform web --output-dir /tmp/lmc-message-image-20261013`

运行：`LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/message-image-smoke/verify.cjs /tmp/lmc-message-image-20261013`

可选`LMC_CHROME_PATH`选择Chrome；输出路径在控制台，含PNG及result.json。
