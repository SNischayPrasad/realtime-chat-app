/**
 * Crypto tests. Run with:  npm run test:crypto
 *
 * These run under Node's own webcrypto, which is the same API the browser uses,
 * so what passes here is what ships. The suite deliberately spends most of its
 * effort trying to BREAK the construction rather than confirming happy paths:
 * a round-trip test proves almost nothing about an AEAD.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainLink,
  computeEpoch,
  conversationKey,
  decryptMessage,
  deriveAuthSecret,
  deriveConversationKeys,
  deriveMasterKey,
  deriveVaultKey,
  encryptMessage,
  fromBase64Url,
  generateIdentity,
  importPrivateKey,
  importPublicKey,
  kdfSalt,
  newVaultId,
  openSignal,
  PADDING_BLOCK,
  pinHash,
  safetyNumber,
  sealSignal,
  toBase64Url,
  unwrapVault,
  wrapVault,
  type VaultPlaintext,
} from './crypto.ts';

const PASSWORD = 'correct-horse-battery-staple';
const ALICE = 'usr_alice0000000000000000000000';
const BOB = 'usr_bob00000000000000000000000';

/** Building two participants is expensive (PBKDF2), so it is done once. */
async function pair() {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const dmKey = conversationKey(ALICE, BOB);
  const roomId = 'room_test';
  const epoch = await computeEpoch(ALICE, alice.publicKey, BOB, bob.publicKey);

  const aliceKeys = await deriveConversationKeys(
    await importPrivateKey(alice.privateKey),
    await importPublicKey(bob.publicKey),
    dmKey,
    roomId,
    epoch,
  );
  const bobKeys = await deriveConversationKeys(
    await importPrivateKey(bob.privateKey),
    await importPublicKey(alice.publicKey),
    dmKey,
    roomId,
    epoch,
  );
  return { alice, bob, dmKey, roomId, epoch, aliceKeys, bobKeys };
}

/* -------------------------------------------------------------------------- */

test('base64url round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
  assert.deepEqual(Array.from(fromBase64Url(toBase64Url(bytes))), Array.from(bytes));
  // URL-safe alphabet only.
  assert.match(toBase64Url(bytes), /^[A-Za-z0-9_-]+$/);
});

test('the KDF salt is deterministic and case-insensitive on username', async () => {
  const a = await kdfSalt('Ada');
  const b = await kdfSalt('ada');
  assert.deepEqual(Array.from(a), Array.from(b));
  const other = await kdfSalt('linus');
  assert.notDeepEqual(Array.from(a), Array.from(other));
});

