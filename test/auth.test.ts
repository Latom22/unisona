import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { AuthError, verifySupabaseToken } from "../src/auth.js";

const key = new TextEncoder().encode("test-secret-test-secret-test-secret");
const sign = (claims: { aud?: string; iss?: string; sub?: string }, exp = "5m") =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub ?? "user-123")
    .setAudience(claims.aud ?? "authenticated")
    .setIssuer(claims.iss ?? "https://example.supabase.co/auth/v1")
    .setExpirationTime(exp)
    .sign(key);

describe("verifySupabaseToken (HS256)", () => {
  it("accepts a valid Supabase access token", async () => {
    await expect(verifySupabaseToken(await sign({}))).resolves.toMatchObject({ userId: "user-123" });
  });
  it("rejects wrong audience, wrong issuer and expired tokens", async () => {
    await expect(verifySupabaseToken(await sign({ aud: "anon" }))).rejects.toBeInstanceOf(AuthError);
    await expect(verifySupabaseToken(await sign({ iss: "https://evil.example/auth/v1" }))).rejects.toBeInstanceOf(AuthError);
    await expect(verifySupabaseToken(await sign({}, "-1m"))).rejects.toBeInstanceOf(AuthError);
  });
});
