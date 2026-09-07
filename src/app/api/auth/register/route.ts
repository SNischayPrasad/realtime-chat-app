import { NextResponse } from 'next/server';
import { createSessionToken, hashPassword, sessionCookieOptions } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/config';
import {
  jsonError,
  readJson,
  validateDisplayName,
  validatePassword,
  validateUsername,
} from '@/lib/http';
import { getStore, hueFor } from '@/lib/store';
import { UsernameTakenError } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/register - create an account and start a session. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const username = validateUsername(body.username);
  if (!username.ok) return jsonError(400, username.error, username.field);

  const password = validatePassword(body.password);
  if (!password.ok) return jsonError(400, password.error, password.field);

  const displayName = validateDisplayName(body.displayName, username.value);
  if (!displayName.ok) return jsonError(400, displayName.error, displayName.field);

  try {
    const user = await getStore().createUser({
      username: username.value,
      displayName: displayName.value,
      passwordHash: await hashPassword(password.value),
      avatarHue: hueFor(username.value),
    });

    const response = NextResponse.json({ user }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);
    return response;
  } catch (error) {
    if (error instanceof UsernameTakenError) {
      return jsonError(409, 'That username is already taken', 'username');
    }
    console.error('[auth/register]', error);
    return jsonError(500, 'Could not create your account, please try again');
  }
}
