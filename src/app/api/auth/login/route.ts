import { NextResponse } from 'next/server';
import { createSessionToken, sessionCookieOptions, verifyPassword } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/config';
import { asString, jsonError, readJson } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/login - exchange credentials for a session cookie. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const username = asString(body.username).trim();
  const password = asString(body.password);
  if (!username || !password) {
    return jsonError(400, 'Username and password are required');
  }

  try {
    const record = await getStore().findUserByUsername(username);
    // Same response for "no such user" and "wrong password" so the endpoint
    // cannot be used to enumerate registered usernames.
    if (!record || !(await verifyPassword(password, record.passwordHash))) {
      return jsonError(401, 'Incorrect username or password');
    }

    const { passwordHash: _ignored, ...user } = record;
    const response = NextResponse.json({ user });
    response.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);
    return response;
  } catch (error) {
    console.error('[auth/login]', error);
    return jsonError(500, 'Could not sign you in, please try again');
  }
}
