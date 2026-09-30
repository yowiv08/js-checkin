import { amountQuota, quotaAmount, tokenInteger, tokenName, ipWhitelist, expiryInput, expiryDisplay } from "../src/token-values.mjs";

export function mount({api,notify,ask}) {
  const $=s=>document.querySelector(s),form=$("#tokenForm"),editor=$("#tokenEditor"),field=name=>form.elements.namedItem(name);
  let accounts=[],selected="",view=false,epoch=0,loading=false,acting=false,page=1,data=null,editing=null,options=null;
  let selectedModels=new Set(),quotaMode="quota",originalQuota="",quotaDirty=false,editorEpoch=0,submitted=null;
  const keys=new Map(),operations=new Map();
  const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const query=(route,extra={})=>route+"?"+new URLSearchParams({accountId:selected,...extra}).toString();
  const active=()=>accounts.find(a=>a.id===selected)?.available;
  const errorText=error=>String(error?.message||"操作失败");
  const operation=()=>Date.now()+":"+crypto.randomUUID();
  function buttons(){
    const busy=loading||acting;
    $("#tokenRefresh").disabled=busy||!active();
    $("#tokenAdd").disabled=busy||!active();
    $("#tokenPrev").disabled=busy||!active()||page<=1;
    $("#tokenNext").disabled=busy||!active()||!data?.hasNext;
    $("#tokenList").querySelectorAll("button").forEach(b=>b.disabled=busy||!active());
  }
  function clearKeys(){
    keys.clear();
    $("#tokenList").querySelectorAll(".token-key").forEach(el=>el.value="••••••••••••");
    $("#tokenList").querySelectorAll('[data-token-action="show"]').forEach(el=>el.textContent="显示");
  }
  function invalidate(){
    epoch++;editorEpoch++;clearKeys();loading=false;acting=false;data=null;
    editor.close();form.reset();editing=null;options=null;submitted=null;selectedModels.clear();
    $("#tokenModels").replaceChildren();$("#tokenList").replaceChildren();
    $("#tokenPageLabel").textContent="";$("#tokenPageError").textContent="";
  }
  function setAccounts(rows){
    const old=accounts.find(a=>a.id===selected);
    accounts=rows.filter(a=>!a.invalid).map(a=>({id:a.id,label:a.label,siteType:a.siteType,baseUrl:a.baseUrl,available:a.available,version:a.version}));
    const next=accounts.find(a=>a.id===selected);
    const changed=!next||old?.version!==next.version||old?.available!==next.available;
    if(changed)invalidate();
    if(!next)selected=accounts[0]?.id||"";
    const select=$("#tokenAccount");select.replaceChildren();
    if(!accounts.length)select.append(new Option("请先添加签到账号",""));
    for(const account of accounts)select.append(new Option(`${account.label} · ${account.siteType}${account.available?"":" · 已停用"}`,account.id));
    select.value=selected;buttons();
    if(view&&changed)load(1);
  }
  function showTokens(accountId=selected){
    invalidate();selected=accounts.some(a=>a.id===accountId)?accountId:accounts[0]?.id||"";
    $("#tokenAccount").value=selected;view=true;
    $("#accountsPage").hidden=true;$("#tokensPage").hidden=false;
    $("#accountsTab").classList.remove("active");$("#accountsTab").setAttribute("aria-pressed","false");
    $("#tokensTab").classList.add("active");$("#tokensTab").setAttribute("aria-pressed","true");
    load(1);
  }
  $("#tokensTab").onclick=()=>showTokens();
  $("#accountsTab").onclick=()=>{
    invalidate();view=false;$("#accountsPage").hidden=false;$("#tokensPage").hidden=true;
    $("#accountsTab").classList.add("active");$("#accountsTab").setAttribute("aria-pressed","true");
    $("#tokensTab").classList.remove("active");$("#tokensTab").setAttribute("aria-pressed","false");
  };
  $("#tokenAccount").onchange=()=>showTokens($("#tokenAccount").value);
  function render(){
    clearKeys();const root=$("#tokenList");root.replaceChildren();
    if(!data?.items?.length){root.append(node("div","empty",active()?"暂无令牌":"请选择已启用的账号"));buttons();return;}
    const wrap=node("div","token-table-wrap"),table=node("table","token-table"),head=node("thead"),headRow=node("tr"),body=node("tbody");
    for(const label of ["名称 / 密钥","状态","分组","剩余 / 已用额度","过期时间 · UTC+8","操作"])headRow.append(node("th","",label));
    head.append(headRow);table.append(head,body);wrap.append(table);root.append(wrap);
    for(const item of data.items){
      const row=node("tr");row.dataset.tokenId=item.id;
      const name=node("td"),key=node("input","token-key");key.readOnly=true;key.autocomplete="off";key.spellcheck=false;key.value="••••••••••••";key.setAttribute("aria-label","令牌密钥");
      name.append(node("strong","",item.name),key);
      const state=node("td");state.append(node("span","token-status"+(item.status==="1"?"":" disabled"),({"1":"已启用","2":"已禁用","3":"已过期","4":"已耗尽"})[item.status]||"未知"));
      const quota=node("td"),remaining=item.unlimited_quota?"无限额度":item.amount!==null&&item.amount!==undefined?item.amount+" "+(data.currency?.unit||""):item.remain_quota+" quota";
      quota.append(node("div","",remaining),node("small","token-quota-note","已用 "+(item.usedAmount??item.used_quota)+(item.usedAmount!=null?" "+data.currency.unit:" quota")));
      const actions=node("td"),group=node("div","actions");
      for(const [action,label]of [["show","显示"],["copy","复制"],["edit","编辑"],["status",item.status==="1"?"禁用":"启用"],["delete","删除"]]){
        const button=node("button",action==="delete"?"danger":"",label);button.type="button";button.dataset.tokenAction=action;
        button.onclick=()=>act(action,item,row);group.append(button);
      }
      actions.append(group);row.append(name,state,node("td","",item.group||"账号分组"),quota,node("td","",item.expired_time==="-1"?"永不过期":expiryDisplay(item.expired_time).replace("T"," ")),actions);body.append(row);
    }
    buttons();
  }
  async function load(nextPage=page){
    if(!selected||!active()){data=null;page=1;render();return;}
    const ticket=++epoch;clearKeys();loading=true;$("#tokenPageError").textContent="";buttons();
    try{
      const result=await api("GET",query("tokens/list",{page:String(nextPage)}));
      if(ticket!==epoch)return;
      data=result;page=result.page;render();
      $("#tokenPageLabel").textContent=`第 ${page} 页${result.total===null?"":" · 共 "+result.total+" 条"}`;
    }catch(error){
      if(ticket!==epoch)return;
      $("#tokenPageError").textContent=errorText(error);data=null;
      $("#tokenList").replaceChildren(node("div","empty","令牌读取失败"));$("#tokenPageLabel").textContent="";
    }finally{if(ticket===epoch){loading=false;buttons();}}
  }
  $("#tokenRefresh").onclick=()=>load(page);
  $("#tokenPrev").onclick=()=>load(page-1);$("#tokenNext").onclick=()=>load(page+1);
  async function act(action,item,row){
    if(loading||acting)return;
    if(action==="edit"){await openEditor(item.id);return;}
    if(action==="show"&&keys.has(item.id)){
      keys.delete(item.id);row.querySelector(".token-key").value="••••••••••••";
      row.querySelector('[data-token-action="show"]').textContent="显示";return;
    }
    const ticket=epoch,accountId=selected;
    if(action==="delete"&&!await ask(`删除令牌“${item.name}”？此操作无法撤销。`))return;
    if(ticket!==epoch||acting||loading)return;
    acting=true;buttons();$("#tokenPageError").textContent="";
    try{
      if(action==="show"||action==="copy"){
        const key=keys.get(item.id)??(await api("POST","tokens/key",{accountId,tokenId:item.id})).key;
        if(ticket!==epoch)return;
        if(action==="show"){
          keys.set(item.id,key);row.querySelector(".token-key").value=key;
          row.querySelector('[data-token-action="show"]').textContent="隐藏";
        }else{
          try{
            if(!navigator.clipboard?.writeText)throw Error("clipboard unavailable");
            await navigator.clipboard.writeText(key);
            if(ticket===epoch)notify("密钥已复制");
          }catch{
            if(ticket!==epoch)return;
            keys.set(item.id,key);const input=row.querySelector(".token-key");input.value=key;input.focus();input.select();
            row.querySelector('[data-token-action="show"]').textContent="隐藏";notify("按 Ctrl+C 复制密钥");
          }
        }
      }else{
        const cacheKey=JSON.stringify([accountId,action,item.id,item.revision]);
        if(!operations.has(cacheKey))operations.set(cacheKey,operation());
        const result=await api("POST","tokens/"+action,{
          accountId,tokenId:item.id,revision:item.revision,operationId:operations.get(cacheKey),
          ...(action==="status"?{status:item.status==="1"?"2":"1"}:{})
        });
        if(ticket!==epoch)return;
        notify(result.warning||result.message);acting=false;
        await load(action==="delete"?1:page);
      }
    }catch(error){if(ticket===epoch)$("#tokenPageError").textContent=errorText(error);}
    finally{if(ticket===epoch){acting=false;buttons();}}
  }
  const defaults=()=>({name:"",group:"",expired_time:"-1",unlimited_quota:false,model_limits_enabled:false,model_limits:[],allow_ips:""});
  function renderModels(){
    const filter=$("#tokenModelSearch").value.toLowerCase(),root=$("#tokenModels");root.replaceChildren();
    const all=[...new Set([...(options?.models||[]),...selectedModels])];
    for(const model of all.filter(m=>m.toLowerCase().includes(filter))){
      const label=node("label"),box=node("input");box.type="checkbox";box.checked=selectedModels.has(model);
      box.disabled=!field("model_limits_enabled").checked||!options?.modelsLoaded;
      box.onchange=()=>{box.checked?selectedModels.add(model):selectedModels.delete(model);};
      label.append(box,document.createTextNode(model));root.append(label);
    }
    if(!all.length)root.append(node("span","token-quota-note",options?.modelsLoaded?"站点没有可用模型":"模型选项未加载"));
  }
  function quotaNote(){
    const currency=options?.currency;
    field("quotaValue").disabled=field("unlimited_quota").checked;
    field("quotaMode").disabled=field("unlimited_quota").checked;
    $("#tokenQuotaLabel").textContent=quotaMode==="amount"?"剩余额度 · "+currency.unit:"剩余额度 · quota";
    try{
      const value=field("quotaValue").value;
      if(!value){$("#tokenQuotaNote").textContent="";return;}
      const quota=quotaMode==="amount"?amountQuota(value,currency):tokenInteger(value,"额度",true);
      const amount=currency?quotaAmount(quota,currency):null;
      $("#tokenQuotaNote").textContent=quotaMode==="amount"?quota+" quota":amount!==null?amount+" "+currency.unit:"";
    }catch(error){$("#tokenQuotaNote").textContent=errorText(error);}
  }
  function syncControls(){
    field("expires").disabled=field("neverExpires").checked;
    renderModels();quotaNote();
  }
  async function openEditor(tokenId=null){
    if(loading||acting||!active())return;
    const ticket=epoch,editTicket=++editorEpoch;
    loading=true;buttons();editing=null;options=null;submitted=null;quotaDirty=false;selectedModels.clear();
    form.reset();$("#tokenFields").disabled=true;$("#tokenSave").disabled=true;
    $("#tokenFormError").textContent="";$("#tokenOptionWarning").textContent="正在加载…";$("#tokenModels").replaceChildren();
    $("#tokenEditorTitle").textContent=tokenId?"编辑令牌":"新建令牌";editor.showModal();
    try{
      const token=tokenId?(await api("GET",query("tokens/detail",{tokenId}))).token:null;
      if(ticket!==epoch||editTicket!==editorEpoch)return;
      const settings=await api("GET",query("tokens/options"));
      if(ticket!==epoch||editTicket!==editorEpoch)return;
      editing=token;options=settings;
      const value=token||defaults();
      for(const name of ["name","allow_ips"])field(name).value=value[name];
      for(const name of ["unlimited_quota","model_limits_enabled"])field(name).checked=value[name];
      const groups=field("group");groups.replaceChildren(new Option("使用账号分组",""));
      for(const group of settings.groups)if(group.value)groups.append(new Option(group.label||group.value,group.value));
      if(value.group&&![...groups.options].some(o=>o.value===value.group))groups.append(new Option(value.group+"（已有设置）",value.group));
      groups.value=value.group;groups.disabled=!settings.groupsLoaded;
      field("model_limits_enabled").disabled=!settings.modelsLoaded;
      selectedModels=new Set(value.model_limits);
      field("neverExpires").checked=value.expired_time==="-1";field("expires").value=expiryDisplay(value.expired_time);
      originalQuota=token?.remain_quota??"";
      const amount=originalQuota!==""&&settings.currency?quotaAmount(originalQuota,settings.currency):null;
      quotaMode=settings.currency&&(!token||amount!==null)?"amount":"quota";
      field("quotaMode").querySelector('[value="amount"]').disabled=!settings.currency;
      field("quotaMode").value=quotaMode;
      field("quotaValue").value=quotaMode==="amount"?amount??"":originalQuota;
      $("#tokenModelSearch").value="";
      $("#tokenFields").disabled=false;$("#tokenSave").disabled=false;
      $("#tokenOptionWarning").textContent=(settings.errors||[]).join("\n");syncControls();field("name").focus();
    }catch(error){
      if(ticket===epoch&&editTicket===editorEpoch)$("#tokenFormError").textContent=errorText(error);
    }finally{if(ticket===epoch&&editTicket===editorEpoch){loading=false;buttons();}}
  }
  $("#tokenAdd").onclick=()=>openEditor();
  function closeEditor(){
    if(acting)return;
    editorEpoch++;loading=false;editor.close();form.reset();editing=null;options=null;submitted=null;selectedModels.clear();
    $("#tokenModels").replaceChildren();buttons();
  }
  $("#tokenClose").onclick=closeEditor;$("#tokenCancel").onclick=closeEditor;
  editor.addEventListener("cancel",event=>{event.preventDefault();closeEditor();});
  $("#tokenModelSearch").oninput=renderModels;
  for(const name of ["neverExpires","model_limits_enabled","unlimited_quota"])field(name).onchange=syncControls;
  field("quotaValue").oninput=()=>{quotaDirty=true;quotaNote();};
  field("quotaMode").onchange=()=>{
    const next=field("quotaMode").value;
    try{
      let value=field("quotaValue").value;
      if(value){
        const quota=quotaMode==="amount"?amountQuota(value,options.currency):tokenInteger(value,"额度",true);
        value=next==="quota"?quota:quotaAmount(quota,options.currency);
        if(value===null)throw Error("该 quota 无法精确表示为金额，请继续使用 quota");
      }
      quotaMode=next;field("quotaValue").value=value;quotaNote();
    }catch(error){field("quotaMode").value=quotaMode;$("#tokenFormError").textContent=errorText(error);}
  };
  form.addEventListener("submit",async event=>{
    event.preventDefault();if(loading||acting||!options)return;
    $("#tokenFormError").textContent="";
    const ticket=epoch,editTicket=editorEpoch;
    try{
      const expiry=field("neverExpires").checked?"-1":expiryInput(field("expires").value);
      if(expiry!==editing?.expired_time&&expiry!=="-1"&&Number(expiry)*1000<=Date.now())throw Error("新的过期时间必须晚于当前时间");
      const value={
        name:tokenName(field("name").value),group:field("group").value,expired_time:expiry,
        unlimited_quota:field("unlimited_quota").checked,model_limits_enabled:field("model_limits_enabled").checked,
        model_limits:[...selectedModels],allow_ips:editing?.allow_ips===field("allow_ips").value?editing.allow_ips:ipWhitelist(field("allow_ips").value)
      };
      if(value.model_limits_enabled&&!value.model_limits.length)throw Error("启用模型限制时至少选择一个模型");
      const changes=Object.fromEntries(Object.entries(value).filter(([k,v])=>!editing||JSON.stringify(v)!==JSON.stringify(editing[k])));
      let quota;
      if(!value.unlimited_quota&&(!editing||editing.unlimited_quota||quotaDirty)){
        const raw=field("quotaValue").value;
        const exact=quotaMode==="amount"?amountQuota(raw,options.currency):tokenInteger(raw);
        if(!editing||editing.unlimited_quota||exact!==originalQuota)
          quota={mode:quotaMode,value:raw,...(quotaMode==="amount"?{currencyRevision:options.currency.revision}:{})};
      }
      if(editing&&!Object.keys(changes).length&&!quota){notify("没有修改任何字段");return;}
      const body={accountId:selected,changes,...(quota?{quota}:{}),...(editing?{tokenId:editing.id,revision:editing.revision}:{})};
      const fingerprint=JSON.stringify(body);
      if(!submitted||submitted.fingerprint!==fingerprint)submitted={fingerprint,operationId:operation()};
      acting=true;buttons();$("#tokenSave").disabled=true;$("#tokenFields").disabled=true;
      const result=await api("POST",editing?"tokens/update":"tokens/create",{...body,operationId:submitted.operationId});
      if(ticket!==epoch||editTicket!==editorEpoch)return;
      acting=false;closeEditor();notify(result.warning||result.message);await load(1);
    }catch(error){
      if(ticket===epoch&&editTicket===editorEpoch)$("#tokenFormError").textContent=errorText(error);
    }finally{
      if(ticket===epoch&&editTicket===editorEpoch){acting=false;$("#tokenSave").disabled=false;$("#tokenFields").disabled=false;buttons();}
    }
  });
  window.addEventListener("pagehide",()=>{invalidate();operations.clear();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden){clearKeys();}});
  buttons();
  return {setAccounts,open:showTokens};
}
