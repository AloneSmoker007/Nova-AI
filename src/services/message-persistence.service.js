import { dbPool, isDatabaseConfigured } from "../config/database.js";

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }
}

function normalizeProfileName(profileName) {
  if (typeof profileName !== "string") return null;
  const value = profileName.trim();
  return value ? value.slice(0, 255) : null;
}

export async function persistInboundMessage({
  tenantId,
  whatsappNumberId,
  waId,
  profileName,
  whatsappMessageId,
  messageType = "text",
  body,
  receivedAt = new Date(),
}) {
  assertDatabase();

  if (!tenantId || !whatsappNumberId || !waId || !whatsappMessageId) {
    throw new Error("Missing required inbound message identifiers");
  }

  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Inbound message body is invalid");
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const contactResult = await client.query(
      `
        INSERT INTO contacts (tenant_id, wa_id, profile_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, wa_id)
        DO UPDATE SET
          profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
          updated_at = NOW()
        RETURNING id
      `,
      [tenantId, waId, normalizeProfileName(profileName)],
    );

    const contactId = contactResult.rows[0]?.id;
    if (!contactId) throw new Error("Failed to create or resolve contact");

    const conversationResult = await client.query(
      `
        INSERT INTO conversations (
          tenant_id,
          whatsapp_number_id,
          contact_id,
          status,
          last_message_at
        )
        VALUES ($1, $2, $3, 'open', $4)
        ON CONFLICT (whatsapp_number_id, contact_id)
        DO UPDATE SET
          status = 'open',
          last_message_at = EXCLUDED.last_message_at,
          updated_at = NOW()
        RETURNING id
      `,
      [tenantId, whatsappNumberId, contactId, receivedAt],
    );

    const conversationId = conversationResult.rows[0]?.id;
    if (!conversationId) throw new Error("Failed to create or resolve conversation");

    const messageResult = await client.query(
      `
        INSERT INTO messages (
          tenant_id,
          conversation_id,
          whatsapp_message_id,
          direction,
          message_type,
          body,
          status
        )
        VALUES ($1, $2, $3, 'inbound', $4, $5, 'received')
        ON CONFLICT (whatsapp_message_id)
        DO NOTHING
        RETURNING id
      `,
      [tenantId, conversationId, whatsappMessageId, messageType, body.slice(0, 4096)],
    );

    if (messageResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { duplicate: true, conversationId, contactId, messageId: null };
    }

    await client.query("COMMIT");

    return {
      duplicate: false,
      contactId,
      conversationId,
      messageId: messageResult.rows[0].id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function persistOutboundMessage({
  tenantId,
  conversationId,
  whatsappMessageId = null,
  messageType = "text",
  body,
  sentAt = new Date(),
}) {
  assertDatabase();

  if (!tenantId || !conversationId) {
    throw new Error("Missing required outbound message identifiers");
  }

  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Outbound message body is invalid");
  }

  const result = await dbPool.query(
    `
      INSERT INTO messages (
        tenant_id,
        conversation_id,
        whatsapp_message_id,
        direction,
        message_type,
        body,
        status,
        created_at
      )
      VALUES ($1, $2, $3, 'outbound', $4, $5, 'sent', $6)
      ON CONFLICT (whatsapp_message_id)
      DO NOTHING
      RETURNING id
    `,
    [tenantId, conversationId, whatsappMessageId, messageType, body.slice(0, 4096), sentAt],
  );

  await dbPool.query(
    `
      UPDATE conversations
      SET last_message_at = $2, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $3
    `,
    [tenantId, sentAt, conversationId],
  );

  return {
    duplicate: result.rowCount === 0,
    messageId: result.rows[0]?.id ?? null,
  };
}
