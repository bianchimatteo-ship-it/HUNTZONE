import { MODE_PRESETS, MODE_IDS, type ModeId } from './modes';
import type {
  GameCoreError,
  GameCoreResult,
  LobbyCommand,
  MatchConfig,
  MatchState,
  Transition,
} from './types';

const fail = <T>(error: GameCoreError): GameCoreResult<T> => ({ ok: false, error });

export function validateMatchConfig(input: unknown): GameCoreResult<MatchConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail({ code: 'INVALID_CONFIG', message: 'Configuration must be an object.' });
  }

  const candidate = input as Record<string, unknown>;
  const fields = Object.keys(candidate);
  const allowed = ['schemaVersion', 'modeId', 'playerCap', 'radiusMeters', 'durationSeconds'];
  const unknown = fields.filter(field => !allowed.includes(field));
  const invalid: string[] = [...unknown];

  if (candidate.schemaVersion !== 1) invalid.push('schemaVersion');
  if (typeof candidate.modeId !== 'string' || !MODE_IDS.includes(candidate.modeId as ModeId)) invalid.push('modeId');
  if (!Number.isInteger(candidate.radiusMeters) || Number(candidate.radiusMeters) < 100 || Number(candidate.radiusMeters) > 3000) invalid.push('radiusMeters');
  if (!Number.isInteger(candidate.durationSeconds) || Number(candidate.durationSeconds) < 60 || Number(candidate.durationSeconds) > 7200) invalid.push('durationSeconds');

  const mode = typeof candidate.modeId === 'string' && MODE_IDS.includes(candidate.modeId as ModeId)
    ? MODE_PRESETS[candidate.modeId as ModeId]
    : undefined;
  if (mode && (!Number.isInteger(candidate.playerCap) || Number(candidate.playerCap) < mode.minPlayers || Number(candidate.playerCap) > mode.maxPlayers)) {
    invalid.push('playerCap');
  }

  if (invalid.length > 0 || !mode) {
    return fail({
      code: 'INVALID_CONFIG',
      message: 'Configuration is invalid or outside the current proposal bounds.',
      fields: [...new Set(invalid)],
    });
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      modeId: mode.id,
      playerCap: Number(candidate.playerCap),
      radiusMeters: Number(candidate.radiusMeters),
      durationSeconds: Number(candidate.durationSeconds),
    },
  };
}

export function createLobby(input: {
  matchId: string;
  inviteCode: string;
  hostPlayerId: string;
  hostDisplayName: string;
  config: unknown;
}): GameCoreResult<MatchState> {
  const config = validateMatchConfig(input.config);
  const ids = [input.matchId, input.inviteCode, input.hostPlayerId, input.hostDisplayName];
  if (ids.some(value => typeof value !== 'string' || value.trim().length === 0)) {
    return fail({ code: 'INVALID_COMMAND', message: 'Match, invite and host identifiers must be non-empty.' });
  }
  if (!config.ok) return config;

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      matchId: input.matchId,
      inviteCode: input.inviteCode,
      hostPlayerId: input.hostPlayerId,
      revision: 0,
      phase: 'lobby',
      config: config.value,
      players: [{ id: input.hostPlayerId, displayName: input.hostDisplayName, ready: false }],
      processedCommandIds: [],
    },
  };
}

export function applyLobbyCommand(state: MatchState, command: LobbyCommand): GameCoreResult<Transition> {
  if (typeof command.commandId !== 'string' || command.commandId.trim().length === 0 || !Number.isInteger(command.expectedRevision)) {
    return fail({ code: 'INVALID_COMMAND', message: 'Command ID and integer expectedRevision are required.' });
  }
  if (state.processedCommandIds.includes(command.commandId)) {
    return { ok: true, value: { state, duplicate: true } };
  }
  if (command.expectedRevision !== state.revision) {
    return fail({ code: 'STALE_REVISION', message: 'Command revision does not match current match revision.' });
  }
  if (state.phase !== 'lobby') {
    return fail({ code: 'WRONG_PHASE', message: 'Lobby commands are accepted only before the match starts.' });
  }

  let players = state.players;
  if (command.type === 'player.joined') {
    if (command.player.id !== command.actorPlayerId || !command.player.id.trim() || !command.player.displayName.trim()) {
      return fail({ code: 'INVALID_COMMAND', message: 'A join command must identify its player and display name.' });
    }
    if (state.players.some(player => player.id === command.player.id)) {
      return fail({ code: 'DUPLICATE_PLAYER', message: 'Player is already in this lobby.' });
    }
    if (state.players.length >= state.config.playerCap) {
      return fail({ code: 'LOBBY_FULL', message: 'Lobby has reached its configured player cap.' });
    }
    players = [...state.players, { ...command.player, ready: false }];
  } else {
    const playerIndex = state.players.findIndex(player => player.id === command.actorPlayerId);
    if (playerIndex < 0) return fail({ code: 'UNKNOWN_PLAYER', message: 'Only a lobby member may change their ready state.' });
    players = state.players.map((player, index) => index === playerIndex ? { ...player, ready: command.ready } : player);
  }

  return {
    ok: true,
    value: {
      duplicate: false,
      state: {
        ...state,
        revision: state.revision + 1,
        players,
        processedCommandIds: [...state.processedCommandIds, command.commandId],
      },
    },
  };
}
