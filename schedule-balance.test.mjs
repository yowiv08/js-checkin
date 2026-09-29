import {test} from "node:test";
import assert from "node:assert/strict";
import {parseCron,cronMatches,nextRuns,DEFAULT_CRON} from "./src/cron.mjs";
import {configFrom,decode,day,acquire,accountLock} from "./src/common.mjs";
import {runOne,refreshBalance} from "./src/runner.mjs";
import {readAccount,persistBalance} from "./src/accounts.mjs";
import {exactJson,agentSession} from "./src/balance.mjs";
import * as plugin from "./src/plugin.mjs";
import {fixture,response,cancellation} from "./test-host.mjs";

test("Cron 默认/五六字段/UTC+8/列表范围步长和星期日 7",()=>{
  assert.equal(parseCron().expression,DEFAULT_CRON);
  assert.equal(parseCron("10 10 * * *").expression,DEFAULT_CRON);
  assert.ok(cronMatches(DEFAULT_CRON,Date.parse("2026-09-29T02:10:30Z")));
  assert.ok(!cronMatches(DEFAULT_CRON,Date.parse("2026-09-29T10:10:00Z")));
  assert.ok(cronMatches("0 */15 9-17 * 1,9 1-5",Date.parse("2026-09-29T02:15:00Z")));
  assert.ok(cronMatches("0 0 8 * * 7",Date.parse("2026-10-04T00:00:00Z")));
  assert.ok(cronMatches("0 0 8 1 * 1",Date.parse("2026-10-05T00:00:00Z")),"DOM/DOW OR");
});
test("Cron 无效输入、非法秒位、无效步长及超大表达式被拒绝",()=>{
  for(const value of ["","* * *","1 * * * * *","*/5 * * * * *","60 10 * * *","0 24 * * *","0 10 0 * *",
    "0 10 * 13 *","0 10 * * 8","0 10 ? * *","0 10 * * MON","0 10 * * 1#2","*/0 * * * *","*/99 * * * *","4-2 * * * *","0".repeat(161),7])
    assert.throws(()=>parseCron(value));
});
test("Cron 预览严格在将来、跨天、闰年、无效日有界返回",()=>{
  assert.deepEqual(nextRuns(DEFAULT_CRON,Date.parse("2026-09-29T02:10:00Z"),1),["2026-09-30T02:10:00.000Z"]);
  assert.deepEqual(nextRuns("0 0 * * *",Date.parse("2026-09-29T15:59:00Z"),1),["2026-09-29T16:00:00.000Z"]);
  assert.deepEqual(nextRuns("0 0 29 2 *",Date.parse("2026-09-29T00:00:00Z"),1),["2028-02-28T16:00:00.000Z"]);
  assert.deepEqual(nextRuns("0 0 31 2 *"),[]);
});
test("旧配置迁移 Cron / 默认查询余额；预览/保存/校验没有远端请求",async()=>{
  const f=fixture(),a=f.seed(),stored=JSON.parse(a.credential.fields.config);
  delete stored.cron;delete stored.queryBalance;a.credential.fields.config=JSON.stringify(stored);
  const c=decode(f.ctx(),a.credential);assert.equal(c.cron,DEFAULT_CRON);assert.equal(c.queryBalance,true);
  const preview=await plugin.previewSchedule(f.ctx({cron:"30 9 * * 1-5"}));
  assert.equal(preview.statusCode,200);assert.equal(preview.body.next.length,3);
  assert.equal((await plugin.previewSchedule(f.ctx({cron:"bad"}))).statusCode,400);
  const out=await plugin.saveAccount(f.ctx({id:a.id,version:"1",cron:"30 9 * * *",queryBalance:false}));
  assert.equal(out.body.account.cron,"0 30 9 * * *");assert.equal(out.body.account.queryBalance,false);
  assert.equal(f.calls.length,0);
  assert.throws(()=>configFrom(f.ctx(),{...stored,cron:"invalid"}));
});
test("默认 10:10 才入队，重复/多实例同一 slot 不重复；ticker 不运行 HTTP",async t=>{
  let clock=Date.parse("2026-09-29T02:09:00Z");t.mock.method(Date,"now",()=>clock);
  const f=fixture(),a=f.seed();await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,0);
  clock+=60000;
  await Promise.all([plugin.dailyCheckIn(f.ctx()),plugin.dailyCheckIn(f.ctx())]);
  assert.equal(f.jobs.size,1);assert.equal(f.calls.length,0);
  const job=[...f.jobs.values()][0];assert.deepEqual(job.input.ids,[a.id]);
  assert.doesNotMatch(JSON.stringify(job.input),/COOKIE_SECRET|PASSWORD_SECRET|username|cookie/);
  job.state="Completed";await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,1);
});
test("自动 job 排队期间修改 Cron / 认证 / 开关或过期会跳过",async t=>{
  let clock=Date.now();t.mock.method(Date,"now",()=>clock);
  for(const changed of [{cron:"0 1 1 * * *"},{cookie:"session=NEW"},{autoCheckIn:false},{enabled:false},null]){
    const f=fixture(),a=f.seed("NewAPI",{cron:"* * * * *"});await plugin.dailyCheckIn(f.ctx());
    const job=[...f.jobs.values()][0];assert.ok(job);
    if(changed){const stored=JSON.parse(a.credential.fields.config);a.credential.fields.config=JSON.stringify({...stored,...changed})}
    else clock+=31*60000;
    const out=await plugin.checkInJob(f.ctx(),job.input);assert.equal(out.results[0].status,"Skipped");assert.equal(f.calls.length,0);
  }
});
test("超过 100 个到期账号分批，Redis 不可用拒绝调度，成功/未确认账号不入队",async()=>{
  const f=fixture();for(let i=0;i<101;i++)f.seed("NewAPI",{cron:"* * * * *"});
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,2);
  assert.deepEqual([...f.jobs.values()].map(j=>j.input.ids.length),[100,1]);
  f.available=false;await assert.rejects(plugin.dailyCheckIn(f.ctx()),/Redis/);
  const g=fixture(),a=g.seed("NewAPI",{cron:"* * * * *"}),b=g.seed("NewAPI",{cron:"* * * * *"});
  a.credential.fields.lastSuccessDay=day();b.credential.fields.lastResult=JSON.stringify({status:"Uncertain"});
  await plugin.dailyCheckIn(g.ctx());assert.equal(g.jobs.size,0);
});
test("lossless JSON 保留大整数及字符串内数字，不接受坏 JSON",()=>{
  assert.deepEqual(exactJson('{"id":90071992547409931234,"quota":12345678901234567890,"s":"x:42 \\"9\\"","success":true}'),
    {id:"90071992547409931234",quota:"12345678901234567890",s:'x:42 "9"',success:true});
  assert.throws(()=>exactJson('{"quota":01}'));assert.throws(()=>exactJson("x".repeat(1024*1024+1)));
});
const status=()=>response({success:true,data:{quota_per_unit:500000,quota_display_type:"USD"}});
const storedBalance=a=>JSON.parse(a.credential.fields.balance);
function cookieHandler(spec){
  if(spec.method==="POST")return response({success:true,message:"签到成功"});
  if(spec.url.endsWith("/api/user/self"))return response({success:true,data:{quota:12500000,used_quota:100}});
  if(spec.url.endsWith("/api/status"))return status();
  throw Error("unexpected");
}
test("New API 签到后余额：固定客户端、Cookie UID、无重定向、status 不带秘密",async()=>{
  const f=fixture(),a=f.seed("NewAPI",{queryBalance:true,route:"pool",userAgent:"UA"});
  f.handler=cookieHandler;const out=await runOne(f.ctx(),a.id);assert.equal(out.status,"Success");
  assert.deepEqual(f.calls.map(c=>[c.method,new URL(c.url).pathname]),[["POST","/api/user/checkin"],["GET","/api/user/self"],["GET","/api/status"]]);
  const self=f.calls[1];assert.equal(self.headers.cookie,"session=COOKIE_SECRET");assert.equal(self.headers["user-agent"],"UA");
  assert.equal(self.headers["new-api-user"],"90071992547409931234");assert.equal(self.body,undefined);
  assert.equal(self.followRedirects,false);assert.equal(self.allowDirectFallback,false);
  assert.deepEqual(f.calls[2].headers,{accept:"application/json",origin:"https://new.example",referer:"https://new.example/","user-agent":"UA"});
  assert.equal(new Set(f.calls.map(c=>c.client)).size,1);assert.ok(f.clients.every(c=>c.closed));
  assert.equal(storedBalance(a).snapshot.amount,"25");assert.equal(storedBalance(a).snapshot.unit,"USD");
  assert.equal(a.credential.fields.lastSuccessDay,day());assert.equal(storedBalance(a).state,"Fresh");
});
test("AnyRouter GET self 不登录，精确大整数按 500000 换算；负数/零不当作未知",async()=>{
  const f=fixture(),a=f.seed("AnyRouter",{queryBalance:true});
  f.handler=async spec=>spec.method==="POST"?response({success:false,message:"今日已签到"}):
    response('{"success":true,"data":{"quota":90071992547409931234}}');
  assert.equal((await runOne(f.ctx(),a.id)).status,"Already");
  assert.equal(f.calls.length,2);assert.equal(f.probes.length,1);assert.equal(storedBalance(a).snapshot.amount,"180143985094819.862468");
  for(const quota of ["0","-500000"]){
    const g=fixture(),b=g.seed("AnyRouter");g.handler=async()=>response(`{"success":true,"data":{"quota":${quota}}}`);
    await refreshBalance(g.ctx(),b.id);assert.equal(storedBalance(b).snapshot.amount,quota==="0"?"0":"-1");
  }
});
for(const [kind,extra,unit,amount] of [
  ["CNY",{usd_exchange_rate:7},"CNY","175"],
  ["CUSTOM",{custom_currency_symbol:"€",custom_currency_exchange_rate:0.9},"€","22.5"],
  ["TOKENS",{},"quota","12500000"],
  ["CUSTOM",{},"quota","12500000"]
])test(`余额按站点单位 ${kind} ${unit}，无法换算则保留 quota`,async()=>{
  const f=fixture(),a=f.seed("NewAPI",{queryBalance:true});
  f.handler=async spec=>spec.url.endsWith("/api/status")?response({success:true,data:{quota_per_unit:500000,quota_display_type:kind,...extra}}):cookieHandler(spec);
  await runOne(f.ctx(),a.id);
  assert.equal(storedBalance(a).snapshot.amount,amount);assert.equal(storedBalance(a).snapshot.unit,unit);
});
test("status WAF 不隐藏已查到的原始 quota；自定义 AnyRouter origin 不套官方汇率",async()=>{
  const f=fixture(),a=f.seed("AnyRouter",{baseUrl:"https://custom.example",queryBalance:true});
  f.handler=async spec=>spec.url.endsWith("/api/status")?response("acw_sc__v2",403):cookieHandler(spec);
  await runOne(f.ctx(),a.id);assert.equal(storedBalance(a).snapshot.unit,"quota");assert.equal(storedBalance(a).state,"Fresh");
});
for(const [label,reply] of [
  ["HTML",()=>response("<html>login</html>")],["Cookie失效",()=>response({success:false,message:"未登录"})],
  ["WAF",()=>response("acw_sc__v2",403)],["限流",()=>response("",429)],
  ["缺quota",()=>response({success:true,data:{}})],["业务失败",()=>response({success:false,data:{quota:0}})],
  ["超时",()=>{throw Error("timeout COOKIE_SECRET")}]
])test(`余额${label}独立失败，不改变签到成功且不重放 POST`,async()=>{
  const f=fixture(),a=f.seed("NewAPI",{queryBalance:true});
  f.handler=async spec=>spec.method==="POST"?cookieHandler(spec):reply();
  const out=await runOne(f.ctx(),a.id);assert.equal(out.status,"Success");assert.ok(out.warning);
  assert.equal(JSON.parse(a.credential.fields.lastResult).status,"Success");
  assert.equal(storedBalance(a).state,"Unknown");assert.equal(storedBalance(a).snapshot,null);
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");
  if(label==="超时")assert.equal(storedBalance(a).error,"timeout COOKIE_SECRET");
});
test("余额刷新失败保留上次余额，并标旧数据；不修改签到结果",async()=>{
  const f=fixture(),a=f.seed("NewAPI");f.handler=cookieHandler;
  await refreshBalance(f.ctx(),a.id);assert.equal(storedBalance(a).snapshot.amount,"25");
  const first=storedBalance(a).snapshot.updatedAt;f.handler=async()=>response("",401);
  await refreshBalance(f.ctx(),a.id);assert.equal(storedBalance(a).state,"Stale");
  assert.equal(storedBalance(a).snapshot.amount,"25");assert.equal(storedBalance(a).snapshot.updatedAt,first);
  assert.equal(a.credential.fields.lastResult,undefined);assert.ok(f.calls.every(c=>c.method==="GET"));
});
function login(checked=false,headers=["session=TEMP_ONLY; Path=/; HttpOnly; Secure"]){
  const r=response('{"success":true,"data":{"id":90071992547409931234'+(checked===null?'':`,"checked_in":${checked}`)+'}}');
  r.headers={"set-cookie":headers};return r;
}
test("Agent 登录后复用临时 Cookie + 精确 UID + 同代理；会话不持久化",async()=>{
  const f=fixture(),a=f.seed("AgentRouter",{queryBalance:true,route:"pool"});
  f.handler=async spec=>spec.method==="POST"?login():cookieHandler(spec);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Success");
  assert.equal(f.calls[0].url,"https://agentrouter.org/api/user/login");
  assert.equal(f.calls[1].headers.cookie,"session=TEMP_ONLY");
  assert.equal(f.calls[1].headers["new-api-user"],"90071992547409931234");
  assert.equal(new Set(f.calls.map(c=>c.client)).size,1);
  assert.equal(storedBalance(a).snapshot.amount,"25");
  assert.doesNotMatch(JSON.stringify(a.credential),/TEMP_ONLY/);
  assert.ok(!f.calls.some(c=>c.url.endsWith("sign_in")||c.url.endsWith("checkin")));
  assert.equal((await plugin.startBalance(f.ctx({id:a.id}))).statusCode,400);
  await assert.rejects(refreshBalance(f.ctx(),a.id),/不会为刷新/);
});
test("Agent 缺签到标志即使余额成功仍为未确认；缺会话不登录第二次",async()=>{
  for(const headers of [["session=TEMP_ONLY; Path=/"],[]]){
    const f=fixture(),a=f.seed("AgentRouter",{queryBalance:true});
    f.handler=async spec=>spec.method==="POST"?login(null,headers):cookieHandler(spec);
    assert.equal((await runOne(f.ctx(),a.id)).status,"Uncertain");
    assert.equal(a.credential.fields.lastSuccessDay,undefined);
    assert.equal(storedBalance(a).state,headers.length?"Fresh":"Unknown");
    assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
  }
});
test("临时 session 拒绝不匹配 domain/path、失效、多义、控制字符；允许部署子路径",()=>{
  const f=fixture(),a=f.seed("AgentRouter"),c=decode(f.ctx(),a.credential);
  for(const headers of [
    ["session=X; Domain=evil.example"],["session=X; Path=/other"],["session=X; Max-Age=0"],
    ["session=X; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],["session=X\r\nCookie:Y"],
    ["session=X","session=Y"],["other=X"]
  ])assert.throws(()=>agentSession(c,login(false,headers)));
  assert.equal(agentSession({...c,baseUrl:c.baseUrl+"/sub"},login(false,["session=X; Path=/sub"])).cookie,"session=X");
});
test("余额 GET 取消发生在签到确认后：job 取消，确认记录保留，不伪造余额",async()=>{
  const f=fixture(),a=f.seed("NewAPI",{queryBalance:true});
  f.handler=async spec=>{if(spec.method==="POST")return cookieHandler(spec);f.aborted=true;throw cancellation()};
  await assert.rejects(runOne(f.ctx(),a.id),{code:"host.cancelled"});
  assert.equal(JSON.parse(a.credential.fields.lastResult).status,"Success");
  assert.equal(a.credential.fields.lastSuccessDay,day());assert.equal(a.credential.fields.balance,undefined);
});
test("余额 CAS 合并并发配置、冲突不重放；更换身份清除旧余额",async()=>{
  const f=fixture(),a=f.seed();f.handler=cookieHandler;let conflict=false;
  f.casHook=async()=>{if(conflict)return;conflict=true;a.version++;const c=JSON.parse(a.credential.fields.config);c.cron="0 20 10 * * *";a.credential.fields.config=JSON.stringify(c)};
  await refreshBalance(f.ctx(),a.id);assert.equal(JSON.parse(a.credential.fields.config).cron,"0 20 10 * * *");assert.equal(f.calls.length,2);
  const record=await readAccount(f.ctx(),a.id);
  await plugin.saveAccount(f.ctx({id:a.id,version:String(a.version),cookie:"session=NEW"}));
  assert.equal(a.credential.fields.balance,undefined);
  await assert.rejects(persistBalance(f.ctx(),record,{checkedAt:"x",error:"failed"}),/身份变化/);
  f.casHook=async()=>{a.version++};await assert.rejects(refreshBalance(f.ctx(),a.id),/并发冲突/);assert.equal(f.calls.length,4);
});
test("余额和签到共享账号锁、origin 归属校验，余额 job 只传 ID并防重",async()=>{
  const f=fixture(),a=f.seed();f.handler=cookieHandler;
  const one=await plugin.startBalance(f.ctx({id:a.id})),two=await plugin.startBalance(f.ctx({id:a.id}));
  assert.equal(one.body.id,two.body.id);assert.deepEqual(one.body.input,{id:a.id});
  await acquire(f.ctx(),accountLock(f.ctx(),a.id));
  await assert.rejects(refreshBalance(f.ctx(),a.id),/正在执行/);assert.equal(f.calls.length,0);
  f.state.clear();f.origins.clear();await assert.rejects(refreshBalance(f.ctx(),a.id),/未授权/);
  a.platform="foreign";assert.equal((await plugin.startBalance(f.ctx({id:a.id}))).statusCode,404);
});
test("余额查询建客户端失败仍保留旧值并标旧数据，不改签到、不回退直连",async()=>{
  const f=fixture(),a=f.seed("NewAPI",{route:"pool"});f.handler=cookieHandler;
  await refreshBalance(f.ctx(),a.id);const ctx=f.ctx();
  ctx.http.createClient=async()=>{throw Object.assign(Error("none"),{code:"host.proxy_pool_unavailable"})};
  await refreshBalance(ctx,a.id);assert.equal(storedBalance(a).state,"Stale");
  assert.equal(storedBalance(a).snapshot.amount,"25");assert.equal(storedBalance(a).error,"host.proxy_pool_unavailable: none");
  assert.equal(f.calls.length,2);assert.equal(a.credential.fields.lastResult,undefined);
});
test("入队失败不在同一 slot 重试；计划不会泄露凭据或触发 POST",async()=>{
  const f=fixture();f.seed("NewAPI",{cron:"* * * * *"});const ctx=f.ctx();let attempts=0;
  ctx.jobs.start=async()=>{attempts++;throw Error("queue full")};
  await assert.rejects(plugin.dailyCheckIn(ctx),/queue full/);
  await plugin.dailyCheckIn(ctx);assert.equal(attempts,1);assert.equal(f.calls.length,0);
});
