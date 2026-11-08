import pg from 'pg';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrate';

const { app } = await import('./server');
const { pool } = await import('./db');
const origin = 'http://localhost:5173';
let baseUrl = '';
const fixturePlayerIds: string[] = [];
const fixtureMatchIds: string[] = [];

type Guest = { cookie: string; playerId: string; displayName: string };

async function createGuest(displayName: string): Promise<Guest> {
  const response = await app.inject({
    method: 'POST', url: '/v1/guest-sessions', headers: { origin }, payload: { displayName },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).not.toHaveProperty('token');
  const setCookie = response.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(header).toContain('HttpOnly');
  const cookie = String(header).split(';', 1)[0]!;
  fixturePlayerIds.push(response.json().playerId);
  return { cookie, playerId: response.json().playerId, displayName };
}

async function openSocket(matchId: string, guest: Guest) {
  const socket = new WebSocket(`${baseUrl}/v1/matches/${matchId}/stream`, { headers: { Origin: origin, Cookie: guest.cookie } });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'session.authenticate' }));
  const firstFrame = await new Promise<string>((resolve, reject) => {
    socket.once('message', data => resolve(data.toString()));
    socket.once('error', reject);
  });
  expect(JSON.parse(firstFrame).type).toBe('match.snapshot');
  return socket;
}

async function waitForMatch(matchId: string, predicate: (row: Record<string, unknown>) => boolean, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await pool!.query('SELECT phase,paused_from_phase,host_player_id,host_disconnected_at,revision FROM matches WHERE id=$1', [matchId]);
    if (result.rows[0] && predicate(result.rows[0])) return result.rows[0] as Record<string, unknown>;
    await delay(15);
  }
  throw new Error(`Timed out waiting for match state: ${matchId}`);
}

