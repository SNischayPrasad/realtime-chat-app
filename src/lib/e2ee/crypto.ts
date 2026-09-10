/**
 * End-to-end encryption primitives.
 *
 * Web Crypto only, so the exact same code runs in the browser and under Node's
 * `globalThis.crypto` — which means the test suite exercises the real thing
 * rather than a shim.
 *
 * Scope: private 1:1 conversations. Public rooms are not encrypted, because a
 * key that every member can fetch on joining an open room is not a secret.
 *
 * Read `docs/ENCRYPTION.md` for the threat model. The short version: this
 * protects your messages from a database dump, from network capture, and from
 * whoever operates the server reading them at rest. It does NOT protect you
 * from a server that ships malicious client JavaScript, and there is no forward
 * secrecy — one static key per conversation means a future key compromise
 * decrypts past ciphertext.
 */

const subtle = globalThis.crypto.subtle;

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', input as BufferSource));
}

/* -------------------------------------------------------------------------- */
/* Domain separation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every derived key and every AAD is prefixed with a distinct label. Two values
 * derived under different labels are computationally independent, which is what
 * stops the server — who legitimately receives `authSecret` — from computing the
 * vault key that protects the identity private key.
 */
const LABEL = {
  kdfSalt: 'transmission/v1/kdf-salt|',
  authVerifier: 'transmission/v1/auth-verifier',
  keyWrapping: 'transmission/v1/key-wrapping',
  vaultAad: 'transmission/v1/vault|',
  recoveryAad: 'transmission/v1/recovery|',
  epoch: 'transmission/v1/epoch|',
  dmSalt: 'transmission/v1/dm/',
  messageKey: 'transmission/v1/dm-message-key|',
  signalKey: 'transmission/v1/dm-signal-key|',
  ivTag: 'transmission/v1/iv-tag|',
  messageAad: 'transmission/v1/msg|',
  signalAad: 'transmission/v1/signal|',
  fingerprint: 'transmission/v1',
} as const;

/** Client-side constants. Nothing about the KDF is fetched from the server, so
 *  a hostile server cannot serve `iterations: 1` and turn the auth secret it
 *  receives at login into a one-millisecond password cracker. */
export const KDF_ITERATIONS = 600_000;
export const KDF_VERSION = 1;

/** Plaintext is padded to a multiple of this, so ciphertext length leaks a
 *  bucket rather than a character count. */
export const PADDING_BLOCK = 256;

/* -------------------------------------------------------------------------- */
/* Password derivation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The salt is derived from the username rather than stored server-side. A salt
 * must be unique, not secret or unpredictable, and the username already is
 * unique — so there is nothing for the client to fetch and therefore nothing
 * for a hostile server to lie about.
 */
export async function kdfSalt(username: string): Promise<Uint8Array> {
  return sha256(utf8.encode(LABEL.kdfSalt + username.toLowerCase()));
}

async function hkdfBase(material: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

/** PBKDF2 over the password. Everything else derives from this. */
export async function deriveMasterKey(password: string, username: string): Promise<Uint8Array> {
  const salt = await kdfSalt(username);
  const base = await subtle.importKey('raw', utf8.encode(password) as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** Sent to the server in place of the password. The server scrypt-hashes it
 *  again, so its database still never holds a directly usable verifier. */
export async function deriveAuthSecret(masterKey: Uint8Array, username: string): Promise<string> {
  const salt = await kdfSalt(username);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8.encode(LABEL.authVerifier) as BufferSource },
    await hkdfBase(masterKey),
    256,
  );
  return toHex(bits);
}

/** Never leaves the browser. Unwraps the vault holding the identity key. */
export async function deriveVaultKey(masterKey: Uint8Array, username: string): Promise<CryptoKey> {
  const salt = await kdfSalt(username);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8.encode(LABEL.keyWrapping) as BufferSource },
    await hkdfBase(masterKey),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export type IdentityKeyPair = {
  /** base64url SPKI — handed to anyone who opens a conversation with you. */
  publicKey: string;
  /** base64url PKCS8 — only ever stored inside the encrypted vault. */
  privateKey: string;
};

/**
 * P-256 rather than X25519: X25519 reached Web Crypto only recently and older
 * iOS Safari has no support and no fallback without pulling in a crypto
 * library, which would defeat the point of auditable browser-native crypto.
 *
 * There is deliberately no second (signing) keypair. Call setup gets its
 * integrity from sealing under the ECDH-derived key; a signing key that the
 * safety number did not cover would be a silent path for key substitution.
 */
export async function generateIdentity(): Promise<IdentityKeyPair> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const [spki, pkcs8] = await Promise.all([
    subtle.exportKey('spki', pair.publicKey),
    subtle.exportKey('pkcs8', pair.privateKey),
  ]);
  return { publicKey: toBase64Url(spki), privateKey: toBase64Url(pkcs8) };
}

