export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  avatarHue: number;
  createdAt: string;
};

export type UserRecord = PublicUser & {
  passwordHash: string;
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
};

export type Message = {
  /** Monotonic cursor, serialised as a string so large ids survive JSON. */
  id: string;
  roomId: string;
  body: string;
  createdAt: string;
  author: PublicUser;
};

export type PresenceEntry = {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number;
  lastSeenAt: string;
};

/** A DM as the rail needs it: the room, the other person, and what is unread. */
export type Conversation = {
  room: Room;
  counterpart: PublicUser;
  lastMessage: { id: string; body: string; createdAt: string; authorId: string } | null;
  unreadCount: number;
};

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
