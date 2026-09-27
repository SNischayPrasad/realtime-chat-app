'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { randomNonce, type ConversationCrypto, type Keyring } from '@/lib/e2ee/keyring';
import type { Call, CallMedia, CallSignal, Conversation, PublicUser } from '@/lib/types';

/**
 * 1:1 voice and video calls.
 *
 * Media flows directly between the two browsers over WebRTC and is encrypted
 * by DTLS-SRTP; it never touches this server. The server only relays the
 * signalling needed to set the connection up - and every signal (SDP offers,
 * answers, ICE candidates) is sealed here with a key derived from both users'
 * identity keys before it is sent. That matters: an unsealed SDP carries both
 * people's IP addresses and the DTLS fingerprint, and a server able to swap the
 * fingerprint could sit in the middle of the media.
 */

export type CallPhase = 'ringing' | 'connecting' | 'connected' | 'ended';

export type CallView = {
  call: Call;
  direction: 'incoming' | 'outgoing';
  peer: PublicUser;
  phase: CallPhase;
  startedAt: number | null;
  message: string | null;
  peerMuted: boolean;
  peerCameraOff: boolean;
};

type MediaState = { muted: boolean; cameraOff: boolean };

const RING_TIMEOUT_MS = 45_000;
const HEARTBEAT_MS = 15_000;

const ENDED_MESSAGES: Record<string, string> = {
  declined: 'Call declined',
  missed: 'No answer',
  cancelled: 'Call cancelled',
  ended: 'Call ended',
  failed: 'Call failed',
  timeout: 'No answer',
  stale: 'Call dropped',
};

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* 202/204 */
  }
  return { status: response.status, data };
}

function describeMediaError(error: unknown, media: CallMedia): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return media === 'video'
      ? 'Camera and microphone access was blocked. Allow it in your browser to call.'
      : 'Microphone access was blocked. Allow it in your browser to call.';
  }
  if (name === 'NotFoundError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError') return 'Your camera or microphone is being used by another app.';
  return 'Could not start your camera or microphone.';
}

