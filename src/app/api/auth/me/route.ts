import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { unauthorized } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/auth/me - the signed-in user, or 401. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  return NextResponse.json({ user });
}
