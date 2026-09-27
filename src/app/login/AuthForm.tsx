'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Keyring, migratedMarker } from '@/lib/e2ee/keyring';
import type { KeyBundle, PublicUser } from '@/lib/types';

type Mode = 'signin' | 'register' | 'upgrade';

type AuthResponse = {
  user?: PublicUser;
  keys?: KeyBundle | null;
  error?: string;
  field?: string;
  legacy?: boolean;
};

const MIN_PASSWORD = 8;

function hasMigrated(username: string): boolean {
  try {
    return localStorage.getItem(migratedMarker(username)) === '1';
  } catch {
    return false;
  }
}

function markMigrated(username: string) {
  try {
    localStorage.setItem(migratedMarker(username), '1');
  } catch {
    /* private mode: the downgrade guard simply does not persist */
  }
}

export default function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setFieldError(null);
  }

  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as AuthResponse };
  }

  async function finish(user: PublicUser, keys: KeyBundle, vaultKey: CryptoKey) {
    setBusy('Unlocking your keys…');
    await Keyring.open(user.id, vaultKey, keys);
    markMigrated(user.username);
    router.replace('/chat');
    router.refresh();
  }

  async function signIn() {
    const name = username.trim();
    setBusy('Securing your sign-in…');
    const { authSecret, vaultKey } = await Keyring.derive(name, password);
    const { status, data } = await post('/api/auth/login', { username: name, authSecret });

    if (status === 200 && data.user && data.keys) return finish(data.user, data.keys, vaultKey);

    // A pre-encryption account. Offer the one-time upgrade - unless this
    // browser has already signed in to it the new way, in which case the
    // account cannot legitimately be legacy and something is trying to
    // downgrade it.
    if (status === 401 && data.legacy && !hasMigrated(name)) {
      setBusy(null);
      switchMode('upgrade');
      return;
    }
    throw new Error(data.error ?? 'Could not sign you in');
  }

  async function upgrade() {
    const name = username.trim();
    setBusy('Creating your encryption keys…');
    const { authSecret, vaultKey } = await Keyring.derive(name, password);
    const keys = await Keyring.createKeys(vaultKey);
    const { status, data } = await post('/api/auth/login', {
      username: name,
      password,
      upgrade: { authSecret, ...keys },
    });
    if (status === 200 && data.user && data.keys) return finish(data.user, data.keys, vaultKey);
    if (status === 409) {
      // Another tab won the upgrade race; its keys are the real ones.
      switchMode('signin');
    }
    throw new Error(data.error ?? 'Could not upgrade your account');
  }

  async function register() {
    const name = username.trim();
    if (password.length < MIN_PASSWORD) {
      setFieldError('password');
      throw new Error(`Use at least ${MIN_PASSWORD} characters`);
    }
    if (password !== confirm) {
      setFieldError('confirm');
      throw new Error("The passwords don't match");
    }
    setBusy('Creating your encryption keys…');
    const { authSecret, vaultKey } = await Keyring.derive(name, password);
    const keys = await Keyring.createKeys(vaultKey);
    const { status, data } = await post('/api/auth/register', {
      username: name,
      displayName: displayName || name,
      authSecret,
      ...keys,
    });
    if (status === 201 && data.user && data.keys) return finish(data.user, data.keys, vaultKey);
    setFieldError(data.field ?? null);
    throw new Error(data.error ?? 'Could not create your account');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldError(null);
    try {
      if (mode === 'register') await register();
      else if (mode === 'upgrade') await upgrade();
      else await signIn();
    } catch (caught) {
      setError(
        caught instanceof TypeError
          ? 'Could not reach the server. Check your connection and try again.'
          : (caught as Error).message,
      );
      setBusy(null);
    }
  }

  if (mode === 'upgrade') {
    return (
      <div className="auth__card">
        <h2 className="auth__title">Turn on encryption</h2>
        <p className="auth__subtitle">
          This account was created before private messages were end-to-end encrypted.
        </p>
        <div className="notice notice--info">
          <strong className="notice__title">What happens next</strong>
          <p className="notice__body">
            Your password is sent to the server <b>one last time</b> so it can check it and
            upgrade the account. After this it never leaves your browser again. Messages you
            already sent stay unencrypted; new private messages are encrypted.
          </p>
        </div>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={onSubmit}>
          <button className="button button--block" type="submit" disabled={busy !== null}>
            {busy ?? `Upgrade @${username.trim()}`}
          </button>
        </form>
        <button
          type="button"
          className="linkish linkish--dark"
          style={{ marginTop: 14 }}
          onClick={() => switchMode('signin')}
        >
          Cancel
        </button>
      </div>
    );
  }

  const isRegister = mode === 'register';

  return (
    <div className="auth__card">
      <div className="auth__tabs" role="tablist" aria-label="Sign in or create an account">
        <button
          type="button"
          role="tab"
          className="auth__tab"
          aria-selected={!isRegister}
          onClick={() => switchMode('signin')}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          className="auth__tab"
          aria-selected={isRegister}
          onClick={() => switchMode('register')}
        >
          Create account
        </button>
      </div>

      <h2 className="auth__title">{isRegister ? 'Create your account' : 'Welcome back'}</h2>
      <p className="auth__subtitle">
        {isRegister
          ? 'Your private messages are encrypted with a key only your password can unlock.'
          : 'Sign in to pick up where the room left off.'}
      </p>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} noValidate>
        <label className="field">
          <span className="field__label">Username</span>
          <input
            className="field__input"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={fieldError === 'username'}
            placeholder="ada"
          />
          {isRegister && (
            <span className="field__hint">
              3-24 characters. Letters, numbers, dot, dash or underscore.
            </span>
          )}
        </label>

        {isRegister && (
          <label className="field">
            <span className="field__label">Display name</span>
            <input
              className="field__input"
              name="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="nickname"
              placeholder="Ada Lovelace"
              aria-invalid={fieldError === 'displayName'}
            />
            <span className="field__hint">Optional. Defaults to your username.</span>
          </label>
        )}

        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
            aria-invalid={fieldError === 'password'}
            placeholder="••••••••"
          />
        </label>

        {isRegister && (
          <label className="field">
            <span className="field__label">Confirm password</span>
            <input
              className="field__input"
              name="confirm"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              required
              aria-invalid={fieldError === 'confirm'}
              placeholder="••••••••"
            />
            <span className="field__hint">
              At least {MIN_PASSWORD} characters. There is no reset: if you forget it, your
              private messages cannot be recovered - by anyone.
            </span>
          </label>
        )}

        <button className="button button--block" type="submit" disabled={busy !== null}>
          {busy ?? (isRegister ? 'Create account and join' : 'Sign in')}
        </button>
      </form>
    </div>
  );
}
