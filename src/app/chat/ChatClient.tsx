'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { chainLink } from '@/lib/e2ee/crypto';
import {
  Keyring,
  VaultRollbackError,
  type ConversationCrypto,
  type PinState,
} from '@/lib/e2ee/keyring';
import type {
  CallSignal,
  Call,
  Conversation,
  FriendsSnapshot,
  Message,
  PublicUser,
  Room,
} from '@/lib/types';
import CallOverlay from './calls/CallOverlay';
import { useCalls } from './calls/useCalls';
import EncryptionGate, { type GateReason } from './EncryptionGate';
import FriendsDialog from './FriendsDialog';
import SafetyNumberDialog from './SafetyNumberDialog';

type ConnectionState = 'connecting' | 'live' | 'offline';

type RosterEntry = {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number;
  live: boolean;
};

type TypingEntry = { userId: string; displayName: string };

/** A message the user has sent but the server has not acknowledged yet. */
type PendingMessage = {
  nonce: string;
  roomId: string;
  body: string;
  createdAt: string;
  failed: boolean;
};

/** What the browser learned by decrypting one message. */
type Opened =
  | {
      ok: true;
      text: string;
      /** The sender's own clock, from inside the ciphertext. */
      sentAt: string;
      seq: number;
      /** false: this sender's message chain is broken (reordered or missing). */
      chainOk: boolean;
    }
  | { ok: false; reason: 'auth' | 'epoch' };

type FriendsTab = 'friends' | 'requests' | 'add' | 'blocked';

type Props = {
  user: PublicUser;
  initialRooms: Room[];
  initialConversations: Conversation[];
  persistent: boolean;
};

