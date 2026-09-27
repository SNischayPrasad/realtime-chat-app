#!/usr/bin/env node
/**
 * End-to-end verification suite.
 *
 *   npm run verify -- [baseUrl]
 *
 * Defaults to http://localhost:3000. Uses only the public HTTP API, so it
 * proves what a real client experiences. Key derivation and encryption use the
 * app's own src/lib/e2ee/crypto.ts under Node's webcrypto - the same code the
 * browser runs - which also proves that code is portable.
 *
 * Optional: LEGACY_ACCOUNT="username:password" rehearses the one-time upgrade
 * of an account created before encryption existed.
 *
 * Exits non-zero if any check fails.
 */

import {
  computeEpoch,
  conversationKey,
  decryptMessage,
  deriveAuthSecret,
  deriveConversationKeys,
  deriveMasterKey,
  deriveVaultKey,
  encryptMessage,
  generateIdentity,
  importPrivateKey,
  importPublicKey,
  newVaultId,
  openSignal,
  sealSignal,
  toBase64Url,
  unwrapVault,
  wrapVault,
} from '../src/lib/e2ee/crypto.ts';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = 'correct-horse-battery-staple';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push(name);
  }
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const section = (title) => console.log(`\n${title}`);
const nonce = () => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
const suffix = Math.random().toString(36).slice(2, 7);

/* -------------------------------------------------------------------------- */
/* A client: one cookie jar plus the keys a browser would hold                */
/* -------------------------------------------------------------------------- */

class Client {
  constructor(name) {
    this.name = name;
    this.username = `${name}_${suffix}`;
    this.cookie = null;
    this.user = null;
    this.identity = null;
  }

  async fetch(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${BASE}${path}`, { ...options, headers, redirect: 'manual' });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      if (pair.startsWith('chat_session=')) this.cookie = pair.endsWith('=') ? null : pair;
    }
    return response;
  }

  async json(path, options) {
    const response = await this.fetch(path, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* 204s and friends */
    }
    return { status: response.status, body };
  }

  post(path, payload = {}) {
    return this.json(path, { method: 'POST', body: JSON.stringify(payload) });
  }

  del(path) {
    return this.json(path, { method: 'DELETE' });
  }

  /** Exactly what the browser does at sign-up. */
  async register(displayName) {
    const master = await deriveMasterKey(PASSWORD, this.username);
    const authSecret = await deriveAuthSecret(master, this.username);
    const vaultKey = await deriveVaultKey(master, this.username);
    this.identity = await generateIdentity();
    const vaultId = newVaultId();
    const sealed = await wrapVault(
      vaultKey,
      { v: 1, ecdhPkcs8: this.identity.privateKey, pins: {}, rooms: {}, retired: [] },
      vaultId,
      1,
    );
    const result = await this.post('/api/auth/register', {
      username: this.username,
      displayName,
      authSecret,
      vaultId,
      identityPub: this.identity.publicKey,
      vault: { ct: sealed.ciphertext, iv: sealed.iv },
    });
    this.user = result.body?.user ?? null;
    return result;
  }

  /** Signs in and proves the returned vault opens to the same identity key. */
  async login(password = PASSWORD) {
    const master = await deriveMasterKey(password, this.username);
    const result = await this.post('/api/auth/login', {
      username: this.username,
      authSecret: await deriveAuthSecret(master, this.username),
    });
    if (result.status === 200 && result.body?.keys) {
      const vault = await unwrapVault(
        await deriveVaultKey(master, this.username),
        { ciphertext: result.body.keys.vault.ct, iv: result.body.keys.vault.iv },
        result.body.keys.vaultId,
        result.body.keys.vault.version,
      );
      result.vaultOpened = vault.ecdhPkcs8 === this.identity?.privateKey;
    }
    return result;
  }

  async keysFor(other, roomId) {
    const dmKey = conversationKey(this.user.id, other.user.id);
    const epoch = await computeEpoch(
      this.user.id,
      this.identity.publicKey,
      other.user.id,
      other.identity.publicKey,
    );
    const keys = await deriveConversationKeys(
      await importPrivateKey(this.identity.privateKey),
      await importPublicKey(other.identity.publicKey),
      dmKey,
      roomId,
      epoch,
    );
    return { ...keys, dmKey, epoch };
  }

  async sendEncrypted(other, roomId, text) {
    const keys = await this.keysFor(other, roomId);
    const clientNonce = nonce();
    const sealed = await encryptMessage({
      messageKey: keys.messageKey,
      roomId,
      senderId: this.user.id,
      epoch: keys.epoch,
      dmKey: keys.dmKey,
      clientNonce,
      text,
      seq: 1,
      prev: null,
    });
    return this.post(`/api/rooms/${roomId}/messages`, {
      encVersion: 1,
      body: sealed.body,
      iv: sealed.iv,
      epoch: keys.epoch,
      clientNonce,
    });
  }
}

/** Reads an SSE response until `until(frames)` is satisfied or time runs out. */
async function collectFrames(client, path, until, timeoutMs = 20_000) {
  const controller = new AbortController();
  const frames = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { cookie: client.cookie ?? '' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return { status: response.status, frames };
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = raw.match(/^event: (.+)$/m)?.[1];
        const data = raw.match(/^data: (.+)$/m)?.[1];
        const id = raw.match(/^id: (.+)$/m)?.[1];
        if (event) frames.push({ event, id, data: data ? JSON.parse(data) : null });
      }
      if (until(frames)) break;
    }
    return { status: 200, frames };
  } catch {
    return { status: 0, frames };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Verifying ${BASE}`);
  const health = await new Client('probe').json('/api/health');
  console.log(
    `Datastore: ${health.body?.store} (persistent: ${health.body?.persistent}, session key: ${health.body?.sessionKey})`,
  );

