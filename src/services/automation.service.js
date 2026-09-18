import { dbPool, isDatabaseConfigured } from "../config/database.js";

const MAX_STEPS = 50;
const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;
const MAX_WEBHOOK_BODY = 16_384;
const MAX_RETRIES = 5;

function assertDb() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}
function uuid(v) { return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v.trim()); }
function tenant(v) { if (!uuid(v)) throw new Error("Invalid tenant ID"); return v.trim(); }
function text(v, max) { if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("Invalid text value"); return v.trim(); }

export function normalizeWorkflowDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("Invalid workflow definition");
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (steps.length > MAX_STEPS) throw new Error("Workflow has too many steps");
  return {
    version: 1,
    steps: steps.map((step, i) => normalizeStep(step, i)),
  };
}
function normalizeStep(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error("Invalid workflow step");
  const action = text(step.action, 40).toLowerCase();
  if (!["send_message","add_tag","webhook","wait","condition"].includes(action)) throw new Error("Unsupported workflow action");
  if (action === "wait") {
    const seconds = Number(step.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_DELAY_SECONDS) throw new Error("Invalid workflow delay");
    return { action, seconds };
  }
  if (action === "send_message") return { action, body: text(step.body, 4096) };
  if (action === "add_tag") return { action, tag: text(step.tag, 100) };
  if (action === "condition") {
    const field = text(step.field, 100);
    const operator = text(step.operator, 30).toLowerCase();
    if (!["equals","not_equals","contains","exists"].includes(operator)) throw new Error("Invalid condition operator");
    return { action, field, operator, value: step.value ?? null, if_true: Number.isInteger(step.if_true) ? step.if_true : index + 1, if_false: Number.isInteger(step.if_false) ? step.if_false : index + 1 };
  }
  const url = text(step.url, 2048);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Invalid webhook URL"); }
  if (!["https:"].includes(parsed.protocol)) throw new Error("Webhook must use HTTPS");
  return { action, url, method: String(step.method || "POST").toUpperCase() === "POST" ? "POST" : "PUT", body: step.body && typeof step.body === "object" ? step.body : {} };
}