test('the server cannot derive the vault key from the auth secret', async () => {
  const master = await deriveMasterKey(PASSWORD, 'ada');
  const authSecret = await deriveAuthSecret(master, 'ada');
  const vaultKey = await deriveVaultKey(master, 'ada');

  // The auth secret is what the server receives. It must not equal, contain, or
  // be usable as the wrapping key.
  assert.equal(authSecret.length, 64);
  assert.match(authSecret, /^[0-9a-f]+$/);

  // The wrapping key is non-extractable, so it cannot leak even from the client.
  assert.equal(vaultKey.extractable, false);

  // Different labels must give independent output.
  const vault: VaultPlaintext = {
    v: 1,
    ecdhPkcs8: 'x',
    pins: {},
    rooms: {},
    retired: [],
  };
  const vaultId = newVaultId();
  const sealed = await wrapVault(vaultKey, vault, vaultId, 1);

  // A key built from the auth secret must not open the vault.
  const impostor = await globalThis.crypto.subtle.importKey(
    'raw',
    Buffer.from(authSecret, 'hex'),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  await assert.rejects(() => unwrapVault(impostor, sealed, vaultId, 1));
});

test('the same password on another device reproduces the same keys', async () => {
  const first = await deriveMasterKey(PASSWORD, 'ada');
  const second = await deriveMasterKey(PASSWORD, 'ada');
  assert.deepEqual(Array.from(first), Array.from(second));
  assert.equal(await deriveAuthSecret(first, 'ada'), await deriveAuthSecret(second, 'ada'));
});

test('a wrong password produces a different auth secret', async () => {
  const good = await deriveAuthSecret(await deriveMasterKey(PASSWORD, 'ada'), 'ada');
  const bad = await deriveAuthSecret(await deriveMasterKey(PASSWORD + '!', 'ada'), 'ada');
  assert.notEqual(good, bad);
});

/* -------------------------------------------------------------------------- */

test('vault: round-trips, and every wrap uses a fresh IV', async () => {
  const master = await deriveMasterKey(PASSWORD, 'ada');
  const key = await deriveVaultKey(master, 'ada');
  const identity = await generateIdentity();
  const vaultId = newVaultId();

  const plaintext: VaultPlaintext = {
    v: 1,
    ecdhPkcs8: identity.privateKey,
    pins: { [BOB]: { keyHash: await pinHash(identity.publicKey), firstSeen: 'now', verifiedAt: null } },
    rooms: { room_x: { dmKey: 'a|b', e2eeSinceId: '12', epoch: 'deadbeef' } },
    retired: [],
  };

  const one = await wrapVault(key, plaintext, vaultId, 1);
  const two = await wrapVault(key, plaintext, vaultId, 1);

  // Nonce reuse under one key is what turns AES-GCM from confidential into
  // readable, so identical input must still produce distinct IVs.
  assert.notEqual(one.iv, two.iv);
  assert.notEqual(one.ciphertext, two.ciphertext);

  const opened = await unwrapVault(key, one, vaultId, 1);
  assert.deepEqual(opened, plaintext);
});

test('vault: a replayed older version is rejected', async () => {
  const key = await deriveVaultKey(await deriveMasterKey(PASSWORD, 'ada'), 'ada');
  const vaultId = newVaultId();
  const v1 = await wrapVault(key, { v: 1, ecdhPkcs8: 'old', pins: {}, rooms: {}, retired: [] }, vaultId, 1);

  // Serving version 1's bytes while claiming version 2 must fail.
  await assert.rejects(() => unwrapVault(key, v1, vaultId, 2));
});

test('vault: a vault from another account is rejected', async () => {
  const key = await deriveVaultKey(await deriveMasterKey(PASSWORD, 'ada'), 'ada');
  const mine = newVaultId();
  const theirs = newVaultId();
  const sealed = await wrapVault(key, { v: 1, ecdhPkcs8: 'x', pins: {}, rooms: {}, retired: [] }, mine, 1);
  await assert.rejects(() => unwrapVault(key, sealed, theirs, 1));
});

test('vault: the recovery wrapping is a separate domain', async () => {
  const key = await deriveVaultKey(await deriveMasterKey(PASSWORD, 'ada'), 'ada');
  const vaultId = newVaultId();
  const sealed = await wrapVault(key, { v: 1, ecdhPkcs8: 'x', pins: {}, rooms: {}, retired: [] }, vaultId, 1, 'recovery');
  // Opened as a normal vault it must fail, even with the right key and version.
  await assert.rejects(() => unwrapVault(key, sealed, vaultId, 1, 'vault'));
  assert.ok(await unwrapVault(key, sealed, vaultId, 1, 'recovery'));
});

/* -------------------------------------------------------------------------- */

test('both sides independently agree on the conversation key and epoch', async () => {
  const { alice, bob, epoch } = await pair();
  // Order of arguments must not matter — both screens must agree.
  const reversed = await computeEpoch(BOB, bob.publicKey, ALICE, alice.publicKey);
  assert.equal(epoch, reversed);
  assert.equal(conversationKey(ALICE, BOB), conversationKey(BOB, ALICE));
});

test('the epoch changes if either identity key changes', async () => {
  const { alice, bob, epoch } = await pair();
  const impostor = await generateIdentity();
  const swapped = await computeEpoch(ALICE, alice.publicKey, BOB, impostor.publicKey);
  assert.notEqual(epoch, swapped);
});

test('a message encrypted by one side decrypts on the other', async () => {
  const { roomId, epoch, dmKey, aliceKeys, bobKeys } = await pair();
  const clientNonce = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));

  const sealed = await encryptMessage({
    messageKey: aliceKeys.messageKey,
    roomId,
    senderId: ALICE,
    epoch,
    dmKey,
    clientNonce,
    text: 'the eagle lands at dawn',
    seq: 1,
    prev: null,
  });

  const opened = await decryptMessage({
    messageKey: bobKeys.messageKey,
    roomId,
    senderId: ALICE,
    epoch,
    clientNonce,
    body: sealed.body,
    iv: sealed.iv,
  });

  assert.equal(opened.text, 'the eagle lands at dawn');
  assert.equal(opened.seq, 1);
  assert.equal(opened.prev, null);
});

