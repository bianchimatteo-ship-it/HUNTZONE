import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { MODE_IDS, applyCapture, applyLobbyCommand, applyPinAttempt, createLobby, createMatchRuntime, evaluateCaptureEvidence, resolveTimeout, withdrawPlayer, type CapturePolicy, type MatchRuntime, type MatchState } from '../../../packages/game-core/src/index.js';
import { authenticate, hashSessionToken, newSessionToken, sessionTokenFromRequest, type Principal } from './auth.js';
import { pool, withTransaction } from './db.js';

const PORT = Number(process.env.API_PORT || 8787);
const HOST = process.env.API_HOST || '127.0.0.1';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const inviteAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const app = Fastify({
  logger: process.env.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
  bodyLimit: 16 * 1024,
  trustProxy: process.env.TRUST_PROXY === 'true',
});

type ParticipantRow = { id: string; display_name: string; ready: boolean; connected: boolean; host: boolean };
type MatchRow = { id: string; invite_code: string; host_player_id: string; mode_id: string; config: MatchState['config']; phase: string; revision: string; countdown_ends_at?: Date | string | null; has_area?: boolean };
type ClientSocket = { playerId: string; socket: WebSocket };
type GpsObservation = { latitude: number; longitude: number; accuracyMeters: number; sequence: number; deviceTimestampMs: number; receivedAtMs: number; receivedAtMonotonicMs: number };
type SecretPin = { value: string; hash: Buffer; expiresAtMs: number; attemptsByCaptor: Map<string, number>; consumed: boolean };
const socketsByMatch = new Map<string, Set<ClientSocket>>();
const countdownTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gpsObservations = new Map<string, Map<string, GpsObservation>>();
const capturePins = new Map<string, Map<string, SecretPin>>();
const automaticProximitySince = new Map<string, number>();
const lastSnapshotBroadcastAt = new Map<string, number>();

function pinHash(matchId: string, playerId: string, pin: string) {
  return createHash('sha256').update(`${matchId}:${playerId}:${pin}`).digest();
}

function issueCapturePins(matchId: string, runtime: MatchRuntime) {
  const pins = new Map<string, SecretPin>();
  const nowMs = Date.now();
  for (const player of runtime.players.filter(item => item.roleId === 'hider')) {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pins.set(player.playerId, { value, hash: pinHash(matchId, player.playerId, value), expiresAtMs: nowMs + 90_000, attemptsByCaptor: new Map(), consumed: false });
  }
  capturePins.set(matchId, pins);
}

function freshCapturePin(matchId: string, playerId: string) {
  const pins = capturePins.get(matchId);
  let secret = pins?.get(playerId);
  if (pins && (!secret || secret.expiresAtMs <= Date.now())) {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    secret = { value, hash: pinHash(matchId, playerId, value), expiresAtMs: Date.now() + 90_000, attemptsByCaptor: new Map(), consumed: false };
    pins.set(playerId, secret);
  }
  return secret;
}

function gpsObservation(matchId: string, playerId: string) {
  const observation = gpsObservations.get(matchId)?.get(playerId);
  if (!observation) return null;
  if (Number(process.hrtime.bigint() / 1_000_000n) - observation.receivedAtMonotonicMs > 5000) {
    gpsObservations.get(matchId)?.delete(playerId);
    return null;
  }
  return observation;
}

function clearGpsObservation(matchId: string, playerId: string) {
  const observations = gpsObservations.get(matchId);
  observations?.delete(playerId);
  if (!observations?.size) gpsObservations.delete(matchId);
}

function distanceMeters(a: Pick<GpsObservation, 'latitude' | 'longitude'>, b: Pick<GpsObservation, 'latitude' | 'longitude'>) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const deltaLatitude = latitudeB - latitudeA;
  const deltaLongitude = radians(b.longitude - a.longitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

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

function setSessionCookie(reply: import('fastify').FastifyReply, token: string) {
  const secure = process.env.NODE_ENV === 'production';
  const name = secure ? '__Host-huntzone_session' : 'huntzone_session';
  const attributes = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'Max-Age=2592000', secure ? 'Secure' : '', secure ? 'SameSite=None' : 'SameSite=Lax'].filter(Boolean);
  reply.header('Set-Cookie', attributes.join('; '));
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

async function finishCountdown(matchId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await withTransaction(async client => {
    const matchResult = await client.query<{ id: string; host_player_id: string; mode_id: string; config: MatchState['config']; phase: string; revision: string; area_center: unknown; due: boolean }>(
      `SELECT id,host_player_id,mode_id,config,phase,revision,area_center,
              countdown_ends_at <= clock_timestamp() AS due
         FROM matches WHERE id=$1 FOR UPDATE`, [matchId],
    );
    const match = matchResult.rows[0];
    if (!match || match.phase !== 'countdown' || !match.due) return false;
    const participants = await client.query<{ player_id: string; ready: boolean; connected: boolean }>(
      'SELECT player_id,ready,connected FROM participants WHERE match_id=$1 ORDER BY joined_at,player_id', [matchId],
    );
    const valid = match.mode_id === 'classic-hide-and-seek' && match.area_center !== null
      && participants.rows.length >= 3 && participants.rows.length <= match.config.playerCap
      && participants.rows.every(player => player.ready && player.connected && gpsObservation(matchId, player.player_id));
    const consented = await client.query<{ player_id: string }>(
      `SELECT c.player_id FROM consents c JOIN participants p ON p.match_id=c.match_id AND p.player_id=c.player_id
        WHERE c.match_id=$1 AND c.purpose='active-match-location' AND c.withdrawn_at IS NULL`, [matchId],
    );
    const hasAllConsents = consented.rowCount === participants.rows.length;
    const clock = await client.query<{ now_ms: string }>('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
    const nowMs = Number(clock.rows[0]!.now_ms);
    const revision = Number(match.revision) + 1;
    if (!valid || !hasAllConsents) {
      await client.query('UPDATE participants SET ready=false WHERE match_id=$1', [matchId]);
      await client.query('UPDATE matches SET phase=\'lobby\',countdown_ends_at=NULL,revision=$2 WHERE id=$1', [matchId, revision]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,payload) VALUES($1,$2,$3,$4)',
        [matchId, revision, 'start.cancelled', JSON.stringify({ reason: 'preconditions-changed' })]);
      return true;
    }
    const created = createMatchRuntime({
      modeId: 'classic-hide-and-seek', hostPlayerId: match.host_player_id,
      players: participants.rows.map(player => ({ id: player.player_id, ready: player.ready })),
      durationSeconds: match.config.durationSeconds, captureMethod: match.config.captureMethod,
      nowMs, randomUnit: () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000,
    });
    if (!created.ok) throw new Error(`MATCH_START_REJECTED:${created.error.code}`);
    const runtime: MatchRuntime = { ...created.value, revision };
    for (const player of runtime.players) {
      await client.query('UPDATE participants SET role_id=$3,team_id=$4,virtual_status=$5 WHERE match_id=$1 AND player_id=$2',
        [matchId, player.playerId, player.roleId, player.teamId ?? null, player.status]);
    }
    await client.query('UPDATE matches SET phase=\'active\',countdown_ends_at=NULL,started_at=to_timestamp($2/1000.0),revision=$3 WHERE id=$1', [matchId, nowMs, revision]);
    await client.query('INSERT INTO match_events(match_id,revision,event_type,payload) VALUES($1,$2,$3,$4)',
      [matchId, revision, 'match.started', JSON.stringify({ modeId: match.mode_id, playerCount: participants.rows.length, engineVersion: runtime.engineVersion })]);
    await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
      [matchId, revision, runtime.engineVersion, JSON.stringify(runtime)]);
    if (runtime.captureMethod === 'pin') issueCapturePins(matchId, runtime);
    return true;
  });
  if (result) {
    const timer = countdownTimers.get(matchId);
    if (timer) clearTimeout(timer);
    countdownTimers.delete(matchId);
  }
  if (result && pool) {
    const active = await pool.query<{ virtual_state: MatchRuntime }>("SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1", [matchId]);
    if (active.rows[0]?.virtual_state.phase === 'active') scheduleDeadline(matchId, active.rows[0].virtual_state.deadlineAtMs);
  }
  return result;
}

