import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/friends/requests/:userId/accept - accept a request sent TO you.
 * "No such request", "it was your own request" and "blocked" are one 404.
 */
export async function POST(_request: Request, context: { params: Promise<{ userId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { userId } = await context.params;
  const accepted = await getSocial().accept(user.id, userId);
  if (!accepted) return jsonError(404, 'No pending request from that person');
  return NextResponse.json({ status: 'accepted' });
}
