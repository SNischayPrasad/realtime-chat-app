import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, unauthorized } from '@/lib/http';
import { checkRateLimit, LIMITS } from '@/lib/ratelimit';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';
import type { DirectoryEntry, FriendEntry, FriendRelation } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/directory?q= - backs the "add friend" and "new message" pickers.
 *
 * You see your own graph: friends and pending requests in either direction.
 * A stranger appears only on an EXACT username match (3+ characters), one at a
 * time, rate-limited. There is no prefix search over strangers and no "active
 * recently" list: the first made the user table harvestable and the second
 * told anyone who was online right now.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim().replace(/^@/, '').slice(0, 64).toLowerCase();

  try {
    const social = getSocial();
    const snapshot = await social.snapshot(user.id);

    const tag = (entries: FriendEntry[], relation: FriendRelation): DirectoryEntry[] =>
      entries.map((entry) => ({ ...entry.user, relation }));
    const graph: DirectoryEntry[] = [
      ...tag(snapshot.friends, 'friend'),
      ...tag(snapshot.incoming, 'incoming'),
      ...tag(snapshot.outgoing, 'outgoing'),
    ];

    const people = q
      ? graph.filter(
          (person) =>
            person.username.toLowerCase().includes(q) ||
            person.displayName.toLowerCase().includes(q),
        )
      : graph;

    if (q.length >= 3 && !graph.some((person) => person.username.toLowerCase() === q)) {
      const allowed = await checkRateLimit(
        `lookup:${user.id}`,
        LIMITS.lookupPerUser.limit,
        LIMITS.lookupPerUser.windowSeconds,
      );
      if (allowed) {
        const found = await getStore().findUserByUsername(q);
        if (found && found.id !== user.id && !(await social.isBlockedEitherWay(user.id, found.id))) {
          // Stripped to public fields only; never the auth or token versions.
          people.push({
            id: found.id,
            username: found.username,
            displayName: found.displayName,
            avatarHue: found.avatarHue,
            createdAt: found.createdAt,
            relation: await social.relation(user.id, found.id),
          });
        }
      }
    }

    return NextResponse.json({ people });
  } catch (error) {
    console.error('[directory:GET]', error);
    return jsonError(500, 'Could not load people');
  }
}
