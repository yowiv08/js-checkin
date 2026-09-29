/** 余额协议：不登录、不签到，只读取 self；AgentRouter 使用调用内临时会话。 */
import { InputError, cancelled } from "./common.mjs";
import { interpret, requestFor } from "./adapters.mjs";

/** 在 JSON 数字经过 JS Number 前转为字符串；字符串 token 原样保留。 */
export function exactJson(raw) {
  if (typeof raw !== "string" || raw.length > 1024 * 1024) throw new InputError(502,"上游 JSON 过大或缺失");
  // 仅校验原始语法，丢弃此结果；防止 01/数字属性名等非法 JSON 被替换成有效字符串。
  JSON.parse(raw);
  return JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => token[0] === '"' ? token : `"${token}"`));
}
const integer = value => typeof value === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(value);
const decimal = value => typeof value === "string" && /^(?:0|[1-9]\d{0,27})(?:\.\d{1,28})?$/.test(value);
function business(response) {
  let json;
  try { json = exactJson(response.bodyText); } catch { /* 统一错误分类，不回显上游文本。 */ }
  if (response.statusCode >= 200 && response.statusCode < 300 && json?.success === true && json.data && !Array.isArray(json.data) && typeof json.data === "object") return json.data;
  const result = interpret("NewAPI",response);
  throw new InputError(502, ["AuthExpired","Challenge","RateLimited"].includes(result.status)
    ? result.message : "余额接口未返回明确成功的 JSON 数据");
}
/** 只提取有效的 session Cookie；不接受其他域/不匹配路径/已删除的会话。 */
export function agentSession(config, loginResponse) {
  const data = business(loginResponse), uid = data.id;
  if (typeof uid !== "string" || !/^[1-9]\d{0,39}$/.test(uid))
    throw new InputError(502,"登录响应缺少精确 User ID，未查询余额");
  const hostname = config.baseUrl.split("/")[2].split(":")[0].toLowerCase();
  const pathStart = config.baseUrl.indexOf("/",8);
  const path = (pathStart < 0 ? "" : config.baseUrl.slice(pathStart)) + "/api/user/self";
  const cookies = loginResponse.headers?.["set-cookie"];
  if (!Array.isArray(cookies)) throw new InputError(502,"登录响应未提供临时会话，余额未知；不会再次登录");
  const sessions = [];
  for (const line of cookies) {
    if (typeof line !== "string" || /[\r\n]/.test(line)) continue;
    const parts = line.split(";").map(s=>s.trim()), pair = parts.shift();
    if (!/^session=[^\s;,]+$/.test(pair || "")) continue;
    let valid = true;
    for (const attribute of parts) {
      const at = attribute.indexOf("="), name = (at < 0 ? attribute : attribute.slice(0,at)).toLowerCase();
      const value = at < 0 ? "" : attribute.slice(at+1);
      if (name === "domain" && value.replace(/^\./,"").toLowerCase() !== hostname) valid = false;
      if (name === "path" && !(path === value || path.startsWith(value.endsWith("/") ? value : value + "/"))) valid = false;
      if (name === "max-age" && (!/^\d+$/.test(value) || Number(value) <= 0)) valid = false;
      if (name === "expires" && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) valid = false;
    }
    if (valid) sessions.push(pair);
  }
  if (sessions.length !== 1) throw new InputError(502,"未找到唯一有效的临时 session，未查询余额");
  return { cookie: sessions[0], userId: uid };
}
/** @returns {import("../sdk/index").HttpRequest & {responseType:"text"}} */
function getSpec(config, path, session) {
  const { route, body, ...spec } = requestFor(config);
  return { ...spec, method: "GET", url: config.baseUrl + path,
    headers: session ? { ...spec.headers, cookie:session.cookie,"new-api-user":session.userId } : {accept:"application/json"} };
}
/** 固定客户端中不重复指定 route；会话与密码不会传给 /api/status。 */
/** @param {import("./common.mjs").Context} ctx
 * @param {import("../sdk/index").HttpClientHandle} client */
export async function readBalance(ctx, config, client, loginResponse = null) {
  const checkedAt = new Date().toISOString();
  try {
    const session = config.siteType === "AgentRouter" ? agentSession(config,loginResponse) : config;
    const data = business(await client.request(getSpec(config,"/api/user/self",session)));
    if (!integer(data.quota)) throw new InputError(502,"余额缺少有效 quota，未将未知余额当作零");
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
          if (!decimal(meta.quota_per_unit) || ctx.decimal.compare(meta.quota_per_unit,"0") <= 0)
            throw new InputError(502,"缺少额度单位");
          let rate = "1", unit = kind;
          if (kind === "CNY") rate = meta.usd_exchange_rate;
          else if (kind === "CUSTOM") {
            rate = meta.custom_currency_exchange_rate;
            unit = typeof meta.custom_currency_symbol === "string" ? meta.custom_currency_symbol.slice(0,16) : "";
          } else if (kind !== "USD") throw new InputError(502,"未知币种");
          if (!unit || !decimal(rate) || ctx.decimal.compare(rate,"0") <= 0) throw new InputError(502,"缺少汇率");
          snapshot.amount = ctx.decimal.multiply(ctx.decimal.divide(data.quota,meta.quota_per_unit),rate);
          snapshot.unit = unit; snapshot.note = "按站点 /api/status 单位与汇率换算";
        }
      } catch (error) {
        if (cancelled(error)) throw error;
        snapshot.note = "币种/换算信息不可用，显示原始 quota";
      }
    }
    return { snapshot, checkedAt, error: null };
  } catch (error) {
    if (cancelled(error)) throw error;
    return { checkedAt, error: error instanceof InputError ? error.message : "余额查询失败，保留上次数据；未重试" };
  }
}
