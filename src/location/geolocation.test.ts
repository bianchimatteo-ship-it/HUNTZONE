import { describe, expect, it, vi } from 'vitest';
import { createLocationTracker, type LocationSnapshot } from './geolocation';

function makePosition(latitude: number, longitude: number, accuracy: number, timestamp: number): GeolocationPosition {
  return { coords: { latitude, longitude, accuracy } as GeolocationCoordinates, timestamp } as GeolocationPosition;
}

function harness(now = 100_000) {
  let success: PositionCallback | undefined;
  let failure: PositionErrorCallback | undefined;
  const snapshots: LocationSnapshot[] = [];
  const geolocation = {
    watchPosition: vi.fn((onSuccess: PositionCallback, onFailure?: PositionErrorCallback | null) => {
      success = onSuccess;
      failure = onFailure ?? undefined;
      return 42;
    }),
    clearWatch: vi.fn(),
  };
  const tracker = createLocationTracker(snapshot => snapshots.push(snapshot), { geolocation, now: () => now, freshnessMs: 30_000 });
  return {
    tracker, snapshots, geolocation,
    success(position: GeolocationPosition) { success?.(position); },
    failure(code: number) { failure?.({ code } as GeolocationPositionError); },
    setNow(value: number) { now = value; },
  };
}

describe('browser geolocation tracker', () => {
  it('does not start before the explicit caller action and creates only one high-accuracy watch', () => {
    const test = harness();
    expect(test.geolocation.watchPosition).not.toHaveBeenCalled();
    test.tracker.start();
    test.tracker.start();
    expect(test.geolocation.watchPosition).toHaveBeenCalledTimes(1);
    expect(test.geolocation.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true, maximumAge: 0, timeout: 15_000,
    });
    expect(test.tracker.snapshot.status).toBe('REQUESTING');
  });

  it('accepts successive valid samples and exposes device accuracy and age', () => {
    const test = harness();
    test.tracker.start();
    test.success(makePosition(45.4642, 9.19, 18.5, 99_500));
    expect(test.tracker.snapshot).toMatchObject({ status: 'ACTIVE', ageMs: 500, sample: { latitude: 45.4642, longitude: 9.19, accuracyMeters: 18.5 } });
    test.setNow(101_000);
    test.success(makePosition(45.465, 9.191, 22, 100_900));
    expect(test.tracker.snapshot.sample?.accuracyMeters).toBe(22);
    expect(test.tracker.snapshot.ageMs).toBe(100);
  });

  it('marks old samples stale and refreshes age without losing the latest sample', () => {
    const test = harness();
    test.tracker.start();
    test.success(makePosition(45, 9, 10, 100_000));
    test.setNow(130_001);
    test.tracker.refresh();
    expect(test.tracker.snapshot.status).toBe('STALE');
    expect(test.tracker.snapshot.sample?.latitude).toBe(45);
    expect(test.tracker.snapshot.ageMs).toBe(30_001);
  });

  it.each([[1, 'DENIED'], [2, 'UNAVAILABLE']] as const)('maps browser error %s to %s and clears the watcher', (code, status) => {
    const test = harness();
    test.tracker.start();
    test.failure(code);
    expect(test.tracker.snapshot.status).toBe(status);
    expect(test.geolocation.clearWatch).toHaveBeenCalledWith(42);
    expect(test.tracker.watchId).toBeNull();
  });

  it('retries temporary timeouts twice without treating them as permission revocation', () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      test.tracker.start();
      test.failure(3);
      expect(test.tracker.snapshot).toMatchObject({ status: 'TIMEOUT', sample: null });
      expect(test.geolocation.clearWatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2500);
      expect(test.geolocation.watchPosition).toHaveBeenCalledTimes(2);
      expect(test.geolocation.clearWatch).toHaveBeenCalledWith(42);
      test.failure(1);
      expect(test.tracker.snapshot.status).toBe('DENIED');
      expect(test.geolocation.clearWatch).toHaveBeenCalledTimes(2);
      test.tracker.stop();
    } finally { vi.useRealTimers(); }
  });

  it('clears an active watch and its precise sample on stop and unmount cleanup', () => {
    const test = harness();
    test.tracker.start();
    test.success(makePosition(45, 9, 12, 100_000));
    test.tracker.stop();
    expect(test.tracker.snapshot).toMatchObject({ status: 'STOPPED', sample: null, ageMs: null });
    expect(test.geolocation.clearWatch).toHaveBeenCalledTimes(1);

    const second = harness();
    second.tracker.start();
    second.tracker.dispose();
    expect(second.geolocation.clearWatch).toHaveBeenCalledWith(42);
    expect(second.tracker.snapshot.sample).toBeNull();
    expect(second.snapshots.at(-1)?.status).toBe('REQUESTING');
  });

  it('stops collection after a permission revocation', () => {
    const test = harness();
    test.tracker.start();
    test.success(makePosition(45, 9, 15, 100_000));
    test.tracker.permissionChanged('denied');
    expect(test.tracker.snapshot).toMatchObject({ status: 'DENIED', sample: null });
    expect(test.geolocation.clearWatch).toHaveBeenCalledWith(42);
  });

  it.each([
    [91, 9, 10], [45, 181, 10], [45, 9, Number.NaN],
  ])('rejects invalid device coordinates or accuracy without exposing them', (latitude, longitude, accuracy) => {
    const test = harness();
    test.tracker.start();
    test.success(makePosition(latitude, longitude, accuracy, 100_000));
    expect(test.tracker.snapshot).toMatchObject({ status: 'UNAVAILABLE', sample: null });
  });

  it('reports an unsupported environment without creating a watcher', () => {
    const snapshots: LocationSnapshot[] = [];
    const tracker = createLocationTracker(snapshot => snapshots.push(snapshot), { geolocation: null });
    tracker.start();
    expect(tracker.snapshot.status).toBe('UNSUPPORTED');
    expect(snapshots.at(-1)?.message).toMatch(/non supporta/i);
  });
});
