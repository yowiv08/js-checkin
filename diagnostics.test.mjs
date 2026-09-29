import { test } from "node:test";
import assert from "node:assert/strict";
import { responseMessage, exceptionMessage, RESPONSE_LIMIT } from "./src/diagnostics.mjs";
import { interpret } from "./src/adapters.mjs";
import { resultData } from "./src/common.mjs";
import { runBatch } from "./src/runner.mjs";
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
