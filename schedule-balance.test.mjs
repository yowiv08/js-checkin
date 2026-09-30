import {test} from "node:test";
import assert from "node:assert/strict";
import {parseCron,cronMatches,nextRuns,DEFAULT_CRON,dailySlot} from "./src/cron.mjs";
import {configFrom,decode,day,acquire,accountLock} from "./src/common.mjs";
import {runOne,refreshBalance} from "./src/runner.mjs";
import {blocksUncertain} from "./src/uncertainty.mjs";
import {readAccount,persistBalance,card,readAgentSession,persistAgentSession} from "./src/accounts.mjs";
import {exactJson,agentSession} from "./src/balance.mjs";
import * as plugin from "./src/plugin.mjs";

test("AnyRouter 已接收空消息仅阻止当天，不永久封锁次日 Cron",async t=>{
  t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-09-29T15:59:00Z")});
  const f=fixture(),a=f.seed("AnyRouter",{cron:"* * * * *"});
  const previous={status:"Uncertain",httpStatus:200,message:'{"message":"","success":true}',
    startedAt:"2026-09-29T15:58:00Z",finishedAt:"2026-09-29T15:58:01Z"};
  a.credential.fields.lastResult=JSON.stringify(previous);
  const view=card(await readAccount(f.ctx(),a.id));
  assert.equal(view.lastResult.status,"Success");
  assert.equal(view.lastResult.message,previous.message);
  assert.equal(view.lastSuccessDay,"2026-09-29");
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,0);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");assert.equal(f.calls.length,0);
  t.mock.timers.setTime(Date.parse("2026-09-29T16:00:00Z"));
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,0);
  t.mock.timers.setTime(Date.parse("2026-09-30T02:10:00Z"));
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,1);
  f.handler=async spec=>spec.method==="POST"?response({success:true,message:""}):response({success:true});
  const job=[...f.jobs.values()][0];
  const out=await plugin.checkInJob(f.ctx(),job.input);
  assert.equal(out.results[0].status,"Success");
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
  assert.equal(a.credential.fields.lastSuccessDay,"2026-09-30");
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
});

