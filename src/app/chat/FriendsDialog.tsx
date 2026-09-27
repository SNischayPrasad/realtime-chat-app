'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { DirectoryEntry, FriendsSnapshot, PublicUser } from '@/lib/types';

type Tab = 'friends' | 'requests' | 'add' | 'blocked';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Person({ person, children }: { person: PublicUser; children?: React.ReactNode }) {
  return (
    <li className="friend">
      <span
        className="avatar avatar--sm"
        style={{ background: `hsl(${person.avatarHue} 42% 38%)` }}
        aria-hidden="true"
      >
        {initials(person.displayName)}
      </span>
      <span className="friend__who">
        <span className="friend__name">{person.displayName}</span>
        <span className="friend__handle mono">@{person.username}</span>
      </span>
      <span className="friend__actions">{children}</span>
    </li>
  );
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok && response.status !== 204) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Something went wrong');
  }
  return response.status === 204 ? null : ((await response.json()) as Record<string, unknown>);
}

export default function FriendsDialog({
  snapshot,
  initialTab = 'friends',
  onChanged,
  onMessage,
  onClose,
}: {
  snapshot: FriendsSnapshot | null;
  initialTab?: Tab;
  onChanged: () => Promise<void> | void;
  onMessage: (person: PublicUser) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<DirectoryEntry | null | 'none'>(null);
  const [blocked, setBlocked] = useState<PublicUser[] | null>(null);

  const incoming = snapshot?.incoming ?? [];
  const outgoing = snapshot?.outgoing ?? [];
  const friends = snapshot?.friends ?? [];

  // Keep a looked-up person's relation in step with the live friends list, so
  // "Request sent" becomes "Already friends" the moment they accept.
  useEffect(() => {
    if (!found || found === 'none' || !snapshot) return;
    const has = (list: { user: PublicUser }[]) => list.some((entry) => entry.user.id === found.id);
    const relation = has(snapshot.friends)
      ? 'friend'
      : has(snapshot.outgoing)
        ? 'outgoing'
        : has(snapshot.incoming)
          ? 'incoming'
          : 'none';
    if (relation !== found.relation) setFound({ ...found, relation });
  }, [snapshot, found]);

  useEffect(() => {
    if (tab !== 'blocked') return;
    void call('GET', '/api/blocks')
      .then((data) => setBlocked((data?.blocked as PublicUser[]) ?? []))
      .catch(() => setError('Could not load your block list'));
  }, [tab]);

  async function act(key: string, action: () => Promise<unknown>, success?: string) {
    setBusy(key);
    setError(null);
    setInfo(null);
    try {
      await action();
      if (success) setInfo(success);
      await onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function lookUp(event: FormEvent) {
    event.preventDefault();
    const q = query.trim().replace(/^@/, '');
    if (q.length < 3) {
      setError('Enter their exact username (at least 3 characters).');
      return;
    }
    setBusy('lookup');
    setError(null);
    setInfo(null);
    try {
      const response = await fetch(`/api/directory?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const data = (await response.json()) as { people?: DirectoryEntry[] };
      const match = data.people?.find((p) => p.username.toLowerCase() === q.toLowerCase());
      setFound(match ?? 'none');
    } catch {
      setError('Could not search right now.');
    } finally {
      setBusy(null);
    }
  }

  const tabs: Array<[Tab, string]> = [
    ['friends', `Friends${friends.length ? ` (${friends.length})` : ''}`],
    ['requests', `Requests${incoming.length ? ` (${incoming.length})` : ''}`],
    ['add', 'Add friend'],
    ['blocked', 'Blocked'],
  ];

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="friends-title">
        <h2 id="friends-title">Friends</h2>
        <p>Private conversations and calls are only possible between friends.</p>

        <div className="tabs" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="tabs__tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
                setError(null);
                setInfo(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {info && (
          <div className="notice notice--ok" role="status">
            <p className="notice__body">{info}</p>
          </div>
        )}

        {tab === 'friends' &&
          (friends.length === 0 ? (
            <p className="roster__empty">
              No friends yet.{' '}
              <button type="button" className="linkish linkish--dark" onClick={() => setTab('add')}>
                Add someone by username
              </button>
              .
            </p>
          ) : (
            <ul className="friend-list">
              {friends.map(({ user: person }) => (
                <Person key={person.id} person={person}>
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => void onMessage(person).catch((e: Error) => setError(e.message))}
                  >
                    Message
                  </button>
                  <button
                    type="button"
                    className="button button--small button--ghost"
                    disabled={busy === `unfriend:${person.id}`}
                    onClick={() =>
                      act(`unfriend:${person.id}`, () => call('DELETE', `/api/friends/${person.id}`))
                    }
                  >
                    Unfriend
                  </button>
                  <button
                    type="button"
                    className="button button--small button--danger"
                    disabled={busy === `block:${person.id}`}
                    onClick={() =>
                      act(
                        `block:${person.id}`,
                        () => call('POST', '/api/blocks', { userId: person.id }),
                        `${person.displayName} is blocked.`,
                      )
                    }
                  >
                    Block
                  </button>
                </Person>
              ))}
            </ul>
          ))}

        {tab === 'requests' && (
          <>
            <p className="eyebrow">Waiting for you</p>
            {incoming.length === 0 ? (
              <p className="roster__empty">No requests.</p>
            ) : (
              <ul className="friend-list">
                {incoming.map(({ user: person }) => (
                  <Person key={person.id} person={person}>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          `accept:${person.id}`,
                          () => call('POST', `/api/friends/requests/${person.id}/accept`),
                          `You and ${person.displayName} are now friends.`,
                        )
                      }
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="button button--small button--ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        act(`decline:${person.id}`, () =>
                          call('POST', `/api/friends/requests/${person.id}/decline`),
                        )
                      }
                    >
                      Decline
                    </button>
                  </Person>
                ))}
              </ul>
            )}
            <p className="eyebrow" style={{ marginTop: 16 }}>
              Sent by you
            </p>
            {outgoing.length === 0 ? (
              <p className="roster__empty">Nothing pending.</p>
            ) : (
              <ul className="friend-list">
                {outgoing.map(({ user: person }) => (
                  <Person key={person.id} person={person}>
                    <button
                      type="button"
                      className="button button--small button--ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        act(`cancel:${person.id}`, () =>
                          call('DELETE', `/api/friends/requests/${person.id}`),
                        )
                      }
                    >
                      Cancel
                    </button>
                  </Person>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'add' && (
          <>
            <form onSubmit={lookUp} className="add-friend">
              <label className="visually-hidden" htmlFor="add-friend">
                Their exact username
              </label>
              <input
                id="add-friend"
                className="field__input"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setFound(null);
                }}
                placeholder="@username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
              <button type="submit" className="button" disabled={busy !== null}>
                Find
              </button>
            </form>
            <p className="field__hint">
              Exact usernames only - there is no browsing other people&apos;s accounts.
            </p>
            {found === 'none' && <p className="roster__empty">No one has that username.</p>}
            {found && found !== 'none' && (
              <ul className="friend-list">
                <Person person={found}>
                  {found.relation === 'friend' ? (
                    <span className="eyebrow">Already friends</span>
                  ) : found.relation === 'outgoing' ? (
                    <span className="eyebrow">Request sent</span>
                  ) : (
                    <button
                      type="button"
                      className="button button--small"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          `request:${found.id}`,
                          async () => {
                            const data = await call('POST', '/api/friends/requests', {
                              userId: found.id,
                            });
                            setFound({
                              ...found,
                              relation: data?.status === 'accepted' ? 'friend' : 'outgoing',
                            });
                          },
                          found.relation === 'incoming'
                            ? `You and ${found.displayName} are now friends.`
                            : `Request sent to ${found.displayName}.`,
                        )
                      }
                    >
                      {found.relation === 'incoming' ? 'Accept request' : 'Add friend'}
                    </button>
                  )}
                </Person>
              </ul>
            )}
          </>
        )}

        {tab === 'blocked' &&
          (blocked === null ? (
            <p className="roster__empty">Loading…</p>
          ) : blocked.length === 0 ? (
            <p className="roster__empty">You haven&apos;t blocked anyone.</p>
          ) : (
            <ul className="friend-list">
              {blocked.map((person) => (
                <Person key={person.id} person={person}>
                  <button
                    type="button"
                    className="button button--small button--ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      act(`unblock:${person.id}`, async () => {
                        await call('DELETE', `/api/blocks/${person.id}`);
                        setBlocked((current) => (current ?? []).filter((p) => p.id !== person.id));
                      })
                    }
                  >
                    Unblock
                  </button>
                </Person>
              ))}
            </ul>
          ))}

        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
