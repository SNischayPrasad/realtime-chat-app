import { getCurrentUser } from '@/lib/auth';
import { jsonError, unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/friends/requests/:userId/decline - decline a request sent to you.
 * The requester is not told; they simply cannot ask again for a while.
 */
export async function POST(_request: Request, context: { params: Promise<{ userId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { userId } = await context.params;
  const declined = await getSocial().decline(user.id, userId);
  if (!declined) return jsonError(404, 'No pending request from that person');
  return new Response(null, { status: 204 });
}
