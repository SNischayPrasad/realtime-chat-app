import { HAS_DATABASE } from './config';
import { query, withTransaction } from './db';
import { getStore } from './store';
import type {
  FriendEntry,
  FriendRelation,
  FriendsSnapshot,
  PublicUser,
} from './types';

/**
 * Friends and blocks.
 *
 * Friendship is one row per PAIR, stored with the two ids pre-sorted, so the
 * primary key alone makes duplicate requests, a reciprocal pending request and
 * the simultaneous-mutual-request race impossible. Blocking is directional and
 * lives in its own table.
 */

/** A declined requester must wait this long before asking again. */
export const DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Caps outgoing pending requests so the endpoint cannot be used to spam. */
export const MAX_PENDING_OUT = 50;

export type RequestOutcome =
  | 'pending'
  | 'accepted'
  | 'already-friends'
  | 'already-sent'
  | 'cooldown'
  | 'limit'
  | 'blocked'
  | 'self';

export interface SocialStore {
  relation(me: string, other: string): Promise<FriendRelation>;
  snapshot(me: string): Promise<FriendsSnapshot>;
  request(me: string, target: string): Promise<RequestOutcome>;
  /** Recipient only. False covers "no request", "it was yours" and "blocked" alike. */
  accept(me: string, other: string): Promise<boolean>;
  decline(me: string, other: string): Promise<boolean>;
  cancel(me: string, other: string): Promise<void>;
  unfriend(me: string, other: string): Promise<void>;
  block(me: string, other: string): Promise<void>;
  unblock(me: string, other: string): Promise<void>;
  listBlocked(me: string): Promise<PublicUser[]>;
  isBlockedEitherWay(a: string, b: string): Promise<boolean>;
  /** True when another member of the room has blocked `userId`. */
  blockedInRoom(roomId: string, userId: string): Promise<boolean>;
  /**
   * Ids of people who have blocked `me`. Server-side only - used to hide their
   * conversations from `me`, and never returned to any client.
   */
  listBlockersOf(me: string): Promise<Set<string>>;
  /** Cheap change marker so the user stream only emits when something moved. */
  revision(me: string): Promise<{ incoming: number; rev: string }>;
}

/**
 * Must match Postgres' `COLLATE "C"` ordering. Ids are `usr_` plus hex, all
 * ASCII, so JavaScript's UTF-16 code-unit sort and byte order agree.
 */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/* -------------------------------------------------------------------------- */
/* Postgres                                                                   */
/* -------------------------------------------------------------------------- */

type FriendRow = {
  low_user_id: string;
  high_user_id: string;
  status: 'pending' | 'accepted' | 'declined';
  requested_by: string;
  requested_at: Date;
  responded_at: Date | null;
  id: string;
  username: string;
  display_name: string;
  avatar_hue: number;
  created_at: Date;
};

function userOf(row: {
  id: string;
  username: string;
  display_name: string;
  avatar_hue: number;
  created_at: Date;
}): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    createdAt: row.created_at.toISOString(),
  };
}

class PostgresSocial implements SocialStore {
  async relation(me: string, other: string): Promise<FriendRelation> {
    const [low, high] = orderedPair(me, other);
    const rows = await query<{ status: string; requested_by: string }>(
      'SELECT status, requested_by FROM friendships WHERE low_user_id = $1 AND high_user_id = $2',
      [low, high],
    );
    const row = rows[0];
    if (!row) return 'none';
    if (row.status === 'accepted') return 'friend';
    if (row.status === 'pending') return row.requested_by === me ? 'outgoing' : 'incoming';
    return 'none';
  }

  async snapshot(me: string): Promise<FriendsSnapshot> {
    const rows = await query<FriendRow>(
      `SELECT f.low_user_id, f.high_user_id, f.status, f.requested_by,
              f.requested_at, f.responded_at,
              u.id, u.username, u.display_name, u.avatar_hue, u.created_at
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.low_user_id = $1 THEN f.high_user_id ELSE f.low_user_id END
       WHERE (f.low_user_id = $1 OR f.high_user_id = $1)
         AND f.status IN ('pending', 'accepted')
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       ORDER BY u.display_name ASC`,
      [me],
    );

    const snapshot: FriendsSnapshot = { friends: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      const entry: FriendEntry = {
        user: userOf(row),
        since: (row.status === 'accepted' ? (row.responded_at ?? row.requested_at) : row.requested_at).toISOString(),
      };
      if (row.status === 'accepted') snapshot.friends.push(entry);
      else if (row.requested_by === me) snapshot.outgoing.push(entry);
      else snapshot.incoming.push(entry);
    }
    return snapshot;
  }