function scheduleCountdown(matchId: string, endsAt: number) {
  const current = countdownTimers.get(matchId);
  if (current) clearTimeout(current);
  const delay = Math.max(0, Math.min(2_147_000_000, endsAt - Date.now()));
  countdownTimers.set(matchId, setTimeout(() => {
    void finishCountdown(matchId)
      .then(async changed => { if (changed) await broadcastSnapshot(matchId); })
      .catch(() => scheduleCountdown(matchId, Date.now() + 1500));
  }, delay));
}

async function finishDeadline(matchId: string): Promise<boolean> {
  if (!pool) return false;
  const finished = await withTransaction(async client => {
    const match = await client.query<{ phase: string }>('SELECT phase FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
    if (match.rows[0]?.phase !== 'active') return false;
    const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
      'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
    );
    const runtime = checkpoint.rows[0]?.virtual_state;
    if (!runtime || runtime.phase !== 'active') return false;
    const dbClock = await client.query<{ now_ms: string }>('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
    const nowMs = Number(dbClock.rows[0]!.now_ms);
    const resolved = resolveTimeout(runtime, nowMs);
    if (!resolved.ok) return false;
    const next = resolved.value;
    await client.query("UPDATE matches SET phase=$2,revision=$3,ended_at=clock_timestamp() WHERE id=$1", [matchId, next.phase, next.revision]);
    await client.query('INSERT INTO match_events(match_id,revision,event_type,payload) VALUES($1,$2,$3,$4)',
      [matchId, next.revision, 'match.completed', JSON.stringify({ winner: next.winner ?? null, reason: next.endReason ?? null })]);
    await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
      [matchId, next.revision, next.engineVersion, JSON.stringify(next)]);
    return true;
  });
  countdownTimers.delete(matchId);
  if (finished) {
    gpsObservations.delete(matchId); capturePins.delete(matchId);
    for (const key of automaticProximitySince.keys()) if (key.startsWith(`${matchId}:`)) automaticProximitySince.delete(key);
  }
  return finished;
}

function scheduleDeadline(matchId: string, deadlineAt: number) {
  const current = countdownTimers.get(matchId);
  if (current) clearTimeout(current);
  const delay = Math.max(0, Math.min(2_147_000_000, deadlineAt - Date.now()));
  countdownTimers.set(matchId, setTimeout(() => {
    void finishDeadline(matchId)
      .then(async changed => {
        if (changed) await broadcastSnapshot(matchId);
        else if (pool && (await pool.query("SELECT 1 FROM matches WHERE id=$1 AND phase='active'", [matchId])).rowCount) scheduleDeadline(matchId, Date.now() + 1500);
      })
      .catch(() => scheduleDeadline(matchId, Date.now() + 1500));
  }, delay));
}

