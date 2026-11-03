export const MODE_IDS = [
  'classic-hide-and-seek',
  'manhunt',
  'infected',
  'team-hunt',
  'survival',
  'tasks-and-deception',
] as const;

export type ModeId = (typeof MODE_IDS)[number];

export type ModeDefinition = {
  id: ModeId;
  displayName: string;
  minPlayers: number;
  maxPlayers: number;
  rulesStatus: 'proposal';
  currentRuleSummary: string;
};

// Limits and summaries below are review proposals, not approved playable rules.
// The registry is useful to validate lobby configuration; it does not authorize
// starting a match or adjudicating a mode.
export const MODE_PRESETS: Readonly<Record<ModeId, ModeDefinition>> = {
  'classic-hide-and-seek': {
    id: 'classic-hide-and-seek',
    displayName: 'CLASSIC HIDE & SEEK',
    minPlayers: 3,
    maxPlayers: 30,
    rulesStatus: 'proposal',
    currentRuleSummary: 'One seeker; hiders survive until timeout. Capture goal and tie behavior need owner approval.',
  },
  manhunt: {
    id: 'manhunt',
    displayName: 'MANHUNT',
    minPlayers: 4,
    maxPlayers: 20,
    rulesStatus: 'proposal',
    currentRuleSummary: 'Hunter team pursues fugitives; role ratio and terminal condition need owner approval.',
  },
  infected: {
    id: 'infected',
    displayName: 'INFECTED',
    minPlayers: 5,
    maxPlayers: 20,
    rulesStatus: 'proposal',
    currentRuleSummary: 'Captures convert players to infected; starting count and timeout outcome need owner approval.',
  },
  'team-hunt': {
    id: 'team-hunt',
    displayName: 'TEAM HUNT',
    minPlayers: 6,
    maxPlayers: 24,
    rulesStatus: 'proposal',
    currentRuleSummary: 'Two or more teams pursue opponents; capture, score and tie policy need owner approval.',
  },
  survival: {
    id: 'survival',
    displayName: 'SURVIVAL',
    minPlayers: 3,
    maxPlayers: 16,
    rulesStatus: 'proposal',
    currentRuleSummary: 'Everyone competes to remain active; capture authority and timeout ranking need owner approval.',
  },
  'tasks-and-deception': {
    id: 'tasks-and-deception',
    displayName: 'TASKS & DECEPTION',
    minPlayers: 6,
    maxPlayers: 18,
    rulesStatus: 'proposal',
    currentRuleSummary: 'Secret role and virtual objectives; objectives, disclosure and win conditions need owner approval.',
  },
};
