import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const out=path.join(root,"artifacts","preview");
await fs.mkdir(out,{recursive:true});
let chrome;
for(const candidate of [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome","/usr/bin/chromium"].filter(Boolean)){
  try{await fs.access(candidate);chrome=candidate;break}catch{}
}
if(!chrome)throw Error("未找到 Chromium。设置 CHROME_PATH；此检查不会安装浏览器。");
const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const defaults={version:"1",enabled:true,available:true,autoCheckIn:true,route:"direct",userAgent:"",
  cookie:"session=DEMO_ONLY",userId:"1024",username:"",password:"",hasCookie:true,hasPassword:false,
  queryBalance:true};
const rows=[
  {id:"demo-1",label:"New API · 主力站点",siteType:"NewAPI",baseUrl:"https://new-api.example",lastSuccessDay:day,
    balance:{state:"Fresh",snapshot:{amount:"128.56",unit:"USD",quota:"64280000",note:"按站点单位换算",updatedAt:new Date().toISOString()}},
    lastResult:{status:"Success",message:"上游确认签到成功",finishedAt:new Date().toISOString()}},
  {id:"demo-2",label:"AnyRouter · 日常账号",siteType:"AnyRouter",baseUrl:"https://anyrouter.top",lastSuccessDay:day,
    balance:{state:"Fresh",snapshot:{amount:"96.8",unit:"USD",quota:"48400000",note:"500000 quota / USD",updatedAt:new Date().toISOString()}},
    lastResult:{status:"Already",message:"上游确认今日已签到",finishedAt:new Date().toISOString()}},
  {id:"demo-3",label:"AgentRouter · 工作账号",siteType:"AgentRouter",baseUrl:"https://agentrouter.org",
    cookie:"",username:"demo@example.test",password:"DEMO_ONLY",hasCookie:false,hasPassword:true,
    balance:{state:"Stale",error:"余额接口需要人机验证",checkedAt:new Date().toISOString(),snapshot:{amount:"45.2",unit:"USD",quota:"22600000",note:"上次查询记录",updatedAt:new Date(Date.now()-86400000).toISOString()}},
    lastResult:{status:"Uncertain",message:"登录成功，签到状态未确认",finishedAt:new Date().toISOString()}},
  {id:"demo-4",label:"New API · 备用线路",siteType:"NewAPI",baseUrl:"https://backup.example",route:"pool",autoCheckIn:false},
  {id:"demo-5",label:"AnyRouter · 测试账号",siteType:"AnyRouter",baseUrl:"https://anyrouter.top",
    lastResult:{status:"Challenge",message:"上游需要人机验证，请在浏览器处理",finishedAt:new Date().toISOString()}},
  {id:"demo-6",label:"AgentRouter · 备用账号",siteType:"AgentRouter",baseUrl:"https://agentrouter.org",
    enabled:false,available:false,autoCheckIn:false,cookie:"",username:"demo2@example.test",password:"DEMO_ONLY",hasCookie:false,hasPassword:true}
].map(row=>({...defaults,...row}));
const mock=`<script>window.Router2API={request:async(method,route,body)=>{if(route==="accounts")return{accounts:${JSON.stringify(rows)},jobs:[]};if(route==="schedule/preview")return{cron:"0 10 10 * * *",next:["2026-10-01T02:10:00Z"]};throw Error("离线演示不会执行签到")}};</script>`;
const version=JSON.parse(await fs.readFile(path.join(root,"plugin.json"),"utf8")).version;
const html=(await fs.readFile(path.join(root,"ui/index.html"),"utf8")).replace("</head>",mock+"</head>").replace(`>v${version}<`,`>演示数据 · v${version}<`);
await fs.writeFile(path.join(out,"index.html"),html);
await fs.writeFile(path.join(out,"sandbox.html"),`<!doctype html><meta charset="utf-8"><title>宿主沙箱离线测试</title>
<iframe id="host" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
<script>document.getElementById("host").srcdoc=${JSON.stringify(html).replace(/</g,"\\u003c")};</script>`);
const profile=await fs.mkdtemp(path.join(out,"browser-profile-"));
const child=spawn(chrome,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--disable-background-networking","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],
  {windowsHide:true,stdio:["ignore","ignore","pipe"]});
