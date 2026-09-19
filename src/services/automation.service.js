import { dbPool, isDatabaseConfigured } from "../config/database.js";

const MAX_STEPS = 50;
const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;
const MAX_WEBHOOK_BODY = 16_384;
const MAX_WEBHOOK_BODY_DEPTH = 10;
const MAX_RETRIES = 5;

function assertDb() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}
function uuid(v) { return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v.trim()); }
function tenant(v) { if (!uuid(v)) throw new Error("Invalid tenant ID"); return v.trim(); }
function text(v, max) { if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("Invalid text value"); return v.trim(); }

function validateWebhookJsonValue(value, seen, depth) {
  if (value === null) return;
  if (value === undefined || ["function", "symbol", "bigint"].includes(typeof value)) {
    throw new Error("Webhook body contains a non-JSON-safe value");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Webhook body contains a non-finite number");
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value !== "object") throw new Error("Webhook body contains an invalid value");
  if (depth > MAX_WEBHOOK_BODY_DEPTH) throw new Error("Webhook body nesting is too deep");
  if (seen.has(value)) throw new Error("Webhook body contains a circular reference");
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_WEBHOOK_BODY) throw new Error("Webhook body is too large");
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error("Webhook body contains a sparse array");
      validateWebhookJsonValue(value[i], seen, depth + 1);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new Error("Webhook body contains a symbol key");
      if (key === "length") continue;
      if (!/^(0|[1-9]\\d*)$/.test(key) || Number(key) >= value.length) {
        throw new Error("Webhook body contains an invalid array property");
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Webhook body contains a non-plain object");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new Error("Webhook body contains a symbol key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new Error("Webhook body contains a non-JSON-safe property");
      }
      validateWebhookJsonValue(descriptor.value, seen, depth + 1);
    }
  }

  seen.delete(value);
}

function normalizeWebhookBody(value) {
  validateWebhookJsonValue(value, new WeakSet(), 0);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Invalid webhook body");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_WEBHOOK_BODY) {
    throw new Error("Webhook body is too large");
  }
  return value;
}

export function normalizeWorkflowDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("Invalid workflow definition");
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (steps.length > MAX_STEPS) throw new Error("Workflow has too many steps");
  return {
    version: 1,
    steps: steps.map((step, i) => normalizeStep(step, i, steps.length)),
  };
}
function normalizeStep(step, index, stepCount) {
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
    const target = (name) => {
      if (!Object.prototype.hasOwnProperty.call(step, name)) return index + 1;
      if (!Number.isInteger(step[name]) || step[name] < 0 || step[name] > stepCount) {
        throw new Error(`Invalid workflow condition ${name} target`);
      }
      return step[name];
    };
    return { action, field, operator, value: step.value ?? null, if_true: target("if_true"), if_false: target("if_false") };
  }
  const url = text(step.url, 2048);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Invalid webhook URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Webhook must use HTTPS without embedded credentials");
  const allowed = String(process.env.AUTOMATION_WEBHOOK_ALLOWLIST || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(parsed.hostname.toLowerCase())) throw new Error("Webhook host is not allowlisted");
  const body = Object.prototype.hasOwnProperty.call(step, "body") ? step.body : {};
  if (body === null || typeof body !== "object") throw new Error("Invalid webhook body");
  return { action, url, method: String(step.method || "POST").toUpperCase() === "POST" ? "POST" : "PUT", body: normalizeWebhookBody(body) };
}

