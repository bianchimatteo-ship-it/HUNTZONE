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
type MatchRow = { id: string; invite_code: string; host_player_id: string; mode_id: string; config: MatchState['config']; phase: string; revision: string; countdown_ends_at?: Date | string | null; paused_from_phase?: string | null; has_area?: boolean };
type ClientSocket = { playerId: string; socket: WebSocket };
type GpsObservation = { latitude: number; longitude: number; accuracyMeters: number; sequence: number; deviceTimestampMs: number; receivedAtMs: number; receivedAtMonotonicMs: number };
type SecretPin = { value: string; hash: Buffer; expiresAtMs: number; attemptsByCaptor: Map<string, number>; consumed: boolean };
const socketsByMatch = new Map<string, Set<ClientSocket>>();
const countdownTimers = new Map<string, ReturnType<typeof setTimeout>>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const hostDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gpsObservations = new Map<string, Map<string, GpsObservation>>();
const capturePins = new Map<string, Map<string, SecretPin>>();
const automaticProximitySince = new Map<string, number>();
const lastSnapshotBroadcastAt = new Map<string, number>();

function pinHash(matchId: string, playerId: string, pin: string) {
  return createHash('sha256').update(`${matchId}:${playerId}:${pin}`).digest();
}

function capturePinLifetimeMs() {
  return process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.HUNTZONE_TEST_PIN_LIFETIME_MS) || 90_000) : 90_000;
}

function issueCapturePins(matchId: string, runtime: MatchRuntime) {
  const pins = new Map<string, SecretPin>();
  const nowMs = Date.now();
  for (const player of runtime.players.filter(item => item.roleId === 'hider')) {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pins.set(player.playerId, { value, hash: pinHash(matchId, player.playerId, value), expiresAtMs: nowMs + capturePinLifetimeMs(), attemptsByCaptor: new Map(), consumed: false });
  }
  capturePins.set(matchId, pins);
}

function freshCapturePin(matchId: string, playerId: string) {
  const pins = capturePins.get(matchId);
  let secret = pins?.get(playerId);
  if (pins && (!secret || secret.expiresAtMs <= Date.now())) {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    secret = { value, hash: pinHash(matchId, playerId, value), expiresAtMs: Date.now() + capturePinLifetimeMs(), attemptsByCaptor: new Map(), consumed: false };
    pins.set(playerId, secret);
  }
  return secret;
}

function gpsObservation(matchId: string, playerId: string) {
  const observation = gpsObservations.get(matchId)?.get(playerId);
  if (!observation) return null;
  if (Number(process.hrtime.bigint() / 1_000_000n) - observation.receivedAtMonotonicMs > 5000
    || Date.now() - observation.deviceTimestampMs > 5000
    || observation.deviceTimestampMs > Date.now() + 5000) {
    clearGpsObservation(matchId, playerId);
    return null;
  }
  return observation;
}

function clearGpsObservation(matchId: string, playerId: string) {
  const observations = gpsObservations.get(matchId);
  observations?.delete(playerId);
  if (!observations?.size) gpsObservations.delete(matchId);
  clearAutomaticProximityForPlayer(matchId, playerId);
}

function clearAutomaticProximityForPlayer(matchId: string, playerId: string) {
  const prefix = `${matchId}:`;
  for (const key of automaticProximitySince.keys()) {
    if (key.startsWith(prefix) && key.split(':').includes(playerId)) automaticProximitySince.delete(key);
  }
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
    const testHeadStartMs = testDurationMs('HUNTZONE_TEST_HEADSTART_MS', 60_000, 60_000);
    const runtime: MatchRuntime = process.env.NODE_ENV === 'test'
      ? { ...created.value, captureAvailableAtMs: nowMs + testHeadStartMs, deadlineAtMs: nowMs + match.config.durationSeconds * 1000 + testHeadStartMs, revision }
      : { ...created.value, revision };
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
    clearMatchDisconnectTimers(matchId);
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

function disconnectTimerKey(matchId: string, playerId: string) { return `${matchId}:${playerId}`; }

function clearMatchDisconnectTimers(matchId: string) {
  const prefix = `${matchId}:`;
  for (const [key, timer] of disconnectTimers) if (key.startsWith(prefix)) {
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
  const hostTimer = hostDisconnectTimers.get(matchId);
  if (hostTimer) clearTimeout(hostTimer);
  hostDisconnectTimers.delete(matchId);
}

function scheduleDisconnectExpiry(matchId: string, playerId: string, disconnectedAt: Date | string, isHost: boolean) {
  const key = disconnectTimerKey(matchId, playerId);
  const previous = disconnectTimers.get(key);
  if (previous) clearTimeout(previous);
  const graceMs = isHost ? hostGraceMs() : participantGraceMs();
  const ageMs = Date.now() - new Date(disconnectedAt).getTime();
  const delay = Math.max(0, Math.min(2_147_000_000, graceMs - ageMs));
  disconnectTimers.set(key, setTimeout(() => {
    void expireDisconnectedParticipant(matchId, playerId)
      .then(async result => {
        if ('rescheduleAt' in result && result.rescheduleAt) scheduleDisconnectExpiry(matchId, playerId, result.rescheduleAt, result.isHost);
        if (result.changed) {
          await broadcastSnapshot(matchId);
          if (result.phase && result.phase !== 'active') {
            const timer = countdownTimers.get(matchId);
            if (timer) clearTimeout(timer);
            countdownTimers.delete(matchId);
            if (result.phase !== 'lobby') {
              gpsObservations.delete(matchId);
              capturePins.delete(matchId);
              for (const proximityKey of automaticProximitySince.keys()) if (proximityKey.startsWith(`${matchId}:`)) automaticProximitySince.delete(proximityKey);
            }
          }
        }
      })
      .catch(() => scheduleDisconnectExpiry(matchId, playerId, new Date(), isHost));
  }, delay));
}

function participantGraceMs() {
  return process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.HUNTZONE_TEST_PARTICIPANT_GRACE_MS) || 120_000) : 120_000;
}

function hostGraceMs() {
  return process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.HUNTZONE_TEST_HOST_GRACE_MS) || 300_000) : 300_000;
}

function testDurationMs(name: string, fallback: number, maximum: number) {
  if (process.env.NODE_ENV !== 'test') return fallback;
  const requested = Number(process.env[name]);
  return Number.isFinite(requested) && requested > 0 ? Math.min(maximum, Math.floor(requested)) : fallback;
}

