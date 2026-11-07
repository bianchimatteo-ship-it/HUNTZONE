import { MODE_PRESETS, type ModeId } from './modes';
import { assignRandomRoles, validateRoleAssignmentPlan, type PlayerAssignment, type RoleSlot } from './roles';
import type { CaptureEvidence, CapturePolicy } from './capture';

export type RuntimePhase = 'active' | 'completed' | 'cancelled';
export type RuntimePlayer = {
  playerId: string;
  roleId: string;
  teamId?: string;
  status: 'active' | 'captured' | 'withdrawn';
  taskIds: readonly string[];
  completedTaskIds: readonly string[];
};
export type MatchRuntime = {
  schemaVersion: 1;
  engineVersion: '1.0.0';
  modeId: ModeId;
  phase: RuntimePhase;
  revision: number;
  hostPlayerId: string;
  startedAtMs: number;
  captureAvailableAtMs: number;
  deadlineAtMs: number;
  captureMethod: CapturePolicy['method'];
  players: readonly RuntimePlayer[];
  saboteurId?: string;
  crewTaskThreshold: number;
  sabotageCharges: number;
  sabotageAvailableAtMs: number;
  progressPausedUntilMs: number;
  votes: Readonly<Record<string, string>>;
  winner?: string;
  endReason?: string;
  processedCommandIds: readonly string[];
};
export type RuleError = { code: 'INVALID_MATCH' | 'NOT_READY' | 'NOT_AUTHORIZED' | 'INVALID_ACTION' | 'INDETERMINATE_GPS' | 'WRONG_PHASE' | 'STALE_TIMER'; message: string };
export type RuleResult<T> = { ok: true; value: T } | { ok: false; error: RuleError };
export type RuleTransition = { state: MatchRuntime; duplicate: boolean; event?: { type: string; actorPlayerId?: string; targetPlayerId?: string } };
export type StartPlayer = { id: string; ready: boolean };
type StartInput = {
  modeId: ModeId;
  hostPlayerId: string;
  players: readonly StartPlayer[];
  durationSeconds: number;
  captureMethod: CapturePolicy['method'];
  nowMs: number;
  randomUnit: () => number;
  assignmentMethod?: 'random' | 'manual';
  manualAssignments?: readonly PlayerAssignment[];
};

const fail = <T>(code: RuleError['code'], message: string): RuleResult<T> => ({ ok: false, error: { code, message } });
const isFinitePositive = (value: number) => Number.isFinite(value) && value > 0;

function slotsFor(modeId: ModeId, count: number): RoleSlot[] {
  switch (modeId) {
    case 'classic-hide-and-seek': return [{ roleId: 'seeker', count: 1, secret: true }, { roleId: 'hider', count: count - 1, secret: true }];
    case 'manhunt': {
      const hunters = Math.max(1, Math.ceil(count / 4));
      return [{ roleId: 'hunter', count: hunters, teamId: 'hunters', secret: true }, { roleId: 'fugitive', count: count - hunters, teamId: 'fugitives', secret: true }];
    }
    case 'infected': return [{ roleId: 'infected', count: 1, teamId: 'infected', secret: true }, { roleId: 'survivor', count: count - 1, teamId: 'survivors', secret: true }];
    case 'team-hunt': {
      const red = Math.ceil(count / 2);
      return [{ roleId: 'team-player', count: red, teamId: 'red', secret: false }, { roleId: 'team-player', count: count - red, teamId: 'green', secret: false }];
    }
    case 'survival': return [{ roleId: 'contender', count, secret: false }];
    case 'tasks-and-deception': return [{ roleId: 'saboteur', count: 1, secret: true }, { roleId: 'crew', count: count - 1, teamId: 'crew', secret: true }];
  }
}

function taskIds(playerId: string) { return [1, 2, 3].map(index => `${playerId}:virtual-task-${index}`); }

