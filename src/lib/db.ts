import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { DATABASE_URL } from './config';

/**
 * Serverless-friendly Postgres access.
 *
 * A single `Pool` is cached on `globalThis` so that a warm Lambda/Node instance
 * reuses connections across requests instead of opening a new socket per call.
 * The pool is deliberately small: many concurrent instances each holding a few
 * connections is what exhausts a Postgres server, so we lean on the provider's
 * connection pooler (Neon's `-pooler` host) for fan-out.
 */

declare global {
  // eslint-disable-next-line no-var
  var __chatPgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __chatSchemaReady: Promise<void> | undefined;
}

function needsSsl(url: string): boolean {
  if (/sslmode=disable/i.test(url)) return false;
  if (/localhost|127\.0\.0\.1/i.test(url)) return false;
  return true;
}

export function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error('getPool() called without a database connection string');
  }
  if (!global.__chatPgPool) {
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    // An idle client erroring out (provider restart, idle eviction) must never
    // take the whole process down - that would surface as a 500 for unrelated
    // concurrent requests.
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
    global.__chatPgPool = pool;
  }
  return global.__chatPgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/** Runs `fn` inside a transaction, always releasing the client. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already broken; nothing useful to do */
    }
    throw error;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  avatar_hue     INTEGER NOT NULL DEFAULT 210,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  topic      TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id           BIGSERIAL PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  client_nonce TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_room_id_idx ON messages (room_id, id);

-- Makes a retried POST (double click, flaky network, EventSource replay) land
-- exactly once instead of duplicating the message.
CREATE UNIQUE INDEX IF NOT EXISTS messages_nonce_idx
  ON messages (user_id, client_nonce) WHERE client_nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS presence (
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS typing_state (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

-- Private 1:1 conversations -------------------------------------------------
-- Additive and idempotent, so this applies cleanly to a database that already
-- holds rooms and messages. Existing rows take kind='public' from the default.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'public';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS dm_key TEXT;

-- The canonical "these two people" key. This partial unique index is what makes
-- a duplicate DM thread impossible when both users start one at the same moment
-- on two different serverless instances.
CREATE UNIQUE INDEX IF NOT EXISTS rooms_dm_key_idx ON rooms (dm_key) WHERE dm_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS rooms_kind_idx ON rooms (kind);

CREATE TABLE IF NOT EXISTS room_members (
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id, room_id);
`;

const SEED_ROOMS: Array<{ id: string; slug: string; name: string; topic: string }> = [
  { id: 'room_general', slug: 'general', name: 'General', topic: 'Everything and anything' },
  { id: 'room_engineering', slug: 'engineering', name: 'Engineering', topic: 'Builds, bugs and deploys' },
  { id: 'room_random', slug: 'random', name: 'Random', topic: 'Off-topic chatter' },
];

/**
 * Creates the schema on first use. Idempotent and safe to call concurrently:
 * a transaction-scoped advisory lock serialises competing cold starts, which
 * otherwise race inside `CREATE TABLE IF NOT EXISTS` on the system catalogs.
 */
export function ensureSchema(): Promise<void> {
  if (!global.__chatSchemaReady) {
    global.__chatSchemaReady = (async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [826_141_337]);
        await client.query(SCHEMA_SQL);
        for (const room of SEED_ROOMS) {
          await client.query(
            `INSERT INTO rooms (id, slug, name, topic)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (slug) DO NOTHING`,
            [room.id, room.slug, room.name, room.topic],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        // Let the next request retry a failed bootstrap instead of caching it.
        global.__chatSchemaReady = undefined;
        throw error;
      } finally {
        client.release();
      }
    })();
  }
  return global.__chatSchemaReady;
}

/** Postgres unique-violation SQLSTATE. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
