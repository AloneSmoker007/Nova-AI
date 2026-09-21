import { dbPool } from "../config/database.js";

export async function getDashboardSummary(tenantId) {
  const [messages, conversations, ai, revenue, appointments] = await Promise.all([
    dbPool.query("SELECT COUNT(*)::int AS count FROM messages WHERE tenant_id = $1", [tenantId]),
    dbPool.query("SELECT COUNT(*)::int AS count FROM conversations WHERE tenant_id = $1", [tenantId]),
    dbPool.query("SELECT COALESCE(SUM(units),0)::int AS count FROM usage_events WHERE tenant_id = $1 AND event_type IN ('ai_reply','copilot_draft','ai_generation')", [tenantId]),
    dbPool.query("SELECT COALESCE(SUM(amount_minor),0)::bigint AS total_minor FROM payments WHERE tenant_id = $1 AND status = 'paid'", [tenantId]),
    dbPool.query("SELECT COUNT(*)::int AS count FROM appointments WHERE tenant_id = $1 AND status IN ('pending','confirmed') AND starts_at >= NOW() AND starts_at < NOW() + INTERVAL '48 hours'", [tenantId]),
  ]);
  return { messages: messages.rows[0].count, conversations: conversations.rows[0].count, aiReplies: ai.rows[0].count, revenueMinor: Number(revenue.rows[0].total_minor), upcomingAppointments: appointments.rows[0].count };
}
