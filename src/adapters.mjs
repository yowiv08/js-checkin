/**
 * 独立实现公开协议，不执行参考项目的代码/远端挑战脚本。
 * AnyRouter/New API 不登录；AgentRouter 不访问 sign_in（余额模块可复用登录会话 GET self）。
 */
/** @returns {import("../sdk/index").HttpRequest & { responseType: "text" }} */
export function requestFor(config) {
  const agent = config.siteType === "AgentRouter";
  const path = agent ? "/api/user/login" : config.siteType === "AnyRouter" ? "/api/user/sign_in" : "/api/user/checkin";
  // baseUrl 已经通过 ctx.url 规范化；此处只提取经过校验的 origin。
  const origin = config.baseUrl.split("/").slice(0, 3).join("/");
  const headers = { accept: "application/json", origin, referer: config.baseUrl + (agent ? "/login" : "/") };
  if (!agent) {
    headers.cookie = config.cookie;
    headers["new-api-user"] = config.userId;
    if (config.userAgent) headers["user-agent"] = config.userAgent;
  }
  return {
    url: config.baseUrl + path, method: "POST", route: config.route, headers,
    responseType: "text", timeoutMs: 30000, followRedirects: false, allowDirectFallback: false,
    ...(agent ? { body: { username: config.username, password: config.password } } : {})
  };
}
/** 只返回固定消息，不把可能反射 Cookie/密码的上游 message 或 data 返回到页面。 */
export function interpret(siteType, response) {
  const httpStatus = response.statusCode;
  const result = (status, message) => ({ status, message, httpStatus });
  const raw = typeof response.bodyText === "string" ? response.bodyText : "";
  if (httpStatus === 429) return result("RateLimited", "上游限流，未自动重试");
  if (/acw_sc__v2|aliyun_waf|请按住滑块|访问验证|cf-chl-|challenge-platform|http_ratelimit/i.test(raw))
    return /http_ratelimit/i.test(raw) ? result("RateLimited", "边缘节点限流，请勿连续重试")
      : result("Challenge", "上游需要人机验证，请在浏览器处理；插件不会执行挑战脚本");
  if (httpStatus === 401) return result("AuthExpired", "认证失效，请更新 Cookie 或用户名密码");
  if (httpStatus >= 300 && httpStatus < 400) return result("Failed", "上游返回重定向，未跟随或发送凭据到其他地址");
  if (httpStatus >= 500 || httpStatus === 408) return result("Uncertain", "上游超时或服务异常，无法确认 POST 是否生效，未重试");
  let json;
  try { json = JSON.parse(raw); } catch { return result("Uncertain", "响应不是有效 JSON，无法确认签到结果"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) return result("Uncertain", "响应结构无法识别");
  const message = typeof json.message === "string" ? json.message : "";
  if (/turnstile|captcha|人机|验证码|验证令牌/i.test(message))
    return result("Challenge", "站点要求验证码，需人工处理");
  if (/未登录|登录.*(?:失效|过期)|cookie.*(?:expired|invalid)|unauthori[sz]ed|not logged|登录信息.*无效|密码.*(?:错误|不正确)|用户名.*(?:错误|不存在)|invalid.*(?:password|credential)/i.test(message))
    return result("AuthExpired", "认证失效，请更新 Cookie 或用户名密码");
  if (httpStatus < 200 || httpStatus >= 300) return result("Failed", `上游拒绝请求（HTTP ${httpStatus}）`);
  if (/未启用|未开启|disabled|not enabled/i.test(message)) return result("Failed", "站点未启用签到功能");
  if (siteType !== "AgentRouter" && /今日已签到|今天已签到|已经签到|已签到|already (?:checked|signed) in|checked in today/i.test(message))
    return result("Already", "上游确认今日已签到");
  if (json.success === false || json.error != null && json.error !== false)
    return result("Failed", "上游返回业务失败，请检查账号或站点设置");
  if (json.success !== true) return result("Uncertain", "响应没有明确业务成功标志，未记录为成功");
  if (siteType === "AgentRouter") {
    const data = json.data;
    const checked = data?.checked_in ?? data?.check_in;
    if (checked === true) return result("Already", "登录成功，上游标记今日已签到");
    if (checked === false) return result("Success", "登录成功，本次触发签到");
    return result("Uncertain", "登录成功，签到状态未确认");
  }
  const reward = ["quota_awarded", "checkin_quota", "check_in_quota", "checkin_reward", "reward"]
    .some(key => json.data?.[key] != null || json[key] != null);
  if (reward || /签到成功|check.?in successful|successfully (?:checked|signed) in/i.test(message))
    return result("Success", "上游确认签到成功");
  return result("Uncertain", "业务返回成功但没有明确签到信息，未记录为今日成功");
}
