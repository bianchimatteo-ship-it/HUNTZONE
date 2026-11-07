import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { MODE_IDS, applyLobbyCommand, createLobby, type MatchState } from '../../../packages/game-core/src/index.js';
import { authenticate, hashSessionToken, newSessionToken, type Principal } from './auth.js';
import { pool, withTransaction } from './db.js';

const PORT = Number(process.env.API_PORT || 8787);
const HOST = process.env.API_HOST || '127.0.0.1';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const inviteAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const app = Fastify({
  logger: process.env.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
  bodyLimit: 16 * 1024,
});

type ParticipantRow = { id: string; display_name: string; ready: boolean; connected: boolean; host: boolean };
type MatchRow = { id: string; invite_code: string; host_player_id: string; mode_id: string; config: MatchState['config']; phase: MatchState['phase']; revision: string };
type ClientSocket = { playerId: string; socket: WebSocket };
const socketsByMatch = new Map<string, Set<ClientSocket>>();

function inviteCode() {
  const bytes = randomBytes(6);
  return Array.from(bytes, byte => inviteAlphabet[byte % inviteAlphabet.length]).join('');
}

function readMessage(raw: unknown): Record<string, unknown> | null {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (Buffer.byteLength(text) > 8192) return null;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function authenticateRawToken(token: unknown): Promise<Principal | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,80}$/.test(token) || !pool) return null;
  const result = await pool.query<{ player_id: string; display_name: string }>(
    `SELECT s.player_id, p.display_name FROM guest_sessions s JOIN players p ON p.id=s.player_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [hashSessionToken(token)],
  );
  return result.rows[0] ? { playerId: result.rows[0].player_id, displayName: result.rows[0].display_name } : null;
}

async function loadLobbyState(client: import('pg').PoolClient, matchId: string): Promise<MatchState | null> {
  const matchResult = await client.query<MatchRow>('SELECT id, invite_code, host_player_id, mode_id, config, phase, revision FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
  const match = matchResult.rows[0];
  if (!match || match.phase !== 'lobby') return null;
  const participants = await client.query<ParticipantRow>(
    `SELECT p.id, p.display_name, x.ready, x.connected, (x.player_id=m.host_player_id) AS host
       FROM participants x JOIN players p ON p.id=x.player_id JOIN matches m ON m.id=x.match_id
      WHERE x.match_id=$1 ORDER BY x.joined_at, p.id`, [matchId],
  );
  return {
    schemaVersion: 1,
    matchId: match.id,
    inviteCode: match.invite_code,
    hostPlayerId: match.host_player_id,
    revision: Number(match.revision),
    phase: 'lobby',
    config: match.config,
    players: participants.rows.map(player => ({ id: player.id, displayName: player.display_name, ready: player.ready })),
    processedCommandIds: [],
  };
}

async function publicSnapshot(matchId: string, viewerPlayerId: string) {
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const match = await pool.query<MatchRow>(
    `SELECT m.id, m.invite_code, m.host_player_id, m.mode_id, m.config, m.phase, m.revision
       FROM matches m JOIN participants x ON x.match_id=m.id
      WHERE m.id=$1 AND x.player_id=$2`, [matchId, viewerPlayerId],
  );
  if (!match.rows[0]) return null;
  const row = match.rows[0];
  const players = await pool.query<ParticipantRow>(
    `SELECT p.id, p.display_name, x.ready, x.connected, (x.player_id=$2) AS host
       FROM participants x JOIN players p ON p.id=x.player_id WHERE x.match_id=$1 ORDER BY x.joined_at,p.id`,
    [matchId, row.host_player_id],
  );
  return {
    matchId: row.id,
    inviteCode: row.invite_code,
    hostPlayerId: row.host_player_id,
    viewerPlayerId,
    isHost: viewerPlayerId === row.host_player_id,
    revision: Number(row.revision),
    phase: row.phase,
    config: row.config,
    players: players.rows.map(player => ({ id: player.id, displayName: player.display_name, ready: player.ready, connected: player.connected })),
    capabilities: { start: false, roles: false, gameplay: false },
  };
}

async function broadcastSnapshot(matchId: string) {
  const sockets = socketsByMatch.get(matchId);
  if (!sockets?.size) return;
  for (const connection of [...sockets]) {
    if (connection.socket.readyState !== 1) continue;
    try {
      const snapshot = await publicSnapshot(matchId, connection.playerId);
      if (snapshot) connection.socket.send(JSON.stringify({ type: 'match.snapshot', payload: snapshot }));
    } catch { connection.socket.close(1011, 'snapshot unavailable'); }
  }
}

async function commitReady(matchId: string, principal: Principal, ready: boolean, commandId: string, expectedRevision: number) {
  const result = await withTransaction(async client => {
    const locked = await client.query('SELECT id FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
    if (!locked.rowCount) return { ok: false as const, status: 404, message: 'Lobby non trovata.' };
    const duplicate = await client.query<{ result: Record<string, unknown> }>(
      'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3',
      [matchId, principal.playerId, commandId],
    );
    if (duplicate.rows[0]) return { ok: true as const, value: duplicate.rows[0].result, duplicate: true };
    const state = await loadLobbyState(client, matchId);
    if (!state) return { ok: false as const, status: 409, message: 'La lobby non accetta più modifiche.' };
    const transition = applyLobbyCommand(state, { type: 'player.ready-changed', actorPlayerId: principal.playerId, ready, commandId, expectedRevision });
    if (!transition.ok) return { ok: false as const, status: 409, message: transition.error.message };
    const revision = transition.value.state.revision;
    await client.query('UPDATE participants SET ready=$3 WHERE match_id=$1 AND player_id=$2', [matchId, principal.playerId, ready]);
    await client.query('UPDATE matches SET revision=$2 WHERE id=$1', [matchId, revision]);
    await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
      [matchId, revision, 'player.ready-changed', principal.playerId, JSON.stringify({ ready })]);
    const payload = { revision, playerId: principal.playerId, ready };
    await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
      [matchId, principal.playerId, commandId, revision, JSON.stringify(payload)]);
    return { ok: true as const, value: payload, duplicate: false };
  });
  return result;
}

async function requirePrincipal(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
  if (!pool) {
    await reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servizio multiplayer non configurato.' } });
    return null;
  }
  const principal = await authenticate(request);
  if (!principal) {
    await reply.code(401).send({ error: { code: 'SESSION_INVALID', message: 'Sessione ospite non valida o scaduta.' } });
    return null;
  }
  return principal;
}

const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(origin => origin.trim()).filter(Boolean);
await app.register(cors, { origin: allowedOrigins, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'] });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(websocket, { options: { maxPayload: 8192 } });

app.get('/v1/health', async (_request, reply) => {
  if (!pool) return reply.code(503).send({ status: 'unavailable', reason: 'database-not-configured' });
  try { await pool.query('SELECT PostGIS_Version()'); return { status: 'ok' }; }
  catch { return reply.code(503).send({ status: 'unavailable', reason: 'database-unavailable' }); }
});

app.post<{ Body: { displayName: string } }>('/v1/guest-sessions', {
  config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: { type: 'string', minLength: 2, maxLength: 32, pattern: '.*\\S.*' } } } },
}, async (request, reply) => {
  if (!pool) return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servizio multiplayer non disponibile.' } });
  const displayName = request.body.displayName.trim();
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  try {
    const created = await withTransaction(async client => {
      const player = await client.query<{ id: string }>('INSERT INTO players(display_name) VALUES($1) RETURNING id', [displayName]);
      await client.query('INSERT INTO guest_sessions(token_hash,player_id,expires_at) VALUES($1,$2,$3)', [hashSessionToken(token), player.rows[0]!.id, expiresAt]);
      return player.rows[0]!.id;
    });
    return reply.code(201).send({ token, playerId: created, displayName, expiresAt: expiresAt.toISOString() });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Impossibile creare una sessione.' } }); }
});

app.post<{ Body: { modeId: string; playerCap: number; radiusMeters: number; durationSeconds: number; displayName?: string } }>('/v1/lobbies', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['modeId', 'playerCap', 'radiusMeters', 'durationSeconds'], properties: {
    modeId: { type: 'string', enum: MODE_IDS }, playerCap: { type: 'integer', minimum: 3, maximum: 30 }, radiusMeters: { type: 'integer', minimum: 100, maximum: 3000 }, durationSeconds: { type: 'integer', minimum: 600, maximum: 7200 }, displayName: { type: 'string', minLength: 2, maxLength: 32 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const validated = createLobby({
    matchId: randomUUID(), inviteCode: 'INVITE', hostPlayerId: principal.playerId, hostDisplayName: principal.displayName,
    config: { schemaVersion: 1, modeId: request.body.modeId, playerCap: request.body.playerCap, radiusMeters: request.body.radiusMeters, durationSeconds: request.body.durationSeconds },
  });
  if (!validated.ok) return reply.code(400).send({ error: validated.error });
  try {
    const created = await withTransaction(async client => {
      let matchId = '';
      let code = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        code = inviteCode();
        const match = await client.query<{ id: string }>(
            `INSERT INTO matches(invite_code,host_player_id,mode_id,config) VALUES($1,$2,$3,$4) ON CONFLICT(invite_code) DO NOTHING RETURNING id`,
            [code, principal.playerId, request.body.modeId, JSON.stringify(validated.value.config)],
          );
        if (match.rows[0]) {
          matchId = match.rows[0]!.id;
          break;
        }
      }
      if (!matchId) throw new Error('INVITE_CODE_UNAVAILABLE');
      await client.query('INSERT INTO participants(match_id,player_id,connected) VALUES($1,$2,false)', [matchId, principal.playerId]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,0,$2,$3,$4)',
        [matchId, 'lobby.created', principal.playerId, JSON.stringify({ modeId: request.body.modeId })]);
      return { matchId, code };
    });
    const snapshot = await publicSnapshot(created.matchId, principal.playerId);
    const origin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') ?? '';
    return reply.code(201).send({ ...snapshot, inviteUrl: `${origin}/#/join?code=${created.code}` });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Impossibile creare la lobby.' } }); }
});

