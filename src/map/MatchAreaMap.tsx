import { useState } from 'react';
import type { GeoCoordinate, LocationStatus } from '../location/geolocation';
import { useLocation } from '../location/LocationProvider';
import type { DemoMatch } from '../types';
import StadiaMap from './StadiaMap';

const statusLabel: Record<LocationStatus, string> = {
  NOT_REQUESTED: 'GPS non richiesto', REQUESTING: 'GPS in attesa', ACTIVE: 'Posizione aggiornata',
  DENIED: 'Permesso negato', UNAVAILABLE: 'Posizione non disponibile', TIMEOUT: 'GPS in timeout',
  UNSUPPORTED: 'GPS non supportato', STOPPED: 'GPS fermato', STALE: 'Posizione non recente',
};

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestampMs);
}

export default function MatchAreaMap({ match, stage }: { match: DemoMatch; stage: 'LOBBY' | 'GAME' | 'RESULTS' }) {
  const location = useLocation();
  const [focusCommand, setFocusCommand] = useState<{ point: GeoCoordinate; token: number } | null>(
    () => match.areaCenter ? { point: match.areaCenter, token: 1 } : null,
  );
  const canStop = ['REQUESTING', 'ACTIVE', 'STALE'].includes(location.status);
  return <section className={`match-area-map match-area-map--${stage.toLowerCase()}`} aria-label={`Mappa area ${stage.toLowerCase()}`}>
    <header className="match-area-map__header">
      <div><span className="eyebrow">{stage === 'LOBBY' ? 'AREA SELEZIONATA' : stage === 'GAME' ? 'CAMPO DI GIOCO' : 'AREA DELLA PARTITA'}</span>
        <h2>{match.areaCenter ? 'Centro e raggio' : 'Centro non selezionato'}</h2>
      </div>
      <span className="match-area-map__radius">{match.config.radius.toLocaleString('it-IT')} m</span>
    </header>
    <StadiaMap
      center={match.areaCenter}
      radiusMeters={match.config.radius}
      deviceSample={location.sample}
      focusCommand={focusCommand}
      onChooseCenter={() => undefined}
    />
    <div className="match-area-map__status" role="status">
      <span className={`location-status-dot location-status-dot--${location.status.toLowerCase()}`} />
      <span><b>{statusLabel[location.status]}</b>{location.sample && <> · Precisione dichiarata ±{Math.round(location.sample.accuracyMeters)} m · Aggiornata alle {formatTime(location.sample.timestampMs)}</>}</span>
      {location.sample && <button type="button" onClick={() => setFocusCommand(current => ({ point: location.sample!, token: (current?.token ?? 0) + 1 }))}>CENTRA SU DI TE</button>}
      {canStop && <button type="button" className="match-area-map__stop" onClick={location.stop}>STOP GPS</button>}
    </div>
    <p className="match-area-map__legend"><span><i className="legend-center" /> Centro del campo</span><span><i className="legend-device" /> Dispositivo</span><span>Partecipanti demo non localizzati</span></p>
  </section>;
}
