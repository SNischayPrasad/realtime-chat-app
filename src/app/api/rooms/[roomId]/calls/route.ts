import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { CALL_MEDIA, getCalls } from '@/lib/calls';
import { clampLimit, jsonError, NONCE_PATTERN, readJson, unauthorized } from '@/lib/http';
import { checkRateLimit, LIMITS } from '@/lib/ratelimit';
import { counterpartOf, loadRoomFor } from '@/lib/rooms';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';
import type { CallMedia } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/rooms/:roomId/calls?limit= - call history, newest first. */
export async function GET(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { roomId } = await context.params;
  const room = await loadRoomFor(user, roomId);
  if (!room) return jsonError(404, 'Room not found');
  const limit = clampLimit(new URL(request.url).searchParams.get('limit'), 20, 100);
  return NextResponse.json({ calls: await getCalls().roomHistory(room.id, limit) });
}

/**
 * POST /api/rooms/:roomId/calls - start a voice or video call.
 *
 * Body: { media: 'audio' | 'video', clientNonce }
 *
 * Only in private conversations, only between friends, and only when both
 * people have encryption keys - the signalling that sets the call up is sealed
 * with them. The person being called is derived from room membership, never
 * taken from the request.
 *
 * 409 { reason: 'busy' }           one of you is already in a call
 * 409 { reason: 'glare', callId }  they are calling you right now - answer that
 */
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { roomId } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const media = body.media as CallMedia;
  if (!CALL_MEDIA.includes(media)) return jsonError(400, "media must be 'audio' or 'video'");
  const clientNonce =
    typeof body.clientNonce === 'string' && NONCE_PATTERN.test(body.clientNonce)
      ? body.clientNonce
      : null;

  try {
    const room = await loadRoomFor(user, roomId);
    if (!room) return jsonError(404, 'Room not found');
    if (room.kind !== 'dm') return jsonError(400, 'Calls are only available in private conversations');

    const callee = await counterpartOf(room, user.id);
    if (!callee) return jsonError(404, 'Room not found');

    const social = getSocial();
    if (
      (await social.isBlockedEitherWay(user.id, callee.id)) ||
      (await social.relation(user.id, callee.id)) !== 'friend'
    ) {
      return jsonError(403, 'You can only call friends');
    }

    const keys = await getStore().getIdentityKeys([user.id, callee.id]);
    if (!keys[callee.id]) {
      return jsonError(409, `${callee.displayName} needs to sign in again before you can call them`);
    }
    if (!keys[user.id]) return jsonError(409, 'Set up encryption before making calls');

    const allowed = await checkRateLimit(
      `call:${user.id}`,
      LIMITS.callsPerUser.limit,
      LIMITS.callsPerUser.windowSeconds,
    );
    if (!allowed) return jsonError(429, 'Too many calls. Wait a minute and try again.');

    const outcome = await getCalls().create({
      roomId: room.id,
      callerId: user.id,
      calleeId: callee.id,
      media,
      clientNonce,
    });

    if (!outcome.ok) {
      return outcome.reason === 'glare'
        ? NextResponse.json(
            { error: `${callee.displayName} is calling you`, reason: 'glare', callId: outcome.callId },
            { status: 409 },
          )
        : NextResponse.json(
            { error: 'One of you is already in a call', reason: 'busy' },
            { status: 409 },
          );
    }

    return NextResponse.json({ call: outcome.call }, { status: outcome.created ? 201 : 200 });
  } catch (error) {
    console.error('[calls:POST]', error);
    return jsonError(500, 'Could not start the call');
  }
}
