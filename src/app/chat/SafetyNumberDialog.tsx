'use client';

import { useEffect, useState } from 'react';
import type { Keyring, PinState } from '@/lib/e2ee/keyring';
import type { PublicUser } from '@/lib/types';

/**
 * Safety numbers are how two people confirm nobody swapped their keys.
 *
 * The server hands out public keys, so the server is exactly the party that
 * could substitute one and read everything. The digits are computed here, in
 * the browser, from the two keys actually in use - never taken from the server
 * - and both people see the same digits only if both hold the same two keys.
 */
export default function SafetyNumberDialog({
  keyring,
  peer,
  peerKey,
  state,
  onTrusted,
  onClose,
}: {
  keyring: Keyring;
  peer: PublicUser;
  peerKey: string;
  state: PinState;
  onTrusted: (state: PinState) => void;
  onClose: () => void;
}) {
  const [digits, setDigits] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void keyring.safetyNumber(peer.id, peerKey).then((value) => {
      if (!cancelled) setDigits(value);
    });
    return () => {
      cancelled = true;
    };
  }, [keyring, peer.id, peerKey]);

  const groups = digits ? digits.split(/\s+/).filter(Boolean) : [];

  async function markVerified() {
    setBusy(true);
    setError(null);
    try {
      await keyring.trust(peer.id, peerKey, true);
      onTrusted('verified');
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
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="safety-title">
        <h2 id="safety-title">Verify {peer.displayName}</h2>
        <p>
          Compare these numbers with {peer.displayName.split(' ')[0]} in person or on a call. If
          they match on both screens, nobody - including whoever runs this server - is
          intercepting your conversation.
        </p>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <div className="safety" aria-label="Safety number">
          {groups.length === 0 ? (
            <span className="roster__empty">Computing…</span>
          ) : (
            groups.map((group, index) => (
              <span className="safety__group mono" key={index}>
                {group}
              </span>
            ))
          )}
        </div>

        {state === 'verified' ? (
          <p className="verified-line">
            <span className="verified-dot" aria-hidden="true" /> You verified {peer.displayName}.
            If their key ever changes, you will be warned.
          </p>
        ) : (
          <p className="field__hint">
            Marking as verified is remembered on every device you sign in to.
          </p>
        )}

        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Close
          </button>
          {state !== 'verified' && (
            <button type="button" className="button" disabled={busy || !digits} onClick={markVerified}>
              {busy ? 'Saving…' : 'They match - mark verified'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