function scheduleHostDisconnectExpiry(matchId: string, disconnectedAt: Date | string) {
  const previous = hostDisconnectTimers.get(matchId);
  if (previous) clearTimeout(previous);
  const ageMs = Date.now() - new Date(disconnectedAt).getTime();
  const delay = Math.max(0, Math.min(2_147_000_000, hostGraceMs() - ageMs));
  hostDisconnectTimers.set(matchId, setTimeout(() => {
    void expireHostDisconnect(matchId, new Date(disconnectedAt).getTime())
      .then(async result => {
        if ('rescheduleAt' in result && result.rescheduleAt) scheduleHostDisconnectExpiry(matchId, result.rescheduleAt);
        if (result.changed) {
          clearMatchDisconnectTimers(matchId);
          const timer = countdownTimers.get(matchId);
          if (timer) clearTimeout(timer);
          countdownTimers.delete(matchId);
          gpsObservations.delete(matchId);
          capturePins.delete(matchId);
          for (const key of automaticProximitySince.keys()) if (key.startsWith(`${matchId}:`)) automaticProximitySince.delete(key);
          await broadcastSnapshot(matchId);
        }
      })
      .catch(() => scheduleHostDisconnectExpiry(matchId, new Date(disconnectedAt)));
  }, delay));
}

async function expireHostDisconnect(matchId: string, expectedDisconnectedAtMs: number) {
  if (!pool) return { changed: false as const };
  return withTransaction(async client => {
    const selected = await client.query<{
      phase: string; paused_from_phase: string | null; revision: string; host_disconnected_at: Date | null;
    }>('SELECT phase,paused_from_phase,revision,host_disconnected_at FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
    const match = selected.rows[0];
    if (!match || match.phase !== 'paused' || !match.host_disconnected_at
      || match.host_disconnected_at.getTime() !== expectedDisconnectedAtMs) return { changed: false as const };
    const elapsed = Date.now() - match.host_disconnected_at.getTime();
    if (elapsed < hostGraceMs()) return { changed: false as const, rescheduleAt: match.host_disconnected_at };
    const revision = Number(match.revision) + 1;
    if (match.paused_from_phase === 'active') {
      const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
        'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
      );
      const runtime = checkpoint.rows[0]?.virtual_state;
      if (!runtime) return { changed: false as const };
      const cancelled: MatchRuntime = { ...runtime, phase: 'cancelled', revision, winner: undefined, endReason: 'host-disconnected' };
      await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
        [matchId, revision, cancelled.engineVersion, JSON.stringify(cancelled)]);
    }
    await client.query("UPDATE matches SET phase='cancelled',paused_from_phase=NULL,host_disconnected_at=NULL,host_disconnect_player_id=NULL,countdown_ends_at=NULL,revision=$2,ended_at=clock_timestamp() WHERE id=$1", [matchId, revision]);
    await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND purpose='active-match-location' AND withdrawn_at IS NULL", [matchId]);
    await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
      [matchId, revision, 'match.cancelled', null, JSON.stringify({ reason: 'host-return-timeout' })]);
    return { changed: true as const };
  });
}

async function recordParticipantDisconnect(matchId: string, playerId: string) {
  if (!pool) return null;
  return withTransaction(async client => {
    const participant = await client.query<{ disconnected_at: Date }>(
      'UPDATE participants SET connected=false,disconnected_at=COALESCE(disconnected_at,clock_timestamp()) WHERE match_id=$1 AND player_id=$2 RETURNING disconnected_at',
      [matchId, playerId],
    );
    if (!participant.rows[0]) return null;
    const selected = await client.query<{
      phase: string; revision: string; host_player_id: string; paused_from_phase: string | null;
      host_disconnected_at: Date | null; host_disconnect_player_id: string | null;
    }>('SELECT phase,revision,host_player_id,paused_from_phase,host_disconnected_at,host_disconnect_player_id FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
    const match = selected.rows[0];
    if (!match || ['completed', 'cancelled'].includes(match.phase)) {
      return { disconnectedAt: participant.rows[0].disconnected_at, isHost: false, paused: false };
    }
    if (match.phase === 'paused') {
      if (match.host_player_id !== playerId) return { disconnectedAt: participant.rows[0].disconnected_at, isHost: false, paused: false };
      const replacement = await client.query<{ player_id: string }>(
        'SELECT player_id FROM participants WHERE match_id=$1 AND player_id<>$2 AND connected ORDER BY connected_since,joined_at,player_id LIMIT 1', [matchId, playerId],
      );
      if (replacement.rows[0]) {
        const revision = Number(match.revision) + 1;
        if (match.paused_from_phase === 'active') {
          const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
            'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
          );
          const runtime = checkpoint.rows[0]?.virtual_state;
          if (!runtime) throw new Error('PAUSED_MATCH_CHECKPOINT_MISSING');
          const nextRuntime = { ...runtime, hostPlayerId: replacement.rows[0].player_id, revision };
          await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
            [matchId, revision, nextRuntime.engineVersion, JSON.stringify(nextRuntime)]);
        }
        await client.query('UPDATE matches SET host_player_id=$2,revision=$3 WHERE id=$1', [matchId, replacement.rows[0].player_id, revision]);
        await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
          [matchId, revision, 'host.transferred', playerId, JSON.stringify({ newHostPlayerId: replacement.rows[0].player_id, reason: 'paused-host-disconnected' })]);
      }
      return { disconnectedAt: participant.rows[0].disconnected_at, isHost: false, paused: false };
    }
    if (match.host_player_id !== playerId) return { disconnectedAt: participant.rows[0].disconnected_at, isHost: false, paused: false };

    const revision = Number(match.revision) + 1;
    const successor = await client.query<{ player_id: string }>(
      'SELECT player_id FROM participants WHERE match_id=$1 AND player_id<>$2 AND connected ORDER BY connected_since,joined_at,player_id LIMIT 1', [matchId, playerId],
    );
    const nextHostId = successor.rows[0]?.player_id ?? playerId;
    if (match.phase === 'active') {
      const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
        'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
      );
      const runtime = checkpoint.rows[0]?.virtual_state;
      if (!runtime) throw new Error('ACTIVE_MATCH_CHECKPOINT_MISSING');
      const pausedRuntime = { ...runtime, hostPlayerId: nextHostId, revision };
      await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
        [matchId, revision, pausedRuntime.engineVersion, JSON.stringify(pausedRuntime)]);
    }
    await client.query(
      `UPDATE matches SET phase='paused',paused_from_phase=$2,host_disconnected_at=$3,host_disconnect_player_id=$4,
              host_player_id=$5,countdown_ends_at=CASE WHEN $7::boolean THEN countdown_ends_at ELSE NULL END,revision=$6
        WHERE id=$1`,
      [matchId, match.phase, participant.rows[0].disconnected_at, playerId, nextHostId, revision, match.phase === 'countdown'],
    );
    await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
      [matchId, revision, 'match.paused', playerId, JSON.stringify({ reason: 'host-disconnected', pausedFrom: match.phase, hostControlsTransferredTo: successor.rows[0]?.player_id ?? null })]);
    return { disconnectedAt: participant.rows[0].disconnected_at, isHost: true, paused: true };
  });
}

