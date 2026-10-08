import {
  InputError, day, enabled, acquire, renew, release, accountLock,
  cancelled, errorMessage, STATUS_LABELS, passwordAuth
} from "./common.mjs";
import { readAccount, persist, persistBalance, readAgentSession, persistAgentSession, forgetAgentSession } from "./accounts.mjs";
import { requestFor, loginRequest, interpret, businessAccepted } from "./adapters.mjs";
import { readBalance, agentSession, requireAgentSession, exactJson } from "./balance.mjs";
import { scheduleStamp } from "./schedule.mjs";
import { cronMatches, DEFAULT_CRON } from "./cron.mjs";
import { prepareWaf } from "./waf.mjs";
import { blocksUncertain, legacySuccessDay } from "./uncertainty.mjs";

/** @param {import("./common.mjs").Context} ctx */
export async function writeLog(ctx, result, taskName) {
  try {
    await ctx.tasks.writeLog({
      taskName, accountId: result.accountId, status: result.status, message: STATUS_LABELS[result.status] || result.status,
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
      || stamps?.[accountId] !== scheduleStamp(ctx,record.config) || !cronMatches(DEFAULT_CRON,slot)))
      return finish("Skipped","排队中的定时配置已变化或超过 30 分钟，未执行过期计划");
    if (record.credential.fields.lastSuccessDay === day() ||
        legacySuccessDay(record.config,record.credential.fields) === day())
      return finish("Skipped", "本地已确认今日成功，未重复发送");
    if (blocksUncertain(record.config,record.credential.fields) && !acknowledgeUncertain)
      return finish("Skipped", "上次结果不确定；请先到站点确认，再手动确认是否重新发送");
    const origin = ctx.url.parse(record.config.baseUrl).origin;
    if (!(await ctx.http.approvedOrigins()).includes(origin))
      throw new InputError(403, "站点 origin 未授权，未发送签到请求");
    if (passwordAuth(record.config)) {
      gate = await acquire(ctx, "agent:" + ctx.crypto.sha256(origin));
      if (!gate) return finish("Skipped", "同站点已有登录任务，未并发发送");
    }
    client = await ctx.http.createClient({route:record.config.route,allowDirectFallback:false});
    const prepared = await prepareWaf(ctx,record.config,client,async()=>{
      await renew(ctx,lease);
      if (gate) await renew(ctx,gate);
    });
    if (prepared.error) {
      outcome = finish(prepared.error.status,prepared.error.message,{httpStatus:prepared.error.httpStatus});
      await renew(ctx,lease);
      await persist(ctx,record,outcome);
      return outcome;
    }
    await ctx.delay(0);
    await renew(ctx, lease);
    if (gate) await renew(ctx, gate);
    outcome = finish("Uncertain", "请求已准备发送，尚未确认结果；中断后请先到站点核实");
    await persist(ctx, record, outcome);
    pending = true;
    await renew(ctx, lease);
    if (gate) await renew(ctx, gate);
    dispatched = true;
    let session = null;
    let checkinConfig = prepared.config;
    if (passwordAuth(record.config) && record.config.siteType !== "AgentRouter") {
      const {route:loginRoute,...loginSpec} = loginRequest(prepared.config);
      const loginResponse = await client.request(loginSpec);
      const result = interpret("NewAPI",loginResponse);
      let loginData;
      try { loginData = exactJson(loginResponse.bodyText); } catch {}
      if (!businessAccepted(loginResponse) || loginData?.error != null && loginData.error !== false ||
          loginData?.data?.require_2fa || loginData?.data?.requires_2fa || loginData?.data?.two_factor_required ||
          loginData?.require_2fa || result.status === "Challenge") {
        const status = result.status === "Challenge" || loginData?.data?.require_2fa || loginData?.data?.requires_2fa ||
          loginData?.data?.two_factor_required || loginData?.require_2fa ? "Challenge"
          : ["AuthExpired","RateLimited","Uncertain"].includes(result.status) ? result.status : "Failed";
        outcome = finish(status,result.message,{httpStatus:result.httpStatus});
        if(status==="AuthExpired")await forgetAgentSession(ctx,record);
        await renew(ctx,lease);await persist(ctx,record,outcome,null,attemptId);
        return outcome;
      }
      try {
        session = agentSession(prepared.config,loginResponse);
        const path = ctx.url.parse(record.config.baseUrl).path.replace(/\/$/,"") +
          (record.config.siteType === "AnyRouter" ? "/api/user/sign_in" : "/api/user/checkin");
        requireAgentSession(session,path);
      } catch {
        outcome = finish("Failed",result.message,{httpStatus:result.httpStatus});
        await renew(ctx,lease);await persist(ctx,record,outcome,null,attemptId);
        return outcome;
      }
      await renew(ctx,lease);
      record.credential.fields.balanceSession = await persistAgentSession(ctx,record,session);
      await renew(ctx,lease);if(gate)await renew(ctx,gate);
      if (!(await ctx.http.approvedOrigins()).includes(origin)) throw new InputError(403,"站点 origin 已撤销，未发送签到");
      checkinConfig = {...prepared.config,...session};
    }
    const {route, ...spec} = requestFor(checkinConfig);
    const response = await client.request(spec);
    const interpreted = interpret(record.config.siteType === "AgentRouter" && !passwordAuth(record.config) ? "NewAPI" : record.config.siteType, response);
    outcome = finish(interpreted.status, interpreted.message, { httpStatus: interpreted.httpStatus });
    if(passwordAuth(record.config)&&outcome.status==="AuthExpired")await forgetAgentSession(ctx,record);
    const sameDay = day(Date.parse(startedAt)) === day();
    try {
      await renew(ctx, lease);
      await persist(ctx, record, outcome,
        sameDay && ["Success", "Already"].includes(outcome.status) ? day() : null, attemptId);
    } catch (error) {
      if (cancelled(error)) throw error;
      outcome.warning = errorMessage(error);
    }
    const accepted = (
      ["Success","Already"].includes(outcome.status) ||
      outcome.status === "Uncertain" && businessAccepted(response)
    );
    if (record.config.siteType === "AgentRouter" && passwordAuth(record.config) && accepted && !outcome.warning) {
      try { session = agentSession(prepared.config,response); }
      catch (error) { if (cancelled(error)) throw error; }
      try {
        await renew(ctx,lease);
        record.credential.fields.balanceSession = await persistAgentSession(ctx,record,session);
      } catch (error) {
        if (cancelled(error)) throw error;
        outcome.warning = errorMessage(error);
      }
    }
    if (record.config.queryBalance && !outcome.warning && accepted) {
      try {
        await renew(ctx,lease);
        const update = await readBalance(ctx,prepared.config,client,session);
        await renew(ctx,lease);
        const balance = await persistBalance(ctx,record,update);
        if (balance.error) outcome.warning = balance.error;
      } catch (error) {
        if (cancelled(error)) throw error;
        outcome.warning = errorMessage(error);
      }
    }
    return outcome;
  } catch (error) {
    if (cancelled(error)) throw error;
    const definitelyNotSent = ["host.denied", "host.proxy_pool_unavailable"].includes(error?.code);
    outcome = finish(dispatched && !definitelyNotSent ? "Uncertain" : "Failed",
      errorMessage(error),{httpStatus:error?.response?.statusCode ?? error?.response?.status ?? null});
    if (record && lease) {
      try { await renew(ctx, lease); await persist(ctx, record, outcome, null, pending ? attemptId : null); }
      catch (saveError) {
        if (cancelled(saveError)) throw saveError;
        outcome.warning = errorMessage(saveError);
      }
    }
    return outcome;
  } finally {
    if (client) { try { await client.close(); } catch {  } }
    await release(ctx, gate);
    await release(ctx, lease);
  }
}

