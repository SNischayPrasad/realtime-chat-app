import { randomUUID } from 'node:crypto';
import { HAS_DATABASE, PRESENCE_WINDOW_MS, TYPING_TTL_MS } from './config';
import { isUniqueViolation, query } from './db';
import {
  RoomExistsError,
  UsernameTakenError,
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

  listRooms(): Promise<Room[]>;
  findRoom(idOrSlug: string): Promise<Room | null>;
  createRoom(input: { name: string; topic: string; createdBy: string }): Promise<Room>;

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

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  topic: string;
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

function toPublicUser(row: UserRow): PublicUser {
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
    const rows = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows.length ? toPublicUser(rows[0]) : null;
  }

  async listRooms(): Promise<Room[]> {
    const rows = await query<RoomRow>('SELECT * FROM rooms ORDER BY created_at ASC, slug ASC');
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
        `INSERT INTO rooms (id, slug, name, topic, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, slug, input.name, input.topic, input.createdBy],
      );
      return toRoom(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new RoomExistsError(slug);
      throw error;
    }
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
    const id = inserted.length
      ? inserted[0].id
      : (
          await query<{ id: string }>(
            'SELECT id FROM messages WHERE user_id = $1 AND client_nonce = $2',
            [input.userId, input.clientNonce],
          )
        )[0]?.id;

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
      rooms.set(seed.id, { ...seed, createdBy: null, createdAt: now });
    }
    global.__chatMemoryState = {
      users: new Map(),
      rooms,
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

  async listRooms(): Promise<Room[]> {
    return [...memoryState().rooms.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    state.rooms.set(room.id, room);
    return room;
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
    const nonceKey = input.clientNonce ? `${input.userId}:${input.clientNonce}` : null;
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
      const [entryRoomId, userId] = key.split(':');
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