export async function createWorkflow({ tenantId, createdBy, name, description = null, triggerType = "manual", triggerConfig = {}, definition = {} }) {
  assertDb(); const t=tenant(tenantId);
  if (!uuid(createdBy)) throw new Error("Invalid creator ID");
  const n=text(name,120);
  if (!["manual","message_received","conversation_created","inactivity"].includes(triggerType)) throw new Error("Invalid trigger type");
  if (!triggerConfig || typeof triggerConfig !== "object" || Array.isArray(triggerConfig)) throw new Error("Invalid trigger configuration");
  if (triggerType === "inactivity") { const after = Number(triggerConfig.afterSeconds); if (!Number.isInteger(after) || after < 60 || after > MAX_DELAY_SECONDS) throw new Error("Invalid inactivity delay"); }
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
export async function startWorkflowRun({tenantId,workflowId,conversationId=null,contactId=null,context={},triggerKey=null}) {
  assertDb(); const t=tenant(tenantId);
  if(!uuid(workflowId)) throw new Error("Invalid workflow ID");
  const r=await dbPool.query(`INSERT INTO automation_runs(tenant_id,workflow_id,conversation_id,contact_id,status,context,next_run_at,trigger_key)
    SELECT $1,w.id,$3,$4,'queued',$5,NOW() FROM automation_workflows w
    WHERE w.tenant_id=$1 AND w.id=$2 AND w.status='active' ON CONFLICT (tenant_id,workflow_id,trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING RETURNING *`,[t,workflowId,conversationId,contactId,context,triggerKey]);
  return r.rows[0] ?? null;
}
export async function triggerWorkflows({tenantId,triggerType,conversationId=null,contactId=null,context={}}) {
  assertDb(); const t=tenant(tenantId);
  const r=await dbPool.query(`SELECT id FROM automation_workflows WHERE tenant_id=$1 AND status='active' AND trigger_type=$2`,[t,triggerType]);
  const key = context?.message?.id ? `${triggerType}:${context.message.id}` : null;
  const runs=[]; for(const row of r.rows) { const run = await startWorkflowRun({tenantId:t,workflowId:row.id,conversationId,contactId,context,triggerKey:key}); if(run) runs.push(run); } return runs;
}
function getPath(obj,path){ return path.split(".").reduce((v,k)=>v && typeof v==="object"?v[k]:undefined,obj); }
function condition(step,ctx){ const v=getPath(ctx,step.field); if(step.operator==="exists") return v!==undefined&&v!==null; if(step.operator==="equals") return v===step.value; if(step.operator==="not_equals") return v!==step.value; return typeof v==="string"&&v.toLowerCase().includes(String(step.value??"").toLowerCase()); }

async function executeSendMessage(client, run, step, stepIndex) {
  if (!uuid(run.conversation_id)) throw new Error("Workflow send_message requires a conversation");
  const q=await client.query(`SELECT c.id,c.tenant_id,co.wa_id
    FROM conversations c
    JOIN contacts co ON co.tenant_id=c.tenant_id AND co.id=c.contact_id
    WHERE c.tenant_id=$1 AND c.id=$2 LIMIT 1`,[run.tenant_id,run.conversation_id]);
  if(!q.rows[0]) throw new Error("Workflow conversation not found");
  const row=q.rows[0];
  const d=await client.query(`INSERT INTO whatsapp_deliveries
    (tenant_id,inbox_message_id,conversation_id,recipient_wa_id,body,automation_run_id,automation_step)
    VALUES($1,NULL,$2,$3,$4,$5,$6)
    ON CONFLICT (tenant_id,automation_run_id,automation_step) DO NOTHING
    RETURNING id`,[run.tenant_id,row.id,row.wa_id,step.body,run.id,stepIndex]);
  return d.rows[0] ? "queued" : "already_queued";
}
async function executeTag(client,run,step){
  if(!uuid(run.conversation_id)) throw new Error("Workflow add_tag requires a conversation");
  await client.query(`INSERT INTO conversation_tags(tenant_id,conversation_id,tag)
    SELECT $1,c.id,$3 FROM conversations c WHERE c.tenant_id=$1 AND c.id=$2 ON CONFLICT DO NOTHING`,[run.tenant_id,run.conversation_id,step.tag]);
}
async function executeWebhook(step,run,ctx,stepIndex){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10_000);
  try {
    const body=JSON.stringify({runId:run.id,workflowId:run.workflow_id,step:stepIndex,context:ctx});
    if(body.length>MAX_WEBHOOK_BODY) throw new Error("Webhook payload too large");
    const response=await fetch(step.url,{method:step.method,headers:{"content-type":"application/json","idempotency-key":run.id+":"+stepIndex},body,signal:controller.signal,redirect:"error"});
    if(!response.ok) throw new Error(`Workflow webhook returned HTTP ${response.status}`);
  } finally { clearTimeout(timer); }
}
export async function scheduleInactivityTriggers(limit=100) {
  assertDb();
  const safe=Math.min(Math.max(Number(limit)||100,1),500);
  const r=await dbPool.query(`SELECT w.id AS workflow_id,w.tenant_id,w.trigger_config,c.id AS conversation_id,c.contact_id,
      FLOOR(EXTRACT(EPOCH FROM (NOW()-c.last_message_at))/GREATEST(COALESCE((w.trigger_config->>'afterSeconds')::integer,86400),1)) AS bucket
    FROM automation_workflows w
    JOIN conversations c ON c.tenant_id=w.tenant_id
    WHERE w.status='active' AND w.trigger_type='inactivity'
      AND c.status IN ('active','paused','human')
      AND c.last_message_at <= NOW() - (GREATEST(COALESCE((w.trigger_config->>'afterSeconds')::integer,86400),1) * INTERVAL '1 second')
    ORDER BY c.last_message_at ASC LIMIT $1`,[safe]);
  let created=0;
  for(const row of r.rows){
    const key=`inactivity:${row.conversation_id}:${row.bucket}`;
    const run=await startWorkflowRun({
      tenantId:row.tenant_id,workflowId:row.workflow_id,
      conversationId:row.conversation_id,contactId:row.contact_id,
      context:{trigger:{type:"inactivity",bucket:Number(row.bucket)}},triggerKey:key,
    });
    if(run) created++;
  }
  return created;
}

