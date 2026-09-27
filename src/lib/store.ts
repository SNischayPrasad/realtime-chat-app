import { randomUUID } from 'node:crypto';
import { HAS_DATABASE, PRESENCE_WINDOW_MS, TYPING_TTL_MS } from './config';
import { isUniqueViolation, query, withTransaction } from './db';
import {
  NonceConflictError,
  RoomExistsError,
  UsernameTakenError,
  type Conversation,
  type ConversationPreview,
  type EncVersion,
  type KeyBundle,
  type Message,
  type NewKeys,
  type PresenceEntry,
  type PublicUser,
  type Room,
  type SealedBlob,
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
  encVersion?: EncVersion;
  iv?: string | null;
  epoch?: string | null;
};

export type NewAccount = {
  username: string;
  displayName: string;
  /** scrypt(authSecret) - the server never sees the password itself. */
  passwordHash: string;
  avatarHue: number;
  keys: NewKeys;
};

export interface ChatStore {
  readonly kind: 'postgres' | 'memory';

  /** Creates the user AND their key vault atomically: an account must never exist without one. */
  createAccount(input: NewAccount): Promise<PublicUser>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<PublicUser | null>;
  /** The user plus the token version their session cookie must match. */
  findSessionUser(id: string): Promise<{ user: PublicUser; tokenVersion: number } | null>;

  getKeyBundle(userId: string): Promise<KeyBundle | null>;
  /** Identity public keys for the given users; users without keys are omitted. */
  getIdentityKeys(userIds: string[]): Promise<Record<string, string>>;
  /**
   * Second half of the legacy-account upgrade. Only succeeds for an account
   * still at auth_version 0, so two racing tabs cannot strand a vault under
   * the wrong key.
   */
  bootstrapKeys(
    userId: string,
    passwordHash: string,
    keys: NewKeys,
  ): Promise<{ upgraded: boolean; tokenVersion: number }>;
  /** Optimistic write: succeeds only if the stored version is `version - 1`. */
  updateVault(userId: string, vault: SealedBlob, version: number): Promise<boolean>;

  /** Public rooms only. DMs are never returned here - see listConversations. */
  listRooms(): Promise<Room[]>;
  findRoom(idOrSlug: string): Promise<Room | null>;
  createRoom(input: { name: string; topic: string; createdBy: string }): Promise<Room>;

  /** Membership is authoritative for `dm` rooms only. */
  isRoomMember(roomId: string, userId: string): Promise<boolean>;
  listRoomMembers(roomId: string): Promise<PublicUser[]>;
  findDirectRoom(userIdA: string, userIdB: string): Promise<Room | null>;
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
 * The e2ee layer computes the same value independently on each client.
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
  auth_version: number;
  token_version: number;
};

type PublicUserRow = Pick<UserRow, 'id' | 'username' | 'display_name' | 'avatar_hue' | 'created_at'>;

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  kind: string;
  created_by: string | null;
  created_at: Date;
  e2ee_since_id: string | null;
};

type MessageRow = {
  id: string;
  room_id: string;
  body: string;
  created_at: Date;
  client_nonce: string | null;
  enc_version: number;
  enc_iv: string | null;
  enc_epoch: string | null;
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
  o_identity_pub: string | null;
  lm_id: string | null;
  lm_body: string | null;
  lm_created_at: Date | null;
  lm_author: string | null;
  lm_client_nonce: string | null;
  lm_enc_version: number | null;
  lm_enc_iv: string | null;
  lm_enc_epoch: string | null;
  unread: string;
};

type KeyRow = {
  vault_id: string;
  identity_pub: string;
  vault_ct: string;
  vault_iv: string;
  vault_version: number;
  recovery_ct: string | null;
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
    e2eeSinceId: row.e2ee_since_id === null ? null : String(row.e2ee_since_id),
  };
}