async function resumeHostPausedMatch(matchId: string, actorPlayerId: string, commandId: string, expectedRevision: number) {
  if (!pool) return { ok: false as const, status: 503, message: 'Database non disponibile.' };
  return withTransaction(async client => {
    const selected = await client.query<{
      phase: string; paused_from_phase: string | null; host_disconnected_at: Date | null; host_disconnect_player_id: string | null;
      host_player_id: string; revision: string; countdown_ends_at: Date | null;
    }>('SELECT phase,paused_from_phase,host_disconnected_at,host_disconnect_player_id,host_player_id,revision,countdown_ends_at FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
    const match = selected.rows[0];
    if (!match) return { ok: false as const, status: 404, message: 'Partita non trovata.' };
    const duplicate = await client.query<{ result: Record<string, unknown> }>(
      'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3', [matchId, actorPlayerId, commandId],
    );
    if (duplicate.rows[0]) return { ok: true as const, result: duplicate.rows[0].result, duplicate: true };
    if (match.phase !== 'paused' || !match.paused_from_phase || !match.host_disconnected_at) return { ok: false as const, status: 409, message: 'La partita non è in pausa per la disconnessione dell’host.' };
    if (Date.now() - match.host_disconnected_at.getTime() >= hostGraceMs()) return { ok: false as const, status: 409, message: 'Il tempo di recupero host è scaduto; la partita verrà annullata senza vincitore.' };
    if (match.host_player_id !== actorPlayerId) return { ok: false as const, status: 403, message: 'Solo l’host attuale può riprendere la partita.' };
    if (Number(match.revision) !== expectedRevision) return { ok: false as const, status: 409, message: 'La partita è cambiata. Aggiorna lo stato e riprova.' };
    const now = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const resumedAt = now.rows[0]!.now;
    const pausedMs = Math.max(0, resumedAt.getTime() - match.host_disconnected_at.getTime());
    const revision = Number(match.revision) + 1;
    if (match.paused_from_phase === 'active') {
      const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
        'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
      );
      const runtime = checkpoint.rows[0]?.virtual_state;
      if (!runtime || runtime.phase !== 'active') return { ok: false as const, status: 503, message: 'Checkpoint della partita non disponibile.' };
      const resumedRuntime = { ...runtime, deadlineAtMs: runtime.deadlineAtMs + pausedMs, captureAvailableAtMs: runtime.captureAvailableAtMs + pausedMs, revision };
      await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
        [matchId, revision, resumedRuntime.engineVersion, JSON.stringify(resumedRuntime)]);
    }
    const nextPhase = match.paused_from_phase;
    await client.query(
      `UPDATE matches SET phase=$2,revision=$3,paused_from_phase=NULL,host_disconnected_at=NULL,host_disconnect_player_id=NULL,
              countdown_ends_at=CASE WHEN $5::boolean THEN countdown_ends_at + ($4::double precision * interval '1 millisecond') ELSE NULL END
        WHERE id=$1`, [matchId, nextPhase, revision, pausedMs, nextPhase === 'countdown'],
    );
    const result = { matchId, phase: nextPhase, revision };
    await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
      [matchId, revision, 'match.resumed', actorPlayerId, JSON.stringify({ pausedMilliseconds: pausedMs, phase: nextPhase })]);
    await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
      [matchId, actorPlayerId, commandId, revision, JSON.stringify(result)]);
    return { ok: true as const, result, duplicate: false };
  });
}

async function expireDisconnectedParticipant(matchId: string, playerId: string) {
  if (!pool) return { changed: false as const };
  const result = await withTransaction(async client => {
    const selected = await client.query<{
      phase: string; paused_from_phase: string | null; host_player_id: string; host_disconnect_player_id: string | null;
      revision: string; connected: boolean; disconnected_at: Date | null; virtual_status: string;
    }>(
      `SELECT m.phase,m.paused_from_phase,m.revision,m.host_player_id,m.host_disconnect_player_id,p.connected,p.disconnected_at,p.virtual_status
         FROM matches m JOIN participants p ON p.match_id=m.id
        WHERE m.id=$1 AND p.player_id=$2 FOR UPDATE OF m,p`, [matchId, playerId],
    );
    const row = selected.rows[0];
    if (!row || row.connected || !row.disconnected_at || ['completed', 'cancelled'].includes(row.phase)) return { changed: false as const };
    if (row.phase === 'paused' && row.host_disconnect_player_id === playerId) return { changed: false as const };
    const isHost = row.host_player_id === playerId;
    const graceMs = isHost ? hostGraceMs() : participantGraceMs();
    const ageMs = Date.now() - row.disconnected_at.getTime();
    if (ageMs < graceMs) return { changed: false as const, isHost, rescheduleAt: row.disconnected_at };
    const revision = Number(row.revision) + 1;
    if (isHost) {
      const successor = await client.query<{ player_id: string }>(
        'SELECT player_id FROM participants WHERE match_id=$1 AND player_id<>$2 AND connected ORDER BY joined_at,player_id LIMIT 1', [matchId, playerId],
      );
      if (successor.rows[0]) {
        if (row.phase === 'active') {
          const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
            'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
          );
          const runtime = checkpoint.rows[0]?.virtual_state;
          if (!runtime) return { changed: false as const };
          const nextRuntime = { ...runtime, hostPlayerId: successor.rows[0].player_id, revision };
          await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
            [matchId, revision, nextRuntime.engineVersion, JSON.stringify(nextRuntime)]);
        }
        await client.query('UPDATE matches SET host_player_id=$2,revision=$3 WHERE id=$1', [matchId, successor.rows[0].player_id, revision]);
        await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
          [matchId, revision, 'host.transferred', playerId, JSON.stringify({ newHostPlayerId: successor.rows[0].player_id, reason: 'disconnect-grace-expired' })]);
        return { changed: true as const, phase: row.phase };
      }
      if (row.phase === 'active') {
        const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
          'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
        );
        const runtime = checkpoint.rows[0]?.virtual_state;
        if (!runtime) return { changed: false as const };
        const cancelled: MatchRuntime = { ...runtime, phase: 'cancelled', revision, winner: undefined, endReason: 'host-disconnected' };
        await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
          [matchId, revision, cancelled.engineVersion, JSON.stringify(cancelled)]);
        await client.query("UPDATE matches SET phase='cancelled',revision=$2,ended_at=clock_timestamp() WHERE id=$1", [matchId, revision]);
      } else {
        await client.query("UPDATE matches SET phase='cancelled',countdown_ends_at=NULL,revision=$2,ended_at=clock_timestamp() WHERE id=$1", [matchId, revision]);
      }
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [matchId, revision, row.phase === 'active' ? 'match.cancelled' : 'lobby.cancelled', playerId, JSON.stringify({ reason: 'host-disconnected' })]);
      return { changed: true as const, phase: 'cancelled' };
    }
    const effectivePhase = row.phase === 'paused' ? row.paused_from_phase : row.phase;
    if (effectivePhase === 'active') {
      if (row.virtual_status !== 'active') return { changed: false as const };
      const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
        'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
      );
      const runtime = checkpoint.rows[0]?.virtual_state;
      if (!runtime) return { changed: false as const };
      const withdrawn = withdrawPlayer({ state: runtime, playerId, commandId: `disconnect-${playerId}-${revision}`, nowMs: Date.now() });
      if (!withdrawn.ok) return { changed: false as const };
      const next = withdrawn.value.state;
      const persistedPhase = row.phase === 'paused' && next.phase === 'active' ? 'paused' : next.phase;
      await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $4 THEN clock_timestamp() ELSE ended_at END WHERE id=$1', [matchId, persistedPhase, next.revision, next.phase !== 'active']);
      await client.query("UPDATE participants SET virtual_status='withdrawn' WHERE match_id=$1 AND player_id=$2", [matchId, playerId]);
      await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND player_id=$2 AND purpose='active-match-location' AND withdrawn_at IS NULL", [matchId, playerId]);
      await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)', [matchId, next.revision, next.engineVersion, JSON.stringify(next)]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [matchId, next.revision, 'player.withdrew', playerId, JSON.stringify({ reason: 'disconnect-grace-expired' })]);
      return { changed: true as const, phase: next.phase, paused: row.phase === 'paused' };
    }
    if (!['lobby', 'countdown'].includes(effectivePhase ?? '')) return { changed: false as const };
    await client.query('DELETE FROM participants WHERE match_id=$1 AND player_id=$2', [matchId, playerId]);
    const remaining = await client.query<{ player_id: string }>('SELECT player_id FROM participants WHERE match_id=$1 ORDER BY connected DESC,joined_at,player_id', [matchId]);
    const nextPhase = remaining.rowCount ? 'lobby' : 'cancelled';
    if (effectivePhase === 'countdown') await client.query('UPDATE participants SET ready=false WHERE match_id=$1', [matchId]);
    if (remaining.rowCount) {
      await client.query("UPDATE matches SET phase=CASE WHEN phase='paused' THEN 'paused' ELSE 'lobby' END,paused_from_phase=CASE WHEN phase='paused' THEN 'lobby' ELSE NULL END,countdown_ends_at=NULL,revision=$2 WHERE id=$1", [matchId, revision]);
    } else {
      await client.query("UPDATE matches SET phase='cancelled',countdown_ends_at=NULL,revision=$2,ended_at=clock_timestamp() WHERE id=$1", [matchId, revision]);
    }
    await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
      [matchId, revision, 'player.disconnected-expired', playerId, JSON.stringify({ phase: nextPhase, graceSeconds: 120 })]);
    return { changed: true as const, phase: nextPhase, paused: row.phase === 'paused' };
  });
  if (result.changed) {
    disconnectTimers.delete(disconnectTimerKey(matchId, playerId));
    clearGpsObservation(matchId, playerId);
    if (result.phase === 'cancelled') {
      gpsObservations.delete(matchId);
      capturePins.delete(matchId);
      for (const key of automaticProximitySince.keys()) if (key.startsWith(`${matchId}:`)) automaticProximitySince.delete(key);
      clearMatchDisconnectTimers(matchId);
    }
  }
  return result;
}

