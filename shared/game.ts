// The rules of the air, shared by the server (which decides what happens) and the client
// (which predicts its own plane so steering feels immediate).
//
// The world is a 2048 px torus: fly off one edge and you come back on the other, exactly as
// the island map wraps in the renderer.

export const WORLD = 2048;
export const TICK_HZ = 30;
export const SNAPSHOT_EVERY = 2; // ticks: 15 snapshots a second
export const CRUISE_Z = 82; // every plane flies at the same height, above the clouds

/**
 * Growth, agar.io style: every point makes the plane a little bigger, tougher and harder
 * hitting, and a little slower to turn, so a small plane can always out-turn a big one.
 * Score maps to a level (1 to MAX_LEVEL, with a fraction for the way to the next), and the
 * stats follow the fractional level, so growth never waits for a level-up. Guns are the
 * one thing that comes in steps.
 */
export interface Stats {
  level: number; // 1..MAX_LEVEL, fractional
  scale: number; // size of the sprite stack
  hp: number;
  dmg: number; // per bullet
  guns: number; // bullets per burst
  fire: number; // seconds between bursts
  speed: number; // px per second, cruising
  turn: number; // max turn rate, radians per second
}

export const MAX_LEVEL = 50;
/** score needed to reach level L: quick at first (level 2 at 2 points), steeper later */
export function levelScore(L: number) {
  return L <= 1 ? 0 : Math.round(2 * Math.pow(L - 1, 1.952)); // level 5 at 30, 20 at ~630, 50 at ~4,000
}
const LEVEL_SCORES = Array.from({ length: MAX_LEVEL + 1 }, (_, i) => levelScore(i));

/** the level a score buys, with the fraction of the way to the next */
export function levelOf(score: number): number {
  let L = 1;
  while (L < MAX_LEVEL && score >= LEVEL_SCORES[L + 1]) L++;
  if (L >= MAX_LEVEL) return MAX_LEVEL;
  return L + (score - LEVEL_SCORES[L]) / (LEVEL_SCORES[L + 1] - LEVEL_SCORES[L]);
}

/** the guns arrive at these levels */
export const GUN_LEVELS = [1, 8, 18, 30];
export const gunsAt = (level: number) => GUN_LEVELS.filter((l) => level >= l).length;

export function statsAt(level: number): Stats {
  const g = clamp(level, 1, MAX_LEVEL) - 1; // 0..49
  return {
    level: g + 1,
    scale: 0.55 + 0.013 * g, // 0.55 .. 1.19
    hp: 100 + 6 * g, // 100 .. 394
    dmg: 10 + 0.18 * g, // 10 .. 18.8
    guns: gunsAt(g + 1),
    fire: 0.16 - 0.001 * g, // 0.16 .. 0.11 s
    speed: 104 + 0.06 * g,
    turn: 2.3 - 0.021 * g, // 2.3 .. 1.27 rad/s
  };
}
export const statsFor = (score: number) => statsAt(levelOf(score));

/** ranks: titles earned at set levels */
export const RANKS = [
  { name: "Cadet", level: 1 },
  { name: "Wingman", level: 5 },
  { name: "Flight Lead", level: 10 },
  { name: "Ace", level: 15 },
  { name: "Double Ace", level: 20 },
  { name: "Squadron Leader", level: 28 },
  { name: "Wing Commander", level: 36 },
  { name: "Air Marshal", level: 45 },
];
export function rankAt(level: number) {
  let r = 0;
  for (let i = 0; i < RANKS.length; i++) if (level >= RANKS[i].level) r = i;
  return r;
}

export const BOOST_MULT = 1.75; // speed while the afterburner is open
export const BOOST_DRAIN = 38; // energy per second while boosting
export const BOOST_REGEN = 20; // energy per second, after a short pause
export const BOOST_MIN = 12; // energy needed to light it
export const ROLL_TIME = 0.7; // a barrel roll, seconds
export const ROLL_COOLDOWN = 3.2;
export const ROLL_SAFE_FROM = 0.08; // bullets pass through between these points of the roll
export const ROLL_SAFE_TO = 0.62;
export const SPAWN_SAFE = 3; // seconds of protection after spawning (ends when you fire)
export const REGEN_DELAY = 5; // seconds without being hit before health returns
export const REGEN_RATE = 0.06; // share of max health per second

export const BULLET_SPEED = 430;
export const BULLET_LIFE = 0.62; // seconds: about 330 px of reach
export const SALVAGE_AMBIENT = 400; // salvage drifting in the world when nobody has died lately
export const SALVAGE_MAX = 700;

