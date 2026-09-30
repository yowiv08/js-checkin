import { InputError, text } from "./common.mjs";

const strip = s => s.replace(/^0+(?=\d)/,"");
function cmp(a,b) { a=strip(a);b=strip(b);return a.length!==b.length ? a.length-b.length : a===b ? 0 : a>b ? 1 : -1; }
function subtract(a,b) {
  const digits=a.split("");let borrow=0;
  for(let i=a.length-1,j=b.length-1;i>=0;i--,j--){
    let n=Number(a[i])-Number(b[j]||0)-borrow;borrow=n<0?1:0;digits[i]=String(n+borrow*10);
  }
  return strip(digits.join(""));
}
function multiply(a,b) {
  const out=Array(a.length+b.length).fill(0);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)out[i+j+1]+=Number(a[i])*Number(b[j]);
  for(let i=out.length-1;i>0;i--){out[i-1]+=Math.floor(out[i]/10);out[i]%=10;}
  return strip(out.join(""));
}
function divide(a,b,places) {
  if(b==="0")throw new InputError(400,"额度换算比例不能为零");
  let remainder="0",out="";
  for(const digit of a+"0".repeat(places)){
    remainder=strip(remainder+digit);let q=0;
    while(cmp(remainder,b)>=0){remainder=subtract(remainder,b);q++;}
    out+=q;
  }
  if(remainder!=="0")return null;
  out=strip(out).padStart(places+1,"0");
  return places ? (out.slice(0,-places)+"."+out.slice(-places)).replace(/\.?0+$/,"") : strip(out);
}
function parts(value) {
  if(typeof value!=="string"||!/^(?:0|[1-9]\d{0,39})(?:\.\d{1,40})?$/.test(value))
    throw new InputError(400,"金额或换算比例格式无效");
  const [whole,fraction=""]=value.split(".");
  return {digits:strip(whole+fraction),scale:fraction.length};
}
/** Exact x * numerator / denominator; null means no finite representation within places. */
function ratio(x,numerator,denominator,places) {
  const a=parts(x),b=parts(numerator),c=parts(denominator);
  return divide(multiply(a.digits,b.digits)+"0".repeat(c.scale),
    c.digits+"0".repeat(a.scale+b.scale),places);
}
export function tokenInteger(value,name="额度",negative=false) {
  if(typeof value!=="string"||!(negative?/^-?(?:0|[1-9]\d{0,18})$/:/^(?:0|[1-9]\d{0,18})$/).test(value)||
    cmp(value.replace(/^-/,""),"9223372036854775807")>0)
    throw new InputError(400,`${name} 必须是有效的 64 位整数字符串`);
  return value;
}
export function tokenId(value) {
  tokenInteger(value,"令牌 ID");
  if(value==="0")throw new InputError(400,"令牌 ID 必须大于零");
  return value;
}
export function currencyFor(config,meta) {
  if(config.siteType==="AnyRouter"&&config.baseUrl==="https://anyrouter.top")
    return {unit:"USD",quotaPerUnit:"500000",rate:"1"};
  if(!meta||meta.display_in_currency===false)return null;
  const kind=meta.quota_display_type??(meta.display_in_currency===true?"USD":"TOKENS");
  let unit=kind,rate="1";
  if(kind==="CNY")rate=meta.usd_exchange_rate;
  else if(kind==="CUSTOM"){unit=meta.custom_currency_symbol;rate=meta.custom_currency_exchange_rate;}
  else if(kind!=="USD")return null;
  try{
    if(typeof unit!=="string"||!unit||unit.length>16||/[\u0000-\u001f\u007f]/.test(unit))return null;
    if(parts(rate).digits==="0"||parts(meta.quota_per_unit).digits==="0")return null;
    return {unit,quotaPerUnit:meta.quota_per_unit,rate};
  }catch{return null;}
}
export function quotaAmount(quota,currency) {
  tokenInteger(quota,"额度",true);
  if(!currency)return null;
  const negative=quota.startsWith("-");
  const result=ratio(quota.replace(/^-/,""),currency.rate,currency.quotaPerUnit,28);
  return result===null ? null : (negative&&result!=="0"?"-":"")+result;
}
export function amountQuota(amount,currency) {
  if(!currency)throw new InputError(400,"站点换算信息不可用，请使用 quota");
  const value=ratio(amount,currency.quotaPerUnit,currency.rate,0);
  if(value===null)throw new InputError(400,"金额不能精确换算为整数 quota，请调整金额或使用 quota");
  return tokenInteger(value);
}
export function tokenName(value) {
  const name=text(value,"令牌名称",100,true).trim();let bytes=0;
  for(const char of name){
    const n=char.codePointAt(0);
    if(n>=0xd800&&n<=0xdfff)throw new InputError(400,"令牌名称包含无效字符");
    bytes+=n<=0x7f?1:n<=0x7ff?2:n<=0xffff?3:4;
  }
  if(bytes>50)throw new InputError(400,"令牌名称不能超过 50 字节");
  return name;
}
function ipv4(value) {
  const groups=value.split(".");
  return groups.length===4&&groups.every(s=>/^(?:0|[1-9]\d{0,2})$/.test(s)&&Number(s)<=255);
}
function ipv6(value) {
  if(!/^[0-9a-fA-F:.]+$/.test(value)||value.includes(":::"))return false;
  let s=value;
  if(s.includes(".")){
    const at=s.lastIndexOf(":");if(at<0||!ipv4(s.slice(at+1)))return false;
    s=s.slice(0,at+1)+"0:0";
  }
  const halves=s.split("::");if(halves.length>2)return false;
  const groups=halves.flatMap(part=>part?part.split(":"):[]);
  if(!groups.every(g=>/^[0-9a-fA-F]{1,4}$/.test(g)))return false;
  return halves.length===2 ? groups.length<8 : groups.length===8;
}
export function ipWhitelist(value) {
  if(typeof value!=="string"||value.length>16384||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw new InputError(400,"IP 白名单格式无效");
  const lines=value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length>256)throw new InputError(400,"IP 白名单最多 256 项");
  for(const line of lines){
    const [address,prefix,...extra]=line.split("/"),v4=ipv4(address),v6=ipv6(address);
    if(extra.length||!v4&&!v6||prefix!==undefined&&(!/^(?:0|[1-9]\d{0,2})$/.test(prefix)||Number(prefix)>(v4?32:128)))
      throw new InputError(400,"IP 白名单包含无效 IP 或 CIDR");
  }
  return [...new Set(lines)].join("\n");
}
export function modelList(value) {
  if(!Array.isArray(value)||value.length>2000)throw new InputError(400,"模型列表格式无效");
  const models=[...new Set(value.map(v=>text(v,"模型名称",256,true)))];
  if(models.some(v=>v.includes(","))||models.join(",").length>32768)throw new InputError(400,"模型列表格式无效");
  return models;
}
export function expiryInput(value) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw new InputError(400,"过期时间格式无效");
  const ms=Date.parse(value+"+08:00");
  if(!Number.isFinite(ms)||new Date(ms+8*3600000).toISOString().slice(0,value.length)!==value)
    throw new InputError(400,"过期时间格式无效");
  return String(ms/1000);
}
export function expiryDisplay(seconds) {
  if(seconds==="-1")return "";
  const ms=Number(seconds)*1000+8*3600000;
  return Number.isFinite(ms)&&Math.abs(ms)<8640000000000000 ? new Date(ms).toISOString().slice(0,19) : "";
}
