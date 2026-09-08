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
import type { Conversation, Message, PublicUser, Room } from '@/lib/types';

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

type Props = {
  user: PublicUser;
  initialRooms: Room[];
  initialConversations: Conversation[];
  persistent: boolean;
};

const TYPING_PING_INTERVAL_MS = 3000;
const CONVERSATION_POLL_MS = 8000;

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

export default function ChatClient({
  user,
  initialRooms,
  initialConversations,
  persistent,
}: Props) {
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeRoomId, setActiveRoomId] = useState<string>(initialRooms[0]?.id ?? '');
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
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

  const logRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const stickToBottom = useRef(true);
  const lastTypingPing = useRef(0);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const draft = drafts[activeRoomId] ?? '';

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
  /* Conversation list                                                 */
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

  // The SSE stream is scoped to one room, so a DM that arrives while you are
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
    document.title = totalUnread > 0 ? `(${totalUnread}) Transmission` : 'Transmission';
  }, [totalUnread]);

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
  }, [activeRoomId, router]);

  /* ---------------------------------------------------------------- */
  /* Live stream                                                       */
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
        setPending((current) => current.filter((item) => item.body !== message.body));
      } else {
        // Someone replied in the open conversation: keep the rail preview fresh.
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
  }, [messages, pending, typing]);

  // Only mark read when the conversation is open, the window has focus, and the
  // log is actually at the bottom. Reading back through history while new
  // messages arrive must not silently clear the badge.
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

    // Clearing the box stops the indicator at once. In a 1:1 a lingering
    // "still typing…" after someone visibly gave up is conspicuous.
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

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    const roomId = activeRoomId;
    if (!body || !roomId) return;

    const nonce =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setDrafts((current) => ({ ...current, [roomId]: '' }));
    stickToBottom.current = true;
    setPending((current) => [
      ...current,
      { nonce, roomId, body, createdAt: new Date().toISOString(), failed: false },
    ]);

    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    lastTypingPing.current = 0;
    signalTyping(false);

    try {
      const response = await fetch(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, clientNonce: nonce }),
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
  /* Rooms and conversations                                           */
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

  /** Opens (or creates) the private conversation with one person. */
  const openConversationWith = useCallback(
    async (person: PublicUser) => {
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
    },
    [],
  );

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const rendered = useMemo(() => {
    const rows: Array<
      | { kind: 'day'; key: string; label: string }
      | { kind: 'message'; key: string; message: Message; grouped: boolean }
    > = [];

    let previous: Message | null = null;
    for (const message of messages) {
      if (!previous || dayOf(previous.createdAt) !== dayOf(message.createdAt)) {
        rows.push({ kind: 'day', key: `day-${message.id}`, label: dayLabel(message.createdAt) });
      }
      const grouped =
        previous !== null &&
        previous.author.id === message.author.id &&
        dayOf(previous.createdAt) === dayOf(message.createdAt) &&
        new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;

      rows.push({ kind: 'message', key: message.id, message, grouped });
      previous = message;
    }
    return rows;
  }, [messages]);

  const visiblePending = pending.filter((item) => item.roomId === activeRoomId);

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

          <p className="rail__section">Direct</p>
          {conversations.length === 0 ? (
            <p className="rail__hint">No private conversations yet.</p>
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
          <button type="button" className="linkish" onClick={signOut}>
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
                  <span className="lock" aria-hidden="true">
                    ●
                  </span>{' '}
                  Private · @{counterpart.username}
                </p>
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
              {activeRoom?.topic && <p className="conv__topic">{activeRoom.topic}</p>}
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
                    Only the two of you can read these messages
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
            ) : (
              <MessageRow
                key={row.key}
                message={row.message}
                grouped={row.grouped}
                mine={row.message.author.id === user.id}
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
                isDirect && counterpart
                  ? `Message @${counterpart.username}`
                  : `Message #${activeRoom?.slug ?? 'room'}`
              }
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={!activeRoom}
            />
            <button className="button" type="submit" disabled={!draft.trim() || !activeRoom}>
              Send
            </button>
          </div>
          <p className="composer__hint">
            Enter to send · Shift+Enter for a new line
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
                Only you and {counterpart.displayName.split(' ')[0]} can read this conversation.
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="roster__head">In this room — {roster.length}</p>
            {roster.length === 0 ? (
              <p className="roster__empty">Waiting for the first presence ping…</p>
            ) : (
              <ul className="roster__list">
                {roster.map((entry) => (
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
                    {entry.userId !== user.id && (
                      <button
                        type="button"
                        className="roster__dm"
                        aria-label={`Message ${entry.displayName} privately`}
                        title={`Message ${entry.displayName} privately`}
                        onClick={() =>
                          void openConversationWith({
                            id: entry.userId,
                            username: entry.username,
                            displayName: entry.displayName,
                            avatarHue: entry.avatarHue,
                            createdAt: '',
                          }).catch((error: Error) => setNotice(error.message))
                        }
                      >
                        Message
                      </button>
                    )}
                  </li>
                ))}
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
        <PeoplePicker
          onClose={() => setShowPicker(false)}
          onPick={async (person) => {
            await openConversationWith(person);
            setShowPicker(false);
          }}
        />
      )}
    </div>
  );
}

function MessageRow({
  message,
  grouped,
  mine,
}: {
  message: Message;
  grouped: boolean;
  mine: boolean;
}) {
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
            <time className="msg__time mono" dateTime={message.createdAt}>
              {timeOf(message.createdAt)}
            </time>
          </div>
        )}
        <div className="bubble">{message.body}</div>
      </div>
    </article>
  );
}

function PeoplePicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (person: PublicUser) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/directory?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        const data = (await response.json()) as { people?: PublicUser[] };
        if (!cancelled) setPeople(data.people ?? []);
      } catch {
        if (!cancelled) setError('Could not load people.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

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
        <p>Private, and only visible to the two of you.</p>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span className="visually-hidden">Search people</span>
          <input
            className="field__input"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search by name or @username"
            autoFocus
          />
        </label>

        <p className="eyebrow" style={{ marginBottom: 8 }}>
          {q ? 'Matches' : 'Recently active'}
        </p>

        {loading && people.length === 0 ? (
          <p className="roster__empty">Looking…</p>
        ) : people.length === 0 ? (
          <p className="roster__empty">
            {q ? `No one here matches “${q}”.` : 'Nobody has been active recently.'}
          </p>
        ) : (
          <ul className="picker__list">
            {people.map((person) => (
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
        <p>Public. Anyone signed in can join it.</p>

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