export function useCalls({
  user,
  keyring,
  conversations,
  onNotice,
}: {
  user: PublicUser;
  keyring: Keyring | null;
  conversations: Conversation[];
  onNotice: (message: string) => void;
}) {
  const [view, setView] = useState<CallView | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [media, setMedia] = useState<MediaState>({ muted: false, cameraOff: false });

  const pc = useRef<RTCPeerConnection | null>(null);
  const call = useRef<Call | null>(null);
  const direction = useRef<'incoming' | 'outgoing' | null>(null);
  const convRef = useRef<ConversationCrypto | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const buffered = useRef<CallSignal[]>([]);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const relay = useRef(false);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationsRef = useRef(conversations);
  const keyringRef = useRef(keyring);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    keyringRef.current = keyring;
  }, [keyring]);

  /* ---- helpers ----------------------------------------------------------- */

  const patchView = useCallback((patch: Partial<CallView>) => {
    setView((current) => (current ? { ...current, ...patch } : current));
  }, []);

  /** Who is on the other end, and their key - from the conversation list. */
  const resolvePeer = useCallback(async (roomId: string) => {
    let entry = conversationsRef.current.find((c) => c.room.id === roomId);
    if (!entry) {
      const response = await fetch('/api/conversations', { cache: 'no-store' });
      const data = (await response.json()) as { conversations?: Conversation[] };
      entry = data.conversations?.find((c) => c.room.id === roomId);
    }
    return entry ?? null;
  }, []);

  const teardown = useCallback(
    (reason: string | null) => {
      if (ringTimer.current) clearTimeout(ringTimer.current);
      if (heartbeat.current) clearInterval(heartbeat.current);
      ringTimer.current = null;
      heartbeat.current = null;

      pc.current?.getSenders().forEach((sender) => sender.track?.stop());
      pc.current?.close();
      pc.current = null;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      call.current = null;
      direction.current = null;
      convRef.current = null;
      buffered.current = [];
      pendingIce.current = [];

      setLocalStream(null);
      setRemoteStream(null);
      setMedia({ muted: false, cameraOff: false });
      setView((current) =>
        current
          ? {
              ...current,
              phase: 'ended',
              message: reason ? (ENDED_MESSAGES[reason] ?? reason) : 'Call ended',
            }
          : current,
      );
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(() => setView(null), 2600);
    },
    [],
  );

  const transition = useCallback(async (callId: string, action: string, reason?: string) => {
    return postJson(`/api/calls/${callId}/state`, { action, reason });
  }, []);

  const sendSignal = useCallback(async (kind: CallSignal['kind'], payload: unknown) => {
    const current = call.current;
    const ring = keyringRef.current;
    if (!current || !convRef.current || !ring) return;
    const sealed = await ring.sealSignal(convRef.current, current.id, payload);
    await postJson(`/api/calls/${current.id}/signal`, {
      kind,
      sigNonce: sealed.nonce,
      iv: sealed.iv,
      payload: sealed.body,
    });
  }, []);

  const fail = useCallback(
    async (message: string) => {
      const current = call.current;
      if (current) await transition(current.id, 'fail', 'connection').catch(() => undefined);
      teardown(message);
    },
    [teardown, transition],
  );

  const getMedia = useCallback(async (kind: CallMedia): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video:
          kind === 'video'
            ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
            : false,
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      // No camera (or it is busy): fall back to voice rather than failing.
      if (kind === 'video' && (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError')) {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        setMedia((current) => ({ ...current, cameraOff: true }));
        return audioOnly;
      }
      throw error;
    }
  }, []);

  const flushIce = useCallback(async () => {
    const connection = pc.current;
    if (!connection?.remoteDescription) return;
    const queued = pendingIce.current;
    pendingIce.current = [];
    for (const candidate of queued) {
      await connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      const connection = pc.current;
      const ring = keyringRef.current;
      if (!connection || !convRef.current || !ring) return;

      let payload: unknown;
      try {
        payload = await ring.openSignal(convRef.current, signal.callId, signal);
      } catch {
        // Fails authentication: not sealed by the other participant under the
        // keys you both hold. Dropped rather than applied.
        console.warn('[calls] dropped a signal that failed authentication');
        return;
      }

      if (signal.kind === 'offer') {
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await flushIce();
        if (direction.current === 'incoming') {
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
          await sendSignal('answer', { type: answer.type, sdp: answer.sdp });
        }
      } else if (signal.kind === 'answer') {
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await flushIce();
      } else if (signal.kind === 'ice') {
        if (connection.remoteDescription) {
          await connection.addIceCandidate(payload as RTCIceCandidateInit).catch(() => undefined);
        } else {
          pendingIce.current.push(payload as RTCIceCandidateInit);
        }
      } else if (signal.kind === 'media-state') {
        const state = payload as MediaState;
        patchView({ peerMuted: Boolean(state.muted), peerCameraOff: Boolean(state.cameraOff) });
      }
    },
    [flushIce, patchView, sendSignal],
  );

  const drainBuffered = useCallback(async () => {
    const current = call.current;
    if (!current) return;
    const mine = buffered.current
      .filter((signal) => signal.callId === current.id)
      .sort((a, b) => Number(a.id) - Number(b.id));
    buffered.current = buffered.current.filter((signal) => signal.callId !== current.id);
    // The offer must be applied before any candidates.
    mine.sort((a, b) => (a.kind === 'offer' ? -1 : b.kind === 'offer' ? 1 : 0));
    for (const signal of mine) await handleSignal(signal);
  }, [handleSignal]);

  const createConnection = useCallback(
    async (localMedia: MediaStream) => {
      const ice = (await fetch('/api/ice', { cache: 'no-store' }).then((r) => r.json())) as {
        iceServers: RTCIceServer[];
        relay: boolean;
      };
      relay.current = ice.relay;

      const connection = new RTCPeerConnection({ iceServers: ice.iceServers });
      pc.current = connection;
      localMedia.getTracks().forEach((track) => connection.addTrack(track, localMedia));

      connection.onicecandidate = (event) => {
        if (event.candidate) void sendSignal('ice', event.candidate.toJSON());
      };
      connection.ontrack = (event) => {
        setRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
      };
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'connected') {
          setView((current) =>
            current && current.phase !== 'connected'
              ? { ...current, phase: 'connected', startedAt: Date.now(), message: null }
              : current,
          );
        } else if (connection.connectionState === 'failed') {
          void fail(
            relay.current
              ? "Couldn't connect the call."
              : "Couldn't connect: one of your networks blocks direct connections, and no relay (TURN) server is configured.",
          );
        }
      };
      return connection;
    },
    [fail, sendSignal],
  );

  const startHeartbeat = useCallback(() => {
    if (heartbeat.current) clearInterval(heartbeat.current);
    heartbeat.current = setInterval(async () => {
      const current = call.current;
      if (!current) return;
      const response = await fetch(`/api/calls/${current.id}/heartbeat`, { method: 'POST' }).catch(
        () => null,
      );
      if (response?.status === 409 || response?.status === 404) teardown('ended');
    }, HEARTBEAT_MS);
  }, [teardown]);

  /** Refuses to call or answer across a key the user has not accepted. */
  const prepareCrypto = useCallback(async (entry: Conversation) => {
    const ring = keyringRef.current;
    if (!ring || !entry.counterpartKey) {
      throw new Error(`${entry.counterpart.displayName} needs to sign in again before calls work.`);
    }
    if ((await ring.pinState(entry.counterpart.id, entry.counterpartKey)) === 'changed') {
      throw new Error(
        `${entry.counterpart.displayName}'s security key changed. Verify it in the conversation first.`,
      );
    }
    convRef.current = await ring.conversation(entry.room.id, entry.counterpart.id, entry.counterpartKey);
  }, []);

  /* ---- outgoing ----------------------------------------------------------- */

  const startCall = useCallback(
    async (entry: Conversation, kind: CallMedia) => {
      if (call.current) {
        onNotice('You are already in a call.');
        return;
      }
      if (dismissTimer.current) clearTimeout(dismissTimer.current);

      try {
        await prepareCrypto(entry);
      } catch (error) {
        convRef.current = null;
        onNotice((error as Error).message);
        return;
      }

      // Ask for the camera/microphone BEFORE ringing anyone, so a denied
      // permission does not leave the other person answering to silence.
      let localMedia: MediaStream;
      try {
        localMedia = await getMedia(kind);
      } catch (error) {
        convRef.current = null;
        onNotice(describeMediaError(error, kind));
        return;
      }

      const { status, data } = await postJson(`/api/rooms/${entry.room.id}/calls`, {
        media: kind,
        clientNonce: randomNonce(),
      });
      if (status !== 201 && status !== 200) {
        localMedia.getTracks().forEach((track) => track.stop());
        convRef.current = null;
        onNotice(
          data.reason === 'glare'
            ? `${entry.counterpart.displayName} is calling you - answer their call.`
            : String(data.error ?? 'Could not start the call.'),
        );
        return;
      }

      const created = data.call as Call;
      call.current = created;
      direction.current = 'outgoing';
      stream.current = localMedia;
      setLocalStream(localMedia);
      setView({
        call: created,
        direction: 'outgoing',
        peer: entry.counterpart,
        phase: 'ringing',
        startedAt: null,
        message: null,
        peerMuted: false,
        peerCameraOff: false,
      });

      try {
        const connection = await createConnection(localMedia);
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await sendSignal('offer', { type: offer.type, sdp: offer.sdp });
      } catch {
        await transition(created.id, 'cancel').catch(() => undefined);
        teardown('Call failed');
        return;
      }

      ringTimer.current = setTimeout(async () => {
        const current = call.current;
        if (current?.id === created.id && current.state === 'ringing') {
          await transition(created.id, 'missed', 'timeout').catch(() => undefined);
          teardown('missed');
        }
      }, RING_TIMEOUT_MS);
    },
    [createConnection, getMedia, onNotice, prepareCrypto, sendSignal, teardown, transition],
  );

  /* ---- incoming ----------------------------------------------------------- */

  const accept = useCallback(async () => {
    const current = call.current;
    if (!current || direction.current !== 'incoming') return;
    const entry = await resolvePeer(current.roomId);
    try {
      if (!entry) throw new Error('This conversation is no longer available.');
      await prepareCrypto(entry);
    } catch (error) {
      await transition(current.id, 'decline', 'key').catch(() => undefined);
      teardown((error as Error).message);
      return;
    }

    let localMedia: MediaStream;
    try {
      localMedia = await getMedia(current.media);
    } catch (error) {
      await transition(current.id, 'decline', 'media').catch(() => undefined);
      teardown(describeMediaError(error, current.media));
      return;
    }
    stream.current = localMedia;
    setLocalStream(localMedia);

    const { status } = await transition(current.id, 'accept');
    if (status !== 200) {
      teardown('This call is no longer ringing.');
      return;
    }
    patchView({ phase: 'connecting' });
    await createConnection(localMedia);
    startHeartbeat();
    await drainBuffered();
  }, [createConnection, drainBuffered, getMedia, patchView, prepareCrypto, resolvePeer, startHeartbeat, teardown, transition]);

  const decline = useCallback(async () => {
    const current = call.current;
    if (!current) return;
    await transition(current.id, 'decline').catch(() => undefined);
    teardown('declined');
  }, [teardown, transition]);

  const hangUp = useCallback(async () => {
    const current = call.current;
    if (!current) {
      setView(null);
      return;
    }
    const action =
      current.state === 'accepted'
        ? 'end'
        : direction.current === 'outgoing'
          ? 'cancel'
          : 'decline';
    await transition(current.id, action).catch(() => undefined);
    teardown(action === 'end' ? 'ended' : action === 'cancel' ? 'cancelled' : 'declined');
  }, [teardown, transition]);

  const toggleMute = useCallback(() => {
    setMedia((current) => {
      const muted = !current.muted;
      stream.current?.getAudioTracks().forEach((track) => (track.enabled = !muted));
      void sendSignal('media-state', { muted, cameraOff: current.cameraOff });
      return { ...current, muted };
    });
  }, [sendSignal]);

  const toggleCamera = useCallback(() => {
    setMedia((current) => {
      if (!stream.current?.getVideoTracks().length) return current;
      const cameraOff = !current.cameraOff;
      stream.current.getVideoTracks().forEach((track) => (track.enabled = !cameraOff));
      void sendSignal('media-state', { muted: current.muted, cameraOff });
      return { ...current, cameraOff };
    });
  }, [sendSignal]);

  /* ---- stream frames ------------------------------------------------------ */

  const onCallFrame = useCallback(
    async (incoming: Call) => {
      const current = call.current;

      if (current && current.id === incoming.id) {
        call.current = incoming;
        if (incoming.state === 'accepted' && direction.current === 'outgoing') {
          if (ringTimer.current) clearTimeout(ringTimer.current);
          patchView({ phase: 'connecting', call: incoming });
          startHeartbeat();
        } else if (['declined', 'missed', 'cancelled', 'failed', 'ended'].includes(incoming.state)) {
          teardown(incoming.endReason && ENDED_MESSAGES[incoming.endReason] ? incoming.endReason : incoming.state);
        }
        return;
      }

      if (incoming.state !== 'ringing' || incoming.calleeId !== user.id || current) return;

      const entry = await resolvePeer(incoming.roomId);
      if (!entry) return;
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      call.current = incoming;
      direction.current = 'incoming';
      setView({
        call: incoming,
        direction: 'incoming',
        peer: entry.counterpart,
        phase: 'ringing',
        startedAt: null,
        message: null,
        peerMuted: false,
        peerCameraOff: false,
      });
    },
    [patchView, resolvePeer, startHeartbeat, teardown, user.id],
  );

  const onSignal = useCallback(
    async (signal: CallSignal) => {
      if (seen.current.has(signal.id)) return;
      seen.current.add(signal.id);
      if (!pc.current || call.current?.id !== signal.callId || !convRef.current) {
        buffered.current.push(signal);
        return;
      }
      await handleSignal(signal);
    },
    [handleSignal],
  );

  /* ---- leaving the page mid-call ------------------------------------------ */

  useEffect(() => {
    const onPageHide = () => {
      const current = call.current;
      if (!current) return;
      const action =
        current.state === 'accepted' ? 'end' : direction.current === 'outgoing' ? 'cancel' : null;
      if (!action) return;
      navigator.sendBeacon(
        `/api/calls/${current.id}/state`,
        new Blob([JSON.stringify({ action, reason: 'left' })], { type: 'application/json' }),
      );
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  return {
    view,
    localStream,
    remoteStream,
    muted: media.muted,
    cameraOff: media.cameraOff,
    startCall,
    accept,
    decline,
    hangUp,
    toggleMute,
    toggleCamera,
    onCallFrame,
    onSignal,
    dismiss: () => setView(null),
  };
}