async function publicSnapshot(matchId: string, viewerPlayerId: string) {
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  await finishDeadline(matchId);
  await finishCountdown(matchId);
  const match = await pool.query<MatchRow & { center_latitude: number | null; center_longitude: number | null }>(
    `SELECT m.id, m.invite_code, m.host_player_id, m.mode_id, m.config, m.phase, m.revision,m.paused_from_phase,
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
  const checkpoint = row.phase === 'active' || row.phase === 'completed' || row.phase === 'cancelled' || row.phase === 'paused'
    ? await pool.query<{ virtual_state: MatchRuntime }>('SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1', [matchId])
    : { rows: [] as { virtual_state: MatchRuntime }[] };
  const runtime = checkpoint.rows[0]?.virtual_state;
  const isClassicLobby = row.phase === 'lobby' && row.mode_id === 'classic-hide-and-seek';
  if (row.config.captureMethod === 'pin' && runtime?.phase === 'active' && !capturePins.has(matchId)) issueCapturePins(matchId, runtime);
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
      return participant ? { id: participant.id, displayName: participant.display_name, gpsReady: Boolean(gpsObservation(matchId, participant.id)) } : null;
    }).filter((player): player is { id: string; displayName: string; gpsReady: boolean } => player !== null)
    : undefined;
  const canCapture = Boolean(row.phase === 'active' && runtime?.phase === 'active' && runtime.modeId === 'classic-hide-and-seek' && own.rows[0]?.role_id === 'seeker'
    && row.config.captureMethod !== 'automatic' && Date.now() >= runtime.captureAvailableAtMs
    && captureTargets?.length && gpsObservation(matchId, viewerPlayerId)
    && captureTargets.some(target => target.gpsReady));
  return {
    matchId: row.id,
    inviteCode: row.invite_code,
    hostPlayerId: row.host_player_id,
    viewerPlayerId,
    isHost: viewerPlayerId === row.host_player_id,
    revision: Number(row.revision),
    phase: row.phase,
    ...(row.paused_from_phase ? { pausedFromPhase: row.paused_from_phase } : {}),
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
    capabilities: { start: canStart, roles: Boolean(own.rows[0]?.role_id), gameplay: row.phase === 'active' && runtime?.phase === 'active', capture: canCapture },
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
    if (expectedRevision > state.revision) return { ok: false as const, status: 409, message: 'La lobby è cambiata. Aggiorna lo stato e riprova.' };
    // Per-player READY changes commute while the match is still a lobby. Use the
    // locked current revision so simultaneous participants do not reject each other.
    const transition = applyLobbyCommand(state, { type: 'player.ready-changed', actorPlayerId: principal.playerId, ready, commandId, expectedRevision: state.revision });
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
await app.register(rateLimit, { max: process.env.NODE_ENV === 'test' ? 1000 : 120, timeWindow: '1 minute' });
await app.register(websocket, { options: { maxPayload: 8192 } });

app.get('/v1/health', async (_request, reply) => {
  if (!pool) return reply.code(503).send({ status: 'unavailable', reason: 'database-not-configured' });
  try { await pool.query('SELECT PostGIS_Version()'); return { status: 'ok' }; }
  catch { return reply.code(503).send({ status: 'unavailable', reason: 'database-unavailable' }); }
});

app.post<{ Body: { displayName: string } }>('/v1/guest-sessions', {
  config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 100 : 8, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: { type: 'string', minLength: 2, maxLength: 32, pattern: '.*\\S.*' } } } },
}, async (request, reply) => {
  if (!pool) return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servizio multiplayer non disponibile.' } });
  const existing = await authenticate(request);
  if (existing) return reply.send({ playerId: existing.playerId, displayName: existing.displayName });
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
        WHERE p.player_id=$1 AND m.phase IN ('lobby','countdown','active','paused','completed','cancelled')
        ORDER BY CASE WHEN m.phase IN ('lobby','countdown','active','paused') THEN 0 ELSE 1 END, p.joined_at DESC LIMIT 1`, [principal.playerId],
    );
    const match = active.rows[0] ? await publicSnapshot(active.rows[0].id, principal.playerId) : null;
    return reply.send({ session: principal, match });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Impossibile recuperare la sessione.' } }); }
});

