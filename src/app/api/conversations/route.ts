import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { asString, jsonError, readJson, unauthorized } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/conversations
 *
 * The caller's private conversations, newest activity first. Scoped by
 * construction: the query starts from the caller's membership rows and takes
 * no room id from the request, so there is nothing here to tamper with.
 *
 * Message previews are truncated server-side so a long private message is not
 * shipped wholesale into a list payload.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  try {
    const conversations = await getStore().listConversations(user.id);
    return NextResponse.json({ conversations });
  } catch (error) {
    console.error('[conversations:GET]', error);
    return jsonError(500, 'Could not load your conversations');
  }
}

/**
 * POST /api/conversations
 *
 * Find or create the private conversation between the caller and one other
 * user. Body: { userId } or { username }.
 *
 * Deliberately idempotent: the caller's intent is "open a conversation with
 * this person", so sending it twice is a no-op rather than a conflict. Two
 * people starting one simultaneously converge on a single room via the unique
 * index on `rooms.dm_key`.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const userId = asString(body.userId).trim();
  const username = asString(body.username).trim();
  if (!userId && !username) {
    return jsonError(400, 'Provide the person you want to message', 'userId');
  }

  try {
    const store = getStore();
    const target = userId
      ? await store.findUserById(userId)
      : await store.findUserByUsername(username);

    if (!target) return jsonError(404, 'No such person');
    if (target.id === user.id) {
      return jsonError(400, "You can't start a conversation with yourself", 'userId');
    }

    const { room, created } = await store.findOrCreateDirectRoom(user.id, target.id);
    const { passwordHash: _ignored, ...counterpart } = target as typeof target & {
      passwordHash?: string;
    };

    return NextResponse.json(
      {
        conversation: { room, counterpart, lastMessage: null, unreadCount: 0 },
        created,
      },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    console.error('[conversations:POST]', error);
    return jsonError(500, 'Could not open that conversation');
  }
}