  const ada = new Client('ada');
  const linus = new Client('linus');
  const grace = new Client('grace');
  const carol = new Client('carol');
  const dave = new Client('dave');
  const everyone = [
    [ada, 'Ada Demo'],
    [linus, 'Linus Demo'],
    [grace, 'Grace Demo'],
    [carol, 'Carol Demo'],
    [dave, 'Dave Demo'],
  ];

  /* ---- authentication ---------------------------------------------------- */
  section('Authentication (the password never leaves the client)');

  for (const [client, name] of everyone) {
    const result = await client.register(name);
    check(`register ${client.name}`, result.status === 201, `HTTP ${result.status}`);
    check(`${client.name}'s vault stored`, Boolean(result.body?.keys?.vaultId));
  }

  const raw = await new Client('raw').post('/api/auth/register', {
    username: `raw_${suffix}`,
    password: PASSWORD,
  });
  check('raw password refused at registration', raw.status === 400, `HTTP ${raw.status}`);

  const dupe = await new Client('dupe').post('/api/auth/register', {
    username: ada.username.toUpperCase(),
    authSecret: 'a'.repeat(64),
    vaultId: nonce(),
    identityPub: ada.identity.publicKey,
    vault: { ct: nonce() + nonce(), iv: nonce().slice(0, 16) },
  });
  check('duplicate username rejected', dupe.status === 409, `HTTP ${dupe.status}`);

  const fresh = new Client('ada');
  fresh.username = ada.username;
  fresh.identity = ada.identity;
  const signIn = await fresh.login();
  check('sign-in with derived secret', signIn.status === 200, `HTTP ${signIn.status}`);
  check('vault opens to the same identity key on a "new device"', signIn.vaultOpened === true);

  const wrong = await fresh.login('not-the-password');
  check('wrong password rejected', wrong.status === 401, `HTTP ${wrong.status}`);
  check('wrong password is not flagged as legacy', !wrong.body?.legacy);

  const rawLogin = await new Client('x').post('/api/auth/login', {
    username: ada.username,
    password: PASSWORD,
    upgrade: {},
  });
  check(
    'raw-password login refused for an upgraded account',
    rawLogin.status === 400 || rawLogin.status === 401,
    `HTTP ${rawLogin.status}`,
  );

  const anon = await new Client('anon').json('/api/rooms');
  check('unauthenticated request rejected', anon.status === 401, `HTTP ${anon.status}`);

  const me = [];
  for (let i = 0; i < 6; i += 1) me.push((await ada.json('/api/auth/me')).status);
  check('session valid across repeated requests', me.every((s) => s === 200), me.join(' '));

  const keyMe = await ada.json('/api/keys/me');
  check('own sealed vault retrievable', keyMe.status === 200 && Boolean(keyMe.body?.keys?.vault?.ct));
  const keyOther = await ada.json(`/api/keys/${linus.user.id}`);
  check(
    "another user's public key is served without a fingerprint",
    keyOther.body?.identityPub === linus.identity.publicKey && !('fingerprint' in (keyOther.body ?? {})),
  );

  /* ---- friends ----------------------------------------------------------- */
  section('Friends');

