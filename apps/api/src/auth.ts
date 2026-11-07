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

export async function authenticate(request: FastifyRequest): Promise<Principal | null> {
  const match = /^Bearer ([A-Za-z0-9_-]{32,80})$/.exec(request.headers.authorization ?? '');
  if (!match || !pool) return null;
  const result = await pool.query<{ player_id: string; display_name: string }>(
    `SELECT s.player_id, p.display_name
       FROM guest_sessions s JOIN players p ON p.id = s.player_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashSessionToken(match[1])],
  );
  const row = result.rows[0];
  return row ? { playerId: row.player_id, displayName: row.display_name } : null;
}
