export interface PlayerState {
  id: string;
  name: string;
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
