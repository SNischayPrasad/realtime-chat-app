import { randomUUID } from 'node:crypto';
import { HAS_DATABASE, PRESENCE_WINDOW_MS, TYPING_TTL_MS } from './config';
import { isUniqueViolation, query, withTransaction } from './db';
import {
  RoomExistsError,
  UsernameTakenError,
  type Conversation,
  type Message,
  type PresenceEntry,
  type PublicUser,
  type Room,
  type UserRecord,
} from './types';

export type ListMessagesOptions = {
  roomId: string;
  /** Return messages with an id strictly greater than this cursor. */
  afterId?: string;
  limit: number;
};

export type CreateMessageInput = {
  roomId: string;
  userId: string;
  body: string;
  clientNonce?: string | null;
};

export type UserSearchOptions = {
  q: string;
  limit: number;
  excludeUserId: string;
};

export interface ChatStore {
  readonly kind: 'postgres' | 'memory';

  createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    avatarHue: number;
  }): Promise<PublicUser>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<PublicUser | null>;
  searchUsers(options: UserSearchOptions): Promise<PublicUser[]>;

  /** Public rooms only. DMs are never returned here - see listConversations. */
  listRooms(): Promise<Room[]>;
  findRoom(idOrSlug: string): Promise<Room | null>;
  createRoom(input: { name: string; topic: string; createdBy: string }): Promise<Room>;

  /** Membership is authoritative for `dm` rooms only. */
  isRoomMember(roomId: string, userId: string): Promise<boolean>;
  listRoomMembers(roomId: string): Promise<PublicUser[]>;
  findOrCreateDirectRoom(
    userIdA: string,
    userIdB: string,
  ): Promise<{ room: Room; created: boolean }>;
  listConversations(userId: string): Promise<Conversation[]>;
  markRead(roomId: string, userId: string, lastReadId: string): Promise<void>;

  listMessages(options: ListMessagesOptions): Promise<Message[]>;
  latestMessageId(roomId: string): Promise<string>;
  createMessage(input: CreateMessageInput): Promise<Message>;

  touchPresence(roomId: string, userId: string): Promise<void>;
  listPresence(roomId: string): Promise<PresenceEntry[]>;

  setTyping(roomId: string, userId: string, typing: boolean): Promise<void>;
  listTyping(roomId: string): Promise<PresenceEntry[]>;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `room-${randomUUID().slice(0, 8)}`;
}

/** Stable hue derived from a username, used for avatar colours. */
export function hueFor(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * The canonical identity of a 1:1 conversation. Sorting makes it symmetric, so
 * "Ada messages Linus" and "Linus messages Ada" produce the same key and the
 * unique index on `rooms.dm_key` collapses the race into one room.
 *
 * Built from user ids rather than usernames so it survives a future rename.
 */
export function directKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join('|');
}

/**
 * DM slugs are random rather than derived from the participants. A derived slug
 * would let anyone who knows two user ids probe `findRoom(slug)` and learn
 * whether those two people have a conversation.
 */
function directSlug(): string {
  return `dm_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

const PREVIEW_LENGTH = 80;

function preview(body: string): string {
  return body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH)}…` : body;
}

/** Escapes LIKE metacharacters so a search for "100%" is not a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_hue: number;
  created_at: Date;
};

type PublicUserRow = Omit<UserRow, 'password_hash'>;

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  kind: string;
  created_by: string | null;
  created_at: Date;
};

type MessageRow = {
  id: string;
  room_id: string;
  body: string;
  created_at: Date;
  user_id: string;
  username: string;
  display_name: string;
  avatar_hue: number;
  user_created_at: Date;
};

type PresenceRow = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_hue: number;
  last_seen_at: Date;
};

type ConversationRow = RoomRow & {
  o_id: string;
  o_username: string;
  o_display_name: string;
  o_avatar_hue: number;
  o_created_at: Date;
  lm_id: string | null;
  lm_body: string | null;
  lm_created_at: Date | null;
  lm_author: string | null;
  unread: string;
};

function toPublicUser(row: PublicUserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    createdAt: row.created_at.toISOString(),
  };
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    topic: row.topic,
    kind: row.kind === 'dm' ? 'dm' : 'public',
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: String(row.id),
    roomId: row.room_id,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      avatarHue: row.avatar_hue,
      createdAt: row.user_created_at.toISOString(),
    },
  };
}

function toPresence(row: PresenceRow): PresenceEntry {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

const MESSAGE_SELECT = `
  SELECT m.id, m.room_id, m.body, m.created_at,
         u.id AS user_id, u.username, u.display_name, u.avatar_hue,
         u.created_at AS user_created_at
  FROM messages m
  JOIN users u ON u.id = m.user_id
`;

/** Explicit column list: the password hash must never ride along into JSON. */
const USER_COLUMNS = 'id, username, display_name, avatar_hue, created_at';

