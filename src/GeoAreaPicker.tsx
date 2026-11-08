import { useState } from 'react';
import type { GeoCoordinate, LocationSnapshot } from './location/geolocation';
import { useLocation } from './location/LocationProvider';
import StadiaMap, { type MapLoadStatus } from './map/StadiaMap';

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '—';
  if (ageMs < 1000) return 'meno di 1 s';
  return `${Math.floor(ageMs / 1000)} s`;
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestampMs);
}

const statusLabel: Record<LocationSnapshot['status'], string> = {
  NOT_REQUESTED: 'NON RICHIESTA', REQUESTING: 'RICERCA IN CORSO', ACTIVE: 'AGGIORNATA',
  DENIED: 'PERMESSO NEGATO', UNAVAILABLE: 'NON DISPONIBILE', TIMEOUT: 'TEMPO SCADUTO',
  UNSUPPORTED: 'NON SUPPORTATA', STOPPED: 'FERMATA', STALE: 'DATI NON RECENTI',
};

export default function GeoAreaPicker({
  center,
  centerSource,
  radiusMeters,
  onCenterChange,
  onMapStatusChange,
}: {
  center: GeoCoordinate | null;
  centerSource: 'map' | 'device' | null;
  radiusMeters: number;
  onCenterChange: (center: GeoCoordinate | null, source: 'map' | 'device' | null) => void;
  onMapStatusChange?: (status: MapLoadStatus) => void;
}) {
  const location = useLocation();
  const [focusCommand, setFocusCommand] = useState<{ point: GeoCoordinate; token: number } | null>(null);

  function centerMapOnDevice() {
    if (!location.sample) return;
    setFocusCommand(current => ({ point: location.sample!, token: (current?.token ?? 0) + 1 }));
  }

  function useDeviceAsCenter() {
    if (!location.sample || location.status !== 'ACTIVE') return;
    onCenterChange({ latitude: location.sample.latitude, longitude: location.sample.longitude }, 'device');
    centerMapOnDevice();
  }

  const canTrack = !['REQUESTING', 'ACTIVE', 'STALE', 'UNSUPPORTED'].includes(location.status);
  return <div className="geo-area-picker">
    <div className="geo-map-heading"><div><span>MAPPA INTERATTIVA</span><b>La posizione e il centro del campo sono separati.</b></div><span className={`geo-status-pill geo-status-pill--${location.status.toLowerCase()}`}><i /> {statusLabel[location.status]}</span></div>
    <StadiaMap
      center={center}
      radiusMeters={radiusMeters}
      deviceSample={location.sample}
      focusCommand={focusCommand}
      onChooseCenter={point => onCenterChange(point, 'map')}
      onStatusChange={onMapStatusChange}
    />
    <div className="geo-selection-status" aria-live="polite">
      <span className="geo-selection-mark" aria-hidden="true">⌖</span>
      <div><b>{center ? 'CENTRO AREA SELEZIONATO' : 'CENTRO AREA NON SELEZIONATO'}</b><span>{center ? (centerSource === 'device' ? 'Impostato dalla posizione attuale del dispositivo.' : 'Scelto manualmente toccando la mappa.') : 'Tocca la mappa o usa la posizione attuale del dispositivo.'}</span></div>
      {center && <button type="button" className="geo-clear-center" onClick={() => onCenterChange(null, null)} aria-label="Rimuovi il centro selezionato">RIMUOVI</button>}
    </div>
    <div className="geo-controls">
      <div className="location-consent">
        <span className="eyebrow">POSIZIONE DEL DISPOSITIVO · FACOLTATIVA</span>
        <p>Attivala solo se vuoi centrare la mappa o usare il tuo punto come centro del campo. Il browser chiederà il permesso; coordinate e precisione restano in memoria e il tracciamento si ferma quando esci o premi STOP. Se centri la mappa sul GPS, Stadia Maps riceve richieste cartografiche relative all’area inquadrata.</p>
      </div>
      <div className="location-status" role="status">
        <span className={`location-status-dot location-status-dot--${location.status.toLowerCase()}`} />
        <div><b>{statusLabel[location.status]}</b><span>{location.message}</span></div>
        {location.sample && <div className="location-metrics"><span>PRECISIONE DICHIARATA <b>±{Math.round(location.sample.accuracyMeters)} m</b></span><span>ULTIMO CAMPIONE <b>{formatTime(location.sample.timestampMs)}</b></span><span>ETÀ <b>{formatAge(location.ageMs)}</b></span></div>}
      </div>
      <div className="location-actions">
        <button type="button" className="button button--primary" onClick={location.start} disabled={!canTrack}><span>{location.status === 'DENIED' ? 'RIPROVA POSIZIONE' : 'ATTIVA POSIZIONE'}</span><b>⌖</b></button>
        <button type="button" className="button button--ghost" onClick={centerMapOnDevice} disabled={!location.sample}><span>CENTRA MAPPA</span></button>
        <button type="button" className="button button--ghost" onClick={useDeviceAsCenter} disabled={!location.sample || location.status !== 'ACTIVE'}><span>USA POSIZIONE COME CENTRO</span></button>
        <button type="button" className="button button--stop" onClick={location.stop} disabled={!['REQUESTING', 'ACTIVE', 'STALE'].includes(location.status)}><span>STOP GPS</span></button>
      </div>
      {location.sample && <details className="location-diagnostics"><summary>DIAGNOSTICA TECNICA · COORDINATE</summary><code>lat {location.sample.latitude.toFixed(6)} · lon {location.sample.longitude.toFixed(6)}</code></details>}
    </div>
  </div>;
}
