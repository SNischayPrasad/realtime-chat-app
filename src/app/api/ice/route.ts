import { createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { unauthorized } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const TURN_TTL_SECONDS = 3600;

/**
 * GET /api/ice - the ICE servers a call should use.
 *
 * STUN is always included. It lets two browsers discover their public
 * addresses and connect directly, which works on most home and mobile
 * networks.
 *
 * TURN is a relay for when a direct connection is impossible - symmetric NAT,
 * corporate and campus firewalls, some carrier networks. Without one, calls on
 * those networks fail every time, not intermittently. TURN costs bandwidth, so
 * it is off unless configured:
 *
 *   CHAT_TURN_URLS        comma-separated, e.g. turns:turn.example.com:5349
 *   CHAT_TURN_SECRET      coturn "use-auth-secret": short-lived HMAC credentials
 *   - or -
 *   CHAT_TURN_USERNAME / CHAT_TURN_CREDENTIAL  for providers that issue static ones
 *
 * `relay` tells the client whether a relay exists, so when a call cannot
 * connect it can say "your network needs a relay server" instead of shrugging.
 *
 * A TURN relay forwards the media but cannot read it: the media is still
 * DTLS-SRTP encrypted end to end between the two browsers.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const urls = (process.env.CHAT_TURN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  const iceServers: RTCIceServer[] = [...STUN];
  let relay = false;

  if (urls.length > 0) {
    const secret = process.env.CHAT_TURN_SECRET;
    const staticUser = process.env.CHAT_TURN_USERNAME;
    const staticCredential = process.env.CHAT_TURN_CREDENTIAL;

    if (secret) {
      // coturn's REST scheme: the username embeds an expiry, and the password
      // is an HMAC of it, so a leaked credential dies on its own.
      const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:${user.id}`;
      const credential = createHmac('sha1', secret).update(username).digest('base64');
      iceServers.push({ urls, username, credential });
      relay = true;
    } else if (staticUser && staticCredential) {
      iceServers.push({ urls, username: staticUser, credential: staticCredential });
      relay = true;
    }
  }

  return NextResponse.json(
    { iceServers, relay, ttl: TURN_TTL_SECONDS },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
