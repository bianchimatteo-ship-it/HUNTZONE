import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import StadiaMap, { classifyMapError } from './StadiaMap';
import { resetTestMaps, TestMap } from './MapLibreTestDouble';

vi.mock('maplibre-gl', async () => {
  const mock = await import('./MapLibreTestDouble');
  return { Map: mock.TestMap, NavigationControl: mock.NavigationControl, setWorkerUrl: vi.fn() };
});

afterEach(() => { cleanup(); resetTestMaps(); vi.useRealTimers(); });

describe('StadiaMap adapter', () => {
  it('loads the Stadia EU style, exposes required attribution, and updates geodesic overlays', async () => {
    render(<StadiaMap center={{ latitude: 45, longitude: 9 }} radiusMeters={840} deviceSample={{ latitude: 45.001, longitude: 9.002, accuracyMeters: 16, timestampMs: Date.now() }} focusCommand={null} onChooseCenter={vi.fn()} />);
    act(() => TestMap.instances[0].fire('load'));
    await waitFor(() => expect(TestMap.instances[0]?.sources.has('play-area')).toBe(true));
    const map = TestMap.instances[0];
    expect(map.options.style).toBe('https://tiles-eu.stadiamaps.com/styles/alidade_smooth_dark.json');
    expect(map.options.attributionControl).toBe(false);
    expect(map.layers).toHaveLength(6);
    expect(JSON.stringify(map.sources.get('play-area')?.data)).toContain('840');
    expect(JSON.stringify(map.sources.get('gps-accuracy')?.data)).toContain('16');
    expect(screen.getByRole('link', { name: 'Stadia Maps' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OpenMapTiles' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'MapLibre' })).toBeTruthy();
  });

  it('selects a distinct map centre and recentres only after an explicit focus command', async () => {
    const onChooseCenter = vi.fn();
    const { rerender } = render(<StadiaMap center={null} radiusMeters={100} deviceSample={null} focusCommand={null} onChooseCenter={onChooseCenter} />);
    await waitFor(() => expect(TestMap.instances[0]).toBeDefined());
    const map = TestMap.instances[0];
    act(() => map.fire('load'));
    await waitFor(() => expect(map.sources.has('map-markers')).toBe(true));
    map.fire('click', { lngLat: { lat: 46, lng: 10 } });
    expect(onChooseCenter).toHaveBeenCalledWith({ latitude: 46, longitude: 10 });
    expect(JSON.stringify(map.sources.get('map-markers')?.data)).not.toContain('45');
    rerender(<StadiaMap center={{ latitude: 45, longitude: 9 }} radiusMeters={1500} deviceSample={null} focusCommand={{ point: { latitude: 46, longitude: 10 }, token: 1 }} onChooseCenter={onChooseCenter} />);
    await waitFor(() => expect(map.cameraMoves).toHaveLength(1));
    expect(JSON.stringify(map.sources.get('play-area')?.data)).toContain('1500');
    expect(JSON.stringify(map.sources.get('map-markers')?.data)).toContain('45');
  });

  it('replaces a failed provider map with a clear retry state and releases the old instance', async () => {
    render(<StadiaMap center={null} radiusMeters={100} deviceSample={null} focusCommand={null} onChooseCenter={vi.fn()} />);
    act(() => TestMap.instances[0].fire('error', { error: new Error('401') }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/accesso autorizzato/i)).toBeTruthy();
    expect(document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state')).toBe('AUTH_ERROR');
    screen.getByRole('button', { name: /riprova/i }).click();
    await waitFor(() => expect(TestMap.instances).toHaveLength(2));
    expect(TestMap.instances[0].removed).toBe(true);
  });

  it('keeps a ready map visible when one tile fails and marks it degraded', async () => {
    render(<StadiaMap center={null} radiusMeters={840} deviceSample={null} focusCommand={null} onChooseCenter={vi.fn()} />);
    act(() => TestMap.instances[0].fire('load'));
    await waitFor(() => expect(document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state')).toBe('READY'));
    act(() => TestMap.instances[0].fire('error', { sourceId: 'base-map', tile: {}, error: new Error('tile request failed') }));
    expect(document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state')).toBe('DEGRADED');
    expect(screen.getByText(/mappa resta utilizzabile/i)).toBeTruthy();
    expect(document.querySelector('.stadia-map-canvas')?.classList.contains('stadia-map-canvas--hidden')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes worker, WebGL2, auth, style, network and unknown failures', () => {
    expect(classifyMapError({ error: new Error('Worker script failed') }, false).status).toBe('WORKER_ERROR');
    expect(classifyMapError({ error: new Error('WebGL2 context creation failed') }, false).status).toBe('WEBGL_UNSUPPORTED');
    expect(classifyMapError({ error: { status: 403, message: 'forbidden' } }, false).status).toBe('AUTH_ERROR');
    expect(classifyMapError({ error: new Error('Failed to load style.json') }, false).status).toBe('STYLE_ERROR');
    expect(classifyMapError({ error: new Error('Network fetch failed') }, false).status).toBe('NETWORK_ERROR');
    expect(classifyMapError({ error: new Error('unclassified') }, false).status).toBe('FATAL_ERROR');
  });

  it('clears the load timeout on MapLibre load and reports a bounded timeout otherwise', () => {
    vi.useFakeTimers();
    const ready = render(<StadiaMap center={null} radiusMeters={100} deviceSample={null} focusCommand={null} onChooseCenter={vi.fn()} />);
    act(() => TestMap.instances[0].fire('load'));
    act(() => vi.advanceTimersByTime(20_000));
    expect(document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state')).toBe('READY');
    ready.unmount();

    render(<StadiaMap center={null} radiusMeters={100} deviceSample={null} focusCommand={null} onChooseCenter={vi.fn()} />);
    act(() => vi.advanceTimersByTime(18_000));
    expect(document.querySelector('.stadia-map-shell')?.getAttribute('data-map-state')).toBe('TIMEOUT');
    expect(screen.getByText(/non ha terminato il caricamento/i)).toBeTruthy();
  });
});
