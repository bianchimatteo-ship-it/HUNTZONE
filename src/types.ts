export type Screen = 'home' | 'modes' | 'create' | 'lobby' | 'game' | 'results' | 'profile';
export type Role = 'hunter' | 'runner';
export type Player = {
  id: string;
  name: string;
  initials: string;
  color: string;
  team: 'red' | 'green';
  isLocal?: boolean;
  ready: boolean;
  captured: boolean;
};

export type MatchConfig = {
  mode: string;
  maxPlayers: number;
  radius: number;
  duration: number;
  teams: boolean;
  manualCapture: boolean;
  radar: boolean;
  missions: boolean;
  dynamicZones: boolean;
};

export type DemoMatch = {
  code: string;
  config: MatchConfig;
  players: Player[];
  secondsLeft: number;
  role: Role;
  radarActive: boolean;
  missionComplete: boolean;
  events: string[];
  startedAt?: number;
};
