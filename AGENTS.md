# 开发边界

- 独立项目，纯 JavaScript / Jint Host API 1；不要把实现写回示例仓库。
- 先读 README.md。生产代码只在 src/，页面在 ui/；sdk/ 是开发期类型快照。
- 不添加 C#、宿主源码依赖、浏览器自动登录或挑战求解器。
- npm ci；npm run check；npm test；npm run test:build；npm run test:release；npm run build。
- GitHub 发行使用 PowerShell 7 的 package-release.ps1；仅打包 dist/js-checkin，产物为 ZIP、SHA256 与 release-index.json。
- 只复制 dist/js-checkin 完整发行包；开发/打包不等于部署授权。
- 管理员界面和 JSON 按用户要求展示完整 Cookie/密码；绝不提交真实凭据。
- 日志不记录凭据；POST 不自动重试，取消后保留未确认记录，CAS 不覆盖并发编辑。
- 不自动安装、重载宿主、提交或推送。测试结果必须区分 mock、浏览器和真实站点。
