import { randomUUID } from 'node:crypto';
import { HAS_DATABASE } from './config';
import { query } from './db';
import { loadRoomFor } from './rooms';
import {
  TERMINAL_CALL_STATES,
  type Call,
  type CallMedia,
  type CallSignal,
  type CallSignalKind,
  type CallState,
  type PublicUser,
} from './types';

/**
 * 1:1 calls: the ringing/accept/hang-up state machine, and the signalling
 * mailbox that carries sealed SDP and ICE between the two browsers.
 *
 * The media itself never touches this server: WebRTC connects the two peers
 * directly (DTLS-SRTP encrypted). The server only relays signalling, and even
 * that is sealed with a key derived from both users' identity keys.
 */

/** A call nobody answers becomes "missed" after this long. */
export const RING_TIMEOUT_MS = 45_000;
/** An accepted call with no heartbeat for this long is presumed dead. */
export const CALL_STALE_MS = 45_000;
export const MAX_SIGNAL_PAYLOAD = 16_384;
export const MAX_SIGNALS_PER_CALL = 200;
/**
 * BIGSERIAL ids are allocated before COMMIT, so a signal can become visible
 * with an id below a cursor the reader has already passed. Re-reading a short
 * recent window (and deduplicating by id) means a late-committing ICE
 * candidate is never silently skipped - which would kill the call.
 */
export const SIGNAL_REPLAY_WINDOW_SECONDS = 15;

export const CALL_MEDIA: readonly CallMedia[] = ['audio', 'video'];
export const SIGNAL_KINDS: readonly CallSignalKind[] = [
  'offer',
  'answer',
  'ice',
  'media-state',
  'restart',
];

export type CallAction = 'accept' | 'decline' | 'cancel' | 'missed' | 'end' | 'fail';
export const CALL_ACTIONS: readonly CallAction[] = [
  'accept',
  'decline',
  'cancel',
  'missed',
  'end',
  'fail',
];

export type CreateCallOutcome =
  | { ok: true; call: Call; created: boolean }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'glare'; callId: string };

export type NewSignal = {
  callId: string;
  roomId: string;
  fromUser: string;
  toUser: string;
  kind: CallSignalKind;
  sigNonce: string;
  iv: string;
  payload: string;
};

export interface CallStore {
  create(input: {
    roomId: string;
    callerId: string;
    calleeId: string;
    media: CallMedia;
    clientNonce: string | null;
  }): Promise<CreateCallOutcome>;
  get(callId: string): Promise<Call | null>;
  /** Zero rows changed means the transition was illegal; the current row is returned for a 409. */
  transition(
    callId: string,
    actorId: string,
    action: CallAction,
    reason?: string | null,
  ): Promise<{ ok: boolean; call: Call | null }>;
  heartbeat(callId: string, userId: string): Promise<boolean>;
  addSignal(input: NewSignal): Promise<{ ok: true; id: string } | { ok: false; reason: 'limit' }>;
  signalsFor(userId: string, afterId: string): Promise<CallSignal[]>;
  liveCallsFor(userId: string): Promise<Call[]>;
  roomHistory(roomId: string, limit: number): Promise<Call[]>;
  /** Expires unanswered and abandoned calls. Cheap; throttled per instance. */
  reap(): Promise<void>;
}

export function isTerminal(state: CallState): boolean {
  return TERMINAL_CALL_STATES.includes(state);
}

/* -------------------------------------------------------------------------- */
/* Postgres                                                                   */
/* -------------------------------------------------------------------------- */

type CallRow = {
  id: string;
  room_id: string;
  caller_id: string;
  callee_id: string;
  media: string;
  state: string;
  end_reason: string | null;
  created_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
};

type SignalRow = {
  id: string;
  call_id: string;
  room_id: string;
  from_user: string;
  to_user: string;
  kind: string;
  sig_nonce: string;
  enc_iv: string;
  payload: string;
  created_at: Date;
};

