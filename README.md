# 中转站签到

Router2API 签到插件，支持账号管理、自动签到、余额查询和 JSON 配置。

## 功能

- 添加、编辑、删除账号，按站点类型和名称筛选。
- 单账号签到、全部签到、任务进度与取消。
- 所有账号统一每天 10:10 自动签到，时区 UTC+8。
- 查看下三次统一签到时间。
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

所有开启自动签到的账号统一在 **每天 10:10（UTC+8）** 入队，批量依次执行。
宿主任务 Cron 为 `0 10 10 * * *`，不支持按账号自定义时间。

新账号自动签到默认关闭。已确认当天签到成功的账号会跳过后续签到。

调度延迟不超过 30 分钟时仍归入当天同一计划，重复触发不重复入队；
错过该窗口不会在其他时间补发。

AnyRouter 签到接口返回 HTTP 2xx 和 `{"message":"","success":true}` 时显示「签到成功」。
超时、取消、未知响应等无法确认是否生效的 POST 仍需人工确认，不会因跨日自动重试。

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
  "queryBalance": true
}
```

AgentRouter 使用 `username` 和 `password`，`cookie` 和 `userId` 留空。

## 安装

安装包：[GitHub Releases](https://github.com/yowiv08/js-checkin/releases/latest) 中的 `js-checkin.zip`。

将包内 `js-checkin` 目录放入 Router2API 程序目录下的 `plugins`，在插件管理页加载。
运行环境为 Jint、Host API 1 和 Redis。