app.post<{ Params: { code: string } }>('/v1/lobbies/:code/join', {
  config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  schema: { params: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[2-9A-HJ-NP-Z]{6}$' } } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const code = request.params.code.toUpperCase();
  try {
    const joined = await withTransaction(async client => {
      const matchResult = await client.query<{ id: string; invite_code: string; host_player_id: string; config: MatchState['config']; phase: string; revision: string }>(
        'SELECT id,invite_code,host_player_id,config,phase,revision FROM matches WHERE invite_code=$1 FOR UPDATE', [code],
      );
      const match = matchResult.rows[0];
      if (!match || match.phase !== 'lobby') return { ok: false as const, status: 404, message: 'Codice non valido o lobby non disponibile.' };
      const state = await loadLobbyState(client, match.id);
      if (!state) return { ok: false as const, status: 409, message: 'La lobby non accetta nuovi partecipanti.' };
      const alreadyMember = state.players.some(player => player.id === principal.playerId);
      const commandId = `join:${principal.playerId}`;
      if (!alreadyMember) {
        const transition = applyLobbyCommand(state, { type: 'player.joined', actorPlayerId: principal.playerId, player: { id: principal.playerId, displayName: principal.displayName }, commandId, expectedRevision: state.revision });
        if (!transition.ok) return { ok: false as const, status: 409, message: transition.error.message };
        const revision = transition.value.state.revision;
        await client.query('INSERT INTO participants(match_id,player_id,connected) VALUES($1,$2,false)', [match.id, principal.playerId]);
        await client.query('UPDATE matches SET revision=$2 WHERE id=$1', [match.id, revision]);
        await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
          [match.id, revision, 'player.joined', principal.playerId, JSON.stringify({ displayName: principal.displayName })]);
        await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
          [match.id, principal.playerId, commandId, revision, JSON.stringify({ revision })]);
      } else {
        await client.query('UPDATE participants SET connected=false WHERE match_id=$1 AND player_id=$2', [match.id, principal.playerId]);
      }
      return { ok: true as const, matchId: match.id };
    });
    if (!joined.ok) return reply.code(joined.status).send({ error: { code: 'JOIN_REJECTED', message: joined.message } });
    const snapshot = await publicSnapshot(joined.matchId, principal.playerId);
    await broadcastSnapshot(joined.matchId);
    return reply.send(snapshot);
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Impossibile accedere alla lobby.' } }); }
});

