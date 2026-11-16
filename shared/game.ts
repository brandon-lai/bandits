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
 * Tiers: score buys a bigger, tougher, harder-hitting plane that turns slower. A small plane
 * can always out-turn a big one, so the leader is never safe.
 */
export interface Tier {
  name: string;
  score: number; // score needed to reach this tier
  scale: number; // size of the sprite stack
  hp: number;
  dmg: number; // per bullet
  guns: number; // bullets per burst
  fire: number; // seconds between bursts
  speed: number; // px per second, cruising
  turn: number; // max turn rate, radians per second
}

export const TIERS: Tier[] = [
  { name: "Cadet", score: 0, scale: 0.55, hp: 100, dmg: 10, guns: 1, fire: 0.16, speed: 104, turn: 2.3 },
  { name: "Wingman", score: 50, scale: 0.62, hp: 120, dmg: 11, guns: 1, fire: 0.14, speed: 106, turn: 2.15 },
  { name: "Flight Lead", score: 130, scale: 0.7, hp: 150, dmg: 12, guns: 2, fire: 0.15, speed: 107, turn: 2.0 },
  { name: "Ace", score: 260, scale: 0.78, hp: 185, dmg: 13, guns: 2, fire: 0.13, speed: 108, turn: 1.85 },
  { name: "Double Ace", score: 460, scale: 0.86, hp: 225, dmg: 14, guns: 3, fire: 0.14, speed: 108, turn: 1.7 },
  { name: "Squadron Leader", score: 750, scale: 0.95, hp: 270, dmg: 15, guns: 3, fire: 0.12, speed: 107, turn: 1.56 },
  { name: "Wing Commander", score: 1150, scale: 1.05, hp: 320, dmg: 16, guns: 4, fire: 0.12, speed: 106, turn: 1.43 },
  { name: "Air Marshal", score: 1700, scale: 1.15, hp: 380, dmg: 18, guns: 4, fire: 0.11, speed: 104, turn: 1.3 },
];

export function tierFor(score: number): number {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (score >= TIERS[i].score) t = i;
  return t;
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
export const SALVAGE_AMBIENT = 260; // salvage drifting in the world when nobody has died lately
export const SALVAGE_MAX = 520;

/** a plane's hit radius, px */
export const hitRadius = (scale: number) => 13 * scale + 3;
/** how close salvage must be to be picked up, px */
export const pickRadius = (scale: number) => 16 * scale + 8;

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
export function fly(f: Flight, c: Controls, tier: Tier, dt: number) {
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