function toCall(row: CallRow): Call {
  return {
    id: row.id,
    roomId: row.room_id,
    callerId: row.caller_id,
    calleeId: row.callee_id,
    media: row.media === 'video' ? 'video' : 'audio',
    state: row.state as CallState,
    endReason: row.end_reason,
    createdAt: row.created_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

function toSignal(row: SignalRow): CallSignal {
  return {
    id: String(row.id),
    callId: row.call_id,
    roomId: row.room_id,
    fromUser: row.from_user,
    toUser: row.to_user,
    kind: row.kind as CallSignalKind,
    sigNonce: row.sig_nonce,
    iv: row.enc_iv,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Each transition is a single conditional UPDATE that encodes both the legal
 * prior state and who may perform it. Two serverless instances will race; the
 * database decides, and the loser gets zero rows back.
 */
const TRANSITIONS: Record<CallAction, { to: CallState; from: CallState[]; actor: 'caller' | 'callee' | 'either' }> = {
  accept: { to: 'accepted', from: ['ringing'], actor: 'callee' },
  decline: { to: 'declined', from: ['ringing'], actor: 'callee' },
  cancel: { to: 'cancelled', from: ['ringing'], actor: 'caller' },
  missed: { to: 'missed', from: ['ringing'], actor: 'caller' },
  end: { to: 'ended', from: ['accepted'], actor: 'either' },
  fail: { to: 'failed', from: ['ringing', 'accepted'], actor: 'either' },
};

let lastReap = 0;

class PostgresCalls implements CallStore {
  async create(input: {
    roomId: string;
    callerId: string;
    calleeId: string;
    media: CallMedia;
    clientNonce: string | null;
  }): Promise<CreateCallOutcome> {
    await this.reap(true);

    if (input.clientNonce) {
      const existing = await query<CallRow>(
        'SELECT * FROM calls WHERE caller_id = $1 AND client_nonce = $2',
        [input.callerId, input.clientNonce],
      );
      if (existing[0]) return { ok: true, call: toCall(existing[0]), created: false };
    }

    // Glare: the other person is already ringing us. Rather than two crossing
    // calls, point the caller at the one that already exists.
    const glare = await query<{ id: string }>(
      `SELECT id FROM calls
       WHERE room_id = $1 AND caller_id = $2 AND callee_id = $3 AND state = 'ringing'
       LIMIT 1`,
      [input.roomId, input.calleeId, input.callerId],
    );
    if (glare[0]) return { ok: false, reason: 'glare', callId: glare[0].id };

    const busy = await query(
      `SELECT 1 FROM calls
       WHERE state IN ('ringing', 'accepted')
         AND (caller_id IN ($1, $2) OR callee_id IN ($1, $2))
       LIMIT 1`,
      [input.callerId, input.calleeId],
    );
    if (busy.length > 0) return { ok: false, reason: 'busy' };

    const rows = await query<CallRow>(
      `INSERT INTO calls (id, room_id, caller_id, callee_id, media, client_nonce)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (caller_id, client_nonce) WHERE client_nonce IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        `call_${randomUUID().replace(/-/g, '')}`,
        input.roomId,
        input.callerId,
        input.calleeId,
        input.media,
        input.clientNonce,
      ],
    );
    if (rows[0]) return { ok: true, call: toCall(rows[0]), created: true };

    // A concurrent retry with the same nonce won the insert.
    const raced = await query<CallRow>(
      'SELECT * FROM calls WHERE caller_id = $1 AND client_nonce = $2',
      [input.callerId, input.clientNonce],
    );
    return { ok: true, call: toCall(raced[0]), created: false };
  }

  async get(callId: string): Promise<Call | null> {
    const rows = await query<CallRow>('SELECT * FROM calls WHERE id = $1', [callId]);
    return rows[0] ? toCall(rows[0]) : null;
  }

  async transition(
    callId: string,
    actorId: string,
    action: CallAction,
    reason?: string | null,
  ): Promise<{ ok: boolean; call: Call | null }> {
    const rule = TRANSITIONS[action];
    const actorClause =
      rule.actor === 'caller'
        ? 'caller_id = $2'
        : rule.actor === 'callee'
          ? 'callee_id = $2'
          : '(caller_id = $2 OR callee_id = $2)';
    const terminal = isTerminal(rule.to);

    const rows = await query<CallRow>(
      `UPDATE calls SET
         state = $3,
         answered_at = CASE WHEN $3 = 'accepted' THEN now() ELSE answered_at END,
         ended_at = CASE WHEN $4 THEN now() ELSE ended_at END,
         end_reason = CASE WHEN $4 THEN COALESCE($5, $3) ELSE end_reason END,
         last_seen_at = now()
       WHERE id = $1 AND state = ANY($6::text[]) AND ${actorClause}
       RETURNING *`,
      [callId, actorId, rule.to, terminal, reason ?? null, rule.from],
    );

    if (rows[0]) {
      // A finished call's signalling is garbage and holds IP-bearing (sealed)
      // blobs; drop it immediately rather than waiting for expiry.
      if (terminal) await query('DELETE FROM call_signals WHERE call_id = $1', [callId]);
      return { ok: true, call: toCall(rows[0]) };
    }
    return { ok: false, call: await this.get(callId) };
  }

  async heartbeat(callId: string, userId: string): Promise<boolean> {
    const rows = await query(
      `UPDATE calls SET last_seen_at = now()
       WHERE id = $1 AND state = 'accepted' AND (caller_id = $2 OR callee_id = $2)
       RETURNING 1`,
      [callId, userId],
    );
    return rows.length > 0;
  }

  async addSignal(
    input: NewSignal,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: 'limit' }> {
    const rows = await query<{ id: string }>(
      `INSERT INTO call_signals
         (call_id, room_id, from_user, to_user, kind, sig_nonce, enc_iv, payload)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       WHERE (SELECT count(*) FROM call_signals WHERE call_id = $1) < $9
       RETURNING id`,
      [
        input.callId,
        input.roomId,
        input.fromUser,
        input.toUser,
        input.kind,
        input.sigNonce,
        input.iv,
        input.payload,
        MAX_SIGNALS_PER_CALL,
      ],
    );
    return rows[0] ? { ok: true, id: String(rows[0].id) } : { ok: false, reason: 'limit' };
  }

  async signalsFor(userId: string, afterId: string): Promise<CallSignal[]> {
    const rows = await query<SignalRow>(
      `SELECT * FROM call_signals
       WHERE to_user = $1 AND expires_at > now()
         AND (id > $2 OR created_at > now() - ($3::int * interval '1 second'))
       ORDER BY id
       LIMIT 200`,
      [userId, afterId, SIGNAL_REPLAY_WINDOW_SECONDS],
    );
    return rows.map(toSignal);
  }

  async liveCallsFor(userId: string): Promise<Call[]> {
    const rows = await query<CallRow>(
      `SELECT * FROM calls
       WHERE (caller_id = $1 OR callee_id = $1)
         AND (state IN ('ringing', 'accepted') OR ended_at > now() - interval '30 seconds')
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId],
    );
    return rows.map(toCall);
  }

  async roomHistory(roomId: string, limit: number): Promise<Call[]> {
    const rows = await query<CallRow>(
      'SELECT * FROM calls WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2',
      [roomId, limit],
    );
    return rows.map(toCall);
  }

  async reap(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastReap < 10_000) return;
    lastReap = now;
    await query(
      `UPDATE calls SET state = 'missed', ended_at = now(), end_reason = 'timeout'
       WHERE state = 'ringing'
         AND created_at < now() - ($1::int * interval '1 millisecond')`,
      [RING_TIMEOUT_MS],
    );
    await query(
      `UPDATE calls SET state = 'ended', ended_at = now(), end_reason = 'stale'
       WHERE state = 'accepted'
         AND last_seen_at < now() - ($1::int * interval '1 millisecond')`,
      [CALL_STALE_MS],
    );
    await query(`DELETE FROM call_signals WHERE expires_at < now()`);
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory (local development only)                                         */
/* -------------------------------------------------------------------------- */

type MemoryCall = Call & { clientNonce: string | null; lastSeenAt: number };
type MemorySignal = CallSignal & { expiresAt: number };

type CallsState = {
  calls: Map<string, MemoryCall>;
  signals: MemorySignal[];
  nextSignalId: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __chatCallsState: CallsState | undefined;
}

function callsState(): CallsState {
  if (!global.__chatCallsState) {
    global.__chatCallsState = { calls: new Map(), signals: [], nextSignalId: 1 };
  }
  return global.__chatCallsState;
}

function publicCall(call: MemoryCall): Call {
  const { clientNonce: _nonce, lastSeenAt: _seen, ...rest } = call;
  return rest;
}

class MemoryCalls implements CallStore {
  async create(input: {
    roomId: string;
    callerId: string;
    calleeId: string;
    media: CallMedia;
    clientNonce: string | null;
  }): Promise<CreateCallOutcome> {
    await this.reap();
    const state = callsState();
    const calls = [...state.calls.values()];

    if (input.clientNonce) {
      const existing = calls.find(
        (c) => c.callerId === input.callerId && c.clientNonce === input.clientNonce,
      );
      if (existing) return { ok: true, call: publicCall(existing), created: false };
    }

    const glare = calls.find(
      (c) =>
        c.roomId === input.roomId &&
        c.callerId === input.calleeId &&
        c.calleeId === input.callerId &&
        c.state === 'ringing',
    );
    if (glare) return { ok: false, reason: 'glare', callId: glare.id };

    const involved = [input.callerId, input.calleeId];
    const busy = calls.some(
      (c) =>
        (c.state === 'ringing' || c.state === 'accepted') &&
        (involved.includes(c.callerId) || involved.includes(c.calleeId)),
    );
    if (busy) return { ok: false, reason: 'busy' };

    const call: MemoryCall = {
      id: `call_${randomUUID().replace(/-/g, '')}`,
      roomId: input.roomId,
      callerId: input.callerId,
      calleeId: input.calleeId,
      media: input.media,
      state: 'ringing',
      endReason: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
      endedAt: null,
      clientNonce: input.clientNonce,
      lastSeenAt: Date.now(),
    };
    state.calls.set(call.id, call);
    return { ok: true, call: publicCall(call), created: true };
  }

  async get(callId: string): Promise<Call | null> {
    const call = callsState().calls.get(callId);
    return call ? publicCall(call) : null;
  }

  async transition(
    callId: string,
    actorId: string,
    action: CallAction,
    reason?: string | null,
  ): Promise<{ ok: boolean; call: Call | null }> {
    const state = callsState();
    const call = state.calls.get(callId);
    if (!call) return { ok: false, call: null };
    const rule = TRANSITIONS[action];
    const actorOk =
      rule.actor === 'caller'
        ? call.callerId === actorId
        : rule.actor === 'callee'
          ? call.calleeId === actorId
          : call.callerId === actorId || call.calleeId === actorId;
    if (!actorOk || !rule.from.includes(call.state)) return { ok: false, call: publicCall(call) };

    call.state = rule.to;
    call.lastSeenAt = Date.now();
    if (rule.to === 'accepted') call.answeredAt = new Date().toISOString();
    if (isTerminal(rule.to)) {
      call.endedAt = new Date().toISOString();
      call.endReason = reason ?? rule.to;
      state.signals = state.signals.filter((s) => s.callId !== callId);
    }
    return { ok: true, call: publicCall(call) };
  }

  async heartbeat(callId: string, userId: string): Promise<boolean> {
    const call = callsState().calls.get(callId);
    if (!call || call.state !== 'accepted') return false;
    if (call.callerId !== userId && call.calleeId !== userId) return false;
    call.lastSeenAt = Date.now();
    return true;
  }

  async addSignal(
    input: NewSignal,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: 'limit' }> {
    const state = callsState();
    if (state.signals.filter((s) => s.callId === input.callId).length >= MAX_SIGNALS_PER_CALL) {
      return { ok: false, reason: 'limit' };
    }
    const signal: MemorySignal = {
      ...input,
      id: String(state.nextSignalId++),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 120_000,
    };
    state.signals.push(signal);
    return { ok: true, id: signal.id };
  }

  async signalsFor(userId: string, afterId: string): Promise<CallSignal[]> {
    const now = Date.now();
    const windowStart = now - SIGNAL_REPLAY_WINDOW_SECONDS * 1000;
    return callsState()
      .signals.filter(
        (s) =>
          s.toUser === userId &&
          s.expiresAt > now &&
          (Number(s.id) > Number(afterId) || Date.parse(s.createdAt) > windowStart),
      )
      .slice(0, 200)
      .map(({ expiresAt: _e, ...signal }) => signal);
  }

  async liveCallsFor(userId: string): Promise<Call[]> {
    const cutoff = Date.now() - 30_000;
    return [...callsState().calls.values()]
      .filter(
        (c) =>
          (c.callerId === userId || c.calleeId === userId) &&
          (c.state === 'ringing' ||
            c.state === 'accepted' ||
            (c.endedAt !== null && Date.parse(c.endedAt) > cutoff)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map(publicCall);
  }

  async roomHistory(roomId: string, limit: number): Promise<Call[]> {
    return [...callsState().calls.values()]
      .filter((c) => c.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(publicCall);
  }

  async reap(): Promise<void> {
    const now = Date.now();
    const state = callsState();
    for (const call of state.calls.values()) {
      if (call.state === 'ringing' && now - Date.parse(call.createdAt) > RING_TIMEOUT_MS) {
        call.state = 'missed';
        call.endedAt = new Date().toISOString();
        call.endReason = 'timeout';
      } else if (call.state === 'accepted' && now - call.lastSeenAt > CALL_STALE_MS) {
        call.state = 'ended';
        call.endedAt = new Date().toISOString();
        call.endReason = 'stale';
      }
    }
    state.signals = state.signals.filter((s) => s.expiresAt > now);
  }
}

/* -------------------------------------------------------------------------- */

let cached: CallStore | undefined;

export function getCalls(): CallStore {
  if (!cached) cached = HAS_DATABASE ? new PostgresCalls() : new MemoryCalls();
  return cached;
}

/**
 * The call, if `userId` is one of its two participants AND can still reach its
 * room. Non-participants get null, which routes turn into the same 404 as a
 * call that does not exist. Re-checking the room means being blocked mid-call
 * cuts off signalling too, not just future calls.
 */
export async function loadCallFor(user: PublicUser, callId: string): Promise<Call | null> {
  const call = await getCalls().get(callId);
  if (!call) return null;
  if (call.callerId !== user.id && call.calleeId !== user.id) return null;
  return (await loadRoomFor(user, call.roomId)) ? call : null;
}

/** The other participant of a call. */
export function peerOf(call: Call, userId: string): string {
  return call.callerId === userId ? call.calleeId : call.callerId;
}
