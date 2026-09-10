#!/usr/bin/env node
/**
 * End-to-end verification suite.
 *
 *   node scripts/verify.mjs [baseUrl]
 *
 * Defaults to http://localhost:3000. Runs against a local build or the live
 * deployment equally - it only uses the public HTTP API and a cookie jar, so it
 * proves what an actual client would experience rather than what the code
 * appears to do.
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const SUITE = process.argv[3] ?? 'all';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* A minimal cookie jar - enough for one session cookie per account.           */
/* -------------------------------------------------------------------------- */

class Session {
  constructor(label) {
    this.label = label;
    this.cookie = null;
    this.user = null;
  }

  async fetch(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${BASE}${path}`, { ...options, headers, redirect: 'manual' });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      if (pair.startsWith('chat_session=')) {
        this.cookie = pair.endsWith('=') ? null : pair;
      }
    }
    return response;
  }

  async json(path, options) {
    const response = await this.fetch(path, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* some responses legitimately have no JSON body */
    }
    return { status: response.status, body };
  }

  post(path, payload) {
    return this.json(path, { method: 'POST', body: JSON.stringify(payload) });
  }
}

const suffix = Math.random().toString(36).slice(2, 8);
const account = (name) => `${name}_${suffix}`;

/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Verifying ${BASE}`);

  const health = await new Session('probe').json('/api/health');
  const store = health.body?.store ?? 'unknown';
  console.log(`Datastore: ${store} (persistent: ${health.body?.persistent})`);
  if (store !== 'postgres') {
    console.log(
      'NOTE: not running against Postgres. Cross-instance checks are meaningless\n' +
        '      on the in-memory store and are reported for information only.',
    );
  }

  const ada = new Session('ada');
  const linus = new Session('linus');
  const grace = new Session('grace');
  const anon = new Session('anon');

  /* ---- accounts ---------------------------------------------------------- */
  section('Authentication');

  for (const [session, name] of [
    [ada, 'ada'],
    [linus, 'linus'],
    [grace, 'grace'],
  ]) {
    const result = await session.post('/api/auth/register', {
      username: account(name),
      password: 'correct-horse-battery-staple',
      displayName: `${name[0].toUpperCase()}${name.slice(1)} Demo`,
    });
    session.user = result.body?.user ?? null;
    check(`register ${name}`, result.status === 201, `HTTP ${result.status}`);
  }

  const dupe = await new Session('dupe').post('/api/auth/register', {
    username: (ada.user?.username ?? '').toUpperCase(),
    password: 'correct-horse-battery-staple',
  });
  check('duplicate username rejected', dupe.status === 409, `HTTP ${dupe.status}`);

  const weak = await new Session('weak').post('/api/auth/register', {
    username: account('weak'),
    password: 'short',
  });
  check('short password rejected', weak.status === 400, `HTTP ${weak.status}`);

  const wrongPassword = await new Session('bad').post('/api/auth/login', {
    username: ada.user?.username,
    password: 'not-the-password',
  });
  check('wrong password rejected', wrongPassword.status === 401, `HTTP ${wrongPassword.status}`);

  const guard = await anon.json('/api/rooms');
  check('unauthenticated request rejected', guard.status === 401, `HTTP ${guard.status}`);

  // The check that fails on the in-memory store: a session must be recognised
  // no matter which instance serves the request.
  const meResults = [];
  for (let i = 0; i < 8; i += 1) meResults.push((await ada.json('/api/auth/me')).status);
  const allOk = meResults.every((s) => s === 200);
  check(
    'session valid across repeated requests',
    allOk,
    `${meResults.filter((s) => s === 200).length}/8 returned 200`,
  );

  /* ---- rooms and messages ------------------------------------------------ */
  section('Public rooms');

  const rooms = await ada.json('/api/rooms');
  check('rooms listed', rooms.status === 200 && (rooms.body?.rooms?.length ?? 0) > 0,
    `${rooms.body?.rooms?.length ?? 0} rooms`);

  const sent = await linus.post('/api/rooms/general/messages', {
    body: 'verification: hello from linus',
    clientNonce: `verify-${suffix}-1`,
  });
  check('message accepted', sent.status === 201, `HTTP ${sent.status}`);
  const sentId = sent.body?.message?.id;

  const replay = await linus.post('/api/rooms/general/messages', {
    body: 'verification: hello from linus',
    clientNonce: `verify-${suffix}-1`,
  });
  check('replayed nonce is idempotent', replay.body?.message?.id === sentId,
    `original ${sentId}, replay ${replay.body?.message?.id}`);

  const history = await ada.json('/api/rooms/general/messages?limit=50');
  const found = (history.body?.messages ?? []).some((m) => m.id === sentId);
  check('message readable by another account', found);

  const empty = await linus.post('/api/rooms/general/messages', { body: '   ' });
  check('empty message rejected', empty.status === 400, `HTTP ${empty.status}`);

  /* ---- live delivery ----------------------------------------------------- */
  section('Live delivery (SSE)');
  await verifyStream(ada, linus);