function toEncVersion(value: number | null | undefined): EncVersion {
  return value === 1 ? 1 : 0;
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
    clientNonce: row.client_nonce,
    encVersion: toEncVersion(row.enc_version),
    iv: row.enc_iv,
    epoch: row.enc_epoch,
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

function toKeyBundle(row: KeyRow): KeyBundle {
  return {
    vaultId: row.vault_id,
    identityPub: row.identity_pub,
    vault: { ct: row.vault_ct, iv: row.vault_iv, version: row.vault_version },
    recoveryAvailable: row.recovery_ct !== null,
  };
}

const MESSAGE_SELECT = `
  SELECT m.id, m.room_id, m.body, m.created_at,
         m.client_nonce, m.enc_version, m.enc_iv, m.enc_epoch,
         u.id AS user_id, u.username, u.display_name, u.avatar_hue,
         u.created_at AS user_created_at
  FROM messages m
  JOIN users u ON u.id = m.user_id
`;

/** Explicit column list: the password hash must never ride along into JSON. */
const USER_COLUMNS = 'id, username, display_name, avatar_hue, created_at';

class PostgresStore implements ChatStore {
  readonly kind = 'postgres' as const;

  async createAccount(input: NewAccount): Promise<PublicUser> {
    const id = `usr_${randomUUID().replace(/-/g, '')}`;
    try {
      return await withTransaction(async (client) => {
        const inserted = await client.query<UserRow>(
          `INSERT INTO users
             (id, username, username_lower, display_name, password_hash, avatar_hue, auth_version)
           VALUES ($1, $2, $3, $4, $5, $6, 1)
           RETURNING ${USER_COLUMNS}`,
          [
            id,
            input.username,
            input.username.toLowerCase(),
            input.displayName,
            input.passwordHash,
            input.avatarHue,
          ],
        );
        await client.query(
          `INSERT INTO user_keys
             (user_id, vault_id, identity_pub, vault_ct, vault_iv, vault_version,
              recovery_ct, recovery_iv, recovery_version)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
          [
            id,
            input.keys.vaultId,
            input.keys.identityPub,
            input.keys.vault.ct,
            input.keys.vault.iv,
            input.keys.recovery?.ct ?? null,
            input.keys.recovery?.iv ?? null,
            input.keys.recovery ? 1 : 0,
          ],
        );
        return toPublicUser(inserted.rows[0]);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new UsernameTakenError(input.username);
      throw error;
    }
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const rows = await query<UserRow>(
      `SELECT ${USER_COLUMNS}, password_hash, auth_version, token_version
       FROM users WHERE username_lower = $1`,
      [username.toLowerCase()],
    );
    if (rows.length === 0) return null;
    return {
      ...toPublicUser(rows[0]),
      passwordHash: rows[0].password_hash,
      authVersion: rows[0].auth_version,
      tokenVersion: rows[0].token_version,
    };
  }

  async findUserById(id: string): Promise<PublicUser | null> {
    const rows = await query<PublicUserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows.length ? toPublicUser(rows[0]) : null;
  }

  async findSessionUser(id: string): Promise<{ user: PublicUser; tokenVersion: number } | null> {
    const rows = await query<UserRow>(
      `SELECT ${USER_COLUMNS}, token_version FROM users WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return { user: toPublicUser(rows[0]), tokenVersion: rows[0].token_version };
  }

  async getKeyBundle(userId: string): Promise<KeyBundle | null> {
    const rows = await query<KeyRow>(
      `SELECT vault_id, identity_pub, vault_ct, vault_iv, vault_version, recovery_ct
       FROM user_keys WHERE user_id = $1`,
      [userId],
    );
    return rows.length ? toKeyBundle(rows[0]) : null;
  }

  async getIdentityKeys(userIds: string[]): Promise<Record<string, string>> {
    if (userIds.length === 0) return {};
    const rows = await query<{ user_id: string; identity_pub: string }>(
      'SELECT user_id, identity_pub FROM user_keys WHERE user_id = ANY($1::text[])',
      [userIds],
    );
    return Object.fromEntries(rows.map((row) => [row.user_id, row.identity_pub]));
  }

  async bootstrapKeys(
    userId: string,
    passwordHash: string,
    keys: NewKeys,
  ): Promise<{ upgraded: boolean; tokenVersion: number }> {
    return withTransaction(async (client) => {
      const updated = await client.query<{ token_version: number }>(
        `UPDATE users
         SET password_hash = $2, auth_version = 1, token_version = token_version + 1
         WHERE id = $1 AND auth_version = 0
         RETURNING token_version`,
        [userId, passwordHash],
      );
      if (updated.rowCount === 0) {
        const current = await client.query<{ token_version: number }>(
          'SELECT token_version FROM users WHERE id = $1',
          [userId],
        );
        return { upgraded: false, tokenVersion: current.rows[0]?.token_version ?? 0 };
      }
      await client.query(
        `INSERT INTO user_keys
           (user_id, vault_id, identity_pub, vault_ct, vault_iv, vault_version,
            recovery_ct, recovery_iv, recovery_version)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          userId,
          keys.vaultId,
          keys.identityPub,
          keys.vault.ct,
          keys.vault.iv,
          keys.recovery?.ct ?? null,
          keys.recovery?.iv ?? null,
          keys.recovery ? 1 : 0,
        ],
      );
      return { upgraded: true, tokenVersion: updated.rows[0].token_version };
    });
  }

  async updateVault(userId: string, vault: SealedBlob, version: number): Promise<boolean> {
    const rows = await query(
      `UPDATE user_keys
       SET vault_ct = $2, vault_iv = $3, vault_version = $4, updated_at = now()
       WHERE user_id = $1 AND vault_version = $4 - 1
       RETURNING 1`,
      [userId, vault.ct, vault.iv, version],
    );
    return rows.length > 0;
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

  async findDirectRoom(userIdA: string, userIdB: string): Promise<Room | null> {
    const rows = await query<RoomRow>('SELECT * FROM rooms WHERE dm_key = $1', [
      directKey(userIdA, userIdB),
    ]);
    return rows.length ? toRoom(rows[0]) : null;
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
              k.identity_pub AS o_identity_pub,
              lm.id AS lm_id, lm.body AS lm_body,
              lm.created_at AS lm_created_at, lm.user_id AS lm_author,
              lm.client_nonce AS lm_client_nonce, lm.enc_version AS lm_enc_version,
              lm.enc_iv AS lm_enc_iv, lm.enc_epoch AS lm_enc_epoch,
              COALESCE(uc.cnt, 0) AS unread
       FROM room_members me
       JOIN rooms r ON r.id = me.room_id AND r.kind = 'dm'
       JOIN room_members other ON other.room_id = r.id AND other.user_id <> me.user_id
       JOIN users o ON o.id = other.user_id
       LEFT JOIN user_keys k ON k.user_id = o.id
       LEFT JOIN LATERAL (
         SELECT m.id, m.body, m.created_at, m.user_id,
                m.client_nonce, m.enc_version, m.enc_iv, m.enc_epoch
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

    return rows.map((row) => {
      let lastMessage: ConversationPreview | null = null;
      if (row.lm_id) {
        const encVersion = toEncVersion(row.lm_enc_version);
        lastMessage = {
          id: String(row.lm_id),
          // Ciphertext is returned whole: truncating it would cut the GCM tag.
          body: encVersion === 1 ? (row.lm_body ?? '') : preview(row.lm_body ?? ''),
          createdAt: (row.lm_created_at as Date).toISOString(),
          authorId: row.lm_author as string,
          clientNonce: row.lm_client_nonce,
          encVersion,
          iv: row.lm_enc_iv,
          epoch: row.lm_enc_epoch,
        };
      }
      return {
        room: toRoom(row),
        counterpart: toPublicUser({
          id: row.o_id,
          username: row.o_username,
          display_name: row.o_display_name,
          avatar_hue: row.o_avatar_hue,
          created_at: row.o_created_at,
        }),
        counterpartKey: row.o_identity_pub,
        lastMessage,
        unreadCount: Number(row.unread),
      };
    });
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
    const encVersion = input.encVersion ?? 0;
    const inserted = await query<{ id: string }>(
      `INSERT INTO messages (room_id, user_id, body, client_nonce, enc_version, enc_iv, enc_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, client_nonce) WHERE client_nonce IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.roomId,
        input.userId,
        input.body,
        input.clientNonce ?? null,
        encVersion,
        input.iv ?? null,
        input.epoch ?? null,
      ],
    );

    let id: string | undefined = inserted[0]?.id;

    if (!id) {
      // The unique nonce index swallowed a retry; look up the row that already
      // exists so the caller still gets the message back. Scoped to this room
      // so a nonce replayed against a different room cannot read back a
      // message from the first one.
      id = (
        await query<{ id: string }>(
          'SELECT id FROM messages WHERE user_id = $1 AND client_nonce = $2 AND room_id = $3',
          [input.userId, input.clientNonce, input.roomId],
        )
      )[0]?.id;

      if (!id) {
        // The nonce belongs to a message in another room. For an encrypted
        // message the nonce is part of the authenticated data, so storing it
        // without one would make it undecryptable - refuse instead.
        if (encVersion === 1) throw new NonceConflictError();
        const fresh = await query<{ id: string }>(
          `INSERT INTO messages (room_id, user_id, body, client_nonce)
           VALUES ($1, $2, $3, NULL) RETURNING id`,
          [input.roomId, input.userId, input.body],
        );
        id = fresh[0].id;
      }
    } else if (encVersion === 1) {
      // Mark where encryption began. LEAST keeps the earliest of two racing
      // first messages rather than whichever UPDATE happened to run first.
      await query(
        `UPDATE rooms SET e2ee_since_id = LEAST(COALESCE(e2ee_since_id, $2), $2)
         WHERE id = $1`,
        [input.roomId, id],
      );
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

type StoredKeys = {
  vaultId: string;
  identityPub: string;
  vault: SealedBlob & { version: number };
  recovery: SealedBlob | null;
};

type MemoryState = {
  users: Map<string, UserRecord>;
  keys: Map<string, StoredKeys>;
  rooms: Map<string, Room>;
  dmKeys: Map<string, string>;
  members: Map<string, Map<string, { joinedAt: number; lastReadId: number }>>;
  messages: Message[];
  presence: Map<string, number>;
  typing: Map<string, number>;
  nextMessageId: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __chatMemoryState: MemoryState | undefined;
}

export function memoryState(): MemoryState {
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
      rooms.set(seed.id, {
        ...seed,
        kind: 'public',
        createdBy: null,
        createdAt: now,
        e2eeSinceId: null,
      });
    }
    global.__chatMemoryState = {
      users: new Map(),
      keys: new Map(),
      rooms,
      dmKeys: new Map(),
      members: new Map(),
      messages: [],
      presence: new Map(),
      typing: new Map(),
      nextMessageId: 1,
    };
  }
  return global.__chatMemoryState;
}

function publicOf(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarHue: user.avatarHue,
    createdAt: user.createdAt,
  };
}

function bundleOf(keys: StoredKeys): KeyBundle {
  return {
    vaultId: keys.vaultId,
    identityPub: keys.identityPub,
    vault: keys.vault,
    recoveryAvailable: keys.recovery !== null,
  };
}

class MemoryStore implements ChatStore {
  readonly kind = 'memory' as const;

  async createAccount(input: NewAccount): Promise<PublicUser> {
    const state = memoryState();
    // No await before the writes below: on Node's single-threaded loop the
    // check and both inserts are atomic, standing in for the SQL transaction.
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
      authVersion: 1,
      tokenVersion: 0,
    };
    state.users.set(record.id, record);
    state.keys.set(record.id, {
      vaultId: input.keys.vaultId,
      identityPub: input.keys.identityPub,
      vault: { ...input.keys.vault, version: 1 },
      recovery: input.keys.recovery,
    });
    return publicOf(record);
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    for (const user of memoryState().users.values()) {
      if (user.username.toLowerCase() === username.toLowerCase()) return user;
    }
    return null;
  }

  async findUserById(id: string): Promise<PublicUser | null> {
    const user = memoryState().users.get(id);
    return user ? publicOf(user) : null;
  }

  async findSessionUser(id: string): Promise<{ user: PublicUser; tokenVersion: number } | null> {
    const user = memoryState().users.get(id);
    return user ? { user: publicOf(user), tokenVersion: user.tokenVersion } : null;
  }

  async getKeyBundle(userId: string): Promise<KeyBundle | null> {
    const keys = memoryState().keys.get(userId);
    return keys ? bundleOf(keys) : null;
  }

  async getIdentityKeys(userIds: string[]): Promise<Record<string, string>> {
    const state = memoryState();
    const out: Record<string, string> = {};
    for (const id of userIds) {
      const keys = state.keys.get(id);
      if (keys) out[id] = keys.identityPub;
    }
    return out;
  }

  async bootstrapKeys(
    userId: string,
    passwordHash: string,
    keys: NewKeys,
  ): Promise<{ upgraded: boolean; tokenVersion: number }> {
    const state = memoryState();
    const user = state.users.get(userId);
    if (!user) return { upgraded: false, tokenVersion: 0 };
    if (user.authVersion !== 0) return { upgraded: false, tokenVersion: user.tokenVersion };
    user.passwordHash = passwordHash;
    user.authVersion = 1;
    user.tokenVersion += 1;
    if (!state.keys.has(userId)) {
      state.keys.set(userId, {
        vaultId: keys.vaultId,
        identityPub: keys.identityPub,
        vault: { ...keys.vault, version: 1 },
        recovery: keys.recovery,
      });
    }
    return { upgraded: true, tokenVersion: user.tokenVersion };
  }

  async updateVault(userId: string, vault: SealedBlob, version: number): Promise<boolean> {
    const keys = memoryState().keys.get(userId);
    if (!keys || keys.vault.version !== version - 1) return false;
    keys.vault = { ...vault, version };
    return true;
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
      e2eeSinceId: null,
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
      if (user) users.push(publicOf(user));
    }
    return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async findDirectRoom(userIdA: string, userIdB: string): Promise<Room | null> {
    const state = memoryState();
    const id = state.dmKeys.get(directKey(userIdA, userIdB));
    return id ? (state.rooms.get(id) ?? null) : null;
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
      e2eeSinceId: null,
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
        counterpartKey: state.keys.get(counterpart.id)?.identityPub ?? null,
        lastMessage: last
          ? {
              id: last.id,
              body: last.encVersion === 1 ? last.body : preview(last.body),
              createdAt: last.createdAt,
              authorId: last.author.id,
              clientNonce: last.clientNonce,
              encVersion: last.encVersion,
              iv: last.iv,
              epoch: last.epoch,
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
    const encVersion = input.encVersion ?? 0;

    // Mirrors the Postgres unique index on (user_id, client_nonce): a nonce is
    // either a retry in the same room, or a conflict with another room.
    if (input.clientNonce) {
      const existing = state.messages.find(
        (m) => m.author.id === input.userId && m.clientNonce === input.clientNonce,
      );
      if (existing) {
        if (existing.roomId === input.roomId) return existing;
        if (encVersion === 1) throw new NonceConflictError();
      }
    }

    const author = await this.findUserById(input.userId);
    if (!author) throw new Error(`Unknown user ${input.userId}`);

    const nonceTaken = input.clientNonce
      ? state.messages.some(
          (m) => m.author.id === input.userId && m.clientNonce === input.clientNonce,
        )
      : false;

    const message: Message = {
      id: String(state.nextMessageId++),
      roomId: input.roomId,
      body: input.body,
      createdAt: new Date().toISOString(),
      author,
      clientNonce: nonceTaken ? null : (input.clientNonce ?? null),
      encVersion,
      iv: input.iv ?? null,
      epoch: input.epoch ?? null,
    };
    state.messages.push(message);

    if (encVersion === 1) {
      const room = state.rooms.get(input.roomId);
      if (room && (room.e2eeSinceId === null || Number(message.id) < Number(room.e2eeSinceId))) {
        room.e2eeSinceId = message.id;
      }
    }
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
