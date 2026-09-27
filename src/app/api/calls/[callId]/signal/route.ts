import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  getCalls,
  loadCallFor,
  MAX_SIGNAL_PAYLOAD,
  peerOf,
  SIGNAL_KINDS,
} from '@/lib/calls';
import {
  isBase64Url,
  IV_PATTERN,
  jsonError,
  NONCE_PATTERN,
  readJson,
  unauthorized,
} from '@/lib/http';
import type { CallSignalKind } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/calls/:callId/signal - relay one signalling message to the peer.
 *
 * Body: { kind, sigNonce, iv, payload }
 *
 * `payload` is an SDP offer/answer or ICE candidate, sealed in the browser with
 * a key derived from both users' identity keys. The server never parses it -
 * validating its contents would need a key the server must not have. It only
 * stores the envelope for the peer's stream to pick up.
 *
 * The recipient is derived from the call, never from the request.
 */
export async function POST(request: Request, context: { params: Promise<{ callId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { callId } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const kind = body.kind as CallSignalKind;
  if (!SIGNAL_KINDS.includes(kind)) return jsonError(400, 'Unknown signal kind');
  if (typeof body.sigNonce !== 'string' || !NONCE_PATTERN.test(body.sigNonce)) {
    return jsonError(400, 'sigNonce is required');
  }
  if (typeof body.iv !== 'string' || !IV_PATTERN.test(body.iv)) {
    return jsonError(400, 'iv is required');
  }
  if (!isBase64Url(body.payload, 16, MAX_SIGNAL_PAYLOAD)) {
    return jsonError(400, 'payload is malformed or too large');
  }

  const call = await loadCallFor(user, callId);
  if (!call) return jsonError(404, 'Call not found');
  if (call.state !== 'ringing' && call.state !== 'accepted') {
    return NextResponse.json({ error: 'This call has ended', call }, { status: 409 });
  }

  const result = await getCalls().addSignal({
    callId: call.id,
    roomId: call.roomId,
    fromUser: user.id,
    toUser: peerOf(call, user.id),
    kind,
    sigNonce: body.sigNonce,
    iv: body.iv,
    payload: body.payload,
  });
  if (!result.ok) return jsonError(429, 'Too many signalling messages for this call');
  return NextResponse.json({ id: result.id }, { status: 202 });
}
