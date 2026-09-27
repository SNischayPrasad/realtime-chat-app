/**
 * Seeds a running instance with demo accounts, friendships, a public
 * conversation and two end-to-end encrypted private ones. Useful for
 * screenshots and for trying the app quickly.
 *
 *   npm run seed -- [baseUrl]
 *
 * Default baseUrl is http://localhost:3000. Accounts are created if missing and
 * reused if they exist, so it is safe to run more than once.
 *
 * Like a real client, it never sends a password: keys are derived and messages
 * are encrypted with the app's own src/lib/e2ee/crypto.ts.
 */

import {
  computeEpoch,
  conversationKey,
  deriveAuthSecret,
  deriveConversationKeys,
  deriveMasterKey,
  deriveVaultKey,
  encryptMessage,
  generateIdentity,
  importPrivateKey,
  importPublicKey,
  newVaultId,
  toBase64Url,
  unwrapVault,
  wrapVault,
} from '../src/lib/e2ee/crypto.ts';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

const PEOPLE = [
  { username: 'ada', displayName: 'Ada Lovelace', password: 'analytical-engine' },
  { username: 'linus', displayName: 'Linus Tan', password: 'kernel-panic-99' },
  { username: 'grace', displayName: 'Grace Okafor', password: 'nanoseconds-1906' },
];

const people = new Map();

async function api(person, path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  if (person.cookie) headers.cookie = person.cookie;
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    if (pair.startsWith('chat_session=')) person.cookie = pair;
  }
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function signIn(spec) {
  const person = { ...spec, cookie: null };
  const master = await deriveMasterKey(spec.password, spec.username);
  const authSecret = await deriveAuthSecret(master, spec.username);
  const vaultKey = await deriveVaultKey(master, spec.username);

  let { status, data } = await api(person, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: spec.username, authSecret }),
  });

  if (status === 200) {
    const vault = await unwrapVault(
      vaultKey,
      { ciphertext: data.keys.vault.ct, iv: data.keys.vault.iv },
      data.keys.vaultId,
      data.keys.vault.version,
    );
    person.identity = { privateKey: vault.ecdhPkcs8, publicKey: data.keys.identityPub };
    console.log(`  signed in  @${spec.username}`);
  } else {
    person.identity = await generateIdentity();
    const vaultId = newVaultId();
    const sealed = await wrapVault(
      vaultKey,
      { v: 1, ecdhPkcs8: person.identity.privateKey, pins: {}, rooms: {}, retired: [] },
      vaultId,
      1,
    );
    ({ status, data } = await api(person, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: spec.username,
        displayName: spec.displayName,
        authSecret,
        vaultId,
        identityPub: person.identity.publicKey,
        vault: { ct: sealed.ciphertext, iv: sealed.iv },
      }),
    }));
    if (status !== 201) throw new Error(`register @${spec.username} -> ${status} ${JSON.stringify(data)}`);
    console.log(`  registered @${spec.username}`);
  }
  person.user = data.user;
  people.set(spec.username, person);
  return person;
}

async function befriend(a, b) {
  await api(a, '/api/friends/requests', {
    method: 'POST',
    body: JSON.stringify({ userId: b.user.id }),
  });
  await api(b, `/api/friends/requests/${a.user.id}/accept`, { method: 'POST' });
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

async function say(person, roomId, body) {
  const nonce = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const { status } = await api(person, `/api/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body, clientNonce: nonce }),
  });
  if (status !== 201) throw new Error(`post to ${roomId} -> ${status}`);
  await pause();
}

async function whisper(from, to, roomId, text) {
  const dmKey = conversationKey(from.user.id, to.user.id);
  const epoch = await computeEpoch(
    from.user.id,
    from.identity.publicKey,
    to.user.id,
    to.identity.publicKey,
  );
  const { messageKey } = await deriveConversationKeys(
    await importPrivateKey(from.identity.privateKey),
    await importPublicKey(to.identity.publicKey),
    dmKey,
    roomId,
    epoch,
  );
  const clientNonce = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const sealed = await encryptMessage({
    messageKey,
    roomId,
    senderId: from.user.id,
    epoch,
    dmKey,
    clientNonce,
    text,
    seq: 1,
    prev: null,
  });
  const { status, data } = await api(from, `/api/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ encVersion: 1, body: sealed.body, iv: sealed.iv, epoch, clientNonce }),
  });
  if (status !== 201) throw new Error(`encrypted post -> ${status} ${JSON.stringify(data)}`);
  await pause();
}

async function directRoom(from, to) {
  const { status, data } = await api(from, '/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ userId: to.user.id }),
  });
  if (status >= 300) throw new Error(`open conversation -> ${status} ${JSON.stringify(data)}`);
  return data.conversation.room.id;
}

async function main() {
  console.log(`Seeding ${BASE}`);
  for (const spec of PEOPLE) await signIn(spec);
  const ada = people.get('ada');
  const linus = people.get('linus');
  const grace = people.get('grace');

  console.log('  making friends');
  await befriend(ada, linus);
  await befriend(grace, ada);

  console.log('  posting in #general (public, not end-to-end encrypted)');
  await say(grace, 'general', 'Morning all. Standup in ten, usual link.');
  await say(linus, 'general', 'On my way. I pushed the SSE reconnect fix late last night.');
  await say(ada, 'general', 'Saw it. The Last-Event-ID replay is exactly what we needed.');
  await say(linus, 'general', 'Yeah, no more gaps when the function hits its time budget.');

  console.log('  encrypted private chat between @ada and @linus');
  const adaLinus = await directRoom(ada, linus);
  await whisper(ada, linus, adaLinus, 'Before I raise it in the room - are we happy with the 50s stream budget?');
  await whisper(linus, ada, adaLinus, 'Honestly yes. Vercel caps the function at 60s, so closing at 50 keeps it clean.');
  await whisper(ada, linus, adaLinus, 'Good. Call me after standup? Want to walk through the key-change banner.');
  await whisper(linus, ada, adaLinus, 'Sure - video, so I can share my screen of the safety number dialog.');

  console.log('  an unread encrypted message from @grace to @ada');
  const graceAda = await directRoom(grace, ada);
  await whisper(grace, ada, graceAda, 'Can you review my PR before I merge it?');

  console.log('\nDone. Sign in as any of:');
  for (const spec of PEOPLE) console.log(`  @${spec.username} / ${spec.password}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
