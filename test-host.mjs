/** Node 离线模拟器；不运行 .NET/Jint/SQLite，不向真实站点发送请求。 */
import { createHash, randomUUID } from "node:crypto";
import { DEFAULTS } from "./src/common.mjs";
import { DEFAULT_CRON } from "./src/cron.mjs";
const clone = value => structuredClone(value);
export const cancellation = () => Object.assign(new Error("cancelled"), { code: "host.cancelled" });
export function fixture() {
  const db = new Map(), state = new Map(), origins = new Set(), calls = [], logs = [], jobs = new Map(), progress = [], waits = [];
  let nextId = 0;
  const f = { db, state, origins, calls, logs, jobs, progress, waits, clients: [], available: true, aborted: false,
    handler: async () => response({ success: true, message: "签到成功" }), casHook: null, failLog: false, stateFail: false };
  const check = () => { if (f.aborted) throw cancellation(); };
  const metadata = (row, secrets = false) => ({
    id: row.id, label: row.label, platform: row.platform, credentialKind: "Custom",
    credentialVersion: String(row.version), credential: secrets ? clone(row.credential) : null, status: clone(row.status)
  });
  f.seed = (siteType = "NewAPI", overrides = {}, accountId = `account-${++nextId}`) => {
    const config = {
      siteType, baseUrl: DEFAULTS[siteType] || "https://new.example", enabled: true, autoCheckIn: true,
      cron: DEFAULT_CRON, queryBalance: false, // 原有签到单元测试关闭可选 GET；余额套件显式开启。
      route: "direct", userAgent: "", cookie: siteType === "AgentRouter" ? "" : "session=COOKIE_SECRET",
      userId: siteType === "AgentRouter" ? "" : "90071992547409931234",
      username: siteType === "AgentRouter" ? "ethan@example.test" : "", password: siteType === "AgentRouter" ? "PASSWORD_SECRET" : "",
      ...overrides
    };
    const row = { id: accountId, label: "测试 " + accountId, platform: "js-checkin", status: { state: "Active", cooldownUntil: null },
      version: 1, credential: { kind: "Custom", fields: { config: JSON.stringify(config) } } };
    db.set(accountId, row); origins.add(new URL(config.baseUrl).origin); return row;
  };
  const live = key => {
    if (f.stateFail) throw new Error("Redis unavailable");
    check();
    const item = state.get(key);
    if (item && item.expires <= Date.now()) { state.delete(key); return undefined; }
    return item;
  };
  f.ctx = (body, overrides = {}) => {
    const ctx = {
      pluginKey: "js-checkin", platform: "js-checkin", phase: "Control", body, query: {},
      json: (statusCode, body) => ({ statusCode, body }), reply: { error: (statusCode, message) => ({ statusCode, message }) },
      crypto: { sha256: value => createHash("sha256").update(value).digest("hex"), randomUUID },
      decimal: decimalMock,
      url: { parse: value => { const u = new URL(value); return { href:u.href, origin:u.origin, scheme:u.protocol.slice(0,-1), host:u.hostname, path:u.pathname, query:u.search, fragment:u.hash, port:443 }; } },
      accounts: {
        get: async id => { check(); const row=db.get(id);return row?.platform==="js-checkin"?metadata(row):null; },
        list: async options => { check();return [...db.values()].filter(r=>r.platform==="js-checkin").map(r=>metadata(r,!!options?.includeCredentials)); },
        readCredentials: async id => {check();const row=db.get(id);if(!row||row.platform!=="js-checkin")throw Error("foreign account");return{accountId:id,version:String(row.version),credential:clone(row.credential)};},
        save: async input => {
          check();if(input.id){const row=db.get(input.id);if(!row||row.platform!=="js-checkin")throw Error("foreign");if(input.label!==undefined)row.label=input.label;return metadata(row)}
          const id=`account-${++nextId}`,row={id,platform:"js-checkin",label:input.label,version:1,status:{state:"Active"},credential:clone(input.credential)};
          db.set(id,row);return metadata(row);
        },
        compareExchangeCredential: async (id,version,credential) => {
          check();if(f.casHook)await f.casHook(id,version,credential);check();
          const row=db.get(id);if(!row||row.platform!=="js-checkin"||String(row.version)!==version)return null;
          row.credential=clone(credential);row.version++;return metadata(row);
        },
        delete: async id => {check();db.delete(id)}
      },
      state: { shared: {
        available: async () => {check();return f.available},
        get: async key => clone(live(key)?.value ?? null),
        putIfAbsent: async (key,value,options) => {if(live(key))return false;state.set(key,{value:clone(value),expires:Date.now()+options.ttlSeconds*1000});return true;},
        set: async (key,value,options) => {live(key);state.set(key,{value:clone(value),expires:Date.now()+options.ttlSeconds*1000});},
        compareExchange: async (key,expected,value,options={ttlSeconds:300}) => {
          const current=live(key)?.value;if(JSON.stringify(current)!==JSON.stringify(expected))return false;
          if(value===undefined)state.delete(key);else state.set(key,{value:clone(value),expires:Date.now()+options.ttlSeconds*1000});return true;
        }
      } },
      http: {
        createClient: async options => {
          check();const handle=randomUUID(),info={handle,options:clone(options),closed:false};f.clients.push(info);
          return{handle,request:async spec=>{
            check();if(info.closed)throw Error("closed client");
            if(spec.route!==undefined||spec.retry!==undefined)throw Error("fixed client cannot override route/retry");
            return ctx.http.request({...spec,route:options.route,client:handle});
          },close:async()=>{check();info.closed=true}};
        },
        approvedOrigins: async () => {check();return [...origins]},
        approveOrigin: async origin => {check();if(ctx.phase!=="Control")throw Error("admin only");origins.add(origin)},
        request: async spec => {check();if(!origins.has(new URL(spec.url).origin))throw Object.assign(Error("denied"),{code:"host.denied"});calls.push(clone(spec));return f.handler(spec,ctx)}
      },
      tasks: { writeLog: async value => {check();if(f.failLog)throw Error("log unavailable");logs.push(clone(value))} },
      jobs: {
        start: async (name,input,options) => {check();const old=[...jobs.values()].find(j=>j.key===options.key&&["Queued","Running"].includes(j.state));if(old)return clone(old);const j={id:randomUUID(),name,input:clone(input),key:options.key,state:"Queued"};jobs.set(j.id,j);return clone(j)},
        get: async id => {check();return clone(jobs.get(id)??null)},
        list: async () => {check();return [...jobs.values()].map(clone)},
        cancel: async id => {check();const j=jobs.get(id);if(!j)return false;j.cancelRequested=true;return true},
        progress: async value => {check();progress.push(clone(value))}
      },
      delay: async ms => {check();waits.push(ms);if(f.onDelay)await f.onDelay(ms);check()},
      ...overrides
    };
    return ctx;
  };
  return f;
}
export function response(json, statusCode = 200) {
  return { statusCode, headers: {}, bodyText: typeof json === "string" ? json : JSON.stringify(json) };
}
// 测试专用定点整数实现，不用 JS Number 模拟金额；不声称等同于 .NET decimal 舍入。
const SCALE=10n**28n;
const fixed=value=>{if(!/^-?\d+(?:\.\d{1,28})?$/.test(value))throw Error("decimal");const neg=value.startsWith("-"),[a,b=""]=value.replace(/^-/,"").split(".");return(neg?-1n:1n)*(BigInt(a)*SCALE+BigInt(b.padEnd(28,"0")))};
const formatted=value=>{const neg=value<0n;if(neg)value=-value;const fraction=(value%SCALE).toString().padStart(28,"0").replace(/0+$/,"");return(neg?"-":"")+(value/SCALE).toString()+(fraction?"."+fraction:"")};
const decimalMock={
  divide:(a,b)=>formatted(fixed(a)*SCALE/fixed(b)),
  multiply:(a,b)=>formatted(fixed(a)*fixed(b)/SCALE),
  compare:(a,b)=>fixed(a)<fixed(b)?-1:fixed(a)>fixed(b)?1:0
};
