# 来源与参考

本项目是独立签到插件，不依赖兄弟示例仓库的源码、node_modules 或宿主测试。

## 开发期 SDK 快照

- [sdk/index.d.ts](sdk/index.d.ts)：来自 [Rouer-Plugins-js](https://github.com/NNNNolan/Rouer-Plugins-js/blob/ab14a9cd1f908b6025e6caac7b9af0d17e75ed41/sdk/js/index.d.ts)，Host API 1。
- [tools/build.mjs](tools/build.mjs)：同一提交的 [构建工具](https://github.com/NNNNolan/Rouer-Plugins-js/blob/ab14a9cd1f908b6025e6caac7b9af0d17e75ed41/sdk/js/build.mjs)，仅调整命令示例路径，保留源码注释。
- 上游 JS 仓库当前说明“尚未指定新的主许可证”。以上是本地开发使用的来源记录，不据此声称获得额外再发行授权；对外再发布 SDK 快照前应确认其许可。
- SDK 类型和 Node 构建工具不进入插件运行包。

## GitHub 发行协议

- 工作流参照 Rouer-Plugins-js 的 tag 发布方式，使用本项目根目录的构建入口。
- [package-release.ps1](package-release.ps1) 独立实现单插件 ZIP 与索引生成，遵循 Router2API 的 [插件发行索引协议](https://github.com/NNNNolan/Router2API/blob/main/sdk/PLUGIN-RELEASES.md)。
- `sha256` 校验 ZIP，`contentSha256` 根据排序后的包内相对路径与文件摘要生成。

## 协议依据

- [wuwei0727/anyrouter-sign](https://github.com/wuwei0727/anyrouter-sign/tree/a113cad0f82a798490d6bfcc84b3feb84ab0b89a)：AnyRouter Cookie + New-Api-User、POST sign_in。
- [tpf308/router-checkin](https://github.com/tpf308/router-checkin/tree/d239f1c20913975d406073e5375e52d866cba55c)：AgentRouter 登录触发签到及 checked_in/check_in 的解释。
- [New API](https://github.com/QuantumNous/new-api)：标准 POST /api/user/checkin、GET /api/user/self 的 quota，以及 `/api/status` 的额度/币种配置。余额单位计算参考其 `web/src/lib/currency.ts`、`web/src/lib/format.ts` 的公开字段语义，独立实现。

签到、余额、分钟 Cron 解析与调度独立实现；未复制上述签到项目的 WAF 求解、登录浏览器、通知、重试或代理探测代码。AnyRouter 的固定额度换算依据为其参考项目的 quota / 500000。参考项目的历史站点现状不代表本次已经完成真实站点验收。

## 开发依赖

esbuild、TypeScript、jsdom 及其依赖遵循各自包中许可证。依赖版本固定在 package-lock.json，均为开发期依赖，不打入生产插件。
