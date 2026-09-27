'use client';

import { useState, type FormEvent } from 'react';
import { Keyring, migratedMarker } from '@/lib/e2ee/keyring';
import type { KeyBundle, PublicUser } from '@/lib/types';

export type GateReason = 'locked' | 'no-keys' | 'rollback' | 'error';

/**
 * Shown when the browser is signed in but does not hold the user's keys.
 *
 *   locked   - keys exist but this browser lost them (cleared site data, new
 *              profile). The password re-derives the vault key; the server is
 *              not asked to check anything, because only the right password
 *              can open the vault.
 *   no-keys  - an account from before encryption, still on an old session.
 *              Upgraded exactly like at sign-in: the password is verified one
 *              final time and never sent again.
 *   rollback - the server served an older copy of the keys than this browser
 *              has already seen. Refused, because that is how a hostile server
 *              would undo a key change or a verification.
 */
export default function EncryptionGate({
  user,
  reason,
  onReady,
  onSignOut,
}: {
  user: PublicUser;
  reason: GateReason;
  onReady: (keyring: Keyring) => void;
  onSignOut: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (reason === 'locked') {
        onReady(await Keyring.unlock(user.id, user.username, password));
        return;
      }
      const { authSecret, vaultKey } = await Keyring.derive(user.username, password);
      const keys = await Keyring.createKeys(vaultKey);
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: user.username,
          password,
          upgrade: { authSecret, ...keys },
        }),
      });
      const data = (await response.json()) as { keys?: KeyBundle; error?: string };
      if (!response.ok || !data.keys) throw new Error(data.error ?? 'Could not turn on encryption');
      const keyring = await Keyring.open(user.id, vaultKey, data.keys);
      try {
        localStorage.setItem(migratedMarker(user.username), '1');
      } catch {
        /* private mode */
      }
      onReady(keyring);
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  }

  if (reason === 'rollback' || reason === 'error') {
    return (
      <main className="gate">
        <div className="gate__card">
          <h1 className="auth__title">
            {reason === 'rollback' ? 'Your keys look out of date' : 'Could not load your keys'}
          </h1>
          <p className="auth__subtitle">
            {reason === 'rollback'
              ? 'The server sent an older copy of your encryption keys than this browser has already seen, so they were not used. This should not happen; if it keeps happening, do not trust this server with private messages.'
              : 'Something went wrong loading your encryption keys. Reload the page to try again.'}
          </p>
          <button type="button" className="button button--ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="gate">
      <form className="gate__card" onSubmit={submit}>
        <span className="gate__lock" aria-hidden="true">
          ◈
        </span>
        <h1 className="auth__title">
          {reason === 'locked' ? 'Unlock your messages' : 'Turn on encryption'}
        </h1>
        <p className="auth__subtitle">
          {reason === 'locked'
            ? 'This browser does not have your encryption keys yet. Your password unlocks them - it is not sent anywhere.'
            : 'Your account was created before private messages were end-to-end encrypted. Your password is checked by the server one last time to upgrade it, and never sent again.'}
        </p>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span className="field__label">Password for @{user.username}</span>
          <input
            className="field__input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>

        <button className="button button--block" type="submit" disabled={busy || !password}>
          {busy ? 'Working…' : reason === 'locked' ? 'Unlock' : 'Turn on encryption'}
        </button>
        <button
          type="button"
          className="linkish linkish--dark"
          style={{ marginTop: 14 }}
          onClick={onSignOut}
        >
          Sign out instead
        </button>
      </form>
    </main>
  );
}
