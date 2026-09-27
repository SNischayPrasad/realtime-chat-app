import { NextResponse } from 'next/server';
import {
  createSessionToken,
  hashPassword,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/auth';
import { LEGACY_AUTH_UNTIL, SESSION_COOKIE } from '@/lib/config';
import { AUTH_SECRET_PATTERN, asString, jsonError, parseNewKeys, readJson } from '@/lib/http';
import { checkRateLimit, clientIp, LIMITS } from '@/lib/ratelimit';
import { getStore } from '@/lib/store';
import type { PublicUser } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A precomputed scrypt hash of a random value. Checking a password against it
 * when the username does not exist costs the same as checking a real one, so
 * response time does not reveal whether an account exists.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(crypto.randomUUID());
  return decoyHash;
}

const INCORRECT = 'Incorrect username or password';

/**
 * POST /api/auth/login
 *
 * Current accounts:  { username, authSecret }
 *   The browser derives authSecret from the password; the password itself is
 *   never sent. The response includes the user's sealed key vault, which only
 *   the browser can open.
 *
 * Legacy accounts (created before encryption, until LEGACY_AUTH_UNTIL):
 *   { username, password, upgrade: { authSecret, vaultId, identityPub, vault, recovery? } }
 *   Verifies the raw password one final time and upgrades the account in the
 *   same request, so afterwards the password never reaches the server again.
 *   The upgrade is bound to password verification on purpose: a separate,
 *   session-only upgrade endpoint would let a stolen session cookie replace
 *   the account's password with one the thief chose.
 *
 *   The raw-password shape is refused for an already-upgraded account, so an
 *   upgraded account cannot be downgraded through the API.
 */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const username = asString(body.username).trim();
  if (!username) return jsonError(400, 'Username is required');

  const ipOk = await checkRateLimit(
    `login:ip:${clientIp(request)}`,
    LIMITS.loginPerIp.limit,
    LIMITS.loginPerIp.windowSeconds,
  );
  const userOk = await checkRateLimit(
    `login:user:${username.toLowerCase()}`,
    LIMITS.loginPerUser.limit,
    LIMITS.loginPerUser.windowSeconds,
  );
  if (!ipOk || !userOk) {
    return jsonError(429, 'Too many sign-in attempts. Wait a few minutes and try again.');
  }

  try {
    const store = getStore();
    const record = await store.findUserByUsername(username);

    /* ---- current accounts ---------------------------------------------- */
    if (typeof body.authSecret === 'string') {
      if (!AUTH_SECRET_PATTERN.test(body.authSecret)) return jsonError(401, INCORRECT);

      const valid =
        record !== null &&
        record.authVersion === 1 &&
        (await verifyPassword(body.authSecret, record.passwordHash));
      if (!record) await verifyPassword(body.authSecret, await decoy());

      if (!valid || !record) {
        // Tell an up-to-date client that this is a pre-encryption account, so
        // it offers the one-time upgrade instead of just "wrong password".
        // This reveals only that the username exists - which registration
        // already reveals - plus that it predates encryption.
        const legacy =
          record !== null && record.authVersion === 0 && Date.now() < LEGACY_AUTH_UNTIL;
        return NextResponse.json(legacy ? { error: INCORRECT, legacy: true } : { error: INCORRECT }, {
          status: 401,
        });
      }

      return signedIn(record, record.tokenVersion, await store.getKeyBundle(record.id));
    }

    /* ---- legacy accounts: one-time upgrade ----------------------------- */
    if (typeof body.password === 'string') {
      if (Date.now() >= LEGACY_AUTH_UNTIL) return jsonError(401, INCORRECT);

      const upgrade =
        typeof body.upgrade === 'object' && body.upgrade !== null
          ? (body.upgrade as Record<string, unknown>)
          : null;
      const authSecret = upgrade ? asString(upgrade.authSecret) : '';
      const keys = upgrade ? parseNewKeys(upgrade) : null;
      if (!upgrade || !AUTH_SECRET_PATTERN.test(authSecret) || !keys) {
        return jsonError(400, 'This page is out of date. Reload it and try again.');
      }

      const valid =
        record !== null &&
        record.authVersion === 0 &&
        (await verifyPassword(body.password, record.passwordHash));
      if (!record) await verifyPassword(body.password, await decoy());
      if (!valid || !record) return jsonError(401, INCORRECT);

      const result = await store.bootstrapKeys(record.id, await hashPassword(authSecret), keys);
      if (!result.upgraded) {
        // Another tab upgraded it first. Its vault is the real one; this client
        // must sign in again with the new flow rather than use its own keys.
        return jsonError(409, 'This account was just upgraded elsewhere. Sign in again.');
      }
      // The token version was bumped, so every older session - including any
      // legacy cookie that might have been stolen - is now signed out.
      return signedIn(record, result.tokenVersion, await store.getKeyBundle(record.id), true);
    }

    return jsonError(400, 'Username and password are required');
  } catch (error) {
    console.error('[auth/login]', error);
    return jsonError(500, 'Could not sign you in, please try again');
  }
}

function signedIn(
  record: PublicUser,
  tokenVersion: number,
  keys: Awaited<ReturnType<ReturnType<typeof getStore>['getKeyBundle']>>,
  upgraded = false,
) {
  const user: PublicUser = {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    avatarHue: record.avatarHue,
    createdAt: record.createdAt,
  };
  const response = NextResponse.json({ user, keys, upgraded });
  response.cookies.set(
    SESSION_COOKIE,
    createSessionToken(user.id, tokenVersion),
    sessionCookieOptions,
  );
  return response;
}