app.get<{ Params: { matchId: string } }>('/v1/matches/:matchId', async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  try {
    const snapshot = await publicSnapshot(request.params.matchId, principal.playerId);
    return snapshot ? reply.send(snapshot) : reply.code(404).send({ error: { code: 'MATCH_NOT_FOUND', message: 'Lobby non trovata.' } });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servizio multiplayer non disponibile.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number; ready: boolean } }>('/v1/matches/:matchId/ready', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision', 'ready'], properties: { commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 }, ready: { type: 'boolean' } } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  try {
    const membership = await pool?.query('SELECT 1 FROM participants WHERE match_id=$1 AND player_id=$2', [request.params.matchId, principal.playerId]);
    if (!membership?.rowCount) return reply.code(404).send({ error: { code: 'MATCH_NOT_FOUND', message: 'Lobby non trovata.' } });
    const transition = await commitReady(request.params.matchId, principal, request.body.ready, request.body.commandId, request.body.expectedRevision);
    if (!transition.ok) return reply.code(transition.status).send({ error: { code: 'COMMAND_REJECTED', message: transition.message } });
    await broadcastSnapshot(request.params.matchId);
    return reply.send({ type: 'command.ack', ...transition.value, duplicate: transition.duplicate, snapshot: await publicSnapshot(request.params.matchId, principal.playerId) });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Comando non confermato dal server.' } }); }
});

