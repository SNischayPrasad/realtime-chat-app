import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { asString, jsonError, readJson, unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/conversations - the caller's private conversations.
 *
 * Scoped by construction: the query starts from the caller's own membership
 * rows and takes no room id from the request, so there is nothing to tamper
 * with. Conversations with someone who has blocked the caller are omitted, the
 * same way the room itself 404s for them.
 *
 * Each entry carries the counterpart's identity public key. The client must
 * compare it against the copy it pinned the first time, and warn loudly if it
 * changed - the server is the one handing out keys, so it is also the party
 * that could swap one.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  try {
    const [conversations, blockers] = await Promise.all([
      getStore().listConversations(user.id),
      getSocial().listBlockersOf(user.id),
    ]);
    return NextResponse.json({
      conversations: conversations.filter((entry) => !blockers.has(entry.counterpart.id)),
    });
  } catch (error) {
    console.error('[conversations:GET]', error);
    return jsonError(500, 'Could not load your conversations');
  }
}

/**
 * POST /api/conversations - open the private conversation with one person.
 *
 * Body: { userId } or { username }
 *
 * Starting a NEW conversation requires an accepted friendship. A conversation
 * that already exists stays openable regardless: people who were talking
 * before friends existed must not be locked out by a rule added afterwards.
 * Idempotent - opening it twice returns the same room.
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
    const social = getSocial();
    const target = userId
      ? await store.findUserById(userId)
      : await store.findUserByUsername(username);

    // Unknown and blocked-in-either-direction are deliberately the same answer.
    if (!target || (await social.isBlockedEitherWay(user.id, target.id))) {
      return jsonError(404, 'No such person');
    }
    if (target.id === user.id) {
      return jsonError(400, "You can't start a conversation with yourself", 'userId');
    }

    const existing = await store.findDirectRoom(user.id, target.id);
    if (!existing && (await social.relation(user.id, target.id)) !== 'friend') {
      return jsonError(403, 'Add them as a friend to start a private conversation');
    }

    const { room, created } = existing
      ? { room: existing, created: false }
      : await store.findOrCreateDirectRoom(user.id, target.id);

    const counterpart = {
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      avatarHue: target.avatarHue,
      createdAt: target.createdAt,
    };
    const keys = await store.getIdentityKeys([target.id]);

    return NextResponse.json(
      {
        conversation: {
          room,
          counterpart,
          counterpartKey: keys[target.id] ?? null,
          lastMessage: null,
          unreadCount: 0,
        },
        created,
      },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    console.error('[conversations:POST]', error);
    return jsonError(500, 'Could not open that conversation');
  }
}