export async function createWorkflow({ tenantId, createdBy, name, description = null, triggerType = "manual", triggerConfig = {}, definition = {} }) {
  assertDb(); const t=tenant(tenantId);
  if (!uuid(createdBy)) throw new Error("Invalid creator ID");
  const n=text(name,120);
  if (!["manual","message_received","conversation_created","inactivity"].includes(triggerType)) throw new Error("Invalid trigger type");
  const def=normalizeWorkflowDefinition(definition);
  const r=await dbPool.query(`INSERT INTO automation_workflows
    (tenant_id,name,description,trigger_type,trigger_config,definition,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,[t,n,typeof description==="string"?description.slice(0,2000):null,triggerType,triggerConfig,def,createdBy]);
  return r.rows[0];
}
export async function listWorkflows(tenantId) {
  assertDb(); const r=await dbPool.query("SELECT * FROM automation_workflows WHERE tenant_id=$1 ORDER BY created_at DESC",[tenant(tenantId)]); return r.rows;
}
export async function setWorkflowStatus(tenantId, workflowId, status) {
  assertDb(); if(!uuid(workflowId)) throw new Error("Invalid workflow ID");
  if(!["draft","active","paused","archived"].includes(status)) throw new Error("Invalid workflow status");
  const r=await dbPool.query("UPDATE automation_workflows SET status=$3, version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",[tenant(tenantId),workflowId,status]);
  if(!r.rows[0]) throw new Error("Workflow not found"); return r.rows[0];
}
export async function startWorkflowRun({tenantId,workflowId,conversationId=null,contactId=null,context={}}) {
  assertDb(); const t=tenant(tenantId);
  if(!uuid(workflowId)) throw new Error("Invalid workflow ID");
  const r=await dbPool.query(`INSERT INTO automation_runs(tenant_id,workflow_id,conversation_id,contact_id,status,context,next_run_at)
    SELECT $1,w.id,$3,$4,'queued',$5,NOW() FROM automation_workflows w
    WHERE w.tenant_id=$1 AND w.id=$2 AND w.status='active' RETURNING *`,[t,workflowId,conversationId,contactId,context]);
  if(!r.rows[0]) throw new Error("Active workflow not found"); return r.rows[0];
}
export async function triggerWorkflows({tenantId,triggerType,conversationId=null,contactId=null,context={}}) {
  assertDb(); const t=tenant(tenantId);
  const r=await dbPool.query(`SELECT id FROM automation_workflows WHERE tenant_id=$1 AND status='active' AND trigger_type=$2`,[t,triggerType]);
  const runs=[]; for(const row of r.rows) runs.push(await startWorkflowRun({tenantId:t,workflowId:row.id,conversationId,contactId,context})); return runs;
}
function getPath(obj,path){ return path.split(".").reduce((v,k)=>v && typeof v==="object"?v[k]:undefined,obj); }
function condition(step,ctx){ const v=getPath(ctx,step.field); if(step.operator==="exists") return v!==undefined&&v!==null; if(step.operator==="equals") return v===step.value; if(step.operator==="not_equals") return v!==step.value; return typeof v==="string"&&v.toLowerCase().includes(String(step.value??"").toLowerCase()); }

async function executeSendMessage(client, run, step, ctx) {
  if(!uuid(run.conversation_id)) throw new Error("Workflow send_message requires a conversation");
  const q=await client.query(`SELECT c.id,c.tenant_id,c.contact_id,c.whatsapp_number_id,co.wa_id,wn.phone_number_id
    FROM conversations c JOIN contacts co ON co.tenant_id=c.tenant_id AND co.id=c.contact_id
    JOIN whatsapp_numbers wn ON wn.tenant_id=c.tenant_id AND wn.id=c.whatsapp_number_id
    WHERE c.tenant_id=$1 AND c.id=$2 LIMIT 1`,[run.tenant_id,run.conversation_id]);
  if(!q.rows[0]) throw new Error("Workflow conversation not found");
  const row=q.rows[0];
  const d=await client.query(`INSERT INTO whatsapp_deliveries
    (tenant_id,inbox_message_id,conversation_id,recipient_wa_id,body,automation_run_id)
    VALUES($1,NULL,$2,$3,$4,$5) ON CONFLICT (tenant_id,automation_run_id)
    DO NOTHING RETURNING id`,[run.tenant_id,row.id,row.wa_id,step.body,run.id]);
  return d.rows[0] ? "queued" : "already_queued";
}
async function executeTag(client,run,step){
  if(!uuid(run.conversation_id)) throw new Error("Workflow add_tag requires a conversation");
  await client.query(`INSERT INTO conversation_tags(tenant_id,conversation_id,tag)
    SELECT $1,c.id,$3 FROM conversations c WHERE c.tenant_id=$1 AND c.id=$2 ON CONFLICT DO NOTHING`,[run.tenant_id,run.conversation_id,step.tag]);
}
async function executeWebhook(step,run,ctx){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10_000);
  try {
    const body=JSON.stringify({tenantId:run.tenant_id,runId:run.id,context:ctx});
    if(body.length>MAX_WEBHOOK_BODY) throw new Error("Webhook payload too large");
    const response=await fetch(step.url,{method:step.method,headers:{"content-type":"application/json"},body,signal:controller.signal,redirect:"error"});
    if(!response.ok) throw new Error(`Workflow webhook returned HTTP ${response.status}`);
  } finally { clearTimeout(timer); }
}
export async function processDueWorkflowRuns(limit=20) {
  assertDb(); const safe=Math.min(Math.max(Number(limit)||20,1),50); const client=await dbPool.connect();
  try {
    const claimed=await client.query(`WITH picked AS (
      SELECT id FROM automation_runs WHERE status IN ('queued','waiting') AND (next_run_at IS NULL OR next_run_at<=NOW())
      ORDER BY next_run_at NULLS FIRST,created_at FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE automation_runs r SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,NOW()),updated_at=NOW()
      FROM picked WHERE r.id=picked.id RETURNING r.*`,[safe]);
    for(const run of claimed.rows) {
      try {
        const wf=(await client.query("SELECT * FROM automation_workflows WHERE tenant_id=$1 AND id=$2 AND status='active'",[run.tenant_id,run.workflow_id])).rows[0];
        if(!wf) throw new Error("Workflow is no longer active");
        const steps=normalizeWorkflowDefinition(wf.definition).steps;
        let idx=run.current_step, ctx=run.context||{};
        while(idx<steps.length) {
          const step=steps[idx];
          if(step.action==="wait"){ await client.query("UPDATE automation_runs SET status='waiting',current_step=$3,next_run_at=NOW()+($4*INTERVAL '1 second') WHERE tenant_id=$1 AND id=$2",[run.tenant_id,run.id,idx+1,step.seconds]); break; }
          if(step.action==="condition"){ idx=condition(step,ctx)?step.if_true:step.if_false; continue; }
          if(step.action==="send_message"){ await executeSendMessage(client,run,step,ctx); idx++; continue; }
          if(step.action==="add_tag"){ await executeTag(client,run,step); idx++; continue; }
          if(step.action==="webhook"){ await executeWebhook(step,run,ctx); idx++; continue; }
          idx++;
          await client.query("UPDATE automation_runs SET current_step=$3,context=$4 WHERE tenant_id=$1 AND id=$2",[run.tenant_id,run.id,idx,ctx]);
        }
        if(idx>=steps.length) await client.query("UPDATE automation_runs SET status='completed',current_step=$3,next_run_at=NULL,completed_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND id=$2",[run.tenant_id,run.id,idx]);
      } catch(error) {
        const retry=run.attempts<MAX_RETRIES;
        await client.query(`UPDATE automation_runs SET status=$3,next_run_at=CASE WHEN $3='queued' THEN NOW()+(LEAST(300,POWER(2,GREATEST(attempts-1,0))*2)*INTERVAL '1 second') ELSE NULL END,last_error=$4,updated_at=NOW() WHERE tenant_id=$1 AND id=$2`,[run.tenant_id,run.id,retry?"queued":"failed",String(error.message).slice(0,1000)]);
      }
    }
    return claimed.rows.length;
  } finally { client.release(); }
}
