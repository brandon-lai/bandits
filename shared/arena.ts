// The arena: every plane, bullet and piece of salvage, stepped TICK_HZ times a second.
// Pure logic, no sockets: the Durable Object owns one of these, and the tests drive one directly.

import {
  BULLET_LIFE, BULLET_SPEED, CRUISE_Z, type Controls, type Flight, REGEN_DELAY, REGEN_RATE, SALVAGE_AMBIENT,
  SALVAGE_MAX, SPAWN_SAFE, TICK_HZ, TIERS, WORLD, clamp, fly, gunAngles, gunOffsets, hitRadius, newFlight,
  pickRadius, rolling, tierFor, wrapAngle, wrapDelta, wrapPos,
} from "./game";
import type { BulletRow, Ev, LeaderRow, Me, PilotInfo, PlaneRow, SalvageRow } from "./protocol";

export const BOT_NAMES = [
  "Kestrel", "Halyard", "Vireo", "Sable", "Mako", "Osprey", "Juniper", "Tamarack", "Riptide", "Nimbus",
  "Cobalt", "Ember", "Pike", "Jackdaw", "Wren", "Bramble", "Cinder", "Gannet", "Lark", "Moraine",
];

/** how many bots keep the sky busy for a given number of people */
export function botsFor(humans: number) {
  if (humans <= 0) return 0;
  return clamp(9 - humans, 0, 6);
}

interface Brain {
  think: number;
  target: number; // pilot id, or -1
  aimErr: number;
  wander: number;
  fleeing: boolean;
  circling: number; // seconds stuck in a turning fight that is going nowhere
  extend: number; // seconds left of flying straight out of one, to come back round
  hunter: boolean; // goes looking for fights across the map, rather than collecting salvage
  respawn: number; // seconds until it flies again, when shot down
}

export interface Pilot {
  id: number;
  name: string;
  cc: string;
  paint: number;
  bot: boolean;
  flight: Flight | null; // null while shot down
  tier: number;
  hp: number;
  score: number;
  kills: number;
  controls: Controls;
  rollLatch: boolean;
  gunCd: number;
  protect: number; // seconds of spawn protection left
  sinceHit: number;
  lastHitBy: number;
  firing: number; // seconds since the guns last fired (for the muzzle flash)
  spawnedAt: number;
  lives: number;
  brain: Brain | null;
}

interface Bullet {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  dmg: number;
}

interface Salvage {
  id: number;
  x: number;
  y: number;
  v: number;
  ox: number;
  oy: number;
  expires: number; // seconds of arena time; Infinity for ambient
}

export interface LifeEnd {
  pilot: Pilot;
  score: number;
  kills: number;
  tier: number;
  seconds: number;
  killer: Pilot | null;
}

export interface TickOut {
  bullets: BulletRow[];
  salvageAdded: SalvageRow[];
  salvageRemoved: number[];
  events: Ev[];
  lifeEnds: LifeEnd[];
}