// scoring: every hit counts, a kill counts more, and the victim's score is shared out
export const HIT_POINTS = 2;
export const KILL_POINTS = 30;
export const KILL_SHARE = 0.3; // of the victim's score, to the killer
/** what a piece of ambient salvage is worth: mostly 1, some 2, a few 5-point crates */
export function ambientValue(r: number) {
  return r < 0.6 ? 1 : r < 0.9 ? 2 : 5;
}

/** a plane's hit radius, px */
export const hitRadius = (scale: number) => 13 * scale + 3;
/** how close salvage must be to be picked up, px */
export const pickRadius = (scale: number) => 20 * scale + 10;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export function wrapAngle(a: number) {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}
/** the shortest way from a to b across the torus, on one axis */
export function wrapDelta(d: number) {
  return d - WORLD * Math.round(d / WORLD);
}
export function wrapPos(v: number) {
  return ((v % WORLD) + WORLD) % WORLD;
}

export interface Flight {
  x: number;
  y: number;
  yaw: number; // 0 = north (up the map), clockwise
  yawRate: number;
  boost: number; // 0..1, eased
  energy: number; // 0..100
  boostIdle: number; // seconds since the afterburner was last open
  burning: boolean; // the afterburner is lit (once it runs dry it needs BOOST_MIN to relight)
  roll: number; // -1 when not rolling, else 0..1 through the roll
  rollDir: number;
  rollCd: number; // seconds until another roll is allowed
}

export interface Controls {
  aim: number; // heading the pilot wants, radians
  fire: boolean;
  boost: boolean;
  roll: boolean; // pressed since the last tick
}

export function newFlight(x: number, y: number, yaw: number): Flight {
  return { x, y, yaw, yawRate: 0, boost: 0, energy: 100, boostIdle: 9, burning: false, roll: -1, rollDir: 1, rollCd: 0 };
}

/** one step of flying. Pure: the client runs the same code to predict its own plane. */
export function fly(f: Flight, c: Controls, tier: Stats, dt: number) {
  // turning: toward the aim, no faster than the plane allows
  const err = wrapAngle(c.aim - f.yaw);
  const want = clamp(err * 3.2, -tier.turn, tier.turn);
  f.yawRate += (want - f.yawRate) * (1 - Math.exp(-dt * 6));
  f.yaw = wrapAngle(f.yaw + f.yawRate * dt);

  // afterburner: needs energy to light, drains while open, refills after a pause
  const lit = c.boost && (f.burning ? f.energy > 0 : f.energy >= BOOST_MIN);
  f.burning = lit;
  if (lit) {
    f.energy = Math.max(0, f.energy - BOOST_DRAIN * dt);
    f.boostIdle = 0;
  } else {
    f.boostIdle += dt;
    if (f.boostIdle > 0.6) f.energy = Math.min(100, f.energy + BOOST_REGEN * dt);
  }
  f.boost += ((lit ? 1 : 0) - f.boost) * (1 - Math.exp(-dt * (lit ? 6 : 3)));
  if (f.boost < 0.001 && !lit) f.boost = 0;

  // barrel roll: a dodge with a cooldown
  f.rollCd = Math.max(0, f.rollCd - dt);
  if (c.roll && f.roll < 0 && f.rollCd <= 0) {
    f.roll = 0;
    f.rollDir = f.yawRate >= 0 ? 1 : -1;
    f.rollCd = ROLL_COOLDOWN;
  }
  if (f.roll >= 0) {
    f.roll += dt / ROLL_TIME;
    if (f.roll >= 1) f.roll = -1;
  }

  const speed = tier.speed * (1 + (BOOST_MULT - 1) * f.boost);
  f.x = wrapPos(f.x + Math.sin(f.yaw) * speed * dt);
  f.y = wrapPos(f.y - Math.cos(f.yaw) * speed * dt);
  return speed;
}

export const rolling = (f: Flight) => f.roll >= ROLL_SAFE_FROM && f.roll <= ROLL_SAFE_TO;

/** where each gun sits, across the wings (px at scale 1), for a burst of n */
export function gunOffsets(n: number): number[] {
  if (n <= 1) return [0];
  if (n === 2) return [-6, 6];
  if (n === 3) return [-8, 0, 8];
  return [-11, -4, 4, 11];
}
/** a little spread, so a burst covers more sky the more guns there are */
export function gunAngles(n: number): number[] {
  if (n <= 1) return [0];
  if (n === 2) return [-0.012, 0.012];
  if (n === 3) return [-0.04, 0, 0.04];
  return [-0.06, -0.02, 0.02, 0.06];
}

/** the colours a pilot may paint the accent (the body stays gunmetal) */
export const PAINTS = ["#f0580e", "#e23b3b", "#f2c230", "#4bbf5a", "#1fb5a8", "#3f7bf0", "#9a5cf0", "#f05aa8"];
export const PAINT_NAMES = ["Signal orange", "Red", "Yellow", "Green", "Teal", "Blue", "Violet", "Pink"];
