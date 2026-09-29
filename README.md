# 中转站签到

Router2API 签到插件，支持账号管理、自动签到、余额查询和 JSON 配置。

## 功能

- 添加、编辑、删除账号，按站点类型和名称筛选。
- 单账号签到、全部签到、任务进度与取消。
- 每个账号单独设置 Cron，默认每天 10:10，时区 UTC+8。
- 每日时间快捷设置、恢复默认时间、下三次执行时间预览。
- 显示账号余额、单位、更新时间和签到结果。
- 可视化与 JSON 双向编辑，支持导入、导出和复制配置。
- 启用开关、自动签到开关、签到后更新余额开关。
- 直连和代理池两种网络路线。
- New API、AnyRouter、AgentRouter 共用 acw_sc__v2 自动验证，支持签到、登录和余额查询。
- 执行结果显示 HTTP 状态、响应正文和网络错误。

## 站点类型

| 类型 | 登录信息 | 签到方式 | 余额更新 |
| --- | --- | --- | --- |
| New API | 站点地址、Cookie、User ID | Cookie 签到 | 签到后更新或手动刷新 |
| AnyRouter | Cookie、User ID | Cookie 签到 | 签到后更新或手动刷新 |
| AgentRouter | 用户名或邮箱、密码 | 登录签到 | 登录签到后更新 |

AnyRouter 默认地址为 `https://anyrouter.top`，AgentRouter 默认地址为 `https://agentrouter.org`。

Cookie 使用请求头 Cookie，User ID 使用请求头 New-Api-User。User-Agent 可选填。

## 定时设置

支持五字段 `分 时 日 月 周` 和六字段 `秒 分 时 日 月 周`，秒位固定为 `0`。
支持通配符、列表、范围和步长。星期日可写 `0` 或 `7`，日期与星期同时指定时取 OR。

| Cron | 执行时间 |
| --- | --- |
| `0 10 10 * * *` | 每天 10:10 |
| `30 9 * * *` | 每天 09:30 |
| `0 10 10 * * 1-5` | 工作日 10:10 |
| `0 */30 9-18 * * *` | 每天 09:00–18:30，每半小时 |

新账号自动签到默认关闭。已确认当天签到成功的账号会跳过后续签到。

## 余额

- 账号卡片显示可用余额、币种、原始 quota 和更新时间。
- New API 按站点设置显示 USD、CNY、自定义币种或 quota。
- AnyRouter 官方站点按 `500000 quota / USD` 换算。
- 刷新失败时保留上次余额并显示错误，尚未获取时显示 `—`。

## JSON 配置

```json
{
  "label": "日常账号",
  "siteType": "NewAPI",
  "baseUrl": "https://TARGET",
  "cookie": "session=TOKEN",
  "userId": "123",
  "userAgent": "",
  "username": "",
  "password": "",
  "route": "direct",
  "enabled": true,
  "autoCheckIn": false,
  "cron": "0 10 10 * * *",
  "queryBalance": true
}
```

AgentRouter 使用 `username` 和 `password`，`cookie` 和 `userId` 留空。

## 安装

安装包：[GitHub Releases](https://github.com/yowiv08/js-checkin/releases/latest) 中的 `js-checkin.zip`。

将包内 `js-checkin` 目录放入 Router2API 程序目录下的 `plugins`，在插件管理页加载。
运行环境为 Jint、Host API 1 和 Redis。
