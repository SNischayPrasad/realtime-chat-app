import { NextResponse } from 'next/server';
import { createSessionToken, hashPassword, sessionCookieOptions } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/config';
import {
  AUTH_SECRET_PATTERN,
  jsonError,
  parseNewKeys,
  readJson,
  validateDisplayName,
  validateUsername,
} from '@/lib/http';
import { checkRateLimit, clientIp, LIMITS } from '@/lib/ratelimit';
import { getStore, hueFor } from '@/lib/store';
import { UsernameTakenError } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/register
 *
 * Body: { username, displayName?, authSecret, vaultId, identityPub, vault, recovery? }
 *
 * The password never arrives here. The browser derives two independent values
 * from it - `authSecret`, which is sent and scrypt-hashed like a password, and
 * a vault key, which never leaves the browser and seals the user's identity
 * private key into `vault`. The account and its vault are created in one
 * transaction: an account must never exist without one.
 *
 * Password strength is checked in the browser, because that is the only place
 * the password exists.
 */
export async function POST(request: Request) {
  const allowed = await checkRateLimit(
    `register:ip:${clientIp(request)}`,
    LIMITS.registerPerIp.limit,
    LIMITS.registerPerIp.windowSeconds,
  );
  if (!allowed) return jsonError(429, 'Too many sign-ups from this network. Try again later.');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const username = validateUsername(body.username);
  if (!username.ok) return jsonError(400, username.error, username.field);

  if (typeof body.authSecret !== 'string' || !AUTH_SECRET_PATTERN.test(body.authSecret)) {
    // Most likely an outdated tab still posting a raw password.
    return jsonError(400, 'This page is out of date. Reload it and try again.');
  }

  const displayName = validateDisplayName(body.displayName, username.value);
  if (!displayName.ok) return jsonError(400, displayName.error, displayName.field);

  const keys = parseNewKeys(body);
  if (!keys) return jsonError(400, 'Encryption keys were missing or malformed. Reload and try again.');

  try {
    const store = getStore();
    const user = await store.createAccount({
      username: username.value,
      displayName: displayName.value,
      passwordHash: await hashPassword(body.authSecret),
      avatarHue: hueFor(username.value),
      keys,
    });

    const response = NextResponse.json(
      { user, keys: await store.getKeyBundle(user.id) },
      { status: 201 },
    );
    response.cookies.set(SESSION_COOKIE, createSessionToken(user.id, 0), sessionCookieOptions);
    return response;
  } catch (error) {
    if (error instanceof UsernameTakenError) {
      return jsonError(409, 'That username is already taken', 'username');
    }
    console.error('[auth/register]', error);
    return jsonError(500, 'Could not create your account, please try again');
  }
}
