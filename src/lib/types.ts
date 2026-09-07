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

export type Room = {
  id: string;
  slug: string;
  name: string;
  topic: string;
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
