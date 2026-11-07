import { useCallback, useEffect, useRef, useState } from 'react';
import { MODE_IDS, MODE_PRESETS, type ModeId } from '../packages/game-core/src/modes';

type Session = { playerId: string; displayName: string };
type Player = { id: string; displayName: string; ready: boolean; connected: boolean };
type Snapshot = {
  matchId: string; inviteCode: string; inviteUrl?: string; hostPlayerId: string; viewerPlayerId: string;
  isHost: boolean; revision: number; phase: string; config: { modeId: ModeId; playerCap: number; radiusMeters: number; durationSeconds: number };
  players: Player[]; capabilities?: { start: boolean; gameplay: boolean };
};
type ServiceState = 'checking' | 'unconfigured' | 'unavailable' | 'ready';
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
  const [service, setService] = useState<ServiceState>(API_BASE ? 'checking' : 'unconfigured');
  const [serviceMessage, setServiceMessage] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [modeId, setModeId] = useState<ModeId>('classic-hide-and-seek');
  const [playerCap, setPlayerCap] = useState(8);
  const [radiusMeters, setRadiusMeters] = useState(500);
  const [durationMinutes, setDurationMinutes] = useState(20);
  const [inviteCode, setInviteCode] = useState(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('code') ?? '');
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const currentRevision = useRef(0);

  const checkService = useCallback(async () => {
    if (!API_BASE) { setService('unconfigured'); return; }
    try {
      await request('/v1/health');
      setService('ready');
      setServiceMessage('Connessione protetta disponibile. Le modalità restano in sviluppo; la lobby online è reale.');
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
    if (!API_BASE) return;
    let disposed = false;
    void request<{ session: Session; match: Snapshot | null }>('/v1/guest-sessions/current')
      .then(restored => {
        if (disposed) return;
        setSession(restored.session);
        setSnapshot(restored.match);
      })
      .catch(() => { /* An absent/expired session returns the user to the entry screen. */ });
    return () => { disposed = true; };
  }, []);

  useEffect(() => { currentRevision.current = snapshot?.revision ?? 0; }, [snapshot?.revision]);

  useEffect(() => {
    if (!session || !snapshot) return;
    let disposed = false;
    let retryTimer = 0;
    let socket: WebSocket | null = null;
    let retry = 0;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(apiSocketUrl(snapshot.matchId));
      socket.addEventListener('open', () => {
        retry = 0;
        socket?.send(JSON.stringify({ type: 'session.authenticate' }));
      });
      socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(String(event.data)) as { type: string; payload?: Snapshot; snapshot?: Snapshot };
          if (message.type === 'match.snapshot' && message.payload) setSnapshot(message.payload);
          if (message.type === 'command.ack' && message.snapshot) setSnapshot(message.snapshot);
        } catch { /* Ignore malformed frames; the next authorized snapshot repairs view state. */ }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        retry += 1;
        retryTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(retry, 5)));
      });
    };
    connect();
    return () => { disposed = true; window.clearTimeout(retryTimer); socket?.close(); };
  }, [session?.playerId, snapshot?.matchId]);

  async function createGuest() {
    const cleanName = displayName.trim();
    if (cleanName.length < 2) throw new Error('Inserisci un nome da 2 a 32 caratteri.');
    return request<Session>('/v1/guest-sessions', { displayName: cleanName });
  }

  async function createLobby(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const guest = await createGuest();
      const lobby = await request<Snapshot>('/v1/lobbies', { modeId, playerCap, radiusMeters, durationSeconds: durationMinutes * 60 });
      setSession(guest); setSnapshot(lobby);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Creazione lobby non riuscita.'); }
    finally { setBusy(false); }
  }

  async function joinLobby(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const guest = await createGuest();
      const lobby = await request<Snapshot>(`/v1/lobbies/${encodeURIComponent(inviteCode.trim().toUpperCase())}/join`, {});
      setSession(guest); setSnapshot(lobby);
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
      setSnapshot(result.snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Stato READY non confermato.'); }
    finally { setBusy(false); }
  }

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
  const canConnect = service === 'ready' && !busy;

  return <main className="online-shell">
    <header className="online-header"><a className="online-brand" href="#/"><span className="online-emblem">H</span><span>HUNT<span>ZONE</span><small>REAL PEOPLE · REAL WORLD</small></span></a><div className={`online-service online-service--${service}`}><i />{service === 'ready' ? 'SERVIZIO CONNESSO' : service === 'checking' ? 'VERIFICA SERVIZIO' : 'SERVIZIO NON DISPONIBILE'}</div></header>
    {!snapshot ? <section className="online-content">
      <div className="online-hero"><p className="eyebrow"><span>01</span><i /> MULTIPLAYER GPS · PERSONE REALI</p><h1>Il campo è<br /><em>la città.</em></h1><p className="online-lead">Crea una lobby privata e invita i tuoi amici. Ogni nome nella lobby appartiene a una persona realmente collegata.</p><div className="online-truth"><span>NESSUN BOT</span><span>NESSUNA PARTITA SIMULATA</span><span>GPS SOLO CON CONSENSO</span></div></div>
      {service !== 'ready' && <section className="service-unavailable" role="status"><strong>SERVIZIO MULTIPLAYER NON DISPONIBILE</strong><p>{serviceMessage || 'Controllo della connessione in corso.'}</p>{service === 'unconfigured' && <small>Per collegarlo, configura VITE_API_BASE_URL nel build del client.</small>}</section>}
      <div className="online-forms">
        <form className="online-card" onSubmit={createLobby}>
          <div className="online-card-title"><span>01 / HOST</span><h2>Crea una lobby</h2></div>
          <label>Il tuo nome<input required minLength={2} maxLength={32} value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Come ti vedranno gli amici" /></label>
          <label>Modalità<select value={modeId} onChange={event => { const next = event.target.value as ModeId; setModeId(next); setPlayerCap(MODE_PRESETS[next].minPlayers); }}>
            {modeOptions.map(id => <option key={id} value={id}>{MODE_PRESETS[id].displayName} · IN SVILUPPO</option>)}
          </select></label>
          <p className="online-dev-note">La lobby consente di provare inviti e READY reali. Avvio partita e gameplay restano disabilitati finché le regole server-authoritative non sono completate.</p>
          <div className="online-form-grid"><label>Posti<input type="number" min={MODE_PRESETS[modeId].minPlayers} max={MODE_PRESETS[modeId].maxPlayers} value={playerCap} onChange={event => setPlayerCap(Number(event.target.value))} /></label><label>Campo · metri<input type="number" min={100} max={3000} step={100} value={radiusMeters} onChange={event => setRadiusMeters(Number(event.target.value))} /></label></div>
          <label>Durata prevista · minuti<input type="number" min={10} max={120} value={durationMinutes} onChange={event => setDurationMinutes(Number(event.target.value))} /></label>
          <button className="online-button online-button--primary" disabled={!canConnect} type="submit">{busy ? 'CONNESSIONE…' : 'CREA LOBBY REALE'}<span>↗</span></button>
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
      <p className="online-footnote">Per ora le sei modalità sono in sviluppo. Il client non mostra partecipanti inventati e non dichiara giocabile una lobby.</p>
    </section> : <section className="online-content online-lobby">
      <div className="online-lobby-head"><p className="eyebrow"><span>02</span><i /> LOBBY PRIVATA · PERSONE COLLEGATE</p><h1>La squadra<br /><em>si raduna.</em></h1><p>Ogni partecipante qui sotto ha effettuato l'accesso con una sessione reale.</p></div>
      <div className="online-invite"><div><small>CODICE INVITO</small><strong>{snapshot.inviteCode}</strong><span>{snapshot.inviteUrl}</span></div><button className="online-button online-button--secondary" onClick={() => void copyInvite()}>{copied ? 'COPIATO' : 'CONDIVIDI INVITO'} ↗</button></div>
      <div className="online-lobby-grid"><section className="online-card"><div className="online-card-title"><span>{snapshot.players.length} / {snapshot.config.playerCap} PARTECIPANTI REALI</span><h2>Lobby {snapshot.phase.toUpperCase()}</h2></div><ul className="online-roster">{snapshot.players.map(player => <li key={player.id} data-connected={player.connected}><span className="online-avatar">{player.displayName.slice(0, 1).toUpperCase()}</span><span className="online-player-name">{player.displayName}{player.id === snapshot.hostPlayerId && <small>HOST</small>}{player.id === snapshot.viewerPlayerId && <small>TU</small>}</span><span className={`online-player-state ${!player.connected ? 'is-disconnected' : player.ready ? 'is-ready' : ''}`}>{!player.connected ? 'RICONNESSIONE' : player.ready ? 'READY' : 'IN ATTESA'}</span></li>)}</ul><button className="online-button online-button--primary" disabled={busy} onClick={() => void setReady(!snapshot.players.find(player => player.id === snapshot.viewerPlayerId)?.ready)}>{snapshot.players.find(player => player.id === snapshot.viewerPlayerId)?.ready ? 'ANNULLA READY' : 'CONFERMA READY'}</button><p className="online-dev-note">L'avvio è disabilitato: manca ancora il motore multiplayer completo per {mode.displayName}.</p></section><aside className="online-card online-status-card"><span className="status-dot status-dot--green" /><strong>NESSUN BOT</strong><p>I partecipanti vengono dal server e spariscono solo quando escono o perdono la connessione. Una disconnessione non conta come cattura.</p><p><b>Stato rete:</b> riconnessione automatica attiva</p><p><b>GPS:</b> non richiesto in lobby</p></aside></div>
      {error && <p className="online-error" role="alert">{error}</p>}
    </section>}
    <footer className="online-footer">HUNTZONE © 2026 <span>GIOCA CON ATTENZIONE · STOP IN QUALSIASI MOMENTO</span></footer>
  </main>;
}
