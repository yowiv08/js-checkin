import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {fixture,response,cancellation} from "./test-host.mjs";
import * as plugin from "./src/plugin.mjs";
import {readAccount,persistAgentSession} from "./src/accounts.mjs";
import {agentSession,exactJson} from "./src/balance.mjs";
import {refreshBalance} from "./src/runner.mjs";
import {acquire,accountLock} from "./src/common.mjs";
import {tokenInteger,tokenName,ipWhitelist,expiryInput,expiryDisplay,amountQuota,quotaAmount,currencyFor} from "./src/token-values.mjs";

const op=()=>Date.now()+":"+randomUUID();
const key="TOKEN_SECRET_never_log_this";
const initial=()=>({id:"90071992547409931",name:"测试令牌",key,status:"1",group:"default",
  expired_time:"-1",remain_quota:"9007199254740993123",used_quota:"100",unlimited_quota:false,
  model_limits_enabled:false,model_limits:"",allow_ips:"",cross_group_retry:false,auto_groups:null});
const usd={unit:"USD",quotaPerUnit:"500000",rate:"1"};
async function tokenFixture(siteType="NewAPI",{legacy=false,config={},masked=false}={}) {
  const f=fixture(),account=f.seed(siteType,config),token=initial();
  if(siteType==="AgentRouter"){
    const record=await readAccount(f.ctx(),account.id);
    const login=response({success:true,data:{id:"90071992547409931234",checked_in:false}});
    login.headers={"set-cookie":["session=AGENT_SECRET; Path=/; Secure; HttpOnly"]};
    await persistAgentSession(f.ctx(),record,agentSession(record.config,login));
  }
  const records=[token];
  f.handler=async spec=>{
    const url=new URL(spec.url),pathname=url.pathname.replace(/\/$/,"");
    if(pathname.endsWith("/api/status"))return response({success:true,data:{quota_display_type:"USD",quota_per_unit:500000}});
    if(pathname.endsWith("/api/user/self/groups"))return response({success:true,data:{default:{desc:"默认",ratio:1},other:{desc:"其他",ratio:2},auto:{desc:"自动",ratio:1}}});
    if(pathname.endsWith("/api/user/models"))return response({success:true,data:["model-a","model-b"]});
    if(pathname.endsWith("/api/user/self"))return response({success:true,data:{quota:500000}});
    if(spec.method==="GET"&&pathname.endsWith("/api/token")){
      const p=Number(url.searchParams.get("p")),start=(legacy?p:Math.max(p,1)-1)*20;
      const items=records.slice(start,start+20).map(t=>({...t,key:masked?"ABCD********EFGH":t.key}));
      return response({success:true,data:legacy?items:{items,page:Math.max(p,1),page_size:20,total:records.length}});
    }
    if(pathname.endsWith("/api/token/"+token.id)&&spec.method==="GET")return response({success:true,data:{...token,key:masked?"ABCD********EFGH":token.key}});
    if(pathname.endsWith("/api/token/"+token.id+"/key")&&spec.method==="POST")return response({success:true,data:{key}});
    if(pathname.endsWith("/api/token")&&spec.method==="POST")return response({success:true,message:""});
    if(pathname.endsWith("/api/token")&&spec.method==="PUT"){
      const value=exactJson(spec.bodyText);Object.assign(token,value);
      return response({success:true,data:token});
    }
    if(pathname.endsWith("/api/token/"+token.id)&&spec.method==="DELETE"){records.splice(0,1);return response({success:true});}
    throw Error("Unexpected mock endpoint");
  };
  const get=(fn,query={})=>fn(f.ctx(undefined,{query:{accountId:account.id,...query}}));
  const post=(fn,body={})=>fn(f.ctx({accountId:account.id,operationId:op(),...body}));
  const detail=async()=>{const r=await get(plugin.getToken,{tokenId:token.id});assert.equal(r.statusCode,200,JSON.stringify(r.body));return r.body.token;};
  return {f,account,token,records,get,post,detail};
}
const writes=f=>f.calls.filter(c=>c.method!=="GET");
test("兼容宿主冻结的 HttpClientHandle，不修改其方法",async()=>{
  const h=await tokenFixture();
  const ctx=h.f.ctx(undefined,{query:{accountId:h.account.id}});
  const create=ctx.http.createClient.bind(ctx.http);
  ctx.http.createClient=async options=>Object.freeze(await create(options));
  const result=await plugin.listTokens(ctx);
  assert.equal(result.statusCode,200);assert.equal(result.body.items.length,1);
});