test("跨日仍阻止超时、中断、异常正文、缺失或未来时间及其他站点",()=>{
  const now=Date.parse("2026-09-30T02:10:00Z");
  const base={status:"Uncertain",httpStatus:200,message:'{"message":"","success":true}',
    startedAt:"2026-09-29T02:10:00Z",finishedAt:"2026-09-29T02:10:01Z"};
  const blocked=(changes={},siteType="AnyRouter")=>blocksUncertain({siteType},
    {lastResult:JSON.stringify({...base,...changes})},now);
  assert.equal(blocked(),false);
  for(const change of [{httpStatus:null},{httpStatus:500},{message:"timeout"},
    {message:'{"success":false,"message":""}'},{message:'{"success":true,"message":"","error":"x"}'},
    {message:'{"success":true}'},{startedAt:undefined},{finishedAt:undefined},
    {finishedAt:"invalid"},{finishedAt:"2026-09-28T02:10:00Z"},
    {finishedAt:"2026-10-01T00:00:00Z"},{finishedAt:"2026-09-30T00:00:00Z"}])
    assert.equal(blocked(change),true,JSON.stringify(change));
  for(const siteType of ["NewAPI","AgentRouter"])assert.equal(blocked({},siteType),true);
});
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
test("旧 Cron 忽略并在保存时移除；预览始终统一时间且不请求站点",async()=>{
  const f=fixture(),a=f.seed(),stored=JSON.parse(a.credential.fields.config);
  delete stored.cron;delete stored.queryBalance;a.credential.fields.config=JSON.stringify(stored);
  const c=decode(f.ctx(),a.credential);assert.equal(c.cron,undefined);assert.equal(c.queryBalance,true);
  const preview=await plugin.previewSchedule(f.ctx({cron:"30 9 * * 1-5"}));
  assert.equal(preview.statusCode,200);assert.equal(preview.body.next.length,3);
  assert.equal(preview.body.cron,DEFAULT_CRON);
  assert.equal((await plugin.previewSchedule(f.ctx({cron:"bad"}))).body.cron,DEFAULT_CRON);
  const out=await plugin.saveAccount(f.ctx({id:a.id,version:"1",cron:"30 9 * * *",queryBalance:false}));
  assert.equal(out.body.account.cron,undefined);assert.equal(out.body.account.queryBalance,false);
  assert.equal(JSON.parse(a.credential.fields.config).cron,undefined);
  assert.equal(f.calls.length,0);
  assert.equal(configFrom(f.ctx(),{...stored,cron:"invalid"}).cron,undefined);
  for(const legacy of ["* * * * *","invalid",null,123]) {
    a.credential.fields.config=JSON.stringify({...stored,cron:legacy});
    assert.equal(decode(f.ctx(),a.credential).cron,undefined);
  }
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
test("统一时间忽略不同旧 Cron；迟到调度与旧分钟任务复用当天 slot",async t=>{
  const due=Date.parse("2026-09-30T02:10:00Z");
  let clock=due-60000;t.mock.method(Date,"now",()=>clock);
  const f=fixture();
  for(const cron of ["0 0 9 * * *","* * * * *","bad"])f.seed("NewAPI",{cron});
  assert.equal(dailySlot(clock),null);
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,0);
  clock=due+65000;
  await plugin.dailyCheckIn(f.ctx());
  assert.equal(f.jobs.size,1);
  const job=[...f.jobs.values()][0];
  assert.equal(job.input.slot,due);assert.equal(job.input.ids.length,3);
  clock=due+10*60000;
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,1);
  assert.equal(dailySlot(due+1800000),due);
  assert.equal(dailySlot(due+1800001),null);
  clock=due+86400000;
  await plugin.dailyCheckIn(f.ctx());assert.equal(f.jobs.size,2);
});
test("旧 Cron 编辑不改变统一计划摘要；非统一时间的旧排队任务不执行",async t=>{
  const due=Date.parse("2026-09-30T02:10:00Z");
  t.mock.timers.enable({apis:["Date"],now:due});
  const f=fixture(),a=f.seed("NewAPI",{cron:"* * * * *"});
  await plugin.dailyCheckIn(f.ctx());
  const job=[...f.jobs.values()][0];
  const stored=JSON.parse(a.credential.fields.config);
  a.credential.fields.config=JSON.stringify({...stored,cron:"0 0 1 * * *"});
  const invalid=await plugin.checkInJob(f.ctx(),{...job.input,slot:due-60000});
  assert.equal(invalid.results[0].status,"Skipped");assert.equal(f.calls.length,0);
  const valid=await plugin.checkInJob(f.ctx(),job.input);
  assert.equal(valid.results[0].status,"Success");assert.equal(f.calls.length,1);
});
test("自动 job 排队期间修改认证 / 开关或过期会跳过",async t=>{
  let clock=Date.parse("2026-09-30T02:10:00Z");t.mock.method(Date,"now",()=>clock);
  for(const changed of [{cookie:"session=NEW"},{autoCheckIn:false},{enabled:false},null]){
    const f=fixture(),a=f.seed("NewAPI",{cron:"* * * * *"});await plugin.dailyCheckIn(f.ctx());
    const job=[...f.jobs.values()][0];assert.ok(job);
    if(changed){const stored=JSON.parse(a.credential.fields.config);a.credential.fields.config=JSON.stringify({...stored,...changed})}
    else clock+=31*60000;
    const out=await plugin.checkInJob(f.ctx(),job.input);assert.equal(out.results[0].status,"Skipped");assert.equal(f.calls.length,0);
  }
});
test("超过 100 个到期账号分批，Redis 不可用拒绝调度，成功/未确认账号不入队",async t=>{
  t.mock.method(Date,"now",()=>Date.parse("2026-09-30T02:10:00Z"));
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
test("Agent 登录后保存 Cookie + 精确 UID；手动刷新复用会话且不重新签到",async()=>{
  const f=fixture(),a=f.seed("AgentRouter",{queryBalance:true,route:"pool"});
  f.handler=async spec=>spec.method==="POST"?login():cookieHandler(spec);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Success");
  assert.equal(f.calls[0].url,"https://agentrouter.org/api/user/login");
  assert.equal(f.calls[1].headers.cookie,"session=TEMP_ONLY");
  assert.equal(f.calls[1].headers["new-api-user"],"90071992547409931234");
  assert.equal(new Set(f.calls.map(c=>c.client)).size,1);
  assert.equal(storedBalance(a).snapshot.amount,"25");
  assert.equal(JSON.parse(a.credential.fields.balanceSession).cookie,"session=TEMP_ONLY");
  assert.doesNotMatch(JSON.stringify(card(await readAccount(f.ctx(),a.id))),/TEMP_ONLY|balanceSession/);
  assert.doesNotMatch(JSON.stringify((await plugin.listAccounts(f.ctx())).body),/TEMP_ONLY|balanceSession/);
  assert.doesNotMatch(a.credential.fields.config,/TEMP_ONLY/);
  assert.ok(!f.calls.some(c=>c.url.endsWith("sign_in")||c.url.endsWith("checkin")));
  const previous=a.credential.fields.lastResult,successDay=a.credential.fields.lastSuccessDay;
  const started=await plugin.startBalance(f.ctx({id:a.id}));
  assert.equal(started.statusCode,202);assert.deepEqual(started.body.input,{id:a.id});
  assert.equal((await plugin.startBalance(f.ctx({id:a.id}))).body.id,started.body.id);
  const refreshed=await plugin.balanceJob(f.ctx(),started.body.input);
  assert.equal(refreshed.results[0].status,"Success");
  assert.deepEqual(f.calls.slice(3).map(c=>[c.method,new URL(c.url).pathname]),[["GET","/api/user/self"],["GET","/api/status"]]);
  assert.equal(f.calls[3].headers.cookie,"session=TEMP_ONLY");
  assert.equal(f.calls[3].headers["new-api-user"],"90071992547409931234");
  assert.equal(f.calls[3].body,undefined);
  assert.equal(f.calls[4].headers.cookie,undefined);assert.equal(f.calls[4].headers["new-api-user"],undefined);
  assert.equal(f.clients.length,2);
  assert.ok(f.clients.every(c=>c.closed&&c.options.route==="pool"&&c.options.allowDirectFallback===false));
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
  assert.equal(a.credential.fields.lastResult,previous);assert.equal(a.credential.fields.lastSuccessDay,successDay);
  assert.doesNotMatch(JSON.stringify([f.logs,[...f.jobs.values()],f.progress]),/TEMP_ONLY/);
});
test("Agent 关闭签到后查余额仍保存会话；未知签到标志也不阻止只读刷新",async()=>{
  for(const checked of [false,null]){
    const f=fixture(),a=f.seed("AgentRouter",{queryBalance:false});
    f.handler=async spec=>spec.method==="POST"?login(checked):cookieHandler(spec);
    const out=await runOne(f.ctx(),a.id);
    assert.equal(out.status,checked===false?"Success":"Uncertain");
    assert.equal(f.calls.length,1);assert.equal(a.credential.fields.balance,undefined);
    assert.ok(a.credential.fields.balanceSession);
    const previous=a.credential.fields.lastResult;
    assert.equal((await refreshBalance(f.ctx(),a.id)).results[0].status,"Success");
    assert.equal(a.credential.fields.lastResult,previous);
    assert.equal(storedBalance(a).snapshot.amount,"25");
    assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
  }
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
    ["session=X","session=Y"],["other=X"],["session=X\u0001"],["session=X\u007f"],
    ["session=X; Max-Age=3600; Max-Age=7200"],["session=X; Path=/; Path=/api"],
    ["session=X; Max-Age=999999999999999999999999"],['session="X"']
  ])assert.throws(()=>agentSession(c,login(false,headers)));
  assert.equal(agentSession({...c,baseUrl:c.baseUrl+"/sub"},login(false,["session=X; Path=/sub"])).cookie,"session=X");
});
test("Agent 会话期限按 Max-Age/Expires 校验；无期限会话仅在上游认证有效时复用",async t=>{
  const now=Date.parse("2026-09-30T02:00:00Z");
  t.mock.timers.enable({apis:["Date"],now});
  const f=fixture(),a=f.seed("AgentRouter"),c=decode(f.ctx(),a.credential);
  assert.equal(agentSession(c,login()).expiresAt,null);
  assert.equal(agentSession(c,login(false,["session=X; Max-Age=60"])).expiresAt,now+60000);
  assert.equal(agentSession(c,login(false,["session=X; Expires=Wed, 30 Sep 2026 02:10:00 GMT"])).expiresAt,now+600000);
  assert.equal(agentSession(c,login(false,["session=X; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT"])).expiresAt,now+60000);
  await persistAgentSession(f.ctx(),await readAccount(f.ctx(),a.id),agentSession(c,login(false,["session=X; Max-Age=60"])));
  t.mock.timers.tick(60000);
  const out=await refreshBalance(f.ctx(),a.id);
  assert.equal(out.results[0].status,"Failed");assert.match(out.results[0].message,/会话已过期.*登录并签到/);
  assert.equal(a.credential.fields.balanceSession,undefined);
  assert.equal(f.requests.length,0);
});
async function seedSession(f,a,headers) {
  const record=await readAccount(f.ctx(),a.id);
  await persistAgentSession(f.ctx(),record,agentSession(record.config,login(false,headers)));
}
test("Agent 缺失/损坏会话不发送请求，保留旧余额并明确提示登录",async()=>{
  for(const raw of [undefined,"invalid",JSON.stringify({cookie:"session=X",userId:"1",expiresAt:null})]){
    const f=fixture(),a=f.seed("AgentRouter");
    a.credential.fields.balanceSession=raw;
    a.credential.fields.balance=JSON.stringify({state:"Fresh",snapshot:{amount:"25",unit:"USD"}});
    const out=await refreshBalance(f.ctx(),a.id);
    assert.equal(out.results[0].status,"Failed");assert.match(out.results[0].message,/缺少有效登录会话.*登录并签到/);
    assert.equal(storedBalance(a).state,"Stale");assert.equal(storedBalance(a).snapshot.amount,"25");
    assert.equal(a.credential.fields.balanceSession,undefined);assert.equal(f.clients.length,0);
    assert.equal(f.requests.length,0);assert.equal(a.credential.fields.lastResult,undefined);
  }
});
test("Agent 上游认证失效清除会话；后续刷新不登录且不再发送失效会话",async()=>{
  for(const reply of [response("",401),response({success:false,message:"未登录"})]){
    const f=fixture(),a=f.seed("AgentRouter");await seedSession(f,a);f.handler=cookieHandler;
    await refreshBalance(f.ctx(),a.id);
    f.handler=async()=>reply;
    const out=await refreshBalance(f.ctx(),a.id);
    assert.equal(out.results[0].status,"Failed");assert.match(out.results[0].message,/会话已失效.*登录并签到/);
    assert.equal(a.credential.fields.balanceSession,undefined);
    assert.equal(storedBalance(a).snapshot.amount,"25");assert.equal(storedBalance(a).state,"Stale");
    const count=f.requests.length;await refreshBalance(f.ctx(),a.id);assert.equal(f.requests.length,count);
    assert.ok(f.calls.every(c=>c.method==="GET"));assert.equal(a.credential.fields.lastSuccessDay,undefined);
  }
});
test("Agent 签到后余额认证失败也清除刚保存的会话，不丢失签到确认",async()=>{
  const f=fixture(),a=f.seed("AgentRouter",{queryBalance:true});
  f.handler=async spec=>spec.method==="POST"?login():response("",401);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Success");
  assert.equal(a.credential.fields.balanceSession,undefined);assert.equal(storedBalance(a).state,"Unknown");
  assert.equal(a.credential.fields.lastSuccessDay,day());assert.equal(f.calls.length,2);
});
test("Agent 余额 WAF/限流/服务器错误保留会话，取消透传，不重放登录",async()=>{
  for(const reply of [response("acw_sc__v2",403),response("",429),response("",500),null]){
    const f=fixture(),a=f.seed("AgentRouter");await seedSession(f,a);
    const raw=a.credential.fields.balanceSession;
    f.handler=async()=>{if(reply)return reply;throw cancellation()};
    if(reply)assert.equal((await refreshBalance(f.ctx(),a.id)).results[0].status,"Failed");
    else await assert.rejects(refreshBalance(f.ctx(),a.id),{code:"host.cancelled"});
    assert.equal(a.credential.fields.balanceSession,raw);
    assert.ok(f.calls.every(c=>c.method==="GET"));assert.ok(f.clients.every(c=>c.closed));
  }
});
test("Agent 会话绑定账号身份和网络设置，普通编辑保留，认证或路线变化清除",async()=>{
  for(const change of [{password:"NEW"},{username:"new",password:"NEW"},{baseUrl:"https://other.example",password:"NEW",approveOrigin:true},
    {route:"pool"},{siteType:"AnyRouter",cookie:"session=OTHER",userId:"2"}]){
    const f=fixture(),a=f.seed("AgentRouter");await seedSession(f,a);
    const record=await readAccount(f.ctx(),a.id);
    const out=await plugin.saveAccount(f.ctx({id:a.id,version:String(a.version),...change}));
    assert.equal(out.statusCode,200);assert.equal(a.credential.fields.balanceSession,undefined);
    await assert.rejects(persistAgentSession(f.ctx(),record,agentSession(record.config,login())),/配置变化/);
  }
  const f=fixture(),a=f.seed("AgentRouter");await seedSession(f,a);
  const raw=a.credential.fields.balanceSession;
  assert.equal((await plugin.saveAccount(f.ctx({id:a.id,version:String(a.version),label:"renamed",queryBalance:true,autoCheckIn:false}))).statusCode,200);
  assert.equal(a.credential.fields.balanceSession,raw);
  const b=f.seed("AgentRouter",{username:"another"});b.credential.fields.balanceSession=raw;
  assert.throws(()=>readAgentSession(f.ctx(),{config:decode(f.ctx(),b.credential),credential:b.credential}),/缺少有效/);
});
test("Agent 会话 CAS 合并编辑、持续冲突不重发登录，不用旧结果覆盖并发认证变化",async()=>{
  const f=fixture(),a=f.seed("AgentRouter");let changed=false;
  f.casHook=async(_,__,credential)=>{
    if(changed||!credential.fields.balanceSession)return;
    changed=true;a.version++;
    a.credential.fields.config=JSON.stringify({...JSON.parse(a.credential.fields.config),queryBalance:true});
  };
  f.handler=async()=>login();
  assert.equal((await runOne(f.ctx(),a.id)).status,"Success");
  assert.equal(JSON.parse(a.credential.fields.config).queryBalance,true);assert.ok(a.credential.fields.balanceSession);
  assert.equal(f.calls.length,1);
  const g=fixture(),b=g.seed("AgentRouter");
  g.casHook=async(_,__,credential)=>{if(credential.fields.balanceSession)b.version++};
  g.handler=async()=>login();
  const out=await runOne(g.ctx(),b.id);
  assert.equal(out.status,"Success");assert.match(out.warning,/并发冲突/);
  assert.equal(b.credential.fields.lastSuccessDay,day());assert.equal(g.calls.length,1);
  assert.equal(b.credential.fields.balanceSession,undefined);
  const h=fixture(),c=h.seed("AgentRouter",{queryBalance:true});let switched=false;
  h.casHook=async(_,__,credential)=>{
    if(switched||!credential.fields.balanceSession)return;
    switched=true;c.version++;
    c.credential.fields.config=JSON.stringify({...JSON.parse(c.credential.fields.config),password:"CHANGED"});
  };
  h.handler=async()=>login();
  assert.match((await runOne(h.ctx(),c.id)).warning,/配置变化/);
  assert.equal(c.credential.fields.balanceSession,undefined);assert.equal(h.calls.length,1);
});
test("Agent 余额认证失败 CAS 不删除并发写入的新会话",async()=>{
  const f=fixture(),a=f.seed("AgentRouter");await seedSession(f,a);
  const record=await readAccount(f.ctx(),a.id);
  await seedSession(f,a,["session=NEW_SESSION; Path=/"]);
  await persistBalance(f.ctx(),record,{checkedAt:"now",error:"expired",authExpired:true});
  assert.equal(JSON.parse(a.credential.fields.balanceSession).cookie,"session=NEW_SESSION");
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
test("入队失败不在同一 slot 重试；计划不会泄露凭据或触发 POST",async t=>{
  t.mock.method(Date,"now",()=>Date.parse("2026-09-30T02:10:00Z"));
  const f=fixture();f.seed("NewAPI",{cron:"* * * * *"});const ctx=f.ctx();let attempts=0;
  ctx.jobs.start=async()=>{attempts++;throw Error("queue full")};
  await assert.rejects(plugin.dailyCheckIn(ctx),/queue full/);
  await plugin.dailyCheckIn(ctx);assert.equal(attempts,1);assert.equal(f.calls.length,0);
});
