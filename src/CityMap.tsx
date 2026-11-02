import type { CSSProperties } from 'react';
import type { Player, Role } from './types';

type Props = { players: Player[]; role?: Role; capturedIds?: Set<string>; compact?: boolean };

const positions = [
  [20, 31], [38, 43], [63, 27], [77, 48], [50, 61], [30, 72], [68, 75],
];

export default function CityMap({ players, role = 'runner', capturedIds = new Set(), compact = false }: Props) {
  const visible = players.filter((player, index) => {
    if (player.isLocal || role === 'hunter') return true;
    return index % 3 !== 0;
  });
  return (
    <div className={`city-map ${compact ? 'city-map--compact' : ''}`} role="img" aria-label="Mappa schematica demo di una città con area di gioco e giocatori simulati">
      <svg className="map-art" viewBox="0 0 1000 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M 34 0 L 0 0 0 34" fill="none" stroke="#a9a995" strokeOpacity=".045" strokeWidth="1" /></pattern>
          <pattern id="park" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M0 14 Q5 7 10 14 T20 14" fill="none" stroke="#7f9878" strokeOpacity=".18" strokeWidth="1.3" /></pattern>
          <filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <pattern id="safeHatch" width="10" height="10" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="10" stroke="#d6b85e" strokeOpacity=".2" strokeWidth="3" /></pattern>
        </defs>
        <rect width="1000" height="720" fill="#20251f" />
        <rect width="1000" height="720" fill="url(#grid)" />
        <path d="M0 175 1000 118M0 454 1000 522M230 0 322 720M690 0 628 720" stroke="#4a5047" strokeWidth="47" fill="none" />
        <path d="M0 175 1000 118M0 454 1000 522M230 0 322 720M690 0 628 720" stroke="#697064" strokeOpacity=".5" strokeWidth="2" strokeDasharray="10 13" fill="none" />
        <path d="M0 325 1000 375M475 0 500 720M840 0 823 720" stroke="#353c34" strokeWidth="20" fill="none" />
        <path d="M90 60h98v68H90zM360 40h120v75H360zM770 45h110v52H770zM60 230h118v70H60zM355 200h83v56h-83zM510 220h130v73H510zM790 212h142v93H790zM75 548h155v90H75zM370 553h105v66H370zM730 576h160v86H730z" fill="#30372f" stroke="#41483f" strokeWidth="2" />
        <path d="M520 405c51-42 112-26 134 22 25 52-12 90-52 116-51 31-111 4-110-55 1-34 7-63 28-83Z" fill="#314637" stroke="#526b51" strokeWidth="2" />
        <path d="M520 405c51-42 112-26 134 22 25 52-12 90-52 116-51 31-111 4-110-55 1-34 7-63 28-83Z" fill="url(#park)" />
        <path d="M100 342 454 326 474 487 121 510Z" fill="url(#safeHatch)" stroke="#d6b85e" strokeOpacity=".5" strokeWidth="2" strokeDasharray="6 7" />
        <circle cx="490" cy="363" r="265" fill="none" stroke="#d44d3b" strokeWidth="2.5" strokeDasharray="9 9" opacity=".8" />
        <circle cx="490" cy="363" r="254" fill="none" stroke="#d44d3b" strokeWidth="1" opacity=".28" />
        <text x="44" y="42" fill="#aab09f" fontSize="12" fontFamily="monospace" letterSpacing="2">DISTRICT 07 / DEMO GRID</text>
        <text x="119" y="365" fill="#dccb8d" fontSize="11" fontFamily="monospace" letterSpacing="1">NO-GO / SIMULATED</text>
        <text x="520" y="549" fill="#9fb096" fontSize="12" fontFamily="monospace" letterSpacing="2">GREENBELT</text>
        <text x="760" y="690" fill="#879083" fontSize="10" fontFamily="monospace">N  /  SCHEMATIC MAP</text>
        <path d="M930 40v35m-8-27 8-8 8 8" stroke="#bfc4b4" fill="none" strokeWidth="2" />
      </svg>
      <div className="map-coordinate">FIELD SIMULATION <span>•</span> NO LIVE GPS</div>
      {visible.map((player, index) => {
        const [x, y] = positions[index % positions.length];
        const captured = player.captured || capturedIds.has(player.id);
        return <div key={player.id} className={`map-player ${player.isLocal ? 'map-player--local' : ''} ${captured ? 'map-player--captured' : ''}`} style={{ left: `${x}%`, top: `${y}%`, '--player-color': player.isLocal ? '#d6b85e' : player.team === 'red' ? '#d6503e' : '#7da886' } as CSSProperties} title={`${player.name}${captured ? ' — catturato nella demo' : ''}`}>
          <span className="map-player__halo" />
          <span className="map-player__dot">{player.isLocal ? '✦' : player.initials.slice(0, 1)}</span>
          <span className="map-player__name">{player.isLocal ? 'YOU' : player.name.toUpperCase()}</span>
        </div>;
      })}
      {role === 'hunter' && <div className="map-scan" />}
      <div className="map-scale"><i /> 250 m <span>RANGE RING</span></div>
    </div>
  );
}