test("令牌金额换算不使用浮点舍入，支持大整数、零、负余额和非终止小数",()=>{
  assert.equal(amountQuota("18014398509481.986246",usd),"9007199254740993123");
  assert.equal(quotaAmount("9007199254740993123",usd),"18014398509481.986246");
  for(const quota of ["0","1","500000","1000000000000000000","9223372036854775807"])
    assert.equal(amountQuota(quotaAmount(quota,usd),usd),quota);
  assert.equal(quotaAmount("-500000",usd),"-1");
  assert.equal(quotaAmount("1",{...usd,quotaPerUnit:"3"}),null);
  assert.equal(amountQuota("0.14",{...usd,rate:"7"}),"10000");
  assert.equal(quotaAmount("10000",{...usd,rate:"7"}),"0.14");
  assert.equal(amountQuota("0.9",{...usd,rate:"0.9"}),"500000");
  assert.throws(()=>amountQuota("0.000001",usd),/整数 quota/);
  for(const v of ["1e3","NaN","-1","01","","1.2.3","9223372036854775808"])
    assert.throws(()=>tokenInteger(v));
  assert.throws(()=>amountQuota("1",null));
  assert.equal(currencyFor({siteType:"AnyRouter",baseUrl:"https://other.example"},null),null);
  assert.equal(currencyFor({}, {quota_display_type:"USD",quota_per_unit:"0"}),null);
});
test("令牌名称按 UTF-8 字节校验，IP 白名单覆盖 IPv4/IPv6/CIDR",()=>{
  assert.equal(tokenName("  我的令牌  "),"我的令牌");
  assert.equal(tokenName("x".repeat(50)).length,50);
  for(const v of ["", "x".repeat(51),"中".repeat(17),"a\nb","\ud800"])assert.throws(()=>tokenName(v));
  assert.equal(ipWhitelist(" 192.0.2.1 \r\n2001:db8::/32\n::ffff:192.0.2.2\n192.0.2.1"),"192.0.2.1\n2001:db8::/32\n::ffff:192.0.2.2");
  for(const v of ["::","::1","2001:db8:0:0:0:0:1:1","0.0.0.0/0","::/0","2001:db8::1/128"])assert.equal(ipWhitelist(v),v);
  for(const v of ["1.2.3","256.1.1.1","01.2.3.4","1.2.3.4/33","::/129","1::2::3",":::","1:2:3:4:5:6:7:8:9","hostname","1.2.3.4,\n::1","1.2.3.4/","::ffff:192.0.2.999","1.2.3.4\nX\u0000"])assert.throws(()=>ipWhitelist(v),v);
});
test("过期时间固定 UTC+8，校验真实日期并保留秒",()=>{
  assert.equal(expiryInput("2030-01-02T10:30:15"),String(Date.parse("2030-01-02T02:30:15Z")/1000));
  assert.equal(expiryDisplay(expiryInput("2030-01-02T10:30:15")),"2030-01-02T10:30:15");
  assert.equal(expiryDisplay("-1"),"");
  for(const v of ["2030-02-30T10:30","bad","2030-01-01T25:00","2030-01-01T10:30Z"])assert.throws(()=>expiryInput(v));
});
for(const [siteType,legacy] of [["NewAPI",false],["AnyRouter",true],["AgentRouter",false],["NewAPI",true],["AnyRouter",false]])
  test(`${siteType} ${legacy?"数组零基":"对象一基"}分页、认证与隐藏密钥`,async()=>{
    const h=await tokenFixture(siteType,{legacy,config:{route:"pool"}});
    for(let i=1;i<21;i++)h.records.push({...initial(),id:String(i),name:"token-"+i});
    const first=await h.get(plugin.listTokens);assert.equal(first.statusCode,200,JSON.stringify(first.body));
    assert.equal(first.body.items.length,20);assert.equal(first.body.hasNext,true);
    assert.equal(first.body.total,legacy?null:"21");
    assert.equal(first.body.items[0].remain_quota,"9007199254740993123");
    assert.doesNotMatch(JSON.stringify(first),/TOKEN_SECRET|AGENT_SECRET|COOKIE_SECRET/);
    const second=await h.get(plugin.listTokens,{page:"2"});assert.equal(second.statusCode,200);
    assert.equal(second.body.items[0].id,"20");assert.equal(second.body.hasNext,false);
    const listCalls=h.f.calls.filter(c=>c.url.includes("/api/token/?"));
    assert.deepEqual(listCalls.map(c=>new URL(c.url).searchParams.get("p")),["0","0",legacy?"1":"2"]);
    assert.ok(h.f.calls.every(c=>c.method==="GET"&&c.body===undefined&&!c.followRedirects&&!c.allowDirectFallback));
    assert.ok(h.f.clients.every(c=>c.closed&&c.options.route==="pool"&&!c.options.allowDirectFallback));
    for(const call of h.f.calls.filter(c=>!c.url.endsWith("/api/status"))){
      assert.equal(call.headers.cookie,siteType==="AgentRouter"?"session=AGENT_SECRET":"session=COOKIE_SECRET");
      assert.equal(call.headers["new-api-user"],"90071992547409931234");
    }
    assert.equal(h.account.credential.fields.lastResult,undefined);
  });
