import { dbPool } from "../config/database.js";

function tenantId(value){if(typeof value!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new Error("Invalid tenant");return value}
function days(value){const n=Number.parseInt(value,10);return Number.isInteger(n)?Math.min(Math.max(n,7),90):30}

export async function getAnalytics(tenant, {days:range=30}={}) {
 const t=tenantId(tenant), d=days(range);
 const start=new Date(Date.now()-d*86400000);
 const [summary,trend]=await Promise.all([
  dbPool.query(`SELECT
   (SELECT COUNT(*) FROM conversations WHERE tenant_id=$1 AND created_at >= $2)::int AS conversations,
   (SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='inbound' AND created_at >= $2)::int AS inbound_messages,
   (SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='outbound' AND created_at >= $2)::int AS outbound_messages,
   (SELECT COALESCE(SUM(units),0) FROM usage_events WHERE tenant_id=$1 AND event_type IN ('ai_message','copilot_draft','ocr_document','assistant_query') AND created_at >= $2)::int AS ai_usage,
   (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND status IN ('pending','confirmed') AND starts_at >= $2)::int AS appointments,
   (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND status='completed' AND starts_at >= $2)::int AS completed_appointments,
   (SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE tenant_id=$1 AND status='paid' AND created_at >= $2)::bigint AS revenue_minor`,[t,start]),
  dbPool.query(`WITH days AS (
   SELECT generate_series(date_trunc('day',$2::timestamptz),date_trunc('day',NOW()),interval '1 day') AS day
  ), counts AS (
   SELECT date_trunc('day',created_at) day,
     COUNT(*) FILTER (WHERE direction='inbound')::int inbound,
     COUNT(*) FILTER (WHERE direction='outbound')::int outbound
   FROM messages WHERE tenant_id=$1 AND created_at >= $2 GROUP BY 1
  )
  SELECT to_char(days.day,'YYYY-MM-DD') AS day,COALESCE(counts.inbound,0)::int inbound,COALESCE(counts.outbound,0)::int outbound
  FROM days LEFT JOIN counts USING(day) ORDER BY days.day`,[t,start])
 ]);
 const r=summary.rows[0];
 return {rangeDays:d,start,summary:{conversations:Number(r.conversations),inboundMessages:Number(r.inbound_messages),outboundMessages:Number(r.outbound_messages),aiUsage:Number(r.ai_usage),appointments:Number(r.appointments),completedAppointments:Number(r.completed_appointments),revenueMinor:Number(r.revenue_minor)},trend:trend.rows.map(x=>({day:x.day,inbound:Number(x.inbound),outbound:Number(x.outbound)}))};
}
