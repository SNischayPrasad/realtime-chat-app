import { NextResponse } from 'next/server';
import { MAX_MESSAGE_LENGTH } from './config';

export type ApiError = { error: string; field?: string };

export function jsonError(status: number, error: string, field?: string): NextResponse<ApiError> {
  return NextResponse.json(field ? { error, field } : { error }, { status });
}

export const unauthorized = () => jsonError(401, 'You must be signed in to do that');

/** Parses a JSON body, returning `null` instead of throwing on malformed input. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,24}$/;

export function validateUsername(raw: unknown): ValidationResult<string> {
  const username = asString(raw).trim();
  if (!username) return { ok: false, error: 'Username is required', field: 'username' };
  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      error: '3-24 characters, letters, numbers, dot, dash or underscore only',
      field: 'username',
    };
  }
  return { ok: true, value: username };
}

export function validatePassword(raw: unknown): ValidationResult<string> {
  const password = asString(raw);
  if (!password) return { ok: false, error: 'Password is required', field: 'password' };
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters', field: 'password' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password must be at most 200 characters', field: 'password' };
  }
  return { ok: true, value: password };
}

export function validateDisplayName(raw: unknown, fallback: string): ValidationResult<string> {
  const displayName = asString(raw).trim() || fallback;
  if (displayName.length > 48) {
    return { ok: false, error: 'Display name must be at most 48 characters', field: 'displayName' };
  }
  return { ok: true, value: displayName };
}

export function validateMessageBody(raw: unknown): ValidationResult<string> {
  const body = asString(raw).trim();
  if (!body) return { ok: false, error: 'Message cannot be empty', field: 'body' };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Message must be at most ${MAX_MESSAGE_LENGTH} characters`,
      field: 'body',
    };
  }
  return { ok: true, value: body };
}

export function validateRoomName(raw: unknown): ValidationResult<string> {
  const name = asString(raw).trim();
  if (!name) return { ok: false, error: 'Room name is required', field: 'name' };
  if (name.length > 48) {
    return { ok: false, error: 'Room name must be at most 48 characters', field: 'name' };
  }
  return { ok: true, value: name };
}

export function clampLimit(raw: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
