import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { pool } from './db.js';

export type Principal = { playerId: string; displayName: string };

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest();
}

export function cookieSessionToken(cookieHeader: string | undefined, secure: boolean) {
  if (!cookieHeader) return null;
  const cookieName = secure ? '__Host-huntzone_session' : 'huntzone_session';
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== cookieName) continue;
    const token = item.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,80}$/.test(token) ? token : null;
  }
  return null;
}

export function sessionTokenFromRequest(request: FastifyRequest) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{32,80})$/.exec(request.headers.authorization ?? '')?.[1];
  return bearer ?? cookieSessionToken(request.headers.cookie, process.env.NODE_ENV === 'production');
}

export async function authenticate(request: FastifyRequest): Promise<Principal | null> {
  const token = sessionTokenFromRequest(request);
  if (!token || !pool) return null;
  const result = await pool.query<{ player_id: string; display_name: string }>(
    `SELECT s.player_id, p.display_name
       FROM guest_sessions s JOIN players p ON p.id = s.player_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = result.rows[0];
  return row ? { playerId: row.player_id, displayName: row.display_name } : null;
}