export function createMatchRuntime(input: StartInput): RuleResult<MatchRuntime> {
  const mode = MODE_PRESETS[input.modeId];
  const ids = input.players.map(player => player.id);
  if (!mode || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 600 || input.durationSeconds > 7200
    || !isFinitePositive(input.nowMs) || !['radius', 'pin', 'automatic'].includes(input.captureMethod)
    || new Set(ids).size !== ids.length || !ids.includes(input.hostPlayerId)
    || ids.length < mode.minPlayers || ids.length > mode.maxPlayers) {
    return fail('INVALID_MATCH', 'Match configuration or participant count is invalid.');
  }
  if (input.players.some(player => !player.ready)) return fail('NOT_READY', 'Every connected participant must confirm READY before start.');
  const slots = slotsFor(input.modeId, ids.length);
  const plan = { method: input.assignmentMethod ?? 'random', slots } as const;
  let assignments: readonly PlayerAssignment[];
  if (plan.method === 'manual') {
    if (!input.manualAssignments) return fail('INVALID_MATCH', 'Manual assignment is incomplete.');
    const validation = validateRoleAssignmentPlan(plan, input.players.map(player => ({ id: player.id, ready: player.ready })), input.manualAssignments);
    if (!validation.ok) return fail('INVALID_MATCH', validation.error.message);
    assignments = validation.value;
  } else {
    if (input.manualAssignments) return fail('INVALID_MATCH', 'Random assignment cannot accept client-supplied roles.');
    const result = assignRandomRoles(plan, input.players.map(player => ({ id: player.id, ready: player.ready })), input.randomUnit);
    if (!result.ok) return fail('INVALID_MATCH', result.error.message);
    assignments = result.value;
  }
  const runtimePlayers: RuntimePlayer[] = assignments.map(assignment => ({
    playerId: assignment.playerId,
    roleId: assignment.roleId,
    ...(assignment.teamId ? { teamId: assignment.teamId } : {}),
    status: 'active',
    taskIds: input.modeId === 'tasks-and-deception' && assignment.roleId === 'crew' ? taskIds(assignment.playerId) : [],
    completedTaskIds: [],
  }));
  const saboteur = runtimePlayers.find(player => player.roleId === 'saboteur');
  const preparationSeconds = input.modeId === 'classic-hide-and-seek' || input.modeId === 'manhunt' || input.modeId === 'infected' ? 60 : 30;
  return { ok: true, value: {
    schemaVersion: 1, engineVersion: '1.0.0', modeId: input.modeId, phase: 'active', revision: 1,
    hostPlayerId: input.hostPlayerId, startedAtMs: input.nowMs,
    captureAvailableAtMs: input.nowMs + preparationSeconds * 1000,
    deadlineAtMs: input.nowMs + (input.durationSeconds + preparationSeconds) * 1000,
    captureMethod: input.captureMethod, players: runtimePlayers,
    ...(saboteur ? { saboteurId: saboteur.playerId } : {}),
    crewTaskThreshold: input.modeId === 'tasks-and-deception' ? (runtimePlayers.length - 1) * 3 : 0,
    sabotageCharges: input.modeId === 'tasks-and-deception' ? 2 : 0,
    sabotageAvailableAtMs: 0, progressPausedUntilMs: 0, votes: {}, processedCommandIds: [],
  } };
}