  const exact = await ada.json(`/api/directory?q=${linus.username}`);
  check(
    'exact username finds a stranger',
    (exact.body?.people ?? []).some((p) => p.id === linus.user.id && p.relation === 'none'),
  );
  const prefix = await ada.json(`/api/directory?q=${linus.username.slice(0, 4)}`);
  check(
    'partial name does not list strangers',
    !(prefix.body?.people ?? []).some((p) => p.id === linus.user.id),
  );

  const notFriends = await ada.post('/api/conversations', { userId: linus.user.id });
  check('cannot start a conversation with a non-friend', notFriends.status === 403, `HTTP ${notFriends.status}`);

  const sent = await ada.post('/api/friends/requests', { username: linus.username });
  check('friend request sent', sent.status === 201 && sent.body?.status === 'pending');
  const again = await ada.post('/api/friends/requests', { username: linus.username });
  check('duplicate request refused', again.status === 409, `HTTP ${again.status}`);

  const linusView = await linus.json('/api/friends');
  check(
    'recipient sees it as incoming',
    (linusView.body?.incoming ?? []).some((e) => e.user.id === ada.user.id),
  );

  const selfAccept = await ada.post(`/api/friends/requests/${linus.user.id}/accept`);
  check('sender cannot accept their own request', selfAccept.status === 404, `HTTP ${selfAccept.status}`);

  const [acceptA, acceptB] = await Promise.all([
    linus.post(`/api/friends/requests/${ada.user.id}/accept`),
    linus.post(`/api/friends/requests/${ada.user.id}/accept`),
  ]);
  const acceptStatuses = [acceptA.status, acceptB.status].sort().join(',');
  check('double accept: exactly one wins', acceptStatuses === '200,404', acceptStatuses);

  // The race the pair-row design exists for: two people ask each other at once.
  const [mutualA, mutualB] = await Promise.all([
    carol.post('/api/friends/requests', { userId: dave.user.id }),
    dave.post('/api/friends/requests', { userId: carol.user.id }),
  ]);
  const carolFriends = await carol.json('/api/friends');
  check(
    'simultaneous mutual requests converge on friends',
    (carolFriends.body?.friends ?? []).some((e) => e.user.id === dave.user.id),
    `HTTP ${mutualA.status}/${mutualB.status}`,
  );

  await grace.post('/api/friends/requests', { userId: ada.user.id });
  const declined = await ada.post(`/api/friends/requests/${grace.user.id}/decline`);
  check('decline', declined.status === 204, `HTTP ${declined.status}`);
  const cooldown = await grace.post('/api/friends/requests', { userId: ada.user.id });
  check('declined requester must wait', cooldown.status === 429, `HTTP ${cooldown.status}`);

  await ada.post('/api/friends/requests', { userId: grace.user.id });
  const graceAccepts = await grace.post(`/api/friends/requests/${ada.user.id}/accept`);
  check('the other side can still ask, and be accepted', graceAccepts.status === 200);

  /* ---- private conversation, end-to-end encrypted ----------------------- */
  section('Private conversation (end-to-end encrypted)');

  const opened = await ada.post('/api/conversations', { userId: linus.user.id });
  const roomId = opened.body?.conversation?.room?.id;
  check('friends can open a conversation', Boolean(roomId), `HTTP ${opened.status}`);
  check(
    "conversation carries the counterpart's public key",
    opened.body?.conversation?.counterpartKey === linus.identity.publicKey,
  );

  const secret = `the eagle lands at dawn ${suffix}`;
  const encSend = await ada.sendEncrypted(linus, roomId, secret);
  check('encrypted message accepted', encSend.status === 201, `HTTP ${encSend.status}`);

  const history = await linus.json(`/api/rooms/${roomId}/messages`);
  const stored = (history.body?.messages ?? []).find((m) => m.id === encSend.body?.message?.id);
  check('server stored ciphertext, not the text', stored && stored.encVersion === 1 && !stored.body.includes('eagle'));

  const linusKeys = await linus.keysFor(ada, roomId);
  let decrypted = null;
  try {
    decrypted = await decryptMessage({
      messageKey: linusKeys.messageKey,
      roomId,
      senderId: ada.user.id,
      epoch: stored.epoch,
      clientNonce: stored.clientNonce,
      body: stored.body,
      iv: stored.iv,
    });
  } catch {
    /* reported below */
  }
  check('recipient decrypts it', decrypted?.text === secret);

