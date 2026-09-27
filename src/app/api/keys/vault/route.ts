import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, parseSealed, readJson, unauthorized } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/keys/vault - replace the caller's sealed vault.
 *
 * Body: { vault: { ct, iv }, version }
 *
 * The vault holds the identity key plus the list of contacts' keys this user
 * has seen or verified, so a new device inherits them. It is re-sealed in the
 * browser whenever that list changes. `version` must be exactly one more than
 * the stored version: two devices editing at once get a 409 and must reload,
 * merge and retry, rather than silently overwrite each other.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const body = await readJson(request);
  if (!body) return jsonError(400, 'Expected a JSON body');

  const vault = parseSealed(body.vault);
  const version = Number(body.version);
  if (!vault || !Number.isInteger(version) || version < 2) {
    return jsonError(400, 'A sealed vault and its next version are required');
  }

  const saved = await getStore().updateVault(user.id, vault, version);
  if (!saved) return jsonError(409, 'Your keys changed on another device. Reload to continue.');
  return NextResponse.json({ ok: true, version });
}
