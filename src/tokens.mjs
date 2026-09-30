import { InputError, input, id, text, object, enabled, identity, acquire, renew, release, accountLock, cancelled } from "./common.mjs";
import { readAccount, readAgentSession, forgetAgentSession } from "./accounts.mjs";
import { exactJson, requireAgentSession } from "./balance.mjs";
import { prepareWaf, wafHeaders } from "./waf.mjs";
import { currencyFor, tokenInteger, tokenId, amountQuota, quotaAmount } from "./token-values.mjs";
import { tokenView, editableChanges, editableRevision, tokenWire } from "./token-fields.mjs";

class TokenError extends InputError {
  constructor(status,message,code="TOKEN_ERROR",uncertain=false) {
    super(status,message);this.code=code;this.uncertain=uncertain;
  }
}
function tokenEndpoint(handler) {
  return async ctx=>{
    try{return ctx.json(200,await handler(ctx));}
    catch(error){
      if(cancelled(error))throw error;
      return ctx.json(error instanceof InputError?error.status:503,{
        error:error instanceof InputError?error.message:"网络或宿主操作失败，未自动重试",
        code:error instanceof TokenError?error.code:"TOKEN_ERROR",uncertain:error instanceof TokenError&&error.uncertain
      });
    }
  };
}
function business(response) {
  const http=response.statusCode;
  if(http===401)throw new TokenError(401,"登录认证失效，请更新账号登录信息","AUTH_EXPIRED");
  if(http===429)throw new TokenError(429,"站点请求限流，未自动重试","RATE_LIMITED");
  if(http>=300&&http<400)throw new TokenError(502,"站点返回重定向，未跟随","REDIRECT");
  if(http===404||http===405)throw new TokenError(502,`站点接口不存在或不支持（HTTP ${http}）`,"UNSUPPORTED");
  if(http===403||http===412)throw new TokenError(403,`站点拒绝请求或要求验证（HTTP ${http}）`,"CHALLENGE");
  if(http<200||http>=300)throw new TokenError(502,`站点返回 HTTP ${http}`,"UPSTREAM");
  let json;
  try{json=exactJson(response.bodyText);}catch{throw new TokenError(502,"站点没有返回有效 JSON","BAD_RESPONSE");}
  if(!object(json)||typeof json.success!=="boolean")throw new TokenError(502,"站点响应缺少业务结果","BAD_RESPONSE");
  if(!json.success||json.error!=null&&json.error!==false){
    if(/未登录|登录.*(?:失效|过期)|unauthori[sz]ed|not logged|cookie.*(?:expired|invalid)/i.test(typeof json.message==="string"?json.message:""))
      throw new TokenError(401,"登录认证失效，请更新账号登录信息","AUTH_EXPIRED");
    throw new TokenError(400,"站点拒绝此操作，请检查字段、权限、额度或令牌状态","BUSINESS_REJECTED");
  }
  return json;
}
const accountBinding=(ctx,record)=>ctx.crypto.sha256(JSON.stringify([
  identity(ctx,record.config),record.config.route,record.config.userAgent
]));

