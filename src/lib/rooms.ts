import { getStore } from './store';
import type { PublicUser, Room } from './types';

/**
 * Resolves a room AND the caller's right to it in one step.
 *
 * Every room-scoped entry point must go through this instead of calling
 * `store.findRoom()` directly. A DM is just a room whose id someone might
 * guess, so "did you remember the check?" has to have exactly one answer.
 *
 * Returns `null` both for "no such room" and for "exists, but not yours" -
 * deliberately indistinguishable. Callers turn `null` into the same 404 they
 * already emit for a missing room, so a non-participant cannot use the API to
 * confirm that a private conversation exists.
 */
export async function loadRoomFor(user: PublicUser, idOrSlug: string): Promise<Room | null> {
  const store = getStore();
  const room = await store.findRoom(idOrSlug);
  if (!room) return null;

  // Public rooms keep the original flat model: any signed-in user may read and
  // post. Membership rows exist for public rooms too, but only to hold read
  // state - they are never consulted for authorization here.
  if (room.kind === 'public') return room;

  return (await store.isRoomMember(room.id, user.id)) ? room : null;
}
