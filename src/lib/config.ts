/**
 * Central place for environment-driven configuration.
 *
 * The app is designed to run in two modes:
 *   1. Postgres mode   - a connection string is present, everything is durable.
 *   2. Dev memory mode - no connection string, an in-process store is used so
 *      `npm run dev` works with zero setup. Never use this in production: each
 *      serverless instance would keep its own private copy of the data.
 */

function firstDefined(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isPostgresUrl(value: string | undefined): value is string {
  return Boolean(value && /^postgres(ql)?:\/\//i.test(value.trim()));
}

/**
 * Finds the Postgres connection string.
 *
 * The known names are tried first, then anything in the environment that is
 * literally a `postgres://` URL. That fallback exists because Vercel's storage
 * integrations let you pick your own variable prefix when connecting a
 * database - choosing "STORAGE" yields `STORAGE_URL`, not `DATABASE_URL` - and
 * a connected database that the app silently ignores is a miserable failure to
 * diagnose. Pooled names are preferred over direct ones, which matters on
 * serverless where connection count is the scarce resource.
 */
function resolveDatabaseUrl(): string | undefined {
  const known = firstDefined(
    'DATABASE_URL',
    'POSTGRES_URL',
    'STORAGE_URL',
    'POSTGRES_PRISMA_URL',
    'DATABASE_URL_UNPOOLED',
    'POSTGRES_URL_NON_POOLING',
    'STORAGE_URL_NON_POOLING',
  );
  if (isPostgresUrl(known)) return known.trim();

  const candidates = Object.keys(process.env)
    .filter((name) => isPostgresUrl(process.env[name]))
    // A name containing "unpooled" or "non_pooling" is the direct connection;
    // keep it only as a last resort.
    .sort((a, b) => Number(/UNPOOLED|NON_POOLING/i.test(a)) - Number(/UNPOOLED|NON_POOLING/i.test(b)));

  if (candidates.length > 0) {
    const chosen = candidates[0];
    if (!known) {
      console.warn(
        `[config] Using Postgres connection string from ${chosen}. ` +
          'Set DATABASE_URL explicitly to pin it.',
      );
    }
    return process.env[chosen]?.trim();
  }
  return undefined;
}

export const DATABASE_URL = resolveDatabaseUrl();

export const HAS_DATABASE = Boolean(DATABASE_URL);

/**
 * A production deployment with no database is not merely degraded, it is
 * broken: every serverless instance keeps its own copy of the in-memory store,
 * so a session created on one instance is unrecognised by the next and the user
 * is silently signed out. Surfaced in the UI rather than left to be discovered.
 */
export const UNCONFIGURED_IN_PRODUCTION =
  !HAS_DATABASE && process.env.NODE_ENV === 'production';

/**
 * Key used to sign session cookies.
 *
 * `AUTH_SECRET` is the supported way to set this. When it is missing we fall
 * back to deriving a key from the database URL, which is itself a server-side
 * secret and is stable across deployments of the same project. That keeps the
 * app usable the moment the Postgres integration is attached, but setting
 * AUTH_SECRET explicitly is strongly recommended (see README).
 */
export const SESSION_SECRET =
  firstDefined('AUTH_SECRET', 'NEXTAUTH_SECRET') ??
  (DATABASE_URL ? `derived:${DATABASE_URL}` : 'insecure-development-only-secret');

/**
 * Whether the session-signing key was set explicitly. When it is derived from
 * the database URL, a leaked connection string also lets someone mint session
 * cookies. Reported by /api/health rather than enforced, because refusing to
 * serve would take a running deployment down over a configuration gap.
 */
export const SESSION_KEY_EXPLICIT = Boolean(firstDefined('AUTH_SECRET', 'NEXTAUTH_SECRET'));

/**
 * After this date the server refuses the legacy login shape (raw password)
 * outright. Accounts created before encryption existed must sign in once before
 * then to be upgraded; after it, the password never travels to the server under
 * any circumstances. Override with CHAT_LEGACY_AUTH_UNTIL (an ISO date).
 */
export const LEGACY_AUTH_UNTIL = Date.parse(
  process.env.CHAT_LEGACY_AUTH_UNTIL ?? '2026-11-15T00:00:00Z',
);

export const SESSION_COOKIE = 'chat_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** How often an open SSE connection checks the datastore for new rows. */
export const STREAM_POLL_MS = intFromEnv('CHAT_STREAM_POLL_MS', 700, 200, 10_000);

/**
 * How long a single SSE connection is held open before the server politely
 * closes it and the browser's EventSource reconnects. Kept below the Vercel
 * function timeout so streams end cleanly instead of being killed mid-frame.
 */
export const STREAM_TTL_MS = intFromEnv('CHAT_STREAM_TTL_MS', 50_000, 5_000, 280_000);

/** Comment frame interval, keeps proxies from closing an idle connection. */
export const STREAM_HEARTBEAT_MS = 15_000;

/** A presence row younger than this means "currently in the room". */
export const PRESENCE_WINDOW_MS = 45_000;

/** How long a "user is typing" signal stays live without being refreshed. */
export const TYPING_TTL_MS = 6_000;

export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Derived, not chosen by eye: MAX_MESSAGE_LENGTH characters at the worst case
 * of 4 UTF-8 bytes each, plus ~256 bytes of envelope JSON, padded up to the
 * 256-byte bucket, plus the 16-byte GCM tag, then base64url-expanded by 4/3:
 *   ceil((ceil((2000*4 + 256) / 256) * 256 + 16) * 4 / 3) = 11,286 -> 12,000.
 * A smaller cap would reject legitimate non-Latin messages well below the
 * advertised 2000 characters; the crypto tests round-trip 2000 emoji.
 */
export const MAX_CIPHERTEXT_LENGTH = 12_000;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;
