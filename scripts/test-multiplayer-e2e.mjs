import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import pg from 'pg';

const mode = process.env.HUNTZONE_PREVIEW_MODE ?? '';
const baseUrl = process.env.HUNTZONE_E2E_URL ?? `http://127.0.0.1:4180${mode === 'github-pages' ? '/HUNTZONE/' : '/'}`;
const origin = new URL(baseUrl).origin;
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = process.env.HUNTZONE_E2E_URL ? null : spawn('npm', [
  'run', 'preview', ...(mode ? ['--', '--mode', mode] : ['--']), '--host', '127.0.0.1', '--port', '4180', '--strictPort',
], { stdio: 'ignore' });
const localApi = process.env.HUNTZONE_E2E_ALLOW_ONLINE === '1'
  && Boolean(process.env.DATABASE_URL)
  && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.VITE_API_BASE_URL ?? 'http://invalid').hostname);
const captureMethods = (process.env.HUNTZONE_E2E_CAPTURE_METHODS ?? 'radius,pin,automatic').split(',').map(value => value.trim()).filter(Boolean);
const fixturePlayerIds = new Set();
const fixtureMatchIds = new Set();
const browserErrors = [];
const browserDiagnostics = [];
let browser;
let database;

function assert(value, message) { if (!value) throw new Error(message); }

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* Preview still starting. */ }
    await delay(200);
  }
  throw new Error(`Preview did not start at ${baseUrl}`);
}

async function trackFixture(page) {
  const restored = await page.evaluate(async apiBase => {
    const response = await fetch(`${apiBase}/v1/guest-sessions/current`, { credentials: 'include' });
    return response.ok ? response.json() : null;
  }, process.env.VITE_API_BASE_URL);
  if (restored?.session?.playerId) fixturePlayerIds.add(restored.session.playerId);
  if (restored?.match?.matchId) fixtureMatchIds.add(restored.match.matchId);
  return { playerId: restored?.session?.playerId, match: restored?.match ?? null };
}

async function createOnlineLobby(context, name, captureMethod) {
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserDiagnostics.push(message.text()); });
  page.on('requestfailed', request => browserDiagnostics.push(`${request.url()} :: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) browserDiagnostics.push(`HTTP ${response.status()} ${response.url()}`); });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.online-service--ready').waitFor({ timeout: 15_000 });
  const hostForm = page.locator('.online-card').first();
  await hostForm.getByLabel('Il tuo nome').fill(name);
  await hostForm.getByLabel(/Campo · metri/i).fill('3000');
  await hostForm.getByLabel('Sistema di cattura').selectOption(captureMethod);
  const canvas = page.locator('.maplibregl-canvas').first();
  await canvas.waitFor({ timeout: 20_000 });
  const bounds = await canvas.boundingBox();
  assert(bounds, 'Interactive map canvas was not measurable.');
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  const create = hostForm.getByRole('button', { name: /CREA LOBBY REALE/i });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('CREA LOBBY REALE'));
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 30_000 });
  await create.click();
  await page.locator('.online-lobby').waitFor({ timeout: 15_000 });
  return page;
}

async function joinLobby(context, name, code) {
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserDiagnostics.push(message.text()); });
  page.on('requestfailed', request => browserDiagnostics.push(`${request.url()} :: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) browserDiagnostics.push(`HTTP ${response.status()} ${response.url()}`); });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.online-service--ready').waitFor({ timeout: 15_000 });
  const form = page.locator('.online-card').nth(1);
  await form.getByLabel('Il tuo nome').fill(name);
  await form.getByLabel('Codice invito').fill(code);
  await form.getByRole('button', { name: /UNISCITI ALLA LOBBY/i }).click();
  await page.locator('.online-lobby').waitFor({ timeout: 15_000 });
  return page;
}

async function enableTestLocation(context, center, offset) {
  await context.grantPermissions(['geolocation'], { origin });
  await context.setGeolocation({
    latitude: center.latitude + offset * 0.000001,
    longitude: center.longitude,
    accuracy: 5,
  });
}

async function installTestLocationPulse(context) {
  await context.addInitScript(() => {
    const native = navigator.geolocation;
    const pulseIds = new Set();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: native.getCurrentPosition.bind(native),
        watchPosition(success, failure, options) {
          const sample = () => native.getCurrentPosition(position => success({
            coords: position.coords,
            timestamp: Date.now(),
          }), failure, { ...options, maximumAge: 0 });
          sample();
          const id = window.setInterval(sample, 800);
          pulseIds.add(id);
          return id;
        },
        clearWatch(id) {
          window.clearInterval(id);
          pulseIds.delete(id);
        },
      },
    });
  });
}

