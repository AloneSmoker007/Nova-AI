document.addEventListener("DOMContentLoaded",()=>{const messages=document.querySelector("#assistant-messages"),form=document.querySelector("#assistant-form"),input=document.querySelector("#assistant-input"),status=document.querySelector("#nova-status"),activity=document.querySelector("#activity-list"),overlay=document.querySelector("#command-overlay"),commandInput=document.querySelector("#command-input"),results=[...document.querySelectorAll("#command-results button")];const addMessage=(kind,text)=>{const el=document.createElement("div");el.className=kind==="user"?"user-message":"nova-message";el.innerHTML='<span class="message-label">'+(kind==="user"?"You":"Nova")+'</span><p></p><time>Now</time>';el.querySelector("p").textContent=text;messages.appendChild(el);messages.scrollTop=messages.scrollHeight;};const setStatus=v=>status.textContent=v;const addActivity=t=>{if(activity.querySelector(".empty"))activity.innerHTML="";const el=document.createElement("div");el.className="activity-item";el.innerHTML='<span>✦</span><div><strong></strong><small>Just now · Read-only context</small></div>';el.querySelector("strong").textContent=t;activity.prepend(el);};
async function answer(question){
  setStatus("Thinking · Gemini workspace assistant");
  try{
    const result=await NovaAPI.assistantAsk(question);
    const reply=result.data?.answer;
    if(typeof reply!=="string"||!reply.trim())throw new Error("Nova returned no usable answer.");
    addMessage("nova",reply);
    addActivity(question);
    setStatus("Ready · Gemini workspace assistant");
  }catch(error){
    addMessage("nova","I couldn't get an AI answer: "+(error.message||"request failed"));
    setStatus("Ready · Ask Nova again");
  }
}
form.addEventListener("submit",e=>{e.preventDefault();const p=input.value.trim();if(!p)return;addMessage("user",p);input.value="";answer(p);});document.querySelectorAll(".suggestion").forEach(b=>b.addEventListener("click",()=>{input.value=b.dataset.prompt;input.focus();}));const open=()=>{overlay.hidden=false;commandInput.value="";commandInput.focus();};const close=()=>{overlay.hidden=true;};document.querySelector("#command-button")?.addEventListener("click",open);document.querySelectorAll("[data-close-command]").forEach(x=>x.addEventListener("click",close));document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();open();}if(e.key==="Escape"&&!overlay.hidden)close();});commandInput.addEventListener("input",()=>{const q=commandInput.value.toLowerCase();results.forEach(r=>{r.hidden=!!q&&!r.dataset.command.toLowerCase().includes(q);});});results.forEach(r=>r.addEventListener("click",()=>{window.location.href=r.dataset.target;}));});