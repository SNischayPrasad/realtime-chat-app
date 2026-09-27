import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, unauthorized } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/keys/me - the caller's sealed key vault.
 *
 * Needed when a browser still has a session cookie but lost its local key
 * store (cleared site data, a new tab after a restart). Everything returned is
 * either public or sealed under a key only the user's password can derive.
 *
 * 404 means a pre-encryption account that has not been upgraded yet.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const keys = await getStore().getKeyBundle(user.id);
  if (!keys) return jsonError(404, 'This account has not set up encryption yet');
  return NextResponse.json({ keys }, { headers: { 'Cache-Control': 'no-store' } });
}