export async function importPublicKey(spkiBase64Url: string): Promise<CryptoKey> {
  return subtle.importKey(
    'spki',
    fromBase64Url(spkiBase64Url) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

export async function importPrivateKey(pkcs8Base64Url: string): Promise<CryptoKey> {
  return subtle.importKey(
    'pkcs8',
    fromBase64Url(pkcs8Base64Url) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

/* -------------------------------------------------------------------------- */
/* Vault                                                                      */
/* -------------------------------------------------------------------------- */

export type VaultPlaintext = {
  v: 1;
  ecdhPkcs8: string;
  pins: Record<string, { keyHash: string; firstSeen: string; verifiedAt: string | null }>;
  rooms: Record<string, { dmKey: string; e2eeSinceId: string | null; epoch: string }>;
  retired: Array<{ ecdhPkcs8: string; epoch: string }>;
};

export type SealedVault = { ciphertext: string; iv: string };

/**
 * Generates its own IV rather than accepting one, so no caller can supply a
 * stale value and reuse a GCM nonce under the same key — the failure mode that
 * turns AES-GCM from confidential into readable.
 */
export async function wrapVault(
  vaultKey: CryptoKey,
  plaintext: VaultPlaintext,
  vaultId: string,
  version: number,
  label: 'vault' | 'recovery' = 'vault',
): Promise<SealedVault> {
  const iv = randomBytes(12);
  const aad = utf8.encode(
    (label === 'vault' ? LABEL.vaultAad : LABEL.recoveryAad) + vaultId + '|' + version,
  );
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    vaultKey,
    utf8.encode(JSON.stringify(plaintext)) as BufferSource,
  );
  return { ciphertext: toBase64Url(ciphertext), iv: toBase64Url(iv) };
}

export async function unwrapVault(
  vaultKey: CryptoKey,
  sealed: SealedVault,
  vaultId: string,
  version: number,
  label: 'vault' | 'recovery' = 'vault',
): Promise<VaultPlaintext> {
  const aad = utf8.encode(
    (label === 'vault' ? LABEL.vaultAad : LABEL.recoveryAad) + vaultId + '|' + version,
  );
  const plaintext = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(sealed.iv) as BufferSource,
      additionalData: aad as BufferSource,
    },
    vaultKey,
    fromBase64Url(sealed.ciphertext) as BufferSource,
  );
  return JSON.parse(utf8Decoder.decode(plaintext)) as VaultPlaintext;
}

/** 16 random bytes, chosen before the account exists — the user id is minted
 *  server-side in the same INSERT and so cannot appear in the vault's AAD. */
export function newVaultId(): string {
  return toBase64Url(randomBytes(16));
}

/* -------------------------------------------------------------------------- */
/* Conversation keys                                                          */
/* -------------------------------------------------------------------------- */

/** Recomputed locally from two user ids, never sent by the server, so the
 *  server cannot hand the two sides different values. */
export function conversationKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join('|');
}

/**
 * Both sides compute this independently from data they already fingerprint, so
 * the server cannot desync them or force a silent decryption failure.
 */
export async function computeEpoch(
  userIdA: string,
  publicKeyA: string,
  userIdB: string,
  publicKeyB: string,
): Promise<string> {
  const [low, high] =
    userIdA < userIdB
      ? [
          { id: userIdA, key: publicKeyA },
          { id: userIdB, key: publicKeyB },
        ]
      : [
          { id: userIdB, key: publicKeyB },
          { id: userIdA, key: publicKeyA },
        ];
  const digest = await sha256(
    utf8.encode(`${LABEL.epoch}${low.id}|${low.key}|${high.id}|${high.key}`),
  );
  return toHex(digest.slice(0, 4));
}

