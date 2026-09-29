import {
  InputError, day, enabled, resultData, acquire, renew, release, accountLock,
  cancelled, errorMessage
} from "./common.mjs";
import { readAccount, persist, persistBalance } from "./accounts.mjs";
import { requestFor, interpret } from "./adapters.mjs";
import { readBalance } from "./balance.mjs";
import { scheduleStamp } from "./schedule.mjs";
import { cronMatches } from "./cron.mjs";

/** @param {import("./common.mjs").Context} ctx */
export async function writeLog(ctx, result, taskName) {
  try {
    await ctx.tasks.writeLog({
      taskName, accountId: result.accountId, status: result.status, message: result.message,
      startedAt: result.startedAt, finishedAt: result.finishedAt,
      durationMs: Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)),
      details: { httpStatus: result.httpStatus ?? null, attemptId: result.attemptId ?? null }
    });
    return true;
  } catch (error) {
    if (cancelled(error)) throw error;
    return false;
  }
}

/** @param {import("./common.mjs").Context} ctx */
async function waitForAgent(ctx, config, accountLease) {
  const hash = ctx.crypto.sha256(ctx.url.parse(config.baseUrl).origin);
  const lock = await acquire(ctx, `agent:${hash}`);
  if (!lock) return null;
  try {
    const nextKey = `agent-next:${hash}`;
    const next = await ctx.state.shared.get(nextKey);
    if (next !== null && (typeof next !== "number" || !Number.isSafeInteger(next) || next > Date.now() + 120000))
      throw new InputError(503, "站点节流记录异常，请稍后重试");
    while (typeof next === "number" && next > Date.now()) {
      await ctx.delay(Math.min(5000, next - Date.now()));
      await renew(ctx, accountLease);
      await renew(ctx, lock);
    }
    return { ...lock, nextKey };
  } catch (error) {
    await release(ctx, lock);
    throw error;
  }
}

/** @param {import("./common.mjs").Context} ctx */
export async function runOne(ctx, accountId, { automatic = false, acknowledgeUncertain = false, slot = null, stamps = null } = {}) {
  const startedAt = new Date().toISOString();
  let record, lease, gate, client, dispatched = false, pending = false;
  const attemptId = ctx.crypto.randomUUID();
  let outcome;
  const finish = (status, message, extra = {}) => ({
    accountId, label: record?.account.label || accountId, status, message, attemptId,
    startedAt, finishedAt: new Date().toISOString(), httpStatus: null, warning: null, ...extra
  });
  try {
    record = await readAccount(ctx, accountId);
    if (!enabled(record) || automatic && !record.config.autoCheckIn)
      return finish("Skipped", "账号已停用或未开启自动签到");
    lease = await acquire(ctx, accountLock(ctx, accountId));
    if (!lease) return finish("Skipped", "账号已有执行或编辑操作，未重复发送");
    record = await readAccount(ctx, accountId);
    if (!enabled(record) || automatic && !record.config.autoCheckIn)
      return finish("Skipped", "账号已停用或未开启自动签到");
    if (automatic && slot !== null && (Date.now() < slot || Date.now() - slot > 1800000
      || stamps?.[accountId] !== scheduleStamp(ctx,record.config) || !cronMatches(record.config.cron,slot)))
      return finish("Skipped","排队中的定时配置已变化或超过 30 分钟，未执行过期计划");
    if (record.credential.fields.lastSuccessDay === day())
      return finish("Skipped", "本地已确认今日成功，未重复发送");
    if (resultData(record.credential.fields)?.status === "Uncertain" && !acknowledgeUncertain)
      return finish("Skipped", "上次结果不确定；请先到站点确认，再手动确认是否重新发送");
    const origin = ctx.url.parse(record.config.baseUrl).origin;
    if (!(await ctx.http.approvedOrigins()).includes(origin))
      throw new InputError(403, "站点 origin 未授权，未发送签到请求");
    if (record.config.siteType === "AgentRouter") {
      gate = await waitForAgent(ctx, record.config, lease);
      if (!gate) return finish("Skipped", "同站点已有登录任务，未并发发送");
    }
    client = await ctx.http.createClient({route:record.config.route,allowDirectFallback:false});
    await ctx.delay(0);
    await renew(ctx, lease);
    if (gate) await renew(ctx, gate);
    outcome = finish("Uncertain", "请求已准备发送，尚未确认结果；中断后请先到站点核实");
    await persist(ctx, record, outcome);
    pending = true;
    if (gate) await ctx.state.shared.set(gate.nextKey, Date.now() + 90000, { ttlSeconds: 240 });
    await renew(ctx, lease);
    if (gate) await renew(ctx, gate);
    dispatched = true;
    const {route, ...spec} = requestFor(record.config);
    const response = await client.request(spec);
    const interpreted = interpret(record.config.siteType, response);
    outcome = finish(interpreted.status, interpreted.message, { httpStatus: interpreted.httpStatus });
    const sameDay = day(Date.parse(startedAt)) === day();
    try {
      await renew(ctx, lease);
      await persist(ctx, record, outcome,
        sameDay && ["Success", "Already"].includes(outcome.status) ? day() : null, attemptId);
    } catch (error) {
      if (cancelled(error)) throw error;
      outcome.warning = "上游结果已返回，但本地记录未更新；保留未确认状态，不重发请求";
    }
    if (record.config.queryBalance && !outcome.warning && (
      ["Success","Already"].includes(outcome.status) ||
      record.config.siteType === "AgentRouter" && outcome.status === "Uncertain"
    )) {
      try {
        await renew(ctx,lease);
        const update = await readBalance(ctx,record.config,client,response);
        await renew(ctx,lease);
        const balance = await persistBalance(ctx,record,update);
        if (balance.error) outcome.warning = balance.error;
      } catch (error) {
        if (cancelled(error)) throw error;
        outcome.warning = "余额未能更新；签到结果不变，未重发任何 POST";
      }
    }
    return outcome;
  } catch (error) {
    if (cancelled(error)) throw error;
    const definitelyNotSent = ["host.denied", "host.proxy_pool_unavailable"].includes(error?.code);
    outcome = finish(dispatched && !definitelyNotSent ? "Uncertain" : "Failed",
      dispatched && !definitelyNotSent ? "请求发生传输或读取错误，无法确认 POST 是否生效，未重试" : errorMessage(error));
    if (record && lease) {
      try { await renew(ctx, lease); await persist(ctx, record, outcome, null, pending ? attemptId : null); }
      catch (saveError) {
        if (cancelled(saveError)) throw saveError;
        outcome.warning = "结果未能保存，请检查宿主；未重新发送请求";
      }
    }
    return outcome;
  } finally {
    if (client) { try { await client.close(); } catch {  } }
    if (gate && dispatched) {
      try { await ctx.state.shared.set(gate.nextKey, Date.now() + 60000, { ttlSeconds: 240 }); }
      catch {  }
    }
    await release(ctx, gate);
    await release(ctx, lease);
  }
}

