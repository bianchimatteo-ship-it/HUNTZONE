import { describe, expect, it } from 'vitest';
import { assignRandomRoles, projectRoleAssignments, updateManualRoleAssignments, validateRoleAssignmentPlan, type PlayerAssignment, type RoleAssignmentPlan, type RolePlayer } from './roles';

const players: RolePlayer[] = [{ id: 'p1', ready: true }, { id: 'p2', ready: true }, { id: 'p3', ready: false }];
const plan: RoleAssignmentPlan = { method: 'random', slots: [
  { roleId: 'seeker', count: 1, teamId: 'hunters', secret: true },
  { roleId: 'hider', count: 2, teamId: 'runners', secret: false },
] };
const manualPlan: RoleAssignmentPlan = { ...plan, method: 'manual' };
const assigned: PlayerAssignment[] = [
  { playerId: 'p1', roleId: 'seeker', teamId: 'hunters', secret: true },
  { playerId: 'p2', roleId: 'hider', teamId: 'runners', secret: false },
  { playerId: 'p3', roleId: 'hider', teamId: 'runners', secret: false },
];

describe('role assignment policies', () => {
  it('validates exact manual coverage and role/team slot counts', () => {
    expect(validateRoleAssignmentPlan(manualPlan, players, assigned).ok).toBe(true);
    expect(validateRoleAssignmentPlan(manualPlan, players, assigned.slice(1)).ok).toBe(false);
    expect(validateRoleAssignmentPlan(manualPlan, players, [{ ...assigned[0], teamId: 'runners' }, ...assigned.slice(1)]).ok).toBe(false);
  });

  it('creates random assignment through an injected random source', () => {
    const result = assignRandomRoles(plan, players, () => 0.5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(players.length);
      expect(result.value.filter(item => item.roleId === 'seeker')).toHaveLength(1);
      expect(new Set(result.value.map(item => item.playerId)).size).toBe(players.length);
    }
    expect(assignRandomRoles(plan, players, () => 1).ok).toBe(false);
  });

  it('rejects random plans with client-authored assignments', () => {
    expect(validateRoleAssignmentPlan(plan, players, assigned).ok).toBe(false);
    expect(validateRoleAssignmentPlan({ ...plan, arbitrary: true } as RoleAssignmentPlan, players).ok).toBe(false);
  });

  it('allows only the host to edit manual assignments in lobby and clears READY for changed players', () => {
    const proposed = [...assigned].map(item => item.playerId === 'p1' ? { ...item, roleId: 'hider', teamId: 'runners', secret: false } : item);
    const result = updateManualRoleAssignments({
      plan: { method: 'manual', slots: [{ roleId: 'hider', count: 3, teamId: 'runners', secret: false }] },
      hostPlayerId: 'p1', actorPlayerId: 'p1', phase: 'lobby', players,
      assignments: assigned, proposed,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.invalidatedReadyPlayerIds).toEqual(['p1']);
      expect(result.value.players.find(player => player.id === 'p1')?.ready).toBe(false);
      expect(result.value.players.find(player => player.id === 'p2')?.ready).toBe(true);
    }
    expect(updateManualRoleAssignments({ plan: manualPlan, hostPlayerId: 'p1', actorPlayerId: 'p2', phase: 'lobby', players, proposed: assigned }).ok).toBe(false);
    expect(updateManualRoleAssignments({ plan: manualPlan, hostPlayerId: 'p1', actorPlayerId: 'p1', phase: 'active', players, proposed: assigned }).ok).toBe(false);
  });

  it('keeps secret roles private except to the player and the informed manual-assignment admin', () => {
    const hidden = projectRoleAssignments({ assignments: assigned, viewerPlayerId: 'p2', isLobbyAdmin: false, assignmentMethod: 'manual', phase: 'active' });
    expect(hidden[0]).toEqual({ playerId: 'p1' });
    const self = projectRoleAssignments({ assignments: assigned, viewerPlayerId: 'p1', isLobbyAdmin: false, assignmentMethod: 'random', phase: 'active' });
    expect(self[0].roleId).toBe('seeker');
    const admin = projectRoleAssignments({ assignments: assigned, viewerPlayerId: 'p2', isLobbyAdmin: true, assignmentMethod: 'manual', phase: 'active' });
    expect(admin[0].roleId).toBe('seeker');
    const randomAdmin = projectRoleAssignments({ assignments: assigned, viewerPlayerId: 'p2', isLobbyAdmin: true, assignmentMethod: 'random', phase: 'active' });
    expect(randomAdmin[0].roleId).toBeUndefined();
  });
});
