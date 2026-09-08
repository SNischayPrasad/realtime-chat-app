import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { clampLimit, jsonError, unauthorized } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/directory?q=&limit=
 *
 * Backs the people picker. Signed-in only, the caller is excluded, results are
 * hard-capped, and the store selects an explicit column list so a password hash
 * can never ride along into the response.
 *
 * With no query it returns recently-present people rather than a dump of the
 * user table, so the common case is one click and zero typing while the default
 * response describes who is around rather than who exists.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').slice(0, 64);
  const limit = clampLimit(url.searchParams.get('limit'), 15, 25);

  try {
    const people = await getStore().searchUsers({ q, limit, excludeUserId: user.id });
    return NextResponse.json({ people });
  } catch (error) {
    console.error('[directory:GET]', error);
    return jsonError(500, 'Could not load people');
  }
}
