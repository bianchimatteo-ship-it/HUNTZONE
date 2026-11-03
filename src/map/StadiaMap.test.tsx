import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import StadiaMap from './StadiaMap';
import { resetTestMaps, TestMap } from './MapLibreTestDouble';

vi.mock('maplibre-gl', async () => {
  const mock = await import('./MapLibreTestDouble');
  return { Map: mock.TestMap, NavigationControl: mock.NavigationControl };
});

afterEach(() => { cleanup(); resetTestMaps(); });

describe('StadiaMap adapter', () => {
  it('loads the Stadia EU style, exposes required attribution, and updates geodesic overlays', async () => {
    render(<StadiaMap center={{ latitude: 45, longitude: 9 }} radiusMeters={840} deviceSample={{ latitude: 45.001, longitude: 9.002, accuracyMeters: 16, timestampMs: Date.now() }} focusCommand={null} onChooseCenter={vi.fn()} />);
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
    await waitFor(() => expect(TestMap.instances[0]?.sources.has('map-markers')).toBe(true));
    const map = TestMap.instances[0];
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
    await waitFor(() => expect(TestMap.instances[0]).toBeDefined());
    TestMap.instances[0].fire('error', { error: new Error('401') });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/autorizzazione del dominio/i)).toBeTruthy();
    screen.getByRole('button', { name: /riprova/i }).click();
    await waitFor(() => expect(TestMap.instances).toHaveLength(2));
    expect(TestMap.instances[0].removed).toBe(true);
  });
});
