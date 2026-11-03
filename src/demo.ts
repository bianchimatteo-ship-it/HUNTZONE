import type { DemoMatch, MatchConfig, Player } from './types';

export const defaultConfig: MatchConfig = {
  mode: 'CLASSIC HIDE & SEEK',
  maxPlayers: 8,
  radius: 840,
  duration: 12,
  teams: false,
  manualCapture: true,
  captureMethod: 'radius',
  assignmentMethod: 'random',
  radar: true,
  missions: false,
  dynamicZones: false,
};

const palette = ['#cf4f3d', '#93b99a', '#d5ad55', '#8c9fba', '#bc86a4', '#7faeae'];
const names = [
  ['Mia', 'MI'], ['Luca', 'LU'], ['Noah', 'NO'], ['Eva', 'EV'], ['Theo', 'TH'], ['Zoe', 'ZO'],
];

export function makePlayers(maxPlayers: number): Player[] {
  return [
    { id: 'local', name: 'Alex', initials: 'AX', color: '#d5ad55', team: 'green', isLocal: true, ready: true, captured: false },
    ...names.slice(0, Math.max(2, Math.min(maxPlayers - 1, names.length))).map(([name, initials], index) => ({
      id: `demo-${index}`,
      name,
      initials,
      color: palette[index],
      team: index % 2 ? 'green' as const : 'red' as const,
      ready: true,
      captured: false,
    })),
  ];
}

export function makeMatch(config: MatchConfig, areaCenter: DemoMatch['areaCenter'] = null, centerSource: DemoMatch['centerSource'] = null): DemoMatch {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  return {
    code,
    config,
    areaCenter,
    centerSource,
    players: makePlayers(config.maxPlayers),
    secondsLeft: config.duration * 60,
    role: 'runner',
    radarActive: false,
    missionComplete: false,
    events: [],
  };
}

export function loadSavedConfig(): MatchConfig {
  try {
    const raw = localStorage.getItem('huntzone.demo.config');
    return raw ? { ...defaultConfig, ...JSON.parse(raw) as Partial<MatchConfig> } : defaultConfig;
  } catch {
    return defaultConfig;
  }
}

export function saveConfig(config: MatchConfig) {
  localStorage.setItem('huntzone.demo.config', JSON.stringify(config));
}

export const modeCards = [
  { name: 'CLASSIC HIDE & SEEK', label: 'PLAYABLE DEMO', players: '3–8', detail: 'Un seeker. Il tempo scorre. Resta fuori dal radar.', icon: '◉', live: true, accent: 'red' },
  { name: 'MANHUNT', label: 'COMING LATER', players: '4–20', detail: 'Una squadra dà la caccia. L’altra prova a sparire.', icon: '⌁', live: false, accent: 'green' },
  { name: 'INFECTED', label: 'CONCEPT', players: '5–20', detail: 'Ogni cattura cambia il fronte della partita.', icon: '✳', live: false, accent: 'red' },
  { name: 'TEAM HUNT', label: 'CONCEPT', players: '6–24', detail: 'Due o più squadre. Un solo territorio da conquistare.', icon: '⟁', live: false, accent: 'yellow' },
  { name: 'SURVIVAL', label: 'CONCEPT', players: '3–16', detail: 'Tutti contro tutti. L’ultimo ancora in gioco vince.', icon: '△', live: false, accent: 'green' },
  { name: 'TASKS & DECEPTION', label: 'CONCEPT', players: '6–18', detail: 'Obiettivi segreti, alleanze fragili, identità nascoste.', icon: '⌘', live: false, accent: 'yellow' },
];

export const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
