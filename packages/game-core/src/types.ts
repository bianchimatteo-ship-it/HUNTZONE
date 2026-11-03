import type { ModeId } from './modes';

export type MatchPhase = 'lobby' | 'active' | 'completed' | 'cancelled';

export type MatchConfig = {
  schemaVersion: 1;
  modeId: ModeId;
  playerCap: number;
  radiusMeters: number;
  durationSeconds: number;
};

export type LobbyPlayer = {
  id: string;
  displayName: string;
  ready: boolean;
};

export type MatchState = {
  schemaVersion: 1;
  matchId: string;
  inviteCode: string;
  hostPlayerId: string;
  revision: number;
  phase: MatchPhase;
  config: MatchConfig;
  players: readonly LobbyPlayer[];
  processedCommandIds: readonly string[];
};

export type CommandEnvelope = {
  commandId: string;
  actorPlayerId: string;
  expectedRevision: number;
};

export type LobbyCommand =
  | (CommandEnvelope & {
      type: 'player.joined';
      player: Omit<LobbyPlayer, 'ready'>;
    })
  | (CommandEnvelope & {
      type: 'player.ready-changed';
      ready: boolean;
    });

export type Transition = {
  state: MatchState;
  duplicate: boolean;
};

export type GameCoreError = {
  code:
    | 'INVALID_CONFIG'
    | 'INVALID_COMMAND'
    | 'STALE_REVISION'
    | 'WRONG_PHASE'
    | 'UNKNOWN_PLAYER'
    | 'DUPLICATE_PLAYER'
    | 'LOBBY_FULL';
  message: string;
  fields?: readonly string[];
};

export type GameCoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GameCoreError };