async function publicSnapshot(matchId: string, viewerPlayerId: string) {
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  await finishDeadline(matchId);
  await finishCountdown(matchId);
  const match = await pool.query<MatchRow & { center_latitude: number | null; center_longitude: number | null }>(
    `SELECT m.id, m.invite_code, m.host_player_id, m.mode_id, m.config, m.phase, m.revision,
            m.countdown_ends_at, m.area_center IS NOT NULL AS has_area,
            ST_Y(m.area_center::geometry) AS center_latitude, ST_X(m.area_center::geometry) AS center_longitude
       FROM matches m JOIN participants x ON x.match_id=m.id
      WHERE m.id=$1 AND x.player_id=$2`, [matchId, viewerPlayerId],
  );
  if (!match.rows[0]) return null;
  const row = match.rows[0];
  const players = await pool.query<ParticipantRow & { virtual_status: string }>(
    `SELECT p.id, p.display_name, x.ready, x.connected, x.virtual_status, (x.player_id=$2) AS host
       FROM participants x JOIN players p ON p.id=x.player_id WHERE x.match_id=$1 ORDER BY x.joined_at,p.id`,
    [matchId, row.host_player_id],
  );
  const own = await pool.query<{ role_id: string | null; team_id: string | null; virtual_status: string; gps_consent: boolean; all_gps_consented: boolean }>(
    `SELECT p.role_id,p.team_id,p.virtual_status,
            EXISTS(SELECT 1 FROM consents c WHERE c.match_id=p.match_id AND c.player_id=p.player_id AND c.purpose='active-match-location' AND c.withdrawn_at IS NULL) AS gps_consent,
            NOT EXISTS(SELECT 1 FROM participants p2 WHERE p2.match_id=p.match_id AND NOT EXISTS(
              SELECT 1 FROM consents c2 WHERE c2.match_id=p2.match_id AND c2.player_id=p2.player_id AND c2.purpose='active-match-location' AND c2.withdrawn_at IS NULL
            )) AS all_gps_consented
       FROM participants p WHERE p.match_id=$1 AND p.player_id=$2`, [matchId, viewerPlayerId],
  );
  const checkpoint = row.phase === 'active' || row.phase === 'completed' || row.phase === 'paused'
    ? await pool.query<{ virtual_state: MatchRuntime }>('SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1', [matchId])
    : { rows: [] as { virtual_state: MatchRuntime }[] };
  const runtime = checkpoint.rows[0]?.virtual_state;
  const isClassicLobby = row.phase === 'lobby' && row.mode_id === 'classic-hide-and-seek';
  const gpsConsent = Boolean(own.rows[0]?.gps_consent);
  const gpsReady = Boolean(gpsObservation(matchId, viewerPlayerId));
  const canStart = Boolean(isClassicLobby && viewerPlayerId === row.host_player_id && row.has_area
    && players.rows.length >= 3 && players.rows.length <= row.config.playerCap
    && players.rows.every(player => player.connected && player.ready)
    && players.rows.every(player => gpsObservation(matchId, player.id))
    && own.rows[0]?.all_gps_consented);
  const captureTargets = runtime?.modeId === 'classic-hide-and-seek' && own.rows[0]?.role_id === 'seeker'
    ? runtime.players.filter(player => player.roleId === 'hider' && player.status === 'active').map(player => {
      const participant = players.rows.find(item => item.id === player.playerId);
      return participant ? { id: participant.id, displayName: participant.display_name } : null;
    }).filter((player): player is { id: string; displayName: string } => player !== null)
    : undefined;
  const canCapture = Boolean(runtime?.phase === 'active' && runtime.modeId === 'classic-hide-and-seek' && own.rows[0]?.role_id === 'seeker'
    && row.config.captureMethod !== 'automatic' && Date.now() >= runtime.captureAvailableAtMs
    && captureTargets?.length && gpsObservation(matchId, viewerPlayerId)
    && captureTargets.every(target => gpsObservation(matchId, target.id)));
  return {
    matchId: row.id,
    inviteCode: row.invite_code,
    hostPlayerId: row.host_player_id,
    viewerPlayerId,
    isHost: viewerPlayerId === row.host_player_id,
    revision: Number(row.revision),
    phase: row.phase,
    config: row.config,
    areaCenter: row.center_latitude === null || row.center_longitude === null ? null : { latitude: row.center_latitude, longitude: row.center_longitude },
    countdownEndsAt: row.countdown_ends_at ? new Date(row.countdown_ends_at).toISOString() : null,
    players: players.rows.map(player => ({ id: player.id, displayName: player.display_name, ready: player.ready, connected: player.connected, status: player.virtual_status })),
    ...(own.rows[0]?.role_id ? { roleId: own.rows[0].role_id, teamId: own.rows[0].team_id } : {}),
    ...(row.config.captureMethod === 'pin' && own.rows[0]?.role_id === 'hider' && own.rows[0]?.virtual_status === 'active' && freshCapturePin(matchId, viewerPlayerId)
      ? { capturePin: freshCapturePin(matchId, viewerPlayerId)!.value } : {}),
    virtualStatus: own.rows[0]?.virtual_status ?? 'active',
    gpsConsent,
    gpsReady,
    ...(runtime ? { captureAvailableAt: new Date(runtime.captureAvailableAtMs).toISOString(), deadlineAt: new Date(runtime.deadlineAtMs).toISOString() } : {}),
    ...(captureTargets ? { captureTargets } : {}),
    ...(runtime && runtime.phase !== 'active' ? { winner: runtime.winner ?? null, endReason: runtime.endReason ?? null } : {}),
    capabilities: { start: canStart, roles: Boolean(own.rows[0]?.role_id), gameplay: runtime?.phase === 'active', capture: canCapture },
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

async function broadcastLocationSnapshot(matchId: string) {
  const now = Date.now();
  if (now - (lastSnapshotBroadcastAt.get(matchId) ?? 0) < 1000) return;
  lastSnapshotBroadcastAt.set(matchId, now);
  await broadcastSnapshot(matchId);
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
await app.register(cors, { origin: allowedOrigins, credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'] });
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'POST' || !sessionTokenFromRequest(request)) return;
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    await reply.code(403).send({ error: { code: 'ORIGIN_REJECTED', message: 'Origine non autorizzata per questa sessione.' } });
  }
});
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
    setSessionCookie(reply, token);
    return reply.code(201).send({ playerId: created, displayName, expiresAt: expiresAt.toISOString() });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Impossibile creare una sessione.' } }); }
});

