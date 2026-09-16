import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { dbPool, isDatabaseConfigured } from "../config/database.js";

const BCRYPT_ROUNDS = 12;
const JWT_ALGORITHM = "HS256";
const DEFAULT_EXPIRES_IN = "24h";

// Valid 60-character bcrypt hash at cost 12.
// Used only to keep bcrypt timing similar for unknown emails.
const DUMMY_HASH =
  "$2b$12$jI8lnHITTNny75Th8fD9RuIxIVCg09u6pZs/DHBTBWuVsV2qQ1rbW";

function getJwtConfig() {
  const secret = process.env.JWT_SECRET;
  const issuer = process.env.JWT_ISSUER || "nova-ai";
  const audience = process.env.JWT_AUDIENCE || "nova-ai-api";
  const expiresIn = process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN;

  if (!secret || typeof secret !== "string") {
    throw new Error("JWT_SECRET environment variable is required");
  }

  if (secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }

  return { secret, issuer, audience, expiresIn };
}

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function generateToken(user) {
  const config = getJwtConfig();

  const payload = {
    sub: user.id,
    tenantId: user.tenant_id,
    role: user.role,
  };

  return jwt.sign(payload, config.secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: config.expiresIn,
    issuer: config.issuer,
    audience: config.audience,
  });
}

export function verifyToken(token) {
  const config = getJwtConfig();

  return jwt.verify(token, config.secret, {
    algorithms: [JWT_ALGORITHM],
    issuer: config.issuer,
    audience: config.audience,
  });
}

/**
 * Authenticate a user by email and password.
 *
 * Authentication failures intentionally use one generic error so they do
 * not reveal whether an account exists or what its status is.
 * Database/configuration failures propagate as infrastructure errors and
 * are handled by the application error middleware as 500 responses.
 */
export async function loginUser(email, password) {
  if (
    !email ||
    typeof email !== "string" ||
    !password ||
    typeof password !== "string"
  ) {
    throw new Error("Invalid credentials");
  }

  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }

  const normalizedEmail = email.toLowerCase().trim();

  let result;
  try {
    result = await dbPool.query(
      `SELECT id, tenant_id, email, password_hash, role, status
       FROM users
       WHERE email = $1`,
      [normalizedEmail],
    );
  } catch (dbError) {
    throw dbError;
  }

  const user = result.rows[0];
  const hashToVerify = user?.password_hash || DUMMY_HASH;

  let passwordValid;
  try {
    passwordValid = await verifyPassword(password, hashToVerify);
  } catch {
    passwordValid = false;
  }

  if (!user || !passwordValid || user.status !== "active") {
    throw new Error("Invalid credentials");
  }

  const token = generateToken(user);

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
    },
  };
}

export async function getUserById(userId) {
  if (!isDatabaseConfigured() || !dbPool) {
    return null;
  }

  const result = await dbPool.query(
    `SELECT id, tenant_id, email, role, status
     FROM users
     WHERE id = $1`,
    [userId],
  );

  return result.rows[0] || null;
}
