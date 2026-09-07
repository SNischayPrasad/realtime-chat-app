import { NextResponse } from 'next/server';
import { HAS_DATABASE } from '@/lib/config';
import { ensureSchema } from '@/lib/db';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health - readiness probe. Reports which datastore is active and,
 * for Postgres, whether the schema bootstrap succeeded.
 */
export async function GET() {
  const store = getStore();
  if (!HAS_DATABASE) {
    return NextResponse.json({ ok: true, store: store.kind, persistent: false });
  }
  try {
    await ensureSchema();
    const rooms = await store.listRooms();
    return NextResponse.json({ ok: true, store: store.kind, persistent: true, rooms: rooms.length });
  } catch (error) {
    console.error('[health]', error);
    return NextResponse.json(
      { ok: false, store: store.kind, persistent: true, error: (error as Error).message },
      { status: 503 },
    );
  }
}
