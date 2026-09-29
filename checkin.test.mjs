import { test } from "node:test";
import assert from "node:assert/strict";
import * as plugin from "./src/plugin.mjs";
import { runOne, runBatch } from "./src/runner.mjs";
import { interpret } from "./src/adapters.mjs";
import { acquire, release, day, accountLock, configFrom } from "./src/common.mjs";
import { fixture, response, cancellation } from "./test-host.mjs";

test("只提供签到、清单入口不触发登录或模型调用", async () => {
  const f=fixture(),a=f.seed("AgentRouter"),ctx=f.ctx();
  assert.deepEqual(plugin.getModels(),[]);
  assert.equal(plugin.invoke(ctx).statusCode,400);
  assert.equal(plugin.validateCredential(ctx,a.credential).success,true);
  assert.equal(f.calls.length,0);
});
for(const [type,path] of [["NewAPI","/api/user/checkin"],["AnyRouter","/api/user/sign_in"],["AgentRouter","/api/user/login"]]){
  test(`${type} 关闭余额时单次 POST、正确认证与地址`,async()=>{
    const f=fixture(),a=f.seed(type,{baseUrl:"https://site.example/sub"});
    f.handler=async()=>response(type==="AgentRouter"?{success:true,data:{checked_in:false}}:{success:true,message:"签到成功"});
    const result=await runOne(f.ctx(undefined,{phase:"Job"}),a.id);
    assert.equal(result.status,"Success");
    assert.equal(f.calls.length,1);
    const req=f.calls[0];assert.equal(req.url,"https://site.example/sub"+path);assert.equal(req.method,"POST");
    assert.equal(req.followRedirects,false);assert.equal(req.allowDirectFallback,false);assert.equal(req.retry,undefined);
    assert.equal(req.headers.origin,"https://site.example");assert.equal(req.headers.referer,"https://site.example/sub"+(type==="AgentRouter"?"/login":"/"));
    if(type==="AgentRouter"){assert.deepEqual(req.body,{username:"ethan@example.test",password:"PASSWORD_SECRET"});assert.equal(req.headers.cookie,undefined)}
    else{assert.equal(req.headers.cookie,"session=COOKIE_SECRET");assert.equal(req.headers["new-api-user"],"90071992547409931234");assert.equal(req.body,undefined)}
    assert.equal(a.credential.fields.lastSuccessDay,day());
  });
}
const cases=[
  ["重复签到","NewAPI",{success:false,message:"今日已签到"},200,"Already"],
  ["Any空消息","AnyRouter",{success:true,message:""},200,"Uncertain"],
  ["Any未声明成功","AnyRouter",{message:"签到成功"},200,"Uncertain"],
  ["奖励为零仍有明确证据","NewAPI",{success:true,data:{quota_awarded:0}},200,"Success"],
  ["缺少 Agent 标志","AgentRouter",{success:true,data:{}},200,"Uncertain"],
  ["Agent 已签","AgentRouter",{success:true,data:{checked_in:true}},200,"Already"],
  ["Agent 别名","AgentRouter",{success:true,data:{check_in:false}},200,"Success"],
  ["Agent 非布尔标志","AgentRouter",{success:true,data:{checked_in:"false"}},200,"Uncertain"],
  ["密码错误","AgentRouter",{success:false,message:"用户名或密码错误"},200,"AuthExpired"],
  ["Cookie 过期","NewAPI",{success:false,message:"未登录"},200,"AuthExpired"],
  ["Turnstile","NewAPI",{success:false,message:"Turnstile 验证失败"},200,"Challenge"],
  ["禁用签到","NewAPI",{success:false,message:"签到功能未启用"},200,"Failed"],
  ["未知 JSON","AnyRouter",{},200,"Uncertain"],
  ["HTML 200","AnyRouter","<html>login</html>",200,"Uncertain"],
  ["WAF","AnyRouter","<html>acw_sc__v2 arg1</html>",403,"Challenge"],
  ["ESA限流","AnyRouter","Denied by http_ratelimit",403,"RateLimited"],
  ["HTTP429","AgentRouter","",429,"RateLimited"],
  ["HTTP401","NewAPI","",401,"AuthExpired"],
  ["HTTP500","NewAPI","",500,"Uncertain"],
  ["重定向","NewAPI","",302,"Failed"]
];
for(const [label,type,body,code,status]of cases)test(`结果解释：${label}`,()=>{
  const result=interpret(type,response(body,code));assert.equal(result.status,status);
});
test("业务失败不能因奖励字段被判成功；错误消息不会回显响应中的秘密",()=>{
  assert.equal(interpret("NewAPI",response({success:false,data:{reward:3},message:"COOKIE_SECRET"})).status,"Failed");
  assert.doesNotMatch(JSON.stringify(interpret("AgentRouter",response({success:false,message:"PASSWORD_SECRET"}))),/PASSWORD_SECRET/);
});
test("完整凭据按用户要求返回管理员编辑界面；GET 不触发网络",async()=>{
  const f=fixture();f.seed();f.seed("AgentRouter");
  const out=await plugin.listAccounts(f.ctx());assert.equal(out.statusCode,200);
  assert.equal(out.body.accounts[0].cookie,"session=COOKIE_SECRET");assert.equal(out.body.accounts[1].password,"PASSWORD_SECRET");
  assert.equal(f.calls.length,0);
});
test("保存新账号明确批准 origin，但不登录、不签到",async()=>{
  const f=fixture(),body={label:"Any",siteType:"AnyRouter",cookie:"session=TEST",userId:"12"};
  assert.equal((await plugin.saveAccount(f.ctx(body))).statusCode,400);
  assert.equal(f.db.size,0);
  const saved=await plugin.saveAccount(f.ctx({...body,approveOrigin:true}));assert.equal(saved.statusCode,200);
  assert.equal(saved.body.account.baseUrl,"https://anyrouter.top");assert.equal(f.calls.length,0);
});
test("更新密码留空保留、CAS 保留并发宿主状态，成功标记只在身份变化时清除",async()=>{
  const f=fixture(),a=f.seed("AgentRouter");a.credential.fields.lastSuccessDay=day();a.status.cooldownUntil="2099-01-01";
  let out=await plugin.saveAccount(f.ctx({id:a.id,version:"1",password:"",autoCheckIn:false}));
  assert.equal(out.statusCode,200);assert.equal(out.body.account.password,"PASSWORD_SECRET");assert.equal(a.credential.fields.lastSuccessDay,day());
  assert.equal(a.status.cooldownUntil,"2099-01-01");
  out=await plugin.saveAccount(f.ctx({id:a.id,version:String(a.version),password:"NEW_PASSWORD"}));
  assert.equal(out.statusCode,200);assert.equal(a.credential.fields.lastSuccessDay,undefined);
});
test("更换 origin / 类型 / 用户身份不得沿用旧秘密",async()=>{
  const f=fixture(),a=f.seed();
  for(const change of [{baseUrl:"https://new-origin.example"},{siteType:"AnyRouter"},{userId:"2"}]){
    const out=await plugin.saveAccount(f.ctx({id:a.id,version:"1",...change,cookie:"",approveOrigin:true}));
    assert.equal(out.statusCode,400);
  }
  const b=f.seed("AgentRouter");
  assert.equal((await plugin.saveAccount(f.ctx({id:b.id,version:"1",username:"someone",password:""}))).statusCode,400);
});
test("配置验证拒绝 URL 凭据、路径穿越、控制字符、非字符串 UID 与伪造布尔",()=>{
  const f=fixture(),ctx=f.ctx(),base={siteType:"NewAPI",baseUrl:"https://new.example",cookie:"session=X",userId:"123"};
  for(const change of [
    {baseUrl:"http://new.example"},{baseUrl:"https://user:password@new.example"},{baseUrl:"https://new.example/a/../b"},
    {baseUrl:"https://new.example/%2e%2e/a"},{baseUrl:"https://new.example/?token=x"},{baseUrl:"https://new.example/#x"},
    {cookie:"session=x\r\nX:y"},{userId:123},{enabled:"true"},{route:"attempt"}
  ])assert.throws(()=>configFrom(ctx,{...base,...change}));
});
test("版本冲突不覆盖；跨插件账号 get/save/delete/start 均拒绝",async()=>{
  const f=fixture(),a=f.seed();a.version++;
  assert.equal((await plugin.saveAccount(f.ctx({id:a.id,version:"1",label:"覆盖"}))).statusCode,409);
  a.platform="foreign";
  assert.equal((await plugin.saveAccount(f.ctx({id:a.id,version:"2"}))).statusCode,404);
  assert.equal((await plugin.deleteAccount(f.ctx({id:a.id,version:"2"}))).statusCode,404);
  assert.equal((await plugin.startCheckIn(f.ctx({ids:[a.id]}))).statusCode,404);
  assert.equal(f.calls.length,0);
});
test("损坏配置仍可在校验归属与版本后删除",async()=>{
  const f=fixture(),a=f.seed();a.credential.fields.config="{broken";
  const listed=await plugin.listAccounts(f.ctx());assert.equal(listed.body.accounts[0].invalid,true);
  assert.equal((await plugin.deleteAccount(f.ctx({id:a.id,version:"1"}))).statusCode,200);
  assert.equal(f.db.has(a.id),false);
});
test("Redis 不可用 / origin 被撤销时 fail closed，不发 POST",async()=>{
  const f=fixture(),a=f.seed();f.available=false;
  assert.equal((await runOne(f.ctx(),a.id)).status,"Failed");assert.equal(f.calls.length,0);
  f.available=true;f.origins.clear();
  assert.equal((await runOne(f.ctx(),a.id)).status,"Failed");assert.equal(f.calls.length,0);
  f.origins.add("https://new.example");f.stateFail=true;
  assert.equal((await runOne(f.ctx(),a.id)).status,"Failed");assert.equal(f.calls.length,0);
});
test("代理池无节点不直连、不重试",async()=>{
  const f=fixture(),a=f.seed("NewAPI",{route:"pool"});
  f.handler=async()=>{throw Object.assign(Error("no proxy"),{code:"host.proxy_pool_unavailable"})};
  const out=await runOne(f.ctx(),a.id);assert.equal(out.status,"Failed");assert.match(out.message,/未回退直连/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,"pool");
});
test("今日成功重复运行跳过；禁用与自动开关在执行时重新检查",async()=>{
  const f=fixture(),a=f.seed(),ctx=f.ctx();
  await runOne(ctx,a.id);assert.equal((await runOne(ctx,a.id)).status,"Skipped");assert.equal(f.calls.length,1);
  const b=f.seed("NewAPI",{enabled:false}),c=f.seed("NewAPI",{autoCheckIn:false});
  assert.equal((await runOne(ctx,b.id)).status,"Skipped");
  assert.equal((await runOne(ctx,c.id,{automatic:true})).status,"Skipped");
  assert.equal(f.calls.length,1);
});
test("POST 传输失败先保留不确定；后续批次不重试，人工逐账号确认才能重发",async()=>{
  const f=fixture(),a=f.seed();
  f.handler=async()=>{throw Object.assign(Error("network secret"),{code:"host.http_error"})};
  assert.equal((await runOne(f.ctx(),a.id)).status,"Uncertain");
  assert.equal(JSON.parse(a.credential.fields.lastResult).status,"Uncertain");
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");assert.equal(f.calls.length,1);
  f.handler=async()=>response({success:true,message:"签到成功"});
  assert.equal((await runOne(f.ctx(),a.id,{acknowledgeUncertain:true})).status,"Success");assert.equal(f.calls.length,2);
});
test("发送前取消无请求；发送后取消保留预写记录并传播，不伪造 Completed",async()=>{
  const f=fixture(),a=f.seed();f.onDelay=()=>{f.aborted=true};
  await assert.rejects(runOne(f.ctx(),a.id),{code:"host.cancelled"});assert.equal(f.calls.length,0);
  assert.ok(f.state.size>0,"发送前取消也可能使释放操作被取消，锁按 TTL 到期");
  const g=fixture(),b=g.seed();g.handler=async()=>{g.aborted=true;throw cancellation()};
  await assert.rejects(runOne(g.ctx(),b.id),{code:"host.cancelled"});
  assert.equal(g.calls.length,1);assert.equal(JSON.parse(b.credential.fields.lastResult).status,"Uncertain");
  assert.ok(g.state.size>0,"取消后的锁由有限 TTL 兜底");
});
test("成功后的 CAS/日志故障不重发；CAS 重读合并保留配置",async()=>{
  const f=fixture(),a=f.seed();let conflicted=false;
  f.casHook=async(_,__,credential)=>{
    const result=JSON.parse(credential.fields.lastResult);
    if(result.status==="Success"&&!conflicted){conflicted=true;a.version++;const c=JSON.parse(a.credential.fields.config);c.autoCheckIn=false;a.credential.fields.config=JSON.stringify(c)}
  };
  f.failLog=true;const out=await runBatch(f.ctx(),[a.id]);assert.equal(out.results[0].status,"Success");assert.match(out.results[0].warning,/日志/);
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(a.credential.fields.config).autoCheckIn,false);
});
test("最终记录保存持续冲突保留不确定，不重复执行网络",async()=>{
  const f=fixture(),a=f.seed();
  f.casHook=async(_,__,credential)=>{if(JSON.parse(credential.fields.lastResult).status==="Success")a.version++};
  const out=await runOne(f.ctx(),a.id);assert.equal(out.status,"Success");assert.ok(out.warning);assert.equal(f.calls.length,1);
  assert.equal(JSON.parse(a.credential.fields.lastResult).status,"Uncertain");
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");
});
test("手动/Cron 共享锁，执行中不得编辑或删除",async()=>{
  const f=fixture(),a=f.seed();let ready,complete;const started=new Promise(r=>ready=r);
  f.handler=async()=>{ready();await new Promise(r=>complete=r);return response({success:true,message:"签到成功"})};
  const first=runOne(f.ctx(),a.id);await started;
  assert.equal((await runOne(f.ctx(),a.id,{automatic:true})).status,"Skipped");
  assert.equal((await plugin.saveAccount(f.ctx({id:a.id,version:String(a.version),label:"新备注"}))).statusCode,409);
  assert.equal((await plugin.deleteAccount(f.ctx({id:a.id,version:String(a.version)}))).statusCode,409);
  complete();await first;assert.equal(f.calls.length,1);
});
test("锁释放仅允许原持有者，不能删除新锁",async()=>{
  const f=fixture(),ctx=f.ctx(),key=accountLock(ctx,"a"),old=await acquire(ctx,key);
  f.state.set(key,{value:"new-owner",expires:Date.now()+180000});
  await release(ctx,old);assert.equal(f.state.get(key).value,"new-owner");
});
test("AgentRouter 同 origin 登录间隔至少 60 秒；共享节流使用可取消等待",async t=>{
  let clock=Date.now();t.mock.method(Date,"now",()=>clock);
  const f=fixture(),a=f.seed("AgentRouter"),b=f.seed("AgentRouter",{username:"other"});
  f.onDelay=ms=>{clock+=ms};
  const sent=[];f.handler=async()=>{sent.push(clock);return response({success:true,data:{checked_in:false}})};
  const out=await runBatch(f.ctx(),[a.id,b.id]);
  assert.equal(out.results.length,2);assert.ok(sent[1]-sent[0]>=60000);assert.ok(f.waits.includes(5000));
});
test("job 输入只含 ID 和确认选项，同批重复点击复用活跃任务",async()=>{
  const f=fixture(),a=f.seed(),ctx=f.ctx({ids:[a.id]});
  const first=await plugin.startCheckIn(ctx),second=await plugin.startCheckIn(ctx);
  assert.equal(first.statusCode,202);assert.equal(first.body.id,second.body.id);
  assert.deepEqual(first.body.input,{ids:[a.id],acknowledgeUncertain:false});
  assert.equal((await plugin.startCheckIn(f.ctx({all:true,ids:[a.id]}))).statusCode,400);
  assert.equal((await plugin.startCheckIn(f.ctx({all:true,acknowledgeUncertain:true}))).statusCode,400);
  assert.equal((await plugin.startCheckIn(f.ctx({ids:[a.id,a.id]}))).statusCode,400);
});
test("批量进度区分业务失败；取消只请求退出，不直接宣布 Cancelled",async()=>{
  const f=fixture(),a=f.seed(),b=f.seed();f.handler=async()=>response({success:false,message:"签到功能未启用"});
  const out=await plugin.checkInJob(f.ctx(undefined,{job:{id:"j"},phase:"Job"}),{ids:[a.id,b.id]});
  assert.equal(out.summary.Failed,2);assert.equal(f.progress.at(-1).completed,2);assert.equal(f.logs.length,2);
  const queued=await plugin.startCheckIn(f.ctx({ids:[a.id]}));
  const cancel=await plugin.cancelJob(f.ctx({id:queued.body.id}));assert.equal(cancel.body.accepted,true);
  assert.equal(f.jobs.get(queued.body.id).state,"Queued");
  assert.equal((await plugin.jobStatus(f.ctx(undefined,{query:{id:"missing"}}))).statusCode,404);
});
test("分钟任务只将匹配的启用账号入队；记录不包含凭据",async()=>{
  const f=fixture();f.seed("NewAPI",{cron:"* * * * *"});f.seed("NewAPI",{autoCheckIn:false});f.seed("AgentRouter",{enabled:false});
  await plugin.dailyCheckIn(f.ctx(undefined,{phase:"Task"}));assert.equal(f.calls.length,0);
  assert.equal(f.jobs.size,1);
  await plugin.checkInJob(f.ctx(undefined,{phase:"Job"}),[...f.jobs.values()][0].input);assert.equal(f.calls.length,1);
  assert.doesNotMatch(JSON.stringify(f.logs),/COOKIE_SECRET|PASSWORD_SECRET/);
});
