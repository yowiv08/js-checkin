import { test } from "node:test";
import assert from "node:assert/strict";
import { responseMessage, exceptionMessage, RESPONSE_LIMIT } from "./src/diagnostics.mjs";
import { interpret } from "./src/adapters.mjs";
import { resultData } from "./src/common.mjs";
import { runOne, runBatch } from "./src/runner.mjs";
import { fixture, response } from "./test-host.mjs";

test("响应正文完整保留 JSON、HTML、括号和换行",()=>{
  for(const body of ['{"success":false,"message":"请求失败（403）；原因(test)。"}',"<html>\n<script>bad()</script>\n</html>"]){
    assert.equal(responseMessage(response(body,403)),body);
    assert.equal(interpret("AnyRouter",response(body,403)).message,body);
  }
  assert.equal(responseMessage(response("",429)),"HTTP 429");
  assert.equal(responseMessage({statusCode:500,body:{error:"upstream"}}),'{"error":"upstream"}');
});
test("传输异常优先保留响应，否则显示真实错误码和消息",()=>{
  assert.equal(exceptionMessage({code:"ECONNRESET",message:"socket closed (peer)"}),"ECONNRESET: socket closed (peer)");
  assert.equal(exceptionMessage({code:"host.http_error",message:"HTTP transport failed."}),"host.http_error: HTTP transport failed.");
  assert.equal(exceptionMessage({response:{status:502,data:"<html>Bad gateway</html>"},message:"Request failed"}),"<html>Bad gateway</html>");
  assert.equal(exceptionMessage("connection reset"),"connection reset");
});
test("长响应有界持久化，不再裁成 240 字符",()=>{
  const raw="错误（详情）；\n".repeat(1200),message=responseMessage(response(raw));
  assert.equal(message,raw.slice(0,RESPONSE_LIMIT)+"\n…");
  assert.equal(resultData({lastResult:JSON.stringify({status:"Failed",message})}).message,message);
});
test("业务响应返回管理员，任务日志不写入响应凭据",async()=>{
  const f=fixture(),a=f.seed();
  const body=JSON.stringify({success:false,message:"服务异常（502）",echo:"COOKIE_SECRET"});
  f.handler=async()=>response(body,502);
  const out=await runBatch(f.ctx(),[a.id]);
  assert.equal(out.results[0].message,body);assert.equal(out.results[0].httpStatus,502);
  assert.equal(JSON.parse(a.credential.fields.lastResult).message,body);
  assert.doesNotMatch(JSON.stringify(f.logs),/COOKIE_SECRET|echo/);
  assert.equal(f.calls.length,1);
});

for(const siteType of ["NewAPI","AnyRouter"])for(const [label,raw,code,status] of [
  ["JSON",'{\n  "success": false,\n  "message": "用户名或密码错误（请核对）",\n  "echo": "LOGIN_SECRET"\n}',200,"AuthExpired"],
  ["HTML",'<html>\n<script>remote()</script>登录页面（upstream）\n</html>',200,"Uncertain"],
  ["WAF",'<html>\naliyun_waf: 访问验证（403）\n</html>',403,"Challenge"],
  ["空正文","",429,"RateLimited"],
  ["长正文","LOGIN_SECRET\n错误（详情）；\n".repeat(600),502,"Uncertain"]
])test(`${siteType} 登录${label}响应原样展示并有界保存，不写任务日志`,async()=>{
  const f=fixture(),a=f.seed(siteType,{authMode:"password",username:"test-user",password:"PASSWORD_SECRET"});
  f.handler=async()=>response(raw,code);
  const {results:[result]}=await runBatch(f.ctx(),[a.id]);
  const expected=raw ? raw.length>RESPONSE_LIMIT ? raw.slice(0,RESPONSE_LIMIT)+"\n…" : raw : `HTTP ${code}`;
  assert.equal(result.status,status);assert.equal(result.message,expected);assert.equal(result.httpStatus,code);
  const saved=resultData(a.credential.fields);
  assert.equal(saved.message,expected);assert.equal(saved.httpStatus,code);
  assert.equal(a.credential.fields.lastSuccessDay,undefined);assert.equal(a.credential.fields.balanceSession,undefined);
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith("/api/user/login"));
  assert.equal(f.logs.length,1);assert.doesNotMatch(JSON.stringify(f.logs),/LOGIN_SECRET|PASSWORD_SECRET|remote\(\)|aliyun_waf|用户名|错误/);
});

for(const siteType of ["NewAPI","AnyRouter"])for(const [label,reply,expected,code] of [
  ["bodyText",response('{"success":false,"message":"网关失败","echo":"LOGIN_SECRET"}',502),'{"success":false,"message":"网关失败","echo":"LOGIN_SECRET"}',502],
  ["data",{status:503,data:"<html>\nBad gateway（upstream）\n</html>"},"<html>\nBad gateway（upstream）\n</html>",503],
  ["空正文",response("",504),"HTTP 504",504]
])test(`${siteType} 登录异常携带${label}时保留正文及 HTTP 状态，不重放写请求`,async()=>{
  const f=fixture(),a=f.seed(siteType,{authMode:"password",username:"test-user",password:"PASSWORD_SECRET"});
  f.handler=async()=>{throw Object.assign(Error("Request failed"),{
    code:"host.http_error",response:reply,request:{body:{password:"PASSWORD_SECRET"},headers:{cookie:"REQUEST_COOKIE_SECRET"}}
  });};
  const {results:[result]}=await runBatch(f.ctx(),[a.id]);
  assert.equal(result.status,"Uncertain");assert.equal(result.message,expected);assert.equal(result.httpStatus,code);
  const saved=resultData(a.credential.fields);
  assert.equal(saved.message,expected);assert.equal(saved.httpStatus,code);
  assert.equal(a.credential.fields.lastSuccessDay,undefined);assert.equal(a.credential.fields.balanceSession,undefined);
  assert.doesNotMatch(JSON.stringify(result),/PASSWORD_SECRET|REQUEST_COOKIE_SECRET|Request failed|host.http_error/);
  assert.equal(f.logs.length,1);assert.doesNotMatch(JSON.stringify(f.logs),/LOGIN_SECRET|PASSWORD_SECRET|REQUEST_COOKIE_SECRET|Bad gateway|网关失败/);
  assert.equal((await runOne(f.ctx(),a.id)).status,"Skipped");
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith("/api/user/login"));
});

for(const siteType of ["NewAPI","AnyRouter"])for(const code of ["host.denied","host.proxy_pool_unavailable"])
test(`${siteType} 登录被 ${code} 阻止时展示真实错误，不回退或重试`,async()=>{
  const f=fixture(),a=f.seed(siteType,{authMode:"password",username:"test-user",password:"PASSWORD_SECRET",route:"pool"});
  f.handler=async()=>{throw Object.assign(Error("login transport blocked (upstream)"),{code});};
  const {results:[result]}=await runBatch(f.ctx(),[a.id]);
  assert.equal(result.status,"Failed");assert.equal(result.message,`${code}: login transport blocked (upstream)`);
  assert.equal(result.httpStatus,null);assert.equal(resultData(a.credential.fields).message,result.message);
  assert.equal(a.credential.fields.lastSuccessDay,undefined);assert.equal(a.credential.fields.balanceSession,undefined);
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith("/api/user/login"));
  assert.equal(f.calls[0].route,"pool");assert.equal(f.calls[0].allowDirectFallback,false);
  assert.equal(f.logs.length,1);assert.doesNotMatch(JSON.stringify(f.logs),/PASSWORD_SECRET|login transport blocked/);
});
