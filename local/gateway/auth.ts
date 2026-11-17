/**
 * NOVA Hospitality — local auth issuer (PRODUCTIZATION-3, Phases 3-4).
 *
 * Preserves the contract the application already relies on: the client sends
 * `Authorization: Bearer <jwt>`, and the data layer derives identity from the
 * token's `sub` claim through auth.uid(). Nothing in the product changes.
 *
 * Tokens are ES256: PostgREST verifies with the PUBLIC JWK only, so the
 * signing key never leaves this process — a compromised PostgREST cannot mint
 * identities.
 */
import { SQL } from "bun";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { issueAccessToken } from "../../src/modules/runtime/local/jwt.server";
import { hashPassword, verifyPassword } from "../../src/modules/runtime/local/password.server";

export interface AuthDeps {
  sql: SQL;
  privateKeyPem: string;
  kid: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  refresh_token: string;
  user: { id: string; email: string };
}

const MAX_FAILED_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

/**
 * Fixed-cost comparison target used when the email is unknown, so that a
 * failed sign-in costs the same whether or not the account exists.
 */
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("nova-local-absent-account-0000");
  return dummyHash;
}

function hashRefresh(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function mintSession(deps: AuthDeps, user: { id: string; email: string }, terminal?: string) {
  const refreshToken = randomBytes(48).toString("base64url");
  const [session] = await deps.sql`
    INSERT INTO nova_local.sessions (user_id, refresh_token_hash, expires_at, terminal_label)
    VALUES (${user.id}, ${hashRefresh(refreshToken)},
            now() + make_interval(secs => ${deps.refreshTtlSeconds}), ${terminal ?? null})
    RETURNING id`;

  const { token } = issueAccessToken({
    privateKeyPem: deps.privateKeyPem,
    kid: deps.kid,
    userId: user.id,
    email: user.email,
    sessionId: session.id,
    ttlSeconds: deps.accessTtlSeconds,
  });

  return {
    access_token: token,
    token_type: "bearer" as const,
    expires_in: deps.accessTtlSeconds,
    refresh_token: refreshToken,
    user,
  } satisfies TokenResponse;
}

export async function signInWithPassword(
  deps: AuthDeps,
  input: { email: string; password: string; terminal?: string },
): Promise<TokenResponse> {
  const email = input.email.trim().toLowerCase();
  const [credential] = await deps.sql`
    SELECT user_id, email, password_hash, failed_attempts, locked_until
      FROM nova_local.credentials WHERE email = ${email}`;

  // Same message and comparable cost for "no such user" and "wrong password":
  // the login form must not become a user-enumeration oracle.
  if (!credential) {
    await verifyPassword(input.password, await dummyPasswordHash());
    throw new AuthError("Invalid email or password", 400);
  }

  if (credential.locked_until && new Date(credential.locked_until) > new Date()) {
    throw new AuthError("Account temporarily locked after repeated failed sign-ins", 429);
  }

  const ok = await verifyPassword(input.password, credential.password_hash);
  if (!ok) {
    const attempts = Number(credential.failed_attempts ?? 0) + 1;
    await deps.sql`
      UPDATE nova_local.credentials
         SET failed_attempts = ${attempts},
             locked_until = CASE WHEN ${attempts} >= ${MAX_FAILED_ATTEMPTS}
                                 THEN now() + make_interval(mins => ${LOCK_MINUTES}) END,
             updated_at = now()
       WHERE user_id = ${credential.user_id}`;
    throw new AuthError("Invalid email or password", 400);
  }

  await deps.sql`
    UPDATE nova_local.credentials
       SET failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE user_id = ${credential.user_id}`;

  return mintSession(deps, { id: credential.user_id, email: credential.email }, input.terminal);
}

export async function refreshSession(deps: AuthDeps, refreshToken: string): Promise<TokenResponse> {
  const [session] = await deps.sql`
    SELECT s.id, s.user_id, s.revoked_at, s.expires_at, s.refresh_token_hash, s.terminal_label, c.email
      FROM nova_local.sessions s
      JOIN nova_local.credentials c ON c.user_id = s.user_id
     WHERE s.refresh_token_hash = ${hashRefresh(refreshToken)}`;

  if (!session || !constantTimeEquals(session.refresh_token_hash, hashRefresh(refreshToken))) {
    throw new AuthError("Invalid refresh token", 401);
  }
  if (session.revoked_at || new Date(session.expires_at) <= new Date()) {
    throw new AuthError("Session expired, please sign in again", 401);
  }

  // Rotation: the presented refresh token is retired as the new one is issued.
  await deps.sql`UPDATE nova_local.sessions SET revoked_at = now() WHERE id = ${session.id}`;
  return mintSession(
    deps,
    { id: session.user_id, email: session.email },
    session.terminal_label ?? undefined,
  );
}

export async function signOut(deps: AuthDeps, refreshToken: string): Promise<void> {
  await deps.sql`
    UPDATE nova_local.sessions SET revoked_at = now()
     WHERE refresh_token_hash = ${hashRefresh(refreshToken)} AND revoked_at IS NULL`;
}