/** @param {import("./common.mjs").Context} ctx */
async function withAccount(ctx,accountId,handler) {
  await readAccount(ctx,id(accountId));
  const lease=await acquire(ctx,accountLock(ctx,accountId));
  if(!lease)throw new InputError(409,"账号正在执行或编辑，请稍后重试");
  /** @type {import("../sdk/index").HttpClientHandle | undefined} */
  let client;
  try{
    const deadline=Date.now()+20000;
    const record=await readAccount(ctx,accountId),binding=accountBinding(ctx,record),config=record.config;
    const origin=ctx.url.parse(config.baseUrl).origin,basePath=ctx.url.parse(config.baseUrl).path.replace(/\/$/,"");
    const touch=async()=>{
      await ctx.delay(0);await renew(ctx,lease);
      const current=await readAccount(ctx,accountId);
      if(!enabled(current))throw new InputError(400,"账号已停用");
      if(accountBinding(ctx,current)!==binding)throw new InputError(409,"账号认证或网络配置变化，请刷新后重试");
      if(!(await ctx.http.approvedOrigins()).includes(origin))throw new InputError(403,"站点 origin 未授权");
    };
    await touch();
    const auth=config.siteType==="AgentRouter"?readAgentSession(ctx,record,basePath+"/api/token/"):config;
    let prepared;
    const open=async()=>{
      if(prepared)return;
      const handle=await ctx.http.createClient({route:config.route,allowDirectFallback:false});
      const send=handle.request.bind(handle);
      client={...handle,close:()=>handle.close()};
      client.request=spec=>{
        const remaining=deadline-Date.now();
        if(remaining<500)throw new InputError(503,"令牌请求超过时间预算，未自动重试");
        return send({...spec,timeoutMs:Math.min(spec.timeoutMs??15000,remaining)});
      };
      const result=await prepareWaf(ctx,config,client,touch);
      if(result.error)throw new TokenError(403,`站点验证未通过（${result.error.status}，HTTP ${result.error.httpStatus??"—"}）`,"CHALLENGE");
      prepared=result.config;
    };
    const request=async(method,path,bodyText=undefined,authenticated=true)=>{
      await open();await touch();
      if(authenticated&&config.siteType==="AgentRouter")requireAgentSession(auth,basePath+path.split("?")[0]);
      const headers=wafHeaders(prepared,{
        accept:"application/json",origin,referer:config.baseUrl+"/",
        ...(authenticated?{cookie:auth.cookie,"new-api-user":auth.userId}:{})
      });
      const response=await client.request({
        method,url:config.baseUrl+path,headers,responseType:"text",timeoutMs:15000,
        followRedirects:false,allowDirectFallback:false,
        ...(bodyText===undefined?{}:{bodyText,contentType:"application/json"})
      });
      try{return business(response);}
      catch(error){
        if(error instanceof TokenError&&error.code==="AUTH_EXPIRED"&&config.siteType==="AgentRouter")
          await forgetAgentSession(ctx,record);
        throw error;
      }
    };
    return await handler({ctx,record,binding,request,touch,open});
  }finally{
    if(client){try{await client.close();}catch{}}
    await release(ctx,lease);
  }
}
const queryOf=ctx=>ctx.query??{};
function pageNumber(value="1") {
  if(!/^[1-9]\d{0,5}$/.test(value))throw new InputError(400,"页码格式无效");
  return Number(value);
}
function revisionToken(service,data) {
  let token;
  try{token=tokenView(data);}catch{throw new InputError(502,"站点令牌字段不完整或版本不支持");}
  return {...token,revision:editableRevision(service.ctx,token)};
}
async function detail(service,token) {
  const result=await service.request("GET","/api/token/"+token);
  const value=revisionToken(service,result.data);
  if(value.id!==token)throw new InputError(502,"站点返回的令牌 ID 不匹配");
  return value;
}
async function conversion(service) {
  const fixed=currencyFor(service.record.config,null);
  if(fixed)return fixed;
  const meta=await service.request("GET","/api/status",undefined,false);
  return currencyFor(service.record.config,meta.data);
}
const currencyRevision=(ctx,currency)=>ctx.crypto.sha256(JSON.stringify(currency));
const currencyView=(ctx,currency)=>currency?{...currency,revision:currencyRevision(ctx,currency)}:null;