  async request(me: string, target: string): Promise<RequestOutcome> {
    if (me === target) return 'self';
    if (await this.isBlockedEitherWay(me, target)) return 'blocked';

    const [low, high] = orderedPair(me, target);
    const existing = (
      await query<{ status: string; requested_by: string; responded_at: Date | null }>(
        `SELECT status, requested_by, responded_at FROM friendships
         WHERE low_user_id = $1 AND high_user_id = $2`,
        [low, high],
      )
    )[0];

    if (existing?.status === 'accepted') return 'already-friends';
    if (existing?.status === 'pending' && existing.requested_by === me) return 'already-sent';
    if (
      existing?.status === 'declined' &&
      existing.requested_by === me &&
      existing.responded_at &&
      Date.now() - existing.responded_at.getTime() < DECLINE_COOLDOWN_MS
    ) {
      return 'cooldown';
    }

    // Accepting someone else's pending request never counts against the cap.
    const acceptingTheirs = existing?.status === 'pending' && existing.requested_by !== me;
    if (!acceptingTheirs) {
      const pending = await query<{ n: string }>(
        `SELECT count(*) AS n FROM friendships WHERE requested_by = $1 AND status = 'pending'`,
        [me],
      );
      if (Number(pending[0].n) >= MAX_PENDING_OUT) return 'limit';
    }

    // One statement resolves every race. If the other person's request is
    // already pending, this becomes an acceptance; if two people request each
    // other at the same instant, the loser of the INSERT waits for the winner
    // to commit and then applies this UPDATE to the committed row - so both
    // converge on 'accepted' with no lock and no read-modify-write. Every SET
    // expression reads the OLD row values.
    const rows = await query<{ status: string }>(
      `INSERT INTO friendships (low_user_id, high_user_id, status, requested_by, requested_at)
       VALUES ($1, $2, 'pending', $3, now())
       ON CONFLICT (low_user_id, high_user_id) DO UPDATE SET
         status = CASE
           WHEN friendships.status = 'pending' AND friendships.requested_by <> EXCLUDED.requested_by
             THEN 'accepted'
           WHEN friendships.status = 'declined' THEN 'pending'
           ELSE friendships.status END,
         responded_at = CASE
           WHEN friendships.status = 'pending' AND friendships.requested_by <> EXCLUDED.requested_by
             THEN now()
           WHEN friendships.status = 'declined' THEN NULL
           ELSE friendships.responded_at END,
         request_count = friendships.request_count
           + CASE WHEN friendships.status = 'declined' THEN 1 ELSE 0 END,
         requested_at = CASE
           WHEN friendships.status = 'declined' THEN now() ELSE friendships.requested_at END,
         requested_by = CASE
           WHEN friendships.status = 'declined' THEN EXCLUDED.requested_by
           ELSE friendships.requested_by END
       RETURNING status`,
      [low, high, me],
    );
    return rows[0]?.status === 'accepted' ? 'accepted' : 'pending';
  }

  async accept(me: string, other: string): Promise<boolean> {
    const [low, high] = orderedPair(me, other);
    // The recipient-only rule is enforced by the WHERE clause, not by a branch
    // a future change could route around.
    const rows = await query(
      `UPDATE friendships SET status = 'accepted', responded_at = now()
       WHERE low_user_id = $1 AND high_user_id = $2
         AND status = 'pending' AND requested_by <> $3
       RETURNING 1`,
      [low, high, me],
    );
    return rows.length > 0;
  }

  async decline(me: string, other: string): Promise<boolean> {
    const [low, high] = orderedPair(me, other);
    // Declining keeps the row: that is what powers the re-request cooldown.
    const rows = await query(
      `UPDATE friendships SET status = 'declined', responded_at = now()
       WHERE low_user_id = $1 AND high_user_id = $2
         AND status = 'pending' AND requested_by <> $3
       RETURNING 1`,
      [low, high, me],
    );
    return rows.length > 0;
  }

  async cancel(me: string, other: string): Promise<void> {
    const [low, high] = orderedPair(me, other);
    // Deleted rather than tombstoned, so cancelling carries no cooldown.
    await query(
      `DELETE FROM friendships
       WHERE low_user_id = $1 AND high_user_id = $2 AND status = 'pending' AND requested_by = $3`,
      [low, high, me],
    );
  }