app.post<{ Body: { modeId: string; playerCap: number; radiusMeters: number; durationSeconds: number; centerLatitude: number; centerLongitude: number; captureMethod?: MatchState['config']['captureMethod']; displayName?: string } }>('/v1/lobbies', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['modeId', 'playerCap', 'radiusMeters', 'durationSeconds', 'centerLatitude', 'centerLongitude'], properties: {
    modeId: { type: 'string', enum: ['classic-hide-and-seek'] }, playerCap: { type: 'integer', minimum: 3, maximum: 30 }, radiusMeters: { type: 'integer', minimum: 100, maximum: 3000 }, durationSeconds: { type: 'integer', minimum: 600, maximum: 7200 }, centerLatitude: { type: 'number', minimum: -90, maximum: 90 }, centerLongitude: { type: 'number', minimum: -180, maximum: 180 }, captureMethod: { type: 'string', enum: ['radius', 'pin', 'automatic'] }, displayName: { type: 'string', minLength: 2, maxLength: 32 },
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
  config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 1000 : 12, timeWindow: '1 minute' } },
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

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number } }>('/v1/matches/:matchId/leave', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const { matchId } = request.params;
  try {
    const result = await withTransaction(async client => {
      const matchResult = await client.query<{ phase: string; paused_from_phase: string | null; revision: string; host_player_id: string }>(
        'SELECT phase,paused_from_phase,revision,host_player_id FROM matches WHERE id=$1 FOR UPDATE', [matchId],
      );
      const match = matchResult.rows[0];
      if (!match) return { ok: false as const, status: 404, message: 'Partita non trovata.' };
      const duplicate = await client.query<{ result: Record<string, unknown> }>(
        'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3',
        [matchId, principal.playerId, request.body.commandId],
      );
      if (duplicate.rows[0]) return {
        ok: true as const, value: duplicate.rows[0].result, duplicate: true,
        removedFromLobby: Boolean(duplicate.rows[0].result.removedFromLobby), phase: String(duplicate.rows[0].result.phase ?? match.phase),
      };
      const member = await client.query<{ ready: boolean; virtual_status: string }>(
        'SELECT ready,virtual_status FROM participants WHERE match_id=$1 AND player_id=$2 FOR UPDATE', [matchId, principal.playerId],
      );
      if (!member.rowCount) return { ok: false as const, status: 404, message: 'Partecipante non trovato.' };
      if (Number(match.revision) !== request.body.expectedRevision) return { ok: false as const, status: 409, message: 'La partita è cambiata. Aggiorna lo stato e riprova.' };
      let revision = Number(match.revision) + 1;
      let phase = match.phase;
      const effectivePhase = phase === 'paused' ? match.paused_from_phase : phase;
      let hostPlayerId = match.host_player_id;
      let withdrawn = false;
      if (effectivePhase === 'lobby' || effectivePhase === 'countdown') {
        await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND player_id=$2 AND purpose='active-match-location' AND withdrawn_at IS NULL", [matchId, principal.playerId]);
        await client.query('DELETE FROM participants WHERE match_id=$1 AND player_id=$2', [matchId, principal.playerId]);
        const remaining = await client.query<{ player_id: string }>(
          'SELECT player_id FROM participants WHERE match_id=$1 ORDER BY connected DESC,joined_at,player_id', [matchId],
        );
        if (!remaining.rowCount) {
          phase = 'cancelled';
          await client.query("UPDATE matches SET phase='cancelled',paused_from_phase=NULL,host_disconnected_at=NULL,host_disconnect_player_id=NULL,countdown_ends_at=NULL,ended_at=clock_timestamp(),revision=$2 WHERE id=$1", [matchId, revision]);
        } else {
          if (hostPlayerId === principal.playerId) hostPlayerId = remaining.rows[0]!.player_id;
          if (effectivePhase === 'countdown') await client.query('UPDATE participants SET ready=false WHERE match_id=$1', [matchId]);
          phase = match.phase === 'paused' ? 'paused' : 'lobby';
          if (phase === 'paused') {
            await client.query("UPDATE matches SET paused_from_phase='lobby',countdown_ends_at=NULL,host_player_id=$2,revision=$3 WHERE id=$1", [matchId, hostPlayerId, revision]);
          } else await client.query('UPDATE matches SET phase=$2,countdown_ends_at=NULL,host_player_id=$3,revision=$4 WHERE id=$1', [matchId, phase, hostPlayerId, revision]);
        }
      } else if (effectivePhase === 'active') {
        const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
          'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [matchId],
        );
        const runtime = checkpoint.rows[0]?.virtual_state;
        if (!runtime) return { ok: false as const, status: 503, message: 'Stato partita non disponibile.' };
        const transition = withdrawPlayer({ state: runtime, playerId: principal.playerId, commandId: request.body.commandId, nowMs: Date.now() });
        if (!transition.ok) return { ok: false as const, status: 409, message: 'Uscita non applicabile allo stato corrente.' };
        phase = match.phase === 'paused' && transition.value.state.phase === 'active' ? 'paused' : transition.value.state.phase;
        revision = transition.value.state.revision;
        withdrawn = true;
        const successor = await client.query<{ player_id: string }>(
          'SELECT player_id FROM participants WHERE match_id=$1 AND player_id<>$2 AND connected ORDER BY connected_since,joined_at,player_id LIMIT 1', [matchId, principal.playerId],
        );
        if (hostPlayerId === principal.playerId && successor.rows[0]) hostPlayerId = successor.rows[0].player_id;
        const terminal = transition.value.state.phase !== 'active';
        await client.query('UPDATE matches SET phase=$2,revision=$3,host_player_id=$5,ended_at=CASE WHEN $4 THEN clock_timestamp() ELSE ended_at END,paused_from_phase=CASE WHEN $6 THEN NULL ELSE paused_from_phase END,host_disconnected_at=CASE WHEN $6 THEN NULL ELSE host_disconnected_at END,host_disconnect_player_id=CASE WHEN $6 THEN NULL ELSE host_disconnect_player_id END WHERE id=$1',
          [matchId, phase, revision, terminal, hostPlayerId, terminal]);
        await client.query("UPDATE participants SET virtual_status='withdrawn' WHERE match_id=$1 AND player_id=$2", [matchId, principal.playerId]);
        await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND player_id=$2 AND purpose='active-match-location' AND withdrawn_at IS NULL", [matchId, principal.playerId]);
        await client.query('INSERT INTO match_checkpoints(match_id,revision,engine_version,virtual_state) VALUES($1,$2,$3,$4)',
          [matchId, revision, transition.value.state.engineVersion, JSON.stringify(transition.value.state)]);
      } else return { ok: false as const, status: 409, message: 'La partita non accetta più uscite.' };
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [matchId, revision, 'player.left', principal.playerId, JSON.stringify({ phase, hostPlayerId: hostPlayerId === principal.playerId ? null : hostPlayerId, voluntary: true })]);
      const payload = { matchId, revision, phase, hostPlayerId, withdrawn, removedFromLobby: !withdrawn };
      await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
        [matchId, principal.playerId, request.body.commandId, revision, JSON.stringify(payload)]);
      return { ok: true as const, value: payload, duplicate: false, removedFromLobby: !withdrawn, phase };
    });
    if (!result.ok) return reply.code(result.status).send({ error: { code: 'LEAVE_REJECTED', message: result.message } });
    clearGpsObservation(matchId, principal.playerId);
    if (result.removedFromLobby) {
      const ownSockets = socketsByMatch.get(matchId);
      for (const connection of [...(ownSockets ?? [])]) if (connection.playerId === principal.playerId) connection.socket.close(1000, 'participant left');
    }
    if (result.phase !== 'active') {
      const timer = countdownTimers.get(matchId);
      if (timer) clearTimeout(timer);
      countdownTimers.delete(matchId);
      gpsObservations.delete(matchId);
      capturePins.delete(matchId);
      for (const key of automaticProximitySince.keys()) if (key.startsWith(`${matchId}:`)) automaticProximitySince.delete(key);
    }
    if (['completed', 'cancelled'].includes(result.phase)) clearMatchDisconnectTimers(matchId);
    await broadcastSnapshot(matchId);
    const snapshot = result.removedFromLobby ? null : await publicSnapshot(matchId, principal.playerId);
    return reply.send({ ...result.value, duplicate: result.duplicate, snapshot });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Uscita non registrata.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number } }>('/v1/matches/:matchId/cancel', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const { matchId } = request.params;
  try {
    const outcome = await withTransaction(async client => {
      const matchResult = await client.query<{ phase: string; revision: string; host_player_id: string }>(
        'SELECT phase,revision,host_player_id FROM matches WHERE id=$1 FOR UPDATE', [matchId],
      );
      const match = matchResult.rows[0];
      if (!match) return { ok: false as const, status: 404, message: 'Lobby non trovata.' };
      if (match.host_player_id !== principal.playerId) return { ok: false as const, status: 403, message: 'Solo l’host può annullare la lobby.' };
      const duplicate = await client.query<{ result: Record<string, unknown> }>(
        'SELECT result FROM processed_commands WHERE match_id=$1 AND actor_player_id=$2 AND command_id=$3', [matchId, principal.playerId, request.body.commandId],
      );
      if (duplicate.rows[0]) return { ok: true as const, value: duplicate.rows[0].result, duplicate: true };
      if (!['lobby', 'countdown', 'paused'].includes(match.phase)) return { ok: false as const, status: 409, message: 'La partita non è annullabile in questa fase.' };
      if (Number(match.revision) !== request.body.expectedRevision) return { ok: false as const, status: 409, message: 'La lobby è cambiata. Aggiorna lo stato e riprova.' };
      const revision = Number(match.revision) + 1;
      await client.query("UPDATE matches SET phase='cancelled',paused_from_phase=NULL,host_disconnected_at=NULL,host_disconnect_player_id=NULL,countdown_ends_at=NULL,ended_at=clock_timestamp(),revision=$2 WHERE id=$1", [matchId, revision]);
      await client.query('UPDATE participants SET ready=false WHERE match_id=$1', [matchId]);
      await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND purpose='active-match-location' AND withdrawn_at IS NULL", [matchId]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [matchId, revision, 'lobby.cancelled', principal.playerId, JSON.stringify({ reason: 'host-cancelled' })]);
      const value = { matchId, revision, phase: 'cancelled' };
      await client.query('INSERT INTO processed_commands(match_id,actor_player_id,command_id,committed_revision,result) VALUES($1,$2,$3,$4,$5)',
        [matchId, principal.playerId, request.body.commandId, revision, JSON.stringify(value)]);
      return { ok: true as const, value, duplicate: false };
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: { code: 'CANCEL_REJECTED', message: outcome.message } });
    const timer = countdownTimers.get(matchId);
    if (timer) clearTimeout(timer);
    countdownTimers.delete(matchId);
    clearMatchDisconnectTimers(matchId);
    gpsObservations.delete(matchId);
    capturePins.delete(matchId);
    for (const key of automaticProximitySince.keys()) if (key.startsWith(`${matchId}:`)) automaticProximitySince.delete(key);
    await broadcastSnapshot(matchId);
    return reply.send({ ...outcome.value, duplicate: outcome.duplicate, snapshot: await publicSnapshot(matchId, principal.playerId) });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Annullamento non registrato.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number } }>('/v1/matches/:matchId/resume', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  try {
    const resumed = await resumeHostPausedMatch(request.params.matchId, principal.playerId, request.body.commandId, request.body.expectedRevision);
    if (!resumed.ok) return reply.code(resumed.status).send({ error: { code: 'RESUME_REJECTED', message: resumed.message } });
    const hostTimer = hostDisconnectTimers.get(request.params.matchId);
    if (hostTimer) clearTimeout(hostTimer);
    hostDisconnectTimers.delete(request.params.matchId);
    if (resumed.result.phase === 'active') {
      const checkpoint = await pool?.query<{ virtual_state: MatchRuntime }>(
        'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1', [request.params.matchId],
      );
      if (checkpoint?.rows[0]) scheduleDeadline(request.params.matchId, checkpoint.rows[0].virtual_state.deadlineAtMs);
    } else if (resumed.result.phase === 'countdown') {
      const countdown = await pool?.query<{ countdown_ends_at: Date }>(
        "SELECT countdown_ends_at FROM matches WHERE id=$1 AND phase='countdown'", [request.params.matchId],
      );
      if (countdown?.rows[0]) scheduleCountdown(request.params.matchId, countdown.rows[0].countdown_ends_at.getTime());
    }
    await broadcastSnapshot(request.params.matchId);
    return reply.send({ ...resumed.result, duplicate: resumed.duplicate, snapshot: await publicSnapshot(request.params.matchId, principal.playerId) });
  } catch (error) {
    if (process.env.NODE_ENV === 'test') process.stderr.write(`resume transition failed: ${(error as { code?: string }).code ?? 'unknown'} ${(error as Error).message}\n`);
    return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Ripresa non confermata dal server.' } });
  }
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
      const match = await client.query<{ phase: string; paused_from_phase: string | null; revision: string; ready: boolean }>(
        `SELECT m.phase,m.paused_from_phase,m.revision,p.ready FROM matches m JOIN participants p ON p.match_id=m.id
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
      const effectivePhase = row.phase === 'paused' ? row.paused_from_phase : row.phase;
      if (!request.body.granted && !['lobby', 'countdown', 'active'].includes(effectivePhase ?? '')) return { ok: false as const, status: 409, message: 'La partita non accetta più modifiche al consenso GPS.' };
      // Independent consent grants can safely race: each is locked and recorded for
      // one authenticated participant. Revocations and state-changing withdrawals
      // still require the current revision below.
      if (!request.body.granted && Number(row.revision) !== request.body.expectedRevision) {
        return { ok: false as const, status: 409, message: 'La lobby è cambiata. Aggiorna lo stato e riprova.' };
      }
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
      if (!request.body.granted && effectivePhase === 'countdown') {
        await client.query("UPDATE participants SET ready=false WHERE match_id=$1", [request.params.matchId]);
        if (row.phase === 'paused') await client.query("UPDATE matches SET paused_from_phase='lobby',countdown_ends_at=NULL,revision=$2 WHERE id=$1", [request.params.matchId, revision]);
        else await client.query("UPDATE matches SET phase='lobby',countdown_ends_at=NULL,revision=$2 WHERE id=$1", [request.params.matchId, revision]);
      } else if (!request.body.granted && effectivePhase === 'active') {
        const checkpoint = await client.query<{ virtual_state: MatchRuntime }>(
          'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [request.params.matchId],
        );
        const runtime = checkpoint.rows[0]?.virtual_state;
        if (!runtime) return { ok: false as const, status: 503, message: 'Stato partita non disponibile; revoca non confermata.' };
        const result = withdrawPlayer({ state: runtime, playerId: principal.playerId, commandId: request.body.commandId, nowMs: Date.now() });
        if (!result.ok) return { ok: false as const, status: 409, message: 'Ritiro partita non applicabile allo stato corrente.' };
        revision = result.value.state.revision;
        const persistedPhase = row.phase === 'paused' && result.value.state.phase === 'active' ? 'paused' : result.value.state.phase;
        await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $4 THEN clock_timestamp() ELSE ended_at END,paused_from_phase=CASE WHEN $5 THEN NULL ELSE paused_from_phase END,host_disconnected_at=CASE WHEN $5 THEN NULL ELSE host_disconnected_at END,host_disconnect_player_id=CASE WHEN $5 THEN NULL ELSE host_disconnect_player_id END WHERE id=$1',
          [request.params.matchId, persistedPhase, revision, result.value.state.phase !== 'active', result.value.state.phase !== 'active']);
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
      for (const proximityKey of automaticProximitySince.keys()) if (proximityKey.startsWith(`${request.params.matchId}:`)) automaticProximitySince.delete(proximityKey);
      const timer = countdownTimers.get(request.params.matchId); if (timer) clearTimeout(timer);
      countdownTimers.delete(request.params.matchId);
    }
    return reply.send({ ...transition, snapshot });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Consenso GPS non registrato.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { latitude: number; longitude: number; accuracyMeters: number; sequence: number; timestampMs: number } }>('/v1/matches/:matchId/location', {
  config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 1000 : 120, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['latitude', 'longitude', 'accuracyMeters', 'sequence', 'timestampMs'], properties: {
    latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
    accuracyMeters: { type: 'number', minimum: 1, maximum: 10000 }, sequence: { type: 'integer', minimum: 1 }, timestampMs: { type: 'integer', minimum: 0 },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const sample = request.body;
  const serverNow = Date.now();
  if (sample.timestampMs > serverNow + 5_000 || serverNow - sample.timestampMs > 5_000) {
    clearGpsObservation(request.params.matchId, principal.playerId);
    return reply.code(422).send({ error: { code: 'GPS_SAMPLE_STALE', message: 'Il campione GPS deve provenire dagli ultimi 5 secondi.' } });
  }
  try {
    const accepted = await withTransaction(async client => {
      const matchResult = await client.query<{ phase: string; radius_m: number; ready: boolean; consented: boolean; config: MatchState['config']; virtual_status: string; last_gps_sequence: string }>(
        `SELECT m.phase,m.config,(m.config->>'radiusMeters')::integer AS radius_m,p.ready,p.virtual_status,p.last_gps_sequence::text,
                EXISTS(SELECT 1 FROM consents c WHERE c.match_id=m.id AND c.player_id=p.player_id AND c.purpose='active-match-location' AND c.withdrawn_at IS NULL) AS consented
           FROM matches m JOIN participants p ON p.match_id=m.id
          WHERE m.id=$1 AND p.player_id=$2 FOR UPDATE OF m`, [request.params.matchId, principal.playerId],
      );
      const match = matchResult.rows[0];
      if (!match) return { ok: false as const, status: 404, message: 'Match non trovata.' };
      if (!['lobby', 'countdown', 'active'].includes(match.phase) || (match.phase === 'lobby' && !match.ready) || (match.phase === 'active' && match.virtual_status !== 'active')) return { ok: false as const, status: 409, message: 'Il GPS non è atteso in questa fase.' };
      if (!match.consented) return { ok: false as const, status: 403, message: 'Conferma il consenso GPS per questa partita.' };
      const previous = gpsObservations.get(request.params.matchId)?.get(principal.playerId);
      if (sample.sequence <= Number(match.last_gps_sequence)) return { ok: false as const, status: 409, message: 'Campione GPS duplicato o fuori sequenza.' };
      if (previous) {
        const elapsedSeconds = (Date.now() - previous.receivedAtMs) / 1000;
        if (elapsedSeconds > 0 && elapsedSeconds <= 300 && distanceMeters(previous, sample) > Math.max(100, elapsedSeconds * 25)) {
          clearGpsObservation(request.params.matchId, principal.playerId);
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
      await client.query('UPDATE participants SET last_gps_sequence=$3 WHERE match_id=$1 AND player_id=$2', [request.params.matchId, principal.playerId, sample.sequence]);
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
        const monotonicNowMs = Number(process.hrtime.bigint() / 1_000_000n);
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
              nowMs, lastAcceptedSequence: { captor: 0, target: 0 }, proximityStartedAtMs: automaticProximitySince.get(key), proximityNowMs: monotonicNowMs,
            });
            if (evidence.status === 'eligible') {
              const transition = applyCapture({ state: runtime, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId,
                commandId: `automatic-${randomUUID()}`, nowMs, evidence, automaticDwellVerified: true });
              if (!transition.ok) continue;
              const next = transition.value.state;
              await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $4 THEN clock_timestamp() ELSE ended_at END WHERE id=$1', [request.params.matchId, next.phase, next.revision, next.phase !== 'active']);
              await client.query("UPDATE participants SET virtual_status='captured' WHERE match_id=$1 AND player_id=$2", [request.params.matchId, hider.playerId]);
              await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND player_id=$2 AND purpose='active-match-location' AND withdrawn_at IS NULL", [request.params.matchId, hider.playerId]);
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
                clearMatchDisconnectTimers(request.params.matchId);
              }
              break;
            }
            if (evidence.reason === 'dwell-incomplete' && automaticProximitySince.has(key)) continue;
            if (evidence.reason === 'dwell-incomplete') automaticProximitySince.set(key, monotonicNowMs);
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
  config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 1000 : 20, timeWindow: '1 minute' } },
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'expectedRevision', 'targetPlayerId'], properties: {
    commandId: { type: 'string', minLength: 8, maxLength: 80 }, expectedRevision: { type: 'integer', minimum: 0 },
    targetPlayerId: { type: 'string', format: 'uuid' }, pin: { type: 'string', pattern: '^\\d{6}$' },
  } } },
}, async (request, reply) => {
  const principal = await requirePrincipal(request, reply);
  if (!principal) return;
  const { matchId } = request.params;
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
      const captorObservation = gpsObservation(matchId, principal.playerId);
      const targetObservation = gpsObservation(matchId, request.body.targetPlayerId);
      if (!captorObservation || !targetObservation) return { ok: false as const, status: 422, message: 'Servono campioni GPS recenti e affidabili di entrambi i giocatori.' };
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
      await client.query('UPDATE matches SET phase=$2,revision=$3,ended_at=CASE WHEN $4 THEN clock_timestamp() ELSE ended_at END WHERE id=$1', [matchId, next.phase, revision, next.phase !== 'active']);
      await client.query("UPDATE participants SET virtual_status='captured' WHERE match_id=$1 AND player_id=$2", [matchId, request.body.targetPlayerId]);
      await client.query("UPDATE consents SET withdrawn_at=clock_timestamp() WHERE match_id=$1 AND player_id=$2 AND purpose='active-match-location' AND withdrawn_at IS NULL", [matchId, request.body.targetPlayerId]);
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
        clearMatchDisconnectTimers(matchId);
      }
      await broadcastSnapshot(matchId);
    }
    return reply.send({ revision: outcome.revision, duplicate: outcome.duplicate, result: outcome.result, snapshot: await publicSnapshot(matchId, principal.playerId) });
  } catch { return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Cattura non confermata dal server.' } }); }
});

app.post<{ Params: { matchId: string }; Body: { commandId: string; expectedRevision: number } }>('/v1/matches/:matchId/start', {
  config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 1000 : 8, timeWindow: '1 minute' } },
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
      const countdownDurationMs = testDurationMs('HUNTZONE_TEST_COUNTDOWN_MS', 10_000, 10_000);
      const countdown = await client.query<{ ends_at: Date }>("SELECT clock_timestamp() + ($1::double precision * interval '1 millisecond') AS ends_at", [countdownDurationMs]);
      const countdownEndsAt = countdown.rows[0]!.ends_at.toISOString();
      const revision = currentRevision + 1;
      const result = { revision, countdownEndsAt };
      await client.query('UPDATE matches SET phase=\'countdown\',countdown_ends_at=$2,revision=$3 WHERE id=$1', [request.params.matchId, countdownEndsAt, revision]);
      await client.query('INSERT INTO match_events(match_id,revision,event_type,actor_player_id,payload) VALUES($1,$2,$3,$4,$5)',
        [request.params.matchId, revision, 'start.countdown', principal.playerId, JSON.stringify({ durationSeconds: Math.ceil(countdownDurationMs / 1000), participantCount: participants.rows.length })]);
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
      const membership = await pool.query('UPDATE participants SET connected=true,connected_since=CASE WHEN connected THEN connected_since ELSE clock_timestamp() END,disconnected_at=NULL WHERE match_id=$1 AND player_id=$2 RETURNING player_id', [matchId, authenticated.playerId]);
      if (!membership.rowCount) { socket.close(4403, 'not a lobby participant'); return; }
      const disconnectTimer = disconnectTimers.get(disconnectTimerKey(matchId, authenticated.playerId));
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimers.delete(disconnectTimerKey(matchId, authenticated.playerId));
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
    if (!stillConnected) {
      const disconnected = await recordParticipantDisconnect(matchId, principal.playerId).catch(error => {
        if (process.env.NODE_ENV === 'test') process.stderr.write(`participant disconnect transition failed: ${(error as { code?: string }).code ?? 'unknown'} ${(error as Error).message}\n`);
        request.log.error({ code: (error as { code?: string }).code }, 'participant disconnect transition failed');
        return null;
      });
      if (disconnected?.paused) {
        const countdown = countdownTimers.get(matchId);
        if (countdown) clearTimeout(countdown);
        countdownTimers.delete(matchId);
        gpsObservations.delete(matchId);
        for (const key of automaticProximitySince.keys()) if (key.startsWith(`${matchId}:`)) automaticProximitySince.delete(key);
        scheduleHostDisconnectExpiry(matchId, disconnected.disconnectedAt);
      } else if (disconnected) scheduleDisconnectExpiry(matchId, principal.playerId, disconnected.disconnectedAt, false);
    }
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

app.addHook('onClose', async () => {
  for (const timer of countdownTimers.values()) clearTimeout(timer);
  countdownTimers.clear();
  for (const timer of disconnectTimers.values()) clearTimeout(timer);
  disconnectTimers.clear();
  for (const timer of hostDisconnectTimers.values()) clearTimeout(timer);
  hostDisconnectTimers.clear();
  await pool?.end();
});

if (import.meta.url === `file://${process.argv[1]}`) {
  if (pool) {
    const pending = await pool.query<{ id: string; countdown_ends_at: Date }>("SELECT id,countdown_ends_at FROM matches WHERE phase='countdown' AND countdown_ends_at IS NOT NULL");
    for (const match of pending.rows) scheduleCountdown(match.id, match.countdown_ends_at.getTime());
    const active = await pool.query<{ match_id: string; virtual_state: MatchRuntime }>(
      "SELECT DISTINCT ON (c.match_id) c.match_id,c.virtual_state FROM match_checkpoints c JOIN matches m ON m.id=c.match_id WHERE m.phase='active' ORDER BY c.match_id,c.revision DESC",
    );
    for (const match of active.rows) scheduleDeadline(match.match_id, match.virtual_state.deadlineAtMs);
    const disconnected = await pool.query<{ match_id: string; player_id: string; disconnected_at: Date; is_host: boolean }>(
      `SELECT p.match_id,p.player_id,p.disconnected_at,(p.player_id=m.host_player_id) AS is_host
         FROM participants p JOIN matches m ON m.id=p.match_id
        WHERE NOT p.connected AND p.disconnected_at IS NOT NULL AND m.phase IN ('lobby','countdown','active')`,
    );
    for (const participant of disconnected.rows) scheduleDisconnectExpiry(participant.match_id, participant.player_id, participant.disconnected_at, participant.is_host);
    const hostPaused = await pool.query<{ id: string; host_disconnected_at: Date }>(
      "SELECT id,host_disconnected_at FROM matches WHERE phase='paused' AND host_disconnected_at IS NOT NULL",
    );
    for (const match of hostPaused.rows) scheduleHostDisconnectExpiry(match.id, match.host_disconnected_at);
  }
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ port: PORT, databaseConfigured: Boolean(pool) }, 'HUNTZONE API listening');
}

export { app };