for(const siteType of ["NewAPI","AnyRouter","AgentRouter"])test(`${siteType} 单令牌新建、全部字段编辑、状态和删除`,async()=>{
  const h=await tokenFixture(siteType,{legacy:siteType==="AnyRouter"});
  const options=await h.get(plugin.tokenOptions);
  assert.equal(options.statusCode,200);assert.equal(options.body.groups.length,3);assert.equal(options.body.models.length,2);
  const quota={mode:"amount",value:"10.25",currencyRevision:options.body.currency.revision};
  const created=await h.post(plugin.createToken,{changes:{name:"创建",group:"other",expired_time:"-1",unlimited_quota:false,
    model_limits_enabled:true,model_limits:["model-a"],allow_ips:"192.0.2.0/24\n2001:db8::1"},quota});
  assert.equal(created.statusCode,200,JSON.stringify(created.body));assert.equal(created.body.success,true);
  assert.equal(writes(h.f).length,1);
  const create=exactJson(writes(h.f)[0].bodyText);
  assert.equal(create.remain_quota,"5125000");assert.equal(create.model_limits,"model-a");assert.equal(create.id,undefined);
  assert.equal(writes(h.f)[0].contentType,"application/json");
  const current=await h.detail();
  const updated=await h.post(plugin.updateToken,{tokenId:current.id,revision:current.revision,
    changes:{name:"改名",group:"other",expired_time:String(Math.floor(Date.now()/1000)+86400),unlimited_quota:true,
      model_limits_enabled:true,model_limits:["model-b"],allow_ips:"::1"}});
  assert.equal(updated.statusCode,200,JSON.stringify(updated.body));
  const update=writes(h.f)[1];
  assert.match(update.bodyText,/"id":90071992547409931/);assert.doesNotMatch(update.bodyText,/"id":"/);
  assert.match(update.bodyText,/"remain_quota":9007199254740993123/);
  assert.equal(h.token.name,"改名");assert.equal(h.token.group,"other");assert.equal(h.token.allow_ips,"::1");
  const revised=await h.detail();
  const disabled=await h.post(plugin.setTokenStatus,{tokenId:revised.id,revision:revised.revision,status:"2"});
  assert.equal(disabled.statusCode,200);
  assert.deepEqual(exactJson(writes(h.f)[2].bodyText),{id:revised.id,status:"2"});
  const last=await h.detail();
  assert.equal((await h.post(plugin.deleteToken,{tokenId:last.id,revision:last.revision})).statusCode,200);
  assert.equal(writes(h.f)[3].method,"DELETE");assert.equal(writes(h.f)[3].bodyText,undefined);
  assert.equal(h.account.credential.fields.lastSuccessDay,undefined);
  assert.doesNotMatch(JSON.stringify([...h.f.state.values(),...h.f.logs,...h.f.jobs.values()]),/TOKEN_SECRET|COOKIE_SECRET|AGENT_SECRET/);
});
test("仅按需读取旧版或新版完整密钥，不缓存也不重复添加 sk-",async()=>{
  for(const masked of [false,true]){
    const h=await tokenFixture("NewAPI",{masked});
    const details=await h.detail();assert.equal(details.key,undefined);
    const result=await h.post(plugin.tokenKey,{tokenId:h.token.id});
    assert.equal(result.body.key,"sk-"+key);assert.equal(writes(h.f).length,masked?1:0);
    h.token.key="sk-"+key;
    assert.equal((await h.post(plugin.tokenKey,{tokenId:h.token.id})).body.key,"sk-"+key);
    assert.doesNotMatch(JSON.stringify([...h.f.state.values(),h.account.credential,h.f.logs]),/TOKEN_SECRET/);
  }
});
test("新建成功不猜测返回 ID、不自动获取密钥或重复创建",async()=>{
  const h=await tokenFixture();
  const result=await h.post(plugin.createToken,{changes:{name:"重复名称",unlimited_quota:true}});
  assert.equal(result.statusCode,200);assert.equal(result.body.tokenId,undefined);
  assert.equal(result.body.key,undefined);assert.equal(writes(h.f).length,1);
  assert.equal(h.f.calls.filter(c=>c.url.includes("/api/token/")&&c.method==="GET").length,0);
});
test("编辑名称保留最新消费额度、已有模型和隐藏扩展配置",async()=>{
  const h=await tokenFixture();
  Object.assign(h.token,{group:"auto",cross_group_retry:true,auto_groups:["default","other"],model_limits:"old-model"});
  const current=await h.detail();h.token.remain_quota="100";
  const original=h.f.handler;let reads=0;
  h.f.handler=async spec=>{
    if(spec.method==="GET"&&spec.url.endsWith("/api/token/"+h.token.id)&&++reads===2)h.token.remain_quota="90";
    return original(spec);
  };
  const result=await h.post(plugin.updateToken,{tokenId:current.id,revision:current.revision,changes:{name:"改名"}});
  assert.equal(result.statusCode,200);
  const sent=exactJson(writes(h.f)[0].bodyText);
  assert.equal(sent.remain_quota,"90");assert.equal(sent.cross_group_retry,true);
  assert.deepEqual(sent.auto_groups,["default","other"]);assert.equal(sent.model_limits,"old-model");
  assert.equal(sent.key,undefined);assert.equal(sent.used_quota,undefined);
});
test("编辑前或最终写前配置冲突拒绝覆盖",async()=>{
  for(const late of [false,true]){
    const h=await tokenFixture(),current=await h.detail(),original=h.f.handler;let reads=0;
    if(!late)h.token.name="别人修改";
    else h.f.handler=async spec=>{
      if(spec.method==="GET"&&spec.url.endsWith("/api/token/"+h.token.id)&&++reads===2)h.token.name="别人修改";
      return original(spec);
    };
    const result=await h.post(plugin.updateToken,{tokenId:current.id,revision:current.revision,changes:{name:"我的修改"}});
    assert.equal(result.statusCode,409);assert.equal(writes(h.f).length,0);
  }
});
test("写请求成功重放返回同一结果；不同请求复用操作 ID 被拒绝",async()=>{
  const h=await tokenFixture(),operationId=op(),body={operationId,changes:{name:"一次",unlimited_quota:true}};
  const first=await h.post(plugin.createToken,body);assert.equal(first.statusCode,200);
  const count=h.f.requests.length;
  assert.deepEqual(await h.post(plugin.createToken,body),first);assert.equal(h.f.requests.length,count);
  assert.equal((await h.post(plugin.createToken,{...body,changes:{name:"第二次",unlimited_quota:true}})).statusCode,409);
  assert.equal(writes(h.f).length,1);
});
for(const [name,reply]of [
  ["网络错误",()=>{throw Error("TOKEN_SECRET COOKIE_SECRET")}],
  ["HTTP 500",()=>response("",500)],["HTTP 408",()=>response("",408)],
  ["异常正文",()=>response("<html>KEY_SECRET</html>")],["缺少成功标志",()=>response({message:"TOKEN_SECRET"})]
])test(`写请求${name}保持待核对；重复提交不重放`,async()=>{
  const h=await tokenFixture(),original=h.f.handler,body={operationId:op(),changes:{name:"一次",unlimited_quota:true}};
  h.f.handler=spec=>spec.method==="POST"?reply():original(spec);
  const result=await h.post(plugin.createToken,body);
  assert.equal(result.statusCode,409);assert.equal(result.body.uncertain,true);
  assert.doesNotMatch(JSON.stringify(result),/TOKEN_SECRET|COOKIE_SECRET|KEY_SECRET/);
  const count=h.f.requests.length;
  assert.equal((await h.post(plugin.createToken,body)).body.uncertain,true);
  assert.equal(h.f.requests.length,count);assert.equal(writes(h.f).length,1);
});
test("写响应明确业务失败不伪装成功；失败请求同样不重放",async()=>{
  const h=await tokenFixture(),original=h.f.handler,body={operationId:op(),changes:{name:"一次",unlimited_quota:true}};
  h.f.handler=spec=>spec.method==="POST"?response({success:false,message:"TOKEN_SECRET"}):original(spec);
  const result=await h.post(plugin.createToken,body);
  assert.equal(result.statusCode,400);assert.equal(result.body.uncertain,false);
  assert.doesNotMatch(JSON.stringify(result),/TOKEN_SECRET/);
  await h.post(plugin.createToken,body);assert.equal(writes(h.f).length,1);
});
test("写请求取消透传，Pending 记录保留，后续不会重发",async()=>{
  const h=await tokenFixture(),original=h.f.handler,body={operationId:op(),changes:{name:"一次",unlimited_quota:true}};
  h.f.handler=spec=>{if(spec.method==="POST")throw cancellation();return original(spec);};
  await assert.rejects(h.post(plugin.createToken,body),{code:"host.cancelled"});
  assert.equal((await h.post(plugin.createToken,body)).body.uncertain,true);
  assert.equal(writes(h.f).length,1);assert.ok(h.f.clients.every(c=>c.closed));
});
test("记账故障不因上游成功而再次创建，过期操作 ID 永不重发",async t=>{
  const h=await tokenFixture(),ctx=h.f.ctx({accountId:h.account.id,operationId:op(),changes:{name:"一次",unlimited_quota:true}});
  ctx.state.shared.set=async()=>{throw Error("store failed TOKEN_SECRET")};
  const result=await plugin.createToken(ctx);
  assert.equal(result.statusCode,200);assert.equal(result.body.success,true);assert.ok(result.body.warning);
  assert.equal((await plugin.createToken(ctx)).body.uncertain,true);assert.equal(writes(h.f).length,1);
  t.mock.method(Date,"now",()=>Number(ctx.body.operationId.split(":")[0])+8*86400000);
  const later=await plugin.createToken(ctx);
  assert.equal(later.statusCode,409);assert.match(later.body.error,/过期/);assert.equal(writes(h.f).length,1);
});
test("验证拒绝任意字段、非法 ID、未知分组/模型、无额度及非整数换算",async()=>{
  const h=await tokenFixture(),options=await h.get(plugin.tokenOptions);
  for(const body of [
    {changes:{name:"x",key:"BAD",unlimited_quota:true}},
    {changes:{name:"x"}},
    {changes:{name:"x",unlimited_quota:true,group:"unknown"}},
    {changes:{name:"x",unlimited_quota:true,model_limits_enabled:true,model_limits:[]}},
    {changes:{name:"x",unlimited_quota:true,model_limits:["unknown"]}},
    {changes:{name:"x",unlimited_quota:true,allow_ips:"invalid"}},
    {changes:{name:"x"},quota:{mode:"quota",value:100}},
    {changes:{name:"x"},quota:{mode:"amount",value:"0.000001",currencyRevision:options.body.currency.revision}}
  ]){
    const result=await h.post(plugin.createToken,body);assert.equal(result.statusCode,400,JSON.stringify(body));
  }
  for(const tokenId of ["1/../../user/self","0","-1","1?x=1",42]){
    assert.equal((await h.get(plugin.getToken,{tokenId})).statusCode,400);
    assert.equal((await h.post(plugin.tokenKey,{tokenId})).statusCode,400);
  }
  assert.equal(writes(h.f).length,0);
});
test("货币汇率变化拒绝旧金额输入；原始 quota 不依赖汇率",async()=>{
  const h=await tokenFixture(),options=await h.get(plugin.tokenOptions),original=h.f.handler;
  h.f.handler=spec=>spec.url.endsWith("/api/status")?response({success:true,data:{quota_display_type:"CNY",quota_per_unit:500000,usd_exchange_rate:7}}):original(spec);
  assert.equal((await h.post(plugin.createToken,{changes:{name:"x"},quota:{mode:"amount",value:"1",currencyRevision:options.body.currency.revision}})).statusCode,409);
  assert.equal(writes(h.f).length,0);
  assert.equal((await h.post(plugin.createToken,{changes:{name:"x"},quota:{mode:"quota",value:"0"}})).statusCode,200);
  assert.equal(exactJson(writes(h.f)[0].bodyText).remain_quota,"0");
});
test("选项失败不隐藏现有令牌，站点未知格式不当作空列表",async()=>{
  const h=await tokenFixture(),original=h.f.handler;
  h.f.handler=spec=>spec.url.endsWith("/api/status")||spec.url.endsWith("/groups")||spec.url.endsWith("/models")
    ?response("<html>TOKEN_SECRET</html>",403):original(spec);
  const options=await h.get(plugin.tokenOptions);
  assert.equal(options.statusCode,200);assert.equal(options.body.groupsLoaded,false);assert.equal(options.body.modelsLoaded,false);
  assert.equal(options.body.currency,null);assert.equal(options.body.errors.length,3);
  const list=await h.get(plugin.listTokens);assert.equal(list.statusCode,200);assert.equal(list.body.items.length,1);assert.equal(list.body.currency,null);
  h.f.handler=async()=>response({success:true,data:{unexpected:[]}});
  assert.equal((await h.get(plugin.listTokens)).statusCode,502);
  assert.equal(writes(h.f).length,0);
});
test("账号归属、禁用、Redis、origin、账号锁及代理失败均阻止令牌请求",async()=>{
  for(const mode of ["foreign","disabled","redis","origin","lock","proxy"]){
    const h=await tokenFixture();
    if(mode==="foreign")h.account.platform="other";
    if(mode==="disabled")h.account.status.state="Disabled";
    if(mode==="redis")h.f.available=false;
    if(mode==="origin")h.f.origins.clear();
    if(mode==="lock")await acquire(h.f.ctx(),accountLock(h.f.ctx(),h.account.id));
    const ctx=h.f.ctx(undefined,{query:{accountId:h.account.id}});
    if(mode==="proxy")ctx.http.createClient=async()=>{throw Object.assign(Error("TOKEN_SECRET"),{code:"host.proxy_pool_unavailable"});};
    const result=await plugin.listTokens(ctx);
    assert.ok(result.statusCode>=400,mode);assert.equal(h.f.requests.length,0,mode);
    assert.doesNotMatch(JSON.stringify(result),/TOKEN_SECRET/);
  }
});
test("令牌接口请求前再次校验身份和 origin，禁止凭据发送到新站点",async()=>{
  for(const mode of ["identity","origin","lock"]){
    const h=await tokenFixture(),ctx=h.f.ctx(undefined,{query:{accountId:h.account.id}});
    const original=ctx.http.request;
    ctx.http.request=async spec=>{
      const result=await original(spec);
      if(mode==="identity")h.account.credential.fields.config=JSON.stringify({...JSON.parse(h.account.credential.fields.config),cookie:"session=CHANGED"});
      if(mode==="origin")h.f.origins.clear();
      if(mode==="lock")h.f.state.clear();
      return result;
    };
    assert.ok((await plugin.listTokens(ctx)).statusCode>=400);
    assert.equal(h.f.requests.length,1);assert.equal(writes(h.f).length,0);
  }
});
test("Agent 旧会话仍可查余额；令牌要求正确路径且永不自动登录",async()=>{
  const h=await tokenFixture("AgentRouter");
  const raw=JSON.parse(h.account.credential.fields.balanceSession);delete raw.cookiePath;
  h.account.credential.fields.balanceSession=JSON.stringify(raw);
  const legacy=await h.get(plugin.listTokens);
  assert.equal(legacy.statusCode,401);assert.match(legacy.body.error,/作用域/);assert.equal(h.f.requests.length,0);
  assert.equal((await refreshBalance(h.f.ctx(),h.account.id)).results[0].status,"Success");
  for(const scope of ["/api/user","/api/token-other"]){
    raw.cookiePath=scope;h.account.credential.fields.balanceSession=JSON.stringify(raw);
    const count=h.f.requests.length;
    assert.equal((await h.get(plugin.listTokens)).statusCode,401);assert.equal(h.f.requests.length,count);
  }
  assert.equal(writes(h.f).length,0);
});
test("Agent 认证失效清理会话，不覆盖余额或签到；普通拒绝不丢会话",async()=>{
  for(const status of [401,403,429,500]){
    const h=await tokenFixture("AgentRouter");
    h.f.handler=async()=>response("TOKEN_SECRET",status);
    const saved=h.account.credential.fields.balanceSession;
    const result=await h.get(plugin.listTokens);assert.ok(result.statusCode>=400);
    assert.equal(h.account.credential.fields.balanceSession,status===401?undefined:saved);
    assert.equal(h.account.credential.fields.balance,undefined);
    assert.equal(h.account.credential.fields.lastResult,undefined);assert.equal(writes(h.f).length,0);
    assert.doesNotMatch(JSON.stringify(result),/TOKEN_SECRET/);
  }
});
test("子路径和 Cookie Path 精确匹配，status 不携带账号认证",async()=>{
  const h=await tokenFixture("AgentRouter",{config:{baseUrl:"https://agentrouter.org/sub",route:"pool"}});
  assert.equal((await h.get(plugin.tokenOptions)).statusCode,200);
  assert.ok(h.f.calls.every(c=>new URL(c.url).pathname.startsWith("/sub/api/")));
  const meta=h.f.calls.find(c=>c.url.endsWith("/api/status"));
  assert.equal(meta.headers.cookie,undefined);assert.equal(meta.headers["new-api-user"],undefined);
});
test("端点总预算约束 HTTP 请求并停止后续写操作",async t=>{
  let now=Date.now();t.mock.method(Date,"now",()=>now);
  const h=await tokenFixture(),original=h.f.handler;
  h.f.handler=async spec=>{const result=await original(spec);now+=21000;return result;};
  const result=await h.post(plugin.createToken,{changes:{name:"x",group:"other",unlimited_quota:true}});
  assert.ok(result.statusCode>=400);assert.equal(writes(h.f).length,0);
  assert.ok(h.f.requests.every(r=>r.timeoutMs<=20000));
});
