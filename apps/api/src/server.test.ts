import { afterAll, describe, expect, it, vi } from 'vitest';

vi.stubEnv('DATABASE_URL', '');
const { app } = await import('./server');

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

describe('API without PostgreSQL', () => {
  it('reports unavailable instead of claiming a multiplayer service is ready', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'unavailable', reason: 'database-not-configured' });
  });

  it('does not issue guest identities when durable storage is unavailable', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/guest-sessions', payload: { displayName: 'Test Host' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.json()).not.toHaveProperty('token');
  });

  it('does not create or simulate lobbies without an authenticated stored session', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/lobbies',
      payload: { modeId: 'classic-hide-and-seek', playerCap: 3, radiusMeters: 500, durationSeconds: 1200, centerLatitude: 45.46, centerLongitude: 9.19 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.json()).not.toHaveProperty('players');
  });
});
