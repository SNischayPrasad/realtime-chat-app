'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type Mode = 'signin' | 'register';

export default function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setFieldError(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldError(null);

    const endpoint = mode === 'signin' ? '/api/auth/login' : '/api/auth/register';
    const payload =
      mode === 'signin'
        ? { username, password }
        : { username, password, displayName: displayName || username };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string; field?: string };

      if (!response.ok) {
        setError(data.error ?? 'Something went wrong, please try again');
        setFieldError(data.field ?? null);
        return;
      }

      router.replace('/chat');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
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
          ? 'Pick a handle and a password. That is all it takes.'
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
          {isRegister && <span className="field__hint">At least 8 characters.</span>}
        </label>

        <button className="button button--block" type="submit" disabled={busy}>
          {busy ? 'Working…' : isRegister ? 'Create account and join' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
