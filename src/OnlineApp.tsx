import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { MODE_IDS, MODE_PRESETS, type ModeId } from '../packages/game-core/src/modes';
import { useLocation } from './location/LocationProvider';
import type { GeoCoordinate } from './location/geolocation';
import type { MapLoadStatus } from './map/StadiaMap';

const GeoAreaPicker = lazy(() => import('./GeoAreaPicker'));
const StadiaMap = lazy(() => import('./map/StadiaMap'));

type Session = { playerId: string; displayName: string };
type Player = { id: string; displayName: string; ready: boolean; connected: boolean; status?: string };
type Snapshot = {
  matchId: string; inviteCode: string; inviteUrl?: string; hostPlayerId: string; viewerPlayerId: string;
  isHost: boolean; revision: number; phase: string; pausedFromPhase?: string; countdownEndsAt?: string | null;
  roleId?: string; teamId?: string | null; virtualStatus?: string; captureAvailableAt?: string; deadlineAt?: string;
  capturePin?: string; captureTargets?: Array<{ id: string; displayName: string; gpsReady: boolean }>; winner?: string | null; endReason?: string | null;
  areaCenter?: GeoCoordinate | null; gpsConsent?: boolean; gpsReady?: boolean;
  config: { modeId: ModeId; playerCap: number; radiusMeters: number; durationSeconds: number; captureMethod: 'radius' | 'pin' | 'automatic' };
  players: Player[]; capabilities?: { start: boolean; roles: boolean; gameplay: boolean; capture?: boolean };
};
type ServiceState = 'checking' | 'unconfigured' | 'unavailable' | 'ready';
type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const modeOptions: ModeId[] = [...MODE_IDS];

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `Servizio non disponibile (${response.status}).`);
  return payload;
}

