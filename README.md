# 中转站签到

Router2API 签到插件，支持账号管理、自动签到、余额查询、API 令牌和 JSON 配置。

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
- 按账号管理 API 令牌：新建、编辑、复制密钥、启用、禁用和删除。

## 站点类型

| 类型 | 登录信息 | 签到方式 | 余额更新 |
| --- | --- | --- | --- |
| New API | Cookie + User ID 或账号密码 | Cookie 签到或登录后签到 | 签到后更新或手动刷新 |
| AnyRouter | Cookie + User ID 或账号密码 | Cookie 签到或登录后签到 | 签到后更新或手动刷新 |
| AgentRouter | Cookie + User ID 或账号密码 | 密码登录触发签到；Cookie 使用独立签到接口 | 签到后更新或手动刷新 |

AnyRouter 默认地址为 `https://anyrouter.top`，AgentRouter 默认地址为 `https://agentrouter.org`。

Cookie 使用请求头 Cookie，User ID 使用请求头 New-Api-User。User-Agent 可选填。

每个站点均可选择「Cookie / CK」或「账号密码」。密码模式通过 `/api/user/login` 获取 session 和 User ID，无需手填 Cookie。
New API 登录后调用 `/api/user/checkin`，AnyRouter 调用 `/api/user/sign_in`；登录成功不等于签到成功。
AgentRouter 的密码模式保留登录触发签到行为；Cookie 模式需要站点提供 `/api/user/checkin`，不支持时直接报错。
当前密码模式兼容返回 `data.id` 与 session Cookie 的 New API 模板；要求验证码、二次验证、加密密码或仅返回 Bearer 令牌的版本不会继续签到。

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
- 所有站点均可手动刷新余额，不触发签到。
- 所有密码模式账号复用登录签到时保存的会话；未保存会话或会话失效时需先登录并签到。会话不包含在导出配置中。
- 刷新失败时保留上次余额并显示错误，尚未获取时显示 `—`。

## API 令牌

在「API 令牌」页面选择账号，或从账号卡片的「令牌」按钮进入。
支持名称、站点分组、过期时间、有限/无限额度、模型限制和 IP 白名单。

- 过期时间使用 UTC+8，可选永不过期；分组和模型从站点加载。
- 额度默认使用站点币种，可切换 quota；金额必须精确换算为整数 quota。无限额度仅取消令牌自身上限，不增加账号余额。
- 密钥默认隐藏，点击「复制」直接写入剪贴板；「更多」中可查看密钥、启停及删除。密钥不写入日志、任务记录或配置导出。
- 分组、模型及显示汇率短期缓存 60 秒；手动刷新清除页面选项缓存。保存时重新检查令牌配置和额度换算信息。
- 操作凭证由服务端签发，不依赖浏览器时间；正常编辑无须因十分钟限制反复关闭编辑器。
- 密码模式使用已保存且路径适用的登录会话；旧会话缺少路径信息时，需在下次正常登录签到后使用令牌管理。
- 写请求不会自动重发。出现「待核对」时先刷新列表核实，不要直接再次新建令牌。
- 编辑前会重读站点配置，未修改额度时保留最新额度；上游不提供原子条件更新，提交期间仍可能存在并发消费。

## JSON 配置

```json
{
  "label": "日常账号",
  "siteType": "NewAPI",
  "authMode": "cookie",
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

密码模式设置 `"authMode": "password"`，填写 `username` 和 `password`，`cookie` 和 `userId` 留空。
旧配置无须修改：原 Cookie 账号和 AgentRouter 密码账号保留原认证方式。

## 安装

安装包：[GitHub Releases](https://github.com/yowiv08/js-checkin/releases/latest) 中的 `js-checkin.zip`。

将包内 `js-checkin` 目录放入 Router2API 程序目录下的 `plugins`，在插件管理页加载。
运行环境为 Jint、Host API 1 和 Redis。
