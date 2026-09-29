import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const html=await fs.readFile(new URL("./ui/index.html",import.meta.url),"utf8");
const account=(overrides={})=>({
  id:"a",version:"1",label:"日常站点",siteType:"NewAPI",baseUrl:"https://new.example",enabled:true,available:true,
  autoCheckIn:true,route:"direct",cookie:"session=COOKIE_SECRET",userId:"123",username:"",password:"",
  hasCookie:true,hasPassword:false,userAgent:"",lastResult:null,lastSuccessDay:null,...overrides
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
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
test("漂亮空态、统计与账号筛选使用真实 DOM，外部文字不注入 HTML",async t=>{
  const p=await page(t,[account({label:'<img src=x onerror="alert(1)">'}),account({id:"b",siteType:"AgentRouter",cookie:"",password:"PASSWORD",hasPassword:true})]);
  assert.equal(p.$("#statTotal").textContent,"2");assert.equal(p.$("#cards").querySelectorAll("img").length,0);
  p.click('[data-type="AgentRouter"]');assert.equal(p.$("#cards").children.length,1);assert.match(p.$("#cards").textContent,/登录并签到/);
  p.$("#search").value="没有这个备注";p.event(p.$("#search"),"input");assert.match(p.$("#cards").textContent,/没有匹配/);
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
test("Cron 默认/每日时间预设/JSON 双向同步，预览不执行签到",async t=>{
  const p=await page(t,[account()],async(_,route,body)=>{
    if(route==="schedule/preview")return{cron:body.cron,next:["2026-10-01T01:30:00Z"]};
  });p.click('[data-action="edit"]');
  assert.equal(p.$('[name="cron"]').value,"0 10 10 * * *");
  p.$("#dailyTime").value="09:30";p.click("#applyTime");
  assert.equal(p.$('[name="cron"]').value,"0 30 9 * * *");
  p.click("#jsonTab");const config=JSON.parse(p.$("#jsonText").value);assert.equal(config.cron,"0 30 9 * * *");
  assert.equal(config.queryBalance,true);
  config.cron="0 30 9 * * 1-5";config.queryBalance=false;p.$("#jsonText").value=JSON.stringify(config);
  p.click("#previewCron");await until(()=>p.$("#cronPreview").textContent.includes("2026"));
  assert.match(p.$("#cronPreview").textContent,/UTC\+8/);
  assert.equal(p.calls.filter(c=>c.route==="checkin/start"||c.route==="balance/start").length,0);
  p.click("#visualTab");assert.equal(p.$('[name="cron"]').value,"0 30 9 * * 1-5");assert.equal(p.$('[name="queryBalance"]').checked,false);
  p.click("#resetCron");assert.equal(p.$('[name="cron"]').value,"0 10 10 * * *");
});
test("余额卡显示精确字符串/旧数据/未知，不把未知当成零；Agent 无隐含登录按钮",async t=>{
  const p=await page(t,[account({balance:{state:"Stale",error:"上游限流",snapshot:{amount:"180143985094819.862468",unit:"USD",quota:"90071992547409931234",note:"精确金额",updatedAt:"2026-09-29T00:00:00Z"}}}),
    account({id:"b",siteType:"AgentRouter"})]);
  assert.match(p.$("#cards").textContent,/180143985094819\.862468/);
  assert.match(p.$("#cards").textContent,/上次记录/);assert.match(p.$("#cards").textContent,/上游限流/);
  assert.equal(p.$('[data-account="b"] .balance-value strong').textContent,"—");
  assert.equal(p.$('[data-account="b"] [data-action="balance"]'),null);
});
test("余额单独刷新入队，防重复点击且不调用签到接口",async t=>{
  let resolve;
  const p=await page(t,[account()],async(_,route)=>{
    if(route==="balance/start")return new Promise(r=>resolve=r);
  });
  p.click('[data-action="balance"]');p.click('[data-action="balance"]');
  assert.equal(p.calls.filter(c=>c.route==="balance/start").length,1);
  assert.equal(p.$('[data-action="run"]').disabled,true);
  resolve({id:"balance-job",name:"js-checkin-balance",state:"Queued"});await until(()=>!p.$("#jobPanel").hidden);
  assert.match(p.$("#jobTitle").textContent,/余额查询/);
  assert.equal(p.calls.filter(c=>c.route==="checkin/start").length,0);
});
test("Cron 编辑期间过期的预览响应不会覆盖提示",async t=>{
  let resolve;
  const p=await page(t,[account()],async(_,route)=>route==="schedule/preview"?new Promise(r=>resolve=r):undefined);
  p.click('[data-action="edit"]');p.click("#previewCron");
  p.$('[name="cron"]').value="bad";p.event(p.$('[name="cron"]'),"input");
  resolve({cron:"0 10 10 * * *",next:["2026-10-01T02:10:00Z"]});
  await until(()=>!p.$("#previewCron").disabled);assert.doesNotMatch(p.$("#cronPreview").textContent,/2026/);
});
test("余额 job 完成只显示余额结果，不冒充签到成功",async t=>{
  const p=await page(t,[account()],async(_,route)=>{
    if(route==="balance/start")return{id:"b",name:"js-checkin-balance",state:"Completed",result:{completed:1,total:1,results:[{label:"账号",status:"Success",message:"余额已更新；未执行签到"}]}};
  });
  p.click('[data-action="balance"]');await until(()=>!p.$("#jobPanel").hidden);
  assert.match(p.$("#jobResults").textContent,/余额已更新/);assert.doesNotMatch(p.$("#jobResults").textContent,/签到成功/);
  assert.doesNotMatch(p.$("#jobResults").textContent,/未执行签到/);
});
test("页面仅保留功能文案，账号编辑与 JSON 均没有附注提示",async t=>{
  const p=await page(t,[account()]);
  const copy=()=>{const root=p.dom.window.document.body.cloneNode(true);root.querySelectorAll("script,style").forEach(e=>e.remove());return root.textContent};
  assert.equal(p.$(".hero h1").textContent,"中转站签到");
  assert.equal(p.$(".hero p").textContent,"账号管理、自动签到、余额查询");
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
test("只清理系统反馈附注，不修改用户名称和凭据中的括号",async t=>{
  const name="个人账号（备用）",password="P(test)（SECRET）";
  const p=await page(t,[account({label:name,siteType:"AgentRouter",username:"ethan",password,hasPassword:true,
    lastResult:{status:"Failed",message:"上游拒绝请求（HTTP 403）；未重试"}})]);
  assert.equal(p.$(".card-name").textContent,name);
  assert.equal(p.$(".result-msg").textContent,"上游拒绝请求");
  p.click('[data-action="edit"]');assert.equal(p.$('[name="password"]').value,password);
  p.click("#jsonTab");const json=JSON.parse(p.$("#jsonText").value);assert.equal(json.password,password);assert.equal(json.label,name);
  p.click("#visualTab");assert.equal(p.$('[name="password"]').value,password);
});
test("保存成功和复制只显示操作结果",async t=>{
  const p=await page(t,[account()]);p.click('[data-action="edit"]');
  p.click("#copyJson");await until(()=>!p.$("#toast").hidden);
  assert.equal(p.$("#toast").textContent,"按 Ctrl+C 复制");
  p.event(p.$("#accountForm"),"submit");await until(()=>!p.$("#editor").open);
  assert.equal(p.$("#toast").textContent,"已保存");
});
