import { InputError, cancelled, errorMessage, passwordAuth } from "./common.mjs";
import { interpret, requestFor } from "./adapters.mjs";
import { wafHeaders } from "./waf.mjs";
import { responseMessage } from "./diagnostics.mjs";
import { currencyFor } from "./token-values.mjs";

export function exactJson(raw) {
  if (typeof raw !== "string" || raw.length > 1024 * 1024) throw new InputError(502,"上游 JSON 过大或缺失");
  JSON.parse(raw);
  return JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => token[0] === '"' ? token : `"${token}"`));
}
const integer = value => typeof value === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(value);
function business(response) {
  let json;
  try { json = exactJson(response.bodyText); } catch {  }
  if (response.statusCode >= 200 && response.statusCode < 300 && json?.success === true && json.data && !Array.isArray(json.data) && typeof json.data === "object") return json.data;
  const result = interpret("NewAPI",response);
  throw new InputError(502, responseMessage(response) || result.message);
}
export function agentSession(config, loginResponse) {
  const data = business(loginResponse), uid = data.id;
  if (typeof uid !== "string" || !/^[1-9]\d{0,39}$/.test(uid))
    throw new InputError(502,"登录响应缺少精确 User ID，未查询余额");
  const hostname = config.baseUrl.split("/")[2].split(":")[0].toLowerCase();
  const pathStart = config.baseUrl.indexOf("/",8);
  const path = (pathStart < 0 ? "" : config.baseUrl.slice(pathStart)) + "/api/user/self";
  const cookies = loginResponse.headers?.["set-cookie"];
  if (!Array.isArray(cookies)) throw new InputError(502,"登录响应未提供临时会话，余额未知；不会再次登录");
  const sessions = [], now = Date.now();
  for (const line of cookies) {
    if (typeof line !== "string" || line.length > 16384 || /[\u0000-\u001f\u007f]/.test(line)) continue;
    const parts = line.split(";").map(s=>s.trim()), pair = parts.shift();
    if (!sessionCookie(pair)) continue;
    let valid = true, expiresAt = null, maxAge = null;
    let cookiePath = path.slice(0,path.lastIndexOf("/"));
    const seen = new Set();
    for (const attribute of parts) {
      const at = attribute.indexOf("="), name = (at < 0 ? attribute : attribute.slice(0,at)).toLowerCase();
      const value = at < 0 ? "" : attribute.slice(at+1);
      if (["domain","path","max-age","expires"].includes(name)) {
        if (seen.has(name)) valid = false;
        seen.add(name);
      }
      if (name === "domain" && value.replace(/^\./,"").toLowerCase() !== hostname) valid = false;
      if (name === "path" && !(path === value || path.startsWith(value.endsWith("/") ? value : value + "/"))) valid = false;
      if (name === "path") {
        if (!value.startsWith("/")) valid = false;
        cookiePath = value;
      }
      if (name === "max-age") {
        maxAge = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(maxAge) || maxAge <= 0 ||
          !Number.isSafeInteger(now + maxAge * 1000)) valid = false;
      }
      if (name === "expires") {
        expiresAt = Date.parse(value);
        if (!Number.isFinite(expiresAt)) valid = false;
      }
    }
    if (maxAge !== null) expiresAt = now + maxAge * 1000;
    if (expiresAt !== null && expiresAt <= now) valid = false;
    if (valid) sessions.push({cookie:pair,userId:uid,expiresAt,cookiePath});
  }
  if (sessions.length !== 1) throw new InputError(502,"未找到唯一有效的临时 session，未查询余额");
  return sessions[0];
}
function sessionCookie(cookie) {
  return typeof cookie === "string" && cookie.length <= 16384 &&
    /^session=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(cookie);
}
export function requireAgentSession(session, requestPath = null) {
  if (!session || !sessionCookie(session.cookie) || typeof session.userId !== "string" ||
    !/^[1-9]\d{0,39}$/.test(session.userId) ||
    !(session.expiresAt === null || Number.isSafeInteger(session.expiresAt)))
    throw new InputError(401,"缺少有效登录会话，请先登录并签到");
  if (session.expiresAt !== null && session.expiresAt <= Date.now())
    throw new InputError(401,"登录会话已过期，请先登录并签到");
  if (requestPath !== null) {
    const scope = session.cookiePath;
    if (typeof scope !== "string" || !scope.startsWith("/") ||
      !(requestPath === scope || requestPath.startsWith(scope.endsWith("/") ? scope : scope + "/")))
      throw new InputError(401,"会话缺少此接口的路径作用域，请在下次正常登录签到后重试");
  }
  return session;
}
/** @returns {import("../sdk/index").HttpRequest & {responseType:"text"}} */
function getSpec(config, path, session) {
  const { route, body, ...spec } = requestFor(config);
  return { ...spec, method: "GET", url: config.baseUrl + path,
    headers: wafHeaders(config, session
      ? { ...spec.headers, cookie:session.cookie,"new-api-user":session.userId }
      : {accept:"application/json",origin:spec.headers.origin,referer:config.baseUrl+"/"}) };
}
/** @param {import("./common.mjs").Context} ctx
 * @param {import("../sdk/index").HttpClientHandle} client */
export async function readBalance(ctx, config, client, agent = null) {
  const checkedAt = new Date().toISOString();
  try {
    const session = passwordAuth(config) ? requireAgentSession(agent) : config;
    const response = await client.request(getSpec(config,"/api/user/self",session));
    if (passwordAuth(config) && interpret("NewAPI",response).status === "AuthExpired")
      throw new InputError(401,"登录会话已失效，请先登录并签到" +
        (responseMessage(response) ? "\n" + responseMessage(response) : ""));
    const data = business(response);
    if (!integer(data.quota)) throw new InputError(502,responseMessage(response));
    const snapshot = { quota: data.quota, usedQuota: integer(data.used_quota) ? data.used_quota : null,
      amount: data.quota, unit: "quota", source: "/api/user/self", updatedAt: checkedAt, note: "" };
    if (config.siteType === "AnyRouter" && config.baseUrl === "https://anyrouter.top") {
      try { snapshot.amount = ctx.decimal.divide(data.quota,"500000"); snapshot.unit = "USD"; snapshot.note = "按 AnyRouter 500000 quota / USD 换算"; }
      catch { snapshot.note = "额度超出宿主十进制范围，显示原始 quota"; }
    } else {
      try {
        const meta = business(await client.request(getSpec(config,"/api/status",null)));
        const kind = meta.quota_display_type ?? (meta.display_in_currency === true ? "USD" : "TOKENS");
        if (kind === "TOKENS" || meta.display_in_currency === false) snapshot.note = "站点以原始 quota 显示";
        else {
          const currency = currencyFor(config,meta);
          if (!currency) throw new InputError(502,"缺少有效额度单位或汇率");
          snapshot.amount = ctx.decimal.multiply(ctx.decimal.divide(data.quota,currency.quotaPerUnit),currency.rate);
          snapshot.unit = currency.unit; snapshot.note = "按站点 /api/status 单位与汇率换算";
        }
      } catch (error) {
        if (cancelled(error)) throw error;
        snapshot.note = errorMessage(error);
      }
    }
    return { snapshot, checkedAt, error: null };
  } catch (error) {
    if (cancelled(error)) throw error;
    return { checkedAt, error: errorMessage(error),
      ...(passwordAuth(config) && error instanceof InputError && error.status === 401 ? {authExpired:true} : {}) };
  }
}
