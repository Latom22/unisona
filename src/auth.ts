import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config.js";

const issuer = `${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;

// Legacy projects sign with a shared HS256 secret; newer ones use asymmetric
// signing keys published at the JWKS endpoint.
const secret = config.SUPABASE_JWT_SECRET ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET) : null;
const jwks = secret ? null : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

export class AuthError extends Error {}

/** Verify a Supabase access token and return the user id (sub). */
export async function verifySupabaseToken(token: string): Promise<{ userId: string; payload: JWTPayload }> {
  try {
    const opts = { issuer, audience: "authenticated" };
    const { payload } = secret ? await jwtVerify(token, secret, opts) : await jwtVerify(token, jwks!, opts);
    if (!payload.sub) throw new AuthError("token has no subject");
    return { userId: payload.sub, payload };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(err instanceof Error ? err.message : "invalid token");
  }
}
