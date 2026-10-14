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
          last_message_at = GREATEST(
            conversations.last_message_at,
            EXCLUDED.last_message_at
          ),
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
      // Resolve the canonical inbound row from the uniqueness conflict. Durable
      // retries need its message ID to repair signal/quota state idempotently;
      // never return IDs from tentative contact/conversation upserts above.
      const existingResult = await client.query(
        `SELECT
           m.id AS message_id,
           m.conversation_id,
           m.direction,
           m.message_type,
           m."text" AS body,
           c.contact_id,
           c.whatsapp_number_id,
           contact.wa_id
         FROM messages AS m
         JOIN conversations AS c
           ON c.tenant_id = m.tenant_id
          AND c.id = m.conversation_id
         JOIN contacts AS contact
           ON contact.tenant_id = c.tenant_id
          AND contact.id = c.contact_id
         WHERE m.tenant_id = $1
           AND m.whatsapp_message_id = $2
         LIMIT 1`,
        [tenantId, whatsappMessageId],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        throw new Error("Duplicate inbound message could not be resolved");
      }

      const identityConflict =
        existing.direction !== "inbound" ||
        existing.whatsapp_number_id !== whatsappNumberId ||
        existing.wa_id !== waId ||
        existing.message_type !== messageType ||
        existing.body !== body.slice(0, 4096);

      // Discard contact/conversation changes attempted by this duplicate, so a
      // reused provider ID cannot persist a new sender or attach it to history.
      await client.query("ROLLBACK");
      return {
        duplicate: true,
        identityConflict,
        conversationId: existing.conversation_id,
        contactId: existing.contact_id,
        messageId: existing.message_id,
      };
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
      if (deliveryState === "DELIVERED") messageStatus = "delivered";
      if (deliveryState === "READ") messageStatus = "read";
      if (deliveryState === "FAILED") messageStatus = "failed";
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
        SET last_message_at = GREATEST(conversations.last_message_at, $2),
            updated_at = NOW()
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

async function purgeDeletedMessageAiArtifacts(client, tenantId, contactId, conversationId, messageId) {
  // Memory rows from older releases lack provenance. On deletion, clear those
  // legacy inferred rows for this contact as well; new memory is source-linked.
  await client.query(
    `DELETE FROM contact_ai_memory
     WHERE tenant_id=$1 AND contact_id=$2
       AND (source_message_id=$3 OR (source='conversation' AND source_message_id IS NULL))`,
    [tenantId, contactId, messageId],
  );
  await client.query(
    "DELETE FROM conversation_ai_signals WHERE tenant_id=$1 AND message_id=$2",
    [tenantId, messageId],
  );
  // Summaries/drafts may combine multiple turns, so invalidate conversation
  // artifacts rather than risk resurfacing any content from the deleted turn.
  await client.query(
    "DELETE FROM conversation_ai_summaries WHERE tenant_id=$1 AND conversation_id=$2",
    [tenantId, conversationId],
  );
  await client.query(
    "DELETE FROM ai_copilot_drafts WHERE tenant_id=$1 AND conversation_id=$2",
    [tenantId, conversationId],
  );
}

export async function isInboundMessageDeleted(tenantId, messageId) {
  assertDatabase();
  if (!tenantId || !messageId) throw new Error("Missing message deletion identifiers");
  const result = await dbPool.query(
    "SELECT deleted_at FROM messages WHERE tenant_id=$1 AND id=$2",
    [tenantId, messageId],
  );
  return !result.rows[0] || Boolean(result.rows[0].deleted_at);
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
