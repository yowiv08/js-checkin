import { day, resultData } from "./common.mjs";

// 仅从完整的成功响应和同日时间戳推导签到日期。
export function legacySuccessDay(config, fields, now = Date.now()) {
  const result = resultData(fields);
  if (result?.status !== "Uncertain" ||
      config.siteType !== "AnyRouter" || result.httpStatus !== 200) return null;
  const started = Date.parse(result.startedAt), finished = Date.parse(result.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) ||
      finished < started || finished > now || day(started) !== day(finished)) return null;
  try {
    const body = JSON.parse(result.message);
    return body?.success === true && body.message === "" &&
      Object.keys(body).every(key => key === "success" || key === "message") ? day(finished) : null;
  } catch { return null; }
}
export function blocksUncertain(config, fields, now = Date.now()) {
  if (resultData(fields)?.status !== "Uncertain") return false;
  const successDay = legacySuccessDay(config, fields, now);
  return !successDay || successDay === day(now);
}