export type ConversationKeys = { messageKey: CryptoKey; signalKey: CryptoKey };

/**
 * Separate keys for chat and call signalling: the two codepaths cannot share a
 * nonce space, so a mistake in the calling code cannot damage message
 * confidentiality.
 */
export async function deriveConversationKeys(
  privateKey: CryptoKey,
  theirPublicKey: CryptoKey,
  dmKey: string,
  roomId: string,
  epoch: string,
): Promise<ConversationKeys> {
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: theirPublicKey }, privateKey, 256),
  );
  const base = await hkdfBase(shared);
  const salt = await sha256(utf8.encode(LABEL.dmSalt + dmKey));

  const derive = (info: string) =>
    subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8.encode(info) as BufferSource },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

  const [messageKey, signalKey] = await Promise.all([
    derive(`${LABEL.messageKey}${roomId}|${epoch}`),
    derive(`${LABEL.signalKey}${roomId}|${epoch}`),
  ]);
  return { messageKey, signalKey };
}

/* -------------------------------------------------------------------------- */
/* Message envelope                                                           */
/* -------------------------------------------------------------------------- */

export type MessagePlaintext = {
  v: 1;
  /** The sender's own clock. Rendered in the transcript; the server's
   *  `created_at` is advisory and flagged when the two diverge. */
  t: string;
  /** Monotone per sender per room — a repeat is a replay. */
  seq: number;
  /** First 16 bytes of SHA-256 of this sender's previous ciphertext in this
   *  room. A break in the chain means reordering or silent deletion. */
  prev: string | null;
  text: string;
  pad: string;
};

export type SealedMessage = { body: string; iv: string; epoch: string };

/**
 * The IV's first 4 bytes are a per-sender tag, so the two participants occupy
 * structurally disjoint IV space and cross-sender collision is impossible. A
 * counter was rejected: two devices of one user share the message key and their
 * counters would collide immediately.
 */
async function senderTag(dmKey: string, senderId: string): Promise<Uint8Array> {
  // The tag needs to be distinct per sender, not secret: it only partitions the
  // IV space so the two participants cannot collide. A plain hash of values
  // both sides already agree on is enough, and is obviously correct — deriving
  // it from the (non-extractable) message key would add nothing but a fallback
  // path to get wrong.
  const digest = await sha256(utf8.encode(LABEL.ivTag + dmKey + '|' + senderId));
  return digest.slice(0, 4);
}

function pad(text: string): string {
  const size = utf8.encode(text).length;
  const target = Math.ceil((size + 1) / PADDING_BLOCK) * PADDING_BLOCK;
  return ' '.repeat(Math.max(0, target - size));
}

export type EncryptMessageInput = {
  messageKey: CryptoKey;
  roomId: string;
  senderId: string;
  epoch: string;
  dmKey: string;
  clientNonce: string;
  text: string;
  seq: number;
  prev: string | null;
};

export async function encryptMessage(input: EncryptMessageInput): Promise<SealedMessage> {
  const plaintext: MessagePlaintext = {
    v: 1,
    t: new Date().toISOString(),
    seq: input.seq,
    prev: input.prev,
    text: input.text,
    pad: pad(input.text),
  };
  const tag = await senderTag(input.dmKey, input.senderId);
  const iv = concat(tag, randomBytes(8));
  const aad = utf8.encode(
    `${LABEL.messageAad}${input.roomId}|${input.senderId}|${input.epoch}|${input.clientNonce}`,
  );
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    input.messageKey,
    utf8.encode(JSON.stringify(plaintext)) as BufferSource,
  );
  return { body: toBase64Url(ciphertext), iv: toBase64Url(iv), epoch: input.epoch };
}

export type DecryptMessageInput = {
  messageKey: CryptoKey;
  roomId: string;
  senderId: string;
  epoch: string;
  clientNonce: string;
  body: string;
  iv: string;
};

