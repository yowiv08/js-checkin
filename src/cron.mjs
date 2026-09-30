export const DEFAULT_CRON = "0 10 10 * * *";
export const SCHEDULE_LABEL = "每天 10:10（UTC+8）";
const OFFSET = 8 * 3600000;
// 延迟触发沿用当天固定时刻，避免重复入队。
export function dailySlot(now = Date.now()) {
  const local = new Date(now + OFFSET);
  const slot = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),10,10) - OFFSET;
  return now >= slot && now - slot <= 1800000 ? slot : null;
}
export function parseCron(value = DEFAULT_CRON) {
  if (typeof value !== "string" || value.length > 160) throw Error("Cron 必须为不超过 160 字符的表达式");
  const parts = value.trim().split(/\s+/);
  if (parts.length === 5) parts.unshift("0");
  if (parts.length !== 6 || parts[0] !== "0") throw Error("Cron 使用五字段，或秒位固定为 0 的六字段");
  const limits = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  const sets = parts.slice(1).map((part, index) => {
    const [min,max] = limits[index], values = new Set();
    for (const item of part.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/([1-9]\d*))?$/.exec(item);
      if (!match) throw Error("Cron 仅支持数字、*、列表、范围和步长；不支持 ? L W # 或名称");
      const step = Number(match[2] || 1);
      const range = match[1] === "*" ? [min,max] : match[1].split("-").map(Number);
      const start = range[0], end = range[1] ?? (match[2] ? max : start);
      if (start < min || end > max || start > end || step > max - min + 1)
        throw Error("Cron 数值或步长超出范围");
      for (let n = start; n <= end; n += step) values.add(index === 4 && n === 7 ? 0 : n);
    }
    return [...values].sort((a,b) => a-b);
  });
  return { expression: parts.join(" "), sets, domAny: parts[3] === "*", dowAny: parts[5] === "*" };
}
function dateMatches(parsed, date) {
  const [, , days, months, weekdays] = parsed.sets;
  if (!months.includes(date.getUTCMonth() + 1)) return false;
  const dom = days.includes(date.getUTCDate()), dow = weekdays.includes(date.getUTCDay());
  return parsed.domAny ? dow : parsed.dowAny ? dom : dom || dow;
}
export function cronMatches(value, now = Date.now()) {
  const parsed = typeof value === "string" ? parseCron(value) : value, date = new Date(now + OFFSET);
  return dateMatches(parsed, date) && parsed.sets[0].includes(date.getUTCMinutes()) && parsed.sets[1].includes(date.getUTCHours());
}
export function nextRuns(value, now = Date.now(), count = 3) {
  const parsed = parseCron(value), result = [], local = new Date(now + OFFSET);
  const midnight = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());
  for (let d = 0; d < 366 * 5 && result.length < count; d++) {
    const start = midnight + d * 86400000;
    if (!dateMatches(parsed,new Date(start))) continue;
    for (const hour of parsed.sets[1]) {
      if (start + (hour + 1) * 3600000 - OFFSET <= now) continue;
      for (const minute of parsed.sets[0]) {
        const at = start + hour * 3600000 + minute * 60000 - OFFSET;
        if (at > now) result.push(new Date(at).toISOString());
        if (result.length >= count) return result;
      }
    }
  }
  return result;
}