app.get<{ Params: { matchId: string } }>('/v1/matches/:matchId/stream', { websocket: true }, (socket, request) => {
  let principal: Principal | null = null;
  let matchId = request.params.matchId;
  let connection: ClientSocket | null = null;
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) { socket.close(4403, 'origin not allowed'); return; }
  const authTimeout = setTimeout(() => socket.close(4401, 'authentication required'), 5000);
  socket.on('message', async raw => {
    try {
    const message = readMessage(raw);
    if (!message) { socket.close(4400, 'invalid message'); return; }
    if (!principal) {
      if (message.type !== 'session.authenticate') { socket.close(4401, 'authentication required'); return; }
      const authenticated = await authenticateRawToken(message.token);
      if (!authenticated || !pool) { socket.close(4401, 'invalid session'); return; }
      const membership = await pool.query('UPDATE participants SET connected=true WHERE match_id=$1 AND player_id=$2 RETURNING player_id', [matchId, authenticated.playerId]);
      if (!membership.rowCount) { socket.close(4403, 'not a lobby participant'); return; }
      principal = authenticated;
      clearTimeout(authTimeout);
      connection = { playerId: principal.playerId, socket };
      const connections = socketsByMatch.get(matchId) ?? new Set<ClientSocket>();
      connections.add(connection);
      socketsByMatch.set(matchId, connections);
      const snapshot = await publicSnapshot(matchId, principal.playerId);
      if (snapshot) socket.send(JSON.stringify({ type: 'match.snapshot', payload: snapshot }));
      await broadcastSnapshot(matchId);
      return;
    }
    if (message.type === 'player.ready' && typeof message.ready === 'boolean' && typeof message.commandId === 'string' && Number.isInteger(message.expectedRevision)) {
      const transition = await commitReady(matchId, principal, message.ready, message.commandId, Number(message.expectedRevision));
      if (!transition.ok) socket.send(JSON.stringify({ type: 'command.error', message: transition.message }));
      else { socket.send(JSON.stringify({ type: 'command.ack', ...transition.value, duplicate: transition.duplicate })); await broadcastSnapshot(matchId); }
      return;
    }
    socket.send(JSON.stringify({ type: 'command.error', message: 'Comando non supportato.' }));
    } catch {
      socket.close(1011, 'command not committed');
    }
  });
  socket.on('close', async () => {
    clearTimeout(authTimeout);
    if (!principal || !connection || !pool) return;
    socketsByMatch.get(matchId)?.delete(connection);
    const stillConnected = [...(socketsByMatch.get(matchId) ?? [])].some(item => item.playerId === principal!.playerId);
    if (!stillConnected) await pool.query('UPDATE participants SET connected=false WHERE match_id=$1 AND player_id=$2', [matchId, principal.playerId]).catch(() => undefined);
    if (!socketsByMatch.get(matchId)?.size) socketsByMatch.delete(matchId);
    await broadcastSnapshot(matchId).catch(() => undefined);
  });
});

app.setErrorHandler((error, request, reply) => {
  request.log.warn({ code: (error as { code?: string }).code }, 'request rejected');
  const candidate = error as { statusCode?: number };
  const status = candidate.statusCode && candidate.statusCode < 500 ? candidate.statusCode : 500;
  void reply.code(status).send({ error: { code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? 'Richiesta non completata.' : 'Richiesta non valida.' } });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ port: PORT, databaseConfigured: Boolean(pool) }, 'HUNTZONE API listening');
}

app.addHook('onClose', async () => { await pool?.end(); });

export { app };
