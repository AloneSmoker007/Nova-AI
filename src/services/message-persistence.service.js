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
        INSERT INTO contacts (tenant_id, wa_id, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, wa_id)
        DO UPDATE SET
          display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
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
        VALUES ($1, $2, $3, 'active', $4)
        ON CONFLICT (whatsapp_number_id, contact_id)
        DO UPDATE SET
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
          "text",
          status
        )
        VALUES ($1, $2, $3, 'inbound', $4, $5, 'received')
        ON CONFLICT (tenant_id, whatsapp_message_id)
        DO NOTHING
        RETURNING id
      `,
      [tenantId, conversationId, whatsappMessageId, messageType, body.slice(0, 4096)],
    );

    if (messageResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { duplicate: true, conversationId, contactId, messageId: null };
    }

    await client.query(
      `UPDATE conversations
       SET unread_count = unread_count + 1, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, conversationId],
    );

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
  whatsappMessageId,
  messageType = "text",
  body,
  sentAt = new Date(),
  deliveryId = null,
}) {
  assertDatabase();

  if (!tenantId || !conversationId) {
    throw new Error("Missing required outbound message identifiers");
  }

  if (!whatsappMessageId || typeof whatsappMessageId !== "string" || !whatsappMessageId.trim()) {
    throw new Error("whatsappMessageId is required for outbound messages");
  }

  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Outbound message body is invalid");
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    let messageStatus = "sent";

    if (deliveryId) {
      const deliveryResult = await client.query(
        `
          SELECT state
          FROM whatsapp_deliveries
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1
        `,
        [deliveryId, tenantId],
      );

      const deliveryState = deliveryResult.rows[0]?.state;
      if (deliveryState === "delivered") messageStatus = "delivered";
      if (deliveryState === "read") messageStatus = "read";
      if (deliveryState === "failed") messageStatus = "failed";
    }

    const result = await client.query(
      `
        INSERT INTO messages (
          tenant_id,
          conversation_id,
          whatsapp_message_id,
          direction,
          message_type,
          "text",
          status,
          created_at
        )
        VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7)
        ON CONFLICT (tenant_id, whatsapp_message_id)
        DO NOTHING
        RETURNING id
      `,
      [
        tenantId,
        conversationId,
        whatsappMessageId,
        messageType,
        body.slice(0, 4096),
        messageStatus,
        sentAt,
      ],
    );

    if (result.rowCount === 0) {
      await client.query("COMMIT");
      return { duplicate: true, messageId: null };
    }

    await client.query(
      `
        UPDATE conversations
        SET last_message_at = $2, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $3
      `,
      [tenantId, sentAt, conversationId],
    );

    await client.query("COMMIT");

    return {
      duplicate: false,
      messageId: result.rows[0].id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function persistDeletedInboundMessage({
  tenantId,
  whatsappNumberId,
  waId,
  profileName,
  whatsappMessageId,
  deletedAt = new Date(),
}) {
  assertDatabase();

  if (!tenantId || !whatsappNumberId || !waId || !whatsappMessageId) {
    throw new Error("Missing required deleted message identifiers");
  }

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    const contactResult = await client.query(
      `INSERT INTO contacts (tenant_id, wa_id, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, wa_id)
       DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
         updated_at = NOW()
       RETURNING id`,
      [tenantId, waId, normalizeProfileName(profileName)],
    );
    const contactId = contactResult.rows[0]?.id;
    if (!contactId) throw new Error("Failed to create or resolve contact");

    const conversationResult = await client.query(
      `INSERT INTO conversations (tenant_id, whatsapp_number_id, contact_id, status, last_message_at)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (whatsapp_number_id, contact_id)
       DO UPDATE SET last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at), updated_at = NOW()
       RETURNING id`,
      [tenantId, whatsappNumberId, contactId, deletedAt],
    );
    const conversationId = conversationResult.rows[0]?.id;
    if (!conversationId) throw new Error("Failed to create or resolve conversation");

    const existing = await client.query(
      `UPDATE messages
       SET status = 'deleted', deleted_at = $4, deletion_reason = 'whatsapp_user_deleted'
       WHERE tenant_id = $1 AND whatsapp_message_id = $2 AND conversation_id = $3
       RETURNING id`,
      [tenantId, whatsappMessageId, conversationId, deletedAt],
    );

    if (existing.rowCount === 1) {
      await client.query("COMMIT");
      return { foundExisting: true, conversationId, messageId: existing.rows[0].id };
    }

    const created = await client.query(
      `INSERT INTO messages (
         tenant_id, conversation_id, whatsapp_message_id, direction, message_type,
         "text", status, deleted_at, deletion_reason
       ) VALUES ($1, $2, $3, 'inbound', 'unsupported', '[Message deleted on WhatsApp]', 'deleted', $4, 'whatsapp_user_deleted')
       ON CONFLICT (tenant_id, whatsapp_message_id)
       DO UPDATE SET status = 'deleted', deleted_at = EXCLUDED.deleted_at, deletion_reason = EXCLUDED.deletion_reason
       RETURNING id`,
      [tenantId, conversationId, whatsappMessageId, deletedAt],
    );

    await client.query(
      `UPDATE conversations SET last_message_at = GREATEST(last_message_at, $2), updated_at = NOW()
       WHERE tenant_id = $1 AND id = $3`,
      [tenantId, deletedAt, conversationId],
    );
    await client.query("COMMIT");
    return { foundExisting: false, conversationId, messageId: created.rows[0]?.id ?? null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
