import { getUserFromRequest } from '@/lib/auth';
import {
  STREAM_HEARTBEAT_MS,
  STREAM_POLL_MS,
  STREAM_TTL_MS,
} from '@/lib/config';
import { getCalls } from '@/lib/calls';
import { jsonError } from '@/lib/http';
import { loadRoomFor } from '@/lib/rooms';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';
import type { PublicUser } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Held open just long enough for one stream lifetime; the client reconnects.
export const maxDuration = 60;

/**
 * GET /api/stream?roomId=<id|slug>&after=<cursor>
 *
 * A Server-Sent Events feed for one room. Chosen over WebSockets because
 * Vercel's serverless functions cannot hold a stateful socket server, and
 * because SSE gives us automatic browser-side reconnection with `Last-Event-ID`
 * replay for free.
 *
 * Fan-out is done through the datastore rather than an in-process event
 * emitter: two users are frequently served by two different instances, so an
 * in-memory bus would silently drop messages between them. Each open stream
 * tails the `messages` table from a monotonic cursor instead.
 *
 * Frames emitted:
 *   ready     - handshake: the cursor the stream starts from
 *   message   - a new chat message (carries `id:` so reconnects resume)
 *   presence  - who is currently in the room and who is typing
 *   reconnect - the server is closing cleanly, reconnect now
 *   error     - a fatal problem; the client should stop and surface it
 *
 * Access is resolved by `loadRoomFor`, so a stream can only ever be opened for
 * a public room or a private conversation the caller belongs to. In a private
 * conversation the roster is built from membership rather than presence.
 *
 * GET /api/stream?scope=user
 *
 * A second, user-scoped feed that is open whichever room is on screen. It
 * carries what is addressed to YOU rather than to a room:
 *   call    - an incoming call ringing, or a call you are in changing state
 *   signal  - a sealed WebRTC signalling message for a call you are in
 *             (carries `id:`, so a reconnect resumes without losing one)
 *   social  - your friend-request count or friends list changed
 * It takes no room id and does no room lookup: it only ever reads rows whose
 * recipient is the session user, and authorization happened when they were
 * written.
 */