  const downgrade = await ada.post(`/api/rooms/${roomId}/messages`, { body: 'plaintext now' });
  check('plaintext refused once the conversation is encrypted', downgrade.status === 409, `HTTP ${downgrade.status}`);

  const badIv = await ada.post(`/api/rooms/${roomId}/messages`, {
    encVersion: 1,
    body: stored.body,
    iv: 'short',
    epoch: stored.epoch,
    clientNonce: nonce(),
  });
  check('malformed envelope rejected', badIv.status === 400, `HTTP ${badIv.status}`);

  const publicEnc = await ada.post('/api/rooms/general/messages', {
    encVersion: 1,
    body: stored.body,
    iv: stored.iv,
    epoch: stored.epoch,
    clientNonce: nonce(),
  });
  check('ciphertext refused in a public room', publicEnc.status === 400, `HTTP ${publicEnc.status}`);

  const convos = await linus.json('/api/conversations');
  const preview = (convos.body?.conversations ?? []).find((c) => c.room.id === roomId)?.lastMessage;
  check(
    'rail preview carries the whole ciphertext (GCM tag intact)',
    preview?.encVersion === 1 && preview.body === stored.body,
  );

  /* ---- access control ---------------------------------------------------- */
  section('Access control');

  const ghost = await dave.json('/api/rooms/room_does_not_exist/messages');
  const probes = [
    ['read history', await dave.json(`/api/rooms/${roomId}/messages`)],
    ['post', await dave.post(`/api/rooms/${roomId}/messages`, { body: 'hi' })],
    ['typing', await dave.post(`/api/rooms/${roomId}/typing`, { typing: true })],
    ['start a call', await dave.post(`/api/rooms/${roomId}/calls`, { media: 'audio' })],
  ];
  for (const [name, result] of probes) {
    check(`non-member: ${name} → 404`, result.status === 404, `HTTP ${result.status}`);
  }
  check('indistinguishable from a nonexistent room', probes.every(([, r]) => r.status === ghost.status));
  const streamProbe = await dave.fetch(`/api/stream?roomId=${roomId}`);
  check('non-member: stream → 404', streamProbe.status === 404, `HTTP ${streamProbe.status}`);
  await streamProbe.body?.cancel().catch(() => undefined);

  /* ---- live delivery ----------------------------------------------------- */
  section('Live delivery (SSE)');

  const marker = `sse ${suffix}`;
  const watching = collectFrames(ada, '/api/stream?roomId=general', (frames) =>
    frames.some((f) => f.event === 'message' && f.data?.body === marker),
  );
  await new Promise((r) => setTimeout(r, 2500));
  await linus.post('/api/rooms/general/messages', { body: marker, clientNonce: nonce() });
  const live = await watching;
  check('stream handshake', live.frames.some((f) => f.event === 'ready'));
  const liveMessage = live.frames.find((f) => f.event === 'message' && f.data?.body === marker);
  check('message delivered live', Boolean(liveMessage));
  check('frame carries a resume cursor', Boolean(liveMessage?.id));

  /* ---- calls ------------------------------------------------------------- */
  section('Calls');

  const userStream = collectFrames(linus, '/api/stream?scope=user', (frames) =>
    frames.some((f) => f.event === 'signal') && frames.some((f) => f.event === 'call'),
  );
  await new Promise((r) => setTimeout(r, 2000));

  const call = await ada.post(`/api/rooms/${roomId}/calls`, { media: 'video', clientNonce: nonce() });
  const callId = call.body?.call?.id;
  check('call started', call.status === 201 && call.body?.call?.state === 'ringing', `HTTP ${call.status}`);

  const adaKeys = await ada.keysFor(linus, roomId);
  const sigNonce = nonce();
  const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 203.0.113.7\r\n' };
  const sealedOffer = await sealSignal(adaKeys.signalKey, offer, {
    roomId,
    senderId: ada.user.id,
    epoch: adaKeys.epoch,
    callId,
    nonce: sigNonce,
  });
  const signalled = await ada.post(`/api/calls/${callId}/signal`, {
    kind: 'offer',
    sigNonce,
    iv: sealedOffer.iv,
    payload: sealedOffer.body,
  });
  check('sealed offer relayed', signalled.status === 202, `HTTP ${signalled.status}`);

