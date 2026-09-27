import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { CALL_ACTIONS, getCalls, loadCallFor, type CallAction } from '@/lib/calls';
import { asString, jsonError, readJson, unauthorized } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/calls/:callId/state - move a call through its lifecycle.
 *
 * Body: { action, reason? }
 *
 *   accept  - callee, while ringing
 *   decline - callee, while ringing
 *   cancel  - caller, while ringing
 *   missed  - caller, when nobody answered
 *   end     - either, once connected
 *   fail    - either, if the connection could not be established
 *
 * Each rule is enforced by the database in a single conditional UPDATE, so two
 * instances racing (both people hanging up at once) cannot corrupt the state.
 * An illegal transition returns 409 with the call as it actually is.
 */
export async function POST(request: Request, context: { params: Promise<{ callId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { callId } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const action = body.action as CallAction;
  if (!CALL_ACTIONS.includes(action)) return jsonError(400, 'Unknown action');
  const reason = asString(body.reason).slice(0, 40) || null;

  const call = await loadCallFor(user, callId);
  if (!call) return jsonError(404, 'Call not found');

  const result = await getCalls().transition(call.id, user.id, action, reason);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'That is not possible right now', call: result.call },
      { status: 409 },
    );
  }
  return NextResponse.json({ call: result.call });
}
