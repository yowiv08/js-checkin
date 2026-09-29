import {
  InputError, input, text, id, configFrom, decode, identity, resultData,
  enabled, baseUrl, acquire, release, accountLock, cancelled
} from "./common.mjs";

/** @param {import("./common.mjs").Context} ctx */
export async function readAccount(ctx, accountId) {
  const account = await ctx.accounts.get(id(accountId));
  if (!account || account.platform !== ctx.platform) throw new InputError(404, "账号不存在或不属于当前插件");
  const snapshot = await ctx.accounts.readCredentials(account.id);
  if (snapshot.credential.kind !== "Custom") throw new InputError(400, "需要 Custom 凭据");
  return { account, version: snapshot.version, credential: snapshot.credential, config: decode(ctx, snapshot.credential) };
}
export function card(record) {
  const c = record.config;
  return {
    id: record.account.id, version: record.version, label: record.account.label || record.account.id,
    siteType: c.siteType, baseUrl: c.baseUrl, route: c.route,
    enabled: c.enabled, autoCheckIn: c.autoCheckIn, available: enabled(record),
    cron: c.cron, queryBalance: c.queryBalance, balance: balanceData(record.credential.fields),
    userAgent: c.userAgent, userId: c.userId, username: c.username,
    cookie: c.cookie, password: c.password,
    hasCookie: !!c.cookie, hasPassword: !!c.password,
    lastResult: resultData(record.credential.fields),
    lastSuccessDay: record.credential.fields.lastSuccessDay || null
  };
}
/** @param {import("./common.mjs").Context} ctx */
export async function listAccounts(ctx) {
  const accounts = await ctx.accounts.list({ includeCredentials: true });
  const rows = accounts.map(account => {
    try {
      return card({ account, version: account.credentialVersion, credential: account.credential, config: decode(ctx, account.credential) });
    } catch {
      return { id: account.id, version: account.credentialVersion, label: account.label || account.id,
        invalid: true, available: false, error: "账号配置损坏，可删除后重新添加" };
    }
  });
  return ctx.json(200, { accounts: rows, jobs: await ctx.jobs.list(), schedule: "每账号自定义 Cron · 默认每日 10:10（UTC+8）" });
}
/** @param {import("./common.mjs").Context} ctx */
export async function saveAccount(ctx) {
  const body = input(ctx.body);
  let lock = null;
  try {
    let previous;
    if (body.id) {
      id(body.id);
      lock = await acquire(ctx, accountLock(ctx, body.id));
      if (!lock) throw new InputError(409, "账号正在执行或编辑，请稍后重试");
      previous = await readAccount(ctx, body.id);
      if (body.version !== previous.version) throw new InputError(409, "账号已被修改，请刷新后再编辑");
    }
    const config = configFrom(ctx, body, previous?.config);
    const label = text(body.label ?? previous?.account.label ?? "", "账号名称", 128, true).trim();
    const origin = baseUrl(ctx, config.baseUrl).origin;
    const approved = await ctx.http.approvedOrigins();
    if (!approved.includes(origin)) {
      if (body.approveOrigin !== true) throw new InputError(400, "请明确勾选授权此 HTTPS origin");
      await ctx.http.approveOrigin(origin);
    }
    /** @type {Record<string, string | null>} */
    const fields = { ...previous?.credential.fields, config: JSON.stringify(config) };
    if (!previous || identity(ctx, previous.config) !== identity(ctx, config)) {
      delete fields.lastSuccessDay;
      delete fields.lastResult;
      delete fields.balance;
    }
    let saved;
    if (previous) {
      saved = await ctx.accounts.compareExchangeCredential(previous.account.id, previous.version, { kind: "Custom", fields });
      if (!saved) throw new InputError(409, "账号已被修改或删除，未覆盖其他修改");
      await ctx.accounts.save({ id: previous.account.id, label });
    } else {
      saved = await ctx.accounts.save({ label, credential: { kind: "Custom", fields } });
    }
    return ctx.json(200, { account: card(await readAccount(ctx, saved.id)) });
  } finally { await release(ctx, lock); }
}
export function balanceData(fields) {
  try {
    const b = JSON.parse(fields.balance || "null");
    if (!objectBalance(b)) return null;
    return b;
  } catch { return null; }
}
function objectBalance(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && ["Fresh","Stale","Unknown"].includes(value.state);
}
/** @param {import("./common.mjs").Context} ctx */
export async function persistBalance(ctx, record, update) {
  for (let i = 0; i < 3; i++) {
    const current = await readAccount(ctx, record.account.id);
    if (identity(ctx,current.config) !== identity(ctx,record.config))
      throw new InputError(409, "认证身份变化，未保存旧余额");
    const previous = balanceData(current.credential.fields);
    const balance = update.snapshot
      ? { state: "Fresh", ...update }
      : { state: previous?.snapshot ? "Stale" : "Unknown", snapshot: previous?.snapshot ?? null, ...update };
    const fields = { ...current.credential.fields, balance: JSON.stringify(balance) };
    if (await ctx.accounts.compareExchangeCredential(current.account.id,current.version,{kind:"Custom",fields})) return balance;
  }
  throw new InputError(409, "余额保存发生并发冲突，未重发请求");
}
/** @param {import("./common.mjs").Context} ctx */
export async function deleteAccount(ctx) {
  const body = input(ctx.body), accountId = id(body.id);
  const lock = await acquire(ctx, accountLock(ctx, accountId));
  if (!lock) throw new InputError(409, "账号正在执行或编辑，暂不能删除");
  try {
    const account = await ctx.accounts.get(accountId);
    if (!account || account.platform !== ctx.platform) throw new InputError(404, "账号不存在或不属于当前插件");
    if (body.version !== account.credentialVersion) throw new InputError(409, "账号已变化，请刷新后再删除");
    await ctx.accounts.delete(accountId);
    return ctx.json(200, { deleted: true });
  } finally { await release(ctx, lock); }
}
/** @param {import("./common.mjs").Context} ctx */
export async function persist(ctx, record, result, successDay = null, expectedAttempt = null) {
  for (let tries = 0; tries < 3; tries++) {
    const current = await readAccount(ctx, record.account.id);
    if (identity(ctx, current.config) !== identity(ctx, record.config))
      throw new InputError(409, "账号身份已变化，旧结果未覆盖新配置");
    if (expectedAttempt && resultData(current.credential.fields)?.attemptId !== expectedAttempt)
      throw new InputError(409, "签到记录已被新的执行替换");
    /** @type {Record<string, string | null>} */
    const fields = { ...current.credential.fields, lastResult: JSON.stringify(result) };
    if (successDay) fields.lastSuccessDay = successDay;
    const saved = await ctx.accounts.compareExchangeCredential(current.account.id, current.version, { kind: "Custom", fields });
    if (saved) return;
  }
  throw new InputError(409, "结果保存发生并发冲突，未重发签到");
}
/** @param {import("./common.mjs").Context} ctx */
export async function candidateIds(ctx, automatic) {
  const result = [];
  for (const account of await ctx.accounts.list({ includeCredentials: true })) {
    try {
      const config = decode(ctx, account.credential);
      if (enabled({ account, config }) && (!automatic || config.autoCheckIn)) result.push(account.id);
    } catch (error) { if (cancelled(error)) throw error; }
  }
  return result;
}
