/** @typedef {import("../sdk/index").PluginContext} Context */
import { exceptionMessage, RESPONSE_LIMIT } from "./diagnostics.mjs";
export class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const TYPES = ["NewAPI", "AnyRouter", "AgentRouter"];
export const DEFAULTS = { NewAPI: "", AnyRouter: "https://anyrouter.top", AgentRouter: "https://agentrouter.org" };
export const passwordAuth = config => (config.authMode ?? (config.siteType === "AgentRouter" ? "password" : "cookie")) === "password";
export const STATUS_LABELS = {
  Success: "签到成功", Already: "今日已签到", Skipped: "已跳过",
  AuthExpired: "认证失效", Challenge: "需要人机验证", RateLimited: "请求限流",
  Failed: "签到失败", Uncertain: "结果不确定"
};
export const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const cancelled = error => error?.code === "host.cancelled" || error?.name === "AbortError";
export const day = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export function errorMessage(error) {
  if (error instanceof InputError) return error.message;
  return exceptionMessage(error);
}
/** @param {(ctx: Context) => Promise<any>} handler */
export function endpoint(handler) {
  return async ctx => {
    try { return await handler(ctx); }
    catch (error) {
      if (cancelled(error)) throw error;
      return ctx.json(error instanceof InputError ? error.status : 503, { error: errorMessage(error) });
    }
  };
}
export function input(value) {
  if (!object(value)) throw new InputError(400, "正文必须是 JSON 对象");
  return value;
}
export function text(value, name, max = 256, required = false) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new InputError(400, `${name} 格式无效`);
  if (required && !value.trim()) throw new InputError(400, `请填写${name}`);
  return value;
}
export function id(value) { return text(value, "账号 ID", 64, true); }
export function flag(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InputError(400, `${name} 必须是布尔值`);
  return value;
}
/** @param {Context} ctx */
export function baseUrl(ctx, value) {
  const raw = text(value, "HTTPS 站点地址", 1024, true).trim();
  if (!/^https:\/\/[^/?#@\\\s]+(?:\/[^?#\\\s]*)?$/i.test(raw)
    || /%(?:2e|2f|5c|3f|23|40|25)/i.test(raw) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw))
    throw new InputError(400, "地址必须为 HTTPS，不得包含凭据、查询、片段或路径穿越");
  const parsed = ctx.url.parse(raw);
  if (parsed.scheme !== "https" || parsed.query || parsed.fragment) throw new InputError(400, "HTTPS 地址无效");
  return { url: parsed.href.replace(/\/+$/, ""), origin: parsed.origin };
}
/** @param {Context} ctx */
export function configFrom(ctx, body, previous = undefined) {
  const siteType = body.siteType ?? previous?.siteType ?? "NewAPI";
  if (!TYPES.includes(siteType)) throw new InputError(400, "未知站点类型");
  const target = baseUrl(ctx, body.baseUrl ?? previous?.baseUrl ?? DEFAULTS[siteType]);
  const changedSite = previous && (siteType !== previous.siteType || target.origin !== ctx.url.parse(previous.baseUrl).origin);
  const route = body.route ?? previous?.route ?? "direct";
  if (!["direct", "pool"].includes(route)) throw new InputError(400, "网络路线仅支持 direct 或 pool");
  const authMode = body.authMode ?? (body.cookie ? "cookie" : body.username ? "password" :
    (previous?.siteType === siteType ? previous.authMode : undefined) ?? (siteType === "AgentRouter" ? "password" : "cookie"));
  if (!["cookie","password"].includes(authMode)) throw new InputError(400,"认证方式仅支持 cookie 或 password");
  const config = {
    siteType, authMode, baseUrl: target.url, route,
    enabled: flag(body.enabled, "启用状态", previous?.enabled ?? true),
    autoCheckIn: flag(body.autoCheckIn, "自动签到", previous?.autoCheckIn ?? false),
    queryBalance: flag(body.queryBalance, "签到后更新余额", previous?.queryBalance ?? true),
    userAgent: text(body.userAgent ?? previous?.userAgent ?? "", "User-Agent", 512).trim(),
    cookie: "", userId: "", username: "", password: ""
  };
  if (passwordAuth(config)) {
    config.username = text(body.username ?? previous?.username ?? "", "用户名或邮箱", 256, true).trim();
    const supplied = text(body.password ?? "", "密码", 4096);
    const changedUser = previous && config.username !== previous.username;
    config.password = supplied || (!changedSite && !changedUser ? previous?.password : "") || "";
    if (!config.password) throw new InputError(400, "请填写密码；更换站点或用户名后必须重新填写");
  } else {
    config.userId = text(body.userId ?? previous?.userId ?? "", "User ID", 40, true).trim();
    if (!/^[1-9]\d{0,39}$/.test(config.userId)) throw new InputError(400, "User ID 必须是正整数字符串");
    const supplied = text(body.cookie ?? "", "Cookie", 16384).trim();
    const changedUser = previous && config.userId !== previous.userId;
    config.cookie = supplied || (!changedSite && !changedUser ? previous?.cookie : "") || "";
    if (!config.cookie || !config.cookie.split(";").every(pair => /^[!#$%&'*+\-.^_`|~\w]+=[^\r\n;]*$/.test(pair.trim())))
      throw new InputError(400, "请填写有效的请求 Cookie（name=value）；更换站点或 User ID 后必须重新填写");
  }
  return config;
}
/** @param {Context} ctx */
export function identity(ctx, config) {
  const values = [
    config.siteType, config.baseUrl, config.userId, config.username, config.cookie, config.password
  ];
  if (passwordAuth(config) !== (config.siteType === "AgentRouter")) values.push(config.authMode);
  return ctx.crypto.sha256(JSON.stringify(values));
}
/** @param {Context} ctx */
export function decode(ctx, credential) {
  if (credential?.kind !== "Custom" || !object(credential.fields)) throw new InputError(400, "需要 Custom 凭据");
  let stored;
  try { stored = JSON.parse(credential.fields.config); } catch { throw new InputError(400, "账号配置损坏，请重新编辑"); }
  return configFrom(ctx, input(stored));
}
export function resultData(fields) {
  try {
    const value = JSON.parse(fields.lastResult || "null");
    if (!object(value) || !Object.hasOwn(STATUS_LABELS, value.status)) return null;
    return {
      status: value.status, message: typeof value.message === "string" ? value.message.slice(0, RESPONSE_LIMIT + 2) : STATUS_LABELS[value.status],
      startedAt: value.startedAt ?? null, finishedAt: value.finishedAt ?? null,
      httpStatus: Number.isInteger(value.httpStatus) ? value.httpStatus : null,
      attemptId: typeof value.attemptId === "string" ? value.attemptId : null
    };
  } catch { return null; }
}
export const enabled = record => record.config.enabled && record.account.status?.state === "Active";

/** @param {Context} ctx */
export async function acquire(ctx, key, ttlSeconds = 180) {
  const store = ctx.state.shared;
  if (!await store.available()) throw new InputError(503, "Redis 共享状态不可用，未执行签到或修改");
  const owner = ctx.crypto.randomUUID();
  if (!await store.putIfAbsent(key, owner, { ttlSeconds })) return null;
  return { key, owner, ttlSeconds };
}
/** @param {Context} ctx */
export async function renew(ctx, lock) {
  if (!await ctx.state.shared.compareExchange(lock.key, lock.owner, lock.owner, { ttlSeconds: lock.ttlSeconds }))
    throw new InputError(409, "执行锁已失效，未发送新的签到请求");
}
/** @param {Context} ctx */
export async function release(ctx, lock) {
  if (!lock) return;
  try { await ctx.state.shared.compareExchange(lock.key, lock.owner, undefined); }
  catch {  }
}
/** @param {Context} ctx */
export const accountLock = (ctx, accountId) => "account:" + ctx.crypto.sha256(accountId);
