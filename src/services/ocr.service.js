import { GoogleGenAI } from "@google/genai";
import { dbPool } from "../config/database.js";
import { logger } from "../config/logger.js";
import { getGeminiModel } from "../config/gemini-model.js";
import { commitAiUsage, releaseAiUsage, reserveAiUsage } from "./usage.service.js";

const MAX_TEXT = 20_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const OCR_REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MODEL = getGeminiModel();

let client;
function getClient() {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini service is not configured correctly");
  client = new GoogleGenAI({ apiKey });
  return client;
}

function hasValidMagicBytes(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;

  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "application/pdf") {
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }

  return false;
}

function tenant(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid tenant");
  }
  return value;
}

export async function extractTextFromDocument({ tenantId, buffer, mimeType, filename, createdBy = null }) {
  const t = tenant(tenantId);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new Error("Invalid document size");
  if (!ALLOWED.has(mimeType)) throw new Error("Unsupported document type");
  if (!hasValidMagicBytes(buffer, mimeType)) throw new Error("Document content does not match MIME type");
  if (typeof filename !== "string" || !filename.trim() || filename.length > 255) throw new Error("Invalid filename");

  // OCR extractions are billable Gemini operations: reserve quota from the
  // tenant's shared monthly AI limit before any provider call. The validation
  // failures above throw before reserving, so rejected uploads consume nothing.
  const aiReservation = await reserveAiUsage({ tenantId: t, type: "ocr_document" });
  if (aiReservation.inProgress) throw new Error("OCR reservation is already active; retry later");
  if (!aiReservation.allowed) throw new Error("AI usage hard limit reached");

  let providerCallStarted = false;
  try {
    const ai = getClient();
    const base64 = buffer.toString("base64");
    let response;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), OCR_REQUEST_TIMEOUT_MS);
    try {
      // Once dispatched, a timeout/network error cannot prove Gemini did not
      // process the request. Conservatively retain the billable reservation.
      providerCallStarted = true;
      response = await ai.models.generateContent({
        model: MODEL,
        config: {
          abortSignal: timeoutController.signal,
          httpOptions: { timeout: OCR_REQUEST_TIMEOUT_MS },
        },
        contents: [{
          role: "user",
          parts: [
            { text: "Extract all readable text from this document. Preserve line breaks where useful. Do not summarize, translate, infer, or add missing text. Return only the extracted text." },
            { inlineData: { mimeType, data: base64 } },
          ],
        }],
      });
    } catch (error) {
      if (timeoutController.signal.aborted) throw new Error("OCR request timed out");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const extracted = typeof response?.text === "string" ? response.text.trim().slice(0, MAX_TEXT) : "";
    const r = await dbPool.query(
      `INSERT INTO ocr_documents (tenant_id,filename,mime_type,extracted_text,model,created_by,usage_event_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [t, filename.trim(), mimeType, extracted, MODEL, createdBy, aiReservation.eventKey],
    );
    if (aiReservation.reservationToken) {
      try {
        await commitAiUsage({
          tenantId: t,
          eventKey: aiReservation.eventKey,
          reservationToken: aiReservation.reservationToken,
          type: "ocr_document",
        });
      } catch (commitError) {
        logger.warn(
          { tenantId: t, error: commitError.message },
          "OCR result saved but reservation finalization will be reconciled",
        );
      }
    }
    return r.rows[0];
  } catch (error) {
    if (providerCallStarted) {
      // Provider spend may already have occurred even if the request timed out
      // or saving the result failed. Do not release quota and permit a retry to
      // call Gemini again for free; commit the reservation as a conservative
      // usage record. A commit failure leaves the reservation for reconciliation.
      try {
        await commitAiUsage({
          tenantId: t,
          eventKey: aiReservation.eventKey,
          reservationToken: aiReservation.reservationToken,
          type: "ocr_document",
        });
      } catch (commitError) {
        logger.warn(
          { tenantId: t, error: commitError.message },
          "OCR provider may have been charged; usage reservation remains for reconciliation",
        );
      }
    } else {
      // Failures before dispatch (for example, missing local API configuration)
      // cannot have incurred provider spend, so release the reservation.
      try {
        await releaseAiUsage({
          tenantId: t,
          eventKey: aiReservation.eventKey,
          reservationToken: aiReservation.reservationToken,
          type: "ocr_document",
        });
      } catch (releaseError) {
        logger.warn(
          { tenantId: t, error: releaseError.message },
          "Failed to release pre-provider OCR usage reservation",
        );
      }
    }
    throw error;
  }
}

export async function listOcrDocuments(tenantId, limit = 50) {
  tenant(tenantId);
  const safe = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const r = await dbPool.query("SELECT * FROM ocr_documents WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2", [tenantId, safe]);
  return r.rows;
}

export async function getOcrDocument(tenantId, id) {
  tenant(tenantId);
  const r = await dbPool.query("SELECT * FROM ocr_documents WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  return r.rows[0] || null;
}

export { MAX_IMAGE_BYTES, ALLOWED, hasValidMagicBytes };