class PostgresStore implements ChatStore {
  readonly kind = 'postgres' as const;

  async createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    avatarHue: number;
  }): Promise<PublicUser> {
    const id = `usr_${randomUUID().replace(/-/g, '')}`;
    try {
      const rows = await query<UserRow>(
        `INSERT INTO users (id, username, username_lower, display_name, password_hash, avatar_hue)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          id,
          input.username,
          input.username.toLowerCase(),
          input.displayName,
          input.passwordHash,
          input.avatarHue,
        ],
      );
      return toPublicUser(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new UsernameTakenError(input.username);
      throw error;
    }
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const rows = await query<UserRow>('SELECT * FROM users WHERE username_lower = $1', [
      username.toLowerCase(),
    ]);
    if (rows.length === 0) return null;
    return { ...toPublicUser(rows[0]), passwordHash: rows[0].password_hash };
  }

  async findUserById(id: string): Promise<PublicUser | null> {
    const rows = await query<PublicUserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows.length ? toPublicUser(rows[0]) : null;
  }

  async searchUsers(options: UserSearchOptions): Promise<PublicUser[]> {
    const q = options.q.trim();
    if (!q) {
      // No query: show whoever has been active recently, so the picker is
      // useful with zero typing rather than dumping the whole user table.
      const rows = await query<PublicUserRow>(
        `SELECT ${USER_COLUMNS.split(', ')
          .map((column) => `u.${column}`)
          .join(', ')}
         FROM users u
         JOIN (
           SELECT user_id, MAX(last_seen_at) AS seen FROM presence GROUP BY user_id
         ) p ON p.user_id = u.id
         WHERE u.id <> $1 AND p.seen > now() - ($2::int * INTERVAL '1 millisecond')
         ORDER BY p.seen DESC
         LIMIT $3`,
        [options.excludeUserId, PRESENCE_WINDOW_MS * 40, options.limit],
      );
      return rows.map(toPublicUser);
    }

    const pattern = `${escapeLike(q.toLowerCase())}%`;
    const contains = `%${escapeLike(q.toLowerCase())}%`;
    const rows = await query<PublicUserRow>(
      `SELECT ${USER_COLUMNS} FROM users
       WHERE id <> $1
         AND (username_lower LIKE $3 ESCAPE '\\' OR lower(display_name) LIKE $3 ESCAPE '\\')
       ORDER BY
         (username_lower LIKE $2 ESCAPE '\\' OR lower(display_name) LIKE $2 ESCAPE '\\') DESC,
         username_lower ASC
       LIMIT $4`,
      [options.excludeUserId, pattern, contains, options.limit],
    );
    return rows.map(toPublicUser);
  }

  async listRooms(): Promise<Room[]> {
    // The kind filter lives here rather than in the route so that no future
    // caller can accidentally list private conversations.
    const rows = await query<RoomRow>(
      `SELECT * FROM rooms WHERE kind = 'public' ORDER BY created_at ASC, slug ASC`,
    );
    return rows.map(toRoom);
  }

  async findRoom(idOrSlug: string): Promise<Room | null> {
    const rows = await query<RoomRow>('SELECT * FROM rooms WHERE id = $1 OR slug = $1 LIMIT 1', [
      idOrSlug,
    ]);
    return rows.length ? toRoom(rows[0]) : null;
  }

  async createRoom(input: { name: string; topic: string; createdBy: string }): Promise<Room> {
    const slug = slugify(input.name);
    const id = `room_${randomUUID().replace(/-/g, '')}`;
    try {
      const rows = await query<RoomRow>(
        `INSERT INTO rooms (id, slug, name, topic, created_by, kind, dm_key)
         VALUES ($1, $2, $3, $4, $5, 'public', NULL)
         RETURNING *`,
        [id, slug, input.name, input.topic, input.createdBy],
      );
      return toRoom(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new RoomExistsError(slug);
      throw error;
    }
  }

  async isRoomMember(roomId: string, userId: string): Promise<boolean> {
    const rows = await query<{ one: number }>(
      'SELECT 1 AS one FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    return rows.length > 0;
  }

  async listRoomMembers(roomId: string): Promise<PublicUser[]> {
    const rows = await query<PublicUserRow>(
      `SELECT u.id, u.username, u.display_name, u.avatar_hue, u.created_at
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1
       ORDER BY u.display_name ASC`,
      [roomId],
    );
    return rows.map(toPublicUser);
  }

  async findOrCreateDirectRoom(
    userIdA: string,
    userIdB: string,
  ): Promise<{ room: Room; created: boolean }> {
    const key = directKey(userIdA, userIdB);

    const existing = await query<RoomRow>('SELECT * FROM rooms WHERE dm_key = $1', [key]);
    if (existing.length) return { room: toRoom(existing[0]), created: false };

    try {
      const room = await withTransaction(async (client) => {
        // A DM room row carries no name or topic: even if one ever leaked
        // through some future endpoint, it would identify nobody.
        const inserted = await client.query<RoomRow>(
          `INSERT INTO rooms (id, slug, name, topic, created_by, kind, dm_key)
           VALUES ($1, $2, '', '', $3, 'dm', $4)
           RETURNING *`,
          [`room_${randomUUID().replace(/-/g, '')}`, directSlug(), userIdA, key],
        );
        await client.query(
          `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)
           ON CONFLICT DO NOTHING`,
          [inserted.rows[0].id, userIdA, userIdB],
        );
        return toRoom(inserted.rows[0]);
      });
      return { room, created: true };
    } catch (error) {
      // The other participant won the race. Re-read and return their room so
      // both callers converge on one conversation and neither sees an error.
      if (isUniqueViolation(error)) {
        const raced = await query<RoomRow>('SELECT * FROM rooms WHERE dm_key = $1', [key]);
        if (raced.length) return { room: toRoom(raced[0]), created: false };
      }
      throw error;
    }
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    const rows = await query<ConversationRow>(
      `SELECT r.*,
              o.id AS o_id, o.username AS o_username, o.display_name AS o_display_name,
              o.avatar_hue AS o_avatar_hue, o.created_at AS o_created_at,
              lm.id AS lm_id, lm.body AS lm_body,
              lm.created_at AS lm_created_at, lm.user_id AS lm_author,
              COALESCE(uc.cnt, 0) AS unread
       FROM room_members me
       JOIN rooms r ON r.id = me.room_id AND r.kind = 'dm'
       JOIN room_members other ON other.room_id = r.id AND other.user_id <> me.user_id
       JOIN users o ON o.id = other.user_id
       LEFT JOIN LATERAL (
         SELECT m.id, m.body, m.created_at, m.user_id
         FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1
       ) lm ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM messages m
         WHERE m.room_id = r.id AND m.id > me.last_read_id AND m.user_id <> me.user_id
       ) uc ON TRUE
       WHERE me.user_id = $1
       ORDER BY COALESCE(lm.created_at, r.created_at) DESC`,
      [userId],
    );

    return rows.map((row) => ({
      room: toRoom(row),
      counterpart: toPublicUser({
        id: row.o_id,
        username: row.o_username,
        display_name: row.o_display_name,
        avatar_hue: row.o_avatar_hue,
        created_at: row.o_created_at,
      }),
      lastMessage: row.lm_id
        ? {
            id: String(row.lm_id),
            body: preview(row.lm_body ?? ''),
            createdAt: (row.lm_created_at as Date).toISOString(),
            authorId: row.lm_author as string,
          }
        : null,
      unreadCount: Number(row.unread),
    }));
  }

  async markRead(roomId: string, userId: string, lastReadId: string): Promise<void> {
    // GREATEST means an out-of-order request can never un-read a conversation.
    await query(
      `INSERT INTO room_members (room_id, user_id, last_read_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id, user_id)
       DO UPDATE SET last_read_id = GREATEST(room_members.last_read_id, EXCLUDED.last_read_id)`,
      [roomId, userId, lastReadId],
    );
  }

  async listMessages(options: ListMessagesOptions): Promise<Message[]> {
    if (options.afterId !== undefined) {
      const rows = await query<MessageRow>(
        `${MESSAGE_SELECT} WHERE m.room_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3`,
        [options.roomId, options.afterId, options.limit],
      );
      return rows.map(toMessage);
    }
    // No cursor: take the newest page, then flip back to chronological order.
    const rows = await query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.room_id = $1 ORDER BY m.id DESC LIMIT $2`,
      [options.roomId, options.limit],
    );
    return rows.map(toMessage).reverse();
  }

  async latestMessageId(roomId: string): Promise<string> {
    const rows = await query<{ id: string | null }>(
      'SELECT MAX(id) AS id FROM messages WHERE room_id = $1',
      [roomId],
    );
    return rows[0]?.id ? String(rows[0].id) : '0';
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const inserted = await query<{ id: string }>(
      `INSERT INTO messages (room_id, user_id, body, client_nonce)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, client_nonce) WHERE client_nonce IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.roomId, input.userId, input.body, input.clientNonce ?? null],
    );

    // Nothing returned means the unique nonce index swallowed a retry; look up
    // the row that already exists so the caller still gets the message back.
    // Scoped to this room so a nonce replayed against a different room cannot
    // read back a message from the first one.
    const id = inserted.length
      ? inserted[0].id
      : (
          await query<{ id: string }>(
            'SELECT id FROM messages WHERE user_id = $1 AND client_nonce = $2 AND room_id = $3',
            [input.userId, input.clientNonce, input.roomId],
          )
        )[0]?.id;

    if (!id) {
      // The nonce belongs to a message in another room. Treat it as a fresh
      // send rather than leaking or duplicating anything.
      const fresh = await query<{ id: string }>(
        `INSERT INTO messages (room_id, user_id, body, client_nonce)
         VALUES ($1, $2, $3, NULL) RETURNING id`,
        [input.roomId, input.userId, input.body],
      );
      const rows = await query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [fresh[0].id]);
      return toMessage(rows[0]);
    }

    const rows = await query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
    return toMessage(rows[0]);
  }

  async touchPresence(roomId: string, userId: string): Promise<void> {
    await query(
      `INSERT INTO presence (room_id, user_id, last_seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (room_id, user_id) DO UPDATE SET last_seen_at = now()`,
      [roomId, userId],
    );
  }

  async listPresence(roomId: string): Promise<PresenceEntry[]> {
    const rows = await query<PresenceRow>(
      `SELECT p.user_id, p.last_seen_at, u.username, u.display_name, u.avatar_hue
       FROM presence p
       JOIN users u ON u.id = p.user_id
       WHERE p.room_id = $1
         AND p.last_seen_at > now() - ($2::int * INTERVAL '1 millisecond')
       ORDER BY u.display_name ASC`,
      [roomId, PRESENCE_WINDOW_MS],
    );
    return rows.map(toPresence);
  }

  async setTyping(roomId: string, userId: string, typing: boolean): Promise<void> {
    if (!typing) {
      await query('DELETE FROM typing_state WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
      return;
    }
    await query(
      `INSERT INTO typing_state (room_id, user_id, expires_at)
       VALUES ($1, $2, now() + ($3::int * INTERVAL '1 millisecond'))
       ON CONFLICT (room_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [roomId, userId, TYPING_TTL_MS],
    );
  }

  async listTyping(roomId: string): Promise<PresenceEntry[]> {
    const rows = await query<PresenceRow>(
      `SELECT t.user_id, t.expires_at AS last_seen_at, u.username, u.display_name, u.avatar_hue
       FROM typing_state t
       JOIN users u ON u.id = t.user_id
       WHERE t.room_id = $1 AND t.expires_at > now()`,
      [roomId],
    );
    return rows.map(toPresence);
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation (local development only)                          */
/* -------------------------------------------------------------------------- */

type MemoryState = {
  users: Map<string, UserRecord>;
  rooms: Map<string, Room>;
  dmKeys: Map<string, string>;
  members: Map<string, Map<string, { joinedAt: number; lastReadId: number }>>;
  messages: Message[];
  nonces: Map<string, string>;
  presence: Map<string, number>;
  typing: Map<string, number>;
  nextMessageId: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __chatMemoryState: MemoryState | undefined;
}

function memoryState(): MemoryState {
  if (!global.__chatMemoryState) {
    const rooms = new Map<string, Room>();
    const now = new Date().toISOString();
    for (const seed of [
      { id: 'room_general', slug: 'general', name: 'General', topic: 'Everything and anything' },
      {
        id: 'room_engineering',
        slug: 'engineering',
        name: 'Engineering',
        topic: 'Builds, bugs and deploys',
      },
      { id: 'room_random', slug: 'random', name: 'Random', topic: 'Off-topic chatter' },
    ]) {
      rooms.set(seed.id, { ...seed, kind: 'public', createdBy: null, createdAt: now });
    }
    global.__chatMemoryState = {
      users: new Map(),
      rooms,
      dmKeys: new Map(),
      members: new Map(),
      messages: [],
      nonces: new Map(),
      presence: new Map(),
      typing: new Map(),
      nextMessageId: 1,
    };
  }
  return global.__chatMemoryState;
}

class MemoryStore implements ChatStore {
  readonly kind = 'memory' as const;

  async createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    avatarHue: number;
  }): Promise<PublicUser> {
    const state = memoryState();
    for (const user of state.users.values()) {
      if (user.username.toLowerCase() === input.username.toLowerCase()) {
        throw new UsernameTakenError(input.username);
      }
    }
    const record: UserRecord = {
      id: `usr_${randomUUID().replace(/-/g, '')}`,
      username: input.username,
      displayName: input.displayName,
      avatarHue: input.avatarHue,
      createdAt: new Date().toISOString(),
      passwordHash: input.passwordHash,
    };
    state.users.set(record.id, record);
    const { passwordHash: _ignored, ...publicUser } = record;
    return publicUser;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    for (const user of memoryState().users.values()) {
      if (user.username.toLowerCase() === username.toLowerCase()) return user;
    }
    return null;
  }

  async findUserById(id: string): Promise<PublicUser | null> {
    const user = memoryState().users.get(id);
    if (!user) return null;
    const { passwordHash: _ignored, ...publicUser } = user;
    return publicUser;
  }

  async searchUsers(options: UserSearchOptions): Promise<PublicUser[]> {
    const state = memoryState();
    const q = options.q.trim().toLowerCase();
    const candidates: PublicUser[] = [];
    for (const user of state.users.values()) {
      if (user.id === options.excludeUserId) continue;
      const { passwordHash: _ignored, ...publicUser } = user;
      candidates.push(publicUser);
    }

    if (!q) {
      const seen = new Map<string, number>();
      for (const [key, timestamp] of state.presence.entries()) {
        const userId = key.split(':')[1];
        seen.set(userId, Math.max(seen.get(userId) ?? 0, timestamp));
      }
      return candidates
        .filter((user) => seen.has(user.id))
        .sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0))
        .slice(0, options.limit);
    }

    const matches = candidates.filter(
      (user) =>
        user.username.toLowerCase().includes(q) || user.displayName.toLowerCase().includes(q),
    );
    // Same ranking as the SQL: prefix hits first, then alphabetical.
    return matches
      .sort((a, b) => {
        const aPrefix =
          a.username.toLowerCase().startsWith(q) || a.displayName.toLowerCase().startsWith(q);
        const bPrefix =
          b.username.toLowerCase().startsWith(q) || b.displayName.toLowerCase().startsWith(q);
        if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
        return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
      })
      .slice(0, options.limit);
  }

  async listRooms(): Promise<Room[]> {
    return [...memoryState().rooms.values()]
      .filter((room) => room.kind === 'public')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findRoom(idOrSlug: string): Promise<Room | null> {
    const state = memoryState();
    return (
      state.rooms.get(idOrSlug) ??
      [...state.rooms.values()].find((room) => room.slug === idOrSlug) ??
      null
    );
  }

  async createRoom(input: { name: string; topic: string; createdBy: string }): Promise<Room> {
    const state = memoryState();
    const slug = slugify(input.name);
    if ([...state.rooms.values()].some((room) => room.slug === slug)) {
      throw new RoomExistsError(slug);
    }
    const room: Room = {
      id: `room_${randomUUID().replace(/-/g, '')}`,
      slug,
      name: input.name,
      topic: input.topic,
      kind: 'public',
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    state.rooms.set(room.id, room);
    return room;
  }

  async isRoomMember(roomId: string, userId: string): Promise<boolean> {
    return memoryState().members.get(roomId)?.has(userId) ?? false;
  }

  async listRoomMembers(roomId: string): Promise<PublicUser[]> {
    const state = memoryState();
    const members = state.members.get(roomId);
    if (!members) return [];
    const users: PublicUser[] = [];
    for (const userId of members.keys()) {
      const user = state.users.get(userId);
      if (!user) continue;
      const { passwordHash: _ignored, ...publicUser } = user;
      users.push(publicUser);
    }
    return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async findOrCreateDirectRoom(
    userIdA: string,
    userIdB: string,
  ): Promise<{ room: Room; created: boolean }> {
    const state = memoryState();
    const key = directKey(userIdA, userIdB);

    // No `await` between the lookup and the insert: on Node's single-threaded
    // event loop that makes this check-then-set atomic, which is what stands in
    // for the unique index the Postgres store relies on.
    const existingId = state.dmKeys.get(key);
    if (existingId) {
      const existing = state.rooms.get(existingId);
      if (existing) return { room: existing, created: false };
    }

    const room: Room = {
      id: `room_${randomUUID().replace(/-/g, '')}`,
      slug: directSlug(),
      name: '',
      topic: '',
      kind: 'dm',
      createdBy: userIdA,
      createdAt: new Date().toISOString(),
    };
    state.rooms.set(room.id, room);
    state.dmKeys.set(key, room.id);
    state.members.set(
      room.id,
      new Map([
        [userIdA, { joinedAt: Date.now(), lastReadId: 0 }],
        [userIdB, { joinedAt: Date.now(), lastReadId: 0 }],
      ]),
    );
    return { room, created: true };
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    const state = memoryState();
    const conversations: Conversation[] = [];

    for (const [roomId, members] of state.members.entries()) {
      const room = state.rooms.get(roomId);
      if (!room || room.kind !== 'dm') continue;
      const me = members.get(userId);
      if (!me) continue;

      const otherId = [...members.keys()].find((id) => id !== userId);
      const counterpart = otherId ? await this.findUserById(otherId) : null;
      if (!counterpart) continue;

      const roomMessages = state.messages.filter((message) => message.roomId === roomId);
      const last = roomMessages[roomMessages.length - 1] ?? null;

      conversations.push({
        room,
        counterpart,
        lastMessage: last
          ? {
              id: last.id,
              body: preview(last.body),
              createdAt: last.createdAt,
              authorId: last.author.id,
            }
          : null,
        unreadCount: roomMessages.filter(
          (message) => Number(message.id) > me.lastReadId && message.author.id !== userId,
        ).length,
      });
    }

    // Must match the SQL ordering or the rail differs between dev and prod.
    return conversations.sort((a, b) =>
      (b.lastMessage?.createdAt ?? b.room.createdAt).localeCompare(
        a.lastMessage?.createdAt ?? a.room.createdAt,
      ),
    );
  }

  async markRead(roomId: string, userId: string, lastReadId: string): Promise<void> {
    const state = memoryState();
    let members = state.members.get(roomId);
    if (!members) {
      members = new Map();
      state.members.set(roomId, members);
    }
    const existing = members.get(userId);
    members.set(userId, {
      joinedAt: existing?.joinedAt ?? Date.now(),
      lastReadId: Math.max(existing?.lastReadId ?? 0, Number(lastReadId) || 0),
    });
  }

  async listMessages(options: ListMessagesOptions): Promise<Message[]> {
    const all = memoryState().messages.filter((m) => m.roomId === options.roomId);
    if (options.afterId !== undefined) {
      const after = Number(options.afterId);
      return all.filter((m) => Number(m.id) > after).slice(0, options.limit);
    }
    return all.slice(-options.limit);
  }

  async latestMessageId(roomId: string): Promise<string> {
    const all = memoryState().messages.filter((m) => m.roomId === roomId);
    return all.length ? all[all.length - 1].id : '0';
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const state = memoryState();
    // Scoped to the room, matching the Postgres store.
    const nonceKey = input.clientNonce
      ? `${input.userId}:${input.roomId}:${input.clientNonce}`
      : null;
    if (nonceKey && state.nonces.has(nonceKey)) {
      const existingId = state.nonces.get(nonceKey);
      const existing = state.messages.find((m) => m.id === existingId);
      if (existing) return existing;
    }
    const author = await this.findUserById(input.userId);
    if (!author) throw new Error(`Unknown user ${input.userId}`);
    const message: Message = {
      id: String(state.nextMessageId++),
      roomId: input.roomId,
      body: input.body,
      createdAt: new Date().toISOString(),
      author,
    };
    state.messages.push(message);
    if (nonceKey) state.nonces.set(nonceKey, message.id);
    return message;
  }

  async touchPresence(roomId: string, userId: string): Promise<void> {
    memoryState().presence.set(`${roomId}:${userId}`, Date.now());
  }

  private async entriesFrom(
    source: Map<string, number>,
    roomId: string,
    isLive: (timestamp: number) => boolean,
  ): Promise<PresenceEntry[]> {
    const entries: PresenceEntry[] = [];
    for (const [key, timestamp] of source.entries()) {
      const separator = key.indexOf(':');
      const entryRoomId = key.slice(0, separator);
      const userId = key.slice(separator + 1);
      if (entryRoomId !== roomId || !isLive(timestamp)) continue;
      const user = await this.findUserById(userId);
      if (!user) continue;
      entries.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarHue: user.avatarHue,
        lastSeenAt: new Date(timestamp).toISOString(),
      });
    }
    return entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async listPresence(roomId: string): Promise<PresenceEntry[]> {
    const cutoff = Date.now() - PRESENCE_WINDOW_MS;
    return this.entriesFrom(memoryState().presence, roomId, (t) => t > cutoff);
  }

  async setTyping(roomId: string, userId: string, typing: boolean): Promise<void> {
    const state = memoryState();
    const key = `${roomId}:${userId}`;
    if (typing) state.typing.set(key, Date.now() + TYPING_TTL_MS);
    else state.typing.delete(key);
  }

  async listTyping(roomId: string): Promise<PresenceEntry[]> {
    const now = Date.now();
    return this.entriesFrom(memoryState().typing, roomId, (t) => t > now);
  }
}

/* -------------------------------------------------------------------------- */

let cachedStore: ChatStore | undefined;

export function getStore(): ChatStore {
  if (!cachedStore) {
    cachedStore = HAS_DATABASE ? new PostgresStore() : new MemoryStore();
    if (cachedStore.kind === 'memory') {
      console.warn(
        '[store] No DATABASE_URL found - using the in-memory development store. ' +
          'Messages will not survive a restart and will not be shared between instances.',
      );
    }
  }
  return cachedStore;
}
