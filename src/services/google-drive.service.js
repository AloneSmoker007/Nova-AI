import crypto from "node:crypto";
import { dbPool } from "../config/database.js";
import { decryptSecret, encryptSecret } from "./secrets.service.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

function cfg() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Google Drive OAuth is not configured");
  return { clientId, clientSecret, redirectUri };
}
function stateSecret() {
  const value = process.env.GOOGLE_OAUTH_STATE_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("GOOGLE_OAUTH_STATE_SECRET must be at least 32 characters");
  return value;
}
function makeState(value) {
  const payload = Buffer.from(JSON.stringify({ ...value, exp: Date.now() + 600000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return payload + "." + sig;
}
function readState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 2) throw new Error("Invalid OAuth state");
  const expected = crypto.createHmac("sha256", stateSecret()).update(parts[0]).digest("base64url");
  if (parts[1].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) throw new Error("Invalid OAuth state");
  const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (!value.exp || Date.now() > value.exp) throw new Error("Expired OAuth state");
  return value;
}
async function token(body) {
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const data = await response.json();
  if (!response.ok) throw new Error("Google token exchange failed");
  return data;
}
export function buildGoogleDriveAuthorizationUrl({ tenantId, userId }) {
  const { clientId, redirectUri } = cfg();
  const state = makeState({ tenantId, userId, nonce: crypto.randomUUID() });
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", access_type: "offline", prompt: "consent", scope: SCOPE, state });
  return AUTH_URL + "?" + params.toString();
}
export async function completeGoogleDriveAuthorization(code, state) {
  const { tenantId, userId } = readState(state);
  if (!code) throw new Error("Authorization code missing");
  const { clientId, clientSecret, redirectUri } = cfg();
  const data = await token({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!data.refresh_token) throw new Error("Google did not return a refresh token");
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: "Bearer " + data.access_token } });
  const profile = await profileResponse.json();
  if (!profileResponse.ok || !profile.sub) throw new Error("Unable to verify Google account");
  await dbPool.query("INSERT INTO tenant_google_drive_connections (tenant_id,google_subject,google_email,refresh_token_encrypted,connected_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id) DO UPDATE SET google_subject=EXCLUDED.google_subject,google_email=EXCLUDED.google_email,refresh_token_encrypted=EXCLUDED.refresh_token_encrypted,connected_by=EXCLUDED.connected_by,updated_at=NOW()", [tenantId, profile.sub, profile.email || null, encryptSecret(data.refresh_token), userId]);
  return { tenantId, email: profile.email || null };
}
async function accessToken(tenantId) {
  const result = await dbPool.query("SELECT refresh_token_encrypted FROM tenant_google_drive_connections WHERE tenant_id=$1", [tenantId]);
  if (!result.rows[0]) throw new Error("Google Drive is not connected");
  const { clientId, clientSecret } = cfg();
  return (await token({ client_id: clientId, client_secret: clientSecret, refresh_token: decryptSecret(result.rows[0].refresh_token_encrypted), grant_type: "refresh_token" })).access_token;
}
async function driveRequest(tenantId, url, options) {
  const headers = new Headers(options?.headers || {});
  headers.set("authorization", "Bearer " + await accessToken(tenantId));
  return fetch(url, { ...options, headers });
}
export async function ensureBackupFolder(tenantId) {
  const result = await dbPool.query("SELECT drive_folder_id FROM tenant_google_drive_connections WHERE tenant_id=$1", [tenantId]);
  if (result.rows[0]?.drive_folder_id) return result.rows[0].drive_folder_id;
  const response = await driveRequest(tenantId, DRIVE_URL + "/files?fields=id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nova-AI Backups", mimeType: "application/vnd.google-apps.folder" }) });
  const data = await response.json();
  if (!response.ok || !data.id) throw new Error("Google Drive folder creation failed");
  await dbPool.query("UPDATE tenant_google_drive_connections SET drive_folder_id=$2,updated_at=NOW() WHERE tenant_id=$1", [tenantId, data.id]);
  return data.id;
}
export async function uploadBackup(tenantId, filename, content, sha256) {
  const folderId = await ensureBackupFolder(tenantId);
  const boundary = "nova_" + crypto.randomUUID();
  const metadata = JSON.stringify({ name: filename, parents: [folderId], description: "Nova-AI encrypted tenant backup SHA-256 " + sha256 });
  const head = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n--" + boundary + "\r\nContent-Type: application/octet-stream\r\n\r\n";
  const tail = "\r\n--" + boundary + "--";
  const body = Buffer.concat([Buffer.from(head), content, Buffer.from(tail)]);
  const response = await driveRequest(tenantId, UPLOAD_URL + "?uploadType=multipart&fields=id,name,size", { method: "POST", headers: { "content-type": "multipart/related; boundary=" + boundary }, body });
  const data = await response.json();
  if (!response.ok || !data.id) throw new Error("Google Drive backup upload failed");
  return { folderId, fileId: data.id, size: Number(data.size || content.length) };
}
export async function getDriveConnection(tenantId) {
  const result = await dbPool.query("SELECT google_email,drive_folder_id,connected_at,updated_at FROM tenant_google_drive_connections WHERE tenant_id=$1", [tenantId]);
  return result.rows[0] || null;
}