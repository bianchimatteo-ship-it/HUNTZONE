import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { LocationProvider } from './location/LocationProvider';
import { resetTestMaps, TestMap } from './map/MapLibreTestDouble';

vi.mock('maplibre-gl', async () => {
  const mock = await import('./map/MapLibreTestDouble');
  return { Map: mock.TestMap, NavigationControl: mock.NavigationControl };
});

let originalGeolocation: PropertyDescriptor | undefined;
let originalPermissions: PropertyDescriptor | undefined;

afterEach(() => {
  cleanup();
  resetTestMaps();
  localStorage.clear();
  window.location.hash = '';
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  else delete (navigator as unknown as { geolocation?: Geolocation }).geolocation;
  originalGeolocation = undefined;
  if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
  else delete (navigator as unknown as { permissions?: Permissions }).permissions;
  originalPermissions = undefined;
});

beforeEach(() => {
  window.scrollTo = () => {};
});

describe('HUNTZONE local demo flow', () => {
  it('shows capture and role policies as an unapplied local preview', async () => {
    const user = userEvent.setup();
    render(<LocationProvider><App /></LocationProvider>);

    await user.click(screen.getByRole('button', { name: /CREA PARTITA/i }));
    const pin = screen.getByRole('radio', { name: /PIN personale/i });
    const manual = screen.getByRole('radio', { name: /^Manuale/i });
    await user.click(pin);
    await user.click(manual);

    expect(pin).toHaveProperty('checked', true);
    expect(manual).toHaveProperty('checked', true);
    expect(screen.getByText(/Non influenzano la simulazione/i)).toBeTruthy();
    expect(screen.getByText(/soglie numeriche sono ancora da approvare/i)).toBeTruthy();
    expect(localStorage.getItem('huntzone.demo.config')).toContain('"captureMethod":"pin"');
  });

  it('requests GPS only after the explicit action and clears the watch when leaving creation', async () => {
    let success: PositionCallback | undefined;
    const geolocation = {
      watchPosition: vi.fn((onSuccess: PositionCallback) => { success = onSuccess; return 9; }),
      clearWatch: vi.fn(),
    };
    originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation });
    originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
    const user = userEvent.setup();
    const view = render(<StrictMode><LocationProvider><App /></LocationProvider></StrictMode>);
    await user.click(screen.getByRole('button', { name: /CREA PARTITA/i }));
    expect(geolocation.watchPosition).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Stadia Maps' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /ATTIVA POSIZIONE/i }));
    expect(geolocation.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true, maximumAge: 0, timeout: 15_000,
    });
    success?.({
      coords: { latitude: 45.4642, longitude: 9.19, accuracy: 18 } as GeolocationCoordinates,
      timestamp: Date.now(),
    } as GeolocationPosition);
    expect(await screen.findByText(/precisione dichiarata/i)).toBeTruthy();
    expect(localStorage.getItem('huntzone.demo.config') ?? '').not.toContain('45.4642');
    expect(location.hash).not.toContain('45.4642');

    await user.click(screen.getByRole('button', { name: 'HUNTZONE home' }));
    expect(geolocation.clearWatch).toHaveBeenCalledWith(9);
    view.unmount();
  });

  it('creates a configured lobby, simulates a capture, ends the match and allows a rematch', async () => {
    const user = userEvent.setup();
    render(<LocationProvider><App /></LocationProvider>);

    await user.click(screen.getByRole('button', { name: /CREA PARTITA/i }));
    expect(screen.getByRole('heading', { name: /Prepara il campo/i })).toBeTruthy();

    fireEvent.change(screen.getByRole('slider', { name: /Raggio area di gioco/i }), { target: { value: '1550' } });
    expect(screen.getByText('1550')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /CREA LOBBY/i }));
    expect(screen.getByText('INVITE CODE')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /START SIMULATION/i }));
    expect(screen.getByText(/TIME REMAINING/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'HUNTER' }));
    const captureButton = screen.getAllByRole('button', { name: /TAG .*Virtual capture/i })[0];
    await user.click(captureButton);
    expect(screen.getByText(/1 TAGGED/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /TERMINA SIMULAZIONE/i }));
    expect(screen.getByText(/SIMULATION COMPLETE/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /RIVINCITA/i }));
    expect(screen.getByRole('heading', { name: /La squadra si prepara/i })).toBeTruthy();
  });

  it('keeps GPS and the selected area through lobby and game, then stops GPS at results', async () => {
    let success: PositionCallback | undefined;
    const geolocation = {
      watchPosition: vi.fn((onSuccess: PositionCallback) => { success = onSuccess; return 27; }),
      clearWatch: vi.fn(),
    };
    originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation });
    originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
    const user = userEvent.setup();
    render(<LocationProvider><App /></LocationProvider>);

    await user.click(screen.getByRole('button', { name: /CREA PARTITA/i }));
    const createMap = TestMap.instances[0];
    act(() => {
      createMap.fire('load');
      createMap.fire('click', { lngLat: { lat: 45.46, lng: 9.19 } });
    });
    await user.click(screen.getByRole('button', { name: /ATTIVA POSIZIONE/i }));
    success?.({ coords: { latitude: 45.46, longitude: 9.19, accuracy: 12 } as GeolocationCoordinates, timestamp: Date.now() } as GeolocationPosition);
    expect(await screen.findByText(/precisione dichiarata/i)).toBeTruthy();
    expect(localStorage.getItem('huntzone.demo.config') ?? '').not.toContain('45.46');
    expect(window.location.href).not.toContain('45.46');

    await user.click(screen.getByRole('button', { name: /CREA LOBBY/i }));
    expect(geolocation.clearWatch).not.toHaveBeenCalled();
    expect(screen.getByText(/AREA SELEZIONATA/i)).toBeTruthy();
    const lobbyMap = TestMap.instances[1];
    act(() => lobbyMap.fire('load'));
    expect(JSON.stringify(lobbyMap.sources.get('map-markers')?.data)).toContain('center');
    expect(JSON.stringify(lobbyMap.sources.get('map-markers')?.data)).toContain('device');

    await user.click(screen.getByRole('button', { name: /START SIMULATION/i }));
    const gameMap = TestMap.instances[2];
    act(() => gameMap.fire('load'));
    expect(screen.getByText('CAMPO DI GIOCO')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'STOP GPS' })).toBeTruthy();
    expect(JSON.stringify(gameMap.sources.get('map-markers')?.data)).not.toContain('demo-');
    expect(geolocation.clearWatch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /TERMINA SIMULAZIONE/i }));
    expect(geolocation.clearWatch).toHaveBeenCalledWith(27);
    expect(screen.getByText('GPS fermato')).toBeTruthy();
    expect(screen.getByText(/FIELD RADIUS/i)).toBeTruthy();
  });
});
