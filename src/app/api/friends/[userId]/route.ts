import { getCurrentUser } from '@/lib/auth';
import { unauthorized } from '@/lib/http';
import { getSocial } from '@/lib/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/friends/:userId - unfriend. Either side may. Idempotent.
 * Does not delete the conversation or its history; to stop contact, block.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ userId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { userId } = await context.params;
  await getSocial().unfriend(user.id, userId);
  return new Response(null, { status: 204 });
}