const DT = 1 / TICK_HZ;

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export class Arena {
  pilots = new Map<number, Pilot>();
  bullets: Bullet[] = [];
  salvage = new Map<number, Salvage>();
  time = 0;
  tick = 0;
  private nextId = 1;
  private nextBullet = 1;
  private nextSalvage = 1;
  private rnd: () => number;
  private out: TickOut = { bullets: [], salvageAdded: [], salvageRemoved: [], events: [], lifeEnds: [] };

  constructor(seed = Date.now()) {
    this.rnd = mulberry32(seed);
    for (let i = 0; i < SALVAGE_AMBIENT; i++) this.addAmbient(false);
  }

  get humans() {
    let n = 0;
    for (const p of this.pilots.values()) if (!p.bot) n++;
    return n;
  }

  info(p: Pilot): PilotInfo {
    return { id: p.id, name: p.name, cc: p.cc, paint: p.paint, bot: p.bot };
  }

  join(name: string, cc: string, paint: number, bot = false): Pilot {
    const p: Pilot = {
      id: this.nextId++, name, cc, paint: clamp(paint | 0, 0, 7), bot,
      flight: null, tier: 0, hp: TIERS[0].hp, score: 0, kills: 0,
      controls: { aim: 0, fire: false, boost: false, roll: false }, rollLatch: false,
      gunCd: 0, protect: 0, sinceHit: 99, lastHitBy: -1, firing: 99, spawnedAt: 0, lives: 0,
      brain: bot ? { think: 0, target: -1, aimErr: 0, wander: this.rnd() * Math.PI * 2, fleeing: false, circling: 0, extend: 0, hunter: this.rnd() < 0.7, respawn: 0 } : null,
    };
    this.pilots.set(p.id, p);
    this.spawn(p);
    return p;
  }

  /** a pilot leaves; returns the life they were in the middle of, if any */
  leave(id: number): LifeEnd | null {
    const p = this.pilots.get(id);
    if (!p) return null;
    this.pilots.delete(id);
    return p.flight ? this.lifeEnd(p, null) : null;
  }

  /** from the wire: aim in radians, bits 1 fire · 2 boost · 4 roll */
  input(id: number, aim: number, bits: number) {
    const p = this.pilots.get(id);
    if (!p || p.bot) return;
    if (Number.isFinite(aim)) p.controls.aim = wrapAngle(aim);
    p.controls.fire = (bits & 1) !== 0;
    p.controls.boost = (bits & 2) !== 0;
    if (bits & 4) p.rollLatch = true;
  }

  respawn(id: number) {
    const p = this.pilots.get(id);
    if (p && !p.flight) this.spawn(p);
  }

  private spawn(p: Pilot) {
    // the open spot farthest from everyone else, out of a dozen tries
    let bx = 0;
    let by = 0;
    let best = -1;
    for (let i = 0; i < 12; i++) {
      const x = this.rnd() * WORLD;
      const y = this.rnd() * WORLD;
      let near = Infinity;
      for (const o of this.pilots.values()) {
        if (!o.flight || o === p) continue;
        const d = Math.hypot(wrapDelta(o.flight.x - x), wrapDelta(o.flight.y - y));
        if (d < near) near = d;
      }
      if (near > best) { best = near; bx = x; by = y; }
    }
    p.flight = newFlight(bx, by, this.rnd() * Math.PI * 2 - Math.PI);
    p.controls.aim = p.flight.yaw;
    p.score = 0;
    p.kills = 0;
    p.tier = 0;
    p.hp = TIERS[0].hp;
    p.protect = SPAWN_SAFE;
    p.sinceHit = 99;
    p.lastHitBy = -1;
    p.gunCd = 0;
    p.spawnedAt = this.time;
    p.lives++;
    if (p.brain) p.brain.respawn = 0;
  }

  private addAmbient(record = true) {
    const s: Salvage = { id: this.nextSalvage++, x: this.rnd() * WORLD, y: this.rnd() * WORLD, v: 1, ox: 0, oy: 0, expires: Infinity };
    s.ox = s.x;
    s.oy = s.y;
    this.salvage.set(s.id, s);
    if (record) this.out.salvageAdded.push(this.salvageRow(s));
  }

  salvageRow(s: Salvage): SalvageRow {
    return [s.id, r1(s.x), r1(s.y), s.v, r1(s.ox), r1(s.oy)];
  }

  private dropSalvage(x: number, y: number, score: number) {
    const total = 8 + Math.floor(score * 0.5);
    const pieces = clamp(Math.ceil(total / 6), 3, 24);
    const each = Math.max(1, Math.round(total / pieces));
    for (let i = 0; i < pieces; i++) {
      if (this.salvage.size >= SALVAGE_MAX) this.expireOldestDrop();
      const a = this.rnd() * Math.PI * 2;
      const d = 18 + this.rnd() * 70;
      const s: Salvage = {
        id: this.nextSalvage++, x: wrapPos(x + Math.sin(a) * d), y: wrapPos(y - Math.cos(a) * d), v: each,
        ox: x, oy: y, expires: this.time + 40,
      };
      this.salvage.set(s.id, s);
      this.out.salvageAdded.push(this.salvageRow(s));
    }
  }

  private expireOldestDrop() {
    let oldest: Salvage | null = null;
    for (const s of this.salvage.values()) if (s.expires !== Infinity && (!oldest || s.expires < oldest.expires)) oldest = s;
    const victim = oldest ?? this.salvage.values().next().value;
    if (victim) {
      this.salvage.delete(victim.id);
      this.out.salvageRemoved.push(victim.id);
    }
  }

  private lifeEnd(p: Pilot, killer: Pilot | null): LifeEnd {
    return { pilot: p, score: p.score, kills: p.kills, tier: p.tier, seconds: this.time - p.spawnedAt, killer };
  }

  private gain(p: Pilot, pts: number) {
    // bots grow at half speed, so people stay on top of the board
    p.score += p.bot ? Math.ceil(pts / 2) : pts;
    const t = tierFor(p.score);
    if (t > p.tier) {
      // a promotion keeps the same share of health, in the bigger plane
      const share = p.hp / TIERS[p.tier].hp;
      p.tier = t;
      p.hp = Math.min(TIERS[t].hp, Math.max(share, 0.5) * TIERS[t].hp);
      this.out.events.push(["u", p.id, t]);
    }
  }

  /** shoot down `v`, credited to `k` (or nobody) */
  private down(v: Pilot, k: Pilot | null) {
    const f = v.flight!;
    this.out.events.push(["k", k ? k.id : -1, v.id, r1(f.x), r1(f.y), v.tier]);
    this.out.lifeEnds.push(this.lifeEnd(v, k));
    this.dropSalvage(f.x, f.y, v.score);
    // a bullet can land after its pilot went down: the kill is named, but a dead pilot scores nothing
    if (k && k.flight) {
      k.kills++;
      this.gain(k, 20 + Math.floor(v.score * 0.2));
    }
    v.flight = null;
    if (v.brain) v.brain.respawn = 3 + this.rnd() * 2;
  }

  /** keep the bot count where it should be for this many people */
  balanceBots() {
    const want = botsFor(this.humans);
    const bots = [...this.pilots.values()].filter((p) => p.bot);
    if (bots.length < want) {
      const used = new Set(bots.map((b) => b.name));
      const free = BOT_NAMES.filter((n) => !used.has(n));
      for (let i = bots.length; i < want; i++) {
        const name = free.splice(Math.floor(this.rnd() * free.length), 1)[0] ?? `Bogey ${i}`;
        const p = this.join(name, "", Math.floor(this.rnd() * 8), true);
        this.out.events.push(["j", p.id]);
      }
    } else if (bots.length > want) {
      // the ones that are down go first, then the lowest scores
      bots.sort((a, b) => (a.flight ? 1 : 0) - (b.flight ? 1 : 0) || a.score - b.score);
      for (const b of bots.slice(0, bots.length - want)) {
        this.pilots.delete(b.id);
        this.out.events.push(["q", b.id]);
      }
    }
  }

  step(): TickOut {
    const out = this.out;
    this.time += DT;
    this.tick++;

    for (const p of this.pilots.values()) {
      if (p.brain) this.think(p);
      const f = p.flight;
      if (!f) continue;
      const tier = TIERS[p.tier];
      p.controls.roll = p.rollLatch;
      p.rollLatch = false;
      fly(f, p.controls, tier, DT);
      p.sinceHit += DT;
      p.firing += DT;
      if (p.protect > 0) p.protect = Math.max(0, p.protect - DT);
      if (p.sinceHit > REGEN_DELAY && p.hp < tier.hp) p.hp = Math.min(tier.hp, p.hp + tier.hp * REGEN_RATE * DT);

      // guns
      p.gunCd -= DT;
      if (p.controls.fire && p.gunCd <= 0 && f.roll < 0) {
        p.gunCd = tier.fire;
        p.firing = 0;
        p.protect = 0; // firing gives up spawn protection
        const speed = tier.speed * (1 + 0.75 * f.boost);
        const offs = gunOffsets(tier.guns);
        const angs = gunAngles(tier.guns);
        const cs = Math.cos(f.yaw);
        const sn = Math.sin(f.yaw);
        for (let g = 0; g < offs.length; g++) {
          const a = f.yaw + angs[g];
          const side = offs[g] * tier.scale;
          const ahead = 12 * tier.scale;
          const b: Bullet = {
            id: this.nextBullet++, owner: p.id,
            x: wrapPos(f.x + cs * side + sn * ahead), y: wrapPos(f.y + sn * side - cs * ahead),
            vx: Math.sin(a) * (BULLET_SPEED + speed), vy: -Math.cos(a) * (BULLET_SPEED + speed),
            born: this.time, dmg: tier.dmg,
          };
          this.bullets.push(b);
          out.bullets.push([b.id, b.owner, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), this.tick]);
        }
      }
    }

    // bullets: move, then test the stretch they covered against every plane
    const keep: Bullet[] = [];
    for (const b of this.bullets) {
      const x0 = b.x;
      const y0 = b.y;
      const sx = b.vx * DT;
      const sy = b.vy * DT;
      b.x = wrapPos(b.x + sx);
      b.y = wrapPos(b.y + sy);
      let hit: Pilot | null = null;
      for (const p of this.pilots.values()) {
        const f = p.flight;
        if (!f || p.id === b.owner || p.protect > 0 || rolling(f)) continue;
        const r = hitRadius(TIERS[p.tier].scale);
        // closest approach of the segment to the plane's centre
        const cx = wrapDelta(f.x - x0);
        const cy = wrapDelta(f.y - y0);
        const len2 = sx * sx + sy * sy;
        const t = clamp((cx * sx + cy * sy) / (len2 || 1), 0, 1);
        const dx = cx - sx * t;
        const dy = cy - sy * t;
        if (dx * dx + dy * dy <= r * r) { hit = p; break; }
      }
      if (hit) {
        const f = hit.flight!;
        hit.hp -= b.dmg;
        hit.sinceHit = 0;
        hit.lastHitBy = b.owner;
        out.events.push(["h", b.id, hit.id, r1(f.x), r1(f.y)]);
        if (hit.hp <= 0) this.down(hit, this.pilots.get(b.owner) ?? null);
        continue;
      }
      if (this.time - b.born < BULLET_LIFE) keep.push(b);
    }
    this.bullets = keep;

    // salvage: fly through it to collect
    for (const p of this.pilots.values()) {
      const f = p.flight;
      if (!f) continue;
      const r = pickRadius(TIERS[p.tier].scale);
      for (const s of this.salvage.values()) {
        const dx = wrapDelta(s.x - f.x);
        if (dx > r || dx < -r) continue;
        const dy = wrapDelta(s.y - f.y);
        if (dx * dx + dy * dy > r * r) continue;
        this.salvage.delete(s.id);
        out.salvageRemoved.push(s.id);
        out.events.push(["p", p.id, s.id]);
        p.hp = Math.min(TIERS[p.tier].hp, p.hp + s.v * 2);
        this.gain(p, s.v);
      }
    }
    // dropped salvage rusts away; the ambient kind tops itself up
    let ambient = 0;
    for (const s of this.salvage.values()) {
      if (s.expires === Infinity) ambient++;
      else if (s.expires < this.time) {
        this.salvage.delete(s.id);
        out.salvageRemoved.push(s.id);
      }
    }
    if (ambient < SALVAGE_AMBIENT && this.tick % 3 === 0 && this.salvage.size < SALVAGE_MAX) this.addAmbient();

    this.out = { bullets: [], salvageAdded: [], salvageRemoved: [], events: [], lifeEnds: [] };
    return out;
  }

  // ── bots: fly about, collect salvage, pick fights they can win, run from ones they cannot
  private think(p: Pilot) {
    const brain = p.brain!;
    if (!p.flight) {
      brain.respawn -= DT;
      if (brain.respawn <= 0) this.spawn(p);
      return;
    }
    const f = p.flight;
    const tier = TIERS[p.tier];
    brain.think -= DT;
    if (brain.think > 0) return;
    brain.think = 0.18 + this.rnd() * 0.12;
    brain.aimErr = (this.rnd() - 0.5) * 0.22;

    // no more than two bots on any one plane, so a lone newcomer is not swarmed
    const chasers = new Map<number, number>();
    for (const o of this.pilots.values()) {
      if (o.brain && o !== p && o.flight && o.brain.target >= 0) chasers.set(o.brain.target, (chasers.get(o.brain.target) ?? 0) + 1);
    }
    const crowded = (o: Pilot) => (chasers.get(o.id) ?? 0) >= 2 && brain.target !== o.id;
    let foe: Pilot | null = null;
    let foeD = 400;
    for (const o of this.pilots.values()) {
      if (o === p || !o.flight || o.protect > 0 || crowded(o)) continue;
      const d = Math.hypot(wrapDelta(o.flight.x - f.x), wrapDelta(o.flight.y - f.y));
      // a little keener on wounded and smaller planes
      const keen = d * (0.75 + 0.25 * (o.hp / TIERS[o.tier].hp)) * (o.tier > p.tier + 2 ? 1.4 : 1);
      if (keen < foeD) { foeD = keen; foe = o; }
    }
    const c = p.controls;
    c.fire = false;
    c.boost = false;
    brain.target = foe ? foe.id : -1;
    brain.fleeing = !!foe && p.hp < tier.hp * 0.3 && foe.tier >= p.tier;
    if (foe && foe.flight) {
      const of = foe.flight;
      const dx = wrapDelta(of.x - f.x);
      const dy = wrapDelta(of.y - f.y);
      const d = Math.hypot(dx, dy);
      if (brain.fleeing) {
        c.aim = Math.atan2(-dx, dy) + brain.aimErr * 2;
        c.boost = f.energy > 20;
      } else {
        // lead the target
        const ospeed = TIERS[foe.tier].speed;
        const t = d / (BULLET_SPEED + tier.speed);
        const lx = dx + Math.sin(of.yaw) * ospeed * t;
        const ly = dy - Math.cos(of.yaw) * ospeed * t;
        c.aim = Math.atan2(lx, -ly) + brain.aimErr;
        const off = Math.abs(wrapAngle(c.aim - f.yaw));
        // two planes that turn alike just chase tails: break off, open the distance, come back
        const step = 0.24;
        if (brain.extend > 0) {
          brain.extend -= step;
          c.aim = f.yaw;
          c.boost = f.energy > 0;
          return;
        }
        brain.circling = d < 260 && off > 0.8 ? brain.circling + step : Math.max(0, brain.circling - step);
        if (brain.circling > 2.4 + this.rnd() * 2) {
          brain.circling = 0;
          brain.extend = 1.2 + this.rnd() * 0.8;
        }
        // the closer the target, the wider the cone that still hits it
        c.fire = d < 300 && off < Math.max(0.2, Math.atan2(hitRadius(TIERS[foe.tier].scale) * 1.6, d));
        c.boost = d > 260 && f.energy > 55;
      }
      if (p.sinceHit < 0.4 && this.rnd() < 0.25) p.rollLatch = true;
      return;
    }
    // nothing close: hunters head for the nearest plane (people first), the rest go salvaging
    if (brain.hunter) {
      let prey: Pilot | null = null;
      let preyD = 1100;
      for (const o of this.pilots.values()) {
        if (o === p || !o.flight || o.protect > 0 || crowded(o)) continue;
        const d = Math.hypot(wrapDelta(o.flight.x - f.x), wrapDelta(o.flight.y - f.y)) * (o.bot ? 1 : 0.85);
        if (d < preyD) { preyD = d; prey = o; }
      }
      if (prey && prey.flight) {
        brain.target = prey.id;
        c.aim = Math.atan2(wrapDelta(prey.flight.x - f.x), -wrapDelta(prey.flight.y - f.y)) + brain.aimErr;
        c.boost = preyD > 500 && f.energy > 70;
        return;
      }
    }
    let best: Salvage | null = null;
    let bestD = 420;
    for (const s of this.salvage.values()) {
      const dx = wrapDelta(s.x - f.x);
      if (dx > bestD || dx < -bestD) continue;
      const dy = wrapDelta(s.y - f.y);
      const d = Math.hypot(dx, dy) / Math.sqrt(s.v);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) c.aim = Math.atan2(wrapDelta(best.x - f.x), -wrapDelta(best.y - f.y));
    else {
      brain.wander += (this.rnd() - 0.5) * 0.6;
      c.aim = brain.wander;
    }
  }

  // ── what goes on the wire
  planes(): PlaneRow[] {
    const rows: PlaneRow[] = [];
    for (const p of this.pilots.values()) {
      const f = p.flight;
      if (!f) continue;
      const flags = (p.protect > 0 ? 1 : 0) | (p.firing < 0.12 ? 2 : 0);
      rows.push([p.id, r1(f.x), r1(f.y), r3(f.yaw), r2(f.yawRate), f.roll < 0 ? -1 : r2(f.roll), f.rollDir, r2(f.boost), r2(clamp(p.hp / TIERS[p.tier].hp, 0, 1)), p.tier, flags]);
    }
    return rows;
  }

  me(id: number): Me | null {
    const p = this.pilots.get(id);
    if (!p) return null;
    const f = p.flight;
    return {
      alive: !!f, hp: Math.ceil(Math.max(0, p.hp)), max: TIERS[p.tier].hp, en: f ? Math.round(f.energy) : 0,
      sc: p.score, k: p.kills, cd: f ? r2(f.rollCd) : 0, tier: p.tier, prot: r2(p.protect),
    };
  }

  leaderboard(): LeaderRow[] {
    return [...this.pilots.values()]
      .filter((p) => p.flight)
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .map((p) => [p.id, p.score, p.kills, p.tier]);
  }

  allSalvage(): SalvageRow[] {
    return [...this.salvage.values()].map((s) => this.salvageRow(s));
  }

  get cruise() {
    return CRUISE_Z;
  }
}