test('ciphertext length leaks only a padding bucket', async () => {
  const { roomId, epoch, dmKey, aliceKeys } = await pair();
  const lengths = new Set<number>();
  for (const text of ['a', 'hello', 'x'.repeat(80), 'y'.repeat(200)]) {
    const sealed = await encryptMessage({
      messageKey: aliceKeys.messageKey,
      roomId,
      senderId: ALICE,
      epoch,
      dmKey,
      clientNonce: 'nonce',
      text,
      seq: 1,
      prev: null,
    });
    lengths.add(fromBase64Url(sealed.body).length);
  }
  // Four very different message lengths must collapse into one bucket.
  assert.equal(lengths.size, 1, `expected one bucket, got ${[...lengths].join(', ')}`);
});

test('a long unicode message still fits the ciphertext cap', async () => {
  const { roomId, epoch, dmKey, aliceKeys } = await pair();
  const text = '🎉'.repeat(2000); // worst case: 4 UTF-8 bytes per character
  const sealed = await encryptMessage({
    messageKey: aliceKeys.messageKey,
    roomId,
    senderId: ALICE,
    epoch,
    dmKey,
    clientNonce: 'nonce',
    text,
    seq: 1,
    prev: null,
  });
  assert.ok(
    sealed.body.length <= 12000,
    `ciphertext ${sealed.body.length} exceeds the 12000 cap — a legitimate message would be rejected`,
  );
});

test('the two senders occupy disjoint IV space', async () => {
  const { roomId, epoch, dmKey, aliceKeys, bobKeys } = await pair();
  const fromAlice = await encryptMessage({
    messageKey: aliceKeys.messageKey, roomId, senderId: ALICE, epoch, dmKey,
    clientNonce: 'n', text: 'a', seq: 1, prev: null,
  });
  const fromBob = await encryptMessage({
    messageKey: bobKeys.messageKey, roomId, senderId: BOB, epoch, dmKey,
    clientNonce: 'n', text: 'a', seq: 1, prev: null,
  });
  const tagA = Array.from(fromBase64Url(fromAlice.iv).slice(0, 4)).join(',');
  const tagB = Array.from(fromBase64Url(fromBob.iv).slice(0, 4)).join(',');
  assert.notEqual(tagA, tagB, 'sender tags collide — IV reuse across senders is possible');
});

test('repeated encryption never repeats an IV', async () => {
  const { roomId, epoch, dmKey, aliceKeys } = await pair();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const sealed = await encryptMessage({
      messageKey: aliceKeys.messageKey, roomId, senderId: ALICE, epoch, dmKey,
      clientNonce: `n${i}`, text: 'same text every time', seq: i, prev: null,
    });
    assert.ok(!seen.has(sealed.iv), 'IV repeated');
    seen.add(sealed.iv);
  }
});

/* -------------------------------------------------------------------------- */
/* The AAD is what stops a server moving ciphertext around                    */
/* -------------------------------------------------------------------------- */

test('ciphertext cannot be relocated, re-attributed, or replayed', async () => {
  const { roomId, epoch, dmKey, aliceKeys, bobKeys } = await pair();
  const clientNonce = 'nonce-1';
  const sealed = await encryptMessage({
    messageKey: aliceKeys.messageKey, roomId, senderId: ALICE, epoch, dmKey,
    clientNonce, text: 'confidential', seq: 1, prev: null,
  });

  const base = {
    messageKey: bobKeys.messageKey,
    roomId, senderId: ALICE, epoch, clientNonce,
    body: sealed.body, iv: sealed.iv,
  };
  // Sanity: unmodified, it opens.
  assert.ok(await decryptMessage(base));

  await assert.rejects(
    () => decryptMessage({ ...base, roomId: 'room_other' }),
    'a ciphertext moved to another room must not decrypt',
  );
  await assert.rejects(
    () => decryptMessage({ ...base, senderId: BOB }),
    'a ciphertext re-attributed to the other user must not decrypt',
  );
  await assert.rejects(
    () => decryptMessage({ ...base, clientNonce: 'nonce-2' }),
    'a ciphertext replayed under a new id must not decrypt',
  );
  await assert.rejects(
    () => decryptMessage({ ...base, epoch: 'ffffffff' }),
    'a ciphertext under a different epoch must not decrypt',
  );
});

test('a tampered ciphertext byte is rejected', async () => {
  const { roomId, epoch, dmKey, aliceKeys, bobKeys } = await pair();
  const sealed = await encryptMessage({
    messageKey: aliceKeys.messageKey, roomId, senderId: ALICE, epoch, dmKey,
    clientNonce: 'n', text: 'confidential', seq: 1, prev: null,
  });
  const bytes = fromBase64Url(sealed.body);
  bytes[5] ^= 0x01;
  await assert.rejects(() =>
    decryptMessage({
      messageKey: bobKeys.messageKey, roomId, senderId: ALICE, epoch,
      clientNonce: 'n', body: toBase64Url(bytes), iv: sealed.iv,
    }),
  );
});

