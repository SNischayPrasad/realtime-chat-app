import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, SESSION_SECRET, SESSION_TTL_MS } from './config';
import { getStore } from './store';
import type { PublicUser } from './types';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/* -------------------------------------------------------------------------- */
/* Password hashing                                                           */
/* -------------------------------------------------------------------------- */

/** Produces `scrypt$<salt-hex>$<hash-hex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return timingSafeEqual(derived, expected);
}

/* -------------------------------------------------------------------------- */
/* Session tokens                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `tv` is the account's token version at issue time. Bumping `users.token_version`
 * invalidates every outstanding cookie for that account on its next request -
 * the only way to revoke what is otherwise a stateless, self-validating token.
 * Cookies minted before this field existed carry no `tv` and read as 0, which
 * matches the column default, so existing sessions survive the upgrade.
 */
type SessionPayload = { uid: string; exp: number; tv?: number };

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sign(payload: string): string {
  return base64url(createHmac('sha256', SESSION_SECRET).update(payload).digest());
}

/** `<base64url(json)>.<base64url(hmac)>` - a minimal signed cookie, no deps. */
export function createSessionToken(userId: string, tokenVersion = 0): string {
  const payload: SessionPayload = {
    uid: userId,
    exp: Date.now() + SESSION_TTL_MS,
    tv: tokenVersion,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  // Length check first: timingSafeEqual throws on mismatched buffer sizes.
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as SessionPayload;
    if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.tv !== undefined && typeof payload.tv !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

/* -------------------------------------------------------------------------- */
/* Request helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Looks the user up and rejects a cookie whose token version was revoked. */
async function resolveSession(payload: SessionPayload | null): Promise<PublicUser | null> {
  if (!payload) return null;
  const session = await getStore().findSessionUser(payload.uid);
  if (!session) return null;
  if ((payload.tv ?? 0) !== session.tokenVersion) return null;
  return session.user;
}

/** Resolves the signed-in user from the request cookies, or null. */
export async function getCurrentUser(): Promise<PublicUser | null> {
  const cookieStore = await cookies();
  return resolveSession(readSessionToken(cookieStore.get(SESSION_COOKIE)?.value));
}

/** Same as {@link getCurrentUser} but reads the cookie off a `Request`. */
export async function getUserFromRequest(request: Request): Promise<PublicUser | null> {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  return resolveSession(
    readSessionToken(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1))),
  );
}
