import { createHash } from 'node:crypto';
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

/**
 * Serialization failure and deadlock: Postgres rolled the whole statement or
 * transaction back, so it had no effect and is safe to run again. Postgres
 * documents retrying these as the application's job.
 */
const TRANSIENT_CODES = new Set(['40001', '40P01']);

function isTransient(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  return code !== undefined && TRANSIENT_CODES.has(code);
}

async function retryTransient<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      // Jitter so the two sides of a deadlock do not collide again in lockstep.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 50));
    }
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  return retryTransient(async () => (await getPool().query<T>(text, params)).rows);
}

/**
 * Runs `fn` inside a transaction, always releasing the client. `fn` may run
 * more than once if Postgres aborts it as a deadlock victim, so it must only
 * touch the database through `client`.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  return retryTransient(async () => {
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
  });
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

-- ===========================================================================
-- Friends, end-to-end encryption, and calls.
--
-- Additive and idempotent throughout. Every ADD COLUMN is nullable or
-- NOT NULL DEFAULT <constant>, which Postgres 11+ applies without rewriting
-- the table. No existing column changes type or nullability.
-- ===========================================================================

-- Auth versions.
--   auth_version 0: legacy account; password_hash is scrypt(raw password) and
--                   there is no key vault. Every account created before this.
--   auth_version 1: password_hash is scrypt(authSecret); the raw password never
--                   reaches the server again.
-- token_version lets the server revoke outstanding (otherwise stateless)
-- session cookies, e.g. when an account is upgraded.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version  SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER  NOT NULL DEFAULT 0;

-- The key vault. There is no salt or iteration-count column on purpose: both
-- are client-side constants, so a hostile server has nothing to lie about.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vault_id         TEXT NOT NULL,
  identity_pub     TEXT NOT NULL,
  kdf_version      SMALLINT NOT NULL DEFAULT 1,
  vault_ct         TEXT NOT NULL,
  vault_iv         TEXT NOT NULL,
  vault_version    INTEGER NOT NULL DEFAULT 1,
  recovery_ct      TEXT,
  recovery_iv      TEXT,
  recovery_version INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_keys_vault_id_idx ON user_keys (vault_id);

-- Message envelope.
--   enc_version 0: body is plaintext. Every existing row, and every public-room
--                  message from now on.
--   enc_version 1: body is base64url(AES-GCM ciphertext and tag); enc_iv and
--                  enc_epoch are set. The IV has its own column so anyone with
--                  a psql prompt can see at a glance that body is opaque.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS enc_iv      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS enc_epoch   TEXT;

-- The first encrypted message in a room sets this. After it, the server refuses
-- plaintext writes to that room.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS e2ee_since_id BIGINT;

-- Rate limiting. Serverless instances share no memory, so the database is the
-- only place a counter can live. One row per bucket, fixed window.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

-- Friends. One row per PAIR, stored pre-sorted so (A,B) and (B,A) collide on
-- the primary key. That single constraint makes duplicate requests, reciprocal
-- pending requests and the simultaneous-mutual-request race impossible without
-- any application-level locking.
CREATE TABLE IF NOT EXISTS friendships (
  low_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  requested_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_count INTEGER NOT NULL DEFAULT 1,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ,
  PRIMARY KEY (low_user_id, high_user_id),
  -- COLLATE "C" pins byte order so Postgres agrees with the JS sort that
  -- builds the pair. A locale-aware collation could order it differently and
  -- admit both (A,B) and (B,A).
  CONSTRAINT friendships_ordered_pair CHECK ((low_user_id COLLATE "C") < high_user_id),
  CONSTRAINT friendships_status       CHECK (status IN ('pending','accepted','declined')),
  CONSTRAINT friendships_requester    CHECK (requested_by IN (low_user_id, high_user_id))
);

CREATE INDEX IF NOT EXISTS friendships_high_idx ON friendships (high_user_id, status);
CREATE INDEX IF NOT EXISTS friendships_pending_idx
  ON friendships (requested_by) WHERE status = 'pending';

-- Blocking is one-directional, so it gets its own table rather than a status
-- on the symmetric pair row - which could represent neither a mutual block nor
-- the friendship that must return on unblock.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id, blocker_id);

-- Grandfather every conversation that already exists: two people who already
-- share a private room have already consented to talk, and must not be locked
-- out by a rule invented afterwards.
--
-- A failure here aborts ensureSchema() and takes the whole app down, so it is
-- defensive: LEAST/GREATEST re-sort under COLLATE "C" so a legacy key cannot
-- trip the ordered-pair CHECK; the EXISTS checks stop a deleted user raising a
-- foreign-key violation; x <> y drops a malformed self-pair. ON CONFLICT makes
-- the rerun on every cold start free.
INSERT INTO friendships (low_user_id, high_user_id, status, requested_by, requested_at, responded_at)
SELECT LEAST(a.x COLLATE "C", a.y),
       GREATEST(a.x COLLATE "C", a.y),
       'accepted',
       CASE WHEN a.created_by IN (a.x, a.y) THEN a.created_by
            ELSE LEAST(a.x COLLATE "C", a.y) END,
       a.created_at,
       a.created_at
FROM (
  SELECT split_part(dm_key, '|', 1) AS x,
         split_part(dm_key, '|', 2) AS y,
         created_by,
         created_at
  FROM rooms
  WHERE kind = 'dm' AND dm_key IS NOT NULL
) a
WHERE a.x <> '' AND a.y <> '' AND a.x <> a.y
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.x)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.y)
ON CONFLICT (low_user_id, high_user_id) DO NOTHING;

-- Calls. No CHECK constraints on state or media: widening a CHECK later is not
-- an additive change, and this app has no migration tool. The closed sets are
-- validated in application code instead.
CREATE TABLE IF NOT EXISTS calls (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  caller_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media        TEXT NOT NULL DEFAULT 'audio',
  state        TEXT NOT NULL DEFAULT 'ringing',
  end_reason   TEXT,
  client_nonce TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at  TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  -- Heartbeated while connected. Without it, two force-killed tabs would leave
  -- a call 'accepted' forever and every later call would return busy.
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_room_idx ON calls (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_caller_live_idx
  ON calls (caller_id, created_at DESC) WHERE state IN ('ringing', 'accepted');
CREATE INDEX IF NOT EXISTS calls_callee_live_idx
  ON calls (callee_id, created_at DESC) WHERE state IN ('ringing', 'accepted');
CREATE UNIQUE INDEX IF NOT EXISTS calls_nonce_idx
  ON calls (caller_id, client_nonce) WHERE client_nonce IS NOT NULL;

-- Call signalling (SDP offers and answers, ICE candidates). The payload is
-- sealed with a key derived from both users' identity keys, so the server
-- never holds a readable SDP: plaintext would put both users' IP addresses in
-- the database and let anyone who can write this row substitute a DTLS
-- fingerprint and intercept the media.
CREATE TABLE IF NOT EXISTS call_signals (
  id           BIGSERIAL PRIMARY KEY,
  call_id      TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_user    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  sig_nonce    TEXT NOT NULL,
  enc_iv       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '2 minutes')
);

CREATE INDEX IF NOT EXISTS call_signals_inbox_idx  ON call_signals (to_user, id);
CREATE INDEX IF NOT EXISTS call_signals_call_idx   ON call_signals (call_id);
CREATE INDEX IF NOT EXISTS call_signals_expiry_idx ON call_signals (expires_at);
`;

const SEED_ROOMS: Array<{ id: string; slug: string; name: string; topic: string }> = [
  { id: 'room_general', slug: 'general', name: 'General', topic: 'Everything and anything' },
  { id: 'room_engineering', slug: 'engineering', name: 'Engineering', topic: 'Builds, bugs and deploys' },
  { id: 'room_random', slug: 'random', name: 'Random', topic: 'Off-topic chatter' },
];

/**
 * Identifies this exact schema. Recorded once applied, so later cold starts
 * skip the DDL entirely: `ALTER TABLE ... IF NOT EXISTS` takes an ACCESS
 * EXCLUSIVE lock even when there is nothing to do, and running it on every
 * cold start deadlocked against live message inserts under load.
 */
