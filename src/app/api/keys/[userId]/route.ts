import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, unauthorized } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/keys/:userId - a user's identity public key.
 *
 * Deliberately returns NO server-computed fingerprint. A value documented as
 * "never trust this" must not be on the wire: one `{keys.fingerprint}` in the
 * UI would quietly turn safety-number verification into theatre. Clients
 * compute fingerprints themselves from the key.
 */
export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { userId } = await context.params;
  const keys = await getStore().getIdentityKeys([userId]);
  const identityPub = keys[userId];
  if (!identityPub) return jsonError(404, 'No key for that user');
  return NextResponse.json({ userId, identityPub });
}