const TYPING_PING_INTERVAL_MS = 3000;
const CONVERSATION_POLL_MS = 8000;
/** Sender and server clocks further apart than this are flagged. */
const CLOCK_SKEW_MS = 5 * 60_000;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarStyle(hue: number) {
  return { background: `hsl(${hue} 42% 38%)` };
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayOf(iso: string): string {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function typingLabel(entries: TypingEntry[]): string {
  if (entries.length === 0) return '';
  if (entries.length === 1) return `${entries[0].displayName} is typing…`;
  if (entries.length === 2) {
    return `${entries[0].displayName} and ${entries[1].displayName} are typing…`;
  }
  return 'Several people are typing…';
}

async function signOutEverywhere(router: ReturnType<typeof useRouter>) {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  await Keyring.forget();
  router.replace('/login');
  router.refresh();
}

/* ========================================================================== */
/* Entry: unlock the keyring before anything else                             */
/* ========================================================================== */

export default function ChatClient(props: Props) {
  const router = useRouter();
  const [keyring, setKeyring] = useState<Keyring | null>(null);
  const [gate, setGate] = useState<GateReason | 'loading' | null>('loading');

  useEffect(() => {
    let cancelled = false;
    Keyring.restore(props.user.id)
      .then((result) => {
        if (cancelled) return;
        if (result instanceof Keyring) {
          setKeyring(result);
          setGate(null);
        } else {
          setGate(result);
        }
      })
      .catch((error) => {
        if (!cancelled) setGate(error instanceof VaultRollbackError ? 'rollback' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [props.user.id]);

  if (gate === 'loading') {
    return (
      <main className="gate">
        <p className="eyebrow">Unlocking your keys…</p>
      </main>
    );
  }
  if (gate || !keyring) {
    return (
      <EncryptionGate
        user={props.user}
        reason={gate ?? 'error'}
        onReady={(ready) => {
          setKeyring(ready);
          setGate(null);
        }}
        onSignOut={() => void signOutEverywhere(router)}
      />
    );
  }
  return <Chat {...props} keyring={keyring} />;
}

/* ========================================================================== */
/* The chat                                                                   */
/* ========================================================================== */

function Chat({
  user,
  initialRooms,
  initialConversations,
  persistent,
  keyring,
}: Props & { keyring: Keyring }) {
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeRoomId, setActiveRoomId] = useState<string>(initialRooms[0]?.id ?? '');
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [typing, setTyping] = useState<TypingEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [cursor, setCursor] = useState('0');
  /** Drafts are per conversation so private text cannot follow you into a room. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [friends, setFriends] = useState<FriendsSnapshot | null>(null);
  const [incomingCount, setIncomingCount] = useState(0);
  const [friendsTab, setFriendsTab] = useState<FriendsTab | null>(null);
  const [convKeys, setConvKeys] = useState<ConversationCrypto | null>(null);
  const [pinState, setPinState] = useState<PinState | null>(null);
  const [showSafety, setShowSafety] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const openedRef = useRef<Record<string, Opened>>({});
  const stickToBottom = useRef(true);
  const lastTypingPing = useRef(0);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);

  const activeConversation = useMemo(
    () => conversations.find((entry) => entry.room.id === activeRoomId) ?? null,
    [conversations, activeRoomId],
  );

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) ?? activeConversation?.room ?? null,
    [rooms, activeConversation, activeRoomId],
  );

  const isDirect = activeRoom?.kind === 'dm';
  const counterpart = activeConversation?.counterpart ?? null;
  const counterpartKey = activeConversation?.counterpartKey ?? null;
  const draft = drafts[activeRoomId] ?? '';

  const friendIds = useMemo(
    () => new Set((friends?.friends ?? []).map((entry) => entry.user.id)),
    [friends],
  );
  const outgoingIds = useMemo(
    () => new Set((friends?.outgoing ?? []).map((entry) => entry.user.id)),
    [friends],
  );
  const incomingIds = useMemo(
    () => new Set((friends?.incoming ?? []).map((entry) => entry.user.id)),
    [friends],
  );

  const totalUnread = useMemo(
    () => conversations.reduce((sum, entry) => sum + entry.unreadCount, 0),
    [conversations],
  );

  /* ---------------------------------------------------------------- */
  /* Message ingestion                                                 */
  /* ---------------------------------------------------------------- */

  /** Adds a message unless its id has already been rendered. */
  const ingest = useCallback((message: Message) => {
    if (seenIds.current.has(message.id)) return;
    seenIds.current.add(message.id);
    setMessages((current) => [...current, message]);
    setCursor((current) => (Number(message.id) > Number(current) ? message.id : current));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Conversations and friends                                         */
  /* ---------------------------------------------------------------- */

  const refreshConversations = useCallback(async () => {
    try {
      const response = await fetch('/api/conversations', { cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as { conversations?: Conversation[] };
      setConversations(data.conversations ?? []);
    } catch {
      /* the poll is a safety net; a dropped tick is not worth surfacing */
    }
  }, []);

  const refreshFriends = useCallback(async () => {
    try {
      const response = await fetch('/api/friends', { cache: 'no-store' });
      if (!response.ok) return;
      const snapshot = (await response.json()) as FriendsSnapshot;
      setFriends(snapshot);
      setIncomingCount(snapshot.incoming.length);
    } catch {
      /* retried on the next social event */
    }
  }, []);

  useEffect(() => {
    void refreshFriends();
  }, [refreshFriends]);

  // The room stream is scoped to one room, so a DM that arrives while you are
  // looking elsewhere is picked up by this poll rather than by a second stream.
  useEffect(() => {
    const timer = setInterval(refreshConversations, CONVERSATION_POLL_MS);
    const onFocus = () => void refreshConversations();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshConversations]);

  // A backgrounded tab should still say how much is waiting - a count and not a
  // name, so a passer-by learns nothing.
  useEffect(() => {
    const waiting = totalUnread + incomingCount;
    document.title = waiting > 0 ? `(${waiting}) Transmission` : 'Transmission';
  }, [totalUnread, incomingCount]);

  /* ---------------------------------------------------------------- */
  /* Calls, and the user-scoped stream that rings them                 */
  /* ---------------------------------------------------------------- */

  const calls = useCalls({ user, keyring, conversations, onNotice: setNotice });
  const { onCallFrame, onSignal } = calls;

  useEffect(() => {
    const source = new EventSource('/api/stream?scope=user');
    source.addEventListener('call', ((event: MessageEvent<string>) => {
      void onCallFrame(JSON.parse(event.data) as Call);
    }) as EventListener);
    source.addEventListener('signal', ((event: MessageEvent<string>) => {
      void onSignal(JSON.parse(event.data) as CallSignal);
    }) as EventListener);
    source.addEventListener('social', ((event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { incoming: number };
      setIncomingCount(data.incoming);
      void refreshFriends();
      void refreshConversations();
    }) as EventListener);
    return () => source.close();
  }, [onCallFrame, onSignal, refreshFriends, refreshConversations]);

  /* ---------------------------------------------------------------- */
  /* Encryption for the open conversation                              */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    setConvKeys(null);
    setPinState(null);
    if (!isDirect || !activeConversation || !counterpartKey) return;

    let cancelled = false;
    const peer = activeConversation.counterpart;
    const roomId = activeConversation.room.id;
    (async () => {
      let state = await keyring.pinState(peer.id, counterpartKey);
      if (state === 'new') {
        // Trust on first use: remember this key so a later swap is caught.
        await keyring.trust(peer.id, counterpartKey).catch(() => undefined);
        state = 'trusted';
      }
      const conversation = await keyring.conversation(roomId, peer.id, counterpartKey);
      if (!cancelled) {
        setPinState(state);
        setConvKeys(conversation);
      }
    })().catch(() => {
      if (!cancelled) setNotice('Could not set up encryption for this conversation.');
    });
    return () => {
      cancelled = true;
    };
  }, [isDirect, activeConversation, counterpartKey, keyring]);

  // Decrypt whatever encrypted messages have not been opened yet, and check
  // each sender's hash chain so reordering or deletion by the server shows.
  useEffect(() => {
    if (!convKeys) return;
    const todo = messages.filter(
      (message) =>
        message.roomId === convKeys.roomId &&
        message.encVersion === 1 &&
        !(message.id in openedRef.current),
    );
    if (todo.length === 0) return;

    let cancelled = false;
    (async () => {
      const results: Record<string, Opened> = {};
      for (const message of todo) {
        if (message.epoch !== convKeys.epoch) {
          results[message.id] = { ok: false, reason: 'epoch' };
          continue;
        }
        try {
          const plain = await keyring.openMessage(convKeys, message);
          let chainOk = true;
          if (plain.prev !== null) {
            const earlier = messages
              .filter(
                (m) =>
                  m.author.id === message.author.id &&
                  m.encVersion === 1 &&
                  Number(m.id) < Number(message.id),
              )
              .at(-1);
            // Only judged when the previous link is actually loaded.
            if (earlier) chainOk = (await chainLink(earlier.body)) === plain.prev;
          }
          results[message.id] = {
            ok: true,
            text: plain.text,
            sentAt: plain.t,
            seq: plain.seq,
            chainOk,
          };
        } catch {
          results[message.id] = { ok: false, reason: 'auth' };
        }
      }
      if (cancelled) return;
      setOpened((current) => ({ ...current, ...results }));

      const firstEncrypted = todo
        .filter((message) => results[message.id]?.ok)
        .map((message) => message.id)
        .sort((a, b) => Number(a) - Number(b))[0];
      if (firstEncrypted) void keyring.markBoundary(convKeys.roomId, convKeys, firstEncrypted).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, convKeys, keyring]);

  /* ---------------------------------------------------------------- */
  /* History: reload whenever the conversation changes                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!activeRoomId) return;

    let cancelled = false;
    seenIds.current = new Set();
    stickToBottom.current = true;
    setMessages([]);
    setPending([]);
    setTyping([]);
    setRoster([]);
    setLoadingHistory(true);

    (async () => {
      try {
        const response = await fetch(`/api/rooms/${activeRoomId}/messages?limit=50`, {
          cache: 'no-store',
        });
        if (response.status === 401) {
          router.replace('/login');
          return;
        }
        if (response.status === 404) {
          // Blocked, or the conversation is otherwise gone for you.
          if (!cancelled) {
            setNotice('That conversation is no longer available.');
            setActiveRoomId(initialRooms[0]?.id ?? '');
            void refreshConversations();
          }
          return;
        }
        const data = (await response.json()) as { messages?: Message[]; cursor?: string };
        if (cancelled) return;

        const history = data.messages ?? [];
        for (const message of history) seenIds.current.add(message.id);
        setMessages(history);
        setCursor(data.cursor ?? '0');
      } catch {
        if (!cancelled) setNotice('Could not load the history for this conversation.');
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeRoomId, router, initialRooms, refreshConversations]);

  /* ---------------------------------------------------------------- */
  /* Live stream for the open room                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!activeRoomId || loadingHistory) return;

    setConnection('connecting');
    const source = new EventSource(
      `/api/stream?roomId=${encodeURIComponent(activeRoomId)}&after=${encodeURIComponent(cursor)}`,
    );

    const onReady = () => setConnection('live');

    const onMessage = (event: MessageEvent<string>) => {
      setConnection('live');
      const message = JSON.parse(event.data) as Message;
      ingest(message);
      if (message.author.id === user.id) {
        // Reconciled by nonce, not body: an encrypted echo's body is ciphertext.
        setPending((current) => current.filter((item) => item.nonce !== message.clientNonce));
      } else {
        void refreshConversations();
      }
    };

    const onPresence = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { online: RosterEntry[]; typing: TypingEntry[] };
      setRoster(data.online ?? []);
      setTyping(data.typing ?? []);
    };

    // The server closes each stream before the platform's function timeout and
    // emits `reconnect`. EventSource then reopens on its own, replaying the
    // last id it saw via the Last-Event-ID header, so no messages are missed.
    const onReconnect = () => setConnection('connecting');

    const onError = () => {
      setConnection(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    };

    source.addEventListener('ready', onReady as EventListener);
    source.addEventListener('message', onMessage as EventListener);
    source.addEventListener('presence', onPresence as EventListener);
    source.addEventListener('reconnect', onReconnect as EventListener);
    source.onerror = onError;

    return () => {
      source.close();
    };
    // `cursor` is intentionally omitted: it changes on every message and would
    // otherwise tear down and rebuild the stream constantly. The connection
    // resumes from Last-Event-ID instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, loadingHistory, ingest, user.id, refreshConversations]);

  /* ---------------------------------------------------------------- */
  /* Scroll and read state                                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const node = logRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, pending, typing, opened]);

  // Only mark read when the conversation is open, the window has focus, and the
  // log is actually at the bottom.
  useEffect(() => {
    if (!activeRoomId || messages.length === 0) return;
    if (!document.hasFocus() || !stickToBottom.current) return;

    const newest = messages[messages.length - 1].id;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      void fetch(`/api/rooms/${activeRoomId}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastReadId: newest }),
      })
        .then(() =>
          setConversations((current) =>
            current.map((entry) =>
              entry.room.id === activeRoomId ? { ...entry, unreadCount: 0 } : entry,
            ),
          ),
        )
        .catch(() => {
          /* read state is best-effort */
        });
    }, 500);

    return () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    };
  }, [activeRoomId, messages]);

  function onLogScroll() {
    const node = logRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distanceFromBottom < 120;
  }

  /* ---------------------------------------------------------------- */
  /* Typing signal                                                     */
  /* ---------------------------------------------------------------- */

  const signalTyping = useCallback(
    (isTyping: boolean) => {
      if (!activeRoomId) return;
      void fetch(`/api/rooms/${activeRoomId}/typing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typing: isTyping }),
      }).catch(() => {
        /* a dropped typing ping is not worth surfacing */
      });
    },
    [activeRoomId],
  );

  function onDraftChange(value: string) {
    setDrafts((current) => ({ ...current, [activeRoomId]: value }));
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);

    if (!value) {
      lastTypingPing.current = 0;
      signalTyping(false);
      return;
    }

    const now = Date.now();
    if (now - lastTypingPing.current > TYPING_PING_INTERVAL_MS) {
      lastTypingPing.current = now;
      signalTyping(true);
    }
    typingStopTimer.current = setTimeout(() => {
      lastTypingPing.current = 0;
      signalTyping(false);
    }, 4000);
  }

  /* ---------------------------------------------------------------- */
  /* Sending                                                           */
  /* ---------------------------------------------------------------- */

  const encryptionRequired = isDirect && (Boolean(counterpartKey) || activeRoom?.e2eeSinceId !== null);
  const sendBlocked =
    isDirect && pinState === 'changed'
      ? 'key-changed'
      : encryptionRequired && !convKeys
        ? 'no-crypto'
        : null;

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    const roomId = activeRoomId;
    if (!text || !roomId) return;

    if (sendBlocked === 'key-changed') {
      setNotice(`Verify or accept ${counterpart?.displayName}'s new key before sending.`);
      return;
    }
    if (sendBlocked === 'no-crypto') {
      setNotice('Encryption is still being set up for this conversation. Try again in a moment.');
      return;
    }

    let payload: Record<string, unknown>;
    let nonce: string;
    let seq = 0;

    try {
      if (isDirect && convKeys) {
        const previous = [...messages]
          .reverse()
          .find((m) => m.author.id === user.id && m.encVersion === 1 && opened[m.id]?.ok);
        const previousOpened = previous ? opened[previous.id] : undefined;
        const sealed = await keyring.sealMessage(
          convKeys,
          text,
          previous && previousOpened?.ok ? { body: previous.body, seq: previousOpened.seq } : null,
        );
        nonce = sealed.clientNonce;
        seq = (previousOpened?.ok ? previousOpened.seq : 0) + 1;
        payload = {
          encVersion: 1,
          body: sealed.body,
          iv: sealed.iv,
          epoch: sealed.epoch,
          clientNonce: sealed.clientNonce,
        };
      } else {
        nonce =
          globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        payload = { body: text, clientNonce: nonce };
      }
    } catch {
      setNotice('Could not encrypt that message.');
      return;
    }

    setDrafts((current) => ({ ...current, [roomId]: '' }));
    stickToBottom.current = true;
    setPending((current) => [
      ...current,
      { nonce, roomId, body: text, createdAt: new Date().toISOString(), failed: false },
    ]);

    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    lastTypingPing.current = 0;
    signalTyping(false);

    try {
      const response = await fetch(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        router.replace('/login');
        return;
      }

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setNotice(data.error ?? 'Message could not be sent.');
        setPending((current) =>
          current.map((item) => (item.nonce === nonce ? { ...item, failed: true } : item)),
        );
        return;
      }

      const data = (await response.json()) as { message: Message };
      // We already know what we wrote; no need to decrypt our own echo.
      if (data.message.encVersion === 1) {
        setOpened((current) => ({
          ...current,
          [data.message.id]: {
            ok: true,
            text,
            sentAt: new Date().toISOString(),
            seq,
            chainOk: true,
          },
        }));
      }
      ingest(data.message);
      setPending((current) => current.filter((item) => item.nonce !== nonce));
      void refreshConversations();
    } catch {
      setNotice('Message could not be sent. Check your connection.');
      setPending((current) =>
        current.map((item) => (item.nonce === nonce ? { ...item, failed: true } : item)),
      );
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rooms, conversations and friends                                  */
  /* ---------------------------------------------------------------- */

  async function createRoom(name: string, topic: string) {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, topic }),
    });
    const data = (await response.json()) as { room?: Room; error?: string };
    if (!response.ok || !data.room) {
      throw new Error(data.error ?? 'Could not create the room');
    }
    setRooms((current) => [...current, data.room as Room]);
    setActiveRoomId(data.room.id);
  }

  /** Opens (or creates) the private conversation with one friend. */
  const openConversationWith = useCallback(async (person: PublicUser) => {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: person.id }),
    });
    const data = (await response.json()) as { conversation?: Conversation; error?: string };
    if (!response.ok || !data.conversation) {
      throw new Error(data.error ?? 'Could not open that conversation');
    }

    const conversation = data.conversation;
    setConversations((current) =>
      current.some((entry) => entry.room.id === conversation.room.id)
        ? current
        : [conversation, ...current],
    );
    setActiveRoomId(conversation.room.id);
  }, []);

  async function sendFriendRequest(person: { id: string; displayName: string }) {
    const response = await fetch('/api/friends/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: person.id }),
    });
    const data = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
    if (!response.ok) {
      setNotice(data.error ?? 'Could not send the request.');
      return;
    }
    setNotice(
      data.status === 'accepted'
        ? `You and ${person.displayName} are now friends.`
        : `Friend request sent to ${person.displayName}.`,
    );
    void refreshFriends();
  }

  async function acceptNewKey() {
    if (!counterpart || !counterpartKey) return;
    await keyring.trust(counterpart.id, counterpartKey).catch(() => undefined);
    setPinState('trusted');
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Where encryption began in this room, as far as THIS browser can vouch:
   * the earlier of what the vault remembers and the first encrypted message
   * in view. Never the server's own e2eeSinceId - a hostile server could move
   * that to hide a forged plaintext message.
   */
  const boundary = useMemo(() => {
    if (!isDirect || !activeRoom) return null;
    const firstLoaded = messages.find((m) => m.encVersion === 1)?.id ?? null;
    const remembered = keyring.boundary(activeRoom.id);
    if (firstLoaded && remembered) {
      return Number(firstLoaded) < Number(remembered) ? firstLoaded : remembered;
    }
    return firstLoaded ?? remembered;
  }, [isDirect, activeRoom, messages, keyring]);

  const rendered = useMemo(() => {
    const rows: Array<
      | { kind: 'day'; key: string; label: string }
      | { kind: 'e2ee'; key: string }
      | {
          kind: 'message';
          key: string;
          message: Message;
          grouped: boolean;
          unauthenticated: boolean;
        }
    > = [];

    let previous: Message | null = null;
    let dividerShown = false;
    for (const message of messages) {
      if (!previous || dayOf(previous.createdAt) !== dayOf(message.createdAt)) {
        rows.push({ kind: 'day', key: `day-${message.id}`, label: dayLabel(message.createdAt) });
      }
      if (
        isDirect &&
        !dividerShown &&
        boundary &&
        message.id === boundary &&
        messages.some((m) => m.encVersion === 0 && Number(m.id) < Number(boundary))
      ) {
        rows.push({ kind: 'e2ee', key: `e2ee-${message.id}` });
        dividerShown = true;
      }
      const grouped =
        previous !== null &&
        previous.author.id === message.author.id &&
        previous.encVersion === message.encVersion &&
        dayOf(previous.createdAt) === dayOf(message.createdAt) &&
        new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;

      const unauthenticated =
        isDirect &&
        message.encVersion === 0 &&
        boundary !== null &&
        Number(message.id) > Number(boundary);

      rows.push({ kind: 'message', key: message.id, message, grouped, unauthenticated });
      previous = message;
    }
    return rows;
  }, [messages, isDirect, boundary]);

  const visiblePending = pending.filter((item) => item.roomId === activeRoomId);
  const canCall =
    isDirect &&
    Boolean(counterpart && counterpartKey && convKeys) &&
    pinState !== 'changed' &&
    Boolean(counterpart && friendIds.has(counterpart.id));

  return (
    <div className="shell">
      {/* Rail ------------------------------------------------------- */}
      <nav className="pane pane--rail" aria-label="Rooms and conversations">
        <div className="rail__head">
          <span aria-hidden="true">◈</span>
          <span>Transmission</span>
        </div>

        <div className="rail__scroll">
          <p className="rail__section">Rooms</p>
          <ul className="rail__list">
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  type="button"
                  className="room"
                  aria-current={room.id === activeRoomId}
                  onClick={() => setActiveRoomId(room.id)}
                >
                  <span className="room__hash" aria-hidden="true">
                    #
                  </span>
                  <span className="room__name">{room.name}</span>
                </button>
              </li>
            ))}
          </ul>

          <button type="button" className="rail__new" onClick={() => setShowNewRoom(true)}>
            + New room
          </button>

          <div className="rail__section rail__section--row">
            <span>Direct</span>
            <button
              type="button"
              className="rail__friends"
              onClick={() => setFriendsTab(incomingCount > 0 ? 'requests' : 'friends')}
            >
              Friends
              {incomingCount > 0 && (
                <span className="pill pill--alert mono" aria-label={`${incomingCount} friend requests`}>
                  {incomingCount}
                </span>
              )}
            </button>
          </div>
          {conversations.length === 0 ? (
            <p className="rail__hint">
              No private conversations yet. Add a friend to start one.
            </p>
          ) : (
            <ul className="rail__list">
              {conversations.map((entry) => (
                <li key={entry.room.id}>
                  <button
                    type="button"
                    className={`room room--dm ${entry.unreadCount > 0 ? 'room--unread' : ''}`}
                    aria-current={entry.room.id === activeRoomId}
                    onClick={() => setActiveRoomId(entry.room.id)}
                  >
                    <span
                      className="avatar avatar--xs"
                      style={avatarStyle(entry.counterpart.avatarHue)}
                      aria-hidden="true"
                    >
                      {initials(entry.counterpart.displayName)}
                    </span>
                    <span className="room__name">{entry.counterpart.displayName}</span>
                    {entry.unreadCount > 0 ? (
                      <span className="pill mono" aria-label={`${entry.unreadCount} unread`}>
                        {entry.unreadCount}
                      </span>
                    ) : (
                      entry.lastMessage && (
                        <span className="room__time mono">
                          {shortTime(entry.lastMessage.createdAt)}
                        </span>
                      )
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="rail__new" onClick={() => setShowPicker(true)}>
            + New message
          </button>
        </div>

        <div className="rail__foot">
          <span className="avatar avatar--sm" style={avatarStyle(user.avatarHue)} aria-hidden="true">
            {initials(user.displayName)}
          </span>
          <span className="rail__me">
            <span className="rail__me-name">{user.displayName}</span>
            <br />
            <span className="rail__me-handle">@{user.username}</span>
          </span>
          <button type="button" className="linkish" onClick={() => void signOutEverywhere(router)}>
            Sign out
          </button>
        </div>
      </nav>

      {/* Conversation ----------------------------------------------- */}
      <main className="pane">
        <header className="conv__head">
          {isDirect && counterpart ? (
            <>
              <span
                className="avatar avatar--sm"
                style={avatarStyle(counterpart.avatarHue)}
                aria-hidden="true"
              >
                {initials(counterpart.displayName)}
              </span>
              <div>
                <h1 className="conv__title">{counterpart.displayName}</h1>
                <p className="conv__topic mono">
                  {counterpartKey ? (
                    <button
                      type="button"
                      className={`e2ee-chip ${pinState === 'verified' ? 'e2ee-chip--verified' : ''} ${pinState === 'changed' ? 'e2ee-chip--warn' : ''}`}
                      onClick={() => setShowSafety(true)}
                      title="Compare safety numbers"
                    >
                      {pinState === 'verified'
                        ? '✓ Verified · end-to-end encrypted'
                        : pinState === 'changed'
                          ? '⚠ Security key changed'
                          : '● End-to-end encrypted · verify'}
                    </button>
                  ) : (
                    <span className="e2ee-chip e2ee-chip--off">Not encrypted yet</span>
                  )}{' '}
                  @{counterpart.username}
                </p>
              </div>
              <div className="conv__actions">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={!canCall || calls.view !== null}
                  onClick={() => activeConversation && void calls.startCall(activeConversation, 'audio')}
                  title={canCall ? 'Voice call' : 'Calls are available between friends with encryption set up'}
                >
                  Voice
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={!canCall || calls.view !== null}
                  onClick={() => activeConversation && void calls.startCall(activeConversation, 'video')}
                  title={canCall ? 'Video call' : 'Calls are available between friends with encryption set up'}
                >
                  Video
                </button>
              </div>
            </>
          ) : (
            <div>
              <h1 className="conv__title">
                <span aria-hidden="true" style={{ color: 'var(--faint)' }}>
                  #
                </span>{' '}
                {activeRoom?.name ?? 'No room'}
              </h1>
              <p className="conv__topic">
                {activeRoom?.topic}
                {activeRoom && (
                  <span className="e2ee-chip e2ee-chip--off" style={{ marginLeft: activeRoom.topic ? 8 : 0 }}>
                    Public · not end-to-end encrypted
                  </span>
                )}
              </p>
            </div>
          )}

          <div className="wire" data-state={connection} role="status" aria-live="polite">
            <span className="wire__dot" aria-hidden="true" />
            <span>
              {connection === 'live'
                ? 'Live'
                : connection === 'connecting'
                  ? 'Connecting'
                  : 'Offline'}
            </span>
            <span className="wire__cursor">#{cursor}</span>
          </div>
        </header>

        {notice && (
          <div className="alert" style={{ margin: '12px 24px 0' }} role="alert">
            {notice}{' '}
            <button
              type="button"
              className="linkish"
              style={{ color: 'inherit' }}
              onClick={() => setNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {isDirect && counterpart && pinState === 'changed' && (
          <div className="keychange" role="alert">
            <strong>{counterpart.displayName}&apos;s security key changed.</strong> That happens if
            they reset their account keys - or if someone is intercepting this conversation. Compare
            safety numbers before you send anything sensitive.
            <div className="keychange__actions">
              <button type="button" className="button button--small" onClick={() => setShowSafety(true)}>
                Compare safety numbers
              </button>
              <button type="button" className="button button--small button--ghost" onClick={acceptNewKey}>
                Accept the new key
              </button>
            </div>
          </div>
        )}

        {isDirect && counterpart && !counterpartKey && (
          <div className="notice" style={{ margin: '12px 24px 0' }}>
            <strong className="notice__title">Not end-to-end encrypted yet</strong>
            <p className="notice__body">
              {counterpart.displayName} hasn&apos;t signed in since encryption was added, so there
              is no key to encrypt to. Messages you send now are readable by the server. Once they
              sign in, new messages are encrypted automatically.
            </p>
          </div>
        )}

        <div className="log" ref={logRef} onScroll={onLogScroll}>
          {!loadingHistory && messages.length === 0 && visiblePending.length === 0 && (
            <div className="log__empty">
              {isDirect && counterpart ? (
                <>
                  <span
                    className="avatar avatar--lg"
                    style={avatarStyle(counterpart.avatarHue)}
                    aria-hidden="true"
                  >
                    {initials(counterpart.displayName)}
                  </span>
                  <h3>{counterpart.displayName}</h3>
                  <p>This is the start of your conversation with {counterpart.displayName}.</p>
                  <p className="eyebrow" style={{ marginTop: 10 }}>
                    {counterpartKey
                      ? 'End-to-end encrypted - not even the server can read it'
                      : 'Encryption starts once they sign in again'}
                  </p>
                </>
              ) : (
                <>
                  <h3>Nothing here yet</h3>
                  <p>Send the first message and everyone in the room sees it straight away.</p>
                </>
              )}
            </div>
          )}

          {rendered.map((row) =>
            row.kind === 'day' ? (
              <div className="daymark" key={row.key}>
                {row.label}
              </div>
            ) : row.kind === 'e2ee' ? (
              <div className="daymark daymark--e2ee" key={row.key}>
                Messages below are end-to-end encrypted
              </div>
            ) : (
              <MessageRow
                key={row.key}
                message={row.message}
                grouped={row.grouped}
                mine={row.message.author.id === user.id}
                opened={opened[row.message.id]}
                unauthenticated={row.unauthenticated}
              />
            ),
          )}

          {visiblePending.map((item) => (
            <article
              className={`msg msg--mine ${item.failed ? 'msg--failed' : 'msg--pending'}`}
              key={item.nonce}
            >
              <div className="msg__body">
                <div className="msg__meta">
                  <span className="msg__time mono">{item.failed ? 'Not sent' : 'Sending…'}</span>
                </div>
                <div className="bubble">{item.body}</div>
              </div>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <div className="composer__typing" aria-live="polite">
            {typingLabel(typing)}
          </div>
          <div className="composer__row">
            <label className="visually-hidden" htmlFor="composer-input">
              {isDirect && counterpart
                ? `Message ${counterpart.displayName}`
                : `Message ${activeRoom?.name ?? ''}`}
            </label>
            <textarea
              id="composer-input"
              className="composer__input"
              rows={1}
              value={draft}
              placeholder={
                sendBlocked === 'key-changed'
                  ? 'Verify their new key to keep messaging'
                  : isDirect && counterpart
                    ? `Message @${counterpart.username}`
                    : `Message #${activeRoom?.slug ?? 'room'}`
              }
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={!activeRoom || sendBlocked === 'key-changed'}
            />
            <button
              className="button"
              type="submit"
              disabled={!draft.trim() || !activeRoom || sendBlocked !== null}
            >
              Send
            </button>
          </div>
          <p className="composer__hint">
            Enter to send · Shift+Enter for a new line
            {isDirect && convKeys && ' · end-to-end encrypted'}
            {!persistent && ' · dev store: messages are not persisted'}
          </p>
        </form>
      </main>

      {/* Right pane ------------------------------------------------- */}
      <aside className="pane pane--roster" aria-label={isDirect ? 'Conversation' : 'People here'}>
        {isDirect && counterpart ? (
          <>
            <p className="roster__head">Conversation</p>
            <div className="counterpart">
              <span
                className="avatar avatar--lg"
                style={avatarStyle(counterpart.avatarHue)}
                aria-hidden="true"
              >
                {initials(counterpart.displayName)}
              </span>
              <p className="counterpart__name">{counterpart.displayName}</p>
              <p className="counterpart__handle mono">@{counterpart.username}</p>
              <p className="counterpart__status">
                {roster.find((entry) => entry.userId === counterpart.id)?.live
                  ? 'Here now'
                  : 'Not here right now'}
              </p>
              <p className="counterpart__note">
                {counterpartKey
                  ? `Messages and calls are end-to-end encrypted. Only you and ${counterpart.displayName.split(' ')[0]} can read or hear them.`
                  : `Private, but not end-to-end encrypted until ${counterpart.displayName.split(' ')[0]} signs in again.`}
              </p>
              {counterpartKey && (
                <button
                  type="button"
                  className="button button--small button--ghost"
                  onClick={() => setShowSafety(true)}
                >
                  {pinState === 'verified' ? 'View safety number' : 'Verify safety number'}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="roster__head">In this room — {roster.length}</p>
            {roster.length === 0 ? (
              <p className="roster__empty">Waiting for the first presence ping…</p>
            ) : (
              <ul className="roster__list">
                {roster.map((entry) => {
                  const person = {
                    id: entry.userId,
                    username: entry.username,
                    displayName: entry.displayName,
                    avatarHue: entry.avatarHue,
                    createdAt: '',
                  };
                  return (
                    <li className="roster__item" key={entry.userId}>
                      <span
                        className="avatar avatar--sm"
                        style={avatarStyle(entry.avatarHue)}
                        aria-hidden="true"
                      >
                        {initials(entry.displayName)}
                      </span>
                      <span className="roster__name">
                        {entry.displayName}
                        {entry.userId === user.id && ' (you)'}
                      </span>
                      {entry.userId !== user.id &&
                        (friendIds.has(entry.userId) ? (
                          <button
                            type="button"
                            className="roster__dm"
                            title={`Message ${entry.displayName} privately`}
                            onClick={() =>
                              void openConversationWith(person).catch((error: Error) =>
                                setNotice(error.message),
                              )
                            }
                          >
                            Message
                          </button>
                        ) : outgoingIds.has(entry.userId) ? (
                          <span className="roster__dm roster__dm--muted">Requested</span>
                        ) : (
                          <button
                            type="button"
                            className="roster__dm"
                            onClick={() => void sendFriendRequest(person)}
                          >
                            {incomingIds.has(entry.userId) ? 'Accept' : 'Add friend'}
                          </button>
                        ))}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <p className="roster__note">
          Transport: SSE
          <br />
          Cursor: #{cursor}
          <br />
          Store: {persistent ? 'Postgres' : 'memory (dev)'}
        </p>
      </aside>

      {showNewRoom && <NewRoomDialog onClose={() => setShowNewRoom(false)} onCreate={createRoom} />}
      {showPicker && (
        <FriendPicker
          friends={friends}
          onClose={() => setShowPicker(false)}
          onAddFriend={() => {
            setShowPicker(false);
            setFriendsTab('add');
          }}
          onPick={async (person) => {
            await openConversationWith(person);
            setShowPicker(false);
          }}
        />
      )}
      {friendsTab && (
        <FriendsDialog
          snapshot={friends}
          initialTab={friendsTab}
          onChanged={async () => {
            await refreshFriends();
            await refreshConversations();
          }}
          onMessage={async (person) => {
            await openConversationWith(person);
            setFriendsTab(null);
          }}
          onClose={() => setFriendsTab(null)}
        />
      )}
      {showSafety && counterpart && counterpartKey && pinState && (
        <SafetyNumberDialog
          keyring={keyring}
          peer={counterpart}
          peerKey={counterpartKey}
          state={pinState}
          onTrusted={(state) => setPinState(state)}
          onClose={() => setShowSafety(false)}
        />
      )}
      {calls.view && (
        <CallOverlay
          view={calls.view}
          localStream={calls.localStream}
          remoteStream={calls.remoteStream}
          muted={calls.muted}
          cameraOff={calls.cameraOff}
          onAccept={() => void calls.accept()}
          onDecline={() => void calls.decline()}
          onHangUp={() => void calls.hangUp()}
          onToggleMute={calls.toggleMute}
          onToggleCamera={calls.toggleCamera}
          onDismiss={calls.dismiss}
        />
      )}
    </div>
  );
}

/* ========================================================================== */

function MessageRow({
  message,
  grouped,
  mine,
  opened,
  unauthenticated,
}: {
  message: Message;
  grouped: boolean;
  mine: boolean;
  opened: Opened | undefined;
  unauthenticated: boolean;
}) {
  const encrypted = message.encVersion === 1;
  const sentAt = encrypted && opened?.ok ? opened.sentAt : message.createdAt;
  const skewed =
    encrypted &&
    opened?.ok &&
    Math.abs(Date.parse(opened.sentAt) - Date.parse(message.createdAt)) > CLOCK_SKEW_MS;

  let body: React.ReactNode;
  let bubbleClass = 'bubble';
  if (!encrypted) {
    body = message.body;
  } else if (!opened) {
    body = <span className="bubble__muted">Decrypting…</span>;
  } else if (!opened.ok) {
    bubbleClass += ' bubble--locked';
    body =
      opened.reason === 'epoch'
        ? 'Encrypted with a key this browser does not have.'
        : 'This message could not be decrypted. It may have been tampered with.';
  } else {
    body = opened.text;
  }

  if (unauthenticated) {
    return (
      <article className="msg msg--hostile">
        <div className="hostile">
          <strong>Unverified message</strong> - this arrived unencrypted in an end-to-end
          encrypted conversation, so there is no proof it came from {message.author.displayName}.
          <div className="hostile__text">{message.body}</div>
        </div>
      </article>
    );
  }

  return (
    <article className={`msg ${mine ? 'msg--mine' : ''} ${grouped ? 'msg--grouped' : ''}`}>
      {!mine &&
        (grouped ? (
          <span aria-hidden="true" />
        ) : (
          <span className="avatar" style={avatarStyle(message.author.avatarHue)} aria-hidden="true">
            {initials(message.author.displayName)}
          </span>
        ))}
      <div className="msg__body">
        {!grouped && (
          <div className="msg__meta">
            {!mine && <span className="msg__author">{message.author.displayName}</span>}
            <time
              className="msg__time mono"
              dateTime={sentAt}
              title={
                skewed
                  ? `Sender's clock says ${new Date(sentAt).toLocaleString()}; the server received it ${new Date(message.createdAt).toLocaleString()}.`
                  : undefined
              }
            >
              {timeOf(sentAt)}
              {skewed ? ' ⚠' : ''}
            </time>
          </div>
        )}
        <div className={bubbleClass}>{body}</div>
        {encrypted && opened?.ok && !opened.chainOk && (
          <p className="msg__warn">
            ⚠ Out of order, or a message from {message.author.displayName} is missing before this
            one.
          </p>
        )}
      </div>
    </article>
  );
}

function FriendPicker({
  friends,
  onClose,
  onPick,
  onAddFriend,
}: {
  friends: FriendsSnapshot | null;
  onClose: () => void;
  onPick: (person: PublicUser) => Promise<void>;
  onAddFriend: () => void;
}) {
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = (friends?.friends ?? [])
    .map((entry) => entry.user)
    .filter(
      (person) =>
        !q ||
        person.displayName.toLowerCase().includes(q.toLowerCase()) ||
        person.username.toLowerCase().includes(q.toLowerCase().replace(/^@/, '')),
    );

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <h2 id="picker-title">New message</h2>
        <p>Private and end-to-end encrypted. Choose one of your friends.</p>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span className="visually-hidden">Search your friends</span>
          <input
            className="field__input"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search your friends"
            autoFocus
          />
        </label>

        {friends === null ? (
          <p className="roster__empty">Loading…</p>
        ) : list.length === 0 ? (
          <p className="roster__empty">
            {q ? `No friend matches “${q}”.` : 'You have no friends here yet.'}{' '}
            <button type="button" className="linkish linkish--dark" onClick={onAddFriend}>
              Add a friend
            </button>
          </p>
        ) : (
          <ul className="picker__list">
            {list.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="picker__row"
                  onClick={() => {
                    onPick(person).catch((caught: Error) => setError(caught.message));
                  }}
                >
                  <span
                    className="avatar avatar--sm"
                    style={avatarStyle(person.avatarHue)}
                    aria-hidden="true"
                  >
                    {initials(person.displayName)}
                  </span>
                  <span className="picker__name">{person.displayName}</span>
                  <span className="picker__handle mono">@{person.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={onAddFriend}>
            Add a friend
          </button>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function NewRoomDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, topic: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), topic.trim());
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-room-title">
        <h2 id="new-room-title">New room</h2>
        <p>Public, and not end-to-end encrypted. Anyone signed in can join it.</p>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="field__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Release planning"
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Topic</span>
            <input
              className="field__input"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="What this room is for"
            />
          </label>
          <div className="dialog__actions">
            <button type="button" className="button button--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