/** @param {import("./common.mjs").Context} ctx */
export async function refreshBalance(ctx, accountId) {
  const record = await readAccount(ctx,accountId);
  if (record.config.siteType === "AgentRouter") throw new InputError(400,"AgentRouter 余额仅随登录签到更新；不会为刷新余额重新登录");
  const lease = await acquire(ctx,accountLock(ctx,accountId));
  if (!lease) throw new InputError(409,"账号正在执行或编辑");
  let client;
  try {
    const current = await readAccount(ctx,accountId);
    if (!enabled(current)) throw new InputError(400,"账号已停用");
    if (current.config.siteType === "AgentRouter") throw new InputError(409,"账号类型已变化");
    if (!(await ctx.http.approvedOrigins()).includes(ctx.url.parse(current.config.baseUrl).origin))
      throw new InputError(403,"origin 未授权，未查询余额");
    let update;
    try {
      client = await ctx.http.createClient({route:current.config.route,allowDirectFallback:false});
      update = await readBalance(ctx,current.config,client);
    } catch (error) {
      if (cancelled(error)) throw error;
      update = {checkedAt:new Date().toISOString(),error:errorMessage(error)};
    }
    await renew(ctx,lease);
    const balance = await persistBalance(ctx,current,update);
    return {total:1,completed:1,results:[{accountId,label:current.account.label,
      status:balance.error ? "Failed" : "Success",message:balance.error || "余额已更新；未执行签到"}]};
  } finally {
    if (client) { try { await client.close(); } catch {  } }
    await release(ctx,lease);
  }
}

/** @param {import("./common.mjs").Context} ctx */
export async function runBatch(ctx, ids, options = {}) {
  const results = [], taskName = options.automatic ? "js-checkin-daily" : "js-checkin-manual";
  if (ctx.job) await ctx.jobs.progress({ completed: 0, total: ids.length, results: [] });
  for (const accountId of ids) {
    await ctx.delay(0);
    if (ctx.job) await ctx.jobs.progress({ completed: results.length, total: ids.length, currentAccountId: accountId, results });
    const result = await runOne(ctx, accountId, options);
    if (!await writeLog(ctx, result, taskName)) result.warning = "任务日志写入失败，签到不会因此重发";
    results.push(result);
    if (ctx.job) await ctx.jobs.progress({ completed: results.length, total: ids.length, results });
  }
  const summary = {};
  for (const row of results) summary[row.status] = (summary[row.status] || 0) + 1;
  return { total: results.length, summary, results };
}