export async function decryptMessage(input: DecryptMessageInput): Promise<MessagePlaintext> {
  const aad = utf8.encode(
    `${LABEL.messageAad}${input.roomId}|${input.senderId}|${input.epoch}|${input.clientNonce}`,
  );
  const plaintext = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(input.iv) as BufferSource,
      additionalData: aad as BufferSource,
    },
    input.messageKey,
    fromBase64Url(input.body) as BufferSource,
  );
  return JSON.parse(utf8Decoder.decode(plaintext)) as MessagePlaintext;
}

/** Chain link for the next message this sender writes in this room. */
export async function chainLink(ciphertextBase64Url: string): Promise<string> {
  const digest = await sha256(fromBase64Url(ciphertextBase64Url));
  return toBase64Url(digest.slice(0, 16));
}

/* -------------------------------------------------------------------------- */
/* Call signalling envelope                                                   */
/* -------------------------------------------------------------------------- */

export async function sealSignal(
  signalKey: CryptoKey,
  payload: unknown,
  context: { roomId: string; senderId: string; epoch: string; callId: string; nonce: string },
): Promise<{ body: string; iv: string }> {
  const iv = randomBytes(12);
  const aad = utf8.encode(
    `${LABEL.signalAad}${context.roomId}|${context.senderId}|${context.epoch}|${context.callId}|${context.nonce}`,
  );
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    signalKey,
    utf8.encode(JSON.stringify(payload)) as BufferSource,
  );
  return { body: toBase64Url(ciphertext), iv: toBase64Url(iv) };
}

export async function openSignal<T = unknown>(
  signalKey: CryptoKey,
  sealed: { body: string; iv: string },
  context: { roomId: string; senderId: string; epoch: string; callId: string; nonce: string },
): Promise<T> {
  const aad = utf8.encode(
    `${LABEL.signalAad}${context.roomId}|${context.senderId}|${context.epoch}|${context.callId}|${context.nonce}`,
  );
  const plaintext = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(sealed.iv) as BufferSource,
      additionalData: aad as BufferSource,
    },
    signalKey,
    fromBase64Url(sealed.body) as BufferSource,
  );
  return JSON.parse(utf8Decoder.decode(plaintext)) as T;
}

/* -------------------------------------------------------------------------- */
/* Safety numbers                                                             */
/* -------------------------------------------------------------------------- */

/** Deliberately iterated: users compare the first group or two, and ~33 bits of
 *  a single-hash prefix is grindable in seconds. */
const FINGERPRINT_ROUNDS = 5200;

async function fingerprintBytes(publicKey: string, userId: string): Promise<Uint8Array> {
  let digest = concat(utf8.encode(LABEL.fingerprint), fromBase64Url(publicKey), utf8.encode(userId));
  for (let i = 0; i < FINGERPRINT_ROUNDS; i += 1) {
    digest = new Uint8Array(await subtle.digest('SHA-512', digest as BufferSource));
  }
  return digest.slice(0, 30);
}

function digitGroups(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    let value = 0n;
    for (let j = 0; j < 5; j += 1) value = value * 256n + BigInt(bytes[i + j]);
    out += (value % 100000n).toString().padStart(5, '0') + ' ';
  }
  return out.trim();
}

/**
 * Both screens must show identical digits, so the halves are ordered by user id
 * — the same ordering `conversationKey` uses.
 */
export async function safetyNumber(
  userIdA: string,
  publicKeyA: string,
  userIdB: string,
  publicKeyB: string,
): Promise<string> {
  const [low, high] =
    userIdA < userIdB
      ? [
          { id: userIdA, key: publicKeyA },
          { id: userIdB, key: publicKeyB },
        ]
      : [
          { id: userIdB, key: publicKeyB },
          { id: userIdA, key: publicKeyA },
        ];
  const [a, b] = await Promise.all([
    fingerprintBytes(low.key, low.id),
    fingerprintBytes(high.key, high.id),
  ]);
  return `${digitGroups(a)}  ${digitGroups(b)}`;
}

/** Stored in the vault to detect a later key substitution (trust on first use). */
export async function pinHash(publicKey: string): Promise<string> {
  return toBase64Url((await sha256(fromBase64Url(publicKey))).slice(0, 16));
}
