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

export const DATABASE_URL = firstDefined(
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING',
);

export const HAS_DATABASE = Boolean(DATABASE_URL);

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
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;
