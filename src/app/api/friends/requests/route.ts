import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { asString, jsonError, readJson, unauthorized } from '@/lib/http';
import { checkRateLimit, LIMITS } from '@/lib/ratelimit';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/friends/requests - send a friend request.
 *
 * Body: { username } or { userId }
 *
 * If they already asked you, this accepts instead of creating a second request.
 * Unknown and blocked-in-either-direction both return the same 404, so the
 * endpoint cannot be used to discover who has blocked you.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const allowed = await checkRateLimit(
    `friendreq:${user.id}`,
    LIMITS.friendRequestPerUser.limit,
    LIMITS.friendRequestPerUser.windowSeconds,
  );
  if (!allowed) return jsonError(429, 'Too many friend requests. Try again later.');

  const store = getStore();
  const userId = asString(body.userId).trim();
  const username = asString(body.username).trim().replace(/^@/, '');
  const target = userId
    ? await store.findUserById(userId)
    : username
      ? await store.findUserByUsername(username)
      : null;
  if (!target) return jsonError(404, 'No such person');

  const person = {
    id: target.id,
    username: target.username,
    displayName: target.displayName,
    avatarHue: target.avatarHue,
    createdAt: target.createdAt,
  };

  try {
    const outcome = await getSocial().request(user.id, target.id);
    switch (outcome) {
      case 'pending':
        return NextResponse.json({ status: 'pending', user: person }, { status: 201 });
      case 'accepted':
      case 'already-friends':
        return NextResponse.json({ status: 'accepted', user: person });
      case 'already-sent':
        return jsonError(409, 'You already sent them a request');
      case 'cooldown':
        return jsonError(429, "You can't send this person another request yet");
      case 'limit':
        return jsonError(429, 'You have too many requests waiting. Cancel some first.');
      case 'self':
        return jsonError(400, "You can't add yourself");
      case 'blocked':
      default:
        return jsonError(404, 'No such person');
    }
  } catch (error) {
    console.error('[friends/requests:POST]', error);
    return jsonError(500, 'Could not send the request');
  }
}
