'use client';

import { useEffect, useRef, useState } from 'react';
import type { CallView } from './useCalls';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * A synthesized ring, so there is no audio asset to ship. Browsers may refuse
 * to start audio without a prior user gesture; if so the call still rings
 * visually and the failure is silent.
 */
function useRing(pattern: 'incoming' | 'outgoing' | null) {
  useEffect(() => {
    if (!pattern) return;
    let context: AudioContext | null = null;
    let stopped = false;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const ring = () => {
      if (stopped || !context) return;
      const now = context.currentTime;
      const tones = pattern === 'incoming' ? [440, 554] : [425];
      for (const [index, frequency] of tones.entries()) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(pattern === 'incoming' ? 0.08 : 0.04, now + 0.05);
        gain.gain.setValueAtTime(pattern === 'incoming' ? 0.08 : 0.04, now + 0.9);
        gain.gain.linearRampToValueAtTime(0, now + 1);
        osc.connect(gain).connect(context.destination);
        osc.start(now + index * 0.02);
        osc.stop(now + 1.05);
      }
    };
    void context.resume().catch(() => undefined);
    ring();
    const timer = setInterval(ring, pattern === 'incoming' ? 2500 : 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
      void context?.close().catch(() => undefined);
    };
  }, [pattern]);
}

function MediaElement({
  stream,
  kind,
  muted,
  className,
}: {
  stream: MediaStream | null;
  kind: 'video' | 'audio';
  muted?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return kind === 'video' ? (
    <video ref={ref} className={className} autoPlay playsInline muted={muted} />
  ) : (
    <audio ref={ref} autoPlay />
  );
}

export default function CallOverlay({
  view,
  localStream,
  remoteStream,
  muted,
  cameraOff,
  onAccept,
  onDecline,
  onHangUp,
  onToggleMute,
  onToggleCamera,
  onDismiss,
}: {
  view: CallView;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const isVideo = view.call.media === 'video';
  const ringingIn = view.phase === 'ringing' && view.direction === 'incoming';
  const ringingOut = view.phase === 'ringing' && view.direction === 'outgoing';

  useRing(ringingIn ? 'incoming' : ringingOut ? 'outgoing' : null);

  useEffect(() => {
    if (view.phase !== 'connected') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view.phase]);

  const peerAvatar = (
    <span className="call__avatar" style={{ background: `hsl(${view.peer.avatarHue} 42% 38%)` }}>
      {initials(view.peer.displayName)}
    </span>
  );

  // Ringing either way, or ended: a compact card rather than the full stage.
  if (view.phase === 'ringing' || view.phase === 'ended') {
    return (
      <div className="call-scrim" role="dialog" aria-modal="true" aria-label="Call">
        <div className="call-card">
          <div className={`call-card__ring ${ringingIn ? 'call-card__ring--live' : ''}`}>
            {peerAvatar}
          </div>
          <p className="call-card__name">{view.peer.displayName}</p>
          <p className="call-card__status" aria-live="polite">
            {view.phase === 'ended'
              ? view.message
              : ringingIn
                ? `Incoming ${isVideo ? 'video' : 'voice'} call`
                : `Calling…`}
          </p>
          <p className="call-card__lock mono">End-to-end encrypted</p>

          <div className="call-card__actions">
            {ringingIn && (
              <>
                <button type="button" className="call-btn call-btn--decline" onClick={onDecline}>
                  Decline
                </button>
                <button type="button" className="call-btn call-btn--accept" onClick={onAccept}>
                  Accept
                </button>
              </>
            )}
            {ringingOut && (
              <button type="button" className="call-btn call-btn--decline" onClick={onHangUp}>
                Cancel
              </button>
            )}
            {view.phase === 'ended' && (
              <button type="button" className="call-btn" onClick={onDismiss}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showRemoteVideo = isVideo && remoteStream && !view.peerCameraOff;

  return (
    <div className="call-stage" role="dialog" aria-modal="true" aria-label="Call in progress">
      <div className="call-stage__remote">
        {showRemoteVideo ? (
          <MediaElement stream={remoteStream} kind="video" className="call-stage__video" />
        ) : (
          <div className="call-stage__placeholder">
            {peerAvatar}
            <p className="call-card__name">{view.peer.displayName}</p>
          </div>
        )}
        {/* Audio always plays through its own element, so a voice call and a
            camera-off video call sound the same. */}
        {!showRemoteVideo && <MediaElement stream={remoteStream} kind="audio" />}
      </div>

      <div className="call-stage__top">
        <span className="call-stage__peer">{view.peer.displayName}</span>
        <span className="mono call-stage__meta">
          {view.phase === 'connected' && view.startedAt
            ? clock(now - view.startedAt)
            : 'Connecting…'}
          {' · '}End-to-end encrypted
          {view.peerMuted ? ' · they are muted' : ''}
        </span>
      </div>

      {isVideo && localStream && !cameraOff && (
        <MediaElement stream={localStream} kind="video" muted className="call-stage__self" />
      )}

      <div className="call-stage__controls">
        <button
          type="button"
          className={`call-btn ${muted ? 'call-btn--on' : ''}`}
          onClick={onToggleMute}
          aria-pressed={muted}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        {isVideo && (
          <button
            type="button"
            className={`call-btn ${cameraOff ? 'call-btn--on' : ''}`}
            onClick={onToggleCamera}
            aria-pressed={cameraOff}
          >
            {cameraOff ? 'Camera on' : 'Camera off'}
          </button>
        )}
        <button type="button" className="call-btn call-btn--decline" onClick={onHangUp}>
          Hang up
        </button>
      </div>
    </div>
  );
}
