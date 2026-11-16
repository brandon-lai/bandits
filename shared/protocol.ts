// What goes over the WebSocket. JSON, with the hot rows as positional arrays to keep them small.

export interface PilotInfo {
  id: number;
  name: string;
  cc: string; // ISO country code, "" when hidden or unknown
  paint: number;
}

/** id, x, y, yaw, yawRate, roll (-1 or 0..1), rollDir, boost 0..1, hp 0..1, level (fractional), flags (1 protected, 2 firing) */
export type PlaneRow = [number, number, number, number, number, number, number, number, number, number, number];
/** id, owner, x, y, vx, vy, tick it was fired on */
export type BulletRow = [number, number, number, number, number, number, number];
/** id, x, y, value, where it came from x, y (a wreck, for dropped salvage) */
export type SalvageRow = [number, number, number, number, number, number];
/** id, score, kills, level */
export type LeaderRow = [number, number, number, number];

/** things that happened this tick */
export type Ev =
  | ["h", number, number, number, number] // bullet id hit pilot id at x, y
  | ["k", number, number, number, number, number] // killer id (-1 none) shot down victim id at x, y, victim level
  | ["p", number, number] // pilot id picked up salvage id
  | ["u", number, number, number] // pilot id reached a new level; last field: 1 new rank, 2 new guns
  | ["j", number] // pilot id joined (info follows in a "pj")
  | ["q", number]; // pilot id left

export interface Me {
  alive: boolean;
  hp: number;
  max: number;
  en: number;
  sc: number;
  k: number;
  cd: number;
  lv: number; // level, fractional
  prot: number;
}

export type ClientMsg =
  | { t: "join"; name: string; paint: number; flag: boolean }
  | { t: "in"; a: number; b: number }
  | { t: "respawn" }
  | { t: "ping"; c: number };

export interface Snapshot {
  t: "s";
  tk: number;
  p: PlaneRow[];
  b: BulletRow[];
  sa: SalvageRow[];
  sr: number[];
  e: Ev[];
  me: Me | null;
}

export interface BestRow {
  name: string;
  cc: string;
  score: number;
  kills: number;
  tier: number; // the level reached (the column kept its first name)
}

export type ServerMsg =
  | { t: "lobby"; humans: number; max: number; cc: string }
  | { t: "welcome"; id: number; tk: number; pilots: PilotInfo[]; salvage: [number, number, number, number, number, number][] }
  | { t: "pj"; p: PilotInfo }
  | { t: "pq"; id: number }
  | Snapshot
  | { t: "lb"; top: [number, number, number, number][]; rank: number; n: number }
  | { t: "dead"; by: number; byName: string; score: number; kills: number; seconds: number; level: number }
  | { t: "full"; max: number }
  | { t: "pong"; c: number; tk: number };