  /* ---- private conversations --------------------------------------------- */
  section('Private conversations');

  const opened = await ada.post('/api/conversations', { username: linus.user?.username });
  const dmId = opened.body?.conversation?.room?.id;
  check('conversation opened', Boolean(dmId), dmId ?? `HTTP ${opened.status}`);

  const raceResults = await Promise.all(
    Array.from({ length: 6 }, () =>
      ada.post('/api/conversations', { username: linus.user?.username }),
    ),
  );
  const distinct = new Set(raceResults.map((r) => r.body?.conversation?.room?.id));
  check('concurrent opens converge on one room', distinct.size === 1,
    `${distinct.size} distinct room ids`);

  const secret = `verification secret ${suffix}`;
  const dmSend = await ada.post(`/api/rooms/${dmId}/messages`, {
    body: secret,
    clientNonce: `verify-dm-${suffix}`,
  });
  check('member can post to conversation', dmSend.status === 201, `HTTP ${dmSend.status}`);

  const linusRead = await linus.json(`/api/rooms/${dmId}/messages`);
  check('other member can read it',
    JSON.stringify(linusRead.body ?? {}).includes(secret));

  /* ---- access control ---------------------------------------------------- */
  section('Access control (non-member probing a private conversation)');

  const ghost = await grace.json('/api/rooms/room_definitely_not_real/messages');
  const probes = [
    ['read history', await grace.json(`/api/rooms/${dmId}/messages`)],
    ['post message', await grace.post(`/api/rooms/${dmId}/messages`, { body: 'intrusion' })],
    ['typing signal', await grace.post(`/api/rooms/${dmId}/typing`, { typing: true })],
    ['read receipt', await grace.post(`/api/rooms/${dmId}/read`, { lastReadId: '1' })],
  ];

  for (const [name, result] of probes) {
    check(`${name} → 404`, result.status === 404, `HTTP ${result.status}`);
  }
  check('indistinguishable from a nonexistent room',
    probes.every(([, r]) => r.status === ghost.status),
    `nonexistent room returns ${ghost.status}`);

  const streamProbe = await grace.fetch(`/api/stream?roomId=${dmId}`);
  check('stream → 404', streamProbe.status === 404, `HTTP ${streamProbe.status}`);
  try {
    await streamProbe.body?.cancel();
  } catch {
    /* nothing to cancel */
  }

  const graceConvos = await grace.json('/api/conversations');
  check('conversation hidden from non-member',
    (graceConvos.body?.conversations ?? []).length === 0);

  const graceRooms = await grace.json('/api/rooms');
  check('private room absent from public room list',
    !JSON.stringify(graceRooms.body ?? {}).includes(dmId));

  check('message body never leaks to non-member',
    !JSON.stringify(probes.map(([, r]) => r.body)).includes(secret));

  /* ---- concurrency ------------------------------------------------------- */
  section('Concurrency');

  const burst = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      (i % 2 === 0 ? ada : linus).post('/api/rooms/general/messages', {
        body: `burst ${i} ${suffix}`,
        clientNonce: `burst-${suffix}-${i}`,
      }),
    ),
  );
  const created = burst.filter((r) => r.status === 201).length;
  const serverErrors = burst.filter((r) => r.status >= 500).length;
  check('24 concurrent sends all accepted', created === 24, `${created}/24 were 201`);
  check('no server errors under load', serverErrors === 0, `${serverErrors} 5xx`);

  const after = await ada.json('/api/rooms/general/messages?limit=200');
  const persisted = (after.body?.messages ?? []).filter((m) =>
    m.body?.includes(`${suffix}`),
  ).length;
  check('every concurrent message persisted', persisted >= 24, `${persisted} found`);

  /* ---- result ------------------------------------------------------------ */
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Opens a stream as one account, posts as another, and asserts the message
 * arrives as an SSE frame rather than only being fetchable afterwards.
 */
async function verifyStream(reader, writer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  const marker = `sse ${Math.random().toString(36).slice(2, 8)}`;
  let sawReady = false;
  let sawMessage = false;
  let sawId = false;

  const reading = (async () => {
    const response = await fetch(`${BASE}/api/stream?roomId=general`, {
      headers: { cookie: reader.cookie ?? '' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return;

    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      if (text.includes('event: ready')) sawReady = true;
      if (text.includes(/** the id: line proves reconnect-resume works */ 'id: ')) sawId = true;
      if (text.includes(marker)) {
        sawMessage = true;
        break;
      }
    }
  })().catch(() => {
    /* aborted or closed - assertions below report the outcome */
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));
  await writer.post('/api/rooms/general/messages', {
    body: marker,
    clientNonce: `sse-${marker}`,
  });

  await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 20_000))]);
  clearTimeout(timer);
  controller.abort();

  check('stream handshake received', sawReady);
  check('message delivered live over the stream', sawMessage, `marker "${marker}"`);
  check('frames carry a cursor id for resume', sawId);
}

main().catch((error) => {
  console.error('\nVerification aborted:', error);
  process.exit(1);
});
