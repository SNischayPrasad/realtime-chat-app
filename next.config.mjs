import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Security headers.
 *
 * frame-ancestors / X-Frame-Options: a page that can start calls must not be
 * framed by another site, or a click on a harmless-looking button could accept
 * a call or grant camera access (clickjacking).
 *
 * Permissions-Policy: camera and microphone for this origin only, never for an
 * embedded third party.
 *
 * A nonce-based script CSP would further limit what an XSS could do with the
 * keys in this tab; it is not set yet (see docs/ENCRYPTION.md).
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root to this project. Without it, Next walks upward and
  // can adopt an unrelated lockfile higher up the filesystem as the root.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
