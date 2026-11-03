import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createLocationTracker, type LocationSnapshot, type LocationTracker } from './geolocation';

const initialSnapshot: LocationSnapshot = {
  status: 'NOT_REQUESTED', sample: null, ageMs: null, message: 'La posizione non è stata richiesta.',
};

type LocationContextValue = LocationSnapshot & { start: () => void; stop: () => void; refresh: () => void };
const LocationContext = createContext<LocationContextValue | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const trackerRef = useRef<LocationTracker | null>(null);
  const permissionRef = useRef<PermissionStatus | null>(null);
  const permissionHandlerRef = useRef<(() => void) | null>(null);
  const permissionRequestRef = useRef(0);

  const clearPermissionListener = useCallback(() => {
    permissionRequestRef.current += 1;
    if (permissionRef.current && permissionHandlerRef.current) {
      permissionRef.current.removeEventListener('change', permissionHandlerRef.current);
    }
    permissionRef.current = null;
    permissionHandlerRef.current = null;
  }, []);

  useEffect(() => {
    const tracker = createLocationTracker(setSnapshot);
    trackerRef.current = tracker;
    return () => {
      clearPermissionListener();
      tracker.dispose();
      trackerRef.current = null;
    };
  }, [clearPermissionListener]);

  const start = useCallback(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    tracker.start();
    if (!navigator.permissions?.query) return;
    const request = ++permissionRequestRef.current;
    void navigator.permissions.query({ name: 'geolocation' }).then(permission => {
      if (request !== permissionRequestRef.current || trackerRef.current !== tracker) return;
      clearPermissionListener();
      permissionRef.current = permission;
      const handler = () => tracker.permissionChanged(permission.state);
      permissionHandlerRef.current = handler;
      permission.addEventListener('change', handler);
      tracker.permissionChanged(permission.state);
    }).catch(() => {
      // watchPosition reports denial even where the Permissions API is unavailable.
    });
  }, [clearPermissionListener]);

  const stop = useCallback(() => {
    clearPermissionListener();
    trackerRef.current?.stop();
  }, [clearPermissionListener]);

  const refresh = useCallback(() => trackerRef.current?.refresh(), []);

  useEffect(() => {
    if (snapshot.status !== 'ACTIVE' && snapshot.status !== 'STALE') return;
    const timer = window.setInterval(refresh, 1000);
    const onVisibilityChange = () => refresh();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, snapshot.status]);

  return <LocationContext.Provider value={{ ...snapshot, start, stop, refresh }}>{children}</LocationContext.Provider>;
}

export function useLocation(): LocationContextValue {
  const value = useContext(LocationContext);
  if (!value) throw new Error('useLocation must be used within LocationProvider.');
  return value;
}
