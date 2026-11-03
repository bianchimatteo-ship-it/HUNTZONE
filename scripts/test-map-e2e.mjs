import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const serverMode = process.env.HUNTZONE_PREVIEW_MODE ?? '';
const baseUrl = process.env.HUNTZONE_E2E_URL ?? `http://127.0.0.1:4180${serverMode === 'github-pages' ? '/HUNTZONE/' : '/'}`;
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = process.env.HUNTZONE_E2E_URL ? null : spawn('npm', [
  'run', 'preview', ...(serverMode ? ['--', '--mode', serverMode] : ['--']), '--host', '127.0.0.1', '--port', '4180', '--strictPort',
], { stdio: 'ignore' });
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch { /* Vite preview is still starting. */ }
    await delay(200);
  }
  throw new Error(`Preview did not start at ${baseUrl}`);
}

function appUrl() {
  const url = new URL(baseUrl);
  url.hash = process.env.HUNTZONE_E2E_PATH ?? '/home';
  return url.href;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openAndCheckMap(page, expectedOrigin) {
  const errors = [];
  const requests = [];
  const responses = [];
  const workers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
  page.on('worker', worker => workers.push(worker.url()));
  page.on('response', response => {
    if (response.url().includes('stadiamaps.com') || response.url().includes('maplibre-gl-worker')) {
      responses.push({ url: response.url(), status: response.status() });
    }
  });
  page.on('request', async request => {
    if (!request.url().includes('stadiamaps.com')) return;
    requests.push({
      url: request.url(),
      headers: await request.allHeaders(),
      type: request.resourceType(),
    });
  });
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /CREA PARTITA/i }).click();
  await page.locator('.stadia-map-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state') === 'READY', null, { timeout: 60_000 });
  const canvas = page.locator('.maplibregl-canvas');
  await canvas.waitFor({ state: 'visible' });
  const canvasSize = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  assert(canvasSize.width > 0 && canvasSize.height > 0, 'MapLibre canvas has no visible size.');

  const styleRequest = requests.find(request => request.url.includes('/styles/alidade_smooth_dark.json'));
  const workerRequest = requests.some(request => request.url.includes('maplibre-gl-worker')) || workers.some(url => url.includes('maplibre-gl-worker'));
  const tileRequests = requests.filter(request => /\/tiles?\//.test(new URL(request.url).pathname) || /\.(pbf|mvt)(?:\?|$)/.test(request.url));
  const styleAssets = requests.filter(request => /\/(fonts|sprites)\//.test(new URL(request.url).pathname));
  assert(styleRequest, 'No Stadia style JSON request was observed.');
  assert(styleRequest.headers.origin === expectedOrigin, `Unexpected style Origin: ${styleRequest.headers.origin ?? 'missing'}`);
  assert(styleRequest.headers.referer === `${expectedOrigin}/`, `Unexpected style Referer: ${styleRequest.headers.referer ?? 'missing'}`);
  assert(tileRequests.length > 0, 'No Stadia tile request was observed.');
  assert(styleAssets.length > 0, 'No Stadia glyph or sprite request was observed.');
  assert(workerRequest, 'MapLibre worker request was not observed.');
  assert(responses.some(response => response.url.includes('maplibre-gl-worker') && response.status === 200), 'MapLibre worker did not return HTTP 200.');
  assert(responses.some(response => /\.(pbf|mvt)(?:\?|$)/.test(response.url) && response.status === 200), 'No map tile returned HTTP 200.');
  assert(responses.some(response => /\/(fonts|sprites)\//.test(new URL(response.url).pathname) && response.status === 200), 'No style glyph or sprite resource returned HTTP 200.');
  for (const resource of requests) {
    assert(resource.headers.origin === expectedOrigin, `Stadia ${resource.type} Origin header is missing or changed.`);
    assert(resource.headers.referer === `${expectedOrigin}/`, `Stadia ${resource.type} Referer header is missing or changed.`);
  }

  const initialZoom = await page.locator('.stadia-map-canvas').getAttribute('data-map-zoom');
  await page.locator('.maplibregl-ctrl-zoom-in').click();
  await page.waitForFunction(previous => document.querySelector('.stadia-map-canvas')?.getAttribute('data-map-zoom') !== previous, initialZoom);
  await canvas.scrollIntoViewIfNeeded();
  const mapBounds = await canvas.boundingBox();
  assert(mapBounds, 'Map canvas is not positioned.');
  await canvas.click({ position: { x: mapBounds.width / 2, y: mapBounds.height / 2 } });
  await page.getByText('CENTRO AREA SELEZIONATO').waitFor();
  await page.screenshot({ path: '/tmp/huntzone-map-e2e.png', fullPage: false });
  const responsive = [];
  for (const width of [320, 360, 375, 390, 412, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({ width: window.innerWidth, pageWidth: document.documentElement.scrollWidth }));
    assert(metrics.pageWidth <= metrics.width, `Horizontal overflow at ${width}px: document width ${metrics.pageWidth}px.`);
    responsive.push(width);
  }
  return { canvasSize, styleOrigin: styleRequest.headers.origin, tileCount: tileRequests.length, workerRequest, responsive, errors };
}

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const actual = await openAndCheckMap(page, new URL(baseUrl).origin);
  assert(actual.errors.length === 0, `Browser reported errors: ${actual.errors.join(' | ')}`);

  const retryPage = await context.newPage();
  await retryPage.route('**/styles/alidade_smooth_dark.json', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));
  await retryPage.goto(appUrl(), { waitUntil: 'domcontentloaded' });
  await retryPage.getByRole('button', { name: /CREA PARTITA/i }).click();
  await retryPage.locator('.stadia-map-shell[data-map-state="AUTH_ERROR"]').waitFor({ state: 'visible', timeout: 20_000 });
  await retryPage.unroute('**/styles/alidade_smooth_dark.json');
  await retryPage.getByRole('button', { name: /RIPROVA A CARICARE/i }).click();
  await retryPage.waitForFunction(() => document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state') === 'READY', null, { timeout: 60_000 });
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(appUrl(), { waitUntil: 'domcontentloaded' });
  await touchPage.getByRole('button', { name: /CREA PARTITA/i }).click();
  await touchPage.waitForFunction(() => document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state') === 'READY', null, { timeout: 60_000 });
  await touchPage.locator('.stadia-map-canvas').scrollIntoViewIfNeeded();
  const touchCanvas = await touchPage.locator('.maplibregl-canvas').boundingBox();
  assert(touchCanvas, 'Touch map canvas is not positioned.');
  const touchCdp = await touchContext.newCDPSession(touchPage);
  const centerX = Math.round(touchCanvas.x + touchCanvas.width / 2);
  const centerY = Math.round(touchCanvas.y + touchCanvas.height / 2);
  const touchZoomBefore = await touchPage.locator('.stadia-map-canvas').getAttribute('data-map-zoom');
  await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: centerX - 25, y: centerY, id: 0 }, { x: centerX + 25, y: centerY, id: 1 }] });
  await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: centerX - 70, y: centerY, id: 0 }, { x: centerX + 70, y: centerY, id: 1 }] });
  await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchPage.waitForFunction(previous => document.querySelector('.stadia-map-canvas')?.getAttribute('data-map-zoom') !== previous, touchZoomBefore, { timeout: 10_000 });
  await touchPage.locator('.location-consent').scrollIntoViewIfNeeded();
  const scrollBefore = await touchPage.evaluate(() => window.scrollY);
  const consentBounds = await touchPage.locator('.location-consent').boundingBox();
  assert(consentBounds, 'Location disclosure is not positioned.');
  const scrollX = Math.round(consentBounds.x + consentBounds.width / 2);
  const scrollY = Math.round(consentBounds.y + consentBounds.height / 2);
  await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: scrollX, y: scrollY, id: 0 }] });
  await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: scrollX, y: scrollY - 100, id: 0 }] });
  await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchPage.waitForFunction(previous => window.scrollY > previous, scrollBefore, { timeout: 5_000 });
  await touchContext.close();
  console.log(JSON.stringify({ result: 'PASS', ...actual, retryAfterUnauthorized: 'PASS', screenshot: '/tmp/huntzone-map-e2e.png' }, null, 2));
  await context.close();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
