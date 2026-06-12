export interface PlayerState {
  id: string;
  name: string;
  team: 'police' | 'thief' | 'spectator';
  isActive: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  isShooting: boolean;
  color: string;
  kills: number;
  deaths: number;
}

export type AccentColor = 'emerald' | 'violet' | 'indigo' | 'amber';

export interface KillFeedEntry {
  id: string;
  attacker: string;
  victim: string;
  timestamp: string;
}

export interface MatchState {
  phase: 'waiting' | 'countdown' | 'live' | 'round_end';
  countdown: number | null;
  blueScore: number;
  redScore: number;
  roundNumber: number;
  message: string;
  activePlayerIds: string[];
  winnerTeam?: 'police' | 'thief';
}