let socket;
try{
  const address=await new Promise((resolve,reject)=>{
    let log="";const timer=setTimeout(()=>reject(Error("等待 Chromium 调试端口超时")),15000);
    child.once("error",error=>{clearTimeout(timer);reject(error)});
    child.stderr.on("data",chunk=>{log+=chunk;const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1])}});
  });
  socket=new WebSocket(address);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
  let counter=0,session;const pending=new Map(),exceptions=[];
  socket.addEventListener("message",event=>{
    const message=JSON.parse(event.data);
    if(message.method==="Runtime.exceptionThrown")exceptions.push(message.params.exceptionDetails);
    const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);
    if(message.error)item.reject(Error(message.error.message));else item.resolve(message.result);
  });
  const send=(method,params={},withSession=true)=>new Promise((resolve,reject)=>{
    const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP 超时：${method}`))},10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session&&withSession?{sessionId:session}:{})}));
  });
  const target=await send("Target.createTarget",{url:"about:blank"},false);
  session=(await send("Target.attachToTarget",{targetId:target.targetId,flatten:true},false)).sessionId;
  await send("Page.enable");await send("Runtime.enable");
  const evaluate=async (expression,contextId)=>{
    const reply=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true,userGesture:true,...(contextId?{contextId}:{})});
    if(reply.exceptionDetails)throw Error(reply.exceptionDetails.text);return reply.result.value;
  };
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1280,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:pathToFileURL(path.join(out,"index.html")).href});
  for(let i=0;i<100;i++){if(await evaluate("document.querySelectorAll('article.account').length===6"))break;await wait(50)}
  assert.equal(await evaluate("document.querySelectorAll('article.account').length"),6);
  const screenshot=async name=>{
    const data=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    await fs.writeFile(path.join(out,name+".png"),Buffer.from(data.data,"base64"));
  };
  const noOverflow=async()=>assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true,"页面横向溢出");
  await noOverflow();await screenshot("desktop");
  await evaluate("document.querySelector('[data-action=\"edit\"]').click()");
  assert.equal(await evaluate("document.querySelector('#editor').open"),true);
  assert.equal(await evaluate("document.querySelector('#editorTitle').textContent"),"账号编辑");
  assert.equal(await evaluate("document.querySelector('#providerHint')"),null);
  assert.equal(await evaluate("document.querySelector('[name=\"cron\"]')"),null);
  await evaluate("document.querySelector('#previewCron').click()");
  for(let i=0;i<30;i++){if(await evaluate("document.querySelector('#cronPreview').textContent.includes('2026')"))break;await wait(50)}
  assert.equal(await evaluate("document.querySelector('#cronPreview').textContent.includes('2026')"),true);
  await screenshot("editor-visual");
  await evaluate("document.querySelector('#jsonTab').click()");
  assert.equal(await evaluate("JSON.parse(document.querySelector('#jsonText').value).cookie"),"session=DEMO_ONLY");
  assert.equal(await evaluate("'cron' in JSON.parse(document.querySelector('#jsonText').value)"),false);
  await screenshot("editor-json");
  await evaluate("document.querySelector('#closeEditor').click()");
  await send("Emulation.setDeviceMetricsOverride",{width:430,height:1000,deviceScaleFactor:1,mobile:true});
  await noOverflow();await screenshot("mobile");
  await evaluate("document.querySelector('[data-action=\"edit\"]').click()");
  await noOverflow();await screenshot("mobile-editor");
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:pathToFileURL(path.join(out,"sandbox.html")).href});
  let frame,frameTarget;
  for(let i=0;i<100;i++){
    const tree=await send("Page.getFrameTree");frame=tree.frameTree.childFrames?.find(f=>f.frame.url==="about:srcdoc")?.frame;
    frameTarget=(await send("Target.getTargets",{},false)).targetInfos.find(t=>t.type==="iframe"&&t.url==="about:srcdoc");
    if(frame||frameTarget)break;await wait(50);
  }
  assert.ok(frame||frameTarget,"未加载宿主模拟 iframe");
  await wait(150);
  let contextId;
  if(frameTarget){
    session=(await send("Target.attachToTarget",{targetId:frameTarget.targetId,flatten:true},false)).sessionId;
    await send("Runtime.enable");
  }else{
    contextId=(await send("Page.createIsolatedWorld",{frameId:frame.id,worldName:"ui-test"})).executionContextId;
  }
  assert.equal(await evaluate("document.querySelectorAll('article.account').length",contextId),6);
  await evaluate("document.querySelector('[data-action=\"delete\"]').click()",contextId);
  assert.equal(await evaluate("document.querySelector('#confirmation').open",contextId),true);
  await evaluate("document.querySelector('#rejectConfirm').click();document.querySelector('[data-action=\"edit\"]').click()",contextId);
  const before=new Set((await send("Target.getTargets",{},false)).targetInfos.map(t=>t.targetId));
  await evaluate("document.querySelector('#exportJson').click()",contextId);
  assert.equal(await evaluate("document.querySelector('#confirmation').open",contextId),false);
  let popup;
  for(let i=0;i<100;i++){
    popup=(await send("Target.getTargets",{},false)).targetInfos.find(t=>t.type==="page"&&!before.has(t.targetId));
    if(popup)break;await wait(50);
  }
  assert.ok(popup,"iframe 导出窗口未打开");
  session=(await send("Target.attachToTarget",{targetId:popup.targetId,flatten:true},false)).sessionId;
  assert.equal(await evaluate("document.querySelector('a[download]').download"),"js-checkin-account.json");
  assert.equal(await evaluate("JSON.parse(document.querySelector('textarea').value).cookie"),"session=DEMO_ONLY");
  assert.equal(await evaluate("document.title"),"导出账号");
  assert.equal(await evaluate("document.querySelector('p')"),null);
  const downloads=await fs.mkdtemp(path.join(out,"download-test-"));
  await send("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:downloads},false);
  await evaluate("document.querySelector('a[download]').click()");
  const downloaded=path.join(downloads,"js-checkin-account.json");
  for(let i=0;i<100;i++){try{await fs.access(downloaded);break}catch{await wait(50)}}
  assert.equal(JSON.parse(await fs.readFile(downloaded,"utf8")).cookie,"session=DEMO_ONLY");
  assert.equal(exceptions.length,0,"浏览器发生 JS 异常");
  await send("Browser.close",{},false);
  console.log("Chromium 离线验证通过：桌面/430px 手机、双模式及五张截图；同宿主 iframe 内确认、弹窗导出和实际 JSON 下载。");
  console.log(out);
}finally{
  socket?.close();
  if(child.exitCode===null){await new Promise(resolve=>setTimeout(resolve,300));if(child.exitCode===null)child.kill()}
}
