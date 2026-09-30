import { InputError, object, text, flag } from "./common.mjs";
import { tokenId, tokenInteger, tokenName, ipWhitelist, modelList } from "./token-values.mjs";

export const EDIT_FIELDS=["name","group","expired_time","unlimited_quota","model_limits_enabled","model_limits","allow_ips"];
export function tokenView(value) {
  if(!object(value))throw new InputError(502,"站点令牌结构不支持");
  const id=tokenId(value.id);
  if(typeof value.name!=="string"||!["1","2","3","4"].includes(value.status)||
    typeof value.group!=="string"||typeof value.model_limits!=="string"||
    typeof value.unlimited_quota!=="boolean"||typeof value.model_limits_enabled!=="boolean"||
    value.allow_ips!=null&&typeof value.allow_ips!=="string")
    throw new InputError(502,"站点令牌字段不完整，未尝试修改");
  const token={
    id,name:value.name,status:value.status,group:value.group,
    expired_time:tokenInteger(value.expired_time,"过期时间",true),
    remain_quota:tokenInteger(value.remain_quota,"剩余额度",true),
    used_quota:tokenInteger(value.used_quota??"0","已用额度",true),
    unlimited_quota:value.unlimited_quota,model_limits_enabled:value.model_limits_enabled,
    model_limits:value.model_limits?value.model_limits.split(","):[],allow_ips:value.allow_ips??""
  };
  if(value.cross_group_retry!==undefined){
    if(typeof value.cross_group_retry!=="boolean")throw new InputError(502,"跨分组设置无效");
    token.cross_group_retry=value.cross_group_retry;
  }
  if(value.auto_groups!==undefined){
    if(value.auto_groups!==null&&(!Array.isArray(value.auto_groups)||value.auto_groups.some(g=>typeof g!=="string")))
      throw new InputError(502,"自动分组设置无效");
    token.auto_groups=value.auto_groups;
  }
  return token;
}
export function editableChanges(value) {
  if(!object(value)||Object.keys(value).some(key=>!EDIT_FIELDS.includes(key)))
    throw new InputError(400,"包含不支持的令牌字段");
  const out={};
  for(const key of EDIT_FIELDS){
    if(!Object.hasOwn(value,key))continue;
    const v=value[key];
    if(key==="name")out[key]=tokenName(v);
    else if(key==="group")out[key]=text(v,"分组",128);
    else if(key==="expired_time"){
      out[key]=tokenInteger(v,"过期时间",true);
      if(v!=="-1"&&(Number(v)*1000<=Date.now()||Number(v)>253402271999))
        throw new InputError(400,"新的过期时间必须晚于当前时间");
    }else if(key==="unlimited_quota"||key==="model_limits_enabled")out[key]=flag(v,key,false);
    else if(key==="model_limits")out[key]=modelList(v);
    else if(key==="allow_ips")out[key]=ipWhitelist(v);
  }
  return out;
}
export function editableRevision(ctx,token) {
  return ctx.crypto.sha256(JSON.stringify([
    token.id,token.status,...EDIT_FIELDS.map(k=>token[k]),
    token.cross_group_retry??null,token.auto_groups??null
  ]));
}
export function tokenWire(token) {
  const fields={};
  for(const key of ["id","status","name","group","expired_time","remain_quota","unlimited_quota","model_limits_enabled","allow_ips","cross_group_retry","auto_groups"])
    if(token[key]!==undefined)fields[key]=token[key];
  if(token.model_limits!==undefined)fields.model_limits=modelList(token.model_limits).join(",");
  return "{"+Object.entries(fields).map(([key,value])=>JSON.stringify(key)+":"+
    (["id","status","expired_time","remain_quota"].includes(key)
      ? tokenInteger(value,key,key==="expired_time"||key==="remain_quota")
      : JSON.stringify(value))).join(",")+"}";
}
