import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { DEFAULT_HISTORY_LIMIT, MAX_CIPHERTEXT_LENGTH, MAX_HISTORY_LIMIT } from '@/lib/config';
import {
  asString,
  clampLimit,
  EPOCH_PATTERN,
  isBase64Url,
  IV_PATTERN,
  jsonError,
  NONCE_PATTERN,
  readJson,
  unauthorized,
  validateMessageBody,
} from '@/lib/http';
import { counterpartOf, loadRoomFor } from '@/lib/rooms';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';
import { NonceConflictError } from '@/lib/types';

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
 * what the UI needs to paint history on first load. Encrypted messages come
 * back as ciphertext; only the two participants' browsers can read them.
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
 * Plaintext (public rooms, and private rooms before either side has keys):
 *   { body, clientNonce? }
 *
 * End-to-end encrypted (private rooms):
 *   { encVersion: 1, body: <base64url ciphertext>, iv, epoch, clientNonce }
 *   The server cannot read `body`. `clientNonce` is required because it is part
 *   of the ciphertext's authenticated data: the message only decrypts in this
 *   room, from this sender, under this id.
 *
 * Once a private room has carried an encrypted message, the server refuses
 * plaintext into it, so a stale client cannot quietly downgrade the room.
 */
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { roomId } = await context.params;
  const payload = await readJson(request);
  if (!payload) return jsonError(400, 'Expected a JSON body');

  const encVersion = payload.encVersion === 1 ? 1 : 0;
  let body: string;
  let iv: string | null = null;
  let epoch: string | null = null;
  let clientNonce: string | null;

  if (encVersion === 1) {
    if (!isBase64Url(payload.body, 16, MAX_CIPHERTEXT_LENGTH)) {
      return jsonError(400, 'Encrypted message is malformed or too long', 'body');
    }
    if (typeof payload.iv !== 'string' || !IV_PATTERN.test(payload.iv)) {
      return jsonError(400, 'Encrypted message is missing its IV', 'iv');
    }
    if (typeof payload.epoch !== 'string' || !EPOCH_PATTERN.test(payload.epoch)) {
      return jsonError(400, 'Encrypted message is missing its epoch', 'epoch');
    }
    if (typeof payload.clientNonce !== 'string' || !NONCE_PATTERN.test(payload.clientNonce)) {
      return jsonError(400, 'Encrypted message needs a client nonce', 'clientNonce');
    }
    body = payload.body;
    iv = payload.iv;
    epoch = payload.epoch;
    clientNonce = payload.clientNonce;
  } else {
    const validated = validateMessageBody(payload.body);
    if (!validated.ok) return jsonError(400, validated.error, validated.field);
    body = validated.value;
    clientNonce = asString(payload.clientNonce).slice(0, 64) || null;
  }

  try {
    const store = getStore();
    const room = await loadRoomFor(user, roomId);
    if (!room) return jsonError(404, 'Room not found');

    if (room.kind === 'public' && encVersion === 1) {
      return jsonError(400, 'Public rooms are not end-to-end encrypted');
    }

    if (room.kind === 'dm') {
      const other = await counterpartOf(room, user.id);
      // loadRoomFor already hid the room from someone who was blocked; this
      // stops the person who did the blocking from continuing to send.
      if (other && (await getSocial().isBlockedEitherWay(user.id, other.id))) {
        return jsonError(403, 'You blocked this person. Unblock them to send messages.');
      }
      if (encVersion === 0 && room.e2eeSinceId !== null) {
        return jsonError(
          409,
          'This conversation is end-to-end encrypted. Reload the page to send securely.',
        );
      }
    }

    const message = await store.createMessage({
      roomId: room.id,
      userId: user.id,
      body,
      clientNonce,
      encVersion,
      iv,
      epoch,
    });

    await Promise.all([
      store.touchPresence(room.id, user.id),
      store.setTyping(room.id, user.id, false),
    ]);

    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    if (error instanceof NonceConflictError) {
      return jsonError(409, 'Message id collision. Try sending again.');
    }
    console.error('[messages:POST]', error);
    return jsonError(500, 'Could not send the message');
  }
}
