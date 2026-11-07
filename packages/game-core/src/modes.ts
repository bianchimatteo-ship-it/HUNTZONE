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
  rulesStatus: 'in-development';
  currentRuleSummary: string;
};

// Bounds identify accepted implementation scope; every mode remains unavailable
// to clients until its server-authoritative lifecycle passes the beta gates.
export const MODE_PRESETS: Readonly<Record<ModeId, ModeDefinition>> = {
  'classic-hide-and-seek': {
    id: 'classic-hide-and-seek',
    displayName: 'CLASSIC HIDE & SEEK',
    minPlayers: 3,
    maxPlayers: 30,
    rulesStatus: 'in-development',
    currentRuleSummary: 'One seeker; server-verified captures; hiders survive until timeout.',
  },
  manhunt: {
    id: 'manhunt',
    displayName: 'MANHUNT',
    minPlayers: 4,
    maxPlayers: 20,
    rulesStatus: 'in-development',
    currentRuleSummary: 'Quarter-roster hunter team pursues fugitives; all fugitives must be captured.',
  },
  infected: {
    id: 'infected',
    displayName: 'INFECTED',
    minPlayers: 5,
    maxPlayers: 20,
    rulesStatus: 'in-development',
    currentRuleSummary: 'One initial infected converts survivors after server-verified capture.',
  },
  'team-hunt': {
    id: 'team-hunt',
    displayName: 'TEAM HUNT',
    minPlayers: 6,
    maxPlayers: 24,
    rulesStatus: 'in-development',
    currentRuleSummary: 'Two balanced teams; opposing captures; active-player count breaks timeout ties.',
  },
  survival: {
    id: 'survival',
    displayName: 'SURVIVAL',
    minPlayers: 3,
    maxPlayers: 16,
    rulesStatus: 'in-development',
    currentRuleSummary: 'Free-for-all; the last active player wins; multiple players at timeout draw.',
  },
  'tasks-and-deception': {
    id: 'tasks-and-deception',
    displayName: 'TASKS & DECEPTION',
    minPlayers: 6,
    maxPlayers: 18,
    rulesStatus: 'in-development',
    currentRuleSummary: 'Crew complete server-validated virtual tasks while a secret saboteur disrupts progress.',
  },
};