/** @param {import("./common.mjs").Context} ctx */
export async function refreshBalance(ctx, accountId) {
  await readAccount(ctx,accountId);
  const lease = await acquire(ctx,accountLock(ctx,accountId));
  if (!lease) throw new InputError(409,"账号正在执行或编辑");
  let client;
  try {
    const current = await readAccount(ctx,accountId);
    if (!enabled(current)) throw new InputError(400,"账号已停用");
    if (!(await ctx.http.approvedOrigins()).includes(ctx.url.parse(current.config.baseUrl).origin))
      throw new InputError(403,"origin 未授权，未查询余额");
    let update;
    try {
      const session = passwordAuth(current.config) ? readAgentSession(ctx,current) : null;
      client = await ctx.http.createClient({route:current.config.route,allowDirectFallback:false});
      const prepared = await prepareWaf(ctx,current.config,client,()=>renew(ctx,lease));
      update = prepared.error ? {checkedAt:new Date().toISOString(),error:prepared.error.message}
        : await readBalance(ctx,prepared.config,client,session);
    } catch (error) {
      if (cancelled(error)) throw error;
      update = {checkedAt:new Date().toISOString(),error:errorMessage(error),
        ...(passwordAuth(current.config) && error instanceof InputError && error.status === 401 ? {authExpired:true} : {})};
    }
    await renew(ctx,lease);
    const balance = await persistBalance(ctx,current,update);
    return {total:1,completed:1,results:[{accountId,label:current.account.label,
      status:balance.error ? "Failed" : "Success",message:balance.error || "余额已更新"}]};
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
