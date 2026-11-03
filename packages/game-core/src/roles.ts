import type { GameCoreResult } from './types';

export type RoleSlot = { roleId: string; count: number; teamId?: string; secret: boolean };
export type AssignmentMethod = 'random' | 'manual';
export type PlayerAssignment = { playerId: string; roleId: string; teamId?: string; secret: boolean };
export type RoleAssignmentPlan = { method: AssignmentMethod; slots: readonly RoleSlot[] };
export type RolePlayer = { id: string; ready: boolean };
export type RoleAssignmentError = { code: 'INVALID_ROLE_ASSIGNMENT'; message: string; fields?: readonly string[] };

const fail = <T>(message: string, fields: string[] = []): GameCoreResult<T> => ({
  ok: false,
  error: { code: 'INVALID_ROLE_ASSIGNMENT', message, fields } as RoleAssignmentError,
});

function validateSlots(plan: RoleAssignmentPlan, players: readonly RolePlayer[]): string[] {
  const fields: string[] = [];
  if (plan && Object.keys(plan as object).some(key => !['method', 'slots'].includes(key))) fields.push('plan');
  if (!plan || !['random', 'manual'].includes(plan.method)) fields.push('method');
  if (!Array.isArray(plan?.slots) || plan.slots.length === 0) return [...fields, 'slots'];
  const slotKey = (roleId: string, teamId?: string) => JSON.stringify([roleId, teamId ?? null]);
  const slotKeys = new Set<string>();
  let slotCount = 0;
  for (const [index, slot] of plan.slots.entries()) {
    if (slot && Object.keys(slot as object).some(key => !['roleId', 'count', 'teamId', 'secret'].includes(key))) fields.push(`slots.${index}`);
    const key = slot && typeof slot.roleId === 'string' ? slotKey(slot.roleId, slot.teamId) : '';
    if (!slot || typeof slot.roleId !== 'string' || !slot.roleId.trim() || slotKeys.has(key)) fields.push(`slots.${index}.roleId`);
    else slotKeys.add(key);
    if (!Number.isInteger(slot.count) || slot.count < 1) fields.push(`slots.${index}.count`);
    else slotCount += slot.count;
    if (slot.teamId !== undefined && (typeof slot.teamId !== 'string' || !slot.teamId.trim())) fields.push(`slots.${index}.teamId`);
    if (typeof slot.secret !== 'boolean') fields.push(`slots.${index}.secret`);
  }
  const playerIds = new Set(players.map(player => player.id));
  if (playerIds.size !== players.length || [...playerIds].some(id => !id.trim())) fields.push('players');
  if (slotCount !== players.length) fields.push('slots.count');
  return fields;
}

export function validateRoleAssignmentPlan(
  plan: RoleAssignmentPlan,
  players: readonly RolePlayer[],
  assignments?: readonly PlayerAssignment[],
): GameCoreResult<readonly PlayerAssignment[]> {
  const fields = validateSlots(plan, players);
  if (plan.method === 'random') {
    if (assignments !== undefined) fields.push('assignments');
    if (fields.length) return fail('Random assignment plan is invalid.', fields);
    return { ok: true, value: [] };
  }

  if (!Array.isArray(assignments)) fields.push('assignments');
  const assignmentRows = Array.isArray(assignments)
    ? assignments.filter((assignment): assignment is PlayerAssignment => Boolean(assignment && typeof assignment === 'object' && !Array.isArray(assignment)))
    : [];
  if (assignmentRows.length !== (assignments?.length ?? 0)) fields.push('assignments');
  const byPlayer = new Map(assignmentRows.map(assignment => [assignment.playerId, assignment]));
  if (assignments && byPlayer.size !== players.length) fields.push('assignments.playerId');
  if (assignments && assignments.length !== players.length) fields.push('assignments.length');
  const slotKey = (roleId: string, teamId?: string) => JSON.stringify([roleId, teamId ?? null]);
  const slotCounts = new Map(plan.slots.map(slot => [slotKey(slot.roleId, slot.teamId), 0]));
  for (const [index, assignment] of assignmentRows.entries()) {
    if (Object.keys(assignment as object).some(key => !['playerId', 'roleId', 'teamId', 'secret'].includes(key))) fields.push(`assignments.${index}`);
    const slot = plan.slots.find(item => item.roleId === assignment.roleId && item.teamId === assignment.teamId);
    if (!players.some(player => player.id === assignment.playerId)) fields.push(`assignments.${index}.playerId`);
    if (!slot || slot.secret !== assignment.secret) fields.push(`assignments.${index}`);
    else {
      const key = slotKey(slot.roleId, slot.teamId);
      slotCounts.set(key, (slotCounts.get(key) ?? 0) + 1);
    }
  }
  for (const slot of plan.slots) if (slotCounts.get(slotKey(slot.roleId, slot.teamId)) !== slot.count) fields.push(`slots.${slot.roleId}.${slot.teamId ?? 'unassigned'}.count`);
  if (fields.length) return fail('Manual assignment must cover each player exactly once and satisfy every role slot.', [...new Set(fields)]);
  return { ok: true, value: assignments ?? [] };
}