  async unfriend(me: string, other: string): Promise<void> {
    const [low, high] = orderedPair(me, other);
    await query(
      `DELETE FROM friendships
       WHERE low_user_id = $1 AND high_user_id = $2 AND status = 'accepted'`,
      [low, high],
    );
  }

  async block(me: string, other: string): Promise<void> {
    const [low, high] = orderedPair(me, other);
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [me, other],
      );
      // Unblocking returns the pair to "strangers", not to the old friendship.
      await client.query(
        'DELETE FROM friendships WHERE low_user_id = $1 AND high_user_id = $2',
        [low, high],
      );
    });
  }

  async unblock(me: string, other: string): Promise<void> {
    await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, other]);
  }

  async listBlocked(me: string): Promise<PublicUser[]> {
    const rows = await query<{
      id: string;
      username: string;
      display_name: string;
      avatar_hue: number;
      created_at: Date;
    }>(
      `SELECT u.id, u.username, u.display_name, u.avatar_hue, u.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [me],
    );
    return rows.map(userOf);
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const rows = await query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
       LIMIT 1`,
      [a, b],
    );
    return rows.length > 0;
  }

  async blockedInRoom(roomId: string, userId: string): Promise<boolean> {
    const rows = await query(
      `SELECT 1 FROM room_members rm
       JOIN user_blocks b ON b.blocker_id = rm.user_id AND b.blocked_id = $2
       WHERE rm.room_id = $1 AND rm.user_id <> $2
       LIMIT 1`,
      [roomId, userId],
    );
    return rows.length > 0;
  }

  async listBlockersOf(me: string): Promise<Set<string>> {
    const rows = await query<{ blocker_id: string }>(
      'SELECT blocker_id FROM user_blocks WHERE blocked_id = $1',
      [me],
    );
    return new Set(rows.map((row) => row.blocker_id));
  }

  async revision(me: string): Promise<{ incoming: number; rev: string }> {
    const rows = await query<{
      incoming: string;
      total: string;
      latest: Date | null;
      responded: Date | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'pending' AND requested_by <> $1) AS incoming,
         count(*) AS total,
         max(requested_at) AS latest,
         max(responded_at) AS responded
       FROM friendships
       WHERE low_user_id = $1 OR high_user_id = $1`,
      [me],
    );
    const row = rows[0];
    return {
      incoming: Number(row.incoming),
      rev: `${row.total}:${row.latest?.getTime() ?? 0}:${row.responded?.getTime() ?? 0}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory (local development only)                                         */
/* -------------------------------------------------------------------------- */

type MemoryFriendship = {
  status: 'pending' | 'accepted' | 'declined';
  requestedBy: string;
  requestedAt: number;
  respondedAt: number | null;
};

type SocialState = {
  friendships: Map<string, MemoryFriendship>;
  blocks: Map<string, number>;
  version: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __chatSocialState: SocialState | undefined;
}

function socialState(): SocialState {
  if (!global.__chatSocialState) {
    global.__chatSocialState = { friendships: new Map(), blocks: new Map(), version: 0 };
  }
  return global.__chatSocialState;
}

const pairKey = (a: string, b: string) => orderedPair(a, b).join('|');
const blockKey = (blocker: string, blocked: string) => `${blocker}>${blocked}`;

class MemorySocial implements SocialStore {
  async relation(me: string, other: string): Promise<FriendRelation> {
    const row = socialState().friendships.get(pairKey(me, other));
    if (!row) return 'none';
    if (row.status === 'accepted') return 'friend';
    if (row.status === 'pending') return row.requestedBy === me ? 'outgoing' : 'incoming';
    return 'none';
  }

  async snapshot(me: string): Promise<FriendsSnapshot> {
    const state = socialState();
    const snapshot: FriendsSnapshot = { friends: [], incoming: [], outgoing: [] };
    for (const [key, row] of state.friendships) {
      const [a, b] = key.split('|');
      if (a !== me && b !== me) continue;
      if (row.status === 'declined') continue;
      const otherId = a === me ? b : a;
      if (await this.isBlockedEitherWay(me, otherId)) continue;
      const user = await getStore().findUserById(otherId);
      if (!user) continue;
      const entry: FriendEntry = {
        user,
        since: new Date(
          row.status === 'accepted' ? (row.respondedAt ?? row.requestedAt) : row.requestedAt,
        ).toISOString(),
      };
      if (row.status === 'accepted') snapshot.friends.push(entry);
      else if (row.requestedBy === me) snapshot.outgoing.push(entry);
      else snapshot.incoming.push(entry);
    }
    const byName = (x: FriendEntry, y: FriendEntry) =>
      x.user.displayName.localeCompare(y.user.displayName);
    snapshot.friends.sort(byName);
    snapshot.incoming.sort(byName);
    snapshot.outgoing.sort(byName);
    return snapshot;
  }

  async request(me: string, target: string): Promise<RequestOutcome> {
    if (me === target) return 'self';
    if (await this.isBlockedEitherWay(me, target)) return 'blocked';
    const state = socialState();
    const key = pairKey(me, target);
    const existing = state.friendships.get(key);

    if (existing?.status === 'accepted') return 'already-friends';
    if (existing?.status === 'pending' && existing.requestedBy === me) return 'already-sent';
    if (
      existing?.status === 'declined' &&
      existing.requestedBy === me &&
      existing.respondedAt &&
      Date.now() - existing.respondedAt < DECLINE_COOLDOWN_MS
    ) {
      return 'cooldown';
    }

    if (existing?.status === 'pending' && existing.requestedBy !== me) {
      existing.status = 'accepted';
      existing.respondedAt = Date.now();
      state.version += 1;
      return 'accepted';
    }

    const pendingOut = [...state.friendships.values()].filter(
      (row) => row.status === 'pending' && row.requestedBy === me,
    ).length;
    if (pendingOut >= MAX_PENDING_OUT) return 'limit';

    state.friendships.set(key, {
      status: 'pending',
      requestedBy: me,
      requestedAt: Date.now(),
      respondedAt: null,
    });
    state.version += 1;
    return 'pending';
  }

  private respond(me: string, other: string, to: 'accepted' | 'declined'): boolean {
    const state = socialState();
    const row = state.friendships.get(pairKey(me, other));
    if (!row || row.status !== 'pending' || row.requestedBy === me) return false;
    row.status = to;
    row.respondedAt = Date.now();
    state.version += 1;
    return true;
  }

  async accept(me: string, other: string): Promise<boolean> {
    return this.respond(me, other, 'accepted');
  }

  async decline(me: string, other: string): Promise<boolean> {
    return this.respond(me, other, 'declined');
  }

  async cancel(me: string, other: string): Promise<void> {
    const state = socialState();
    const key = pairKey(me, other);
    const row = state.friendships.get(key);
    if (row?.status === 'pending' && row.requestedBy === me) {
      state.friendships.delete(key);
      state.version += 1;
    }
  }

  async unfriend(me: string, other: string): Promise<void> {
    const state = socialState();
    const key = pairKey(me, other);
    if (state.friendships.get(key)?.status === 'accepted') {
      state.friendships.delete(key);
      state.version += 1;
    }
  }

  async block(me: string, other: string): Promise<void> {
    const state = socialState();
    if (!state.blocks.has(blockKey(me, other))) state.blocks.set(blockKey(me, other), Date.now());
    state.friendships.delete(pairKey(me, other));
    state.version += 1;
  }

  async unblock(me: string, other: string): Promise<void> {
    socialState().blocks.delete(blockKey(me, other));
    socialState().version += 1;
  }

  async listBlocked(me: string): Promise<PublicUser[]> {
    const out: PublicUser[] = [];
    for (const key of socialState().blocks.keys()) {
      const [blocker, blocked] = key.split('>');
      if (blocker !== me) continue;
      const user = await getStore().findUserById(blocked);
      if (user) out.push(user);
    }
    return out;
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const blocks = socialState().blocks;
    return blocks.has(blockKey(a, b)) || blocks.has(blockKey(b, a));
  }

  async blockedInRoom(roomId: string, userId: string): Promise<boolean> {
    const members = await getStore().listRoomMembers(roomId);
    return members.some(
      (member) => member.id !== userId && socialState().blocks.has(blockKey(member.id, userId)),
    );
  }

  async listBlockersOf(me: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const key of socialState().blocks.keys()) {
      const [blocker, blocked] = key.split('>');
      if (blocked === me) out.add(blocker);
    }
    return out;
  }

  async revision(me: string): Promise<{ incoming: number; rev: string }> {
    const state = socialState();
    let incoming = 0;
    for (const [key, row] of state.friendships) {
      const [a, b] = key.split('|');
      if ((a === me || b === me) && row.status === 'pending' && row.requestedBy !== me) incoming += 1;
    }
    return { incoming, rev: String(state.version) };
  }
}

/* -------------------------------------------------------------------------- */

let cached: SocialStore | undefined;

export function getSocial(): SocialStore {
  if (!cached) cached = HAS_DATABASE ? new PostgresSocial() : new MemorySocial();
  return cached;
}