function startLocationPulse(clients, center) {
  let running = true;
  let sequence = 0;
  const work = (async () => {
    while (running) {
      await Promise.all(clients.map(({ context }) => context.setGeolocation({
        latitude: center.latitude + sequence * 0.00005,
        longitude: center.longitude,
        accuracy: 5,
      })));
      sequence += 1;
      await delay(900);
    }
  })();
  return async () => { running = false; await work; };
}

async function runGameplayScenario(method) {
  const clients = [];
  for (let index = 0; index < 3; index += 1) {
    const context = await browser.newContext({
      viewport: index === 0 ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
    });
    await installTestLocationPulse(context);
    clients.push({ context, page: null, name: `E2E ${method} ${index + 1}`, playerId: null });
  }
  let stopGps = null;
  try {
    const host = clients[0];
    host.page = await createOnlineLobby(host.context, host.name, method);
    const hostFixture = await trackFixture(host.page);
    host.playerId = hostFixture.playerId;
    const center = hostFixture.match?.areaCenter;
    assert(center && hostFixture.match?.matchId, `${method}: created lobby fixture was not recoverable.`);
    const matchId = hostFixture.match.matchId;
    const code = await host.page.locator('.online-invite strong').innerText();

    await enableTestLocation(host.context, center, 0);
    clients[1].page = await joinLobby(clients[1].context, clients[1].name, code);
    clients[2].page = await joinLobby(clients[2].context, clients[2].name, code);
    for (const client of clients.slice(1)) {
      const fixture = await trackFixture(client.page);
      client.playerId = fixture.playerId;
      assert(fixture.match?.matchId === matchId, `${method}: joined client restored a different match.`);
    }
    await Promise.all(clients.slice(1).map((client, index) => enableTestLocation(client.context, center, index + 1)));
    await host.page.getByText(clients[1].name).waitFor({ timeout: 10_000 });
    await host.page.getByText(clients[2].name).waitFor({ timeout: 10_000 });

    // Exercise cookie-backed WebSocket recovery before starting the match.
    const guestRow = host.page.locator('.online-roster li').filter({ hasText: clients[1].name });
    await clients[1].page.close();
    await guestRow.getByText('RICONNESSIONE').waitFor({ timeout: 10_000 });
    clients[1].page = await clients[1].context.newPage();
    clients[1].page.on('pageerror', error => browserErrors.push(error.message));
    clients[1].page.on('console', message => { if (message.type() === 'error') browserDiagnostics.push(message.text()); });
    clients[1].page.on('requestfailed', request => browserDiagnostics.push(`${request.url()} :: ${request.failure()?.errorText}`));
    clients[1].page.on('response', response => { if (response.status() >= 400) browserDiagnostics.push(`HTTP ${response.status()} ${response.url()}`); });
    await clients[1].page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await clients[1].page.locator('.online-lobby').waitFor({ timeout: 15_000 });
    await host.page.waitForFunction(name => [...document.querySelectorAll('.online-roster li')]
      .some(row => row.textContent?.includes(name) && row.getAttribute('data-connected') === 'true'), clients[1].name, { timeout: 15_000 });

    await Promise.all(clients.map(async client => {
      await client.page.getByRole('button', { name: /CONFERMA READY/i }).click();
      await client.page.getByRole('button', { name: /ANNULLA READY/i }).waitFor({ timeout: 10_000 });
    }));
    stopGps = startLocationPulse(clients, center);
    await Promise.all(clients.map(async client => {
      await client.page.getByRole('button', { name: /CONSENTI GPS E PREPARA/i }).click();
      await client.page.getByRole('button', { name: /REVOCA GPS E FERMA/i }).waitFor({ timeout: 10_000 });
    }));
    try {
      await Promise.all(clients.map(client => client.page.getByText(/GPS verificato dal server/i).waitFor({ timeout: 15_000 })));
    } catch (error) {
      const states = await Promise.all(clients.map(async client => ({
        name: client.name,
        text: await client.page.locator('.online-card').first().innerText(),
        gpsSequence: await client.page.evaluate(id => localStorage.getItem(`huntzone-gps-sequence:${id}`), matchId),
        snapshot: await client.page.evaluate(async ({ apiBase, matchId }) => fetch(`${apiBase}/v1/matches/${matchId}`, { credentials: 'include' }).then(response => response.ok ? response.json() : { status: response.status }), { apiBase: process.env.VITE_API_BASE_URL, matchId }),
      })));
      throw new Error(`GPS verification timed out: ${JSON.stringify(states)}`, { cause: error });
    }
    const startButton = host.page.getByRole('button', { name: /AVVIA CLASSIC/i });
    await startButton.waitFor({ state: 'visible' });
    try {
      await host.page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('AVVIA CLASSIC'));
        return button instanceof HTMLButtonElement && !button.disabled;
      }, null, { timeout: 15_000 });
    } catch (error) {
      const state = await host.page.evaluate(async ({ diagnostics, apiBase, matchId }) => ({
        lobby: document.querySelector('.online-card')?.innerText,
        startDisabled: [...document.querySelectorAll('button')].find(item => item.textContent?.includes('AVVIA CLASSIC'))?.disabled,
        mapState: document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state'),
        mapDiagnostic: document.querySelector('.stadia-map-shell')?.getAttribute('data-map-diagnostic'),
        mapSupportDetail: document.querySelector('.map-diagnostics code')?.textContent,
        mapText: [...document.querySelectorAll('.map-status, [role="status"]')].map(item => item.textContent),
        diagnostics,
        snapshot: await fetch(`${apiBase}/v1/matches/${matchId}`, { credentials: 'include' }).then(response => response.ok ? response.json() : { status: response.status }),
        gpsSequence: localStorage.getItem(`huntzone-gps-sequence:${matchId}`),
      }), { diagnostics: browserDiagnostics.slice(-20), apiBase: process.env.VITE_API_BASE_URL, matchId });
      throw new Error(`${method}: start button remained disabled. UI state: ${JSON.stringify(state)}`, { cause: error });
    }
    await startButton.click();
    await host.page.getByText(/PARTENZA TRA/i).waitFor({ timeout: 5_000 });

    const activeClients = await Promise.all(clients.map(async client => {
      await client.page.getByText(/Il tuo ruolo: (SEEKER|HIDER)/i).waitFor({ timeout: 15_000 });
      return /Il tuo ruolo: SEEKER/i.test(await client.page.locator('.online-card').first().innerText());
    }));
    assert(activeClients.filter(Boolean).length === 1, `${method}: server must assign one private seeker role and two hider roles.`);
    for (const client of clients) {
      const roster = await client.page.locator('.online-roster').innerText();
      assert(!/Il tuo ruolo|SEEKER|HIDER/.test(roster), `${method}: private role appeared in the public roster.`);
    }
    const hiders = clients.filter((_, index) => !activeClients[index]);
    await hiders[0].page.getByText(/Vantaggio HIDER:/i).waitFor({ timeout: 4_000 });

    const capturedIds = new Set();
    if (method === 'automatic') {
      for (const hider of hiders) {
        await hider.page.getByText(/SEI FUORI DAL GIOCO · SPETTATORE|VITTORIA: SEEKER/i).waitFor({ timeout: 15_000 });
        const state = await database.query(
          'SELECT virtual_status FROM participants WHERE match_id=$1 AND player_id=$2', [matchId, hider.playerId],
        );
        assert(state.rows[0]?.virtual_status === 'captured', `${method}: spectator must correspond to a server capture.`);
        capturedIds.add(hider.playerId);
      }
    } else {
      const seeker = clients.find((_, index) => activeClients[index]);
      assert(seeker, `${method}: seeker client missing.`);
      while (capturedIds.size < hiders.length) {
        const targetSelect = seeker.page.getByLabel('BERSAGLIO');
        await targetSelect.waitFor({ timeout: 10_000 });
        const options = targetSelect.locator('option');
        let targetId = '';
        for (let option = 1; option < await options.count(); option += 1) {
          const candidateId = await options.nth(option).getAttribute('value');
          if (candidateId && !capturedIds.has(candidateId)) { targetId = candidateId; break; }
        }
        assert(targetId, `${method}: no eligible HIDER target was offered by the server.`);
        await targetSelect.selectOption(targetId);
        const target = hiders.find(client => client.playerId === targetId);
        assert(target, `${method}: selected target was not one of the two human HIDER clients.`);
        if (method === 'pin') {
          const pin = await target.page.locator('.online-dev-note').filter({ hasText: 'PIN personale' }).locator('strong').innerText();
          await seeker.page.getByLabel('PIN TEMPORANEO').fill(pin);
        }
        await seeker.page.getByRole('button', { name: /VERIFICA CATTURA GPS/i }).click();
        try {
          await target.page.getByText(/SEI FUORI DAL GIOCO · SPETTATORE|VITTORIA: SEEKER/i).waitFor({ timeout: 12_000 });
        } catch (error) {
          const state = await Promise.all([seeker, target].map(async client => ({
            name: client.name,
            text: await client.page.locator('.online-card').first().innerText(),
            snapshot: await client.page.evaluate(async ({ apiBase, matchId }) => fetch(`${apiBase}/v1/matches/${matchId}`, { credentials: 'include' }).then(response => response.ok ? response.json() : { status: response.status }), { apiBase: process.env.VITE_API_BASE_URL, matchId }),
            diagnostics: browserDiagnostics.slice(-20),
          })));
          throw new Error(`${method}: capture did not reach spectator state: ${JSON.stringify(state)}`, { cause: error });
        }
        const targetStatus = await database.query(
          'SELECT virtual_status FROM participants WHERE match_id=$1 AND player_id=$2', [matchId, targetId],
        );
        assert(targetStatus.rows[0]?.virtual_status === 'captured', `${method}: spectator/result must correspond to a server capture.`);
        capturedIds.add(targetId);
      }
    }

    for (const client of clients) await client.page.getByText(/VITTORIA: SEEKER/i).waitFor({ timeout: 15_000 });
    const status = await database.query(
      `SELECT m.phase,c.virtual_state->>'winner' AS winner FROM matches m
        JOIN LATERAL (SELECT virtual_state FROM match_checkpoints WHERE match_id=m.id ORDER BY revision DESC LIMIT 1) c ON true
       WHERE m.id=$1`, [matchId],
    );
    assert(status.rows[0]?.phase === 'completed' && status.rows[0]?.winner === 'seeker', `${method}: authoritative result did not complete as expected.`);
    for (const client of clients) {
      await client.page.reload({ waitUntil: 'domcontentloaded' });
      await client.page.getByText(/VITTORIA: SEEKER/i).waitFor({ timeout: 15_000 });
    }
    return `${method}: PASS (three clients, private roles, GPS consent, countdown, gameplay, capture, spectator, win and result restore)`;
  } finally {
    if (stopGps) await stopGps();
    await Promise.all(clients.map(client => client.context.close()));
  }
}

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Il campo è/i }).waitFor();
  await page.getByText('NESSUN BOT', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const state = document.querySelector('.online-service');
    return state?.classList.contains('online-service--ready')
      || state?.classList.contains('online-service--unavailable')
      || state?.classList.contains('online-service--unconfigured');
  }, null, { timeout: 15_000 });

  const serviceStatus = await page.locator('.online-service').innerText();
  const responsive = [];
  for (const width of [320, 360, 375, 390, 412, 430, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({ width: window.innerWidth, pageWidth: document.documentElement.scrollWidth }));
    assert(metrics.pageWidth <= metrics.width, `Horizontal overflow at ${width}px.`);
    responsive.push(width);
  }

  let liveClients = 'SKIPPED: local PostgreSQL-backed API is not configured';
  if (localApi) {
    await page.waitForFunction(() => document.querySelector('.online-service')?.classList.contains('online-service--ready'), null, { timeout: 15_000 });
    database = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    const results = [];
    for (const method of captureMethods) {
      assert(['radius', 'pin', 'automatic'].includes(method), `Unsupported E2E capture method: ${method}`);
      results.push(await runGameplayScenario(method));
    }
    liveClients = results.join('; ');
  } else {
    assert(await page.getByRole('button', { name: /CREA LOBBY REALE/i }).isDisabled(), 'Lobby creation must be disabled while multiplayer service is unavailable.');
    assert(await page.locator('.online-roster').count() === 0, 'Offline UI must not invent a lobby roster.');
  }

  assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join(' | ')}`);
  console.log(JSON.stringify({ result: 'PASS', serviceStatus, liveClients, noBotRosterWhenOffline: true, responsive, errors: browserErrors }, null, 2));
  await context.close();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  await database?.end();
  if (process.env.DATABASE_URL && fixtureMatchIds.size) {
    const cleanup = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await cleanup.query('DELETE FROM matches WHERE id=ANY($1::uuid[])', [[...fixtureMatchIds]]);
      if (fixturePlayerIds.size) {
        await cleanup.query('DELETE FROM guest_sessions WHERE player_id=ANY($1::uuid[])', [[...fixturePlayerIds]]);
        await cleanup.query('DELETE FROM players WHERE id=ANY($1::uuid[])', [[...fixturePlayerIds]]);
      }
    } finally { await cleanup.end(); }
  }
}