/** `randomUnit` must be backed by a server-owned CSPRNG in a production adapter. */
export function assignRandomRoles(
  plan: RoleAssignmentPlan,
  players: readonly RolePlayer[],
  randomUnit: () => number,
): GameCoreResult<readonly PlayerAssignment[]> {
  if (plan.method !== 'random') return fail('Random assignment requires a random plan.', ['method']);
  const valid = validateRoleAssignmentPlan(plan, players);
  if (!valid.ok) return valid;
  const shuffled = [...players];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    let draw: number;
    try { draw = randomUnit(); } catch { return fail('Random source failed.', ['randomUnit']); }
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) return fail('Random source must return a value in [0, 1).', ['randomUnit']);
    const target = Math.floor(draw * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  const assignments: PlayerAssignment[] = [];
  let playerIndex = 0;
  for (const slot of plan.slots) {
    for (let count = 0; count < slot.count; count += 1) {
      const player = shuffled[playerIndex++];
      assignments.push({ playerId: player.id, roleId: slot.roleId, teamId: slot.teamId, secret: slot.secret });
    }
  }
  // Validate the generated value against slots without accepting caller-authored random assignments.
  return validateRoleAssignmentPlan({ ...plan, method: 'manual' }, players, assignments);
}

export function updateManualRoleAssignments(input: {
  plan: RoleAssignmentPlan;
  hostPlayerId: string;
  actorPlayerId: string;
  phase: 'lobby' | 'countdown' | 'active' | 'completed' | 'cancelled';
  players: readonly RolePlayer[];
  assignments?: readonly PlayerAssignment[];
  proposed: readonly PlayerAssignment[];
}): GameCoreResult<{ assignments: readonly PlayerAssignment[]; players: readonly RolePlayer[]; invalidatedReadyPlayerIds: readonly string[] }> {
  if (input.actorPlayerId !== input.hostPlayerId) return fail('Only the lobby administrator may assign roles.', ['actorPlayerId']);
  if (input.plan.method !== 'manual') return fail('Manual edits require a manual assignment plan.', ['method']);
  if (input.phase !== 'lobby') return fail('Role assignments are frozen once countdown begins.', ['phase']);
  const validated = validateRoleAssignmentPlan(input.plan, input.players, input.proposed);
  if (!validated.ok) return validated;
  const invalidated = input.players.filter(player => player.ready).filter(player => {
    const previous = input.assignments?.find(assignment => assignment.playerId === player.id);
    const next = input.proposed.find(assignment => assignment.playerId === player.id);
    return !previous || previous.roleId !== next?.roleId || previous.teamId !== next?.teamId;
  }).map(player => player.id);
  const changed = new Set(invalidated);
  return {
    ok: true,
    value: {
      assignments: input.proposed,
      players: input.players.map(player => changed.has(player.id) ? { ...player, ready: false } : player),
      invalidatedReadyPlayerIds: invalidated,
    },
  };
}

export function projectRoleAssignments(input: {
  assignments: readonly PlayerAssignment[];
  viewerPlayerId: string;
  isLobbyAdmin: boolean;
  assignmentMethod: AssignmentMethod;
  phase: 'lobby' | 'countdown' | 'active' | 'completed' | 'cancelled';
}): readonly { playerId: string; roleId?: string; teamId?: string }[] {
  return input.assignments.map(assignment => {
    const canSee = !assignment.secret || assignment.playerId === input.viewerPlayerId
      || (input.isLobbyAdmin && input.assignmentMethod === 'manual');
    return canSee
      ? { playerId: assignment.playerId, roleId: assignment.roleId, teamId: assignment.teamId }
      : { playerId: assignment.playerId };
  });
}