function frame(event: string, data: unknown, id?: string): string {
  const lines = [`event: ${event}`];
  if (id) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(data)}`, '', '');
  return lines.join('\n');
}

/** Sleeps, but wakes immediately if the client disconnects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return jsonError(401, 'You must be signed in to open a stream');

  const url = new URL(request.url);
  if (url.searchParams.get('scope') === 'user') return userStream(request, user);

  const roomParam = url.searchParams.get('roomId');
  if (!roomParam) return jsonError(400, 'roomId is required');

  const store = getStore();
  // Guarded before the ReadableStream is built and before any presence write:
  // an unauthorized stream would be a live firehose of a private conversation,
  // and its presence row would seat the intruder in the participants' roster.
  const room = await loadRoomFor(user, roomParam);
  if (!room) return jsonError(404, 'Room not found');

  // On a reconnect the browser replays the last id it saw, which is more
  // trustworthy than the `after` value baked into the original URL.
  const lastEventId = request.headers.get('last-event-id');
  const afterParam = url.searchParams.get('after');
  let cursor =
    lastEventId ?? afterParam ?? (await store.latestMessageId(room.id));

  const encoder = new TextEncoder();
  const deadline = Date.now() + STREAM_TTL_MS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The consumer went away between our abort check and this write.
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', close, { once: true });

      // Shorten the browser's default reconnect delay (~3s) so the gap between
      // one stream ending and the next opening is barely visible.
      send('retry: 1000\n\n');
      send(frame('ready', { roomId: room.id, slug: room.slug, cursor, pollMs: STREAM_POLL_MS }));

      let lastHeartbeat = Date.now();
      let lastPresenceTouch = 0;
      let lastPresenceSignature = '';
      let onlineRoster: Array<{
        userId: string;
        username: string;
        displayName: string;
        avatarHue: number;
        live: boolean;
      }> = [];

      try {
        while (!closed && !request.signal.aborted && Date.now() < deadline) {
          const now = Date.now();

          // 1. New messages since the cursor.
          const messages = await store.listMessages({ roomId: room.id, afterId: cursor, limit: 100 });
          for (const message of messages) {
            send(frame('message', message, message.id));
            cursor = message.id;
          }

          // 2. Membership changes slowly, typing changes constantly - so the
          //    roster is refreshed on a slow beat while typing is checked every
          //    tick. Either way the frame is only sent when something changed.
          const refreshRoster = now - lastPresenceTouch > 10_000;
          if (refreshRoster) {
            lastPresenceTouch = now;
            await store.touchPresence(room.id, user.id);

            const present = await store.listPresence(room.id);
            if (room.kind === 'dm') {
              // A 1:1 roster is derived from membership, never from presence,
              // so a stray presence row can never show a third face in a
              // private conversation. Presence only decides the live dot.
              const live = new Set(present.map((entry) => entry.userId));
              onlineRoster = (await store.listRoomMembers(room.id)).map((member) => ({
                userId: member.id,
                username: member.username,
                displayName: member.displayName,
                avatarHue: member.avatarHue,
                live: live.has(member.id),
              }));
            } else {
              onlineRoster = present.map((entry) => ({
                userId: entry.userId,
                username: entry.username,
                displayName: entry.displayName,
                avatarHue: entry.avatarHue,
                live: true,
              }));
            }
          }

          const typing = await store.listTyping(room.id);
          const payload = {
            online: onlineRoster,
            typing: typing
              .filter((entry) => entry.userId !== user.id)
              .map((entry) => ({ userId: entry.userId, displayName: entry.displayName })),
          };
          const signature = JSON.stringify(payload);
          if (signature !== lastPresenceSignature) {
            lastPresenceSignature = signature;
            send(frame('presence', payload));
          }

          // 3. Keep intermediaries from treating the connection as idle.
          if (now - lastHeartbeat > STREAM_HEARTBEAT_MS) {
            lastHeartbeat = now;
            send(`: heartbeat ${new Date(now).toISOString()}\n\n`);
          }

          await sleep(STREAM_POLL_MS, request.signal);
        }

        // Reached the time budget rather than a disconnect: tell the client so
        // it can reconnect immediately instead of waiting on a timeout.
        if (!closed && !request.signal.aborted) {
          send(frame('reconnect', { cursor }));
        }
      } catch (error) {
        console.error('[stream]', error);
        send(frame('error', { message: 'The stream ended unexpectedly' }));
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
      Connection: 'keep-alive',
      // Disables response buffering on proxies that would otherwise hold
      // frames back until the connection closes.
      'X-Accel-Buffering': 'no',
    },
  });
}

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** See the `scope=user` notes at the top of this file. */
function userStream(request: Request, user: PublicUser): Response {
  const calls = getCalls();
  const social = getSocial();
  const encoder = new TextEncoder();
  const deadline = Date.now() + STREAM_TTL_MS;

  let cursor = request.headers.get('last-event-id') ?? '0';
  if (!/^\d{1,19}$/.test(cursor)) cursor = '0';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener('abort', close, { once: true });

      send('retry: 1000\n\n');
      send(frame('ready', { scope: 'user', cursor, pollMs: STREAM_POLL_MS }));

      // Signals are re-read over a short recent window (see calls.ts), so the
      // same row can come back twice; this set stops it being sent twice.
      const sentSignals = new Set<string>();
      const callSignatures = new Map<string, string>();
      let socialSignature = '';
      let lastSocialCheck = 0;
      let lastHeartbeat = Date.now();
      let tick = 0;

      try {
        while (!closed && !request.signal.aborted && Date.now() < deadline) {
          const now = Date.now();
          tick += 1;

          if (tick % 15 === 1) await calls.reap();

          for (const signal of await calls.signalsFor(user.id, cursor)) {
            if (sentSignals.has(signal.id)) continue;
            sentSignals.add(signal.id);
            send(frame('signal', signal, signal.id));
            if (Number(signal.id) > Number(cursor)) cursor = signal.id;
          }

          for (const call of await calls.liveCallsFor(user.id)) {
            const signature = `${call.state}:${call.endReason ?? ''}`;
            if (callSignatures.get(call.id) !== signature) {
              callSignatures.set(call.id, signature);
              send(frame('call', call));
            }
          }

          if (now - lastSocialCheck > 3000) {
            lastSocialCheck = now;
            const revision = await social.revision(user.id);
            const signature = `${revision.incoming}|${revision.rev}`;
            if (signature !== socialSignature) {
              socialSignature = signature;
              send(frame('social', { incoming: revision.incoming, rev: revision.rev }));
            }
          }

          if (now - lastHeartbeat > STREAM_HEARTBEAT_MS) {
            lastHeartbeat = now;
            send(`: heartbeat ${new Date(now).toISOString()}\n\n`);
          }

          await sleep(STREAM_POLL_MS, request.signal);
        }

        if (!closed && !request.signal.aborted) send(frame('reconnect', { cursor }));
      } catch (error) {
        console.error('[stream:user]', error);
        send(frame('error', { message: 'The stream ended unexpectedly' }));
      } finally {
        close();
      }
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}
