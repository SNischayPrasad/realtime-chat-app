import { NextResponse } from 'next/server';
import { HAS_DATABASE, SESSION_KEY_EXPLICIT } from '@/lib/config';
import { ensureSchema } from '@/lib/db';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health - readiness probe.
 *
 * Reports which datastore is active and, for Postgres, whether the schema
 * bootstrap succeeded. `sessionKey` is "explicit" when AUTH_SECRET is set and
 * "derived" when session cookies are signed with a key derived from the
 * database URL - which works, but means a leaked connection string also lets
 * someone forge sessions.
 */
export async function GET() {
  const store = getStore();
  const sessionKey = SESSION_KEY_EXPLICIT ? 'explicit' : 'derived';
  if (!HAS_DATABASE) {
    return NextResponse.json({ ok: true, store: store.kind, persistent: false, sessionKey });
  }
  try {
    await ensureSchema();
    const rooms = await store.listRooms();
    return NextResponse.json({
      ok: true,
      store: store.kind,
      persistent: true,
      rooms: rooms.length,
      sessionKey,
    });
  } catch (error) {
    console.error('[health]', error);
    return NextResponse.json(
      { ok: false, store: store.kind, persistent: true, error: (error as Error).message },
      { status: 503 },
    );
  }
}
