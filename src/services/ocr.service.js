import { GoogleGenAI } from "@google/genai";
import { dbPool } from "../config/database.js";

const MAX_TEXT = 20_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

  const ai = getClient();
  const base64 = buffer.toString("base64");
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: "Extract all readable text from this document. Preserve line breaks where useful. Do not summarize, translate, infer, or add missing text. Return only the extracted text." },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
  });

  const extracted = typeof response?.text === "string" ? response.text.trim().slice(0, MAX_TEXT) : "";
  const r = await dbPool.query(
    `INSERT INTO ocr_documents (tenant_id,filename,mime_type,extracted_text,model,created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [t, filename.trim(), mimeType, extracted, MODEL, createdBy],
  );
  return r.rows[0];
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
