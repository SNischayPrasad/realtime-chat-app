export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  avatarHue: number;
  createdAt: string;
};

/** Server-side only. Never serialised to a client. */
export type UserRecord = PublicUser & {
  passwordHash: string;
  /** 0 = legacy account (password hashed directly, no key vault). */
  authVersion: number;
  tokenVersion: number;
};

/**
 * `public` rooms are readable and postable by any signed-in user, which is the
 * original behaviour. `dm` rooms are private 1:1 conversations and are only
 * reachable by the two users listed in `room_members`.
 */
export type RoomKind = 'public' | 'dm';

export type Room = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  kind: RoomKind;
  createdBy: string | null;
  createdAt: string;
  /**
   * Id of the first end-to-end encrypted message in this room, once there is
   * one. Advisory for display only: a client decides what to trust from its
   * own vault, never from this field, because the server sets it.
   */
  e2eeSinceId: string | null;
};

/** 0 = plaintext body. 1 = body is AES-GCM ciphertext (see src/lib/e2ee). */
export type EncVersion = 0 | 1;

export type Message = {
  /** Monotonic cursor, serialised as a string so large ids survive JSON. */
  id: string;
  roomId: string;
  /** Plaintext when encVersion is 0, base64url ciphertext when it is 1. */
  body: string;
  createdAt: string;
  author: PublicUser;
  /** Part of the ciphertext's authenticated data, so it must round-trip. */
  clientNonce: string | null;
  encVersion: EncVersion;
  iv: string | null;
  epoch: string | null;
};

export type PresenceEntry = {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number;
  lastSeenAt: string;
};

/**
 * The newest message in a conversation, for the rail. For encrypted messages
 * the body is the FULL ciphertext: truncating it would cut the GCM tag and the
 * rail could never decrypt its own preview.
 */
export type ConversationPreview = {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  clientNonce: string | null;
  encVersion: EncVersion;
  iv: string | null;
  epoch: string | null;
};

/** A DM as the rail needs it: the room, the other person, and what is unread. */
export type Conversation = {
  room: Room;
  counterpart: PublicUser;
  /**
   * The counterpart's identity public key (base64url SPKI), or null if they
   * have not signed in since encryption was added. A client must compare this
   * against its own pinned copy - see the trust-on-first-use checks.
   */
  counterpartKey: string | null;
  lastMessage: ConversationPreview | null;
  unreadCount: number;
};

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

export type SealedBlob = { ct: string; iv: string };

/** What the server stores for one account. Every field is opaque or public. */
export type KeyBundle = {
  vaultId: string;
  identityPub: string;
  vault: SealedBlob & { version: number };
  recoveryAvailable: boolean;
};

export type NewKeys = {
  vaultId: string;
  identityPub: string;
  vault: SealedBlob;
  recovery: SealedBlob | null;
};

/* -------------------------------------------------------------------------- */
/* Friends                                                                    */
/* -------------------------------------------------------------------------- */

export type FriendRelation = 'friend' | 'incoming' | 'outgoing' | 'none';

export type FriendEntry = { user: PublicUser; since: string };

export type FriendsSnapshot = {
  friends: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
};

export type DirectoryEntry = PublicUser & { relation: FriendRelation };

/* -------------------------------------------------------------------------- */
/* Calls                                                                      */
/* -------------------------------------------------------------------------- */

export type CallMedia = 'audio' | 'video';

export type CallState =
  | 'ringing'
  | 'accepted'
  | 'declined'
  | 'missed'
  | 'cancelled'
  | 'failed'
  | 'ended';

export const TERMINAL_CALL_STATES: readonly CallState[] = [
  'declined',
  'missed',
  'cancelled',
  'failed',
  'ended',
];

export type Call = {
  id: string;
  roomId: string;
  callerId: string;
  calleeId: string;
  media: CallMedia;
  state: CallState;
  endReason: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
};

export type CallSignalKind = 'offer' | 'answer' | 'ice' | 'media-state' | 'restart';

/** A signalling message. `payload` is sealed; the server never reads it. */
export type CallSignal = {
  id: string;
  callId: string;
  roomId: string;
  fromUser: string;
  toUser: string;
  kind: CallSignalKind;
  sigNonce: string;
  iv: string;
  payload: string;
  createdAt: string;
};

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already registered`);
    this.name = 'UsernameTakenError';
  }
}

export class RoomExistsError extends Error {
  constructor(slug: string) {
    super(`A room with the slug "${slug}" already exists`);
    this.name = 'RoomExistsError';
  }
}

export class SelfConversationError extends Error {
  constructor() {
    super('You cannot start a conversation with yourself');
    this.name = 'SelfConversationError';
  }
}

/**
 * An encrypted message arrived with a client nonce already used in another
 * room. The nonce is part of the ciphertext's authenticated data, so storing
 * the message without it (the plaintext fallback) would make it undecryptable.
 */
export class NonceConflictError extends Error {
  constructor() {
    super('That message id is already in use');
    this.name = 'NonceConflictError';
  }
}