export async function processDueWorkflowRuns(limit=20) {
  assertDb();
  const safe=Math.min(Math.max(Number(limit)||20,1),50);
  const claimClient=await dbPool.connect();
  let runs=[];
  try {
    const r=await claimClient.query(`WITH picked AS (
      SELECT id FROM automation_runs
      WHERE (status IN ('queued','waiting')
        AND (next_run_at IS NULL OR next_run_at<=NOW()))
        OR (status='running' AND updated_at < NOW() - INTERVAL '2 minutes')
      ORDER BY next_run_at NULLS FIRST,created_at
      FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE automation_runs r
      SET status='running',attempts=attempts+1,
          started_at=COALESCE(started_at,NOW()),updated_at=NOW()
      FROM picked WHERE r.id=picked.id RETURNING r.*`,[safe]);
    runs=r.rows;
  } finally { claimClient.release(); }

  for(const run of runs) {
    try {
      const wf=(await dbPool.query(
        "SELECT * FROM automation_workflows WHERE tenant_id=$1 AND id=$2 AND status='active'",
        [run.tenant_id,run.workflow_id],
      )).rows[0];
      if(!wf) throw new Error("Workflow is no longer active");
      const steps=normalizeWorkflowDefinition(wf.definition).steps;
      let idx=run.current_step;
      const ctx=run.context||{};
      let executed=0;
      while(idx<steps.length) {
        if(++executed>MAX_STEPS) throw new Error("Workflow execution step limit exceeded");
        const step=steps[idx];
        if(step.action==="wait") {
          await dbPool.query(
            "UPDATE automation_runs SET status='waiting',current_step=$3,next_run_at=NOW()+($5*INTERVAL '1 second'),context=$4::jsonb,updated_at=NOW() WHERE tenant_id=$1 AND id=$2",
            [run.tenant_id,run.id,idx+1,JSON.stringify(ctx),step.seconds],
          );
          break;
        }
        if(step.action==="condition"){ idx=condition(step,ctx)?step.if_true:step.if_false; continue; }
        if(step.action==="send_message"){
          const client=await dbPool.connect();
          try { await executeSendMessage(client,run,step,idx); } finally { client.release(); }
        } else if(step.action==="add_tag"){
          const client=await dbPool.connect();
          try { await executeTag(client,run,step); } finally { client.release(); }
        } else if(step.action==="webhook"){
          await executeWebhook(step,run,ctx,idx);
        }
        idx++;
        await dbPool.query(
          "UPDATE automation_runs SET current_step=$3,context=$4::jsonb,updated_at=NOW() WHERE tenant_id=$1 AND id=$2 AND status='running'",
          [run.tenant_id,run.id,idx,JSON.stringify(ctx)],
        );
      }
      if(idx>=steps.length) {
        await dbPool.query(
          "UPDATE automation_runs SET status='completed',current_step=$3,next_run_at=NULL,completed_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND id=$2 AND status='running'",
          [run.tenant_id,run.id,idx],
        );
      }
    } catch(error) {
      const retry=run.attempts<MAX_RETRIES;
      await dbPool.query(
        `UPDATE automation_runs SET status=$3,
          next_run_at=CASE WHEN $3='queued' THEN NOW()+(LEAST(300,POWER(2,GREATEST(attempts-1,0))*2)*INTERVAL '1 second') ELSE NULL END,
          last_error=$4,updated_at=NOW()
          WHERE tenant_id=$1 AND id=$2 AND status='running'`,
        [run.tenant_id,run.id,retry?"queued":"failed",String(error.message||error).slice(0,1000)],
      );
    }
  }
  return runs.length;
}