export const listTokens=tokenEndpoint(async ctx=>{
  const query=queryOf(ctx),page=pageNumber(query.page),size=20;
  return withAccount(ctx,query.accountId,async service=>{
    const first=await service.request("GET",`/api/token/?p=0&size=${size}`);
    const legacy=Array.isArray(first.data);
    if(!legacy&&(!object(first.data)||!Array.isArray(first.data.items)))throw new InputError(502,"站点令牌分页结构不支持");
    const data=page===1?first.data:(await service.request("GET",`/api/token/?p=${legacy?page-1:page}&size=${size}`)).data;
    const items=legacy?data:data?.items;
    if(!Array.isArray(items)||items.length>size||!legacy&&data.page!==String(page))
      throw new InputError(502,"站点返回的令牌分页不匹配");
    const total=legacy?null:tokenInteger(data.total,"令牌总数");
    const hasNext=legacy?items.length===size:Number(total)>page*size;
    let currency=null;
    try{currency=await conversion(service);}catch(error){if(cancelled(error)||error instanceof TokenError&&error.code==="AUTH_EXPIRED")throw error;}
    return {page,pageSize:size,total,hasNext,currency:currencyView(ctx,currency),items:items.map(item=>{
      const token=revisionToken(service,item);
      return {...token,amount:currency?quotaAmount(token.remain_quota,currency):null,usedAmount:currency?quotaAmount(token.used_quota,currency):null};
    })};
  });
});
export const getToken=tokenEndpoint(async ctx=>{
  const query=queryOf(ctx),token=tokenId(query.tokenId);
  return withAccount(ctx,query.accountId,async service=>({token:await detail(service,token)}));
});
export const tokenOptions=tokenEndpoint(async ctx=>{
  return withAccount(ctx,queryOf(ctx).accountId,async service=>{
    const errors=[],groups=[],models=[];
    let groupsLoaded=false,modelsLoaded=false,currency=null;
    const optional=async fn=>{
      try{return await fn();}catch(error){
        if(cancelled(error)||error instanceof TokenError&&error.code==="AUTH_EXPIRED")throw error;
        errors.push(error instanceof InputError?error.message:"站点选项加载失败");return null;
      }
    };
    await optional(async()=>{
      const data=(await service.request("GET","/api/user/self/groups")).data;
      if(!object(data)||Object.keys(data).length>1000)throw new InputError(502,"站点分组选项结构不支持");
      for(const [value,info]of Object.entries(data)){
        text(value,"站点分组",128);
        if(!object(info))throw new InputError(502,"站点分组选项结构不支持");
        groups.push({value,label:typeof info.desc==="string"?info.desc.slice(0,256):value,ratio:typeof info.ratio==="string"?info.ratio.slice(0,40):""});
      }
      groupsLoaded=true;
    });
    await optional(async()=>{
      const data=(await service.request("GET","/api/user/models")).data;
      if(!Array.isArray(data)||data.length>2000||data.some(model=>typeof model!=="string"||model.length>256))
        throw new InputError(502,"站点模型选项结构不支持");
      models.push(...new Set(data));modelsLoaded=true;
    });
    currency=await optional(()=>conversion(service));
    return {groups,models,groupsLoaded,modelsLoaded,currency:currencyView(ctx,currency),errors};
  });
});
export const tokenKey=tokenEndpoint(async ctx=>{
  const body=input(ctx.body),token=tokenId(body.tokenId);
  return withAccount(ctx,body.accountId,async service=>{
    const data=(await service.request("GET","/api/token/"+token)).data;
    if(!object(data)||data.id!==token)throw new InputError(502,"站点返回的令牌 ID 不匹配");
    let key=data.key;
    if(typeof key!=="string"||!key||/[*…]/.test(key))
      key=(await service.request("POST","/api/token/"+token+"/key","{}")).data?.key;
    if(typeof key!=="string"||!/^(?:sk-)?[a-zA-Z0-9_-]{8,256}$/.test(key))
      throw new InputError(502,"站点未提供完整密钥");
    return {key:key.startsWith("sk-")?key:"sk-"+key};
  });
});
function operationId(value) {
  if(typeof value!=="string"||!/^\d{13}:[0-9a-f-]{36}$/i.test(value))throw new InputError(400,"操作 ID 无效");
  return value;
}
function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(object(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
async function payload(service,body,current) {
  const changes=editableChanges(body.changes??{});
  if(!current&&!changes.name)throw new InputError(400,"请填写令牌名称");
  if(current&&body.revision!==current.revision)throw new InputError(409,"令牌配置已变化，请重新打开编辑器");
  if(current&&!Object.keys(changes).length&&body.quota===undefined)throw new InputError(400,"没有修改任何字段");
  const value={name:"",group:"",expired_time:"-1",remain_quota:"0",unlimited_quota:false,
    model_limits_enabled:false,model_limits:[],allow_ips:"",...current,...changes};
  if(value.model_limits_enabled&&!value.model_limits.length)throw new InputError(400,"启用模型限制时至少选择一个模型");
  if(Object.hasOwn(changes,"group")&&changes.group!==current?.group&&changes.group!==""){
    const groups=(await service.request("GET","/api/user/self/groups")).data;
    if(!object(groups)||!Object.hasOwn(groups,changes.group))throw new InputError(400,"所选分组不可用");
  }
  if(Object.hasOwn(changes,"model_limits")){
    const added=changes.model_limits.filter(m=>!current?.model_limits.includes(m));
    if(added.length){
      const models=(await service.request("GET","/api/user/models")).data;
      if(!Array.isArray(models)||added.some(m=>!models.includes(m)))throw new InputError(400,"所选模型不可用");
    }
  }
  if(body.quota!==undefined){
    const quota=input(body.quota);
    if(quota.mode==="quota")value.remain_quota=tokenInteger(quota.value);
    else if(quota.mode==="amount"){
      const currency=await conversion(service);
      if(!currency||quota.currencyRevision!==currencyRevision(service.ctx,currency))
        throw new InputError(409,"额度换算信息已变化，请刷新后重新填写");
      value.remain_quota=amountQuota(quota.value,currency);
    }else throw new InputError(400,"额度输入方式无效");
  }else if(!value.unlimited_quota&&(!current||current.unlimited_quota))
    throw new InputError(400,"请明确填写有限额度");
  if(current&&changes.group!==undefined&&changes.group!=="auto"){
    if(value.cross_group_retry!==undefined)value.cross_group_retry=false;
    if(value.auto_groups!==undefined)value.auto_groups=null;
  }
  // 编辑器打开后的消费不应被恢复为旧余额；写前再次读取，保留最新未编辑字段。
  if(current){
    const latest=await detail(service,current.id);
    if(latest.revision!==current.revision)throw new InputError(409,"令牌配置已变化，请重新打开编辑器");
    if(body.quota===undefined)value.remain_quota=latest.remain_quota;
  }
  return tokenWire(value);
}
function mutate(action) {
  return tokenEndpoint(async ctx=>{
    const body=input(ctx.body),op=operationId(body.operationId),token=action==="create"?null:tokenId(body.tokenId);
    return withAccount(ctx,body.accountId,async service=>{
      const key="token-operation:"+ctx.crypto.sha256(JSON.stringify([body.accountId,op]));
      const fingerprint=ctx.crypto.sha256(JSON.stringify(stable({action,token,binding:service.binding,
        changes:body.changes??null,quota:body.quota??null,revision:body.revision??null,status:body.status??null})));
      const store=ctx.state.shared,old=await store.get(key);
      if(old){
        if(old.fingerprint!==fingerprint)throw new InputError(409,"操作 ID 已用于其他请求");
        if(old.state==="Success")return old.result;
        if(old.state==="Rejected")throw new TokenError(old.status,old.error,"BUSINESS_REJECTED");
        throw new TokenError(409,"此写请求结果待核对，请刷新站点状态；不会重新发送","PENDING",true);
      }
      const age=Date.now()-Number(op.split(":")[0]);
      if(age< -60000||age>600000)throw new InputError(409,"操作 ID 已过期，请重新打开编辑器");
      let method,path,wire;
      if(action==="create"){
        method="POST";path="/api/token/";wire=await payload(service,body,null);
      }else{
        const current=await detail(service,token);
        if(body.revision!==current.revision)throw new InputError(409,"令牌配置已变化，请刷新后重试");
        if(action==="update"){method="PUT";path="/api/token/";wire=await payload(service,body,current);}
        else if(action==="status"){
          if(!["1","2"].includes(body.status))throw new InputError(400,"令牌状态无效");
          method="PUT";path="/api/token/?status_only=true";wire=tokenWire({id:token,status:body.status});
        }else{method="DELETE";path="/api/token/"+token;}
      }
      await service.open();await service.touch();
      const pending={state:"Pending",fingerprint};
      if(!await store.putIfAbsent(key,pending,{ttlSeconds:604800}))throw new InputError(409,"操作已提交，请刷新状态");
      try{
        await service.request(method,path,wire);
      }catch(error){
        if(cancelled(error))throw error;
        if(error instanceof TokenError&&["AUTH_EXPIRED","RATE_LIMITED","REDIRECT","UNSUPPORTED","CHALLENGE","BUSINESS_REJECTED"].includes(error.code)){
          await store.set(key,{state:"Rejected",fingerprint,status:error.status,error:error.message},{ttlSeconds:604800});
          throw error;
        }
        throw new TokenError(409,"写请求结果待核对，请刷新站点状态；不会自动重发","PENDING",true);
      }
      const result={success:true,message:({create:"令牌已创建，请在列表中查看密钥",update:"令牌已更新",status:"令牌状态已更新",delete:"令牌已删除"})[action]};
      try{await store.set(key,{state:"Success",fingerprint,result},{ttlSeconds:604800});}
      catch(error){if(cancelled(error))throw error;return {...result,warning:"上游已返回成功，本地操作记录未保存；请刷新核对"};}
      return result;
    });
  });
}
export const createToken=mutate("create");
export const updateToken=mutate("update");
export const setTokenStatus=mutate("status");
export const deleteToken=mutate("delete");
