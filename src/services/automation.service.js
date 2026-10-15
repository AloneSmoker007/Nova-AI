import { createHash } from "node:crypto";
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
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
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


export function serializeConfiguredWebhookBody(step) {
  const value = step && Object.prototype.hasOwnProperty.call(step, "body")
    ? step.body
    : {};
  return JSON.stringify(normalizeWebhookBody(value));
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
  const normalizedTriggerConfig = { ...triggerConfig };
  if (triggerType === "inactivity") {
    const after = Number(triggerConfig.afterSeconds);
    if (!Number.isInteger(after) || after < 60 || after > MAX_DELAY_SECONDS) {
      throw new Error("Invalid inactivity delay");
    }
    // Persist the numeric value we validated. For example, Number("1e2") is
    // 100, but PostgreSQL cannot cast the original JSON string "1e2" to int.
    normalizedTriggerConfig.afterSeconds = after;
  }
  const def=normalizeWorkflowDefinition(definition);
  const r=await dbPool.query(`INSERT INTO automation_workflows
    (tenant_id,name,description,trigger_type,trigger_config,definition,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,[t,n,typeof description==="string"?description.slice(0,2000):null,triggerType,normalizedTriggerConfig,def,createdBy]);
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
    SELECT $1,w.id,$3,$4,'queued',$5,NOW(),$6 FROM automation_workflows w
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
    ON CONFLICT (tenant_id,automation_run_id,automation_step) WHERE automation_run_id IS NOT NULL DO NOTHING
    RETURNING id`,[run.tenant_id,row.id,row.wa_id,step.body,run.id,stepIndex]);
  return d.rows[0] ? "queued" : "already_queued";
}
async function executeTag(client,run,step){
  if(!uuid(run.conversation_id)) throw new Error("Workflow add_tag requires a conversation");
  await client.query(`INSERT INTO conversation_tags(tenant_id,conversation_id,tag)
    SELECT $1,c.id,$3 FROM conversations c WHERE c.tenant_id=$1 AND c.id=$2 ON CONFLICT DO NOTHING`,[run.tenant_id,run.conversation_id,step.tag]);
}
function webhookOutcomeError(message = "Webhook outcome is unknown; manual reconciliation is required") {
  const error = new Error(message);
  error.code = "AUTOMATION_WEBHOOK_OUTCOME_UNKNOWN";
  return error;
}

function webhookRequestFingerprint(step, body) {
  return createHash("sha256")
    .update(`${step.method}\\n${step.url}\\n${body}`, "utf8")
    .digest("hex");
}