function apiSocketUrl(matchId: string) {
  const url = new URL(`${API_BASE}/v1/matches/${matchId}/stream`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export default function OnlineApp() {
  const location = useLocation();
  const [service, setService] = useState<ServiceState>(API_BASE ? 'checking' : 'unconfigured');
  const [serviceMessage, setServiceMessage] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [modeId, setModeId] = useState<ModeId>('classic-hide-and-seek');
  const [playerCap, setPlayerCap] = useState(8);
  const [radiusMeters, setRadiusMeters] = useState(500);
  const [captureMethod, setCaptureMethod] = useState<'radius' | 'pin' | 'automatic'>('radius');
  const [areaCenter, setAreaCenter] = useState<GeoCoordinate | null>(null);
  const [areaCenterSource, setAreaCenterSource] = useState<'map' | 'device' | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [gpsUploadStatus, setGpsUploadStatus] = useState('GPS non condiviso');
  const [durationMinutes, setDurationMinutes] = useState(20);
  const [inviteCode, setInviteCode] = useState(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('code') ?? '');
  const [session, setSession] = useState<Session | null>(null);
  const [sessionRestoring, setSessionRestoring] = useState(Boolean(API_BASE));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('offline');
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [capturePin, setCapturePin] = useState('');
  const [nowMs, setNowMs] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const currentRevision = useRef(0);
  const gpsSequence = useRef(0);
  const gpsRevocationInFlight = useRef(false);
  const latestGpsUpload = useRef<{ matchId: string; sample: NonNullable<typeof location.sample> } | null>(null);
  const gpsUploadInFlight = useRef(false);

  const applySnapshot = useCallback((incoming: Snapshot) => {
    setSnapshot(current => current && current.matchId === incoming.matchId && current.revision > incoming.revision ? current : incoming);
  }, []);

  const queueGpsUpload = useCallback((matchId: string, sample: NonNullable<typeof location.sample>) => {
    latestGpsUpload.current = { matchId, sample };
    if (gpsUploadInFlight.current) return;
    gpsUploadInFlight.current = true;
    void (async () => {
      while (latestGpsUpload.current) {
        const next = latestGpsUpload.current;
        latestGpsUpload.current = null;
        const key = `huntzone-gps-sequence:${next.matchId}`;
        let previous = 0;
        try { previous = Number(window.localStorage.getItem(key) ?? 0); } catch { /* In-memory sequence is sufficient for this tab. */ }
        const sequence = Math.max(gpsSequence.current, previous) + 1;
        gpsSequence.current = sequence;
        try { window.localStorage.setItem(key, String(sequence)); } catch { /* Sequence remains monotonic for this tab. */ }
        try {
          const result = await request<{ status: string; accuracyMeters: number }>(`/v1/matches/${next.matchId}/location`, {
            latitude: next.sample.latitude, longitude: next.sample.longitude, accuracyMeters: next.sample.accuracyMeters,
            sequence, timestampMs: next.sample.timestampMs,
          });
          setGpsUploadStatus(`GPS verificato dal server · ±${Math.round(result.accuracyMeters)} m`);
        } catch (cause) {
          setGpsUploadStatus(cause instanceof Error ? cause.message : 'GPS in attesa di un campione valido');
        }
      }
    })().finally(() => { gpsUploadInFlight.current = false; });
  }, []);

  const checkService = useCallback(async () => {
    if (!API_BASE) { setService('unconfigured'); return; }
    try {
      await request('/v1/health');
      setService('ready');
      setServiceMessage('Connessione protetta disponibile. Classic Hide & Seek è attivo; le altre cinque modalità sono in sviluppo.');
    } catch {
      setService('unavailable');
      setServiceMessage('Il servizio multiplayer non risponde. Non verrà avviata una partita locale o simulata.');
    }
  }, []);

  useEffect(() => {
    void checkService();
    if (!API_BASE) return;
    const interval = window.setInterval(() => { void checkService(); }, 15_000);
    return () => window.clearInterval(interval);
  }, [checkService]);

  useEffect(() => {
    if (!API_BASE) { setSessionRestoring(false); return; }
    let disposed = false;
    void request<{ session: Session; match: Snapshot | null }>('/v1/guest-sessions/current')
      .then(restored => {
        if (disposed) return;
        setSession(restored.session);
        if (restored.match) applySnapshot(restored.match);
      })
      .catch(() => { /* An absent/expired session returns the user to the entry screen. */ })
      .finally(() => { if (!disposed) setSessionRestoring(false); });
    return () => { disposed = true; };
  }, [applySnapshot]);

  useEffect(() => { currentRevision.current = snapshot?.revision ?? 0; }, [snapshot?.revision]);

  useEffect(() => {
    if (!snapshot || !['countdown', 'active'].includes(snapshot.phase)) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.phase, snapshot?.matchId]);

  useEffect(() => {
    if (!session || !snapshot || !snapshot.gpsConsent || snapshot.virtualStatus !== 'active'
      || !['lobby', 'countdown', 'active'].includes(snapshot.phase) || !location.sample || location.status !== 'ACTIVE') {
      latestGpsUpload.current = null;
      return;
    }
    queueGpsUpload(snapshot.matchId, location.sample);
  }, [location.sample, location.status, queueGpsUpload, session?.playerId, snapshot?.gpsConsent, snapshot?.matchId, snapshot?.phase, snapshot?.virtualStatus]);

  useEffect(() => {
    if (snapshot && (snapshot.virtualStatus === 'captured' || snapshot.virtualStatus === 'withdrawn' || ['completed', 'cancelled'].includes(snapshot.phase))) location.stop();
  }, [snapshot?.phase, snapshot?.virtualStatus, location.stop]);

  useEffect(() => {
    if (location.status !== 'DENIED' || !snapshot?.gpsConsent || gpsRevocationInFlight.current) return;
    gpsRevocationInFlight.current = true;
    setGpsUploadStatus('Permesso posizione negato · consenso in revoca');
    void revokeGps().finally(() => { gpsRevocationInFlight.current = false; });
  }, [location.status, snapshot?.gpsConsent]);

  useEffect(() => {
    if (!session || !snapshot) return;
    let disposed = false;
    let retryTimer = 0;
    let socket: WebSocket | null = null;
    let retry = 0;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(apiSocketUrl(snapshot.matchId));
      setSocketStatus(retry ? 'reconnecting' : 'connecting');
      socket.addEventListener('open', () => {
        socket?.send(JSON.stringify({ type: 'session.authenticate' }));
      });
      socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(String(event.data)) as { type: string; payload?: Snapshot; snapshot?: Snapshot };
          if (message.type === 'match.snapshot' && message.payload) { applySnapshot(message.payload); retry = 0; setSocketStatus('connected'); }
          if (message.type === 'command.ack' && message.snapshot) applySnapshot(message.snapshot);
        } catch { /* Ignore malformed frames; the next authorized snapshot repairs view state. */ }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        retry += 1;
        setSocketStatus('reconnecting');
        void request<Snapshot>(`/v1/matches/${snapshot.matchId}`).then(applySnapshot).catch(() => undefined);
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retry, 5));
        retryTimer = window.setTimeout(connect, delay * (0.75 + Math.random() * 0.5));
      });
    };
    connect();
    return () => { disposed = true; window.clearTimeout(retryTimer); socket?.close(); };
  }, [applySnapshot, session?.playerId, snapshot?.matchId]);

  async function createGuest() {
    const cleanName = displayName.trim();
    if (cleanName.length < 2) throw new Error('Inserisci un nome da 2 a 32 caratteri.');
    return request<Session>('/v1/guest-sessions', { displayName: cleanName });
  }

  async function createLobby(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!areaCenter) throw new Error('Scegli il centro del campo sulla mappa prima di creare la lobby.');
      if (!mapReady) throw new Error('La mappa non è pronta. Attendi il caricamento prima di creare la lobby.');
      location.stop();
      const guest = await createGuest();
      const lobby = await request<Snapshot>('/v1/lobbies', { modeId, playerCap, radiusMeters, durationSeconds: durationMinutes * 60, captureMethod, centerLatitude: areaCenter.latitude, centerLongitude: areaCenter.longitude });
      setSession(guest); applySnapshot(lobby);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Creazione lobby non riuscita.'); }
    finally { setBusy(false); }
  }

  async function joinLobby(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const guest = await createGuest();
      const lobby = await request<Snapshot>(`/v1/lobbies/${encodeURIComponent(inviteCode.trim().toUpperCase())}/join`, {});
      setSession(guest); applySnapshot(lobby);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Accesso lobby non riuscito.'); }
    finally { setBusy(false); }
  }

  async function setReady(ready: boolean) {
    if (!session || !snapshot) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/ready`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current, ready,
      });
      applySnapshot(result.snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Stato READY non confermato.'); }
    finally { setBusy(false); }
  }

  async function startMatch() {
    if (!session || !snapshot) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/start`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current,
      });
      applySnapshot(result.snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Avvio non confermato dal server.'); }
    finally { setBusy(false); }
  }

  async function captureTarget() {
    if (!snapshot || !selectedTargetId) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/capture`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current, targetPlayerId: selectedTargetId,
        ...(snapshot.config.captureMethod === 'pin' ? { pin: capturePin } : {}),
      });
      applySnapshot(result.snapshot); setCapturePin('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cattura non confermata dal server.'); }
    finally { setBusy(false); }
  }

  async function prepareGps() {
    if (!session || !snapshot) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/location-consent`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current, granted: true,
      });
      applySnapshot(result.snapshot);
      location.start();
      setGpsUploadStatus('In attesa di un campione recente e preciso…');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Consenso GPS non registrato.'); }
    finally { setBusy(false); }
  }

  async function revokeGps() {
    if (!session || !snapshot || !snapshot.gpsConsent) return;
    location.stop();
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/location-consent`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current, granted: false,
      });
      applySnapshot(result.snapshot);
      setGpsUploadStatus('Consenso revocato · campione rimosso dal server');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Revoca GPS non registrata.'); }
    finally { setBusy(false); }
  }

  async function leaveMatch() {
    if (!session || !snapshot) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ removedFromLobby: boolean; snapshot: Snapshot | null }>(`/v1/matches/${snapshot.matchId}/leave`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current,
      });
      location.stop();
      if (result.removedFromLobby || !result.snapshot) { setSnapshot(null); setSession(null); }
      else applySnapshot(result.snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Uscita non registrata.'); }
    finally { setBusy(false); }
  }

  async function cancelLobby() {
    if (!session || !snapshot || !snapshot.isHost) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/cancel`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current,
      });
      location.stop();
      applySnapshot(result.snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Annullamento lobby non confermato.'); }
    finally { setBusy(false); }
  }

  async function resumeMatch() {
    if (!session || !snapshot || !snapshot.isHost || snapshot.phase !== 'paused') return;
    setBusy(true); setError('');
    try {
      const result = await request<{ snapshot: Snapshot }>(`/v1/matches/${snapshot.matchId}/resume`, {
        commandId: crypto.randomUUID(), expectedRevision: currentRevision.current,
      });
      applySnapshot(result.snapshot);
      setGpsUploadStatus('Pausa terminata · occorrono nuovi campioni GPS');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ripresa non confermata dal server.'); }
    finally { setBusy(false); }
  }

  function changeAreaCenter(center: GeoCoordinate | null, source: 'map' | 'device' | null) {
    setAreaCenter(center);
    setAreaCenterSource(source);
    // Area selection is a one-time opt-in. Do not keep watching the device during the lobby.
    location.stop();
  }

  const onMapStatusChange = useCallback((status: MapLoadStatus) => {
    setMapReady(status === 'READY' || status === 'DEGRADED');
  }, []);

  async function copyInvite() {
    if (!snapshot) return;
    try {
      const invite = snapshot.inviteUrl
        ? new URL(snapshot.inviteUrl, window.location.origin).href
        : `${window.location.origin}/#/join?code=${snapshot.inviteCode}`;
      await navigator.clipboard.writeText(invite);
      setCopied(true); window.setTimeout(() => setCopied(false), 1800);
    } catch { setError('Copia non disponibile: condividi il codice invito.'); }
  }

  const mode = snapshot ? MODE_PRESETS[snapshot.config.modeId] : MODE_PRESETS[modeId];
  const canConnect = service === 'ready' && !busy && !sessionRestoring;

  return <main className="online-shell">
    <header className="online-header"><a className="online-brand" href="#/"><span className="online-emblem">H</span><span>HUNT<span>ZONE</span><small>REAL PEOPLE · REAL WORLD</small></span></a><div className={`online-service online-service--${service}`}><i />{service === 'ready' ? 'SERVIZIO CONNESSO' : service === 'checking' ? 'VERIFICA SERVIZIO' : 'SERVIZIO NON DISPONIBILE'}</div></header>
    {sessionRestoring && !snapshot ? <section className="online-content" aria-live="polite"><p className="online-dev-note">Ripristino della sessione e della partita…</p></section> : !snapshot ? <section className="online-content">
      <div className="online-hero"><p className="eyebrow"><span>01</span><i /> MULTIPLAYER GPS · PERSONE REALI</p><h1>Il campo è<br /><em>la città.</em></h1><p className="online-lead">Crea una lobby privata e invita i tuoi amici. Ogni nome nella lobby appartiene a una persona realmente collegata.</p><div className="online-truth"><span>NESSUN BOT</span><span>NESSUNA PARTITA SIMULATA</span><span>GPS SOLO CON CONSENSO</span></div></div>
      {service !== 'ready' && <section className="service-unavailable" role="status"><strong>SERVIZIO MULTIPLAYER NON DISPONIBILE</strong><p>{serviceMessage || 'Controllo della connessione in corso.'}</p>{service === 'unconfigured' && <small>Per collegarlo, configura VITE_API_BASE_URL nel build del client.</small>}</section>}
      <div className="online-forms">
        <form className="online-card" onSubmit={createLobby}>
          <div className="online-card-title"><span>01 / HOST</span><h2>Crea una lobby</h2></div>
          <label>Il tuo nome<input required minLength={2} maxLength={32} value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Come ti vedranno gli amici" /></label>
          {service === 'ready' && <Suspense fallback={<p className="online-dev-note">Caricamento mappa del campo…</p>}><GeoAreaPicker center={areaCenter} centerSource={areaCenterSource} radiusMeters={radiusMeters} onCenterChange={changeAreaCenter} onMapStatusChange={onMapStatusChange} /></Suspense>}
          <label>Modalità<select value={modeId} onChange={event => { const next = event.target.value as ModeId; setModeId(next); setPlayerCap(MODE_PRESETS[next].minPlayers); }}>
            {modeOptions.map(id => <option key={id} value={id} disabled={id !== 'classic-hide-and-seek'}>{MODE_PRESETS[id].displayName}{id === 'classic-hide-and-seek' ? '' : ' · IN SVILUPPO'}</option>)}
          </select></label>
          <p className="online-dev-note">CLASSIC è giocabile con tre persone collegate. Le altre cinque modalità sono ancora in sviluppo.</p>
          <div className="online-form-grid"><label>Posti<input type="number" min={MODE_PRESETS[modeId].minPlayers} max={MODE_PRESETS[modeId].maxPlayers} value={playerCap} onChange={event => setPlayerCap(Number(event.target.value))} /></label><label>Campo · metri<input type="number" min={100} max={3000} step={100} value={radiusMeters} onChange={event => setRadiusMeters(Number(event.target.value))} /></label></div>
          <label>Durata prevista · minuti<input type="number" min={10} max={120} value={durationMinutes} onChange={event => setDurationMinutes(Number(event.target.value))} /></label>
          <label>Sistema di cattura<select value={captureMethod} onChange={event => setCaptureMethod(event.target.value as typeof captureMethod)}><option value="radius">RAGGIO</option><option value="pin">PIN + prossimità</option><option value="automatic">AUTOMATICA</option></select></label>
          <button className="online-button online-button--primary" disabled={!canConnect || !areaCenter || !mapReady} type="submit">{busy ? 'CONNESSIONE…' : 'CREA LOBBY REALE'}<span>↗</span></button>
        </form>
        <form className="online-card online-card--join" onSubmit={joinLobby}>
          <div className="online-card-title"><span>02 / INVITATO</span><h2>Unisciti con un codice</h2></div>
          <label>Il tuo nome<input required minLength={2} maxLength={32} value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Come ti vedranno gli amici" /></label>
          <label>Codice invito<input required autoComplete="off" maxLength={8} value={inviteCode} onChange={event => setInviteCode(event.target.value.toUpperCase())} placeholder="ES. 8K4M2Q" /></label>
          <p className="online-dev-note">Il codice apre una lobby ospitata da un'altra persona. La tua presenza viene aggiunta soltanto dopo l'accesso effettivo.</p>
          <button className="online-button online-button--secondary" disabled={!canConnect} type="submit">{busy ? 'CONNESSIONE…' : 'UNISCITI ALLA LOBBY'}<span>→</span></button>
        </form>
      </div>
      {error && <p className="online-error" role="alert">{error}</p>}
      <p className="online-footnote">Classic richiede almeno tre persone reali, GPS consentito e posizione verificata. Le altre modalità sono ancora in sviluppo; nessun bot o giocatore simulato entra nelle lobby.</p>
    </section> : <section className="online-content online-lobby">
      <div className="online-lobby-head"><p className="eyebrow"><span>02</span><i /> LOBBY PRIVATA · PERSONE COLLEGATE</p><h1>La squadra<br /><em>si raduna.</em></h1><p>Ogni partecipante qui sotto ha effettuato l'accesso con una sessione reale.</p></div>
      <div className="online-invite"><div><small>CODICE INVITO</small><strong>{snapshot.inviteCode}</strong><span>{snapshot.inviteUrl}</span></div><button className="online-button online-button--secondary" onClick={() => void copyInvite()}>{copied ? 'COPIATO' : 'CONDIVIDI INVITO'} ↗</button></div>
      <div className="online-lobby-grid"><section className="online-card"><div className="online-card-title"><span>{snapshot.players.length} / {snapshot.config.playerCap} PARTECIPANTI REALI</span><h2>{snapshot.phase === 'active' ? 'PARTITA IN CORSO' : snapshot.phase === 'countdown' ? 'CONTO ALLA ROVESCIA' : `LOBBY ${snapshot.phase.toUpperCase()}`}</h2></div><ul className="online-roster">{snapshot.players.map(player => <li key={player.id} data-connected={player.connected}><span className="online-avatar">{player.displayName.slice(0, 1).toUpperCase()}</span><span className="online-player-name">{player.displayName}{player.id === snapshot.hostPlayerId && <small>HOST</small>}{player.id === snapshot.viewerPlayerId && <small>TU</small>}</span><span className={`online-player-state ${!player.connected ? 'is-disconnected' : player.ready ? 'is-ready' : ''}`}>{!player.connected ? 'RICONNESSIONE' : player.ready ? 'READY' : 'IN ATTESA'}</span></li>)}</ul>{snapshot.phase === 'lobby' && snapshot.isHost && <Suspense fallback={<p className="online-dev-note">Verifica la mappa dell’area…</p>}><StadiaMap center={snapshot.areaCenter ?? null} radiusMeters={snapshot.config.radiusMeters} deviceSample={null} focusCommand={null} onChooseCenter={() => undefined} onStatusChange={onMapStatusChange} /></Suspense>}{snapshot.phase === 'lobby' && <><button className="online-button online-button--primary" disabled={busy} onClick={() => void setReady(!snapshot.players.find(player => player.id === snapshot.viewerPlayerId)?.ready)}>{snapshot.players.find(player => player.id === snapshot.viewerPlayerId)?.ready ? 'ANNULLA READY' : 'CONFERMA READY'}</button><button className="online-button online-button--secondary" disabled={busy} onClick={() => void leaveMatch()}>ESCI DALLA LOBBY</button>{snapshot.gpsConsent ? <div className="gps-preparation"><b>{gpsUploadStatus}</b><p>La posizione esatta resta volatile durante la partita. Il server non invia coordinate di avversari al client.</p><button className="online-button online-button--secondary" disabled={busy} onClick={() => void revokeGps()}>REVOCA GPS E FERMA</button></div> : <button className="online-button online-button--secondary" disabled={busy || !snapshot.players.find(player => player.id === snapshot.viewerPlayerId)?.ready} onClick={() => void prepareGps()}>CONSENTI GPS E PREPARA</button>}{snapshot.isHost && <button className="online-button online-button--secondary" disabled={busy || !snapshot.capabilities?.start || !mapReady} onClick={() => void startMatch()}>AVVIA CLASSIC · 10 SEC</button>}{snapshot.isHost && <button className="online-button online-button--secondary" disabled={busy} onClick={() => void cancelLobby()}>ANNULLA LOBBY</button>}<p className="online-dev-note">{mode.displayName}: servono area selezionata, almeno tre giocatori connessi e READY, consenso GPS e campioni affidabili di tutti.</p></>}{snapshot.phase === 'countdown' && <div className="online-dev-note"><button className="online-button online-button--secondary" disabled={busy} onClick={() => void leaveMatch()}>ESCI DALLA PARTITA</button>{snapshot.isHost && <button className="online-button online-button--secondary" disabled={busy} onClick={() => void cancelLobby()}>ANNULLA LOBBY</button>}<b>PARTENZA TRA {Math.max(0, Math.ceil((Date.parse(snapshot.countdownEndsAt ?? '') - nowMs) / 1000))} SEC</b><p>Il server assegnerà i ruoli quando scade il conto alla rovescia.</p><b>{gpsUploadStatus}</b>{snapshot.gpsConsent && <button className="online-button online-button--secondary" disabled={busy} onClick={() => void revokeGps()}>REVOCA GPS E ANNULLA AVVIO</button>}</div>}{snapshot.phase === 'paused' && <div className="online-dev-note" role="status"><b>PARTITA IN PAUSA · HOST DISCONNESSO</b><p>La raccolta GPS è ferma. Le posizioni precedenti non saranno riutilizzate alla ripresa.</p>{snapshot.isHost && <button className="online-button online-button--primary" disabled={busy} onClick={() => void resumeMatch()}>RIPRENDI PARTITA</button>}<button className="online-button online-button--secondary" disabled={busy} onClick={() => void leaveMatch()}>ESCI DALLA PARTITA</button>{snapshot.gpsConsent && <button className="online-button online-button--secondary" disabled={busy} onClick={() => void revokeGps()}>REVOCA GPS E RITIRATI</button>}{snapshot.isHost && <button className="online-button online-button--secondary" disabled={busy} onClick={() => void cancelLobby()}>ANNULLA PARTITA</button>}</div>}{snapshot.phase === 'active' && (snapshot.virtualStatus === 'captured' || snapshot.virtualStatus === 'withdrawn') && <div className="online-dev-note" role="status"><b>{snapshot.virtualStatus === 'captured' ? 'SEI FUORI DAL GIOCO · SPETTATORE' : 'TI SEI RITIRATO · SPETTATORE'}</b><p>Il tracciamento GPS è fermato. Puoi seguire il risultato della partita.</p></div>}{snapshot.phase === 'active' && snapshot.virtualStatus !== 'captured' && <><div className="online-dev-note"><b>Il tuo ruolo: {snapshot.roleId?.toUpperCase() ?? 'IN CARICAMENTO'}</b><p>Tempo rimanente: {Math.floor(Math.max(0, Date.parse(snapshot.deadlineAt ?? '') - nowMs) / 60000)}:{String(Math.floor(Math.max(0, Date.parse(snapshot.deadlineAt ?? '') - nowMs) / 1000) % 60).padStart(2, '0')} · {gpsUploadStatus}</p>{snapshot.captureAvailableAt && nowMs < Date.parse(snapshot.captureAvailableAt) && <p>Vantaggio HIDER: {Math.ceil((Date.parse(snapshot.captureAvailableAt) - nowMs) / 1000)} secondi.</p>}{snapshot.roleId === 'hider' && snapshot.config.captureMethod === 'pin' && <p>PIN personale da comunicare solo al contatto fisico con il SEEKER: <strong>{snapshot.capturePin ?? 'in caricamento'}</strong></p>}{snapshot.roleId === 'seeker' && snapshot.config.captureMethod !== 'automatic' && <div className="gps-preparation"><label>BERSAGLIO<select value={selectedTargetId} onChange={event => setSelectedTargetId(event.target.value)}><option value="">Scegli HIDER vicino</option>{snapshot.captureTargets?.map(target => <option key={target.id} value={target.id} disabled={!target.gpsReady}>{target.displayName}{target.gpsReady ? '' : ' · GPS IN ATTESA'}</option>)}</select></label>{snapshot.config.captureMethod === 'pin' && <label>PIN TEMPORANEO<input inputMode="numeric" maxLength={6} value={capturePin} onChange={event => setCapturePin(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>}<button className="online-button online-button--primary" disabled={busy || !snapshot.capabilities?.capture || !selectedTargetId || !snapshot.captureTargets?.find(target => target.id === selectedTargetId)?.gpsReady || (snapshot.config.captureMethod === 'pin' && capturePin.length !== 6)} onClick={() => void captureTarget()}>VERIFICA CATTURA GPS</button><p>Il server controlla ruolo, consenso, distanza conservativa, accuratezza e freschezza dei campioni.</p></div>}{snapshot.config.captureMethod === 'automatic' && <p>La cattura si risolve automaticamente dopo 5 secondi di prossimità GPS precisa e continua.</p>}<button className="online-button online-button--secondary" disabled={busy} onClick={() => void leaveMatch()}>ABBANDONA PARTITA</button><button className="online-button online-button--secondary" disabled={busy} onClick={() => void revokeGps()}>REVOCA GPS E RITIRATI</button>{snapshot.gpsConsent && location.status !== 'ACTIVE' && location.status !== 'STALE' && <button className="online-button online-button--primary" disabled={busy} onClick={() => { location.start(); setGpsUploadStatus('Riconnessione GPS in primo piano…'); }}>RIPRENDI GPS</button>}</div><Suspense fallback={<p className="online-dev-note">Caricamento mappa partita…</p>}><StadiaMap center={snapshot.areaCenter ?? null} radiusMeters={snapshot.config.radiusMeters} deviceSample={location.sample} focusCommand={null} onChooseCenter={() => undefined} onStatusChange={onMapStatusChange} /></Suspense></>}{['completed', 'cancelled'].includes(snapshot.phase) && <div className="online-dev-note"><h3>{snapshot.phase === 'completed' ? `VITTORIA: ${snapshot.winner?.toUpperCase() ?? 'PAREGGIO'}` : 'PARTITA TERMINATA SENZA VINCITORE'}</h3><p>{snapshot.endReason ?? 'La partita è conclusa.'}</p></div>}</section><aside className="online-card online-status-card"><span className={`status-dot ${socketStatus === 'connected' ? 'status-dot--green' : ''}`} /><strong>NESSUN BOT</strong><p>I partecipanti vengono dal server e spariscono solo quando escono o perdono la connessione. Una disconnessione non conta come cattura.</p><p><b>Stato rete:</b> {socketStatus === 'connected' ? 'connesso' : socketStatus === 'reconnecting' ? 'riconnessione in corso' : socketStatus === 'connecting' ? 'connessione in corso' : 'offline'}</p><p><b>GPS:</b> {snapshot.gpsConsent ? 'consenso registrato per la partita' : 'non attivo'}</p></aside></div>
      {error && <p className="online-error" role="alert">{error}</p>}
    </section>}
    <footer className="online-footer">HUNTZONE © 2026 <span>GIOCA CON ATTENZIONE · STOP IN QUALSIASI MOMENTO</span></footer>
  </main>;
}
