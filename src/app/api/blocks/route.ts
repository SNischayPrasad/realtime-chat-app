import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { asString, jsonError, readJson, unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/blocks - people you have blocked. Never who has blocked you. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  return NextResponse.json({ blocked: await getSocial().listBlocked(user.id) });
}

/**
 * POST /api/blocks - block someone. Body: { userId }
 *
 * Removes any friendship or pending request. Your shared conversation, its
 * stream, typing and calls all disappear for them - byte-identical to the
 * conversation not existing. You keep read access to your own history.
 * Unblocking later returns you to strangers, not to the old friendship.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const body = await readJson(request);
  const userId = body ? asString(body.userId).trim() : '';
  if (!userId) return jsonError(400, 'userId is required', 'userId');
  if (userId === user.id) return jsonError(400, "You can't block yourself");
  const target = await getStore().findUserById(userId);
  if (!target) return jsonError(404, 'No such person');
  await getSocial().block(user.id, userId);
  return new Response(null, { status: 204 });
}
