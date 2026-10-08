import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { renderPage } from "./tools/ui.mjs";
import { JSDOM } from "jsdom";
const html=await renderPage(fileURLToPath(new URL(".",import.meta.url)));
const account=(overrides={})=>({
  id:"a",version:"1",label:"日常站点",siteType:"NewAPI",baseUrl:"https://new.example",enabled:true,available:true,
  autoCheckIn:true,route:"direct",cookie:"session=COOKIE_SECRET",userId:"123",username:"",password:"",
  hasCookie:true,hasPassword:false,userAgent:"",lastResult:null,lastSuccessDay:null,...overrides
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const tokenRow=(overrides={})=>({
  id:"9007199254740993",name:"工作密钥",status:"1",group:"default",remain_quota:"9007199254740993",
  used_quota:"0",expired_time:"-1",unlimited_quota:false,model_limits_enabled:false,
  model_limits:[],allow_ips:"",revision:"revision",amount:null,usedAmount:null,...overrides
});
const tokenSettings=(overrides={})=>({
  groups:[{value:"default",label:"默认"}],models:["gpt-a","gpt-b"],groupsLoaded:true,modelsLoaded:true,
  currency:{unit:"USD",quotaPerUnit:"500000",rate:"1",revision:"currency"},errors:[],...overrides
});
function tokenMock(overrides={}){
  return async(method,route,body)=>{
    if(overrides.handler){const result=await overrides.handler(method,route,body);if(result!==undefined)return result}
    if(route.startsWith("tokens/list?"))return {page:1,total:null,hasNext:false,currency:null,items:[tokenRow(overrides.token)]};
    if(route.startsWith("tokens/detail?"))return {token:tokenRow(overrides.token)};
    if(route.startsWith("tokens/options?"))return tokenSettings(overrides.settings);
    if(route==="tokens/key")return {key:"sk-DOM_TEST_SECRET"};
    if(route==="tokens/operation")return {operationId:"SERVER:"+Math.random()};
    if(["tokens/create","tokens/update","tokens/status","tokens/delete"].includes(route))return {success:true,message:"已完成"};
  };
}
async function until(predicate){for(let i=0;i<60;i++){if(predicate())return;await tick()}assert.ok(predicate(),"异步 UI 条件未达成")}
async function page(t, rows=[],handler){
  const calls=[],blobs=[];
  const dom=new JSDOM(html,{
    url:"https://router.invalid/plugin",runScripts:"dangerously",pretendToBeVisual:true,
    beforeParse(window){
      window.confirm=()=>true;
      if(!window.HTMLDialogElement.prototype.showModal)window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","")};
      if(!window.HTMLDialogElement.prototype.close)window.HTMLDialogElement.prototype.close=function(){this.removeAttribute("open")};
      window.URL.createObjectURL=blob=>{blobs.push(blob);return"blob:test"};window.URL.revokeObjectURL=()=>{};
      window.HTMLAnchorElement.prototype.click=function(){};
      window.Router2API={request:async(method,route,body)=>{
        calls.push({method,route,body:body===undefined?undefined:JSON.parse(JSON.stringify(body))});
        if(handler){const result=await handler(method,route,body);if(result!==undefined)return result}
        if(route==="accounts")return{accounts:rows,jobs:[]};
        if(route==="accounts/save")return{account:body};
        throw Error("Unexpected route: "+route);
      }};
    }
  });
  t.after(()=>dom.window.close());
  await until(()=>dom.window.document.querySelector("#refresh").disabled===false);
  const $=s=>dom.window.document.querySelector(s);
  return{dom,$,calls,blobs,click:s=>$(s).click(),event:(target,name)=>target.dispatchEvent(new dom.window.Event(name,{bubbles:true,cancelable:true}))};
}
for(const siteType of ["NewAPI","AnyRouter","AgentRouter"])test(`${siteType} UI 可选 CK 或账号密码，保存与 JSON 一致`,async t=>{
  const p=await page(t,[account({siteType})]);
  p.click('[data-action="edit"]');
  p.$('[name="authMode"]').value="password";p.event(p.$('[name="authMode"]'),"change");
  assert.equal(p.$(".cookie-field").hidden,true);assert.equal(p.$(".agent-field").hidden,false);
  assert.equal(p.$('[name="cookie"]').value,"");assert.equal(p.$('[name="userId"]').value,"");
  p.$('[name="username"]').value="test-user";p.$('[name="password"]').value="TEST_PASSWORD";
  p.click("#jsonTab");
  const config=JSON.parse(p.$("#jsonText").value);assert.equal(config.authMode,"password");assert.equal(config.username,"test-user");
  p.click("#visualTab");p.event(p.$("#accountForm"),"submit");
  await until(()=>p.calls.some(c=>c.route==="accounts/save"));
  const body=p.calls.find(c=>c.route==="accounts/save").body;
  assert.equal(body.authMode,"password");assert.equal(body.cookie,"");assert.equal(body.password,"TEST_PASSWORD");
});
test("认证模式切换清空旧凭据；旧密码 JSON 不要求 Cookie/UID",async t=>{
  const p=await page(t);p.click("#add");
  p.$('[name="authMode"]').value="password";p.event(p.$('[name="authMode"]'),"change");
  p.$('[name="username"]').value="old";p.$('[name="password"]').value="old-password";
  p.$('[name="authMode"]').value="cookie";p.event(p.$('[name="authMode"]'),"change");
  assert.equal(p.$('[name="username"]').value,"");assert.equal(p.$('[name="password"]').value,"");
  assert.equal(p.$(".cookie-field").hidden,false);
  p.click("#jsonTab");p.$("#jsonText").value=JSON.stringify({label:"legacy",siteType:"NewAPI",baseUrl:"https://new.example",username:"user",password:"PASS"});
  p.click("#visualTab");assert.equal(p.$('[name="authMode"]').value,"password");assert.equal(p.$(".agent-field").hidden,false);
  p.event(p.$("#accountForm"),"submit");await until(()=>p.calls.some(c=>c.route==="accounts/save"));
  assert.equal(p.calls.find(c=>c.route==="accounts/save").body.authMode,"password");
});
test("令牌独立页面与快捷入口；密钥按需显示复制，切账号和离页清空",async t=>{
  const p=await page(t,[account(),account({id:"b",siteType:"AnyRouter"}),account({id:"c",siteType:"AgentRouter"})],tokenMock());
  const copied=[];
  Object.defineProperty(p.dom.window.navigator,"clipboard",{value:{writeText:async value=>copied.push(value)}});
  p.click('[data-action="tokens"]');await until(()=>!!p.$(".token-key"));
  assert.equal(p.$("#accountsPage").hidden,true);assert.equal(p.$("#tokenAccount").options.length,3);
  assert.equal(p.calls.some(c=>c.route==="tokens/key"),false);
  assert.match(p.$(".token-key").value,/•/);
  p.click('[data-token-action="show"]');await until(()=>p.$(".token-key").value.startsWith("sk-"));
  p.click('[data-token-action="copy"]');await until(()=>copied.length===1);
  assert.equal(copied[0],"sk-DOM_TEST_SECRET");assert.equal(p.calls.filter(c=>c.route==="tokens/key").length,1);
  Object.defineProperty(p.dom.window.document,"hidden",{configurable:true,value:true});
  p.event(p.dom.window.document,"visibilitychange");
  assert.match(p.$(".token-key").value,/•/);assert.equal(p.$('[data-token-action="show"]').textContent,"查看密钥");
  p.$("#tokenAccount").value="b";p.event(p.$("#tokenAccount"),"change");
  await until(()=>!!p.$(".token-key"));assert.match(p.$(".token-key").value,/•/);
  assert.ok(p.calls.some(c=>c.route.includes("accountId=b")));
  p.click("#accountsTab");assert.equal(p.$("#tokensPage").hidden,true);assert.equal(p.$(".token-key"),null);
});
test("令牌旧账号迟到的列表和密钥响应不能污染新账号",async t=>{
  let resolveList,resolveKey,first=true;
  const p=await page(t,[account(),account({id:"b"})],tokenMock({handler:async(method,route)=>{
    if(route.startsWith("tokens/list?")&&route.includes("accountId=a")&&first){first=false;return new Promise(r=>resolveList=r)}
    if(route==="tokens/key")return new Promise(r=>resolveKey=r);
  }}));
  p.click("#tokensTab");await until(()=>!!resolveList);
  p.$("#tokenAccount").value="b";p.event(p.$("#tokenAccount"),"change");await until(()=>!!p.$(".token-key"));
  resolveList({page:1,total:null,hasNext:false,items:[tokenRow({name:"过时列表"})]});await tick();
  assert.doesNotMatch(p.$("#tokenList").textContent,/过时列表/);
  p.click('[data-token-action="show"]');await until(()=>!!resolveKey);
  p.$("#tokenAccount").value="a";p.event(p.$("#tokenAccount"),"change");await until(()=>!!p.$(".token-key"));
  resolveKey({key:"sk-STALE_SECRET"});await tick();assert.match(p.$(".token-key").value,/•/);
});
test("令牌新建精确转换、UTC+8、IP 与模型验证；提交防重且不自动读取密钥",async t=>{
  let resolveCreate;
  const p=await page(t,[account()],tokenMock({handler:async(method,route)=>route==="tokens/create"?new Promise(r=>resolveCreate=r):undefined}));
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click("#tokenAdd");
  await until(()=>!p.$("#tokenSave").disabled);
  const field=name=>p.$(`#tokenForm [name="${name}"]`);
  field("name").value="新令牌";field("quotaValue").value="18014398509.481986";p.event(field("quotaValue"),"input");
  field("quotaMode").value="quota";p.event(field("quotaMode"),"change");assert.equal(field("quotaValue").value,"9007199254740993");
  field("quotaMode").value="amount";p.event(field("quotaMode"),"change");assert.equal(field("quotaValue").value,"18014398509.481986");
  field("neverExpires").checked=false;p.event(field("neverExpires"),"change");field("expires").value="2099-01-01T08:00";
  field("allow_ips").value="999.1.1.1";p.event(p.$("#tokenForm"),"submit");assert.match(p.$("#tokenFormError").textContent,/IP/);
  field("allow_ips").value="::1\n10.0.0.0/8";field("model_limits_enabled").checked=true;p.event(field("model_limits_enabled"),"change");
  p.event(p.$("#tokenForm"),"submit");assert.match(p.$("#tokenFormError").textContent,/至少/);
  p.$("#tokenModels input").click();p.event(p.$("#tokenForm"),"submit");p.event(p.$("#tokenForm"),"submit");
  await until(()=>!!resolveCreate);
  const writes=p.calls.filter(c=>c.route==="tokens/create");assert.equal(writes.length,1);
  assert.equal(writes[0].body.quota.value,"18014398509.481986");
  assert.equal(writes[0].body.changes.expired_time,String(Date.parse("2099-01-01T00:00:00Z")/1000));
  assert.deepEqual(writes[0].body.changes.model_limits,["gpt-a"]);
  p.click("#tokenCancel");assert.equal(p.$("#tokenEditor").open,true);
  resolveCreate({success:true,message:"已创建"});await until(()=>!p.$("#tokenEditor").open);
  assert.equal(p.calls.some(c=>c.route==="tokens/key"),false);
});
test("编辑保留不可用分组和模型、旧 IP，未改额度不提交；选项失败不清配置",async t=>{
  const p=await page(t,[account()],tokenMock({
    token:{group:"retired",model_limits:["retired-model"],model_limits_enabled:true,allow_ips:"legacy-format"},
    settings:{groups:[],models:[],groupsLoaded:false,modelsLoaded:false,errors:["选项加载失败"]}
  }));
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="edit"]');
  await until(()=>!p.$("#tokenSave").disabled);
  const field=name=>p.$(`#tokenForm [name="${name}"]`);
  assert.equal(field("group").value,"retired");assert.equal(field("group").disabled,true);
  assert.equal(p.$("#tokenModels input").checked,true);assert.equal(p.$("#tokenModels input").disabled,true);
  field("name").value="改名";p.event(p.$("#tokenForm"),"submit");
  await until(()=>p.calls.some(c=>c.route==="tokens/update"));
  const body=p.calls.find(c=>c.route==="tokens/update").body;
  assert.deepEqual(body.changes,{name:"改名"});assert.equal(body.quota,undefined);
  assert.equal(body.tokenId,"9007199254740993");assert.equal(body.revision,"revision");
});
test("删除必须确认；启停只提交状态，待核对重复点击复用操作 ID",async t=>{
  const p=await page(t,[account()],tokenMock({handler:async(method,route)=>{
    if(route==="tokens/status")throw Error("此写请求结果待核对");
  }}));
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="delete"]');
  assert.equal(p.$("#confirmation").open,true);p.click("#rejectConfirm");await tick();
  assert.equal(p.calls.some(c=>c.route==="tokens/delete"),false);
  p.click('[data-token-action="delete"]');p.click("#acceptConfirm");await until(()=>p.calls.some(c=>c.route==="tokens/delete"));
  await until(()=>!p.$("#tokenRefresh").disabled);p.click('[data-token-action="status"]');
  await until(()=>p.$("#tokenPageError").textContent.includes("待核对"));p.click('[data-token-action="status"]');await tick();
  const writes=p.calls.filter(c=>c.route==="tokens/status");assert.equal(writes.length,2);
  assert.equal(writes[0].body.operationId,writes[1].body.operationId);assert.equal(writes[0].body.status,"2");
  assert.equal(writes[0].body.changes,undefined);
});
test("关闭编辑器或切换账号后忽略迟到的详情与选项",async t=>{
  let resolveOptions;
  const p=await page(t,[account(),account({id:"b"})],tokenMock({handler:async(method,route)=>{
    if(route.startsWith("tokens/options?"))return new Promise(r=>resolveOptions=r);
  }}));
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="edit"]');
  await until(()=>!!resolveOptions);p.click("#tokenCancel");
  p.$("#tokenAccount").value="b";p.event(p.$("#tokenAccount"),"change");
  resolveOptions(tokenSettings());await tick();
  assert.equal(p.$("#tokenEditor").open,false);assert.equal(p.$('#tokenForm [name="name"]').value,"");
});
test("剪贴板 API 被拒绝时自动复制，不暴露密钥也不要求 Ctrl+C",async t=>{
  const p=await page(t,[account()],tokenMock());
  Object.defineProperty(p.dom.window.navigator,"clipboard",{value:{writeText:async()=>{throw Error("Permissions policy")}}});
  let copied;
  p.dom.window.document.execCommand=command=>{assert.equal(command,"copy");copied=p.dom.window.document.activeElement.value;return true;};
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="copy"]');
  await until(()=>copied==="sk-DOM_TEST_SECRET");
  assert.equal(p.$(".token-key").hidden,true);assert.match(p.$(".token-key").value,/•/);
  assert.doesNotMatch(p.$("#tokensPage").textContent,/Ctrl\+C/);
  assert.equal([...p.dom.window.document.querySelectorAll("textarea")].some(el=>el.value.includes("sk-DOM_TEST_SECRET")),false);
});
test("复制被浏览器完全阻止时明确失败，不误报成功或选中密钥",async t=>{
  const p=await page(t,[account()],tokenMock());
  p.dom.window.document.execCommand=()=>false;
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="copy"]');
  await until(()=>p.$("#tokenPageError").textContent.includes("剪贴板权限"));
  assert.equal(p.$(".token-key").hidden,true);assert.match(p.$(".token-key").value,/•/);
});
test("复制密钥请求迟到时不会写入旧账号密钥",async t=>{
  let resolveKey,copies=0;
  const p=await page(t,[account(),account({id:"b"})],tokenMock({handler:async(method,route)=>route==="tokens/key"?new Promise(r=>resolveKey=r):undefined}));
  p.dom.window.document.execCommand=()=>{copies++;return true;};
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="copy"]');
  await until(()=>!!resolveKey);
  p.$("#tokenAccount").value="b";p.event(p.$("#tokenAccount"),"change");
  resolveKey({key:"sk-OLD_ACCOUNT"});await tick();await tick();
  assert.equal(copies,0);
});
test("ClipboardItem 在点击时申请写入，异步取得密钥后填充",async t=>{
  let resolveKey,written;
  const p=await page(t,[account()],tokenMock({handler:async(method,route)=>route==="tokens/key"?new Promise(r=>resolveKey=r):undefined}));
  p.dom.window.ClipboardItem=class{constructor(value){this.value=value;}};
  Object.defineProperty(p.dom.window.navigator,"clipboard",{value:{write:async items=>{written=items[0];await written.value["text/plain"];}}});
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="copy"]');
  assert.ok(written);await until(()=>!!resolveKey);resolveKey({key:"sk-DOM_TEST_SECRET"});
  await until(()=>!p.$("#tokenRefresh").disabled);
  const blob=await written.value["text/plain"];
  assert.equal(blob.type,"text/plain");assert.equal(p.$(".token-key").hidden,true);
});
test("列表快照直接打开编辑器，60 秒内重开不请求详情或选项；手动刷新清缓存",async t=>{
  const p=await page(t,[account()],tokenMock());
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));p.click('[data-token-action="edit"]');
  await until(()=>!p.$("#tokenSave").disabled);p.click("#tokenCancel");p.click('[data-token-action="edit"]');
  await until(()=>!p.$("#tokenSave").disabled);
  assert.equal(p.calls.filter(c=>c.route.startsWith("tokens/detail?")).length,0);
  assert.equal(p.calls.filter(c=>c.route.startsWith("tokens/options?")).length,1);
  p.click("#tokenCancel");p.click("#tokenRefresh");await until(()=>!p.$("#tokenRefresh").disabled);
  p.click('[data-token-action="edit"]');await until(()=>!p.$("#tokenSave").disabled);
  assert.equal(p.calls.filter(c=>c.route.startsWith("tokens/options?")).length,2);
});
test("操作凭证由服务端签发，不受浏览器时钟偏差影响；成功启停后生成新凭证",async t=>{
  const p=await page(t,[account()],tokenMock());
  p.dom.window.Date.now=()=>1;
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));
  for(let i=0;i<2;i++){
    p.click('[data-token-action="status"]');
    await until(()=>p.calls.filter(c=>c.route==="tokens/status").length===i+1&&!p.$("#tokenRefresh").disabled);
  }
  const writes=p.calls.filter(c=>c.route==="tokens/status");
  assert.match(writes[0].body.operationId,/^SERVER:/);
  assert.notEqual(writes[0].body.operationId,writes[1].body.operationId);
  assert.equal(p.calls.filter(c=>c.route==="tokens/operation").length,2);
});
test("紧凑令牌表格显示创建时间、独立额度和更多菜单，不包含聊天",async t=>{
  const p=await page(t,[account()],tokenMock({token:{created_time:"0",unlimited_quota:true}}));
  p.click("#tokensTab");await until(()=>!!p.$(".token-key"));
  assert.match(p.$("#tokenList").textContent,/1970-01-01 08:00:00/);
  assert.match(p.$("#tokenList").textContent,/∞ 无限制/);
  assert.doesNotMatch(p.$("#tokenList").textContent,/聊天/);
  assert.equal(p.$(".token-more").open,false);
  assert.ok(p.$('.token-menu [data-token-action="delete"]'));
  p.click(".token-more summary");await until(()=>p.$(".token-more").open);
  p.dom.window.document.dispatchEvent(new p.dom.window.KeyboardEvent("keydown",{key:"Escape"}));
  assert.equal(p.$(".token-more").open,false);
});
test("漂亮空态、统计与账号筛选使用真实 DOM，外部文字不注入 HTML",async t=>{
  const p=await page(t,[account({label:'<img src=x onerror="alert(1)">'}),account({id:"b",siteType:"AgentRouter",cookie:"",password:"PASSWORD",hasPassword:true})]);
  assert.equal(p.$("#statTotal").textContent,"2");assert.equal(p.$("#cards").querySelectorAll("img").length,0);
  p.click('[data-type="AgentRouter"]');assert.equal(p.$("#cards").children.length,1);assert.match(p.$("#cards").textContent,/登录并签到/);
  p.$("#search").value="没有这个备注";p.event(p.$("#search"),"input");assert.match(p.$("#cards").textContent,/没有匹配/);
});
test("账号卡片成功置前、未签到居中、失败及认证异常置后，同类保持原顺序",async t=>{
  const rows=Object.freeze([
    account({id:"expired",lastResult:{status:"AuthExpired"},available:false}),
    account({id:"pending"}),
    account({id:"already",lastResult:{status:"Already"}}),
    account({id:"failed",lastResult:{status:"Failed"},lastSuccessDay:new Date(Date.now()+8*3600000).toISOString().slice(0,10)}),
    account({id:"success",lastResult:{status:"Success"}}),
    account({id:"skipped",lastResult:{status:"Skipped"}}),
    account({id:"challenge",lastResult:{status:"Challenge"}}),
    account({id:"limited",lastResult:{status:"RateLimited"}}),
    account({id:"uncertain",lastResult:{status:"Uncertain"}}),
    account({id:"invalid",invalid:true,lastResult:{status:"Success"},available:false})
  ]);
  const original=rows.map(a=>a.id),p=await page(t,rows);
  const order=()=>Array.from(p.$("#cards").children,card=>card.dataset.account);
  const expected=["already","success","pending","skipped","expired","failed","challenge","limited","uncertain","invalid"];
  assert.deepEqual(order(),expected);assert.equal(p.$("#statTotal").textContent,"10");assert.equal(p.$("#statAttention").textContent,"6");
  p.event(p.$("#search"),"input");assert.deepEqual(order(),expected);
  assert.deepEqual(rows.map(a=>a.id),original);assert.equal(p.calls.length,1);assert.equal(p.calls[0].route,"accounts");
  p.click('[data-account="success"] [data-action="edit"]');p.event(p.$("#accountForm"),"submit");
  await until(()=>p.calls.some(c=>c.route==="accounts/save"));
  assert.equal(p.calls.find(c=>c.route==="accounts/save").body.id,"success");
});
test("站点筛选和搜索后仍按签到结果排序，不额外请求站点",async t=>{
  const p=await page(t,[
    account({id:"failed",label:"主力失败",siteType:"AnyRouter",lastResult:{status:"AuthExpired"}}),
    account({id:"other",label:"主力成功",siteType:"AgentRouter",lastResult:{status:"Success"}}),
    account({id:"pending",label:"主力待签",siteType:"AnyRouter"}),
    account({id:"already",label:"主力已签",siteType:"AnyRouter",lastResult:{status:"Already"}}),
    account({id:"success",label:"备用成功",siteType:"AnyRouter",lastResult:{status:"Success"}})
  ]);
  const order=()=>Array.from(p.$("#cards").children,card=>card.dataset.account);
  p.click('[data-type="AnyRouter"]');assert.deepEqual(order(),["already","success","pending","failed"]);
  p.$("#search").value="主力";p.event(p.$("#search"),"input");assert.deepEqual(order(),["already","pending","failed"]);
  p.click('[data-type="all"]');assert.deepEqual(order(),["other","already","pending","failed"]);
  p.$("#search").value="";p.event(p.$("#search"),"input");assert.deepEqual(order(),["other","already","success","pending","failed"]);
  assert.equal(p.calls.length,1);assert.equal(p.calls[0].route,"accounts");
});
test("刷新后随最新签到结果重排，成功账号恢复前列，失败账号移到末尾",async t=>{
  const rows=[account({id:"a",lastResult:{status:"Failed"}}),account({id:"b",lastResult:{status:"Success"}}),account({id:"c"})];
  const p=await page(t,rows),order=()=>Array.from(p.$("#cards").children,card=>card.dataset.account);
  assert.deepEqual(order(),["b","c","a"]);
  rows[0].lastResult={status:"Success"};rows[1].lastResult={status:"AuthExpired"};
  p.click("#refresh");await until(()=>!p.$("#refresh").disabled);
  assert.deepEqual(order(),["a","c","b"]);
  rows[1].lastResult={status:"Already"};p.click("#refresh");await until(()=>!p.$("#refresh").disabled);
  assert.deepEqual(order(),["a","b","c"]);
  assert.equal(p.calls.length,3);assert.ok(p.calls.every(c=>c.method==="GET"&&c.route==="accounts"));
});
test("签到任务完成后账号自动重排，仅改变展示顺序",async t=>{
  const rows=[account({id:"a",lastResult:{status:"Failed"}}),account({id:"b",lastResult:{status:"Success"}})];
  const p=await page(t,rows,async(_,route)=>{
    if(route==="checkin/start")return{id:"sort-job",name:"js-checkin-run",state:"Running",progress:{completed:0,total:2,results:[]}};
    if(route.startsWith("jobs/status")){
      rows[0].lastResult={status:"Success"};rows[1].lastResult={status:"AuthExpired"};
      return{id:"sort-job",name:"js-checkin-run",state:"Completed",result:{total:2,results:rows.map(a=>({accountId:a.id,label:a.label,...a.lastResult}))}};
    }
  });
  const order=()=>Array.from(p.$("#cards").children,card=>card.dataset.account);
  assert.deepEqual(order(),["b","a"]);p.click("#runAll");await until(()=>p.$("#jobTitle").textContent==="正在执行");
  p.click("#pollJob");await until(()=>p.$("#jobTitle").textContent==="执行结束"&&!p.$("#refresh").disabled&&order()[0]==="a");
  assert.deepEqual(order(),["a","b"]);assert.deepEqual(rows.map(a=>a.id),["a","b"]);
  const writes=p.calls.filter(c=>c.method==="POST");assert.equal(writes.length,1);
  assert.equal(writes[0].route,"checkin/start");assert.deepEqual(writes[0].body,{all:true});
  assert.equal(p.calls.filter(c=>c.route==="accounts").length,2);
});
test("可视化/JSON 双向切换保留完整凭据，非法 JSON 不丢失文本",async t=>{
  const p=await page(t,[account()]);p.click('[data-action="edit"]');
  assert.equal(p.$('[name="cookie"]').value,"session=COOKIE_SECRET");p.click("#jsonTab");
  let config=JSON.parse(p.$("#jsonText").value);assert.equal(config.cookie,"session=COOKIE_SECRET");assert.equal(config.id,undefined);
  config.label="JSON 修改";config.cookie="session=UPDATED";p.$("#jsonText").value=JSON.stringify(config);p.click("#visualTab");
  assert.equal(p.$('[name="label"]').value,"JSON 修改");assert.equal(p.$('[name="cookie"]').value,"session=UPDATED");
  p.click("#jsonTab");p.$("#jsonText").value="{bad";p.click("#visualTab");
  assert.equal(p.$("#jsonEditor").hidden,false);assert.equal(p.$("#jsonText").value,"{bad");assert.match(p.$("#formError").textContent,/JSON/);
});
test("站点类型切换显示对应凭据，清除旧秘密；缺少必填项不会提交",async t=>{
  const p=await page(t);p.click("#add");p.$('[name="cookie"]').value="session=OLD";
  p.$('[name="siteType"]').value="AgentRouter";p.event(p.$('[name="siteType"]'),"change");
  assert.equal(p.$('[name="baseUrl"]').value,"https://agentrouter.org");assert.equal(p.$('[name="cookie"]').value,"");
  assert.equal(p.$(".cookie-field").hidden,true);assert.equal(p.$(".agent-field").hidden,false);
  p.$('[name="label"]').value="Agent";p.event(p.$("#accountForm"),"submit");
  assert.match(p.$("#formError").textContent,/用户名/);assert.equal(p.calls.filter(c=>c.route==="accounts/save").length,0);
});
test("JSON 导入绑定当前编辑会话，不接受 ID/版本注入；保存携带完整密码",async t=>{
  const p=await page(t,[account({siteType:"AgentRouter",username:"u",password:"P",hasPassword:true})]);p.click('[data-action="edit"]');p.click("#jsonTab");
  const value=JSON.parse(p.$("#jsonText").value);value.id="foreign";p.$("#jsonText").value=JSON.stringify(value);p.event(p.$("#accountForm"),"submit");
  assert.match(p.$("#formError").textContent,/不支持/);delete value.id;value.password="NEW";p.$("#jsonText").value=JSON.stringify(value);p.event(p.$("#accountForm"),"submit");
  await until(()=>p.calls.some(c=>c.route==="accounts/save"));
  const sent=p.calls.find(c=>c.route==="accounts/save").body;assert.equal(sent.id,"a");assert.equal(sent.version,"1");assert.equal(sent.password,"NEW");
});
test("导入 JSON 文件与直接导出，不弹出额外提示，保留完整配置",async t=>{
  const p=await page(t);p.click("#add");
  const value={label:"文件导入",siteType:"AnyRouter",baseUrl:"https://anyrouter.top",cookie:"session=FULL_SECRET",userId:"2"};
  Object.defineProperty(p.$("#jsonFile"),"files",{configurable:true,value:[{size:200,text:async()=>JSON.stringify(value)}]});
  p.event(p.$("#jsonFile"),"change");await until(()=>p.$('[name="label"]').value==="文件导入");
  p.click("#exportJson");assert.equal(p.$("#confirmation").open,false);
  await until(()=>p.blobs.length===1);
  const raw=await new Promise((resolve,reject)=>{const reader=new p.dom.window.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(p.blobs[0])});
  const exported=JSON.parse(raw);assert.equal(exported.cookie,"session=FULL_SECRET");assert.equal(exported.id,undefined);
});
test("启动中按钮防重复；取消请求不显示为已退出，查询实际状态后更新",async t=>{
  let startResolve,cancelled=false,state="Running";
  const p=await page(t,[account()],async(method,route)=>{
    if(route==="checkin/start")return new Promise(r=>startResolve=r);
    if(route==="jobs/cancel"){cancelled=true;return{accepted:true}}
    if(route.startsWith("jobs/status"))return{id:"job",state,progress:{completed:0,total:1,results:[]}};
  });
  p.click('[data-action="run"]');p.click('[data-action="run"]');assert.equal(p.calls.filter(c=>c.route==="checkin/start").length,1);
  assert.equal(p.$('[data-action="run"]').disabled,true);startResolve({id:"job",state:"Running",progress:{completed:0,total:1,results:[]}});
  await until(()=>!p.$("#jobPanel").hidden);p.click("#cancelJob");await until(()=>cancelled);
  assert.equal(p.$("#jobTitle").textContent,"正在执行");assert.match(p.$("#cancelJob").textContent,/取消中/);
  state="Cancelled";await tick();await tick();p.click("#pollJob");await until(()=>p.$("#jobTitle").textContent==="任务已取消");
});
test("不确定结果需要人工确认重发；保存进行中不能关闭丢失状态",async t=>{
  let saveResolve;
  const p=await page(t,[account({lastResult:{status:"Uncertain",message:"未确认"}})],async(method,route)=>{
    if(route==="checkin/start")return{id:"j",state:"Completed",result:{total:1,results:[]}};
    if(route==="accounts/save")return new Promise(r=>saveResolve=r);
  });
  p.click('[data-action="run"]');assert.match(p.$("#confirmationText").textContent,/确认重新签到/);p.click("#acceptConfirm");await tick();
  assert.equal(p.calls.find(c=>c.route==="checkin/start").body.acknowledgeUncertain,true);
  p.click('[data-action="edit"]');p.event(p.$("#accountForm"),"submit");p.click("#closeEditor");assert.equal(p.$("#editor").open,true);
  saveResolve({account:{}});await until(()=>!p.$("#editor").open);assert.equal(p.$('[name="cookie"]').value,"");
});
test("响应式断点、键盘焦点和无远程资源约束",()=>{
  assert.match(html,/@media\(max-width:640px\)/);assert.match(html,/focus-visible/);assert.match(html,/prefers-reduced-motion/);
  assert.doesNotMatch(html,/<(?:script|link|img)\b[^>]*(?:src|href)=["']https?:/i);
  assert.doesNotMatch(html,/\b(?:localStorage|sessionStorage|fetch)\s*[.(]/);
  assert.doesNotMatch(html,/\bwindow\.(?:confirm|alert|prompt)\s*\(/);
});
test("统一时间预览不执行签到；余额开关仍支持 JSON 双向同步",async t=>{
  const p=await page(t,[account()],async(_,route)=>{
    if(route==="schedule/preview")return{cron:"0 10 10 * * *",next:["2026-10-01T02:10:00Z"]};
  });p.click('[data-action="edit"]');
  assert.equal(p.$('[name="cron"]'),null);
  p.click("#jsonTab");const config=JSON.parse(p.$("#jsonText").value);assert.equal(config.cron,undefined);
  assert.equal(config.queryBalance,true);
  config.queryBalance=false;p.$("#jsonText").value=JSON.stringify(config);
  p.click("#previewCron");await until(()=>p.$("#cronPreview").textContent.includes("2026"));
  assert.match(p.$("#cronPreview").textContent,/UTC\+8/);
  assert.equal(p.calls.filter(c=>c.route==="checkin/start"||c.route==="balance/start").length,0);
  p.click("#visualTab");assert.equal(p.$('[name="queryBalance"]').checked,false);
});
test("余额卡显示精确字符串/旧数据/未知，不把未知当成零；Agent 同样显示刷新按钮",async t=>{
  const p=await page(t,[account({balance:{state:"Stale",error:"上游限流",snapshot:{amount:"180143985094819.862468",unit:"USD",quota:"90071992547409931234",note:"精确金额",updatedAt:"2026-09-29T00:00:00Z"}}}),
    account({id:"b",siteType:"AgentRouter"})]);
  assert.match(p.$("#cards").textContent,/180143985094819\.862468/);
  assert.match(p.$("#cards").textContent,/上次记录/);assert.match(p.$("#cards").textContent,/上游限流/);
  assert.equal(p.$('[data-account="b"] .balance-value strong').textContent,"—");
  assert.ok(p.$('[data-account="b"] [data-action="balance"]'));
});
for(const siteType of ["NewAPI","AnyRouter","AgentRouter"])test(`${siteType} 余额单独刷新入队，防重复点击且不调用签到接口`,async t=>{
  let resolve;
  const p=await page(t,[account({siteType})],async(_,route)=>{
    if(route==="balance/start")return new Promise(r=>resolve=r);
  });
  p.click('[data-action="balance"]');p.click('[data-action="balance"]');
  assert.equal(p.calls.filter(c=>c.route==="balance/start").length,1);
  assert.deepEqual(p.calls.find(c=>c.route==="balance/start").body,{id:"a"});
  assert.equal(p.$('[data-action="run"]').disabled,true);
  resolve({id:"balance-job",name:"js-checkin-balance",state:"Queued"});await until(()=>!p.$("#jobPanel").hidden);
  assert.match(p.$("#jobTitle").textContent,/余额查询/);
  assert.equal(p.calls.filter(c=>c.route==="checkin/start").length,0);
});
test("重新打开编辑器后，旧预览响应不会覆盖提示",async t=>{
  let resolve;
  const p=await page(t,[account()],async(_,route)=>route==="schedule/preview"?new Promise(r=>resolve=r):undefined);
  p.click('[data-action="edit"]');p.click("#previewCron");
  p.click("#closeEditor");p.click("#add");
  resolve({cron:"0 10 10 * * *",next:["2026-10-01T02:10:00Z"]});
  await until(()=>!p.$("#previewCron").disabled);assert.doesNotMatch(p.$("#cronPreview").textContent,/2026/);
});
test("余额 job 完成只显示余额结果，不冒充签到成功",async t=>{
  const p=await page(t,[account()],async(_,route)=>{
    if(route==="balance/start")return{id:"b",name:"js-checkin-balance",state:"Completed",result:{completed:1,total:1,results:[{label:"账号",status:"Success",message:"余额已更新"}]}};
  });
  p.click('[data-action="balance"]');await until(()=>!p.$("#jobPanel").hidden);
  assert.match(p.$("#jobResults").textContent,/余额已更新/);assert.doesNotMatch(p.$("#jobResults").textContent,/签到成功/);
  assert.doesNotMatch(p.$("#jobResults").textContent,/未执行签到/);
});
test("页面仅保留功能文案，账号编辑与 JSON 均没有附注提示",async t=>{
  const p=await page(t,[account()]);
  const copy=()=>{const root=p.dom.window.document.body.cloneNode(true);root.querySelectorAll("script,style").forEach(e=>e.remove());return root.textContent};
  assert.equal(p.$(".hero h1").textContent,"中转站签到");
  assert.equal(p.$(".hero p").textContent,"账号管理、自动签到、余额查询、API 令牌");
  assert.equal(p.$(".footer"),null);assert.equal(p.$("#providerHint"),null);
  p.click('[data-action="edit"]');assert.equal(p.$("#editorTitle").textContent,"账号编辑");
  assert.equal(p.$("#jsonTab").textContent,"JSON");assert.equal(p.$("#cronPreview").textContent,"");
  assert.equal(p.$('[name="approveOrigin"]').parentElement.textContent,"授权访问此站点");
  for(const mode of ["#visualTab","#jsonTab"]){
    p.click(mode);
    assert.doesNotMatch(copy(),/[（(][^）)]*[）)]|敏感|凭据|完整显示|请妥善保管|泄露|不接入模型|不会|不触发|独立签到|各司其职|一目了然|井然有序/);
  }
  p.click("#exportJson");assert.equal(p.$("#confirmation").open,false);
});
test("响应、用户名称和凭据中的括号原样展示",async t=>{
  const name="个人账号（备用）",password="P(test)（SECRET）";
  const p=await page(t,[account({label:name,siteType:"AgentRouter",username:"ethan",password,hasPassword:true,
    lastResult:{status:"Failed",message:"上游拒绝请求（HTTP 403）；未重试"}})]);
  assert.equal(p.$(".card-name").textContent,name);
  assert.equal(p.$(".result-msg").textContent,"上游拒绝请求（HTTP 403）；未重试");
  p.click('[data-action="edit"]');assert.equal(p.$('[name="password"]').value,password);
  p.click("#jsonTab");const json=JSON.parse(p.$("#jsonText").value);assert.equal(json.password,password);assert.equal(json.label,name);
  p.click("#visualTab");assert.equal(p.$('[name="password"]').value,password);
});
test("保存成功和复制只显示操作结果",async t=>{
  const p=await page(t,[account()]);p.click('[data-action="edit"]');
  p.dom.window.document.execCommand=()=>true;
  p.click("#copyJson");await until(()=>!p.$("#toast").hidden);
  assert.equal(p.$("#toast").textContent,"已复制");
  p.event(p.$("#accountForm"),"submit");await until(()=>!p.$("#editor").open);
  assert.equal(p.$("#toast").textContent,"已保存");
});
test("账号与任务响应正文作为文本显示，不执行 HTML，保留括号和换行",async t=>{
  const raw='<html>\n<script>window.REMOTE_EXECUTED=true</script>错误（403）；(details)\n</html>';
  const p=await page(t,[account({lastResult:{status:"Failed",httpStatus:403,message:raw}})],async(_,route)=>{
    if(route==="checkin/start")return{id:"raw",name:"js-checkin-run",state:"Completed",result:{total:1,results:[{label:"账号",status:"Failed",httpStatus:403,message:raw}]}};
  });
  assert.equal(p.$(".result-msg").textContent,raw);
  assert.match(p.$(".result").textContent,/HTTP 403/);
  assert.equal(p.$(".result script"),null);assert.equal(p.dom.window.REMOTE_EXECUTED,undefined);
  p.click('[data-action="run"]');await until(()=>!p.$("#jobPanel").hidden);
  assert.equal(p.$("#jobResults .result-msg").textContent,raw);
  assert.equal(p.$("#jobResults script"),null);assert.equal(p.dom.window.REMOTE_EXECUTED,undefined);
});
for(const siteType of ["NewAPI","AnyRouter"])test(`${siteType} 密码登录失败在账号与任务中直接显示响应`,async t=>{
  const raw='{\n  "success": false,\n  "message": "用户名或密码错误（上游响应）"\n}';
  const result={label:"账号",status:"AuthExpired",httpStatus:200,message:raw};
  const p=await page(t,[account({siteType,authMode:"password",cookie:"",userId:"",username:"test-user",password:"TEST_PASSWORD",hasPassword:true,lastResult:result})],async(_,route)=>{
    if(route==="checkin/start")return{id:"login-response",name:"js-checkin-run",state:"Completed",result:{total:1,results:[result]}};
  });
  assert.equal(p.$(".result-msg").textContent,raw);assert.match(p.$(".result").textContent,/HTTP 200/);
  p.click('[data-action="run"]');await until(()=>!p.$("#jobPanel").hidden);
  assert.equal(p.$("#jobResults .result-msg").textContent,raw);assert.match(p.$("#jobResults").textContent,/HTTP 200/);
  assert.doesNotMatch(p.$("#cards").textContent+p.$("#jobResults").textContent,/登录未完成|请检查凭据、验证码或二次验证/);
});
test("成功响应同样展示正文",async t=>{
  const raw='{"message":"签到成功","success":true}';
  const p=await page(t,[account({lastResult:{status:"Success",httpStatus:200,message:raw}})]);
  assert.equal(p.$(".result-msg").textContent,raw);
  assert.match(p.$(".result").textContent,/HTTP 200/);
});
test("所有账号显示统一时间；编辑器和导出 JSON 不再带 Cron",async t=>{
  const p=await page(t,[account({cron:"0 30 9 * * *"})],async(_,route)=>{
    if(route==="schedule/preview")return{cron:"0 10 10 * * *",next:["2026-10-01T02:10:00Z"]};
  });
  assert.match(p.$(".card-schedule").textContent,/每天 10:10/);
  assert.doesNotMatch(p.$(".card-schedule").textContent,/09:30|0 30 9/);
  p.click('[data-action="edit"]');
  for(const selector of ['[name="cron"]','#dailyTime','#applyTime','#resetCron'])
    assert.equal(p.$(selector),null);
  p.click("#jsonTab");
  const value=JSON.parse(p.$("#jsonText").value);assert.equal("cron" in value,false);
  p.$("#jsonText").value=JSON.stringify({...value,cron:"not a cron"});
  p.click("#visualTab");assert.equal(p.$("#formError").textContent,"");
  p.click("#jsonTab");assert.equal("cron" in JSON.parse(p.$("#jsonText").value),false);
  p.click("#previewCron");await until(()=>p.$("#cronPreview").textContent.includes("2026"));
  assert.deepEqual(p.calls.find(c=>c.route==="schedule/preview").body,{});
  p.event(p.$("#accountForm"),"submit");await until(()=>!p.$("#editor").open);
  assert.equal("cron" in p.calls.find(c=>c.route==="accounts/save").body,false);
});
