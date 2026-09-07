import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, readJson, unauthorized } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/rooms/:roomId/typing - publish a typing signal for this user.
 * Body: { typing: boolean }. The signal expires on its own after TYPING_TTL_MS,
 * so a client that disconnects mid-sentence cannot leave a stuck indicator.
 */
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { roomId } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  try {
    const store = getStore();
    const room = await store.findRoom(roomId);
    if (!room) return jsonError(404, 'Room not found');

    await store.setTyping(room.id, user.id, body.typing === true);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[typing:POST]', error);
    return jsonError(500, 'Could not update typing state');
  }
}
