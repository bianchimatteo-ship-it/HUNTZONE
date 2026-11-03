import { describe, expect, it } from 'vitest';
import { applyLobbyCommand, createLobby, validateMatchConfig } from './lobby';
import { MODE_IDS, MODE_PRESETS } from './modes';

const configFor = (modeId: (typeof MODE_IDS)[number], playerCap = MODE_PRESETS[modeId].minPlayers) => ({
  schemaVersion: 1,
  modeId,
  playerCap,
  radiusMeters: 840,
  durationSeconds: 720,
});

function lobby(playerCap = 3) {
  const result = createLobby({
    matchId: 'match-1',
    inviteCode: 'AB12CD',
    hostPlayerId: 'host-1',
    hostDisplayName: 'Host',
    config: configFor('classic-hide-and-seek', playerCap),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('beta mode registry and config validation', () => {
  it('registers the six requested modes as explicitly unapproved proposals', () => {
    expect(MODE_IDS).toHaveLength(6);
    expect(MODE_IDS.every(id => MODE_PRESETS[id].rulesStatus === 'proposal')).toBe(true);
  });

  it.each(MODE_IDS)('validates proposed player bounds for %s', modeId => {
    expect(validateMatchConfig(configFor(modeId)).ok).toBe(true);
    expect(validateMatchConfig(configFor(modeId, MODE_PRESETS[modeId].maxPlayers)).ok).toBe(true);
    expect(validateMatchConfig(configFor(modeId, MODE_PRESETS[modeId].minPlayers - 1)).ok).toBe(false);
    expect(validateMatchConfig(configFor(modeId, MODE_PRESETS[modeId].maxPlayers + 1)).ok).toBe(false);
  });

  it('rejects unknown fields, unsupported versions, fractional radii and invalid durations', () => {
    expect(validateMatchConfig({ ...configFor('classic-hide-and-seek'), arbitraryRule: 'run code' }).ok).toBe(false);
    expect(validateMatchConfig({ ...configFor('classic-hide-and-seek'), schemaVersion: 2 }).ok).toBe(false);
    expect(validateMatchConfig({ ...configFor('classic-hide-and-seek'), radiusMeters: 100.5 }).ok).toBe(false);
    expect(validateMatchConfig({ ...configFor('classic-hide-and-seek'), durationSeconds: 0 }).ok).toBe(false);
  });
});

describe('pure lobby transitions', () => {
  it('joins players with monotone revisions and default-not-ready state', () => {
    const initial = lobby();
    const result = applyLobbyCommand(initial, {
      type: 'player.joined', commandId: 'join-1', actorPlayerId: 'player-2', expectedRevision: 0,
      player: { id: 'player-2', displayName: 'Runner' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.revision).toBe(1);
    expect(result.value.state.players[1]).toEqual({ id: 'player-2', displayName: 'Runner', ready: false });
  });

  it('rejects stale commands without mutating state', () => {
    const initial = lobby();
    const result = applyLobbyCommand(initial, {
      type: 'player.ready-changed', commandId: 'ready-1', actorPlayerId: 'host-1', expectedRevision: 8, ready: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(initial.revision).toBe(0);
  });

  it('returns the original state for a repeated command ID', () => {
    const initial = lobby();
    const command = {
      type: 'player.ready-changed' as const, commandId: 'ready-1', actorPlayerId: 'host-1', expectedRevision: 0, ready: true,
    };
    const first = applyLobbyCommand(initial, command);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = applyLobbyCommand(first.value.state, command);
    expect(retry).toEqual({ ok: true, value: { state: first.value.state, duplicate: true } });
  });

  it('enforces roster cap and member-only readiness', () => {
    const initial = lobby(3);
    const joined = applyLobbyCommand(initial, {
      type: 'player.joined', commandId: 'join-1', actorPlayerId: 'player-2', expectedRevision: 0,
      player: { id: 'player-2', displayName: 'Two' },
    });
    if (!joined.ok) throw new Error(joined.error.message);
    const joinedAgain = applyLobbyCommand(joined.value.state, {
      type: 'player.joined', commandId: 'join-2', actorPlayerId: 'player-3', expectedRevision: 1,
      player: { id: 'player-3', displayName: 'Three' },
    });
    if (!joinedAgain.ok) throw new Error(joinedAgain.error.message);
    const full = applyLobbyCommand(joinedAgain.value.state, {
      type: 'player.joined', commandId: 'join-3', actorPlayerId: 'player-4', expectedRevision: 2,
      player: { id: 'player-4', displayName: 'Four' },
    });
    expect(full).toMatchObject({ ok: false, error: { code: 'LOBBY_FULL' } });
    const stranger = applyLobbyCommand(initial, {
      type: 'player.ready-changed', commandId: 'ready-1', actorPlayerId: 'stranger', expectedRevision: 0, ready: true,
    });
    expect(stranger).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAYER' } });
  });
});
