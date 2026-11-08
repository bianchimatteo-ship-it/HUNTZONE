import pg from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrate';

const { app } = await import('./server');
const { pool } = await import('./db');
const origin = 'http://localhost:5173';
let baseUrl = '';

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

describe.skipIf(!process.env.DATABASE_URL)('PostGIS-backed guest and lobby integration', () => {
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    await applyMigrations(pool!);
    await pool!.query('TRUNCATE matches, players, guest_sessions CASCADE');
    expect((await pool!.query<{ version: string }>('SELECT PostGIS_Version() AS version')).rows[0]?.version).toBeTruthy();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test API did not bind to a TCP port.');
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await app.close();
  });

  it('recovers cookie identity and lobby, synchronizes three real test clients, and deduplicates READY', async () => {
    const host = await createGuest('Host Player');
    const current = await app.inject({ method: 'GET', url: '/v1/guest-sessions/current', headers: { cookie: host.cookie, origin } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ session: { playerId: host.playerId, displayName: host.displayName }, match: null });

    const created = await app.inject({
      method: 'POST', url: '/v1/lobbies', headers: { cookie: host.cookie, origin },
      payload: { modeId: 'classic-hide-and-seek', playerCap: 3, radiusMeters: 500, durationSeconds: 1200, captureMethod: 'radius', centerLatitude: 45.46, centerLongitude: 9.19 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().areaCenter).toMatchObject({ latitude: 45.46, longitude: 9.19 });
    const match = created.json() as { matchId: string; inviteCode: string; revision: number };

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
        payload: { commandId: `ready-command-${index}`, expectedRevision: index + 2, ready: true },
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().snapshot.players.find((player: { id: string }) => player.id === guest.playerId).ready).toBe(true);
      if (index === 1) {
        const duplicate = await app.inject({
          method: 'POST', url: `/v1/matches/${match.matchId}/ready`, headers: { cookie: guest.cookie, origin },
          payload: { commandId: `ready-command-${index}`, expectedRevision: index + 2, ready: true },
        });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json().duplicate).toBe(true);
      }
    }

    const consentedGuests: Guest[] = [host, second, third];
    for (const [index, guest] of consentedGuests.entries()) {
      const consent = await app.inject({
        method: 'POST', url: `/v1/matches/${match.matchId}/location-consent`, headers: { cookie: guest.cookie, origin },
        payload: { commandId: `consent-command-${index}`, expectedRevision: 5 + index, granted: true },
      });
      expect(consent.statusCode).toBe(200);
      expect(consent.json().snapshot.gpsConsent).toBe(true);
    }
    for (const [index, guest] of consentedGuests.entries()) {
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
    const firstCapture = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/capture`, headers: { cookie: seekerGuest.cookie, origin },
      payload: { commandId: 'capture-command-001', expectedRevision: privateViews[0]!.revision, targetPlayerId: hiderIds[0] },
    });
    expect(firstCapture.statusCode).toBe(200);
    expect(firstCapture.json().result.capturedPlayerId).toBe(hiderIds[0]);
    expect(firstCapture.json().snapshot.players.find((player: { id: string }) => player.id === hiderIds[0]).status).toBe('captured');

    const outsider = await createGuest('Outside Player');
    const forbidden = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: outsider.cookie, origin } });
    expect(forbidden.statusCode).toBe(404);
    const secondHider = consentedGuests.find(guest => guest.playerId === hiderIds[1])!;
    const activeSnapshot = await app.inject({ method: 'GET', url: `/v1/matches/${match.matchId}`, headers: { cookie: secondHider.cookie, origin } });
    const revoked = await app.inject({
      method: 'POST', url: `/v1/matches/${match.matchId}/location-consent`, headers: { cookie: secondHider.cookie, origin },
      payload: { commandId: 'consent-withdraw-01', expectedRevision: activeSnapshot.json().revision, granted: false },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().snapshot).toMatchObject({ phase: 'cancelled', gpsConsent: false, gpsReady: false, virtualStatus: 'withdrawn', endReason: 'targets-withdrew' });
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
});