  const received = await userStream;
  const ring = received.frames.find((f) => f.event === 'call' && f.data?.id === callId);
  check('callee is rung over their user stream', ring?.data?.state === 'ringing');
  const signalFrame = received.frames.find((f) => f.event === 'signal' && f.data?.callId === callId);
  check('signal delivered with a resume cursor', Boolean(signalFrame?.id));
  check('server never saw the SDP', signalFrame && !JSON.stringify(signalFrame.data).includes('203.0.113.7'));
  let openedOffer = null;
  try {
    openedOffer = await openSignal(linusKeys.signalKey, { body: signalFrame.data.payload, iv: signalFrame.data.iv }, {
      roomId,
      senderId: ada.user.id,
      epoch: linusKeys.epoch,
      callId,
      nonce: signalFrame.data.sigNonce,
    });
  } catch {
    /* reported below */
  }
  check('callee opens the sealed offer', openedOffer?.sdp === offer.sdp);

  const glare = await linus.post(`/api/rooms/${roomId}/calls`, { media: 'audio', clientNonce: nonce() });
  check('calling back while being rung returns glare', glare.status === 409 && glare.body?.reason === 'glare' && glare.body?.callId === callId);

  const busy = await grace.post(`/api/conversations`, { userId: ada.user.id }).then((r) =>
    grace.post(`/api/rooms/${r.body.conversation.room.id}/calls`, { media: 'audio', clientNonce: nonce() }),
  );
  check('calling someone already in a call returns busy', busy.status === 409 && busy.body?.reason === 'busy', `HTTP ${busy.status}`);

  const callerAccepts = await ada.post(`/api/calls/${callId}/state`, { action: 'accept' });
  check('caller cannot answer their own call', callerAccepts.status === 409, `HTTP ${callerAccepts.status}`);

  const outsider = await dave.post(`/api/calls/${callId}/state`, { action: 'end' });
  check('outsider cannot touch the call', outsider.status === 404, `HTTP ${outsider.status}`);

  const answered = await linus.post(`/api/calls/${callId}/state`, { action: 'accept' });
  check('callee answers', answered.status === 200 && answered.body?.call?.state === 'accepted');

  const beat = await ada.post(`/api/calls/${callId}/heartbeat`);
  check('heartbeat while connected', beat.status === 204, `HTTP ${beat.status}`);

  const [endA, endB] = await Promise.all([
    ada.post(`/api/calls/${callId}/state`, { action: 'end' }),
    linus.post(`/api/calls/${callId}/state`, { action: 'end' }),
  ]);
  const endStatuses = [endA.status, endB.status].sort().join(',');
  check('both hang up at once: exactly one wins', endStatuses === '200,409', endStatuses);

  const late = await ada.post(`/api/calls/${callId}/signal`, {
    kind: 'ice',
    sigNonce: nonce(),
    iv: sealedOffer.iv,
    payload: sealedOffer.body,
  });
  check('signalling refused after hang-up', late.status === 409, `HTTP ${late.status}`);

  const history2 = await ada.json(`/api/rooms/${roomId}/calls`);
  check('call recorded in history', (history2.body?.calls ?? []).some((c) => c.id === callId && c.state === 'ended'));

  const ice = await ada.json('/api/ice');
  check('ICE servers served', (ice.body?.iceServers ?? []).length > 0, `relay: ${ice.body?.relay}`);

  /* ---- blocking ---------------------------------------------------------- */
  section('Blocking');

  const blocked = await linus.post('/api/blocks', { userId: ada.user.id });
  check('block', blocked.status === 204, `HTTP ${blocked.status}`);

  const afterBlock = [
    ['history', await ada.json(`/api/rooms/${roomId}/messages`)],
    ['send', await ada.sendEncrypted(linus, roomId, 'still there?')],
    ['typing', await ada.post(`/api/rooms/${roomId}/typing`, { typing: true })],
    ['call', await ada.post(`/api/rooms/${roomId}/calls`, { media: 'audio', clientNonce: nonce() })],
  ];
  for (const [name, result] of afterBlock) {
    check(`blocked user: ${name} → 404`, result.status === 404, `HTTP ${result.status}`);
  }
  const adaConvos = await ada.json('/api/conversations');
  check(
    'conversation vanishes from the blocked user’s list',
    !(adaConvos.body?.conversations ?? []).some((c) => c.room.id === roomId),
  );
  const reRequest = await ada.post('/api/friends/requests', { userId: linus.user.id });
  check('blocked user cannot send a request (looks like "no such person")', reRequest.status === 404, `HTTP ${reRequest.status}`);

