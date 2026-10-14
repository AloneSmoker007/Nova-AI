import { randomUUID } from "node:crypto";
import { dbPool } from "../config/database.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function validTenant(value) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid tenant"); return value; }
function text(value, max) { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid value"); return value.trim(); }
function timezone(value) {
  const zone = text(value || "UTC", 64);
  // The runtime's IANA timezone database is the source of truth. Do not require
  // exactly one slash: valid identifiers such as America/Argentina/Buenos_Aires
  // and America/Indiana/Indianapolis contain multiple path segments.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
  } catch {
    throw new Error("Invalid timezone");
  }
  return zone;
}

export function validateAppointmentTimezone(value) {
  return timezone(value);
}
function date(value) { if (typeof value !== "string" || !ISO.test(value)) throw new Error("Invalid appointment time"); const d = new Date(value); if (Number.isNaN(d.getTime())) throw new Error("Invalid appointment time"); return d; }
function int(value,min,max) { if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid duration"); return value; }

export async function createAppointmentType({ tenantId, name, description=null, durationMinutes, bufferMinutes=0, timezone: zone="UTC" }) {
  tenantId=validTenant(tenantId); name=text(name,120); durationMinutes=int(durationMinutes,5,1440); bufferMinutes=int(bufferMinutes,0,1440); zone=timezone(zone);
  const r=await dbPool.query("INSERT INTO appointment_types (tenant_id,name,description,duration_minutes,buffer_minutes,timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",[tenantId,name,typeof description==="string"?description.slice(0,2000):null,durationMinutes,bufferMinutes,zone]);
  return r.rows[0];
}
export async function listAppointmentTypes(tenantId) { tenantId=validTenant(tenantId); const r=await dbPool.query("SELECT * FROM appointment_types WHERE tenant_id=$1 AND active=true ORDER BY name",[tenantId]); return r.rows; }

export function validateBusinessHourRange(startTime, endTime) {
  const validStart =
    typeof startTime === "string" &&
    /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(startTime);
  const validEnd =
    typeof endTime === "string" &&
    (/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(endTime) || endTime === "24:00");

  if (!validStart || !validEnd || startTime >= endTime) {
    throw new Error("Invalid business hours");
  }
  return true;
}

export async function setBusinessHours(tenantId,hours) {
  tenantId=validTenant(tenantId); if(!Array.isArray(hours)||hours.length>14) throw new Error("Invalid business hours");
  const c=await dbPool.connect(); try { await c.query("BEGIN"); await c.query("DELETE FROM business_hours WHERE tenant_id=$1",[tenantId]);
    for(const h of hours){
      if(!Number.isInteger(h?.weekday)||h.weekday<0||h.weekday>6) throw new Error("Invalid business hours");
      validateBusinessHourRange(h.startTime, h.endTime);
      await c.query("INSERT INTO business_hours (tenant_id,weekday,start_time,end_time,timezone) VALUES ($1,$2,$3,$4,$5)",[tenantId,h.weekday,h.startTime,h.endTime,timezone(h.timezone||"UTC")]);
    }
    await c.query("COMMIT"); return getBusinessHours(tenantId); } catch(e){ await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
export async function getBusinessHours(tenantId) { tenantId=validTenant(tenantId); const r=await dbPool.query("SELECT * FROM business_hours WHERE tenant_id=$1 AND active=true ORDER BY weekday,start_time",[tenantId]); return r.rows; }

export async function listAppointments(tenantId,{from,to,status,contactId}={}) {
  tenantId=validTenant(tenantId); const p=[tenantId], w=["tenant_id=$1"];
  if(from){p.push(date(from));w.push("starts_at >= $"+p.length);} if(to){p.push(date(to));w.push("starts_at < $"+p.length);} if(status){p.push(text(status,20));w.push("status = $"+p.length);} if(contactId){p.push(text(contactId,64));w.push("contact_id = $"+p.length);}
  const r=await dbPool.query("SELECT * FROM appointments WHERE "+w.join(" AND ")+" ORDER BY starts_at LIMIT 500",p); return r.rows;
}
export async function getAppointment(tenantId,id){ tenantId=validTenant(tenantId); const r=await dbPool.query("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2",[tenantId,text(id,64)]); return r.rows[0]||null; }

export async function bookAppointment({tenantId,appointmentTypeId,startsAt,customerName,customerPhone,customerEmail=null,contactId=null,conversationId=null,notes=null,createdBy=null,timezone:zone="UTC"}) {
  tenantId=validTenant(tenantId); appointmentTypeId=text(appointmentTypeId,64); const start=date(startsAt); zone=timezone(zone); customerName=text(customerName,160); customerPhone=text(customerPhone,32);
  if(!/^\+?[0-9][0-9 .()-]{6,30}$/.test(customerPhone)) throw new Error("Invalid customer phone");
  if(customerEmail!==null&& (typeof customerEmail!=="string"||customerEmail.length>320)) throw new Error("Invalid customer email");
  const c=await dbPool.connect(); try { await c.query("BEGIN");
    const type=await c.query("SELECT duration_minutes, buffer_minutes FROM appointment_types WHERE tenant_id=$1 AND id=$2 AND active=true FOR SHARE",[tenantId,appointmentTypeId]); if(!type.rows[0]) throw new Error("Appointment type not found");
    const end=new Date(start.getTime()+type.rows[0].duration_minutes*60000); const bufferMinutes=type.rows[0].buffer_minutes; const occupiedEnd=new Date(end.getTime()+bufferMinutes*60000); if(start<=new Date()) throw new Error("Appointment must be in the future");
    const hours=await c.query("SELECT 1 FROM business_hours WHERE tenant_id=$1 AND active=true LIMIT 1",[tenantId]);
    if(hours.rowCount){ const open=await c.query("SELECT 1 FROM business_hours WHERE tenant_id=$1 AND active=true AND weekday=EXTRACT(DOW FROM ($2 AT TIME ZONE timezone))::int AND start_time <= (($2 AT TIME ZONE timezone)::time) AND end_time >= (($3 AT TIME ZONE timezone)::time) LIMIT 1",[tenantId,start,occupiedEnd]); if(!open.rowCount) throw new Error("Appointment is outside business hours"); }
    const r=await c.query("INSERT INTO appointments (tenant_id,appointment_type_id,contact_id,conversation_id,customer_name,customer_phone,customer_email,starts_at,ends_at,buffer_minutes,timezone,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",[tenantId,appointmentTypeId,contactId,conversationId,customerName,customerPhone,customerEmail,start,end,bufferMinutes,zone,typeof notes==="string"?notes.slice(0,4000):null,createdBy]);
    await c.query("COMMIT"); return r.rows[0];
  } catch (error) {
    const originalError = await rollbackPreservingError(c, error);
    if (originalError.code === "23P01") throw new Error("Appointment time is already booked");
    throw originalError;
  } finally { c.release(); }
}

export async function rollbackPreservingError(client, originalError) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Never replace the original database/booking failure with a rollback error.
  }
  return originalError;
}
export async function updateAppointmentStatus(tenantId, id, status) {
  tenantId = validTenant(tenantId);
  id = text(id, 64);
  if (!["pending", "confirmed", "cancelled", "completed", "no_show"].includes(status)) {
    throw new Error("Invalid appointment status");
  }

  // Lock the row before checking the transition so concurrent requests cannot
  // both make decisions from the same stale status.
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      "SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("COMMIT");
      return null;
    }

    // Treat repeated requests for the current status as idempotent, but never
    // allow completed/cancelled/no-show appointments to become active again.
    if (current.status === status) {
      await client.query("COMMIT");
      return current;
    }

    const allowedTransitions = {
      pending: ["confirmed", "cancelled"],
      confirmed: ["completed", "cancelled", "no_show"],
    };
    if (!allowedTransitions[current.status]?.includes(status)) {
      throw new Error(`Invalid appointment status transition: ${current.status} -> ${status}`);
    }

    const updated = await client.query(
      "UPDATE appointments SET status=$3,updated_at=NOW() WHERE tenant_id=$1 AND id=$2 AND status=$4 RETURNING *",
      [tenantId, id, status, current.status],
    );
    if (!updated.rows[0]) {
      throw new Error("Invalid appointment status transition: status changed concurrently; reload and retry");
    }
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    const originalError = await rollbackPreservingError(client, error);
    if (originalError.code === "23P01") throw new Error("Appointment time is already booked");
    throw originalError;
  } finally {
    client.release();
  }
}

function utc(d){return d.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");}
function esc(v){return String(v).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r\n|\r|\n/g,"\\n");}
export function buildCalendarLinks(a){const s=new Date(a.starts_at),e=new Date(a.ends_at),title=encodeURIComponent(a.title||"Appointment"),details=encodeURIComponent(a.notes||"");return {google:"https://calendar.google.com/calendar/render?action=TEMPLATE&text="+title+"&dates="+utc(s)+"/"+utc(e)+"&details="+details,outlook:"https://outlook.live.com/calendar/0/deeplink/compose?subject="+title+"&startdt="+encodeURIComponent(s.toISOString())+"&enddt="+encodeURIComponent(e.toISOString())+"&body="+details};}
export function buildIcs(a){return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Nova-AI//Appointments//EN","BEGIN:VEVENT","UID:"+(a.id||randomUUID())+"@nova-ai","DTSTAMP:"+utc(new Date()),"DTSTART:"+utc(new Date(a.starts_at)),"DTEND:"+utc(new Date(a.ends_at)),"SUMMARY:"+esc(a.title||"Appointment"),"DESCRIPTION:"+esc(a.notes||""),"END:VEVENT","END:VCALENDAR",""].join("\r\n");}