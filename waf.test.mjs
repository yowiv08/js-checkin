import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_USER_AGENT, solveWaf, mergeWafCookie } from "./src/waf.mjs";
import { runOne, runBatch, refreshBalance } from "./src/runner.mjs";
import { accountLock, day } from "./src/common.mjs";
import * as plugin from "./src/plugin.mjs";
import { fixture as mockFixture, response, cancellation } from "./test-host.mjs";
const fixture = () => mockFixture({ rawHttp:true });

const mapping = [15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36];
const key = "3000176000856006061501533003690027800375";
const vectors = [
  ["DA222F44CB065259F13EE30BCB1CBE3363AA205B","6abb7eb0bcb6d136c3e550b71e38c742d5ac311f"],
  ["0123456789abcdef0123456789abcdef01234567","d2c7186598ab1a508a4f6064e4fa746323ab17c6"],
  ["FEDCBA9876543210FEDCBA9876543210FEDCBA98","2d38e79a6754e5af75b09f9b1b058b9cdc54e839"],
  ["0000000000000000000000000000000000000000","3000176000856006061501533003690027800375"],
  ["ffffffffffffffffffffffffffffffffffffffff","cfffe89fff7a9ff9f9eafeaccffc96ffd87ffc8a"]
];
const encode = text => Buffer.from(text).toString("base64").replace(/[a-zA-Z]/g, character =>
  character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
function challenge(seed = vectors[0][0], keys = [key], map = mapping) {
  return `<html><script>var arg1='${seed}';var N=[${["noise",...keys].map(value=>`'${encode(value)}'`).join(",")}];var m=[${map.map(value=>"0x"+value.toString(16)).join(",")}];document.cookie='acw_sc__v2=';</script></html>`;
}
const html = challenge();
const dynamic = `acw_sc__v2=${vectors[0][1]}`;
const noSession = () => response({success:false,message:"未登录"},401);
const success = () => response({success:true,message:"签到成功"});
const balance = () => response({success:true,data:{quota:12500000}});
const last = account => JSON.parse(account.credential.fields.lastResult);
const savedBalance = account => JSON.parse(account.credential.fields.balance);
const posts = f => f.calls.filter(call=>call.method==="POST");
function passing(f) {
  f.handler = async spec => {
    if (f.calls.length === 1) return response(html);
    if (f.calls.length === 2) return noSession();
    return spec.method === "POST" ? success() : balance();
  };
}

for (const [seed, expected] of vectors) test(`acw_sc__v2 固定向量 ${seed.slice(0,8)}`, () => {
  assert.equal(solveWaf(challenge(seed)),`acw_sc__v2=${expected}`);
});
test("静态解析支持空白、引号、十进制与尾逗号", () => {
  const formatted = `<script>\nconst arg1 = "${vectors[0][0]}";\nlet N = [ "${encode("noise")}", "${encode(key)}", ];\nvar m = [ ${mapping.join(", ")}, ];\n'acw_sc__v2';</script>`;
  assert.equal(solveWaf(formatted),dynamic);
});
test("不执行内联脚本、外链脚本或页面事件", () => {
  globalThis.anyrouterExecuted = false;
  try {
    const modified = html.replace("</script>",`; globalThis.anyrouterExecuted = true; throw Error('REMOTE');</script>`);
    assert.equal(solveWaf(modified),dynamic);
    assert.equal(globalThis.anyrouterExecuted,false);
    assert.equal(solveWaf(html.replace("<script>",'<script src="https://untrusted.invalid/code.js">')),null);
  } finally { delete globalThis.anyrouterExecuted; }
});
test("无效或多义的 seed、密钥、排列和超大挑战被拒绝", () => {
  const bad = [
    "",null,"<html>arg1 acw_sc__v2</html>",html.repeat(2),"x".repeat(262145),
    challenge("f".repeat(39)),challenge("G".repeat(40)),challenge(vectors[0][0],[]),
    challenge(vectors[0][0],[key,"a".repeat(40)]),challenge(vectors[0][0],["invalid"]),
    challenge(vectors[0][0],[vectors[0][0]]),challenge(vectors[0][0],[key],mapping.slice(1)),
    challenge(vectors[0][0],[key],Array(40).fill(1)),
    challenge(vectors[0][0],[key],[0,...mapping.slice(1)]),
    challenge(vectors[0][0],[key],[41,...mapping.slice(1)]),
    html.replace("0xf,","1+14,"),html.replace(`'${encode(key)}'`,"fetch('https://untrusted.invalid')"),
    html.replace("var N=[",`var N=['${"a".repeat(2049)}',`)
  ];
  for (const value of bad) assert.equal(solveWaf(value),null);
});
test("替换所有旧 WAF Cookie，完整保留登录 Cookie", () => {
  assert.equal(mergeWafCookie("session=A=B; acw_sc__v2=old; preference=(x); acw_sc__v2=older",dynamic),
    `session=A=B; preference=(x); ${dynamic}`);
  assert.throws(()=>mergeWafCookie("session=A","session=ATTACK"));
  assert.throws(()=>mergeWafCookie("session=A",dynamic+"\r\nX: evil"));
});
for (const route of ["direct","pool"]) test(`AnyRouter ${route} 两次预检、一次签到、余额共用客户端与 UA`, async () => {
  const f=fixture(),a=f.seed("AnyRouter",{route,queryBalance:true,userAgent:route==="pool"?"Custom-UA":"",cookie:"session=COOKIE_SECRET; acw_sc__v2=OLD"});
  const initial=a.credential.fields.config;passing(f);
  const out=await runBatch(f.ctx(),[a.id]);assert.equal(out.results[0].status,"Success");
  assert.deepEqual(f.calls.map(call=>[call.method,new URL(call.url).pathname]),[
    ["GET","/api/user/self"],["GET","/api/user/self"],["POST","/api/user/sign_in"],["GET","/api/user/self"]
  ]);
  assert.equal(f.calls[0].headers.cookie,undefined);assert.equal(f.calls[1].headers.cookie,dynamic);
  for (const spec of f.calls.slice(0,2)) assert.equal(spec.headers["new-api-user"],undefined);
  for (const spec of f.calls.slice(2)) {
    assert.equal(spec.headers.cookie,`session=COOKIE_SECRET; ${dynamic}`);
    assert.equal(spec.headers["new-api-user"],"90071992547409931234");
  }
  assert.ok(f.calls.every(call=>call.headers["user-agent"]===(route==="pool"?"Custom-UA":DEFAULT_USER_AGENT)));
  assert.ok(f.calls.every(call=>call.route===route && call.followRedirects===false && call.allowDirectFallback===false));
  assert.equal(new Set(f.calls.map(call=>call.client)).size,1);
  assert.equal(posts(f).length,1);assert.ok(f.waits.includes(3000));assert.ok(f.clients.every(client=>client.closed));
  assert.equal(savedBalance(a).snapshot.amount,"25");
  assert.equal(a.credential.fields.config,initial);assert.equal(a.credential.fields.lastSuccessDay,day());
  assert.doesNotMatch(JSON.stringify({credential:a.credential,logs:f.logs,result:out}),new RegExp(vectors[0][1]));
  assert.doesNotMatch(JSON.stringify({logs:f.logs,result:out}),/COOKIE_SECRET/);
});
test("预检已通行时保留原 Cookie，单次 POST", async () => {
  const f=fixture(),a=f.seed("AnyRouter");
  f.handler=async spec=>spec.method==="GET"?noSession():success();
  const result=await runOne(f.ctx(),a.id);assert.equal(result.status,"Success");
  assert.equal(f.calls.length,2);assert.equal(posts(f)[0].headers.cookie,"session=COOKIE_SECRET");
  assert.ok(!f.waits.includes(3000));
});
for (const [label,reply,status] of [
  ["未知HTML",response("<html>unknown</html>"),"Failed"],
  ["缺少参数",response("<script>acw_sc__v2</script>",403),"Challenge"],
  ["Cloudflare",response("<html>cf-chl-</html>",403),"Challenge"],
  ["验证码",response({success:false,message:"captcha required"}),"Challenge"],
  ["HTTP429",response(html,429),"RateLimited"],
  ["边缘限流",response("http_ratelimit",403),"RateLimited"],
  ["HTTP503",response(html,503),"Failed"],
  ["重定向",response(html,302),"Failed"],
  ["超大HTML",response("x".repeat(262145)),"Challenge"]
]) test(`预检${label}停止签到`, async () => {
  const f=fixture(),a=f.seed("AnyRouter");f.handler=async()=>reply;
  assert.equal((await runOne(f.ctx(),a.id)).status,status);
  assert.equal(f.calls.length,1);assert.equal(posts(f).length,0);
  assert.equal(last(a).status,status);assert.equal(a.credential.fields.lastSuccessDay,undefined);
});
test("WAF 验证仍被拦截时不循环求解", async () => {
  const f=fixture(),a=f.seed("AnyRouter");f.handler=async()=>response(html,403);
  const out=await runOne(f.ctx(),a.id);assert.equal(out.status,"Challenge");
  assert.equal(f.calls.length,2);assert.equal(posts(f).length,0);assert.equal(last(a).status,"Challenge");
});
test("预检 GET 超时不制造签到不确定，允许下一次任务", async () => {
  const f=fixture(),a=f.seed("AnyRouter");f.handler=async()=>{throw Error("timeout COOKIE_SECRET")};
  const out=await runOne(f.ctx(),a.id);assert.equal(out.status,"Failed");assert.equal(last(a).status,"Failed");
  assert.equal(out.message,"timeout COOKIE_SECRET");assert.equal(posts(f).length,0);
  passing(f);f.calls.length=0;assert.equal((await runOne(f.ctx(),a.id)).status,"Success");
});
for (const point of ["first","wait","verify","beforePost","post"]) test(`取消 ${point} 保持真实执行状态`, async () => {
  const f=fixture(),a=f.seed("AnyRouter");
  f.onDelay=ms=>{
    if(point==="wait"&&ms===3000 || point==="beforePost"&&f.calls.length===2) f.aborted=true;
  };
  f.handler=async spec=>{
    if(point==="first"&&f.calls.length===1 || point==="verify"&&f.calls.length===2 || point==="post"&&spec.method==="POST"){
      f.aborted=true;throw cancellation();
    }
    return f.calls.length===1?response(html):f.calls.length===2?noSession():success();
  };
  await assert.rejects(runOne(f.ctx(),a.id),{code:"host.cancelled"});
  assert.equal(posts(f).length,point==="post"?1:0);
  if(point==="post")assert.equal(last(a).status,"Uncertain");
  else assert.equal(a.credential.fields.lastResult,undefined);
  assert.equal(a.credential.fields.lastSuccessDay,undefined);
});
test("POST 超时后不再预检或重放", async () => {
  const f=fixture(),a=f.seed("AnyRouter");passing(f);const handler=f.handler;
  f.handler=async spec=>{if(spec.method==="POST")throw Error("timeout");return handler(spec)};
  assert.equal((await runOne(f.ctx(),a.id)).status,"Uncertain");assert.equal(posts(f).length,1);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");assert.equal(f.calls.length,3);
});
test("POST 再次遇到 WAF 不重发", async () => {
  const f=fixture(),a=f.seed("AnyRouter");passing(f);const handler=f.handler;
  f.handler=async spec=>spec.method==="POST"?response(html,403):handler(spec);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Challenge");assert.equal(posts(f).length,1);
  assert.equal(f.calls.length,3);
});
test("WAF 通行不等于业务成功，缺失 success 的响应不确认签到", async () => {
  const f=fixture(),a=f.seed("AnyRouter");passing(f);const handler=f.handler;
  f.handler=async spec=>spec.method==="POST"?response({message:""}):handler(spec);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Uncertain");
  assert.equal(a.credential.fields.lastSuccessDay,undefined);
});
test("成功后保存或日志故障不重新签到，CAS 保留并发配置", async () => {
  const f=fixture(),a=f.seed("AnyRouter");passing(f);let edited=false;f.failLog=true;
  f.casHook=async(_,__,credential)=>{
    if(JSON.parse(credential.fields.lastResult).status==="Success"&&!edited){
      edited=true;a.version++;
      a.credential.fields.config=JSON.stringify({...JSON.parse(a.credential.fields.config),autoCheckIn:false});
    }
  };
  const out=await runBatch(f.ctx(),[a.id]);assert.equal(out.results[0].status,"Success");assert.ok(out.results[0].warning);
  assert.equal(JSON.parse(a.credential.fields.config).autoCheckIn,false);
  assert.equal(posts(f).length,1);assert.equal(f.calls.length,3);
});
test("预检期间手动与定时共享锁，编辑不可插入", async () => {
  const f=fixture(),a=f.seed("AnyRouter");let ready,finish;
  const waiting=new Promise(resolve=>ready=resolve);
  f.handler=async spec=>{
    if(spec.method==="GET"){ready();await new Promise(resolve=>finish=resolve);return noSession()}
    return success();
  };
  const running=runOne(f.ctx(),a.id);await waiting;
  assert.equal((await runOne(f.ctx(),a.id,{automatic:true})).status,"Skipped");
  assert.equal((await plugin.saveAccount(f.ctx({id:a.id,version:String(a.version),label:"changed"}))).statusCode,409);
  finish();assert.equal((await running).status,"Success");assert.equal(f.calls.length,2);
});
for (const condition of ["origin","redis","foreign","proxy"]) test(`AnyRouter ${condition} 校验在预检前完成`, async () => {
  const f=fixture(),a=f.seed("AnyRouter",{route:"pool"}),ctx=f.ctx();
  if(condition==="origin")f.origins.clear();
  if(condition==="redis")f.available=false;
  if(condition==="foreign")a.platform="foreign";
  if(condition==="proxy")ctx.http.createClient=async()=>{throw Object.assign(Error("unavailable"),{code:"host.proxy_pool_unavailable"})};
  assert.equal((await runOne(ctx,a.id)).status,"Failed");assert.equal(f.calls.length,0);
});
for (const condition of ["origin","lock"]) test(`预检后 ${condition} 失效阻止后续请求`, async () => {
  const f=fixture(),a=f.seed("AnyRouter"),ctx=f.ctx();
  f.handler=async()=>{
    if(condition==="origin")f.origins.clear();
    else f.state.set(accountLock(ctx,a.id),{value:"another-owner",expires:Date.now()+180000});
    return response(html);
  };
  assert.equal((await runOne(ctx,a.id)).status,"Failed");
  assert.equal(f.calls.length,1);assert.equal(posts(f).length,0);
});
test("独立余额刷新支持 WAF，失败保留旧余额", async () => {
  const f=fixture(),a=f.seed("AnyRouter");passing(f);
  assert.equal((await refreshBalance(f.ctx(),a.id)).results[0].status,"Success");
  assert.equal(f.calls.length,3);assert.equal(posts(f).length,0);assert.equal(savedBalance(a).snapshot.amount,"25");
  assert.equal(f.calls[2].headers.cookie,`session=COOKIE_SECRET; ${dynamic}`);
  assert.equal(a.credential.fields.lastResult,undefined);
  f.handler=async()=>response("captcha",403);
  assert.equal((await refreshBalance(f.ctx(),a.id)).results[0].status,"Failed");
  assert.equal(savedBalance(a).snapshot.amount,"25");assert.equal(savedBalance(a).state,"Stale");
  assert.equal(a.credential.fields.lastResult,undefined);
  assert.doesNotMatch(JSON.stringify(a.credential),new RegExp(vectors[0][1]));
});
test("自定义 AnyRouter 子路径与精确 origin 一致", async () => {
  const f=fixture(),a=f.seed("AnyRouter",{baseUrl:"https://custom.example/sub"});passing(f);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Success");
  assert.deepEqual(f.calls.map(call=>call.url),[
    "https://custom.example/sub/api/user/self","https://custom.example/sub/api/user/self","https://custom.example/sub/api/user/sign_in"
  ]);
  assert.ok(f.calls.every(call=>call.headers.origin==="https://custom.example" && call.headers.referer==="https://custom.example/sub/"));
});
for (const siteType of ["NewAPI","AnyRouter","AgentRouter"]) test(`${siteType} 共用 WAF 验证，登录与余额凭据分离`,async()=>{
  const f=fixture(),a=f.seed(siteType,{queryBalance:true,route:"pool"});
  const before=a.credential.fields.config;
  f.handler=async spec=>{
    if(f.calls.length===1)return response(html,403);
    if(f.calls.length===2)return noSession();
    if(spec.method==="POST"){
      if(siteType!=="AgentRouter")return success();
      const r=response({success:true,data:{id:42,checked_in:false}});
      r.headers={"set-cookie":["session=LOGIN_SESSION; Path=/; HttpOnly; Secure"]};return r;
    }
    if(spec.url.endsWith("/api/status"))return response({success:true,data:{quota_per_unit:500000,quota_display_type:"USD"}});
    return balance();
  };
  const result=await runOne(f.ctx(),a.id);assert.equal(result.status,"Success");
  const post=posts(f)[0];
  assert.equal(posts(f).length,1);
  assert.equal(post.url.endsWith(siteType==="AgentRouter"?"/api/user/login":siteType==="AnyRouter"?"/api/user/sign_in":"/api/user/checkin"),true);
  assert.equal(post.headers.cookie,siteType==="AgentRouter"?dynamic:`session=COOKIE_SECRET; ${dynamic}`);
  if(siteType==="AgentRouter"){
    assert.deepEqual(post.body,{username:"ethan@example.test",password:"PASSWORD_SECRET"});
    assert.equal(post.headers["new-api-user"],undefined);
  }else assert.equal(post.body,undefined);
  const self=f.calls[3];
  assert.equal(self.headers.cookie,siteType==="AgentRouter"?`session=LOGIN_SESSION; ${dynamic}`:`session=COOKIE_SECRET; ${dynamic}`);
  assert.equal(self.headers["new-api-user"],siteType==="AgentRouter"?"42":"90071992547409931234");
  const metadata=f.calls.find(call=>call.url.endsWith("/api/status"));
  if(metadata){assert.equal(metadata.headers.cookie,dynamic);assert.equal(metadata.headers["new-api-user"],undefined)}
  assert.ok(f.calls.every(call=>call.headers["user-agent"]===DEFAULT_USER_AGENT));
  assert.equal(new Set(f.calls.map(call=>call.client)).size,1);
  assert.equal(savedBalance(a).snapshot.amount,"25");
  assert.equal(a.credential.fields.config,before);
  assert.doesNotMatch(JSON.stringify(a.credential),/LOGIN_SESSION|wafCookie/);
});
test("AgentRouter 滑动验证原文返回，不误用 acw_sc__v2 算法",async()=>{
  const f=fixture(),a=f.seed("AgentRouter");
  const slider='<!doctype html><meta name="aliyun_waf_aa" content="sample"><script>var script="AliyunCaptcha.js";</script>滑动验证页面';
  f.handler=async()=>response(slider);
  const result=await runOne(f.ctx(),a.id);
  assert.equal(result.status,"Challenge");assert.equal(result.message,slider);
  assert.equal(posts(f).length,0);assert.equal(last(a).message,slider);
});
test("AgentRouter WAF 等待同步续期站点登录锁与账号锁",async t=>{
  let now=Date.now();t.mock.method(Date,"now",()=>now);
  const f=fixture(),a=f.seed("AgentRouter");passing(f);
  f.handler=async spec=>{
    if(f.calls.length===1)return response(html);
    if(f.calls.length===2)return noSession();
    return response({success:true,data:{checked_in:false}});
  };
  f.onDelay=ms=>{now+=ms};
  const ctx=f.ctx(),renewed=[],original=ctx.state.shared.compareExchange;
  ctx.state.shared.compareExchange=async(key,...args)=>{if(args[1]!==undefined)renewed.push(key);return original(key,...args)};
  assert.equal((await runOne(ctx,a.id)).status,"Success");
  assert.ok(renewed.filter(key=>key.startsWith("agent:")).length>=4);
  assert.ok(renewed.filter(key=>key.startsWith("account:")).length>=4);
});
test("AnyRouter 空消息成功响应保留原文，更新余额并确认今日签到",async()=>{
  const f=fixture(),a=f.seed("AnyRouter",{queryBalance:true});passing(f);
  const handler=f.handler;
  f.handler=async spec=>{
    if(spec.method==="POST")return response('{"message":"","success":true}');
    if(f.calls.length>3)return response({success:true,message:"",data:{quota:250310038,used_quota:824689962}});
    return handler(spec);
  };
  const out=await runOne(f.ctx(),a.id);
  assert.equal(out.status,"Success");assert.equal(out.message,'{"message":"","success":true}');
  assert.equal(a.credential.fields.lastSuccessDay,day());
  assert.equal(savedBalance(a).snapshot.amount,"500.620076");
  assert.equal(savedBalance(a).snapshot.unit,"USD");assert.equal(posts(f).length,1);
});
