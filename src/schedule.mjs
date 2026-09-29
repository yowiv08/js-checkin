import { InputError, decode, enabled, day, resultData } from "./common.mjs";
import { cronMatches } from "./cron.mjs";
/** @param {import("./common.mjs").Context} ctx */
export const scheduleStamp = (ctx, config) => ctx.crypto.sha256(JSON.stringify(config));

/** @param {import("./common.mjs").Context} ctx */
export async function enqueueDue(ctx) {
  const slot = Math.floor(Date.now()/60000)*60000, due = [];
  if (!await ctx.state.shared.available()) throw new InputError(503,"Redis 不可用，未调度自动签到");
  for (const account of await ctx.accounts.list({includeCredentials:true})) {
    if (account.credential?.kind !== "Custom") continue;
    let config;
    try { config = decode(ctx,account.credential); } catch { continue; }
    if (!enabled({account,config}) || !config.autoCheckIn || !cronMatches(config.cron,slot)) continue;
    const fields = account.credential.fields;
    if (fields.lastSuccessDay === day(slot) || resultData(fields)?.status === "Uncertain") continue;
    due.push({ id:account.id, stamp:scheduleStamp(ctx,config) });
  }
  for (let start = 0; start < due.length; start += 100) {
    const items = [];
    for (const item of due.slice(start,start+100)) {
      const key = `cron:${slot}:${ctx.crypto.sha256(item.id)}`;
      if (await ctx.state.shared.putIfAbsent(key,ctx.crypto.randomUUID(),{ttlSeconds:172800})) items.push(item);
    }
    if (!items.length) continue;
    await ctx.jobs.start("js-checkin-run",{
      ids:items.map(item=>item.id), automatic:true, slot,
      stamps:Object.fromEntries(items.map(item=>[item.id,item.stamp]))
    },{key:`cron:${slot}:${ctx.crypto.sha256(JSON.stringify(items))}`});
  }
}