test('a third party with their own keys cannot read the conversation', async () => {
  const { roomId, epoch, dmKey, aliceKeys } = await pair();
  const sealed = await encryptMessage({
    messageKey: aliceKeys.messageKey, roomId, senderId: ALICE, epoch, dmKey,
    clientNonce: 'n', text: 'private', seq: 1, prev: null,
  });

  const eve = await generateIdentity();
  const alice = await generateIdentity();
  const eveKeys = await deriveConversationKeys(
    await importPrivateKey(eve.privateKey),
    await importPublicKey(alice.publicKey),
    dmKey, roomId, epoch,
  );
  await assert.rejects(() =>
    decryptMessage({
      messageKey: eveKeys.messageKey, roomId, senderId: ALICE, epoch,
      clientNonce: 'n', body: sealed.body, iv: sealed.iv,
    }),
  );
});

test('a call signal cannot be served as a chat message', async () => {
  const { roomId, epoch, dmKey, aliceKeys, bobKeys } = await pair();
  const signal = await sealSignal(
    aliceKeys.signalKey,
    { sdp: 'v=0...' },
    { roomId, senderId: ALICE, epoch, callId: 'call_1', nonce: 'sig-1' },
  );

  // Same room, same sender, same epoch — only the key and label differ.
  await assert.rejects(
    () =>
      decryptMessage({
        messageKey: bobKeys.messageKey, roomId, senderId: ALICE, epoch,
        clientNonce: 'sig-1', body: signal.body, iv: signal.iv,
      }),
    'a signal envelope must not open as a message envelope',
  );

  // And it opens correctly in its own domain.
  const opened = await openSignal<{ sdp: string }>(bobKeys.signalKey, signal, {
    roomId, senderId: ALICE, epoch, callId: 'call_1', nonce: 'sig-1',
  });
  assert.equal(opened.sdp, 'v=0...');
});

test('a signal cannot be replayed under a different call id', async () => {
  const { roomId, epoch, aliceKeys, bobKeys } = await pair();
  const signal = await sealSignal(
    aliceKeys.signalKey, { candidate: 'x' },
    { roomId, senderId: ALICE, epoch, callId: 'call_1', nonce: 'sig-1' },
  );
  await assert.rejects(() =>
    openSignal(bobKeys.signalKey, signal, {
      roomId, senderId: ALICE, epoch, callId: 'call_2', nonce: 'sig-1',
    }),
  );
});

/* -------------------------------------------------------------------------- */

test('the safety number is identical on both screens and moves if a key changes', async () => {
  const { alice, bob } = await pair();
  const mine = await safetyNumber(ALICE, alice.publicKey, BOB, bob.publicKey);
  const theirs = await safetyNumber(BOB, bob.publicKey, ALICE, alice.publicKey);
  assert.equal(mine, theirs, 'the two participants must see the same digits');
  assert.match(mine, /^(\d{5} ){5}\d{5}  (\d{5} ){5}\d{5}$/);

  const impostor = await generateIdentity();
  const swapped = await safetyNumber(ALICE, alice.publicKey, BOB, impostor.publicKey);
  assert.notEqual(mine, swapped, 'a substituted key must change the safety number');
});

test('the chain link changes with the ciphertext', async () => {
  const a = await chainLink(toBase64Url(new Uint8Array([1, 2, 3])));
  const b = await chainLink(toBase64Url(new Uint8Array([1, 2, 4])));
  assert.notEqual(a, b);
  assert.equal(a, await chainLink(toBase64Url(new Uint8Array([1, 2, 3]))));
});

test('padding never shrinks a message below its own length', async () => {
  const { roomId, epoch, dmKey, aliceKeys, bobKeys } = await pair();
  const text = 'z'.repeat(PADDING_BLOCK * 2 + 7);
  const sealed = await encryptMessage({
    messageKey: aliceKeys.messageKey, roomId, senderId: ALICE, epoch, dmKey,
    clientNonce: 'n', text, seq: 1, prev: null,
  });
  const opened = await decryptMessage({
    messageKey: bobKeys.messageKey, roomId, senderId: ALICE, epoch,
    clientNonce: 'n', body: sealed.body, iv: sealed.iv,
  });
  assert.equal(opened.text, text);
});