const SCHEMA_FINGERPRINT = createHash('sha256')
  .update(SCHEMA_SQL)
  .update(JSON.stringify(SEED_ROOMS))
  .digest('hex')
  .slice(0, 32);

const SCHEMA_LOCK_ID = 826_141_337;

/** Undefined table: the very first boot, before `schema_migrations` exists. */
const isUndefinedTable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P01';

async function schemaApplied(client: PoolClient): Promise<boolean> {
  try {
    const result = await client.query('SELECT 1 FROM schema_migrations WHERE fingerprint = $1', [
      SCHEMA_FINGERPRINT,
    ]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    if (isUndefinedTable(error)) return false;
    throw error;
  }
}

async function applySchema(client: PoolClient): Promise<void> {
  try {
    await client.query('BEGIN');
    // Lose any lock conflict with live traffic quickly, well inside the 1s
    // deadlock_timeout, so a real request is never picked as the victim.
    await client.query("SET LOCAL lock_timeout = '750ms'");
    // Serialises competing cold starts, which otherwise race inside
    // `CREATE TABLE IF NOT EXISTS` on the system catalogs.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    // Another instance may have finished while this one waited for the lock.
    // A failed check aborts the transaction, so it runs in a savepoint.
    await client.query('SAVEPOINT recheck');
    const done = await schemaApplied(client);
    await client.query(done ? 'RELEASE SAVEPOINT recheck' : 'ROLLBACK TO SAVEPOINT recheck');
    if (!done) {
      await client.query(SCHEMA_SQL);
      for (const room of SEED_ROOMS) {
        await client.query(
          `INSERT INTO rooms (id, slug, name, topic)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (slug) DO NOTHING`,
          [room.id, room.slug, room.name, room.topic],
        );
      }
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           fingerprint TEXT PRIMARY KEY,
           applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      await client.query(
        'INSERT INTO schema_migrations (fingerprint) VALUES ($1) ON CONFLICT DO NOTHING',
        [SCHEMA_FINGERPRINT],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Lock timeout: the migration backed off from live traffic; try again. */
const isLockTimeout = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '55P03';

/**
 * Creates or upgrades the schema on first use. Idempotent and safe to call
 * concurrently. The common case - schema already current - is one indexed
 * SELECT and takes no table locks.
 */
export function ensureSchema(): Promise<void> {
  if (!global.__chatSchemaReady) {
    global.__chatSchemaReady = (async () => {
      const client = await getPool().connect();
      try {
        if (await schemaApplied(client)) return;
        for (let attempt = 1; ; attempt += 1) {
          try {
            await applySchema(client);
            return;
          } catch (error) {
            if (attempt >= 8 || !(isLockTimeout(error) || isTransient(error))) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.random() * 200));
          }
        }
      } catch (error) {
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
