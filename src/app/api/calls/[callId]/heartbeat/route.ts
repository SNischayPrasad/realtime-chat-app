import { getCurrentUser } from '@/lib/auth';
import { getCalls, loadCallFor } from '@/lib/calls';
import { jsonError, unauthorized } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/calls/:callId/heartbeat - "still here", every 15 seconds.
 *
 * Without it, two browser tabs that are force-closed mid-call would leave the
 * call "accepted" forever, and every later call to either person would come
 * back busy - a failure that never shows up in local testing.
 */
export async function POST(_request: Request, context: { params: Promise<{ callId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { callId } = await context.params;
  const call = await loadCallFor(user, callId);
  if (!call) return jsonError(404, 'Call not found');
  const alive = await getCalls().heartbeat(call.id, user.id);
  return alive ? new Response(null, { status: 204 }) : jsonError(409, 'This call has ended');
}