app.get('/v1/guest-sessions/current', async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  if (!pool) return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servizio multiplayer non disponibile.' } });
  try {
    const active = await pool.query<{ id: string }>(
      `SELECT m.id FROM matches m JOIN participants p ON p.match_id=m.id
        WHERE p.player_id=$1 AND m.phase IN ('lobby','countdown','active','paused') ORDER BY p.joined_at DESC LIMIT 1`, [principal.playerId],
    );
    const match = active.rows[0] ? await publicSnapshot(active.rows[0].id, principal.playerId) : null;
    return reply.send({ session: principal, match });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Impossibile recuperare la sessione.' } }); }
});

app.post<{ Body: { modeId: string; playerCap: number; radiusMeters: number; durationSeconds: number; centerLatitude: number; centerLongitude: number; captureMethod?: MatchState['config']['captureMethod']; displayName?: string } }>('/v1/lobbies', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['modeId', 'playerCap', 'radiusMeters', 'durationSeconds', 'centerLatitude', 'centerLongitude'], properties: {
    modeId: { type: 'string', enum: MODE_IDS }, playerCap: { type: 'integer', minimum: 3, maximum: 30 }, radiusMeters: { type: 'integer', minimum: 100, maximum: 3000 }, durationSeconds: { type: 'integer', minimum: 600, maximum: 7200 }, centerLatitude: { type: 'number', minimum: -90, maximum: 90 }, centerLongitude: { type: 'number', minimum: -180, maximum: 180 }, captureMethod: { type: 'string', enum: ['radius', 'pin', 'automatic'] }, displayName: { type: 'string', minLength: 2, maxLength: 32 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const validated = createLobby({
    matchId: randomUUID(), inviteCode: 'INVITE', hostPlayerId: principal.playerId, hostDisplayName: principal.displayName,
    config: { schemaVersion: 1, modeId: request.body.modeId, playerCap: request.body.playerCap, radiusMeters: request.body.radiusMeters, durationSeconds: request.body.durationSeconds, captureMethod: request.body.captureMethod ?? 'radius' },
  });
  if (!validated.ok) return reply.code(400).send({ error: validated.error });
  try {
    const created = await withTransaction(async client => {
      let matchId = '';
      let code = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        code = inviteCode();
        const match = await client.query<{ id: string }>(
          `INSERT INTO matches(invite_code,host_player_id,mode_id,config,area_center)
           VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography)
           ON CONFLICT(invite_code) DO NOTHING RETURNING id`,
            [code, principal.playerId, request.body.modeId, JSON.stringify(validated.value.config), request.body.centerLongitude, request.body.centerLatitude],
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

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number; granted: boolean } }>('/v1/matches/:matchId/location-consent', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision', 'granted'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 }, granted: { type: 'boolean' },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  try {
    const transition = await withTransaction(async client => {
      const match = await client.query<{ phase: string; revision: string; ready: boolean }>(
        `SELECT m.phase,m.revision,p.ready FROM matches m JOIN participants p ON p.match_id=m.id
          WHERE m.id=$1 AND p.player_id=$2 FOR UPDATE OF m`, [request.params.matchId, principal.playerId],
      );
      const row = match.rows[0];
      if (!row) return { ok: false as const, status: 404, message: 'Match non trovata.' };
      const duplicate = await client.query<{ result: Record<string, unknown> }>(
        'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3',
        [request.params.matchId, principal.playerId, request.body.commandId],
      );
      if (duplicate.rows[0]) return { ok: true as const, duplicate: true, value: duplicate.rows[0].result };
      if (request.body.granted && (row.phase !== 'lobby' || !row.ready)) return { ok: false as const, status: 409, message: 'Conferma READY prima di configurare il GPS.' };
      if (!request.body.granted && !['lobby', 'countdown', 'active'].includes(row.phase)) return { ok: false as const, status: 409, message: 'La partita non accetta più modifiche al consenso GPS.' };
      if (Number(row.revision) !== request.body.expectedRevision) return { ok: false as const, status: 409, message: 'La lobby è cambiata. Aggiorna lo stato e riprova.' };
      if (request.body.granted) {
        await client.query(
          `INSERT INTO consents(match_id,player_id,purpose,policy_version,granted_at,withdrawn_at)
           VALUES($1,$2,'active-match-location','huntzone-location-v1',clock_timestamp(),NULL)
           ON CONFLICT(match_id,player_id,purpose) DO UPDATE SET policy_version=EXCLUDED.policy_version,granted_at=EXCLUDED.granted_at,withdrawn_at=NULL`,
          [request.params.matchId, principal.playerId],
        );
      } else {
        await client.query(`UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND player_id=$2 AND purpose='active-match-location' AND withdrawn_at IS NULL`, [request.params.matchId, principal.playerId]);
      }
      let revision = Number(row.revision) + 1;
      let withdrawn = false;
      if (!request.body.granted && row.phase === 'countdown') {
        await client.query("UPDATE participants SET ready=false WHERE match_id=$1", [request.params.matchId]);
        await client.query("UPDATE matches SET phase='lobby',countdown_ends_at=NULL,revision=$2 WHERE id=$1", [request.params.matchId, revision]);
      } else if (!request.body.granted && row.phase === 'active') {
        const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
          'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [request.params.matchId],
        );
        const runtime = checkpoint.rows[0]?.virtual_state;
        if (!runtime) return { ok: false as const, status: 503, message: 'Stato partita non disponibile; revoca non confermata.' };
        const result = withdrawPlayer({ state: runtime, playerId: principal.playerId, commandId: request.body.commandId, nowMs: Date.now() });
        if (!result.ok) return { ok: false as const, status: 409, message: 'Ritiro partita non applicabile allo stato corrente.' };
        revision = result.value.state.revision;
        await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $2 IN (\'completed\',\'cancelled\') THEN clock_timestamp() ELSE ended_at END WHERE id=$1', [request.params.matchId, result.value.state.phase, revision]);
        await client.query("UPDATE participants SET virtual_status='withdrawn' WHERE match_id=$1 AND player_id=$2", [request.params.matchId, principal.playerId]);
        await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
          [request.params.matchId, revision, result.value.state.engineVersion, JSON.stringify(result.value.state)]);
        await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
          [request.params.matchId, revision, 'player.withdrew', principal.playerId, JSON.stringify({ reason: 'gps-consent-withdrawn' })]);
        withdrawn = true;
      } else {
        await client.query('UPDATE matches SET revision=$2 WHERE id=$1', [request.params.matchId, revision]);
      }
      const payload = { revision, granted: request.body.granted };
      if (!withdrawn) await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [request.params.matchId, revision, request.body.granted ? 'gps.consent-granted' : 'gps.consent-withdrawn', principal.playerId, JSON.stringify({ purpose: 'active-match-location', policyVersion: 'huntzone-location-v1', cancelledCountdown: row.phase === 'countdown' && !request.body.granted })]);
      await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
        [request.params.matchId, principal.playerId, request.body.commandId, revision, JSON.stringify(payload)]);
      return { ok: true as const, duplicate: false, value: payload };
    });
    if (!transition.ok) return reply.code(transition.status).send({ error: { code: 'CONSENT_REJECTED', message: transition.message } });
    if (!request.body.granted) {
      clearGpsObservation(request.params.matchId, principal.playerId);
      const timer = countdownTimers.get(request.params.matchId);
      if (timer) clearTimeout(timer);
      countdownTimers.delete(request.params.matchId);
    }
    await broadcastSnapshot(request.params.matchId);
    const snapshot = await publicSnapshot(request.params.matchId, principal.playerId);
    if (snapshot && ['completed', 'cancelled'].includes(snapshot.phase)) {
      gpsObservations.delete(request.params.matchId); capturePins.delete(request.params.matchId);
      const timer = countdownTimers.get(request.params.matchId); if (timer) clearTimeout(timer);
      countdownTimers.delete(request.params.matchId);
    }
    return reply.send({ ...transition, snapshot });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Consenso GPS non registrato.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { latitude: number; longitude: number; accuracyMeters: number; sequence: number; timestampMs: number } }>('/v1/matches/:matchId/location', {
  config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['latitude', 'longitude', 'accuracyMeters', 'sequence', 'timestampMs'], properties: {
    latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
    accuracyMeters: { type: 'number', minimum: 1, maximum: 10000 }, sequence: { type: 'integer', minimum: 1 }, timestampMs: { type: 'integer', minimum: 0 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const sample = request.body;
  const serverNow = Date.now();
  if (Math.abs(serverNow - sample.timestampMs) > 30_000) return reply.code(422).send({ error: { code: 'GPS_SAMPLE_STALE', message: 'Attendi una posizione aggiornata dal dispositivo.' } });
  try {
    const accepted = await withTransaction(async client => {
      const matchResult = await client.query<{ phase: string; radius_m: number; ready: boolean; consented: boolean; config: MatchState['config']; virtual_status: string }>(
        `SELECT m.phase,m.config,(m.config->>'radiusMeters')::integer AS radius_m,p.ready,p.virtual_status,
                EXISTS(SELECT 1 FROM consents c WHERE c.match_id=m.id AND c.player_id=p.player_id AND c.purpose='active-match-location' AND c.withdrawn_at IS NULL) AS consented
           FROM matches m JOIN participants p ON p.match_id=m.id
          WHERE m.id=$1 AND p.player_id=$2 FOR UPDATE OF m`, [request.params.matchId, principal.playerId],
      );
      const match = matchResult.rows[0];
      if (!match) return { ok: false as const, status: 404, message: 'Match non trovata.' };
      if (!['lobby', 'countdown', 'active'].includes(match.phase) || (match.phase === 'lobby' && !match.ready) || (match.phase === 'active' && match.virtual_status !== 'active')) return { ok: false as const, status: 409, message: 'Il GPS non è atteso in questa fase.' };
      if (!match.consented) return { ok: false as const, status: 403, message: 'Conferma il consenso GPS per questa partita.' };
      const previous = gpsObservations.get(request.params.matchId)?.get(principal.playerId);
      if (previous && sample.sequence <= previous.sequence) return { ok: false as const, status: 409, message: 'Campione GPS duplicato o fuori sequenza.' };
      if (previous) {
        const elapsedSeconds = (Date.now() - previous.receivedAtMs) / 1000;
        if (elapsedSeconds > 0 && elapsedSeconds <= 300 && distanceMeters(previous, sample) > Math.max(100, elapsedSeconds * 25)) {
          return { ok: false as const, status: 422, message: 'Salto di posizione implausibile. Nessuna cattura sarà valutata; attendi un nuovo campione GPS.' };
        }
      }
      if (sample.accuracyMeters > 15) {
        clearGpsObservation(request.params.matchId, principal.playerId);
        return { ok: false as const, status: 422, message: 'Precisione GPS insufficiente. Attendi un campione migliore.' };
      }
      const area = await client.query<{ inside: boolean }>(
        `SELECT ST_DWithin(area_center,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4)::boolean AS inside
           FROM matches WHERE id=$1 AND area_center IS NOT NULL`,
        [request.params.matchId, sample.longitude, sample.latitude, Math.max(0, match.radius_m - sample.accuracyMeters)],
      );
      if (!area.rows[0]?.inside) {
        clearGpsObservation(request.params.matchId, principal.playerId);
        return { ok: false as const, status: 422, message: 'Il campione non conferma una posizione affidabile dentro il campo.' };
      }
      const players = gpsObservations.get(request.params.matchId) ?? new Map<string, GpsObservation>();
      players.set(principal.playerId, {
        latitude: sample.latitude, longitude: sample.longitude, accuracyMeters: sample.accuracyMeters,
      sequence: sample.sequence, deviceTimestampMs: sample.timestampMs, receivedAtMs: Date.now(),
        receivedAtMonotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
      });
      gpsObservations.set(request.params.matchId, players);
      let automaticCapture: string | null = null;
      if (match.phase === 'active' && match.config.captureMethod === 'automatic') {
        const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
          'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [request.params.matchId],
        );
        const runtime = checkpoint.rows[0]?.virtual_state;
        const nowMs = Date.now();
        if (runtime?.phase === 'active' && nowMs < runtime.deadlineAtMs && nowMs >= runtime.captureAvailableAtMs) {
          const seeker = runtime.players.find(player => player.roleId === 'seeker' && player.status === 'active');
          const hiders = runtime.players.filter(player => player.roleId === 'hider' && player.status === 'active');
          if (seeker) for (const hider of hiders) {
            const key = `${request.params.matchId}:${seeker.playerId}:${hider.playerId}`;
            const seekerGps = gpsObservation(request.params.matchId, seeker.playerId);
            const hiderGps = gpsObservation(request.params.matchId, hider.playerId);
            const policy: CapturePolicy = { method: 'automatic', distanceMeters: 20, maxAccuracyMeters: 15, maxSampleAgeSeconds: 5, automatic: { minimumProximitySeconds: 5 } };
            const evidence = evaluateCaptureEvidence({
              policy,
              captor: seekerGps ? { latitude: seekerGps.latitude, longitude: seekerGps.longitude, accuracyMeters: seekerGps.accuracyMeters, observedAtMs: seekerGps.receivedAtMs, sequence: seekerGps.sequence } : undefined,
              target: hiderGps ? { latitude: hiderGps.latitude, longitude: hiderGps.longitude, accuracyMeters: hiderGps.accuracyMeters, observedAtMs: hiderGps.receivedAtMs, sequence: hiderGps.sequence } : undefined,
              nowMs, lastAcceptedSequence: { captor: 0, target: 0 }, proximityStartedAtMs: automaticProximitySince.get(key),
            });
            if (evidence.status === 'eligible') {
              const transition = applyCapture({ state: runtime, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId,
                commandId: `automatic-${randomUUID()}`, nowMs, evidence, automaticDwellVerified: true });
              if (!transition.ok) continue;
              const next = transition.value.state;
              await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $2=\'completed\' THEN clock_timestamp() ELSE ended_at END WHERE id=$1', [request.params.matchId, next.phase, next.revision]);
              await client.query("UPDATE participants SET virtual_status='captured' WHERE match_id=$1 AND player_id=$2", [request.params.matchId, hider.playerId]);
              await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
                [request.params.matchId, next.revision, 'player.captured', seeker.playerId, JSON.stringify({ targetPlayerId: hider.playerId, method: 'automatic', evidence: 'gps-verified' })]);
              await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
                [request.params.matchId, next.revision, next.engineVersion, JSON.stringify(next)]);
              clearGpsObservation(request.params.matchId, hider.playerId);
              automaticProximitySince.delete(key);
              automaticCapture = hider.playerId;
              if (next.phase !== 'active') {
                gpsObservations.delete(request.params.matchId); capturePins.delete(request.params.matchId);
                for (const proximityKey of automaticProximitySince.keys()) if (proximityKey.startsWith(`${request.params.matchId}:`)) automaticProximitySince.delete(proximityKey);
                const timer = countdownTimers.get(request.params.matchId); if (timer) clearTimeout(timer);
                countdownTimers.delete(request.params.matchId);
              }
              break;
            }
            if (evidence.reason === 'dwell-incomplete' && automaticProximitySince.has(key)) continue;
            if (evidence.reason === 'dwell-incomplete') automaticProximitySince.set(key, nowMs);
            else automaticProximitySince.delete(key);
          }
        }
      }
      return { ok: true as const, accuracyMeters: sample.accuracyMeters, sequence: sample.sequence, automaticCapture };
    });
    if (!accepted.ok) return reply.code(accepted.status).send({ error: { code: 'GPS_SAMPLE_REJECTED', message: accepted.message } });
    if (accepted.automaticCapture) await broadcastSnapshot(request.params.matchId);
    else await broadcastLocationSnapshot(request.params.matchId);
    return reply.send({ status: 'GPS_READY', accuracyMeters: accepted.accuracyMeters, sequence: accepted.sequence, ...(accepted.automaticCapture ? { captureResolved: true } : {}) });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Il campione GPS non è stato accettato.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number; targetPlayerId: string; pin?: string } }>('/v1/matches/:matchId/capture', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision', 'targetPlayerId'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 },
    targetPlayerId: { type: 'string', format: 'uuid' }, pin: { type: 'string', pattern: '^\\d{6}$' },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const { matchId } = request.params;
  const captorObservation = gpsObservation(matchId, principal.playerId);
  const targetObservation = gpsObservation(matchId, request.body.targetPlayerId);
  if (!captorObservation || !targetObservation) return reply.code(422).send({ error: { code: 'GPS_EVIDENCE_UNAVAILABLE', message: 'Servono campioni GPS recenti e affidabili di entrambi i giocatori.' } });
  try {
    const outcome = await withTransaction(async client => {
      const matchResult = await client.query<{ phase: string; revision: string; config: MatchState['config'] }>(
        'SELECT phase,revision,config FROM matches WHERE id=$1 FOR UPDATE', [matchId],
      );
      const match = matchResult.rows[0];
      if (!match || match.phase !== 'active') return { ok: false as const, status: 409, message: 'La partita non è attiva.' };
      const duplicate = await client.query<{ result: Record<string, unknown> }>(
        'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3', [matchId, principal.playerId, request.body.commandId],
      );
      if (duplicate.rows[0]) return { ok: true as const, duplicate: true, revision: Number(match.revision), result: duplicate.rows[0].result };
      if (Number(match.revision) !== request.body.expectedRevision) return { ok: false as const, status: 409, message: 'La partita è cambiata. Aggiorna lo stato e riprova.' };
      const consent = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM consents WHERE match_id=$1 AND player_id=ANY($2::uuid[])
          AND purpose='active-match-location' AND withdrawn_at IS NULL`, [matchId, [principal.playerId, request.body.targetPlayerId]],
      );
      if (Number(consent.rows[0]?.count) !== 2) return { ok: false as const, status: 403, message: 'Entrambi i giocatori devono mantenere il consenso GPS.' };
      const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
        'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
      );
      const runtime = checkpoint.rows[0]?.virtual_state;
      if (!runtime) return { ok: false as const, status: 503, message: 'Stato partita non disponibile.' };
      const captor = runtime.players.find(player => player.playerId === principal.playerId);
      const target = runtime.players.find(player => player.playerId === request.body.targetPlayerId);
      if (runtime.modeId !== 'classic-hide-and-seek' || captor?.roleId !== 'seeker' || target?.roleId !== 'hider' || target.status !== 'active') {
        return { ok: false as const, status: 403, message: 'Il tuo ruolo non può catturare questo partecipante.' };
      }
      const nowMs = Date.now();
      const method = match.config.captureMethod;
      if (method === 'automatic') return { ok: false as const, status: 409, message: 'Cattura automatica in preparazione; nessuna cattura è stata applicata.' };
      if ((method === 'pin') !== Boolean(request.body.pin)) return { ok: false as const, status: 422, message: method === 'pin' ? 'Inserisci il PIN personale dell’hider.' : 'Questa partita non usa PIN.' };
      const policy: CapturePolicy = { method, distanceMeters: 20, maxAccuracyMeters: 15, maxSampleAgeSeconds: 5,
        ...(method === 'pin' ? { pin: { expiresAfterSeconds: 90, maxAttempts: 3, invalidateAfterUse: true as const } } : {}) };
      const evidence = evaluateCaptureEvidence({
        policy,
        captor: { latitude: captorObservation.latitude, longitude: captorObservation.longitude, accuracyMeters: captorObservation.accuracyMeters, observedAtMs: captorObservation.receivedAtMs, sequence: captorObservation.sequence },
        target: { latitude: targetObservation.latitude, longitude: targetObservation.longitude, accuracyMeters: targetObservation.accuracyMeters, observedAtMs: targetObservation.receivedAtMs, sequence: targetObservation.sequence },
        nowMs, lastAcceptedSequence: { captor: 0, target: 0 },
      });
      if (evidence.status !== 'eligible') return { ok: false as const, status: 422, message: 'Il server non conferma una vicinanza GPS precisa e recente.' };
      let pinSecret: SecretPin | undefined;
      if (method === 'pin') {
        pinSecret = capturePins.get(matchId)?.get(request.body.targetPlayerId);
        if (!pinSecret || pinSecret.consumed || pinSecret.expiresAtMs <= nowMs) return { ok: false as const, status: 422, message: 'PIN scaduto o già utilizzato.' };
        const attempts = pinSecret.attemptsByCaptor.get(principal.playerId) ?? 0;
        if (attempts >= 3) return { ok: false as const, status: 429, message: 'Tentativi PIN esauriti per questo bersaglio.' };
        const expected = pinSecret.hash;
        const supplied = pinHash(matchId, request.body.targetPlayerId, request.body.pin!);
        if (!timingSafeEqual(expected, supplied)) {
          const attempt = applyPinAttempt({ policy: policy.pin!, state: { expiresAtMs: pinSecret.expiresAtMs, attemptsRemaining: 3 - attempts, consumed: false }, nowMs, matches: false });
          pinSecret.attemptsByCaptor.set(principal.playerId, 3 - attempt.state.attemptsRemaining);
          return { ok: false as const, status: attempt.reason === 'locked' ? 429 : 422, message: attempt.reason === 'locked' ? 'Tentativi PIN esauriti per questo bersaglio.' : 'PIN non corretto.' };
        }
      }
      const transition = applyCapture({ state: runtime, captorPlayerId: principal.playerId, targetPlayerId: request.body.targetPlayerId,
        commandId: request.body.commandId, nowMs, evidence, ...(method === 'pin' ? { pinVerified: true } : {}) });
      if (!transition.ok) return { ok: false as const, status: 409, message: transition.error.message };
      const next = transition.value.state;
      const event = transition.value.event;
      const revision = next.revision;
      await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $2=\'completed\' THEN clock_timestamp() ELSE ended_at END WHERE id=$1', [matchId, next.phase, revision]);
      await client.query("UPDATE participants SET virtual_status='captured' WHERE match_id=$1 AND player_id=$2", [matchId, request.body.targetPlayerId]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [matchId, revision, event?.type ?? 'player.captured', principal.playerId, JSON.stringify({ targetPlayerId: request.body.targetPlayerId, evidence: 'gps-verified' })]);
      await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)', [matchId, revision, next.engineVersion, JSON.stringify(next)]);
      const result = { capturedPlayerId: request.body.targetPlayerId, phase: next.phase, winner: next.winner ?? null, endReason: next.endReason ?? null };
      await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
        [matchId, principal.playerId, request.body.commandId, revision, JSON.stringify(result)]);
      if (pinSecret) pinSecret.consumed = true;
      return { ok: true as const, duplicate: false, revision, result, finished: next.phase !== 'active', capturedPlayerId: request.body.targetPlayerId };
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: { code: 'CAPTURE_REJECTED', message: outcome.message } });
    if ('capturedPlayerId' in outcome && typeof outcome.capturedPlayerId === 'string') {
      clearGpsObservation(matchId, outcome.capturedPlayerId);
      if (outcome.finished) {
        gpsObservations.delete(matchId);
        capturePins.delete(matchId);
        const timer = countdownTimers.get(matchId); if (timer) clearTimeout(timer);
        countdownTimers.delete(matchId);
      }
      await broadcastSnapshot(matchId);
    }
    return reply.send({ revision: outcome.revision, duplicate: outcome.duplicate, result: outcome.result, snapshot: await publicSnapshot(matchId, principal.playerId) });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Cattura non confermata dal server.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number } }>('/v1/matches/:matchId/start', {
  config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  try {
    const transition = await withTransaction(async client => {
      const matchResult = await client.query<{ host_player_id: string; mode_id: string; config: MatchState['config']; phase: string; revision: string; has_area: boolean }>(
        'SELECT host_player_id,mode_id,config,phase,revision,area_center IS NOT NULL AS has_area FROM matches WHERE id=$1 FOR UPDATE', [request.params.matchId],
      );
      const match = matchResult.rows[0];
      if (!match) return { ok: false as const, status: 404, message: 'Match non trovata.' };
      const duplicate = await client.query<{ result: { revision: number; countdownEndsAt: string } }>(
        'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3',
        [request.params.matchId, principal.playerId, request.body.commandId],
      );
      if (duplicate.rows[0]) return { ok: true as const, ...duplicate.rows[0].result, duplicate: true };
      if (principal.playerId !== match.host_player_id) return { ok: false as const, status: 403, message: 'Solo l’host può avviare la partita.' };
      if (match.phase !== 'lobby' || match.mode_id !== 'classic-hide-and-seek') return { ok: false as const, status: 409, message: 'Questa modalità o fase non può essere avviata.' };
      if (!match.has_area) return { ok: false as const, status: 409, message: 'Seleziona prima il centro dell’area di gioco.' };
      const participants = await client.query<{ player_id: string; ready: boolean; connected: boolean }>(
        'SELECT player_id,ready,connected FROM participants WHERE match_id=$1 ORDER BY joined_at,player_id', [request.params.matchId],
      );
      if (participants.rows.length < 3 || participants.rows.length > match.config.playerCap
        || participants.rows.some(player => !player.ready || !player.connected)) {
        return { ok: false as const, status: 409, message: 'Servono almeno tre partecipanti connessi e tutti READY.' };
      }
      const consents = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM consents c JOIN participants p ON p.match_id=c.match_id AND p.player_id=c.player_id
          WHERE c.match_id=$1 AND c.purpose='active-match-location' AND c.withdrawn_at IS NULL`, [request.params.matchId],
      );
      if (Number(consents.rows[0]?.count) !== participants.rows.length) return { ok: false as const, status: 409, message: 'Ogni partecipante deve consentire il GPS per questa partita.' };
      if (participants.rows.some(player => !gpsObservation(request.params.matchId, player.player_id))) return { ok: false as const, status: 409, message: 'Attendi un campione GPS recente e sufficientemente preciso da ogni partecipante.' };
      const currentRevision = Number(match.revision);
      if (request.body.expectedRevision !== currentRevision) return { ok: false as const, status: 409, message: 'La lobby è cambiata. Aggiorna lo stato e riprova.' };
      const countdown = await client.query<{ ends_at: Date }>("SELECT clock_timestamp() + interval '10 seconds' AS ends_at");
      const countdownEndsAt = countdown.rows[0]!.ends_at.toISOString();
      const revision = currentRevision + 1;
      const result = { revision, countdownEndsAt };
      await client.query('UPDATE matches SET phase=\'countdown\',countdown_ends_at=$2,revision=$3 WHERE id=$1', [request.params.matchId, countdownEndsAt, revision]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [request.params.matchId, revision, 'start.countdown', principal.playerId, JSON.stringify({ durationSeconds: 10, participantCount: participants.rows.length })]);
      await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
        [request.params.matchId, principal.playerId, request.body.commandId, revision, JSON.stringify(result)]);
      return { ok: true as const, ...result, duplicate: false };
    });
    if (!transition.ok) return reply.code(transition.status).send({ error: { code: 'START_REJECTED', message: transition.message } });
    scheduleCountdown(request.params.matchId, Date.parse(transition.countdownEndsAt));
    await broadcastSnapshot(request.params.matchId);
    return reply.send({ ...transition, snapshot: await publicSnapshot(request.params.matchId, principal.playerId) });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Avvio non confermato dal server.' } }); }
});

