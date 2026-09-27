import { getCurrentUser } from '@/lib/auth';
import { unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE /api/friends/requests/:userId - withdraw a request you sent. Idempotent. */
export async function DELETE(_request: Request, context: { params: Promise<{ userId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { userId } = await context.params;
  await getSocial().cancel(user.id, userId);
  return new Response(null, { status: 204 });
}
