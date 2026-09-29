import { InputError } from "./common.mjs";
import { responseMessage } from "./diagnostics.mjs";

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";
const maxHtml = 256 * 1024;
const hex40 = /^[0-9a-f]{40}$/i;

function decodeKey(encoded) {
  if (!/^[a-zA-Z0-9+/]{1,2048}={0,2}$/.test(encoded)) return "";
  const data = encoded.replace(/=+$/, "");
  if (data.length % 4 === 1) return "";
  let bits = 0, buffer = 0, decoded = "";
  for (const character of data) {
    buffer = buffer * 64 + alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode(buffer >> bits);
      buffer &= (1 << bits) - 1;
    }
  }
  return buffer === 0 ? decoded : "";
}
function uniqueMatch(text, pattern) {
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}
export function solveWaf(html) {
  if (typeof html !== "string" || html.length > maxHtml) return null;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]));
  if (!scripts.length || scripts.length > 32) return null;
  const source = scripts.map(match => match[2]).join("\n");
  if (!source.includes("acw_sc__v2")) return null;
  const seed = uniqueMatch(source, /\b(?:var|let|const)\s+arg1\s*=\s*(['"])([^'"]*)\1/g)?.[2];
  const table = uniqueMatch(source, /\b(?:var|let|const)\s+N\s*=\s*\[([^\]]*)\]/g)?.[1];
  const permutation = uniqueMatch(source, /\b(?:var|let|const)\s+m\s*=\s*\[([^\]]*)\]/g)?.[1];
  if (!seed || !hex40.test(seed) || table === undefined || permutation === undefined) return null;
  const tokens = table.trim().replace(/,\s*$/, "").split(",");
  if (!tokens.length || tokens.length > 2048) return null;
  const keys = new Set();
  for (const token of tokens) {
    const match = token.trim().match(/^(['"])([a-zA-Z0-9+/=]*)\1$/);
    if (!match || match[2].length > 2048) return null;
    const key = decodeKey(match[2]);
    if (hex40.test(key) && key.toLowerCase() !== seed.toLowerCase()) keys.add(key.toLowerCase());
  }
  if (keys.size !== 1) return null;
  const entries = permutation.trim().replace(/,\s*$/, "").split(",").map(value => value.trim());
  if (entries.length !== 40 || entries.some(value => !/^(?:0x[0-9a-f]{1,2}|[1-9]\d?)$/i.test(value))) return null;
  const mapping = entries.map(Number);
  if (mapping.some(value => value < 1 || value > 40) || new Set(mapping).size !== 40) return null;
  const shuffled = mapping.map(position => seed[position - 1]).join("");
  const key = [...keys][0];
  let cookie = "";
  for (let i = 0; i < 40; i += 2)
    cookie += (parseInt(shuffled.slice(i, i + 2), 16) ^ parseInt(key.slice(i, i + 2), 16)).toString(16).padStart(2, "0");
  return `acw_sc__v2=${cookie}`;
}
export function mergeWafCookie(cookie, wafCookie) {
  if (!/^acw_sc__v2=[0-9a-f]{40}$/.test(wafCookie)) throw new Error("Invalid WAF cookie");
  return [...cookie.split(";").map(value => value.trim()).filter(value => value && !/^acw_sc__v2=/.test(value)), wafCookie].join("; ");
}
export function wafHeaders(config, headers) {
  const result = { ...headers, "user-agent": config.userAgent || DEFAULT_USER_AGENT };
  if (config.wafCookie) result.cookie = mergeWafCookie(result.cookie || "", config.wafCookie);
  return result;
}
function inspect(response) {
  const httpStatus = response.statusCode;
  const raw = typeof response.bodyText === "string" ? response.bodyText : "";
  const error = (status, message) => ({ status, message: responseMessage(response) || message, httpStatus });
  if (httpStatus === 429 || /http_ratelimit/i.test(raw)) return { error: error("RateLimited", "站点请求限流") };
  if (httpStatus >= 300 && httpStatus < 400) return { error: error("Failed", "站点返回重定向") };
  if (raw.length > maxHtml) return { error: error("Challenge", "WAF 验证响应过大") };
  if (httpStatus >= 500 || httpStatus === 408) return { error: error("Failed", "站点验证服务异常") };
  if (/cf-chl-|challenge-platform|turnstile|captcha|请按住滑块|访问验证|验证码/i.test(raw))
    return { error: error("Challenge", "站点需要人机验证") };
  if (/\bacw_sc__v2\b|\barg1\b|aliyun_waf/i.test(raw)) {
    const cookie = [200,403,412].includes(httpStatus) ? solveWaf(raw) : null;
    return cookie ? { cookie } : { error: error("Challenge", "WAF 验证格式不支持") };
  }
  let json;
  try { json = JSON.parse(raw); } catch { }
  if ((httpStatus >= 200 && httpStatus < 300 || httpStatus === 401) && json && typeof json === "object" && !Array.isArray(json))
    return {};
  return { error: error("Failed", "站点验证响应无法识别") };
}
/** @param {import("./common.mjs").Context} ctx
 * @param {import("../sdk/index").HttpClientHandle} client
 * @param {() => Promise<void>} touch */
export async function prepareWaf(ctx, config, client, touch) {
  const current = { ...config, userAgent: config.userAgent || DEFAULT_USER_AGENT, wafCookie: "" };
  const origin = ctx.url.parse(current.baseUrl).origin;
  const probe = async (cookie = "") => {
    await ctx.delay(0);
    await touch();
    if (!(await ctx.http.approvedOrigins()).includes(origin)) throw new InputError(403, "站点 origin 未授权");
    return client.request({
      url: current.baseUrl + "/api/user/self", method: "GET", responseType: "text",
      timeoutMs: 30000, followRedirects: false, allowDirectFallback: false,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": current.userAgent, origin, referer: current.baseUrl + "/",
        ...(cookie ? { cookie } : {})
      }
    });
  };
  const first = inspect(await probe());
  if (first.error) return { config: current, error: first.error };
  if (!first.cookie) return { config: current, error: null };
  await ctx.delay(3000);
  const response = await probe(first.cookie);
  const verified = inspect(response);
  if (verified.error) return { config: current, error: verified.error };
  if (verified.cookie) return {
    config: current, error: { status: "Challenge", message: responseMessage(response), httpStatus: response.statusCode }
  };
  return { config: { ...current, wafCookie: first.cookie }, error: null };
}