async function executeWebhook(step, run, stepIndex) {
  // Serialize before recording an external attempt. Validation failures here
  // cannot have caused a remote side effect, so the workflow may safely retry.
  const body = serializeConfiguredWebhookBody(step);
  const endpointHost = new URL(step.url).hostname.toLowerCase();
  const requestFingerprint = webhookRequestFingerprint(step, body);
  let attemptCount = 1;

  const inserted = await dbPool.query(
    `INSERT INTO automation_webhook_effects
       (tenant_id, run_id, step_index, endpoint_host, request_sha256, status, attempt_count)
     VALUES ($1, $2, $3, $4, $5, 'in_flight', 1)
     ON CONFLICT (tenant_id, run_id, step_index) DO NOTHING
     RETURNING id, attempt_count, status`,
    [run.tenant_id, run.id, stepIndex, endpointHost, requestFingerprint],
  );

  let effect = inserted.rows[0];
  if (!effect) {
    const existingResult = await dbPool.query(
      `SELECT id, endpoint_host, request_sha256, status, attempt_count, updated_at
       FROM automation_webhook_effects
       WHERE tenant_id=$1 AND run_id=$2 AND step_index=$3`,
      [run.tenant_id, run.id, stepIndex],
    );
    effect = existingResult.rows[0];
    if (!effect) throw new Error("Automation webhook effect record disappeared");

    // A successful remote effect is durable. If the worker crashed before
    // advancing current_step, resume locally without sending it a second time.
    if (effect.status === "succeeded") return;

    if (
      effect.endpoint_host !== endpointHost ||
      effect.request_sha256 !== requestFingerprint
    ) {
      if (["in_flight", "retry_authorized"].includes(effect.status)) {
        await dbPool.query(
          `UPDATE automation_webhook_effects
           SET status='unknown', last_error_code='definition_changed'
           WHERE id=$1 AND status IN ('in_flight', 'retry_authorized')`,
          [effect.id],
        );
      }
      throw webhookOutcomeError("Webhook definition changed after an external attempt; manual reconciliation is required");
    }

    if (effect.status === "unknown") {
      throw webhookOutcomeError();
    }

    if (effect.status === "in_flight") {
      const stale = await dbPool.query(
        `UPDATE automation_webhook_effects
         SET status='unknown', last_error_code='process_lost'
         WHERE id=$1 AND status='in_flight'
           AND updated_at < NOW() - INTERVAL '15 minutes'
         RETURNING id`,
        [effect.id],
      );
      if (stale.rowCount === 1) throw webhookOutcomeError();
      const error = new Error("Webhook request is already in flight; waiting before reconciliation");
      error.code = "AUTOMATION_WEBHOOK_IN_PROGRESS";
      throw error;
    }

    if (effect.status !== "retry_authorized") {
      throw webhookOutcomeError();
    }

    const retryClaim = await dbPool.query(
      `UPDATE automation_webhook_effects
       SET status='in_flight', attempt_count=attempt_count+1,
           response_status=NULL, last_error_code=NULL
       WHERE id=$1 AND status='retry_authorized'
       RETURNING attempt_count`,
      [effect.id],
    );
    if (retryClaim.rowCount !== 1) {
      const error = new Error("Webhook effect is being reconciled by another actor");
      error.code = "AUTOMATION_WEBHOOK_IN_PROGRESS";
      throw error;
    }
    attemptCount = retryClaim.rows[0].attempt_count;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // Only the explicitly configured, validated JSON body is sent. Customer
    // history, workflow context, phone numbers and credentials are not added.
    const response = await fetch(step.url, {
      method: step.method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": run.id + ":" + stepIndex,
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      const recorded = await dbPool.query(
        `UPDATE automation_webhook_effects
         SET status='unknown', response_status=$4, last_error_code='http_error'
         WHERE tenant_id=$1 AND run_id=$2 AND step_index=$3
           AND status='in_flight' AND attempt_count=$5
         RETURNING id`,
        [run.tenant_id, run.id, stepIndex, response.status, attemptCount],
      );
      if (recorded.rowCount !== 1) throw webhookOutcomeError();
      throw webhookOutcomeError(`Webhook returned HTTP ${response.status}; external outcome requires reconciliation`);
    }

    const recorded = await dbPool.query(
      `UPDATE automation_webhook_effects
       SET status='succeeded', response_status=$4, last_error_code=NULL
       WHERE tenant_id=$1 AND run_id=$2 AND step_index=$3
         AND status='in_flight' AND attempt_count=$5
       RETURNING id`,
      [run.tenant_id, run.id, stepIndex, response.status, attemptCount],
    );
    if (recorded.rowCount !== 1) {
      const latest = await dbPool.query(
        "SELECT status FROM automation_webhook_effects WHERE tenant_id=$1 AND run_id=$2 AND step_index=$3",
        [run.tenant_id, run.id, stepIndex],
      );
      if (latest.rows[0]?.status === "succeeded") return;
      throw webhookOutcomeError();
    }
  } catch (error) {
    // Network resets/timeouts and failed HTTP status codes are ambiguous: a
    // remote server may have acted before the response was lost. Never retry
    // this effect automatically. Record only a safe code, not URL/body/errors.
    if (error.code === "AUTOMATION_WEBHOOK_OUTCOME_UNKNOWN") throw error;
    await dbPool.query(
      `UPDATE automation_webhook_effects
       SET status='unknown',
           response_status=COALESCE(response_status, $4),
           last_error_code=$5
       WHERE tenant_id=$1 AND run_id=$2 AND step_index=$3
         AND status='in_flight' AND attempt_count=$6`,
      [
        run.tenant_id,
        run.id,
        stepIndex,
        Number.isInteger(error.statusCode) ? error.statusCode : null,
        error.name === "AbortError" ? "timeout" : "request_error",
        attemptCount,
      ],
    ).catch(() => undefined);
    throw webhookOutcomeError();
  } finally {
    clearTimeout(timer);
  }
}

export async function listUnknownWorkflowWebhookEffects(tenantId, limit = 50) {
  assertDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const result = await dbPool.query(
    `SELECT id, run_id, step_index, endpoint_host, status, attempt_count,
            response_status, last_error_code, created_at, updated_at
     FROM automation_webhook_effects
     WHERE tenant_id=$1 AND status='unknown'
     ORDER BY updated_at DESC
     LIMIT $2`,
    [tenant(tenantId), safeLimit],
  );
  return result.rows;
}

export async function resolveUnknownWorkflowWebhookEffect({
  tenantId,
  effectId,
  resolvedBy,
  outcome,
  reason,
}) {
  assertDb();
  const t = tenant(tenantId);
  if (!uuid(effectId) || !uuid(resolvedBy)) throw new Error("Invalid identifier");
  if (!["succeeded", "not_sent"].includes(outcome)) throw new Error("Invalid webhook reconciliation outcome");
  const resolutionReason = text(reason, 500);
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");
    const effectResult = await client.query(
      `SELECT id, run_id, step_index, status
       FROM automation_webhook_effects
       WHERE tenant_id=$1 AND id=$2
       FOR UPDATE`,
      [t, effectId],
    );
    const effect = effectResult.rows[0];
    if (!effect || effect.status !== "unknown") {
      await client.query("ROLLBACK");
      return null;
    }

    const resolvedState = outcome === "succeeded" ? "succeeded" : "retry_authorized";
    await client.query(
      `UPDATE automation_webhook_effects
       SET status=$3, resolved_by=$4, resolution_reason=$5, resolved_at=NOW(),
           updated_at=NOW(), last_error_code=NULL
       WHERE tenant_id=$1 AND id=$2 AND status='unknown'`,
      [t, effectId, resolvedState, resolvedBy, resolutionReason],
    );

    const nextStep = outcome === "succeeded" ? effect.step_index + 1 : effect.step_index;
    const run = await client.query(
      `UPDATE automation_runs
       SET status='queued', current_step=$3, next_run_at=NOW(),
           completed_at=NULL, last_error=NULL, attempts=0,
           executor_token=NULL, executor_lease_until=NULL, updated_at=NOW()
       WHERE tenant_id=$1 AND id=$2 AND status='failed'
       RETURNING id`,
      [t, effect.run_id, nextStep],
    );
    if (run.rowCount !== 1) {
      throw new Error("Workflow run is no longer eligible for manual reconciliation");
    }

    await client.query("COMMIT");
    return { effectId, runId: effect.run_id, outcome, status: resolvedState };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function scheduleInactivityTriggers(limit = 100) {
  assertDb();
  const safe = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await dbPool.query(
    `SELECT
       w.id AS workflow_id,
       w.tenant_id,
       w.trigger_config,
       c.id AS conversation_id,
       c.contact_id,
       FLOOR(EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / delay.after_seconds) AS bucket
     FROM automation_workflows AS w
     JOIN conversations AS c ON c.tenant_id = w.tenant_id
     CROSS JOIN LATERAL (
       SELECT CASE
         WHEN jsonb_typeof(w.trigger_config -> 'afterSeconds') IN ('number', 'string')
         THEN CASE
           WHEN (w.trigger_config ->> 'afterSeconds') ~ '^[0-9]{1,7}$'
           THEN CASE
             WHEN (w.trigger_config ->> 'afterSeconds')::integer BETWEEN 60 AND ${MAX_DELAY_SECONDS}
             THEN (w.trigger_config ->> 'afterSeconds')::integer
             ELSE 86400
           END
           ELSE 86400
         END
         ELSE 86400
       END AS after_seconds
     ) AS delay
     WHERE w.status = 'active'
       AND w.trigger_type = 'inactivity'
       AND c.status IN ('active', 'paused', 'human')
       AND c.last_message_at <= NOW() - (delay.after_seconds * INTERVAL '1 second')
     ORDER BY c.last_message_at ASC
     LIMIT $1`,
    [safe],
  );
  let created = 0;
  for (const row of result.rows) {
    const key = `inactivity:${row.conversation_id}:${row.bucket}`;
    const run = await startWorkflowRun({
      tenantId: row.tenant_id,
      workflowId: row.workflow_id,
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      context: { trigger: { type: "inactivity", bucket: Number(row.bucket) } },
      triggerKey: key,
    });
    if (run) created++;
  }
  return created;
}

export async function processDueWorkflowRuns(limit = 20) {
  assertDb();
  const safe = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const claimClient = await dbPool.connect();
  let runs = [];

  try {
    const claimed = await claimClient.query(
      `WITH picked AS (
        SELECT id
        FROM automation_runs
        WHERE (
          status IN ('queued', 'waiting')
          AND (next_run_at IS NULL OR next_run_at <= NOW())
        ) OR (
          status = 'running'
          AND (executor_lease_until IS NULL OR executor_lease_until < NOW())
        )
        ORDER BY next_run_at NULLS FIRST, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE automation_runs AS run
      SET status = 'running',
          attempts = run.attempts + 1,
          started_at = COALESCE(run.started_at, NOW()),
          updated_at = NOW(),
          executor_token = gen_random_uuid(),
          executor_lease_until = NOW() + INTERVAL '15 minutes'
      FROM picked
      WHERE run.id = picked.id
      RETURNING run.*`,
      [safe],
    );
    runs = claimed.rows;
  } finally {
    claimClient.release();
  }

  for (const run of runs) {
    try {
      // A batch may sit while earlier runs execute. Confirm ownership and
      // renew the lease before loading workflow data or performing side effects.
      const initialLease = await dbPool.query(
        `UPDATE automation_runs
         SET executor_lease_until = NOW() + INTERVAL '15 minutes',
             updated_at = NOW()
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'running'
           AND executor_token = $3
           AND executor_lease_until > NOW()
         RETURNING id`,
        [run.tenant_id, run.id, run.executor_token],
      );
      if (initialLease.rowCount !== 1) continue;

      const wf = (
        await dbPool.query(
          "SELECT * FROM automation_workflows WHERE tenant_id=$1 AND id=$2 AND status='active'",
          [run.tenant_id, run.workflow_id],
        )
      ).rows[0];
      if (!wf) throw new Error("Workflow is no longer active");

      const steps = normalizeWorkflowDefinition(wf.definition).steps;
      let idx = run.current_step;
      const ctx = run.context || {};
      let executed = 0;
      let lostLease = false;

      while (idx < steps.length) {
        if (++executed > MAX_STEPS) {
          throw new Error("Workflow execution step limit exceeded");
        }

        // Do not start another action if this executor's lease expired or a
        // newer executor replaced its token while the previous action awaited.
        const renewedLease = await dbPool.query(
          `UPDATE automation_runs
           SET executor_lease_until = NOW() + INTERVAL '15 minutes',
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'running'
             AND executor_token = $3
             AND executor_lease_until > NOW()
           RETURNING id`,
          [run.tenant_id, run.id, run.executor_token],
        );
        if (renewedLease.rowCount !== 1) {
          lostLease = true;
          break;
        }

        const step = steps[idx];

        if (step.action === "wait") {
          const waiting = await dbPool.query(
            `UPDATE automation_runs
             SET status = 'waiting',
                 current_step = $3,
                 next_run_at = NOW() + ($5 * INTERVAL '1 second'),
                 context = $4::jsonb,
                 updated_at = NOW(),
                 executor_token = NULL,
                 executor_lease_until = NULL
             WHERE tenant_id = $1
               AND id = $2
               AND status = 'running'
               AND executor_token = $6
               AND executor_lease_until > NOW()
             RETURNING id`,
            [
              run.tenant_id,
              run.id,
              idx + 1,
              JSON.stringify(ctx),
              step.seconds,
              run.executor_token,
            ],
          );
          if (waiting.rowCount !== 1) lostLease = true;
          break;
        }

        if (step.action === "condition") {
          idx = condition(step, ctx) ? step.if_true : step.if_false;
          continue;
        }

        if (step.action === "send_message") {
          const client = await dbPool.connect();
          try {
            await executeSendMessage(client, run, step, idx);
          } finally {
            client.release();
          }
        } else if (step.action === "add_tag") {
          const client = await dbPool.connect();
          try {
            await executeTag(client, run, step);
          } finally {
            client.release();
          }
        } else if (step.action === "webhook") {
          await executeWebhook(step, run, idx);
        }

        idx++;
        const advanced = await dbPool.query(
          `UPDATE automation_runs
           SET current_step = $3,
               context = $4::jsonb,
               updated_at = NOW(),
               executor_lease_until = NOW() + INTERVAL '15 minutes'
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'running'
             AND executor_token = $5
             AND executor_lease_until > NOW()
           RETURNING id`,
          [run.tenant_id, run.id, idx, JSON.stringify(ctx), run.executor_token],
        );
        if (advanced.rowCount !== 1) {
          lostLease = true;
          break;
        }
      }

      if (lostLease) continue;

      if (idx >= steps.length) {
        await dbPool.query(
          `UPDATE automation_runs
           SET status = 'completed',
               current_step = $3,
               next_run_at = NULL,
               completed_at = NOW(),
               updated_at = NOW(),
               executor_token = NULL,
               executor_lease_until = NULL
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'running'
             AND executor_token = $4
             AND executor_lease_until > NOW()
           RETURNING id`,
          [run.tenant_id, run.id, idx, run.executor_token],
        );
      }
    } catch (error) {
      const outcomeUnknown = error?.code === "AUTOMATION_WEBHOOK_OUTCOME_UNKNOWN";
      const requestStillInFlight = error?.code === "AUTOMATION_WEBHOOK_IN_PROGRESS";
      // Ambiguous external effects are never retried automatically. A recent
      // in-flight effect is delayed (without another send) while the owner
      // finishes or until the 15-minute stale-effect marker forces review.
      const retry = requestStillInFlight || (!outcomeUnknown && run.attempts < MAX_RETRIES);
      const safeError = outcomeUnknown
        ? "Webhook outcome unknown; owner/admin reconciliation required"
        : requestStillInFlight
          ? "Webhook request still in flight; waiting before reconciliation"
          : String(error.message || error).slice(0, 1000);
      // Failure reporting is fenced too: stale executors must not requeue or
      // fail a workflow that a newer executor already owns.
      await dbPool.query(
        `UPDATE automation_runs
         SET status = $3,
             next_run_at = CASE
               WHEN $3 = 'queued'
               THEN NOW() + (LEAST(300, POWER(2, GREATEST(attempts - 1, 0)) * 2) * INTERVAL '1 second')
               ELSE NULL
             END,
             last_error = $4,
             updated_at = NOW(),
             executor_token = NULL,
             executor_lease_until = NULL
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'running'
           AND executor_token = $5
           AND executor_lease_until > NOW()
         RETURNING id`,
        [
          run.tenant_id,
          run.id,
          retry ? "queued" : "failed",
          safeError,
          run.executor_token,
        ],
      );
    }
  }

  return runs.length;
}
