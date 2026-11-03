export type LocationStatus =
  | 'NOT_REQUESTED'
  | 'REQUESTING'
  | 'ACTIVE'
  | 'DENIED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'STOPPED'
  | 'STALE';

export type GeoCoordinate = { latitude: number; longitude: number };

export type LocationSample = GeoCoordinate & {
  accuracyMeters: number;
  timestampMs: number;
};

export type LocationSnapshot = {
  status: LocationStatus;
  sample: LocationSample | null;
  ageMs: number | null;
  message: string;
};

type GeolocationPort = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

const FRESHNESS_MS = 30_000;
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 };

const messages: Record<LocationStatus, string> = {
  NOT_REQUESTED: 'La posizione non è stata richiesta.',
  REQUESTING: 'In attesa del permesso e della posizione del dispositivo…',
  ACTIVE: 'Posizione aggiornata.',
  DENIED: 'Permesso posizione negato. Puoi abilitarlo nelle impostazioni del browser e riprovare.',
  UNAVAILABLE: 'Il dispositivo non riesce a determinare la posizione. Verifica i servizi di localizzazione e riprova.',
  TIMEOUT: 'La posizione non è arrivata entro 15 secondi. Riprova in un luogo con segnale migliore.',
  UNSUPPORTED: 'Questo browser non supporta la geolocalizzazione.',
  STOPPED: 'Tracciamento fermato. Il campione è stato rimosso dalla memoria.',
  STALE: 'Posizione non aggiornata da oltre 30 secondi. Fermati in sicurezza e attendi un nuovo campione.',
};

export function locationErrorStatus(code: number): Extract<LocationStatus, 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT'> {
  if (code === 1) return 'DENIED';
  if (code === 3) return 'TIMEOUT';
  return 'UNAVAILABLE';
}

export function isValidGeoCoordinate(value: GeoCoordinate): boolean {
  return Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90
    && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180;
}

export function createLocationTracker(
  publish: (snapshot: LocationSnapshot) => void,
  options: { geolocation?: GeolocationPort | null; now?: () => number; freshnessMs?: number } = {},
) {
  const geolocation = options.geolocation === undefined
    ? (typeof navigator === 'undefined' ? undefined : navigator.geolocation)
    : options.geolocation ?? undefined;
  const now = options.now ?? Date.now;
  const freshnessMs = options.freshnessMs ?? FRESHNESS_MS;
  let watchId: number | null = null;
  let disposed = false;
  let current: LocationSnapshot = { status: 'NOT_REQUESTED', sample: null, ageMs: null, message: messages.NOT_REQUESTED };

  const emit = (status: LocationStatus, sample: LocationSample | null = current.sample, ageMs: number | null = current.ageMs) => {
    if (disposed) return;
    current = { status, sample, ageMs, message: messages[status] };
    publish(current);
  };

  const clearActiveWatch = () => {
    if (watchId === null) return;
    geolocation?.clearWatch(watchId);
    watchId = null;
  };

  const fail = (status: Extract<LocationStatus, 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT'>) => {
    clearActiveWatch();
    emit(status, null, null);
  };

  return {
    start() {
      if (disposed || watchId !== null || current.status === 'REQUESTING') return;
      if (!geolocation) { emit('UNSUPPORTED', null, null); return; }
      emit('REQUESTING', null, null);
      try {
        const id = geolocation.watchPosition(position => {
          const { latitude, longitude, accuracy } = position.coords;
          const timestampMs = Number(position.timestamp);
          if (!isValidGeoCoordinate({ latitude, longitude }) || !Number.isFinite(accuracy) || accuracy < 0
            || !Number.isFinite(timestampMs) || timestampMs > now()) {
            fail('UNAVAILABLE');
            return;
          }
          const sample: LocationSample = { latitude, longitude, accuracyMeters: accuracy, timestampMs };
          const ageMs = Math.max(0, now() - timestampMs);
          emit(ageMs > freshnessMs ? 'STALE' : 'ACTIVE', sample, ageMs);
        }, error => fail(locationErrorStatus(error.code)), WATCH_OPTIONS);
        watchId = id;
      } catch {
        fail('UNAVAILABLE');
      }
    },
    refresh() {
      if (!current.sample || (current.status !== 'ACTIVE' && current.status !== 'STALE')) return;
      const ageMs = Math.max(0, now() - current.sample.timestampMs);
      emit(ageMs > freshnessMs ? 'STALE' : 'ACTIVE', current.sample, ageMs);
    },
    permissionChanged(state: PermissionState) {
      if (state === 'denied' && watchId !== null) fail('DENIED');
    },
    stop() {
      clearActiveWatch();
      emit('STOPPED', null, null);
    },
    dispose() {
      clearActiveWatch();
      current = { status: 'STOPPED', sample: null, ageMs: null, message: messages.STOPPED };
      disposed = true;
    },
    get watchId() { return watchId; },
    get snapshot() { return current; },
  };
}

export type LocationTracker = ReturnType<typeof createLocationTracker>;
