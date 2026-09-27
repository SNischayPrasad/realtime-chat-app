/**
 * The browser's keyring: the only place a user's private key is ever usable.
 *
 * Lifecycle
 *   sign-up / sign-in  The password is stretched into two independent values:
 *                      an auth secret (sent to the server in place of the
 *                      password) and a vault key (never sent anywhere). The vault
 *                      key opens the sealed vault the server stores, which holds
 *                      the identity private key.
 *   reload             The vault key and the identity key are kept in IndexedDB
 *                      as non-extractable CryptoKeys, so a reload does not need
 *                      the password again. The vault is re-fetched and re-opened.
 *   sign-out           IndexedDB is wiped.
 *
 * The vault also carries the contacts' keys this user has seen ("pins") and
 * which they have verified, so a second device inherits those decisions the
 * moment the password is entered, instead of silently trusting whatever key the
 * server hands it.
 */

import type { KeyBundle, Message } from '../types';
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
  generateIdentity,
  importPrivateKey,
  importPublicKey,
  newVaultId,
  openSignal,
  pinHash,
  safetyNumber,
  sealSignal,
  toBase64Url,
  unwrapVault,
  wrapVault,
  type MessagePlaintext,
  type VaultPlaintext,
} from './crypto';
import { idbClear, idbGet, idbSet } from './idb';

type Persisted = {
  userId: string;
  vaultKey: CryptoKey;
  identityPrivate: CryptoKey;
  identityPub: string;
  vaultId: string;
};

export type PinState = 'new' | 'trusted' | 'verified' | 'changed';

export type ConversationCrypto = {
  roomId: string;
  peerId: string;
  peerPub: string;
  dmKey: string;
  epoch: string;
  messageKey: CryptoKey;
  signalKey: CryptoKey;
};

export class VaultRollbackError extends Error {
  constructor() {
    super('The server sent an older copy of your keys than this browser has already seen.');
    this.name = 'VaultRollbackError';
  }
}

const STORAGE_KEY = 'keyring';
const versionMarker = (userId: string) => `transmission:vv:${userId}`;
export const migratedMarker = (username: string) =>
  `transmission:migrated:${username.toLowerCase()}`;

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode: rollback detection degrades, nothing else does */
  }
}

