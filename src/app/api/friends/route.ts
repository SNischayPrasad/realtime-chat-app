import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/friends - { friends, incoming, outgoing } in one round trip. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  try {
    return NextResponse.json(await getSocial().snapshot(user.id));
  } catch (error) {
    console.error('[friends:GET]', error);
    return jsonError(500, 'Could not load your friends');
  }
}