describe.skipIf(!process.env.DATABASE_URL)('PostGIS-backed guest and lobby integration', () => {
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    process.env.HUNTZONE_TEST_PARTICIPANT_GRACE_MS = '500';
    process.env.HUNTZONE_TEST_HOST_GRACE_MS = '1200';
    process.env.HUNTZONE_TEST_PIN_LIFETIME_MS = '5000';
    await applyMigrations(pool!);
    expect((await pool!.query<{ version: string }>('SELECT PostGIS_Version() AS version')).rows[0]?.version).toBeTruthy();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test API did not bind to a TCP port.');
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    const closing = sockets.filter(socket => socket.readyState < WebSocket.CLOSING).map(socket => new Promise<void>(resolve => {
      socket.once('close', () => resolve());
      socket.close();
    }));
    await Promise.all(closing);
    await delay(30);
    if (pool && fixtureMatchIds.length) await pool.query('DELETE FROM matches WHERE id=ANY($1::uuid[])', [fixtureMatchIds]);
    if (pool && fixturePlayerIds.length) {
      await pool.query('DELETE FROM guest_sessions WHERE player_id=ANY($1::uuid[])', [fixturePlayerIds]);
      await pool.query('DELETE FROM players WHERE id=ANY($1::uuid[])', [fixturePlayerIds]);
    }
    await app.close();
  });

  async function makeActiveMatch(captureMethod: 'radius' | 'pin' | 'automatic') {
    const guests = await Promise.all(['One', 'Two', 'Three'].map(name => createGuest(`${captureMethod}-${name}`)));
    const created = await app.inject({
      method: 'POST', url: '/v1/lobbies', headers: { cookie: guests[0]!.cookie, origin },
      payload: { modeId: 'classic-hide-and-seek', playerCap: 3, radiusMeters: 500, durationSeconds: 1200, captureMethod, centerLatitude: 45.46, centerLongitude: 9.19 },
    });
    expect(created.statusCode).toBe(201);
    const lobby = created.json() as { matchId: string; inviteCode: string };
    fixtureMatchIds.push(lobby.matchId);
    for (const guest of guests.slice(1)) {
      const joined = await app.inject({ method: 'POST', url: `/v1/lobbies/${lobby.inviteCode}/join`, headers: { cookie: guest.cookie, origin }, payload: {} });
      expect(joined.statusCode).toBe(200);
    }
    const matchSockets: WebSocket[] = [];
    for (const guest of guests) {
      const socket = await openSocket(lobby.matchId, guest);
      sockets.push(socket);
      matchSockets.push(socket);
    }
    let revision = 2;
    for (const guest of guests) {
      const ready = await app.inject({
        method: 'POST', url: `/v1/matches/${lobby.matchId}/ready`, headers: { cookie: guest.cookie, origin },
        payload: { commandId: `${captureMethod}-ready-${guest.playerId}`, expectedRevision: revision++, ready: true },
      });
      expect(ready.statusCode).toBe(200);
    }
    for (const guest of guests) {
      const consent = await app.inject({
        method: 'POST', url: `/v1/matches/${lobby.matchId}/location-consent`, headers: { cookie: guest.cookie, origin },
        payload: { commandId: `${captureMethod}-consent-${guest.playerId}`, expectedRevision: revision++, granted: true },
      });
      expect(consent.statusCode).toBe(200);
    }
    for (const [index, guest] of guests.entries()) {
      const gps = await app.inject({
        method: 'POST', url: `/v1/matches/${lobby.matchId}/location`, headers: { cookie: guest.cookie, origin },
        payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 1, timestampMs: Date.now() + index },
      });
      expect(gps.statusCode).toBe(200);
    }
    const started = await app.inject({
      method: 'POST', url: `/v1/matches/${lobby.matchId}/start`, headers: { cookie: guests[0]!.cookie, origin },
      payload: { commandId: `${captureMethod}-start-command`, expectedRevision: revision },
    });
    expect(started.statusCode).toBe(200);
    for (const guest of guests) {
      const gps = await app.inject({
        method: 'POST', url: `/v1/matches/${lobby.matchId}/location`, headers: { cookie: guest.cookie, origin },
        payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 2, timestampMs: Date.now() },
      });
      expect(gps.statusCode).toBe(200);
    }
    await pool!.query('UPDATE matches SET countdown_ends_at=clock_timestamp() WHERE id=$1', [lobby.matchId]);
    const views = [];
    for (const guest of guests) {
      const response = await app.inject({ method: 'GET', url: `/v1/matches/${lobby.matchId}`, headers: { cookie: guest.cookie, origin } });
      expect(response.statusCode).toBe(200);
      expect(response.json().phase).toBe('active');
      views.push(response.json());
    }
    await pool!.query("UPDATE match_checkpoints SET virtual_state=jsonb_set(virtual_state,'{captureAvailableAtMs}','0'::jsonb) WHERE match_id=$1 AND revision=(SELECT max(revision) FROM match_checkpoints WHERE match_id=$1)", [lobby.matchId]);
    for (const [index, guest] of guests.entries()) {
      const response = await app.inject({ method: 'GET', url: `/v1/matches/${lobby.matchId}`, headers: { cookie: guest.cookie, origin } });
      views[index] = response.json();
    }
    return { matchId: lobby.matchId, guests, views, matchSockets };
  }

  it('recovers cookie identity and lobby, synchronizes three real test clients, and deduplicates READY', async () => {
    const host = await createGuest('Host Player');
    const current = await app.inject({ method: 'GET', url: '/v1/guest-sessions/current', headers: { cookie: host.cookie, origin } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ session: { playerId: host.playerId, displayName: host.displayName }, match: null });
    const duplicateSession = await app.inject({
      method: 'POST', url: '/v1/guest-sessions', headers: { cookie: host.cookie, origin }, payload: { displayName: 'Ignored Name' },
    });
    expect(duplicateSession.statusCode).toBe(200);
    expect(duplicateSession.json()).toMatchObject({ playerId: host.playerId, displayName: host.displayName });

    const created = await app.inject({
      method: 'POST', url: '/v1/lobbies', headers: { cookie: host.cookie, origin },
      payload: { modeId: 'classic-hide-and-seek', playerCap: 3, radiusMeters: 500, durationSeconds: 1200, captureMethod: 'radius', centerLatitude: 45.46, centerLongitude: 9.19 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().areaCenter).toMatchObject({ latitude: 45.46, longitude: 9.19 });
    const match = created.json() as { matchId: string; inviteCode: string; revision: number };
    fixtureMatchIds.push(match.matchId);

    const futureMode = await app.inject({
      method: 'POST', url: '/v1/lobbies', headers: { cookie: host.cookie, origin },
      payload: { modeId: 'manhunt', playerCap: 3, radiusMeters: 500, durationSeconds: 1200, captureMethod: 'radius', centerLatitude: 45.46, centerLongitude: 9.19 },
    });
    expect(futureMode.statusCode).toBe(400);

    const second = await createGuest('Second Player');
    const third = await createGuest('Third Player');
    for (const guest of [second, third]) {
      const joined = await app.inject({
        method: 'POST', url: `/v1/lobbies/${match.inviteCode}/join`, headers: { cookie: guest.cookie, origin }, payload: {},
      });
      expect(joined.statusCode).toBe(200);
    }

    const restored = await app.inject({ method: 'GET', url: '/v1/guest-sessions/current', headers: { cookie: host.cookie, origin } });
    expect(restored.json().match.players).toHaveLength(3);
    expect(restored.json().match.matchId).toBe(match.matchId);

    for (const guest of [host, second, third]) sockets.push(await openSocket(match.matchId, guest));

    const nonHostStart = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/start`, headers: { cookie: second.cookie, origin },
      payload: { commandId: 'start-forbidden-01', expectedRevision: 2 },
    });
    expect(nonHostStart.statusCode).toBe(403);

    for (const [index, guest] of [host, second, third].entries()) {
      const ready = await app.inject({
        method: 'POST', url: `/v1/matches/${match.matchId}/ready`, headers: { cookie: guest.cookie, origin },
        payload: { commandId: `ready-command-${index}`, expectedRevision: 2, ready: true },
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().snapshot.players.find((player: { id: string }) => player.id === guest.playerId).ready).toBe(true);
      if (index === 1) {
        const duplicate = await app.inject({
          method: 'POST', url: `/v1/matches/${match.matchId}/ready`, headers: { cookie: guest.cookie, origin },
          payload: { commandId: `ready-command-${index}`, expectedRevision: 2, ready: true },
        });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json().duplicate).toBe(true);
      }
    }

    const consentedGuests: Guest[] = [host, second, third];
    const consentResults = await Promise.all(consentedGuests.map((guest, index) => app.inject({
        method: 'POST', url: `/v1/matches/${match.matchId}/location-consent`, headers: { cookie: guest.cookie, origin },
        payload: { commandId: `consent-command-${index}`, expectedRevision: 5, granted: true },
      })));
    for (const consent of consentResults) {
      expect(consent.statusCode).toBe(200);
      expect(consent.json().snapshot.gpsConsent).toBe(true);
    }
    for (const [index, guest] of consentedGuests.entries()) {
      if (index === 0) {
        const stale = await app.inject({
          method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: guest.cookie, origin },
          payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 1, timestampMs: Date.now() - 6000 },
        });
        expect(stale.statusCode).toBe(422);
        const future = await app.inject({
          method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: guest.cookie, origin },
          payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 1, timestampMs: Date.now() + 6000 },
        });
        expect(future.statusCode).toBe(422);
      }
      const gps = await app.inject({
        method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: guest.cookie, origin },
        payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 1, timestampMs: Date.now() + index },
      });
      expect(gps.statusCode).toBe(200);
      expect(gps.json()).toMatchObject({ status: 'GPS_READY', accuracyMeters: 5 });
      expect(JSON.stringify(gps.json())).not.toMatch(/latitude|longitude|45\.46|9\.19/);
    }

    const start = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/start`, headers: { cookie: host.cookie, origin },
      payload: { commandId: 'start-command-001', expectedRevision: 8 },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().snapshot.phase).toBe('countdown');
    for (const guest of consentedGuests) {
      const gps = await app.inject({
        method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: guest.cookie, origin },
        payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 2, timestampMs: Date.now() },
      });
      expect(gps.statusCode).toBe(200);
    }
    const replayed = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: host.cookie, origin },
      payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 2, timestampMs: Date.now() },
    });
    expect(replayed.statusCode).toBe(409);
    const storedSequence = await pool!.query<{ last_gps_sequence: string }>(
      'SELECT last_gps_sequence::text FROM participants WHERE match_id=$1 AND player_id=$2', [match.matchId, host.playerId],
    );
    expect(storedSequence.rows[0]?.last_gps_sequence).toBe('2');
    await pool!.query('UPDATE matches SET countdown_ends_at=clock_timestamp() WHERE id=$1', [match.matchId]);

    const privateViews = [];
    for (const guest of [host, second, third]) {
      const view = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: guest.cookie, origin } });
      expect(view.statusCode).toBe(200);
      expect(view.json().phase).toBe('active');
      expect(view.json().players.every((player: Record<string, unknown>) => !('roleId' in player))).toBe(true);
      expect(['seeker', 'hider']).toContain(view.json().roleId);
      privateViews.push(view.json());
    }
    expect(privateViews.filter(view => view.roleId === 'seeker')).toHaveLength(1);
    expect(privateViews.filter(view => view.roleId === 'hider')).toHaveLength(2);
    expect(privateViews.every(view => view.captureAvailableAt && view.deadlineAt)).toBe(true);
    await pool!.query("UPDATE match_checkpoints SET virtual_state=jsonb_set(virtual_state,'{captureAvailableAtMs}','0'::jsonb) WHERE match_id=$1 AND revision=(SELECT max(revision) FROM match_checkpoints WHERE match_id=$1)", [match.matchId]);
    const seekerView = privateViews.find(view => view.roleId === 'seeker')!;
    const seekerGuest = consentedGuests.find(guest => guest.playerId === seekerView.viewerPlayerId)!;
    const hiderIds = privateViews.filter(view => view.roleId === 'hider').map(view => view.viewerPlayerId);
    const unavailableHider = consentedGuests.find(guest => guest.playerId === hiderIds[0])!;
    const poorGps = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: unavailableHider.cookie, origin },
      payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 20, sequence: 3, timestampMs: Date.now() },
    });
    expect(poorGps.statusCode).toBe(422);
    const seekerCapability = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: seekerGuest.cookie, origin } });
    expect(seekerCapability.json().capabilities.capture).toBe(true);
    const firstCapture = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seekerGuest.cookie, origin },
      payload: { commandId: 'capture-command-001', expectedRevision: privateViews[0]!.revision, targetPlayerId: hiderIds[1] },
    });
    expect(firstCapture.statusCode).toBe(200);
    expect(firstCapture.json().result.capturedPlayerId).toBe(hiderIds[1]);
    expect(firstCapture.json().snapshot.players.find((player: { id: string }) => player.id === hiderIds[1]).status).toBe('captured');
    const capturedView = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: consentedGuests.find(guest => guest.playerId === hiderIds[1])!.cookie, origin } });
    expect(capturedView.json()).toMatchObject({ virtualStatus: 'captured', gpsConsent: false, gpsReady: false });
    const duplicateCapture = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seekerGuest.cookie, origin },
      payload: { commandId: 'capture-command-001', expectedRevision: privateViews[0]!.revision, targetPlayerId: hiderIds[1] },
    });
    expect(duplicateCapture.statusCode).toBe(200);
    expect(duplicateCapture.json().duplicate).toBe(true);

    const outsider = await createGuest('Outside Player');
    const forbidden = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: outsider.cookie, origin } });
    expect(forbidden.statusCode).toBe(404);
    const secondHider = unavailableHider;
    const activeSnapshot = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: secondHider.cookie, origin } });
    const revoked = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location-consent`, headers: { cookie: secondHider.cookie, origin },
      payload: { commandId: 'consent-withdraw-01', expectedRevision: activeSnapshot.json().revision, granted: false },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().snapshot).toMatchObject({ phase: 'cancelled', gpsConsent: false, gpsReady: false, virtualStatus: 'withdrawn', endReason: 'targets-withdrew' });
    const recoveredResult = await app.inject({ method: 'GET', url: '/v1/guest-sessions/current', headers: { cookie: host.cookie, origin } });
    expect(recoveredResult.json().match).toMatchObject({ matchId: match.matchId, phase: 'cancelled', endReason: 'targets-withdrew' });
    const storedRuntime = await pool!.query<{ virtual_state: { players: Array<{ playerId: string; status: string }> } }>(
      'SELECT virtual_state FROM match_checkpoints WHERE match_id=$1 ORDER BY revision DESC LIMIT 1', [match.matchId],
    );
    expect(storedRuntime.rows[0]?.virtual_state.players.find(player => player.playerId === secondHider.playerId)?.status).toBe('withdrawn');
    const privateData = await pool!.query<{ data: string }>(
      `SELECT COALESCE(string_agg(payload::text || COALESCE(virtual_state::text,''),''),'') AS data
         FROM match_events e LEFT JOIN match_checkpoints c ON c.match_id=e.match_id AND c.revision=e.revision WHERE e.match_id=$1`, [match.matchId],
    );
    expect(privateData.rows[0]?.data).not.toMatch(/45\.46|9\.19/);
    const events = await pool!.query<{ event_type: string }>('SELECT event_type FROM match_events WHERE match_id=$1 ORDER BY revision', [match.matchId]);
    expect(events.rows.map(row => row.event_type)).toEqual(['lobby.created', 'player.joined', 'player.joined', 'player.ready-changed', 'player.ready-changed', 'player.ready-changed', 'gps.consent-granted', 'gps.consent-granted', 'gps.consent-granted', 'start.countdown', 'match.started', 'player.captured', 'player.withdrew']);
  });

  it('transfers host on voluntary lobby exit and restricts cancellation to the new host', async () => {
    const guests = await Promise.all(['Host', 'Member', 'Leaving'].map(name => createGuest(`Exit ${name}`)));
    const created = await app.inject({
      method: 'POST', url: '/v1/lobbies', headers: { cookie: guests[0]!.cookie, origin },
      payload: { modeId: 'classic-hide-and-seek', playerCap: 3, radiusMeters: 500, durationSeconds: 1200, centerLatitude: 45.46, centerLongitude: 9.19 },
    });
    expect(created.statusCode).toBe(201);
    const lobby = created.json() as { matchId: string; inviteCode: string };
    fixtureMatchIds.push(lobby.matchId);
    for (const guest of guests.slice(1)) {
      const joined = await app.inject({ method: 'POST', url: `/v1/lobbies/${lobby.inviteCode}/join`, headers: { cookie: guest.cookie, origin }, payload: {} });
      expect(joined.statusCode).toBe(200);
    }
    for (const guest of guests) sockets.push(await openSocket(lobby.matchId, guest));
    const hostExit = await app.inject({
      method: 'POST', url: `/v1/matches/${lobby.matchId}/leave`, headers: { cookie: guests[0]!.cookie, origin },
      payload: { commandId: 'host-leaves-lobby-01', expectedRevision: 2 },
    });
    expect(hostExit.statusCode).toBe(200);
    expect(hostExit.json()).toMatchObject({ hostPlayerId: guests[1]!.playerId, removedFromLobby: true, phase: 'lobby' });
    const newHostSession = await app.inject({ method: 'GET', url: '/v1/guest-sessions/current', headers: { cookie: guests[1]!.cookie, origin } });
    expect(newHostSession.json().match).toMatchObject({ hostPlayerId: guests[1]!.playerId, isHost: true, players: [{ id: guests[1]!.playerId }, { id: guests[2]!.playerId }] });
    const oldHostCancel = await app.inject({
      method: 'POST', url: `/v1/matches/${lobby.matchId}/cancel`, headers: { cookie: guests[0]!.cookie, origin },
      payload: { commandId: 'old-host-cancel-01', expectedRevision: 3 },
    });
    expect(oldHostCancel.statusCode).toBe(403);
    const guestExit = await app.inject({
      method: 'POST', url: `/v1/matches/${lobby.matchId}/leave`, headers: { cookie: guests[2]!.cookie, origin },
      payload: { commandId: 'guest-leaves-lobby-01', expectedRevision: 3 },
    });
    expect(guestExit.statusCode).toBe(200);
    const cancelled = await app.inject({
      method: 'POST', url: `/v1/matches/${lobby.matchId}/cancel`, headers: { cookie: guests[1]!.cookie, origin },
      payload: { commandId: 'new-host-cancels-01', expectedRevision: 4 },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().snapshot).toMatchObject({ phase: 'cancelled' });
    const resultRestore = await app.inject({ method: 'GET', url: '/v1/guest-sessions/current', headers: { cookie: guests[1]!.cookie, origin } });
    expect(resultRestore.json().match).toMatchObject({ matchId: lobby.matchId, phase: 'cancelled' });
  });

  it('pauses active play on host disconnect, transfers control, resumes fairly and restores roles', async () => {
    const match = await makeActiveMatch('radius');
    const oldHost = match.guests[0]!;
    const oldHostSocket = match.matchSockets[0]!;
    const priorHostView = match.views.find(view => view.viewerPlayerId === oldHost.playerId)!;
    const closed = new Promise<void>(resolve => oldHostSocket.once('close', () => resolve()));
    oldHostSocket.close();
    await closed;
    const paused = await waitForMatch(match.matchId, row => row.phase === 'paused');
    expect(paused.paused_from_phase).toBe('active');
    expect(paused.host_player_id).toBe(match.guests[1]!.playerId);
    const newHost = match.guests[1]!;
    const pausedView = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: newHost.cookie, origin } });
    expect(pausedView.json()).toMatchObject({ phase: 'paused', roleId: match.views.find(view => view.viewerPlayerId === newHost.playerId)!.roleId, capabilities: { gameplay: false, capture: false } });
    expect(pausedView.json().gpsReady).toBe(false);
    const forbiddenResume = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/resume`, headers: { cookie: oldHost.cookie, origin },
      payload: { commandId: 'old-host-resume-001', expectedRevision: Number(paused.revision) },
    });
    expect(forbiddenResume.statusCode).toBe(403);
    const resumed = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/resume`, headers: { cookie: newHost.cookie, origin },
      payload: { commandId: 'new-host-resume-001', expectedRevision: Number(paused.revision) },
    });
    expect(resumed.statusCode, JSON.stringify(resumed.json())).toBe(200);
    expect(resumed.json().snapshot).toMatchObject({ phase: 'active', hostPlayerId: newHost.playerId, roleId: match.views.find(view => view.viewerPlayerId === newHost.playerId)!.roleId, gpsReady: false });
    expect(Date.parse(resumed.json().snapshot.deadlineAt)).toBeGreaterThanOrEqual(Date.parse(priorHostView.deadlineAt));
    expect((await pool!.query('SELECT phase,host_disconnected_at FROM matches WHERE id=$1', [match.matchId])).rows[0]).toMatchObject({ phase: 'active', host_disconnected_at: null });
    const restoredOldHost = await openSocket(match.matchId, oldHost);
    sockets.push(restoredOldHost);
    const restored = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: oldHost.cookie, origin } });
    expect(restored.json()).toMatchObject({ phase: 'active', roleId: priorHostView.roleId, virtualStatus: 'active' });
  });

  it('cancels a host-paused match without a winner when no host resumes inside the grace period', async () => {
    const match = await makeActiveMatch('radius');
    const hostSocket = match.matchSockets[0]!;
    const closed = new Promise<void>(resolve => hostSocket.once('close', () => resolve()));
    hostSocket.close();
    await closed;
    await waitForMatch(match.matchId, row => row.phase === 'paused');
    const cancelled = await waitForMatch(match.matchId, row => row.phase === 'cancelled', 2500);
    expect(cancelled.phase).toBe('cancelled');
    const result = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: match.guests[1]!.cookie, origin } });
    expect(result.json()).toMatchObject({ phase: 'cancelled', winner: null, endReason: 'host-disconnected' });
  });

  it('keeps a disconnected participant during grace, restores them on reconnect, then withdraws without capture', async () => {
    const match = await makeActiveMatch('radius');
    const hiderView = match.views.find(view => view.roleId === 'hider' && view.viewerPlayerId !== match.guests[0]!.playerId)!;
    const guest = match.guests.find(item => item.playerId === hiderView.viewerPlayerId)!;
    const index = match.guests.findIndex(item => item.playerId === guest.playerId);
    const oldSocket = match.matchSockets[index]!;
    const closed = new Promise<void>(resolve => oldSocket.once('close', () => resolve()));
    oldSocket.close();
    await closed;
    await delay(100);
    const duringGrace = await pool!.query('SELECT connected,virtual_status FROM participants WHERE match_id=$1 AND player_id=$2', [match.matchId, guest.playerId]);
    expect(duringGrace.rows[0]).toMatchObject({ connected: false, virtual_status: 'active' });
    const reconnected = await openSocket(match.matchId, guest);
    sockets.push(reconnected);
    const afterReconnect = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: guest.cookie, origin } });
    expect(afterReconnect.json()).toMatchObject({ phase: 'active', virtualStatus: 'active' });
    const secondClosed = new Promise<void>(resolve => reconnected.once('close', () => resolve()));
    reconnected.close();
    await secondClosed;
    const end = Date.now() + 1500;
    let status: string | undefined;
    while (Date.now() < end) {
      const query = await pool!.query<{ virtual_status: string }>('SELECT virtual_status FROM participants WHERE match_id=$1 AND player_id=$2', [match.matchId, guest.playerId]);
      status = query.rows[0]?.virtual_status;
      if (status === 'withdrawn') break;
      await delay(20);
    }
    expect(status).toBe('withdrawn');
    const events = await pool!.query<{ event_type: string; payload: { targetPlayerId?: string } }>('SELECT event_type,payload FROM match_events WHERE match_id=$1', [match.matchId]);
    expect(events.rows.some(event => event.event_type === 'player.captured' && event.payload.targetPlayerId === guest.playerId)).toBe(false);
  });

  it('verifies PIN capture only after fresh, accurate proximity, preserves PIN after reconnect, and locks exhausted attempts', async () => {
    const match = await makeActiveMatch('pin');
    const seekerView = match.views.find(view => view.roleId === 'seeker')!;
    const seeker = match.guests.find(guest => guest.playerId === seekerView.viewerPlayerId)!;
    const hiderViews = match.views.filter(view => view.roleId === 'hider');
    const reconnectView = hiderViews.find(view => view.viewerPlayerId !== match.guests[0]!.playerId) ?? hiderViews[0]!;
    const secondHiderView = hiderViews.find(view => view.viewerPlayerId !== reconnectView.viewerPlayerId)!;
    const firstHiderId = reconnectView.viewerPlayerId;
    const secondHiderId = secondHiderView.viewerPlayerId;
    const firstHider = match.guests.find(guest => guest.playerId === firstHiderId)!;
    const secondHider = match.guests.find(guest => guest.playerId === secondHiderId)!;
    const firstPin = reconnectView.capturePin as string;
    const secondPin = secondHiderView.capturePin as string;
    expect(firstPin).toMatch(/^\d{6}$/);
    expect(seekerView).not.toHaveProperty('capturePin');
    expect(hiderViews[0]).not.toHaveProperty('captureTargets');
    expect(firstPin).not.toBe(secondPin);

    const reconnectIndex = match.guests.findIndex(guest => guest.playerId === firstHiderId);
    const oldSocket = match.matchSockets[reconnectIndex]!;
    const closed = new Promise<void>(resolve => oldSocket.once('close', () => resolve()));
    oldSocket.close();
    await closed;
    const newSocket = await openSocket(match.matchId, firstHider);
    sockets.push(newSocket);
    const reconnectedView = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: firstHider.cookie, origin } });
    expect(reconnectedView.json().capturePin).toBe(firstPin);

    const wrongSecondPin = secondPin === '999999' ? '000000' : '999999';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
        payload: { commandId: `pin-lock-${attempt}-001`, expectedRevision: seekerView.revision, targetPlayerId: secondHiderId, pin: wrongSecondPin },
      });
      expect(response.statusCode).toBe(attempt === 2 ? 429 : 422);
    }
    const lockedAttempt = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
      payload: { commandId: 'pin-lock-final-001', expectedRevision: seekerView.revision, targetPlayerId: secondHiderId, pin: secondPin },
    });
    expect(lockedAttempt.statusCode).toBe(429);

    const poorGps = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: firstHider.cookie, origin },
      payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 20, sequence: 3, timestampMs: Date.now() },
    });
    expect(poorGps.statusCode).toBe(422);
    const beforeGps = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
      payload: { commandId: 'pin-no-gps-001', expectedRevision: seekerView.revision, targetPlayerId: firstHiderId, pin: firstPin },
    });
    expect(beforeGps.statusCode).toBe(422);

    const targetGps = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: firstHider.cookie, origin },
      payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 4, timestampMs: Date.now() },
    });
    expect(targetGps.statusCode).toBe(200);
    const distantSeekerGps = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: seeker.cookie, origin },
      payload: { latitude: 45.4603, longitude: 9.19, accuracyMeters: 5, sequence: 3, timestampMs: Date.now() },
    });
    expect(distantSeekerGps.statusCode).toBe(200);
    const outsideRange = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
      payload: { commandId: 'pin-distance-001', expectedRevision: seekerView.revision, targetPlayerId: firstHiderId, pin: firstPin },
    });
    expect(outsideRange.statusCode).toBe(422);

    const seekerGps = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: seeker.cookie, origin },
      payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: 4, timestampMs: Date.now() },
    });
    expect(seekerGps.statusCode).toBe(200);
    const wrongFirstPin = firstPin === '999999' ? '000000' : '999999';
    const wrong = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
      payload: { commandId: 'pin-wrong-001', expectedRevision: seekerView.revision, targetPlayerId: firstHiderId, pin: wrongFirstPin },
    });
    expect(wrong.statusCode).toBe(422);
    const correct = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
      payload: { commandId: 'pin-correct-001', expectedRevision: seekerView.revision, targetPlayerId: firstHiderId, pin: firstPin },
    });
    expect(correct.statusCode).toBe(200);
    expect(correct.json().result.capturedPlayerId).toBe(firstHiderId);
    expect(correct.json().snapshot.players.find((player: { id: string }) => player.id === firstHiderId).status).toBe('captured');
    const reused = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seeker.cookie, origin },
      payload: { commandId: 'pin-reuse-attempt-01', expectedRevision: correct.json().revision, targetPlayerId: firstHiderId, pin: firstPin },
    });
    expect([403, 422]).toContain(reused.statusCode);
  });

  it('regenerates an expired PIN only in the owning hider snapshot', async () => {
    const match = await makeActiveMatch('pin');
    const hiderView = match.views.find(view => view.roleId === 'hider')!;
    const guest = match.guests.find(item => item.playerId === hiderView.viewerPlayerId)!;
    const oldPin = hiderView.capturePin as string;
    await delay(5100);
    const renewed = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: guest.cookie, origin } });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().capturePin).toMatch(/^\d{6}$/);
    expect(renewed.json().capturePin).not.toBe(oldPin);
    const other = match.guests.find(item => item.playerId !== guest.playerId)!;
    const otherView = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: other.cookie, origin } });
    if (otherView.json().roleId === 'seeker') expect(otherView.json()).not.toHaveProperty('capturePin');
    else expect(otherView.json().capturePin).not.toBe(renewed.json().capturePin);
  }, 12_000);

  it('resolves automatic capture after continuous monotonic proximity and withdraws the captured player GPS consent', async () => {
    const match = await makeActiveMatch('automatic');
    const seekerView = match.views.find(view => view.roleId === 'seeker')!;
    const seeker = match.guests.find(guest => guest.playerId === seekerView.viewerPlayerId)!;
    let resolved = false;
    for (let tick = 0; tick < 9 && !resolved; tick += 1) {
      for (const [index, guest] of match.guests.entries()) {
        const response = await app.inject({
          method: 'POST', url: `/v1/matches/${match.matchId}/location`, headers: { cookie: guest.cookie, origin },
          payload: { latitude: 45.46, longitude: 9.19, accuracyMeters: 5, sequence: tick + 3, timestampMs: Date.now() + index },
        });
        if (response.statusCode === 409 && response.json().error?.code === 'GPS_SAMPLE_REJECTED') continue;
        expect(response.statusCode).toBe(200);
        if (response.json().captureResolved) { resolved = true; break; }
      }
      if (!resolved) await new Promise(resolve => setTimeout(resolve, 700));
    }
    expect(resolved).toBe(true);
    const updated = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: seeker.cookie, origin } });
    expect(updated.json().players.filter((player: { status: string }) => player.status === 'captured')).toHaveLength(1);
    const target = match.guests.find(guest => guest.playerId === updated.json().players.find((player: { status: string }) => player.status === 'captured').id)!;
    const spectator = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: target.cookie, origin } });
    expect(spectator.json()).toMatchObject({ virtualStatus: 'captured', gpsConsent: false, gpsReady: false });
  }, 20_000);
});
