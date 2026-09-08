import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { asString, jsonError, readJson, unauthorized } from '@/lib/http';
import { loadRoomFor } from '@/lib/rooms';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/rooms/:roomId/read
 *
 * Records how far the caller has read. Body: { lastReadId }.
 * The store applies GREATEST(), so an out-of-order request can never un-read a
 * conversation. Read state lives server-side rather than in localStorage so the
 * unread badge tells the truth across devices.
 */
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { roomId } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const lastReadId = asString(body.lastReadId).trim();
  if (!/^\d{1,19}$/.test(lastReadId)) {
    return jsonError(400, 'lastReadId must be a message id', 'lastReadId');
  }

  try {
    const room = await loadRoomFor(user, roomId);
    if (!room) return jsonError(404, 'Room not found');

    await getStore().markRead(room.id, user.id, lastReadId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[read:POST]', error);
    return jsonError(500, 'Could not update read state');
  }
}