export function randomNonce(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/* -------------------------------------------------------------------------- */

export class Keyring {
  private conversations = new Map<string, Promise<ConversationCrypto>>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    readonly userId: string,
    readonly identityPub: string,
    private readonly vaultKey: CryptoKey,
    private readonly identityPrivate: CryptoKey,
    private readonly vaultId: string,
    private vault: VaultPlaintext,
    private version: number,
  ) {}

  /* ---- deriving credentials ----------------------------------------------- */

  /** ~0.5-2s: deliberately slow, which is what makes a stolen hash expensive. */
  static async derive(
    username: string,
    password: string,
  ): Promise<{ authSecret: string; vaultKey: CryptoKey }> {
    const master = await deriveMasterKey(password, username);
    const [authSecret, vaultKey] = await Promise.all([
      deriveAuthSecret(master, username),
      deriveVaultKey(master, username),
    ]);
    master.fill(0);
    return { authSecret, vaultKey };
  }

  /** Fresh identity plus its sealed vault, ready to upload. */
  static async createKeys(vaultKey: CryptoKey) {
    const identity = await generateIdentity();
    const vaultId = newVaultId();
    const sealed = await wrapVault(
      vaultKey,
      { v: 1, ecdhPkcs8: identity.privateKey, pins: {}, rooms: {}, retired: [] },
      vaultId,
      1,
    );
    return {
      vaultId,
      identityPub: identity.publicKey,
      vault: { ct: sealed.ciphertext, iv: sealed.iv },
    };
  }

  /* ---- opening --------------------------------------------------------------- */

  /** Opens a vault the server returned. Throws if the password was wrong. */
  static async open(userId: string, vaultKey: CryptoKey, bundle: KeyBundle): Promise<Keyring> {
    if (bundle.vault.version < readNumber(versionMarker(userId))) throw new VaultRollbackError();

    const vault = await unwrapVault(
      vaultKey,
      { ciphertext: bundle.vault.ct, iv: bundle.vault.iv },
      bundle.vaultId,
      bundle.vault.version,
    );
    const identityPrivate = await importPrivateKey(vault.ecdhPkcs8);

    await idbSet(STORAGE_KEY, {
      userId,
      vaultKey,
      identityPrivate,
      identityPub: bundle.identityPub,
      vaultId: bundle.vaultId,
    } satisfies Persisted);
    writeNumber(versionMarker(userId), bundle.vault.version);

    return new Keyring(
      userId,
      bundle.identityPub,
      vaultKey,
      identityPrivate,
      bundle.vaultId,
      vault,
      bundle.vault.version,
    );
  }

  /**
   * Reopens the keyring after a reload without asking for the password.
   *   'locked'  - this browser holds no keys; ask for the password
   *   'no-keys' - a pre-encryption account that has not been upgraded yet
   */
  static async restore(userId: string): Promise<Keyring | 'locked' | 'no-keys'> {
    const bundle = await fetchBundle();
    if (!bundle) return 'no-keys';

    let persisted: Persisted | undefined;
    try {
      persisted = await idbGet<Persisted>(STORAGE_KEY);
    } catch {
      return 'locked';
    }
    if (!persisted || persisted.userId !== userId || persisted.vaultId !== bundle.vaultId) {
      return 'locked';
    }
    try {
      return await Keyring.open(userId, persisted.vaultKey, bundle);
    } catch (error) {
      if (error instanceof VaultRollbackError) throw error;
      return 'locked';
    }
  }

  /** Re-derives the vault key from the password on a browser that lost it. */
  static async unlock(userId: string, username: string, password: string): Promise<Keyring> {
    const bundle = await fetchBundle();
    if (!bundle) throw new Error('This account has not set up encryption yet');
    const { vaultKey } = await Keyring.derive(username, password);
    try {
      return await Keyring.open(userId, vaultKey, bundle);
    } catch (error) {
      if (error instanceof VaultRollbackError) throw error;
      throw new Error('That password does not open your keys');
    }
  }

  static async forget(): Promise<void> {
    try {
      await idbClear();
    } catch {
      /* nothing stored */
    }
  }

  /* ---- conversations ----------------------------------------------------------- */

  /**
   * Keys for one private conversation. The epoch is computed here from both
   * identity keys, never supplied by the server, so the two sides cannot be
   * desynchronised into silent decryption failure.
   */
  conversation(roomId: string, peerId: string, peerPub: string): Promise<ConversationCrypto> {
    const cacheKey = `${roomId}|${peerPub}`;
    let pending = this.conversations.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const dmKey = conversationKey(this.userId, peerId);
        const epoch = await computeEpoch(this.userId, this.identityPub, peerId, peerPub);
        const keys = await deriveConversationKeys(
          this.identityPrivate,
          await importPublicKey(peerPub),
          dmKey,
          roomId,
          epoch,
        );
        return { roomId, peerId, peerPub, dmKey, epoch, ...keys };
      })();
      this.conversations.set(cacheKey, pending);
    }
    return pending;
  }

  async sealMessage(
    conversation: ConversationCrypto,
    text: string,
    previous: { body: string; seq: number } | null,
  ): Promise<{ body: string; iv: string; epoch: string; clientNonce: string }> {
    const clientNonce = randomNonce();
    const sealed = await encryptMessage({
      messageKey: conversation.messageKey,
      roomId: conversation.roomId,
      senderId: this.userId,
      epoch: conversation.epoch,
      dmKey: conversation.dmKey,
      clientNonce,
      text,
      seq: (previous?.seq ?? 0) + 1,
      prev: previous ? await chainLink(previous.body) : null,
    });
    return { ...sealed, clientNonce };
  }

  openMessage(conversation: ConversationCrypto, message: Message): Promise<MessagePlaintext> {
    if (message.encVersion !== 1 || !message.iv || !message.epoch || !message.clientNonce) {
      return Promise.reject(new Error('Not an encrypted message'));
    }
    return decryptMessage({
      messageKey: conversation.messageKey,
      roomId: conversation.roomId,
      senderId: message.author.id,
      epoch: message.epoch,
      clientNonce: message.clientNonce,
      body: message.body,
      iv: message.iv,
    });
  }

  sealSignal(conversation: ConversationCrypto, callId: string, payload: unknown) {
    const nonce = randomNonce();
    return sealSignal(conversation.signalKey, payload, {
      roomId: conversation.roomId,
      senderId: this.userId,
      epoch: conversation.epoch,
      callId,
      nonce,
    }).then((sealed) => ({ ...sealed, nonce }));
  }

  openSignal<T>(
    conversation: ConversationCrypto,
    callId: string,
    signal: { fromUser: string; sigNonce: string; iv: string; payload: string },
  ): Promise<T> {
    return openSignal<T>(
      conversation.signalKey,
      { body: signal.payload, iv: signal.iv },
      {
        roomId: conversation.roomId,
        senderId: signal.fromUser,
        epoch: conversation.epoch,
        callId,
        nonce: signal.sigNonce,
      },
    );
  }

  /* ---- trust ----------------------------------------------------------------------- */

  async pinState(peerId: string, peerPub: string): Promise<PinState> {
    const pin = this.vault.pins[peerId];
    if (!pin) return 'new';
    if (pin.keyHash !== (await pinHash(peerPub))) return 'changed';
    return pin.verifiedAt ? 'verified' : 'trusted';
  }

  /**
   * Records `peerPub` as this contact's key. Called silently the first time a
   * key is seen (trust on first use), and explicitly when the user accepts a
   * changed key or marks a safety number as verified.
   */
  async trust(peerId: string, peerPub: string, verified = false): Promise<void> {
    const keyHash = await pinHash(peerPub);
    await this.mutate((vault) => {
      const existing = vault.pins[peerId];
      const sameKey = existing?.keyHash === keyHash;
      vault.pins[peerId] = {
        keyHash,
        firstSeen: sameKey && existing ? existing.firstSeen : new Date().toISOString(),
        verifiedAt: verified
          ? new Date().toISOString()
          : sameKey
            ? (existing?.verifiedAt ?? null)
            : null,
      };
    });
  }

  safetyNumber(peerId: string, peerPub: string): Promise<string> {
    return safetyNumber(this.userId, this.identityPub, peerId, peerPub);
  }

  /**
   * The id of the first encrypted message this user has seen in a room. Any
   * plaintext message after it could have been inserted by the server, so the
   * UI marks it as unauthenticated. Stored in the vault, never taken from the
   * server's own `e2eeSinceId`.
   */
  boundary(roomId: string): string | null {
    return this.vault.rooms[roomId]?.e2eeSinceId ?? null;
  }

  async markBoundary(roomId: string, conversation: ConversationCrypto, messageId: string) {
    const current = this.boundary(roomId);
    if (current !== null && Number(current) <= Number(messageId)) return;
    await this.mutate((vault) => {
      const existing = vault.rooms[roomId]?.e2eeSinceId;
      if (existing && Number(existing) <= Number(messageId)) return;
      vault.rooms[roomId] = {
        dmKey: conversation.dmKey,
        epoch: conversation.epoch,
        e2eeSinceId: messageId,
      };
    });
  }

  /* ---- vault writes ------------------------------------------------------------------- */

  /**
   * Applies a change and re-seals the vault. Writes are serialised within the
   * tab; across devices the server's version check turns a conflict into a
   * 409, and the change is re-applied on top of the newer vault.
   */
  private mutate(change: (vault: VaultPlaintext) => void): Promise<void> {
    const next = this.saving.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const draft: VaultPlaintext = structuredClone(this.vault);
        change(draft);
        const version = this.version + 1;
        const sealed = await wrapVault(this.vaultKey, draft, this.vaultId, version);
        const response = await fetch('/api/keys/vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vault: { ct: sealed.ciphertext, iv: sealed.iv }, version }),
        });
        if (response.ok) {
          this.vault = draft;
          this.version = version;
          writeNumber(versionMarker(this.userId), version);
          return;
        }
        if (response.status !== 409) throw new Error('Could not save your keys');
        await this.reloadVault();
      }
      throw new Error('Your keys kept changing on another device. Reload and try again.');
    });
    this.saving = next.catch(() => undefined);
    return next;
  }

  private async reloadVault() {
    const bundle = await fetchBundle();
    if (!bundle) throw new Error('Your keys are missing');
    if (bundle.vault.version < this.version) throw new VaultRollbackError();
    this.vault = await unwrapVault(
      this.vaultKey,
      { ciphertext: bundle.vault.ct, iv: bundle.vault.iv },
      bundle.vaultId,
      bundle.vault.version,
    );
    this.version = bundle.vault.version;
    writeNumber(versionMarker(this.userId), bundle.vault.version);
  }
}

async function fetchBundle(): Promise<KeyBundle | null> {
  const response = await fetch('/api/keys/me', { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not load your keys');
  return ((await response.json()) as { keys: KeyBundle }).keys;
}
