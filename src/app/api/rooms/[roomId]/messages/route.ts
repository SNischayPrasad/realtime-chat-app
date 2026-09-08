import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from '@/lib/config';
import {
  asString,
  clampLimit,
  jsonError,
  readJson,
  unauthorized,
  validateMessageBody,
} from '@/lib/http';
import { loadRoomFor } from '@/lib/rooms';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/rooms/:roomId/messages
 *
 * Query params:
 *   after - only return messages with an id greater than this cursor
 *   limit - page size (default 50, max 200)
 *
 * Without `after` the newest page is returned in chronological order, which is
 * what the UI needs to paint history on first load.
 */
export async function GET(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { roomId } = await context.params;
  const url = new URL(request.url);
  const after = url.searchParams.get('after');
  const limit = clampLimit(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);

  try {
    const store = getStore();
    // Authorization and lookup in one step: a DM the caller is not part of
    // returns null and 404s exactly like a room that does not exist.
    const room = await loadRoomFor(user, roomId);
    if (!room) return jsonError(404, 'Room not found');

    const messages = await store.listMessages({
      roomId: room.id,
      afterId: after ?? undefined,
      limit,
    });

    return NextResponse.json({
      room,
      messages,
      cursor: messages.length ? messages[messages.length - 1].id : (after ?? '0'),
    });
  } catch (error) {
    console.error('[messages:GET]', error);
    return jsonError(500, 'Could not load messages');
  }
}

/**
 * POST /api/rooms/:roomId/messages
 *
 * Body: { body: string, clientNonce?: string }
 *
 * `clientNonce` makes the write idempotent: a retried request (double submit,
 * flaky network) resolves to the same stored message instead of a duplicate.
 * The new message reaches every other participant over the SSE stream.
 */
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { roomId } = await context.params;
  const payload = await readJson(request);
  if (!payload) return jsonError(400, 'Expected a JSON body');

  const body = validateMessageBody(payload.body);
  if (!body.ok) return jsonError(400, body.error, body.field);

  const clientNonce = asString(payload.clientNonce).slice(0, 64) || null;

  try {
    const store = getStore();
    const room = await loadRoomFor(user, roomId);
    if (!room) return jsonError(404, 'Room not found');

    const message = await store.createMessage({
      roomId: room.id,
      userId: user.id,
      body: body.value,
      clientNonce,
    });

    // Sending implies presence, and it clears any lingering typing indicator.
    await Promise.all([
      store.touchPresence(room.id, user.id),
      store.setTyping(room.id, user.id, false),
    ]);

    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    console.error('[messages:POST]', error);
    return jsonError(500, 'Could not send the message');
  }
}
