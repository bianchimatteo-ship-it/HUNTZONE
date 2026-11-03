import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import CityMap from './CityMap';
import GeoAreaPicker from './GeoAreaPicker';
import { formatTime, loadSavedConfig, makeMatch, makePlayers, modeCards, saveConfig } from './demo';
import type { GeoCoordinate } from './location/geolocation';
import type { DemoMatch, MatchConfig, Player, Screen } from './types';

const navItems: { id: Screen; icon: string; label: string }[] = [
  { id: 'home', icon: '⌂', label: 'Gioca' },
  { id: 'modes', icon: '◈', label: 'Modalità' },
  { id: 'profile', icon: '◉', label: 'Profilo' },
];

function readRoute(): Screen {
  const route = location.hash.replace(/^#\/?/, '').split('/')[0];
  return (['home', 'modes', 'create', 'lobby', 'game', 'results', 'profile'].includes(route) ? route : 'home') as Screen;
}

function Icon({ children }: { children: string }) { return <span className="icon-glyph" aria-hidden="true">{children}</span>; }

export default function App() {
  const [screen, setScreen] = useState<Screen>(readRoute);
  const [config, setConfig] = useState<MatchConfig>(loadSavedConfig);
  const [match, setMatch] = useState<DemoMatch | null>(null);
  const [toast, setToast] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<{ winner: string; elapsed: string } | null>(null);
  const [gameRoleView, setGameRoleView] = useState<'hunter' | 'runner'>('runner');

  const go = (next: Screen) => {
    setScreen(next);
    location.hash = `/${next}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const onHash = () => setScreen(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (screen !== 'game' || !match) return;
    const id = window.setInterval(() => {
      setMatch(current => {
        if (!current || current.secondsLeft <= 0) return current;
        return { ...current, secondsLeft: current.secondsLeft - 1 };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [screen, match?.code]);

  useEffect(() => {
    if (screen === 'game' && match?.secondsLeft === 0) finishGame(match, 'RUNNERS');
  }, [screen, match?.secondsLeft]);

  const remaining = match?.players.filter(player => !player.captured) ?? [];
  const capturedCount = match?.players.filter(player => player.captured).length ?? 0;

  function updateConfig(patch: Partial<MatchConfig>) {
    setConfig(current => {
      const next = { ...current, ...patch };
      saveConfig(next);
      return next;
    });
  }

  function createLobby() {
    const demo = makeMatch(config);
    setMatch(demo);
    setJoinError('');
    go('lobby');
  }

  function joinLobby() {
    if (!joinCode.trim()) { setJoinError('Inserisci il codice della lobby.'); return; }
    if (match && match.code.toUpperCase() === joinCode.trim().toUpperCase()) {
      go('lobby');
      setJoinError('');
      return;
    }
    setJoinError('Codice non trovato. In questa demo puoi unirti alla lobby creata in questa sessione.');
  }

  function startGame() {
    if (!match) return;
    const players = match.players.map(player => ({ ...player, captured: false, ready: true }));
    const role = Math.random() < 0.35 ? 'hunter' : 'runner';
    setGameRoleView(role);
    setMatch({ ...match, players, role, secondsLeft: match.config.duration * 60, startedAt: Date.now(), events: ['SIMULATION STARTED'] });
    go('game');
  }

  function finishGame(state: DemoMatch, winningSide?: string) {
    const winner = winningSide ?? (state.players.filter(player => !player.captured).length > 1 ? 'RUNNERS' : 'HUNTERS');
    const elapsed = formatTime(state.config.duration * 60 - state.secondsLeft);
    setResult({ winner, elapsed });
    go('results');
  }

  function capturePlayer(id: string) {
    if (!match) return;
    const target = match.players.find(player => player.id === id);
    if (!target || target.isLocal || target.captured) return;
    const next = { ...match, players: match.players.map(player => player.id === id ? { ...player, captured: true } : player), events: [`${target.name.toUpperCase()} TAGGED / DEMO`, ...match.events].slice(0, 4) };
    setMatch(next);
    setToast(`${target.name} catturato nella simulazione`);
    if (next.players.filter(player => !player.captured && !player.isLocal).length === 0) finishGame(next, 'HUNTERS');
  }

  function addDemoPlayer() {
    if (!match || match.players.length >= match.config.maxPlayers) return;
    const id = `guest-${Date.now()}`;
    const names = [['Rae', 'RA'], ['Max', 'MX'], ['Ivy', 'IV'], ['Sam', 'SA']];
    const [name, initials] = names[match.players.length % names.length];
    const player: Player = { id, name, initials, color: '#91ad99', team: match.players.length % 2 ? 'red' : 'green', ready: false, captured: false };
    setMatch({ ...match, players: [...match.players, player] });
  }

  function toggleReady(id: string) {
    if (!match) return;
    setMatch({ ...match, players: match.players.map(player => player.id === id ? { ...player, ready: !player.ready } : player) });
  }

  function rematch() {
    createLobby();
  }

  const title = useMemo(() => ({ home: 'PLAY', modes: 'MODES', create: 'NEW OPERATION', lobby: 'STAGING AREA', game: 'LIVE SIMULATION', results: 'DEBRIEF', profile: 'PLAYER FILE' }[screen]), [screen]);

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand-lockup" onClick={() => go('home')} aria-label="HUNTZONE home">
        <span className="brand-symbol"><i /><i /><i /></span>
        <span className="brand-name">HUNT<span>ZONE</span><small>GPS HIDE & SEEK GAMES</small></span>
      </button>
      <div className="sidebar-status"><span className="status-dot status-dot--yellow" /> PROTOTIPO UI <span className="status-line" /></div>
      <nav className="side-nav" aria-label="Navigazione principale">
        <p className="eyebrow">COMMAND</p>
        {navItems.map(item => <button key={item.id} className={`nav-item ${screen === item.id ? 'is-active' : ''}`} onClick={() => go(item.id)}><Icon>{item.icon}</Icon><span>{item.label}</span>{screen === item.id && <i className="nav-active-mark" />}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="demo-card"><span className="demo-card__top"><span className="status-dot status-dot--yellow" /> DEMO LOCALE</span><p>Le funzioni di gioco<br />sono simulate.</p><span className="demo-card__coords">GPS SOLO SU RICHIESTA</span></div>
        <button className="profile-mini" onClick={() => go('profile')}><span className="avatar avatar--gold">AX</span><span><b>ALEX</b><small>LEVEL 04 · SCOUT</small></span><span className="profile-mini__arrow">↗</span></button>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="topbar__left"><button className="mobile-brand" onClick={() => go('home')}><span className="brand-symbol"><i /><i /><i /></span> HUNTZONE</button><span className="topbar-crumb">HUNTZONE <b>/</b> {title}</span></div>
        <div className="topbar__right"><span className="demo-pill"><i /> DEMO LOCALE</span><span className="topbar-divider" /><span className="topbar-date">GPS FACOLTATIVO · NESSUN MATCH LIVE</span></div>
      </header>

      <div className="content-wrap">
        {screen === 'home' && <Home go={go} joinCode={joinCode} setJoinCode={setJoinCode} joinLobby={joinLobby} joinError={joinError} />}
        {screen === 'modes' && <Modes go={go} updateConfig={updateConfig} />}
        {screen === 'create' && <Create config={config} updateConfig={updateConfig} advanced={advanced} setAdvanced={setAdvanced} createLobby={createLobby} />}
        {screen === 'lobby' && match && <Lobby match={match} addPlayer={addDemoPlayer} toggleReady={toggleReady} startGame={startGame} copyCode={() => { navigator.clipboard?.writeText(match.code); setToast('Codice copiato'); }} />}
        {screen === 'game' && match && <Game match={match} roleView={gameRoleView} setRoleView={setGameRoleView} remaining={remaining} capturedCount={capturedCount} capturePlayer={capturePlayer} toggleRadar={() => { setMatch({ ...match, radarActive: !match.radarActive, events: ['RADAR PULSE / DEMO', ...match.events].slice(0, 4) }); setToast(match.radarActive ? 'Radar disattivato' : 'Impulso radar simulato'); }} completeMission={() => { setMatch({ ...match, missionComplete: true, events: ['MISSION COMPLETE / DEMO', ...match.events].slice(0, 4) }); setToast('Obiettivo completato nella demo'); }} endGame={() => finishGame(match)} />}
        {screen === 'results' && <Results result={result} match={match} rematch={rematch} go={go} />}
        {screen === 'profile' && <Profile go={go} />}
      </div>
      <footer className="app-footer"><span>HUNTZONE <i>©</i> 2026</span><span>GIOCA CON ATTENZIONE</span><span>PROTOTIPO UI 0.2</span></footer>
    </main>
    <nav className="mobile-nav" aria-label="Navigazione mobile">{navItems.map(item => <button key={item.id} className={screen === item.id ? 'is-active' : ''} onClick={() => go(item.id)}><Icon>{item.icon}</Icon><span>{item.label}</span></button>)}<button onClick={() => go(match ? 'lobby' : 'create')}><Icon>＋</Icon><span>Crea</span></button></nav>
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
  </div>;
}

function PageTitle({ index, title, desc, action }: { index: string; title: string; desc: string; action?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow"><span>{index}</span><i /> FIELD OPERATIONS</div><h1>{title}</h1><p>{desc}</p></div>{action}</div>;
}

function Home({ go, joinCode, setJoinCode, joinLobby, joinError }: { go: (screen: Screen) => void; joinCode: string; setJoinCode: (value: string) => void; joinLobby: () => void; joinError: string }) {
  return <div className="home-screen">
    <section className="hero-panel">
      <div className="hero-grid" />
      <div className="hero-map-preview"><CityMap players={makePlayers(4)} compact /></div>
      <div className="hero-copy">
        <div className="eyebrow hero-eyebrow"><span>01</span><i /> IL PROSSIMO NASCONDINO INIZIA QUI</div>
        <h1>THE CITY<br /><em>IS YOUR</em><br /><strong>PLAYGROUND.</strong></h1>
        <p>Una partita di nascondino, portata fuori.<br />Scegli il campo. Raduna la squadra. Dai inizio alla caccia.</p>
        <div className="hero-actions"><button className="button button--primary" onClick={() => go('create')}><span>CREA PARTITA</span><b>↗</b></button><button className="button button--ghost" onClick={() => document.getElementById('join-code')?.focus()}><span>UNISCITI</span><b>⌁</b></button></div>
        <div className="hero-meta"><span><i className="status-dot status-dot--yellow" /> DEMO INTERATTIVA</span><span>SOLO IN QUESTO BROWSER</span><span>GPS SOLO SU RICHIESTA</span></div>
      </div>
      <div className="hero-index"><span>HIDE</span><i /> <span>HUNT</span><i /> <span>OUTLAST</span></div>
    </section>
    <section className="home-lower">
      <div className="join-card">
        <div className="section-heading"><div><div className="eyebrow"><span>02</span><i /> QUICK ACCESS</div><h2>Hai un codice?</h2></div><span className="section-icon">⌁</span></div>
        <p>Usa il codice della lobby creata in questa sessione demo.</p>
        <form className="join-form" onSubmit={event => { event.preventDefault(); joinLobby(); }}><label className="sr-only" htmlFor="join-code">Codice lobby</label><input id="join-code" autoComplete="off" maxLength={6} placeholder="INSERISCI IL CODICE" value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} /><button type="submit" aria-label="Entra con il codice">→</button></form>
        {joinError && <p className="form-error" role="alert">{joinError}</p>}
        <div className="join-foot"><span><i className="status-dot" /> SESSIONE LOCALE</span><span>NESSUN INVITO REALE</span></div>
      </div>
      <button className="mode-feature" onClick={() => go('modes')}><div className="mode-feature__number">03 / MODE SELECT</div><div><span className="feature-tag">CURRENT BUILD</span><h2>CLASSIC<br />HIDE & SEEK</h2><p>Un classico. Nuovo territorio.</p></div><span className="feature-arrow">↗</span><div className="feature-rings" /></button>
      <div className="home-stat"><div className="eyebrow"><span>04</span><i /> IL PROGETTO</div><div className="stat-big">06<span>·</span>01</div><p>MODALITÀ PREVISTE<br /><b>UNA SOLA DEMO LOCALE</b></p><button className="text-link" onClick={() => go('profile')}>VEDI IL PROFILO ESEMPIO <span>↗</span></button></div>
    </section>
    <div className="safety-strip"><span className="safety-mark">✳</span><span>MAPPA REALE FACOLTATIVA. IL GPS SI ATTIVA SOLO SU RICHIESTA; IL GIOCO RESTA UNA DEMO LOCALE.</span><span className="safety-right">PLAY SAFE <b>·</b> STAY AWARE</span></div>
  </div>;
}

function Modes({ go, updateConfig }: { go: (screen: Screen) => void; updateConfig: (patch: Partial<MatchConfig>) => void }) {
  return <div className="screen-stack"><PageTitle index="01 / MODES" title="Scegli il tuo gioco." desc="Ogni modalità cambia le regole della caccia. CLASSIC è l’unica attiva in questa demo." action={<span className="demo-pill"><i /> 01 PLAYABLE · 05 CONCEPTS</span>} />
    <div className="mode-grid">{modeCards.map((mode, index) => <article key={mode.name} className={`mode-card mode-card--${mode.accent} ${mode.live ? 'mode-card--live' : ''}`}><div className="mode-card__top"><span className="mode-number">0{index + 1}</span><span className={`mode-label ${mode.live ? 'mode-label--live' : ''}`}>{mode.live && <i />}{mode.label}</span></div><div className="mode-card__icon">{mode.icon}</div><h2>{mode.name}</h2><p>{mode.detail}</p><div className="mode-card__meta"><span>{mode.players} PLAYERS</span><span>{mode.live ? 'DEMO LOCALE' : 'FUTURE MODE'}</span></div><button className="mode-card__select" disabled={!mode.live} onClick={() => { updateConfig({ mode: mode.name }); go('create'); }}>{mode.live ? 'CONFIGURA MODALITÀ' : 'CONCEPT / NON DISPONIBILE'} <b>↗</b></button></article>)}</div>
    <div className="note-banner"><span>ⓘ</span><p>Le modalità future sono concept. In questa build puoi giocare una simulazione locale di CLASSIC HIDE & SEEK.</p></div>
  </div>;
}

function Create({ config, updateConfig, advanced, setAdvanced, createLobby }: { config: MatchConfig; updateConfig: (patch: Partial<MatchConfig>) => void; advanced: boolean; setAdvanced: (value: boolean) => void; createLobby: () => void }) {
  const [areaCenter, setAreaCenter] = useState<GeoCoordinate | null>(null);
  const [centerSource, setCenterSource] = useState<'map' | 'device' | null>(null);
  const clampRadius = (value: number) => updateConfig({ radius: Math.max(100, Math.min(3000, Math.round(value || 100))) });
  return <div className="screen-stack"><PageTitle index="02 / LOBBY SETUP" title="Prepara il campo." desc="Bastano due scelte per iniziare. Le opzioni avanzate sono facoltative." />
    <div className="create-layout"><div className="create-main">
      <section className="form-panel"><div className="panel-heading"><span className="step-badge">01</span><div><span className="eyebrow">GAME MODE</span><h2>Modalità di gioco</h2></div><span className="current-chip"><i /> DEMO</span></div><button className="selected-mode" onClick={() => {}}><span className="selected-mode__icon">◉</span><span><b>CLASSIC HIDE & SEEK</b><small>Un seeker. Il resto della squadra si nasconde.</small></span><span className="selected-mode__check">✓</span></button>
      <div className="form-row form-row--three"><div className="field"><label htmlFor="players">PLAYER CAP</label><div className="select-wrap"><select id="players" value={config.maxPlayers} onChange={e => updateConfig({ maxPlayers: Number(e.target.value) })}>{[3,4,5,6,7,8].map(n => <option value={n} key={n}>{n} giocatori</option>)}</select><span>⌄</span></div></div><div className="field"><label htmlFor="duration">DURATA</label><div className="select-wrap"><select id="duration" value={config.duration} onChange={e => updateConfig({ duration: Number(e.target.value) })}>{[8,10,12,15,20].map(n => <option value={n} key={n}>{n} minuti</option>)}</select><span>⌄</span></div></div><div className="field"><label>TEAM SETUP</label><button className={`toggle-row ${config.teams ? 'is-on' : ''}`} onClick={() => updateConfig({ teams: !config.teams })}><span>{config.teams ? '2 squadre' : 'Free for all'}</span><i /></button></div></div>
      </section>
      <section className="form-panel geo-form-panel"><div className="panel-heading"><span className="step-badge">02</span><div><span className="eyebrow">PLAY AREA</span><h2>Definisci il campo.</h2></div><span className="demo-tag">STADIA MAPS</span></div><p className="map-privacy-note">La mappa carica cartografia reale della zona visualizzata. Stadia Maps riceve richieste tile; la tua posizione non viene richiesta finché non premi ATTIVA POSIZIONE.</p><GeoAreaPicker center={areaCenter} centerSource={centerSource} radiusMeters={config.radius} onCenterChange={(center, source) => { setAreaCenter(center); setCenterSource(source); }} /><div className="radius-controls"><div className="area-caption"><span>RAGGIO DI GIOCO</span><span className="range-readout">{config.radius}<small>m</small></span></div><p>Ogni valore intero da 100 a 3.000 è selezionabile.</p><input aria-label="Raggio area di gioco" className="range-input" type="range" min="100" max="3000" step="1" value={config.radius} onChange={e => clampRadius(Number(e.target.value))} style={{ '--range-progress': `${((config.radius - 100) / 2900) * 100}%` } as CSSProperties} /><div className="range-foot"><span>100 M</span><label htmlFor="radius-number">RAGGIO PERSONALIZZATO</label><span>3.000 M</span></div><div className="number-field"><label htmlFor="radius-number" className="sr-only">Raggio in metri</label><input id="radius-number" type="number" min="100" max="3000" step="1" value={config.radius} onChange={e => updateConfig({ radius: Math.max(100, Math.min(3000, Number(e.target.value) || 100)) })} onBlur={() => clampRadius(config.radius)} /><span>METRI</span><b>⌖</b></div><p className="area-footnote"><span>ⓘ</span> Il cerchio sulla mappa segue il centro selezionato e il raggio corrente. Creazione lobby e partita restano demo locali.</p></div></section>
      <section className="form-panel policy-panel" aria-labelledby="policy-heading"><div className="panel-heading"><span className="step-badge">03</span><div><span className="eyebrow">SPECIFICA BETA</span><h2 id="policy-heading">Cattura e assegnazione</h2></div><span className="demo-tag">ANTEPRIMA</span></div><p className="policy-note">Impostazioni salvate solo in locale. Non influenzano la simulazione e non eseguono verifiche GPS o assegnazioni server.</p><div className="policy-grid"><fieldset className="policy-choice"><legend>Sistema di cattura</legend>{([['radius', 'Raggio', 'Richiesta manuale con verifica GPS server.'], ['pin', 'PIN personale', 'PIN temporaneo più verifica GPS server.'], ['automatic', 'Automatica', 'Prossimità server verificata nel tempo.']] as const).map(([value, title, description]) => <label key={value} className="choice-row"><input type="radio" name="capture-method" value={value} checked={config.captureMethod === value} onChange={() => updateConfig({ captureMethod: value })} /><span><b>{title}</b><small>{description}</small></span></label>)}</fieldset><fieldset className="policy-choice"><legend>Assegnazione ruoli</legend>{([['random', 'Casuale', 'Distribuzione server secondo i vincoli del modo.'], ['manual', 'Manuale', 'Assegnazione del gestore; i ruoli segreti saranno visibili a lui.']] as const).map(([value, title, description]) => <label key={value} className="choice-row"><input type="radio" name="assignment-method" value={value} checked={config.assignmentMethod === value} onChange={() => updateConfig({ assignmentMethod: value })} /><span><b>{title}</b><small>{description}</small></span></label>)}</fieldset></div><p className="policy-pending">Regole, compatibilità e soglie numeriche sono ancora da approvare. Vedi le decisioni aperte in BETA-SCOPE.</p></section>
      <section className="advanced-panel"><button className="advanced-trigger" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><span className="advanced-trigger__icon">⚙</span><span><b>OPZIONI DI SIMULAZIONE</b><small>Effetti locali dimostrativi.</small></span><span className="advanced-count">{advanced ? 'CHIUDI' : 'FACOLTATIVE'}</span><b className="advanced-chevron">{advanced ? '−' : '+'}</b></button>{advanced && <div className="advanced-grid"><Toggle label="Radar" detail="Effetto grafico simulato" value={config.radar} onChange={value => updateConfig({ radar: value })} /><Toggle label="Missione relay" detail="Obiettivo locale simulato" value={config.missions} onChange={value => updateConfig({ missions: value })} /><Toggle label="Zona dinamica" detail="Non applicata al gameplay demo" value={config.dynamicZones} onChange={value => updateConfig({ dynamicZones: value })} /><Toggle label="Conferma cattura demo" detail="Nessuna verifica di distanza" value={config.manualCapture} onChange={value => updateConfig({ manualCapture: value })} /></div>}</section>
      <div className="create-actions"><span><i className="status-dot" /> CONFIGURAZIONE SALVATA IN LOCALE</span><button className="button button--primary" onClick={createLobby}><span>CREA LOBBY</span><b>↗</b></button></div>
    </div><aside className="create-summary"><div className="summary-eyebrow">OPERATION SUMMARY <span>DEMO</span></div><div className="summary-center"><span>⌖</span><b>{areaCenter ? (centerSource === 'device' ? 'CENTRO DA GPS' : 'CENTRO DA MAPPA') : 'CENTRO DA SCEGLIERE'}</b><small>Il centro viene mantenuto solo nella memoria di questa schermata.</small></div><div className="summary-list"><div><span>MODE</span><b>CLASSIC HIDE & SEEK</b></div><div><span>PLAYERS</span><b>3—{config.maxPlayers}</b></div><div><span>RADIUS</span><b>{config.radius.toLocaleString('it-IT')} M</b></div><div><span>DURATION</span><b>{config.duration} MIN</b></div></div><div className="summary-safety"><span>✳</span><p>Gioca solo in aree adatte e sicure. Il GPS si ferma quando esci dalla creazione.</p></div></aside></div>
  </div>;
}

function Toggle({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button className="advanced-option" onClick={() => onChange(!value)} aria-pressed={value}><span className={`switch ${value ? 'switch--on' : ''}`}><i /></span><span><b>{label}</b><small>{detail}</small></span></button>;
}

function Lobby({ match, addPlayer, toggleReady, startGame, copyCode }: { match: DemoMatch; addPlayer: () => void; toggleReady: (id: string) => void; startGame: () => void; copyCode: () => void }) {
  const readyCount = match.players.filter(player => player.ready).length;
  return <div className="screen-stack"><PageTitle index="03 / SESSIONE LOCALE" title="La squadra si prepara." desc="I partecipanti sono dati fittizi che esistono solo in questa sessione." action={<span className="demo-pill"><i /> SOLO DEMO</span>} />
    <div className="lobby-layout"><div className="lobby-roster panel"><div className="panel-topline"><span>GIOCATORI DEMO <b>{match.players.length.toString().padStart(2, '0')}</b> / {match.config.maxPlayers}</span><button className="text-link" onClick={addPlayer} disabled={match.players.length >= match.config.maxPlayers}>＋ AGGIUNGI GIOCATORE FITTIZIO</button></div><div className="roster-list">{match.players.map((player, index) => <div key={player.id} className="roster-player"><span className="avatar" style={{ '--avatar-color': player.color } as CSSProperties}>{player.initials}</span><span className="roster-name"><b>{player.name.toUpperCase()}</b><small>{player.isLocal ? 'HOST DEMO · TU' : player.id.startsWith('guest') ? 'PARTECIPANTE FITTIZIO' : `GIOCATORE 0${index}`}</small></span><span className={`roster-team roster-team--${player.team}`}>{match.config.teams ? (player.team === 'red' ? 'ROSSA' : 'VERDE') : 'SOLO'}</span><button className={`ready-badge ${player.ready ? 'ready-badge--ready' : ''}`} onClick={() => toggleReady(player.id)}>{player.ready ? '● PRONTO' : '◌ NON PRONTO'}</button></div>)}</div><div className="roster-footer"><span>{readyCount} / {match.players.length} PRONTI</span><div className="ready-segments">{match.players.map(player => <i key={player.id} className={player.ready ? 'ready' : ''} />)}</div></div></div>
      <aside className="lobby-side"><div className="room-code panel"><div className="eyebrow"><span>INVITE CODE</span><i /></div><div className="code-value">{match.code.split('').map((char, index) => <b key={index}>{char}</b>)}</div><button className="copy-code" onClick={copyCode}>▣ COPIA CODICE</button><div className="room-private"><span className="status-dot" /> CODICE DI QUESTA DEMO</div></div><div className="lobby-rules panel"><div className="eyebrow">MATCH BRIEF</div><div className="rule-line"><span>MODE</span><b>{match.config.mode}</b></div><div className="rule-line"><span>FIELD RADIUS</span><b>{match.config.radius.toLocaleString('it-IT')} M</b></div><div className="rule-line"><span>TIME LIMIT</span><b>{match.config.duration} MIN</b></div><div className="rule-line"><span>SIMULATION</span><b className="text-green">ACTIVE</b></div></div><button className="button button--primary lobby-start" onClick={startGame}><span>START SIMULATION</span><b>↗</b></button><p className="lobby-legal">Nessun altro giocatore è connesso. I partecipanti sono simulati.</p></aside></div>
  </div>;
}

function Game({ match, roleView, setRoleView, remaining, capturedCount, capturePlayer, toggleRadar, completeMission, endGame }: { match: DemoMatch; roleView: 'hunter' | 'runner'; setRoleView: (role: 'hunter' | 'runner') => void; remaining: Player[]; capturedCount: number; capturePlayer: (id: string) => void; toggleRadar: () => void; completeMission: () => void; endGame: () => void }) {
  const canCapture = roleView === 'hunter';
  const openTargets = match.players.filter(player => !player.isLocal && !player.captured);
  return <div className="game-screen"><div className="game-topline"><div><div className="eyebrow"><span>LIVE / DEMO</span><i /> SIMULATED SESSION</div><h1>CLASSIC HIDE & SEEK</h1></div><div className="game-role-switch"><span>VISTA DEMO</span><button className={roleView === 'hunter' ? 'active' : ''} onClick={() => setRoleView('hunter')}>HUNTER</button><button className={roleView === 'runner' ? 'active' : ''} onClick={() => setRoleView('runner')}>RUNNER</button></div></div>
    <div className="game-grid"><div className="game-map-wrap"><div className="game-map-head"><div><span className="status-dot status-dot--yellow" /> FIELD 07 <b>·</b> {match.config.radius} M RADIUS</div><span className="map-live-label">SIMULATED CITY GRID <i>⌖</i></span></div><CityMap players={match.players} role={roleView} compact={false} /><div className="game-map-bottom"><span><i className="legend-dot legend-dot--you" /> YOUR POSITION / DEMO</span><span><i className="legend-dot legend-dot--hostile" /> {roleView === 'hunter' ? 'RUNNER VISIBLE IN DEMO' : 'HIDDEN MOVEMENT'}</span><span><i className="legend-dot legend-dot--safe" /> PLAY AREA</span></div></div>
      <aside className="game-panel"><div className="timer-panel"><span className="eyebrow">TIME REMAINING</span><div className="game-timer">{formatTime(match.secondsLeft)}</div><div className="timer-track"><i style={{ width: `${Math.max(2, (match.secondsLeft / (match.config.duration * 60)) * 100)}%` }} /></div><div className="timer-foot"><span>SESSION 01</span><span>{match.config.duration}:00</span></div></div>
        <div className={`role-card role-card--${roleView}`}><span className="eyebrow">YOUR ROLE / DEMO</span><h2>{roleView === 'hunter' ? 'HUNTER' : 'RUNNER'}</h2><p>{roleView === 'hunter' ? 'Cerca i segnali. Tagga i runner simulati.' : 'Resta nell’ombra. Evita il contatto.'}</p><span className="role-mark">{roleView === 'hunter' ? '⌁' : '◉'}</span></div>
        <div className="objective-panel"><div className="eyebrow">OBJECTIVE</div><div className="objective-row"><span className="objective-icon">⌖</span><span><b>{roleView === 'hunter' ? 'TAG THE RUNNERS' : 'STAY UNSEEN'}</b><small>{capturedCount} TAGGED · {remaining.length - capturedCount} ACTIVE</small></span></div>{match.config.missions && <button className={`mission-chip ${match.missionComplete ? 'mission-chip--done' : ''}`} onClick={completeMission}><span>{match.missionComplete ? '✓' : '◇'}</span>{match.missionComplete ? 'RELAY SIGNAL / COMPLETE' : 'SIMULATED MISSION · ACTIVATE RELAY'}</button>}</div>
        <div className="game-actions"><div className="eyebrow">ACTIONS</div><button className={`action-button ${match.radarActive ? 'action-button--active' : ''}`} onClick={toggleRadar}><span className="action-icon">⌁</span><span><b>{match.radarActive ? 'RADAR PULSE ACTIVE' : 'RADAR PULSE'}</b><small>{match.radarActive ? 'Signal visible in demo' : 'Reveal a rough signal'}</small></span><span className="action-cost">{match.radarActive ? 'ON' : '01'}</span></button>{canCapture && openTargets.slice(0, 2).map(target => <button className="action-button" key={target.id} onClick={() => capturePlayer(target.id)}><span className="action-icon action-icon--red">⌖</span><span><b>TAG {target.name.toUpperCase()}</b><small>Virtual capture / demo</small></span><span className="action-cost">TAG</span></button>)}<div className="connection-state"><span className="status-dot" /><span><b>CONNESSIONE SIMULATA</b><small>Ultimo aggiornamento: ora · dati fittizi</small></span></div></div>
        <button className="end-game" onClick={endGame}>TERMINA SIMULAZIONE <span>↗</span></button>
      </aside></div><div className="event-log"><span className="eyebrow">ACTIVITY LOG</span>{(match.events.length ? match.events : ['AREA SYNCHRONIZED', 'PLAYERS DEPLOYED']).slice(0, 3).map((event, index) => <span key={index}><i className={index === 0 ? 'event-pip event-pip--hot' : 'event-pip'} />{event}</span>)}<span className="event-log__demo">ALL EVENTS ARE SIMULATED</span></div>
  </div>;
}

function Results({ result, match, rematch, go }: { result: { winner: string; elapsed: string } | null; match: DemoMatch | null; rematch: () => void; go: (screen: Screen) => void }) {
  const winner = result?.winner ?? 'RUNNERS';
  return <div className="results-screen"><div className="results-orbit"><i /><i /><i /><span>✦</span></div><div className="eyebrow"><span>SIMULATION COMPLETE</span><i /> DEBRIEF 01</div><h1>{winner === 'HUNTERS' ? 'THE HUNT' : 'STAYED HIDDEN'}<br /><em>{winner === 'HUNTERS' ? 'IS OVER.' : 'THIS TIME.'}</em></h1><p className="results-sub">{winner} WIN THIS DEMO ROUND</p><div className="results-stats"><div><span>TIME IN FIELD</span><b>{result?.elapsed ?? '08:32'}</b></div><div><span>PLAYERS TAGGED</span><b>{match?.players.filter(p => p.captured).length ?? 2}<small> / {match?.players.length ?? 6}</small></b></div><div><span>FIELD RADIUS</span><b>{match?.config.radius ?? 840}<small> M</small></b></div><div><span>SESSION TYPE</span><b>LOCAL<small> DEMO</small></b></div></div><div className="result-actions"><button className="button button--primary" onClick={rematch}><span>RIVINCITA</span><b>↗</b></button><button className="button button--ghost" onClick={() => go('home')}><span>TORNA ALLA HOME</span><b>⌂</b></button></div><p className="result-disclaimer">RISULTATO DIMOSTRATIVO · NESSUN MATCH REALE È STATO GIOCATO</p></div>;
}

function Profile({ go }: { go: (screen: Screen) => void }) {
  return <div className="screen-stack"><PageTitle index="04 / PLAYER PROFILE" title="La tua traccia." desc="Un profilo dimostrativo. Nessuna statistica reale viene raccolta." action={<span className="demo-pill"><i /> LOCAL PROFILE</span>} /><div className="profile-layout"><section className="profile-card panel"><div className="profile-banner"><div className="profile-banner-grid" /><span>FIELD DOSSIER / 0004</span></div><div className="profile-main"><div className="avatar avatar--large avatar--gold">AX</div><div><div className="eyebrow">SCOUT CLASS / ACTIVE</div><h2>ALEX MORI</h2><p>FIELD SCOUT · LEVEL 04</p></div><button className="profile-edit" onClick={() => window.alert('Profilo demo: modifica non disponibile in questa build.')}>EDIT PROFILE ↗</button></div><div className="xp-track"><div><span>EXPERIENCE</span><b>1,280 / 2,000 XP</b></div><i><em /></i></div><div className="profile-stats"><div><b>12</b><span>MATCHES</span></div><div><b>07</b><span>WINS</span></div><div><b>18</b><span>TAGS</span></div><div><b>04</b><span>BADGES</span></div></div></section><aside className="profile-side panel"><div className="eyebrow">FIELD BADGES</div><div className="badge-row"><span>⌁</span><div><b>FIRST OUT</b><small>Prima sessione completata</small></div></div><div className="badge-row"><span>◉</span><div><b>GHOST MODE</b><small>Una vittoria da runner</small></div></div><div className="badge-row badge-row--locked"><span>✳</span><div><b>NIGHT SHIFT</b><small>Coming later</small></div></div><button className="text-link" onClick={() => go('modes')}>MODALITÀ PREFERITE <span>↗</span></button></aside></div></div>;
}