  const blockerReads = await linus.json(`/api/rooms/${roomId}/messages`);
  check('blocker keeps their own history', blockerReads.status === 200);
  const blockerSends = await linus.sendEncrypted(ada, roomId, 'after block');
  check('blocker cannot keep sending', blockerSends.status === 403, `HTTP ${blockerSends.status}`);

  const blockList = await linus.json('/api/blocks');
  check('block list shows it', (blockList.body?.blocked ?? []).some((u) => u.id === ada.user.id));
  const adaBlockList = await ada.json('/api/blocks');
  check('nobody can see who blocked them', !(adaBlockList.body?.blocked ?? []).some((u) => u.id === linus.user.id));

  await linus.del(`/api/blocks/${ada.user.id}`);
  const restored = await ada.json(`/api/rooms/${roomId}/messages`);
  check('unblock restores the conversation', restored.status === 200);
  const relation = await ada.json(`/api/directory?q=${linus.username}`);
  check(
    'unblock returns them to strangers, not friends',
    (relation.body?.people ?? []).some((p) => p.id === linus.user.id && p.relation === 'none'),
  );

  /* ---- concurrency ------------------------------------------------------- */
  section('Concurrency');

  const opened2 = await carol.post('/api/conversations', { userId: dave.user.id });
  const room2 = opened2.body?.conversation?.room?.id;
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? carol.sendEncrypted(dave, room2, `burst ${i}`)
        : dave.sendEncrypted(carol, room2, `burst ${i}`),
    ),
  );
  const ok = burst.filter((r) => r.status === 201).length;
  check('20 concurrent encrypted sends accepted', ok === 20, `${ok}/20`);
  check('no server errors under load', burst.every((r) => r.status < 500));
  const burstHistory = await carol.json(`/api/rooms/${room2}/messages?limit=100`);
  const daveKeys = await dave.keysFor(carol, room2);
  let readable = 0;
  for (const message of burstHistory.body?.messages ?? []) {
    const keys = message.author.id === carol.user.id ? daveKeys : await carol.keysFor(dave, room2);
    try {
      await decryptMessage({
        messageKey: keys.messageKey,
        roomId: room2,
        senderId: message.author.id,
        epoch: message.epoch,
        clientNonce: message.clientNonce,
        body: message.body,
        iv: message.iv,
      });
      readable += 1;
    } catch {
      /* counted below */
    }
  }
  check('every one persisted and decrypts', readable === 20, `${readable}/20`);

  /* ---- legacy upgrade (optional) ----------------------------------------- */
  if (process.env.LEGACY_ACCOUNT) {
    section('Legacy account upgrade');
    const [username, password] = process.env.LEGACY_ACCOUNT.split(':');
    const legacy = new Client('legacy');
    legacy.username = username;

    const master = await deriveMasterKey(password, username);
    const authSecret = await deriveAuthSecret(master, username);
    const first = await legacy.post('/api/auth/login', { username, authSecret });
    check('new-style sign-in reports a pre-encryption account', first.status === 401 && first.body?.legacy === true);

    const noProof = await legacy.post('/api/auth/login', { username, password: 'wrong', upgrade: {} });
    check('upgrade refused without the right password', noProof.status === 400 || noProof.status === 401);

    legacy.identity = await generateIdentity();
    const vaultId = newVaultId();
    const sealed = await wrapVault(
      await deriveVaultKey(master, username),
      { v: 1, ecdhPkcs8: legacy.identity.privateKey, pins: {}, rooms: {}, retired: [] },
      vaultId,
      1,
    );
    const upgrade = {
      authSecret,
      vaultId,
      identityPub: legacy.identity.publicKey,
      vault: { ct: sealed.ciphertext, iv: sealed.iv },
    };
    const staleCookie = new Client('stale');
    await staleCookie.post('/api/auth/login', { username, password, upgrade: { ...upgrade, authSecret: 'x' } });

    const upgraded = await legacy.post('/api/auth/login', { username, password, upgrade });
    check('one-time upgrade succeeds', upgraded.status === 200 && upgraded.body?.upgraded === true, `HTTP ${upgraded.status}`);

    const replay = await new Client('again').post('/api/auth/login', { username, password, upgrade });
    check('raw password refused from then on', replay.status === 401, `HTTP ${replay.status}`);

    const after = await legacy.login(password);
    check('signs in the new way afterwards', after.status === 200, `HTTP ${after.status}`);
    check('upgraded vault opens', after.vaultOpened === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`Failed: ${failures.join(' | ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nVerification aborted:', error);
  process.exit(1);
});
