import { describe, expect, it } from 'vitest';
import { MODE_IDS, type ModeId } from './modes';
import { applyCapture, castSaboteurVote, completeVirtualTask, createMatchRuntime, resolveTimeout, triggerSabotage, withdrawPlayer } from './rules';

const minimum: Record<ModeId, number> = {
  'classic-hide-and-seek': 3, manhunt: 4, infected: 5, 'team-hunt': 6, survival: 3, 'tasks-and-deception': 6,
};
const makeMatch = (modeId: ModeId, count = minimum[modeId], captureMethod: 'radius' | 'pin' | 'automatic' = 'radius') => {
  const players = Array.from({ length: count }, (_, index) => ({ id: `fixture-human-${index + 1}`, ready: true }));
  const result = createMatchRuntime({ modeId, hostPlayerId: players[0]!.id, players, durationSeconds: 600, captureMethod, nowMs: 1000, randomUnit: () => 0.42 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('server-authoritative mode rules baseline', () => {
  it('builds role slots for all six requested modes without synthetic participants', () => {
    expect(MODE_IDS).toHaveLength(6);
    for (const modeId of MODE_IDS) {
      const state = makeMatch(modeId);
      expect(state.players).toHaveLength(minimum[modeId]);
      expect(state.players.every(player => player.playerId.startsWith('fixture-human-'))).toBe(true);
      expect(state.phase).toBe('active');
    }
    expect(makeMatch('classic-hide-and-seek').players.filter(player => player.roleId === 'seeker')).toHaveLength(1);
    expect(makeMatch('manhunt').players.filter(player => player.roleId === 'hunter')).toHaveLength(1);
    expect(makeMatch('infected').players.filter(player => player.roleId === 'infected')).toHaveLength(1);
    expect(makeMatch('team-hunt').players.map(player => player.teamId)).toEqual(expect.arrayContaining(['red', 'green']));
    expect(makeMatch('tasks-and-deception').players.filter(player => player.roleId === 'saboteur')).toHaveLength(1);
  });

  it('requires every player READY and rejects invalid mode roster sizes', () => {
    const result = createMatchRuntime({ modeId: 'classic-hide-and-seek', hostPlayerId: 'host', players: [{ id: 'host', ready: true }, { id: 'guest', ready: false }, { id: 'guest-2', ready: true }], durationSeconds: 600, captureMethod: 'radius', nowMs: 1000, randomUnit: () => 0.3 });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    expect(createMatchRuntime({ modeId: 'team-hunt', hostPlayerId: 'a', players: [{ id: 'a', ready: true }], durationSeconds: 600, captureMethod: 'radius', nowMs: 1000, randomUnit: () => 0.3 })).toMatchObject({ ok: false });
  });

  it('applies server-eligible captures only to authorized roles and honors idempotency', () => {
    const state = makeMatch('classic-hide-and-seek');
    const seeker = state.players.find(player => player.roleId === 'seeker')!;
    const hider = state.players.find(player => player.roleId === 'hider')!;
    const early = applyCapture({ state, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId, commandId: 'early-action', nowMs: 2000, evidence: { status: 'eligible' } });
    expect(early).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } });
    const result = applyCapture({ state, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId, commandId: 'valid-action-01', nowMs: 62_000, evidence: { status: 'eligible' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.players.find(player => player.playerId === hider.playerId)?.status).toBe('captured');
    expect(applyCapture({ state: result.value.state, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId, commandId: 'valid-action-01', nowMs: 63_000, evidence: { status: 'eligible' } })).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(applyCapture({ state, captorPlayerId: hider.playerId, targetPlayerId: seeker.playerId, commandId: 'wrong-role-01', nowMs: 62_000, evidence: { status: 'eligible' } })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
  });

  it('requires GPS plus a one-use PIN or server-observed automatic dwell', () => {
    const pinMatch = makeMatch('classic-hide-and-seek', 3, 'pin');
    const seeker = pinMatch.players.find(player => player.roleId === 'seeker')!;
    const hider = pinMatch.players.find(player => player.roleId === 'hider')!;
    const withoutPin = applyCapture({ state: pinMatch, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId, commandId: 'missing-pin-01', nowMs: 62_000, evidence: { status: 'eligible' } });
    expect(withoutPin).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    const autoMatch = makeMatch('classic-hide-and-seek', 3, 'automatic');
    const autoSeeker = autoMatch.players.find(player => player.roleId === 'seeker')!;
    const autoHider = autoMatch.players.find(player => player.roleId === 'hider')!;
    expect(applyCapture({ state: autoMatch, captorPlayerId: autoSeeker.playerId, targetPlayerId: autoHider.playerId, commandId: 'missing-dwell-01', nowMs: 62_000, evidence: { status: 'eligible' } })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(applyCapture({ state: autoMatch, captorPlayerId: autoSeeker.playerId, targetPlayerId: autoHider.playerId, commandId: 'with-dwell-0001', nowMs: 62_000, evidence: { status: 'eligible' }, automaticDwellVerified: true }).ok).toBe(true);
    expect(applyCapture({ state: pinMatch, captorPlayerId: seeker.playerId, targetPlayerId: hider.playerId, commandId: 'gps-poor-000001', nowMs: 62_000, evidence: { status: 'indeterminate', reason: 'poor-accuracy' }, pinVerified: true })).toMatchObject({ ok: false, error: { code: 'INDETERMINATE_GPS' } });
  });

  it('converts infected players, separates withdrawal from capture, and resolves timer outcomes', () => {
    const infected = makeMatch('infected');
    const attacker = infected.players.find(player => player.roleId === 'infected')!;
    const survivor = infected.players.find(player => player.roleId === 'survivor')!;
    const conversion = applyCapture({ state: infected, captorPlayerId: attacker.playerId, targetPlayerId: survivor.playerId, commandId: 'convert-target-001', nowMs: 62_000, evidence: { status: 'eligible' } });
    expect(conversion).toMatchObject({ ok: true, value: { event: { type: 'player.converted' } } });
    if (conversion.ok) expect(conversion.value.state.players.find(player => player.playerId === survivor.playerId)).toMatchObject({ roleId: 'infected', status: 'active' });

    const classic = makeMatch('classic-hide-and-seek');
    const withdraw = withdrawPlayer({ state: classic, playerId: classic.players[1]!.playerId, commandId: 'withdraw-human-001', nowMs: 62_000 });
    expect(withdraw).toMatchObject({ ok: true, value: { event: { type: 'player.withdrew' } } });
    if (withdraw.ok) expect(withdraw.value.state.players[1]!.status).toBe('withdrawn');
    expect(resolveTimeout(classic, classic.deadlineAtMs)).toMatchObject({ ok: true, value: { winner: 'hiders', endReason: 'time-expired' } });
    expect(resolveTimeout(classic, classic.deadlineAtMs - 1)).toMatchObject({ ok: false, error: { code: 'STALE_TIMER' } });
  });

  it('limits Tasks & Deception actions to assigned crew tasks and supports sabotage/vote outcomes', () => {
    let state = makeMatch('tasks-and-deception');
    const saboteur = state.players.find(player => player.roleId === 'saboteur')!;
    const crew = state.players.filter(player => player.roleId === 'crew');
    expect(completeVirtualTask({ state, playerId: saboteur.playerId, taskId: 'forged-task', commandId: 'forged-task-01', nowMs: 32_000 })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    const sabotage = triggerSabotage({ state, playerId: saboteur.playerId, commandId: 'saboteur-action-01', nowMs: 32_000 });
    expect(sabotage).toMatchObject({ ok: true, value: { event: { type: 'sabotage.activated' } } });
    if (sabotage.ok) state = sabotage.value.state;
    for (const player of crew) {
      for (const taskId of player.taskIds) {
        const result = completeVirtualTask({ state, playerId: player.playerId, taskId, commandId: `task-${player.playerId}-${taskId.slice(-1)}`, nowMs: 100_000 });
        if (result.ok) state = result.value.state;
      }
    }
    expect(state).toMatchObject({ phase: 'completed', winner: 'crew', endReason: 'task-threshold-reached' });

    let voteState = makeMatch('tasks-and-deception');
    const hidden = voteState.players.find(player => player.roleId === 'saboteur')!;
    for (const [index, voter] of voteState.players.filter(player => player.roleId === 'crew').slice(0, 3).entries()) {
      const result = castSaboteurVote({ state: voteState, playerId: voter.playerId, targetPlayerId: hidden.playerId, commandId: `vote-command-${index}`, nowMs: 32_000 });
      expect(result.ok).toBe(true);
      if (result.ok) voteState = result.value.state;
    }
    expect(voteState).toMatchObject({ phase: 'completed', winner: 'crew', endReason: 'saboteur-majority-vote' });
  });
});
