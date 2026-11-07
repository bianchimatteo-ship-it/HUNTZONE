import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const mode = process.env.HUNTZONE_PREVIEW_MODE ?? '';
const baseUrl = process.env.HUNTZONE_E2E_URL ?? `http://127.0.0.1:4180${mode === 'github-pages' ? '/HUNTZONE/' : '/'}`;
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = process.env.HUNTZONE_E2E_URL ? null : spawn('npm', [
  'run', 'preview', ...(mode ? ['--', '--mode', mode] : ['--']), '--host', '127.0.0.1', '--port', '4180', '--strictPort',
], { stdio: 'ignore' });
const localApi = process.env.HUNTZONE_E2E_ALLOW_ONLINE === '1'
  && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.VITE_API_BASE_URL ?? 'http://invalid').hostname);
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* Preview still starting. */ }
    await delay(200);
  }
  throw new Error(`Preview did not start at ${baseUrl}`);
}
function assert(value, message) { if (!value) throw new Error(message); }

async function createOnlineLobby(context, name) {
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.online-service--ready').waitFor({ timeout: 15_000 });
  const hostForm = page.locator('.online-card').first();
  await hostForm.getByLabel('Il tuo nome').fill(name);
  await hostForm.getByRole('button', { name: /CREA LOBBY REALE/i }).click();
  await page.locator('.online-lobby').waitFor({ timeout: 15_000 });
  return page;
}

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Il campo è/i }).waitFor();
  await page.getByText('NESSUN BOT', { exact: true }).waitFor();

  const serviceStatus = await page.locator('.online-service').innerText();
  const responsive = [];
  for (const width of [320, 360, 375, 390, 412, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({ width: window.innerWidth, pageWidth: document.documentElement.scrollWidth }));
    assert(metrics.pageWidth <= metrics.width, `Horizontal overflow at ${width}px.`);
    responsive.push(width);
  }

  let liveClients = 'SKIPPED: local PostgreSQL-backed API is not configured';
  if (localApi) {
    await page.waitForFunction(() => document.querySelector('.online-service')?.classList.contains('online-service--ready'), null, { timeout: 15_000 });
    const host = await createOnlineLobby(context, 'E2E Host');
    const code = await host.locator('.online-invite strong').innerText();
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guest = await guestContext.newPage();
    await guest.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await guest.locator('.online-service--ready').waitFor({ timeout: 15_000 });
    const guestForm = guest.locator('.online-card').nth(1);
    await guestForm.getByLabel('Il tuo nome').fill('E2E Guest');
    await guestForm.getByLabel('Codice invito').fill(code);
    await guestForm.getByRole('button', { name: /UNISCITI ALLA LOBBY/i }).click();
    await guest.locator('.online-lobby').waitFor({ timeout: 15_000 });
    await host.getByText('E2E Guest').waitFor({ timeout: 10_000 });
    await guest.getByRole('button', { name: /CONFERMA READY/i }).click();
    const guestRow = host.locator('.online-roster li').filter({ hasText: 'E2E Guest' });
    await guestRow.getByText('READY').waitFor({ timeout: 10_000 });
    const guestCdp = await guestContext.newCDPSession(guest);
    await guestCdp.send('Network.enable');
    await guestCdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await guestRow.getByText('RICONNESSIONE').waitFor({ timeout: 15_000 });
    await guestCdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await host.waitForFunction(() => [...document.querySelectorAll('.online-roster li')].some(row => row.textContent?.includes('E2E Guest') && row.getAttribute('data-connected') === 'true'), null, { timeout: 15_000 });
    await guestRow.getByText('READY').waitFor({ timeout: 15_000 });
    assert(await host.getByRole('button', { name: /AVVIA/i }).count() === 0, 'An unfinished mode exposed a start control.');
    liveClients = 'PASS: two browser clients created/joined one PostgreSQL lobby; READY synchronized over API/WebSocket';
    await guestContext.close();
  } else {
    assert(await page.getByRole('button', { name: /CREA LOBBY REALE/i }).isDisabled(), 'Lobby creation must be disabled while multiplayer service is unavailable.');
    assert(await page.locator('.online-roster').count() === 0, 'Offline UI must not invent a lobby roster.');
  }

  assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ result: 'PASS', serviceStatus, liveClients, noBotRosterWhenOffline: true, responsive, errors }, null, 2));
  await context.close();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
