import { HAS_DATABASE } from './config';
import { query } from './db';

/**
 * Fixed-window rate limiting.
 *
 * Serverless instances share no memory, so an in-process counter would reset
 * on every cold start and be split across every warm instance - no limit at
 * all. Postgres is the only shared state this deployment has.
 *
 * Note the trade-off on per-username login limits: they slow online password
 * guessing, but they also let anyone briefly lock an account out by spamming
 * wrong passwords. The window is short (minutes) to keep that bounded.
 */

type MemoryBucket = { windowStart: number; count: number };

declare global {
  // eslint-disable-next-line no-var
  var __chatRateLimits: Map<string, MemoryBucket> | undefined;
}

export const LIMITS = {
  registerPerIp: { limit: 30, windowSeconds: 3600 },
  loginPerIp: { limit: 60, windowSeconds: 300 },
  loginPerUser: { limit: 10, windowSeconds: 300 },
  lookupPerUser: { limit: 30, windowSeconds: 60 },
  friendRequestPerUser: { limit: 30, windowSeconds: 3600 },
  callsPerUser: { limit: 5, windowSeconds: 60 },
} as const;

/** Returns true if the request is within the limit (and counts it). */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!HAS_DATABASE) {
    const buckets = (global.__chatRateLimits ??= new Map());
    const now = Date.now();
    const current = buckets.get(bucket);
    if (!current || now - current.windowStart > windowSeconds * 1000) {
      buckets.set(bucket, { windowStart: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  const rows = await query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE
         WHEN rate_limits.window_start < now() - ($2::int * interval '1 second') THEN 1
         ELSE rate_limits.count + 1 END,
       window_start = CASE
         WHEN rate_limits.window_start < now() - ($2::int * interval '1 second') THEN now()
         ELSE rate_limits.window_start END
     RETURNING count`,
    [bucket, windowSeconds],
  );

  // Opportunistic cleanup, so the table does not grow without bound.
  if (Math.random() < 0.01) {
    void query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`).catch(
      () => undefined,
    );
  }

  return rows[0].count <= limit;
}

/**
 * Best-effort client address. Vercel sets x-forwarded-for with the client
 * first; anywhere else the header is attacker-controlled, which only lets an
 * attacker choose which bucket they are counted in - not escape counting.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
