import { endpoint, input, id, text, InputError, decode, flag } from "./common.mjs";
import * as accounts from "./accounts.mjs";
import { runBatch, refreshBalance } from "./runner.mjs";
import { DEFAULT_CRON, nextRuns } from "./cron.mjs";
import { enqueueDue } from "./schedule.mjs";

export const listAccounts = endpoint(accounts.listAccounts);
export const saveAccount = endpoint(accounts.saveAccount);
export const deleteAccount = endpoint(accounts.deleteAccount);
export function getModels() { return []; }
/** @param {import("./common.mjs").Context} ctx */
export function invoke(ctx) { return ctx.reply.error(400, "本插件仅提供签到和余额，不提供模型调用", { failureKind: "Plugin" }); }
/** @param {import("./common.mjs").Context} ctx */
export function validateCredential(ctx, credential) {
  try { decode(ctx, credential); return { success: true }; }
  catch (error) { return { success: false, error: error instanceof InputError ? error.message : "签到账号配置无效" }; }
}
function batchIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new InputError(400, "每批请选择 1–100 个账号");
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) throw new InputError(400, "账号 ID 不能重复");
  return ids;
}
export const startCheckIn = endpoint(async ctx => {
  const body = input(ctx.body);
  if (body.all === true && body.ids !== undefined) throw new InputError(400, "all 与 ids 不能同时指定");
  const ids = body.all === true ? await accounts.candidateIds(ctx, false) : batchIds(body.ids);
  if (!ids.length) throw new InputError(400, "没有可执行的账号");
  batchIds(ids);
  const acknowledgeUncertain = flag(body.acknowledgeUncertain, "确认重新发送", false);
  if (acknowledgeUncertain && (body.all || ids.length !== 1))
    throw new InputError(400, "不确定结果只能逐账号人工确认重新发送");
  for (const accountId of ids) await accounts.readAccount(ctx, accountId);
  if (!await ctx.state.shared.available()) throw new InputError(503, "Redis 共享状态不可用，未启动签到");
  const key = ctx.crypto.sha256(JSON.stringify([ids.slice().sort(), acknowledgeUncertain]));
  return ctx.json(202, await ctx.jobs.start("js-checkin-run", { ids, acknowledgeUncertain }, { key }));
});
/** @param {import("./common.mjs").Context} ctx */
export async function checkInJob(ctx, payload) {
  const body = input(payload), ids = batchIds(body.ids);
  const acknowledgeUncertain = flag(body.acknowledgeUncertain, "确认重新发送", false);
  if (acknowledgeUncertain && ids.length !== 1) throw new InputError(400, "仅允许单账号确认");
  const automatic = flag(body.automatic,"自动任务",false);
  if (automatic && (acknowledgeUncertain || !Number.isSafeInteger(body.slot) || body.slot % 60000 !== 0))
    throw new InputError(400,"自动任务计划无效");
  if (automatic && (!body.stamps || ids.some(accountId => typeof body.stamps[accountId] !== "string")))
    throw new InputError(400,"缺少自动计划摘要");
  return runBatch(ctx, ids, { acknowledgeUncertain, automatic, slot:body.slot ?? null, stamps:body.stamps ?? null });
}
/** @param {import("./common.mjs").Context} ctx */
export async function dailyCheckIn(ctx) {
  await enqueueDue(ctx);
}
export const previewSchedule = endpoint(async ctx => {
  return ctx.json(200,{cron:DEFAULT_CRON,timezone:"UTC+8",next:nextRuns(DEFAULT_CRON)});
});
export const startBalance = endpoint(async ctx => {
  const accountId = id(input(ctx.body).id), record = await accounts.readAccount(ctx,accountId);
  if (record.config.siteType === "AgentRouter") throw new InputError(400,"AgentRouter 请使用登录并签到；不会单独登录查询余额");
  if (!await ctx.state.shared.available()) throw new InputError(503,"Redis 不可用，未启动查询");
  return ctx.json(202,await ctx.jobs.start("js-checkin-balance",{id:accountId},{key:ctx.crypto.sha256(accountId)}));
});
/** @param {import("./common.mjs").Context} ctx */
export async function balanceJob(ctx,payload) { return refreshBalance(ctx,id(input(payload).id)); }
export const jobStatus = endpoint(async ctx => {
  const jobId = text(ctx.query?.id, "任务 ID", 128, true);
  const job = await ctx.jobs.get(jobId);
  if (!job || !["js-checkin-run","js-checkin-balance"].includes(job.name)) throw new InputError(404, "任务不存在、已过期或不属于当前版本");
  return ctx.json(200, job);
});
export const cancelJob = endpoint(async ctx => {
  const jobId = text(input(ctx.body).id, "任务 ID", 128, true);
  const job = await ctx.jobs.get(jobId);
  if (!job || !["js-checkin-run","js-checkin-balance"].includes(job.name)) throw new InputError(404, "任务不存在、已过期或不属于当前版本");
  return ctx.json(200, { accepted: await ctx.jobs.cancel(jobId) });
});
