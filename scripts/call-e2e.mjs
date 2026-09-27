#!/usr/bin/env node
/**
 * Real-browser call test.
 *
 *   npm run seed -- http://localhost:3000        # once, to create ada/linus as friends
 *   npm run test:calls -- http://localhost:3000
 *
 * Launches two isolated Chrome contexts with Chrome's FAKE camera and
 * microphone (a green test pattern and a tone) and drives the actual UI: Ada
 * video-calls Linus, Linus answers, and the test asserts that live video and
 * audio arrive on both sides, that mute propagates, and that hanging up ends
 * the call for both.
 *
 * With DATABASE_URL set it also inspects the database directly, proving that
 * every signalling message the server stored was sealed (no readable SDP, IP
 * address or DTLS fingerprint) and that signalling is deleted at hang-up.
 *
 * Proves the whole call stack end to end on ONE machine. It does not prove
 * NAT traversal between real networks - see the README on TURN.
 *
 * Env: CHROME_PATH (defaults to the standard Windows install; otherwise the
 *      locally installed Chrome channel), CALL_USERS="ada:pass,linus:pass".
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = process.argv[3] ?? null;
const [caller, callee] = (process.env.CALL_USERS ?? 'ada:analytical-engine,linus:kernel-panic-99')
  .split(',')
  .map((pair) => {
    const [username, password] = pair.split(':');
    return { username, password };
  });

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath =
  process.env.CHROME_PATH ?? (existsSync(windowsChrome) ? windowsChrome : undefined);

const browser = await chromium.launch({
  executablePath,
  channel: executablePath ? undefined : 'chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

let db = null;
if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
}

async function signIn({ username, password }) {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`    [${username}] ${error.message}`));
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/chat', { timeout: 30_000 });
  await page.waitForSelector('.shell', { timeout: 30_000 });
  return page;
}

const connected = (page) =>
  page.waitForFunction(
    () => /\d+:\d{2}/.test(document.querySelector('.call-stage__meta')?.textContent ?? ''),
    null,
    { timeout: 30_000 },
  );

const receivedMedia = (page) =>
  page
    .waitForFunction(
      () => {
        const video = document.querySelector('.call-stage__video');
        const stream = video?.srcObject;
        return Boolean(
          stream &&
            stream.getVideoTracks().some((t) => t.readyState === 'live') &&
            stream.getAudioTracks().some((t) => t.readyState === 'live') &&
            video.videoWidth > 0,
        );
      },
      null,
      { timeout: 20_000 },
    )
    .then(() =>
      page.evaluate(() => {
        const video = document.querySelector('.call-stage__video');
        return `${video.videoWidth}x${video.videoHeight}`;
      }),
    );

try {
  console.log(`Calling on ${BASE}`);
  const a = await signIn(caller);
  const b = await signIn(callee);
  check('both users signed in and unlocked their keys', true);

  const bName = await b.evaluate(() => document.querySelector('.rail__me-name')?.textContent);
  const aName = await a.evaluate(() => document.querySelector('.rail__me-name')?.textContent);
  await a.locator('.room--dm', { hasText: bName }).first().click();
  await b.locator('.room--dm', { hasText: aName }).first().click();
  await a.waitForSelector('.e2ee-chip', { timeout: 15_000 });

  console.log(`\n${aName} starts a video call`);
  await a.getByRole('button', { name: 'Video', exact: true }).click();
  await b.locator('.call-card', { hasText: 'Incoming video call' }).waitFor({ timeout: 20_000 });
  check(`${bName} is rung live`, true);
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/07-incoming-call.png` });

  await b.getByRole('button', { name: 'Accept' }).click();

  console.log('\nWaiting for the WebRTC connection');
  await Promise.all([connected(a), connected(b)]);
  check('both sides report the call connected', true);

  const [aSees, bSees] = await Promise.all([receivedMedia(a), receivedMedia(b)]);
  check(`${aName} receives live video and audio`, Boolean(aSees), aSees);
  check(`${bName} receives live video and audio`, Boolean(bSees), bSees);

  await a.waitForTimeout(2500);
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/06-video-call.png` });

  let dbCall = null;
  if (db) {
    dbCall = (
      await db.query(
        `SELECT c.id, c.state FROM calls c JOIN users u ON u.id = c.caller_id
         WHERE u.username = $1 ORDER BY c.created_at DESC LIMIT 1`,
        [caller.username],
      )
    ).rows[0];
    check('database: call is accepted', dbCall?.state === 'accepted', dbCall?.state);

    const signals = (
      await db.query('SELECT kind, payload FROM call_signals WHERE call_id = $1', [dbCall.id])
    ).rows;
    const kinds = [...new Set(signals.map((s) => s.kind))].sort().join(',');
    check('database: offer, answer and ICE all relayed', /answer/.test(kinds) && /ice/.test(kinds) && /offer/.test(kinds), kinds);
    const readable = signals.filter((s) =>
      /IN IP4|IN IP6|a=candidate|a=fingerprint|candidate:/.test(
        Buffer.from(s.payload, 'base64url').toString('latin1'),
      ),
    ).length;
    check(
      'database: every stored signal is sealed (no SDP, IPs or fingerprint readable)',
      readable === 0,
      `${signals.length} signals, ${readable} readable`,
    );
  }

  console.log(`\n${aName} mutes`);
  await a.getByRole('button', { name: 'Mute' }).click();
  await b.waitForFunction(
    () => (document.querySelector('.call-stage__meta')?.textContent ?? '').includes('they are muted'),
    null,
    { timeout: 10_000 },
  );
  check(`${bName} sees the mute (a sealed media-state signal)`, true);

  console.log(`\n${aName} hangs up`);
  await a.getByRole('button', { name: 'Hang up' }).click();
  await b.locator('.call-card', { hasText: 'Call ended' }).waitFor({ timeout: 15_000 });
  check(`${bName} sees the call end`, true);
  await a.waitForTimeout(1000);
  check(`${aName}'s call screen closed`, (await a.locator('.call-stage').count()) === 0);

  if (db && dbCall) {
    const ended = (await db.query('SELECT state FROM calls WHERE id = $1', [dbCall.id])).rows[0];
    check('database: call is ended', ended.state === 'ended', ended.state);
    const leftover = (
      await db.query('SELECT count(*)::int AS n FROM call_signals WHERE call_id = $1', [dbCall.id])
    ).rows[0].n;
    check('database: signalling deleted at hang-up', leftover === 0, `${leftover} left`);
  }
} catch (error) {
  failed += 1;
  console.log(`  ✗ aborted: ${error.message.split('\n')[0]}`);
} finally {
  await db?.end();
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
