# v1.1.1 验证记录

执行日期：2026-09-29。环境：Windows、Node 24.18.0。

| 检查 | 实际结果 |
| --- | --- |
| npm ci | 通过，依赖版本未变 |
| npm run check | 通过：8 个纯 JS 模块、Host API 类型、清单导出、页面语法、文档链接 |
| npm test | 92/92 通过：76 个后端用例 + 16 个 jsdom 用例 |
| npm run test:build | 1/1 通过，真实 esbuild 打包 |
| npm run test:release | 11/11 通过，实际 PowerShell 7 压缩、读取 ZIP、校验摘要和发行索引 |
| npm run test:browser | 通过，真实无头 Chrome + 模拟管理桥 |
| npm run build | 通过，生成 dist/js-checkin |
| ZIP 内容核对 | 恰好 plugin.json、server/plugin.mjs、ui/index.html，带 js-checkin 顶层目录 |
| Rouer-Plugins-js 仓库 | 未写入示例；git status --short 无输出 |

新增用例包含：Cron 五/六字段、UTC+8、默认时间、预览闰年/无匹配日、同 slot 去重、入队失败、过期/变更计划；余额大整数/负数/零/未知、站点换算、临时 session、固定客户端、WAF/失效/超时/取消、独立 CAS、旧余额保留与身份变化。

v1.1.1 新增页面文案回归：功能文案、无导出提醒、无括号附注、用户名称与凭据中的括号原样保留；实际任务状态、取消和原有认证校验保持不变。

## 浏览器实际检查

- 桌面与 430px 手机无横向溢出。
- 可视化/JSON 切换，完整 Cookie 配置保留。
- 每日时间快捷设置为 09:30，Cron 进入 JSON，预览展示下次时间；余额卡片可见（全部是演示数据）。
- 与宿主一致的 sandbox iframe（没有 allow-modals/allow-downloads）中，页面内确认框可用。
- sandbox 内直接打开导出窗口，无额外确认和提示文案；实际下载 JSON，内容与演示凭据一致。
- 五张截图在 artifacts/preview，全部为标注过的离线演示数据，不是真实账号或签到证据。

## 安装包

`dist/js-checkin-1.1.1.zip`，26,767 字节。

SHA256：`f43930b4f349677aa044a84a53c1bc6dc91864ee056c6a9b7492e03a5e74cee6`

校验文件：`dist/js-checkin-1.1.1.zip.sha256`。旧版 ZIP 保留。

## 未验证或未执行

- 没有真实 Cookie/密码，未调用任何上游登录/签到/余额接口。
- 未启动 Jint/SQLite/Redis 的真实宿主集成测试；Node ctx mock 不代表原生集成验收。
- 未验证 AnyRouter 的当前 WAF/TLS 限制，未实现浏览器风控绕过。
- 未安装或重载宿主。

原生宿主加载、真实 Cron 分钟调度/Redis 权限/取消、站点当天状态、币种元数据与请求行为，需要在独立测试宿主中进一步确认。mock 的十进制实现也不等于 .NET decimal 边界舍入验收。

## GitHub 自动打包

- 工作流：`.github/workflows/release-plugins.yml`。
- tag 推送创建 Release；手动运行上传构建资产。
- 构建任务使用只读仓库权限，发布任务单独申请 `contents: write`。
- 实际完成 `npm ci`、检查、92 项业务与页面测试、1 项构建测试、11 项发行测试、构建及 `npm run package:release`。
- 发行测试覆盖实际 ZIP 三文件与字节内容、索引字段、独立 Release tag、稳定内容摘要、无效清单和 tag、目录隔离、符号链接、旧文件保留、发布说明及工作流静态约束。
- 本地发行资产位于 `artifacts/release`，标签 `v1.1.1`，ZIP 大小 26,767 字节。
- ZIP SHA256：`c76c87741dbbc625804537fc39027de38b6950c14c673d1edecdcc0aec6f8734`。
- contentSha256：`5e912944c3b67a3a6106ac97ee77384f14011f5f0cbc9eff56496a90224a627c`。
- PowerShell 打包已在 Windows 验证。GitHub Actions 与 Ubuntu runner 的运行结果见[工作流记录](https://github.com/yowiv08/js-checkin/actions)。