function terminal(state: MatchRuntime, nowMs: number): MatchRuntime {
  if (state.phase !== 'active') return state;
  const active = state.players.filter(player => player.status === 'active');
  const byRole = (role: string) => active.filter(player => player.roleId === role);
  const finish = (phase: 'completed' | 'cancelled', winner: string | undefined, reason: string) => ({
    ...state, phase, winner, endReason: reason, revision: state.revision + 1,
  });
  switch (state.modeId) {
    case 'classic-hide-and-seek':
    case 'manhunt': {
      const targetRole = state.modeId === 'classic-hide-and-seek' ? 'hider' : 'fugitive';
      const hunterRole = state.modeId === 'classic-hide-and-seek' ? 'seeker' : 'hunter';
      const targets = state.players.filter(player => player.roleId === targetRole);
      if (byRole(hunterRole).length === 0) return finish('cancelled', undefined, 'hunters-unavailable');
      if (targets.every(player => player.status === 'captured')) return finish('completed', state.modeId === 'classic-hide-and-seek' ? 'seeker' : 'hunters', 'all-targets-captured');
      if (targets.every(player => player.status !== 'active')) return finish('cancelled', undefined, 'targets-withdrew');
      break;
    }
    case 'infected': {
      const survivors = state.players.filter(player => player.roleId === 'survivor');
      if (byRole('infected').length === 0) return byRole('survivor').length ? finish('completed', 'survivors', 'infected-withdrew') : finish('cancelled', undefined, 'no-active-side');
      if (survivors.length > 0 && survivors.every(player => player.status === 'captured')) return finish('completed', 'infected', 'all-survivors-converted');
      if (survivors.every(player => player.status !== 'active')) return finish('cancelled', undefined, 'survivors-withdrew');
      break;
    }
    case 'team-hunt': {
      const teams = [...new Set(state.players.map(player => player.teamId))];
      const surviving = teams.filter(team => state.players.some(player => player.teamId === team && player.status === 'active'));
      if (surviving.length === 1) {
        const winnerTeam = surviving[0]!;
        const losing = state.players.filter(player => player.teamId !== winnerTeam);
        if (losing.every(player => player.status === 'captured')) return finish('completed', winnerTeam!, 'opposing-team-captured');
        return finish('cancelled', undefined, 'opposing-team-withdrew');
      }
      if (surviving.length === 0) return finish('cancelled', undefined, 'no-active-team');
      break;
    }
    case 'survival':
      if (active.length === 1) return finish('completed', active[0]!.playerId, 'last-player-active');
      if (active.length === 0) return finish('cancelled', undefined, 'no-active-player');
      break;
    case 'tasks-and-deception': {
      if (state.players.filter(player => player.roleId === 'crew').reduce((sum, player) => sum + player.completedTaskIds.length, 0) >= state.crewTaskThreshold) return finish('completed', 'crew', 'task-threshold-reached');
      if (state.saboteurId && !active.some(player => player.playerId === state.saboteurId)) return finish('completed', 'crew', 'saboteur-withdrew');
      if (byRole('crew').length < 4) return finish('cancelled', undefined, 'insufficient-active-crew');
      if (state.saboteurId && byRole('crew').length <= byRole('saboteur').length) return finish('completed', 'saboteur', 'crew-reduced-to-parity');
      break;
    }
  }
  if (nowMs >= state.deadlineAtMs) return resolveTimeoutState(state);
  return state;
}

function resolveTimeoutState(state: MatchRuntime): MatchRuntime {
  if (state.phase !== 'active') return state;
  const active = state.players.filter(player => player.status === 'active');
  const finish = (winner: string | undefined, reason: string, phase: 'completed' | 'cancelled' = 'completed') => ({ ...state, phase, winner, endReason: reason, revision: state.revision + 1 });
  switch (state.modeId) {
    case 'classic-hide-and-seek': return finish(state.players.some(p => p.roleId === 'hider' && p.status === 'active') ? 'hiders' : undefined, 'time-expired', state.players.some(p => p.roleId === 'hider' && p.status === 'active') ? 'completed' : 'cancelled');
    case 'manhunt': return finish(state.players.some(p => p.roleId === 'fugitive' && p.status === 'active') ? 'fugitives' : undefined, 'time-expired', state.players.some(p => p.roleId === 'fugitive' && p.status === 'active') ? 'completed' : 'cancelled');
    case 'infected': return finish(state.players.some(p => p.roleId === 'survivor' && p.status === 'active') ? 'survivors' : undefined, 'time-expired', state.players.some(p => p.roleId === 'survivor' && p.status === 'active') ? 'completed' : 'cancelled');
    case 'team-hunt': {
      const counts = new Map<string, number>();
      for (const player of active) if (player.teamId) counts.set(player.teamId, (counts.get(player.teamId) ?? 0) + 1);
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return entries.length === 0 ? finish(undefined, 'no-active-team', 'cancelled') : entries.length > 1 && entries[0]![1] === entries[1]![1] ? finish(undefined, 'tied-at-timeout') : finish(entries[0]![0], 'active-player-count-at-timeout');
    }
    case 'survival': return active.length === 1 ? finish(active[0]!.playerId, 'last-player-at-timeout') : finish(undefined, active.length ? 'multiple-players-at-timeout' : 'no-active-player', active.length ? 'completed' : 'cancelled');
    case 'tasks-and-deception': return finish('saboteur', 'task-deadline-expired');
  }
}

function duplicateOrInvalid(state: MatchRuntime, commandId: string): RuleResult<RuleTransition> | null {
  if (state.processedCommandIds.includes(commandId)) return { ok: true, value: { state, duplicate: true } };
  if (!commandId || commandId.length > 80) return fail('INVALID_ACTION', 'A valid idempotency key is required.');
  if (state.phase !== 'active') return fail('WRONG_PHASE', 'The match is not active.');
  return null;
}

