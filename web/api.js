const NovaAPI=(()=>{
  const KEY="nova_access_token"; const REFRESH="nova_refresh_token";
  const get=k=>localStorage.getItem(k); const set=(k,v)=>v?localStorage.setItem(k,v):localStorage.removeItem(k);
  const json=value=>JSON.stringify(value);
  const isLoginPage=()=>/\/login\.html(?:$|[?#])/i.test(location.pathname);
  async function request(path,options={}){
    const headers={"Content-Type":"application/json",...(options.headers||{})}; const token=get(KEY);
    if(token) headers.Authorization="Bearer "+token;
    let response=await fetch(path,{...options,headers});
    if(response.status===401&&get(REFRESH)&&!options._retry){
      const refresh=await fetch("/api/auth/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:json({refreshToken:get(REFRESH)})});
      if(refresh.ok){const data=await refresh.json();if(data.token&&data.refreshToken){set(KEY,data.token);set(REFRESH,data.refreshToken);return request(path,{...options,_retry:true});}}
      set(KEY,null); set(REFRESH,null);
    }
    const body=await response.json().catch(()=>({}));
    if(!response.ok){
      if(response.status===401&&!isLoginPage()){location.href="./login.html";}
      throw new Error(body.error||body.message||("Request failed ("+response.status+")"));
    }
    return body;
  }
  const q=(params={})=>{const p=new URLSearchParams();Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=="")p.set(k,String(v));});const s=p.toString();return s?"?"+s:"";};
  return {
    request, hasSession:()=>Boolean(get(KEY)||get(REFRESH)),
    login:async(email,password)=>{const data=await request("/api/auth/login",{method:"POST",body:json({email,password})});if(!data.token||!data.refreshToken)throw new Error("Sign-in response is incomplete");set(KEY,data.token);set(REFRESH,data.refreshToken);return data;},
    me:()=>request("/api/auth/me"),
    logout:async()=>{const refresh=get(REFRESH);try{if(refresh)await request("/api/auth/logout",{method:"POST",body:json({refreshToken:refresh})});}finally{set(KEY,null);set(REFRESH,null);if(!isLoginPage())location.href="./login.html";}},
    dashboard:()=>request("/api/dashboard/summary"), usage:()=>request("/api/usage"),
    conversations:(params={})=>request("/api/conversations"+q(params)),
    messages:(id,params={})=>request("/api/conversations/"+id+"/messages"+q(params)),
    readConversation:id=>request("/api/conversations/"+id+"/read",{method:"POST"}),
    updateConversation:(id,data)=>request("/api/conversations/"+id,{method:"PATCH",body:json(data)}),
    handoff:(id,data={})=>request("/api/conversations/"+id+"/handoff",{method:"POST",body:json(data)}),
    pauseAI:(id,reason)=>request("/api/conversations/"+id+"/pause-ai",{method:"POST",body:json({reason})}),
    resumeAI:id=>request("/api/conversations/"+id+"/resume-ai",{method:"POST"}),
    copilotDrafts:(id,limit=10)=>request("/api/conversations/"+id+"/copilot/drafts"+q({limit})),
    copilotDraft:(id,prompt)=>request("/api/conversations/"+id+"/copilot/draft",{method:"POST",body:json({prompt})}),
    contacts:(params={})=>request("/api/contacts"+q(params)),
    memory:id=>request("/api/contacts/"+id+"/ai-memory"),
    saveMemory:(id,data)=>request("/api/contacts/"+id+"/ai-memory",{method:"POST",body:json(data)}),
    payments:(params={})=>request("/api/payments"+q(params)),
    appointments:(params={})=>request("/api/appointments"+q(params)),
    appointmentTypes:()=>request("/api/appointments/types"),
    updateAppointmentStatus:(id,status)=>request("/api/appointments/"+id+"/status",{method:"PATCH",body:json({status})}),
    automations:()=>request("/api/automations"),
    updateAutomationStatus:(id,status)=>request("/api/automations/"+id+"/status",{method:"PATCH",body:json({status})}),
    runAutomation:(id,data={})=>request("/api/automations/"+id+"/run",{method:"POST",body:json(data)})
  };
})();