app.get<{ Params: { matchId: string } }>('/v1/matches/:matchId/stream', { websocket: true }, (socket, request) => {
  let principal: Principal | null = null;
  let matchId = request.params.matchId;
  let connection: ClientSocket | null = null;
  const origin = request.headers.origin;
  if ((origin && !allowedOrigins.includes(origin)) || (!origin && process.env.NODE_ENV === 'production')) { socket.close(4403, 'origin not allowed'); return; }
  const authTimeout = setTimeout(() => socket.close(4401, 'authentication required'), 5000);
  socket.on('message', async raw => {
    try {
    const message = readMessage(raw);
    if (!message) { socket.close(4400, 'invalid message'); return; }
    if (!principal) {
      if (message.type !== 'session.authenticate') { socket.close(4401, 'authentication required'); return; }
      const authenticated = typeof message.token === 'string'
        ? await authenticateRawToken(message.token)
        : await authenticate(request);
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
  if (pool) {
    const pending = await pool.query<{ id: string; countdown_ends_at: Date }>("SELECT id,countdown_ends_at FROM matches WHERE phase='countdown' AND countdown_ends_at IS NOT NULL");
    for (const match of pending.rows) scheduleCountdown(match.id, match.countdown_ends_at.getTime());
    const active = await pool.query<{ match_id: string; virtual_state: MatchRuntime }>(
      "SELECT DISTINCT ON (c.match_id) c.match_id,c.virtual_state FROM match_checkpoints c JOIN matches m ON m.id=c.match_id WHERE m.phase='active' ORDER BY c.match_id,c.revision DESC",
    );
    for (const match of active.rows) scheduleDeadline(match.match_id, match.virtual_state.deadlineAtMs);
  }
  app.log.info({ port: PORT, databaseConfigured: Boolean(pool) }, 'HUNTZONE API listening');
}

app.addHook('onClose', async () => {
  for (const timer of countdownTimers.values()) clearTimeout(timer);
  countdownTimers.clear();
  await pool?.end();
});

export { app };