function commit(state: MatchRuntime, players: readonly RuntimePlayer[], commandId: string, nowMs: number, event: RuleTransition['event']): RuleTransition {
  const next: MatchRuntime = { ...state, players, revision: state.revision + 1, processedCommandIds: [...state.processedCommandIds, commandId] };
  const resolved = terminal(next, nowMs);
  return { state: resolved, duplicate: false, event };
}

/** Called only by the authoritative server after it evaluates its volatile GPS observations. */
export function applyCapture(input: {
  state: MatchRuntime; captorPlayerId: string; targetPlayerId: string; commandId: string; nowMs: number;
  evidence: CaptureEvidence; pinVerified?: boolean; automaticDwellVerified?: boolean;
}): RuleResult<RuleTransition> {
  const { state, commandId, nowMs } = input;
  const duplicate = duplicateOrInvalid(state, commandId);
  if (duplicate) return duplicate;
  if (!Number.isFinite(nowMs) || nowMs >= state.deadlineAtMs) return fail('STALE_TIMER', 'The match deadline has passed.');
  if (nowMs < state.captureAvailableAtMs) return fail('INVALID_ACTION', 'The preparation period has not ended.');
  if (input.evidence.status !== 'eligible') return fail('INDETERMINATE_GPS', 'Fresh accurate observations do not confirm this action.');
  if (state.captureMethod === 'pin' && input.pinVerified !== true) return fail('NOT_AUTHORIZED', 'A valid one-use PIN and location verification are both required.');
  if (state.captureMethod === 'automatic' && input.automaticDwellVerified !== true) return fail('NOT_AUTHORIZED', 'The server has not observed the required continuous proximity.');
  const captor = state.players.find(player => player.playerId === input.captorPlayerId);
  const target = state.players.find(player => player.playerId === input.targetPlayerId);
  if (!captor || !target || captor === target || captor.status !== 'active' || target.status !== 'active') return fail('INVALID_ACTION', 'Both distinct participants must be active.');
  const allowed = state.modeId === 'survival'
    ? true
    : state.modeId === 'tasks-and-deception'
      ? false
      : state.modeId === 'team-hunt'
        ? captor.teamId !== target.teamId
        : state.modeId === 'infected'
          ? captor.roleId === 'infected' && target.roleId === 'survivor'
          : (captor.roleId === 'seeker' || captor.roleId === 'hunter') && (target.roleId === 'hider' || target.roleId === 'fugitive');
  if (!allowed) return fail('NOT_AUTHORIZED', 'This role cannot capture that participant in this mode.');
  const players = state.modeId === 'infected'
    ? state.players.map(player => player.playerId === target.playerId ? { ...player, roleId: 'infected', teamId: 'infected' } : player)
    : state.players.map(player => player.playerId === target.playerId ? { ...player, status: 'captured' as const } : player);
  const event = { type: state.modeId === 'infected' ? 'player.converted' : 'player.captured', actorPlayerId: captor.playerId, targetPlayerId: target.playerId };
  return { ok: true, value: commit(state, players, commandId, nowMs, event) };
}

export function completeVirtualTask(input: { state: MatchRuntime; playerId: string; taskId: string; commandId: string; nowMs: number }): RuleResult<RuleTransition> {
  const { state } = input;
  const duplicate = duplicateOrInvalid(state, input.commandId);
  if (duplicate) return duplicate;
  if (state.modeId !== 'tasks-and-deception' || input.nowMs >= state.deadlineAtMs || input.nowMs < state.captureAvailableAtMs) return fail('INVALID_ACTION', 'This task action is unavailable.');
  if (input.nowMs < state.progressPausedUntilMs) return fail('INVALID_ACTION', 'Task progress is temporarily paused.');
  const player = state.players.find(item => item.playerId === input.playerId);
  if (!player || player.status !== 'active' || player.roleId !== 'crew' || !player.taskIds.includes(input.taskId) || player.completedTaskIds.includes(input.taskId)) return fail('NOT_AUTHORIZED', 'This participant cannot complete that task.');
  const players = state.players.map(item => item.playerId === player.playerId ? { ...item, completedTaskIds: [...item.completedTaskIds, input.taskId] } : item);
  return { ok: true, value: commit(state, players, input.commandId, input.nowMs, { type: 'virtual-task.completed', actorPlayerId: player.playerId }) };
}

export function triggerSabotage(input: { state: MatchRuntime; playerId: string; commandId: string; nowMs: number }): RuleResult<RuleTransition> {
  const { state } = input;
  const duplicate = duplicateOrInvalid(state, input.commandId);
  if (duplicate) return duplicate;
  const player = state.players.find(item => item.playerId === input.playerId);
  if (state.modeId !== 'tasks-and-deception' || input.nowMs >= state.deadlineAtMs || input.nowMs < state.captureAvailableAtMs || !player || player.playerId !== state.saboteurId || player.status !== 'active') return fail('NOT_AUTHORIZED', 'Only the active saboteur can trigger a sabotage.');
  if (input.nowMs < state.sabotageAvailableAtMs || state.sabotageCharges < 1) return fail('INVALID_ACTION', 'Sabotage is cooling down or has no charges left.');
  const next = { ...state, sabotageCharges: state.sabotageCharges - 1, sabotageAvailableAtMs: input.nowMs + 180_000, progressPausedUntilMs: input.nowMs + 60_000 };
  const result = commit(next, next.players, input.commandId, input.nowMs, { type: 'sabotage.activated', actorPlayerId: player.playerId });
  return { ok: true, value: result };
}

export function castSaboteurVote(input: { state: MatchRuntime; playerId: string; targetPlayerId: string; commandId: string; nowMs: number }): RuleResult<RuleTransition> {
  const { state } = input;
  const duplicate = duplicateOrInvalid(state, input.commandId);
  if (duplicate) return duplicate;
  if (state.modeId !== 'tasks-and-deception' || input.nowMs >= state.deadlineAtMs) return fail('INVALID_ACTION', 'Voting is unavailable.');
  const voter = state.players.find(player => player.playerId === input.playerId && player.status === 'active' && player.roleId === 'crew');
  if (!voter || state.votes[voter.playerId]) return fail('NOT_AUTHORIZED', 'Only an active crew member may vote once.');
  const votes = { ...state.votes, [voter.playerId]: input.targetPlayerId };
  const crew = state.players.filter(player => player.roleId === 'crew' && player.status === 'active');
  const counts = new Map<string, number>();
  for (const target of Object.values(votes)) counts.set(target, (counts.get(target) ?? 0) + 1);
  const majorityTarget = [...counts.entries()].find(([, count]) => count >= Math.floor(crew.length / 2) + 1)?.[0];
  let next: MatchRuntime = { ...state, votes };
  if (majorityTarget) {
    if (majorityTarget === state.saboteurId) next = { ...next, phase: 'completed', winner: 'crew', endReason: 'saboteur-majority-vote' };
    else next = { ...next, crewTaskThreshold: Math.max(1, next.crewTaskThreshold - 1), votes: {} };
  }
  const result = commit(next, next.players, input.commandId, input.nowMs, { type: majorityTarget === state.saboteurId ? 'saboteur.exposed' : 'vote.cast', actorPlayerId: voter.playerId, ...(majorityTarget ? { targetPlayerId: majorityTarget } : {}) });
  return { ok: true, value: result };
}

/** Voluntary withdrawal changes virtual participation but is never converted into a capture. */
export function withdrawPlayer(input: { state: MatchRuntime; playerId: string; commandId: string; nowMs: number }): RuleResult<RuleTransition> {
  const { state } = input;
  const duplicate = duplicateOrInvalid(state, input.commandId);
  if (duplicate) return duplicate;
  const player = state.players.find(item => item.playerId === input.playerId && item.status === 'active');
  if (!player) return fail('INVALID_ACTION', 'Participant is not active.');
  const players = state.players.map(item => item.playerId === player.playerId ? { ...item, status: 'withdrawn' as const } : item);
  return { ok: true, value: commit(state, players, input.commandId, input.nowMs, { type: 'player.withdrew', actorPlayerId: player.playerId }) };
}

export function resolveTimeout(state: MatchRuntime, nowMs: number): RuleResult<MatchRuntime> {
  if (state.phase !== 'active') return fail('WRONG_PHASE', 'Match has already ended.');
  if (!Number.isFinite(nowMs) || nowMs < state.deadlineAtMs) return fail('STALE_TIMER', 'The server deadline has not been reached.');
  const resolved = resolveTimeoutState(state);
  return { ok: true, value: resolved };
}
