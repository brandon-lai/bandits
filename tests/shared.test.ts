import { describe, expect, it } from "vitest";
import { Arena, botsFor } from "../shared/arena";
import { BULLET_LIFE, HIT_POINTS, MAX_LEVEL, RANKS, TICK_HZ, WORLD, fly, gunsAt, levelOf, levelScore, newFlight, rankAt, statsAt, statsFor, wrapDelta } from "../shared/game";

const CADET = statsAt(1);
import { cleanCountry, cleanName } from "../shared/names";

/** put two pilots nose to tail: `a` behind `b`, both heading north, `gap` px apart */
function duel(gap = 120) {
  const arena = new Arena(1);
  const a = arena.join("A", "", 0);
  const b = arena.join("B", "", 1);
  for (const p of [a, b]) {
    p.protect = 0;
    p.flight!.yaw = 0;
    p.controls.aim = 0;
  }
  a.flight!.x = b.flight!.x = 1000;
  a.flight!.y = 1000;
  b.flight!.y = 1000 - gap;
  arena.salvage.clear(); // only the fight scores in these tests
  return { arena, a, b };
}

describe("flying", () => {
  it("turns toward the aim, no faster than the tier allows", () => {
    const f = newFlight(100, 100, 0);
    const t = CADET;
    for (let i = 0; i < 3; i++) fly(f, { aim: Math.PI / 2, fire: false, boost: false, roll: false }, t, 1 / 30);
    expect(f.yaw).toBeGreaterThan(0);
    expect(Math.abs(f.yawRate)).toBeLessThanOrEqual(t.turn + 1e-9);
    for (let i = 0; i < 90; i++) fly(f, { aim: Math.PI / 2, fire: false, boost: false, roll: false }, t, 1 / 30);
    expect(f.yaw).toBeCloseTo(Math.PI / 2, 1);
  });

  it("wraps round the edge of the world", () => {
    const f = newFlight(5, 5, 0);
    fly(f, { aim: 0, fire: false, boost: false, roll: false }, CADET, 0.2);
    expect(f.y).toBeGreaterThan(WORLD - 20);
    expect(wrapDelta(WORLD - 2 - 3)).toBe(-5);
  });

  it("the afterburner needs energy, drains it, and goes faster", () => {
    const f = newFlight(0, 0, 0);
    const c = { aim: 0, fire: false, boost: true, roll: false };
    let fast = 0;
    for (let i = 0; i < 30; i++) fast = fly(f, c, CADET, 1 / 30);
    expect(fast).toBeGreaterThan(CADET.speed * 1.5);
    expect(f.energy).toBeLessThan(70);
    while (f.energy > 0) fly(f, c, CADET, 1 / 30);
    // run dry, it stays out until there is enough to relight, even with the button held
    for (let i = 0; i < 30; i++) {
      fly(f, c, CADET, 1 / 30);
      expect(f.burning).toBe(false);
    }
  });

  it("a barrel roll has a cooldown", () => {
    const f = newFlight(0, 0, 0);
    fly(f, { aim: 0, fire: false, boost: false, roll: true }, CADET, 1 / 30);
    expect(f.roll).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 30; i++) fly(f, { aim: 0, fire: false, boost: false, roll: false }, CADET, 1 / 30);
    expect(f.roll).toBe(-1);
    fly(f, { aim: 0, fire: false, boost: false, roll: true }, CADET, 1 / 30);
    expect(f.roll).toBe(-1); // still cooling down
  });
});

describe("levels", () => {
  it("score buys levels in order, quickly at first, up to the cap", () => {
    expect(levelOf(0)).toBe(1);
    expect(Math.floor(levelOf(levelScore(2)))).toBe(2);
    expect(levelScore(2)).toBeLessThanOrEqual(5); // the first level-up comes within seconds
    expect(levelOf(1e9)).toBe(MAX_LEVEL);
    for (let L = 2; L <= MAX_LEVEL; L++) {
      expect(levelScore(L)).toBeGreaterThan(levelScore(L - 1));
      // each level costs at least as much as the one before
      if (L > 2) expect(levelScore(L) - levelScore(L - 1)).toBeGreaterThanOrEqual(levelScore(L - 1) - levelScore(L - 2));
    }
  });

  it("every point grows the plane, between levels too, and bigger means slower to turn", () => {
    let prev = statsFor(0);
    for (let sc = 1; sc <= levelScore(MAX_LEVEL); sc += 7) {
      const now = statsFor(sc);
      expect(now.hp).toBeGreaterThan(prev.hp);
      expect(now.dmg).toBeGreaterThan(prev.dmg);
      expect(now.scale).toBeGreaterThan(prev.scale);
      expect(now.turn).toBeLessThan(prev.turn);
      prev = now;
    }
    // half-way to level 2 is already half of the step
    const mid = statsFor((levelScore(2) + levelScore(3)) / 2);
    expect(mid.hp).toBeGreaterThan(statsAt(2).hp);
    expect(mid.hp).toBeLessThan(statsAt(3).hp);
  });

  it("ranks and guns arrive at set levels", () => {
    expect(RANKS[rankAt(1)].name).toBe("Cadet");
    expect(RANKS[rankAt(15)].name).toBe("Ace");
    expect(RANKS[rankAt(MAX_LEVEL)].name).toBe("Air Marshal");
    expect([1, 7, 8, 17, 18, 29, 30, 50].map(gunsAt)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe("the arena", () => {
  it("bullets hit the plane in front, and enough of them shoot it down", () => {
    const { arena, a, b } = duel();
    a.controls.fire = true;
    let hits = 0;
    let kill: unknown = null;
    for (let i = 0; i < TICK_HZ * 6 && b.flight; i++) {
      const out = arena.step();
      // keep b flying straight ahead of a
      if (b.flight) b.flight.x = a.flight!.x;
      for (const e of out.events) {
        if (e[0] === "h") hits++;
        if (e[0] === "k") kill = e;
      }
    }
    expect(hits).toBeGreaterThanOrEqual(10);
    expect(b.flight).toBeNull();
    expect(kill).toEqual(["k", a.id, b.id, expect.any(Number), expect.any(Number), 1]);
    expect(a.kills).toBe(1);
    expect(a.score).toBeGreaterThanOrEqual(20);
  });

  it("every hit scores for the shooter, before any kill", () => {
    const { arena, a, b } = duel();
    a.controls.fire = true;
    let hits = 0;
    for (let i = 0; i < TICK_HZ * 0.6 && hits === 0; i++) {
      for (const e of arena.step().events) if (e[0] === "h") hits++;
      b.flight!.x = a.flight!.x;
    }
    expect(hits).toBe(1);
    expect(b.flight).not.toBeNull();
    expect(a.score).toBe(HIT_POINTS);
  });

  it("a shot-down plane drops salvage worth half its score", () => {
    const { arena, a, b } = duel();
    b.score = 200;
    b.level = levelOf(200);
    b.stats = statsAt(b.level);
    b.hp = 1;
    a.controls.fire = true;
    const before = arena.salvage.size;
    let dropped = 0;
    for (let i = 0; i < TICK_HZ && b.flight; i++) {
      const out = arena.step();
      dropped += out.salvageAdded.filter((s) => s[4] !== s[1] || s[5] !== s[2]).reduce((n, s) => n + s[3], 0);
    }
    expect(b.flight).toBeNull();
    expect(dropped).toBeGreaterThanOrEqual(100);
    expect(arena.salvage.size).toBeGreaterThan(before);
  });

  it("spawn protection and a barrel roll let bullets through", () => {
    const { arena, a, b } = duel();
    b.protect = 5;
    a.controls.fire = true;
    let hits = 0;
    for (let i = 0; i < TICK_HZ; i++) {
      // firing ends a's own protection, but b's stays
      for (const e of arena.step().events) if (e[0] === "h") hits++;
      b.flight!.x = a.flight!.x;
    }
    expect(hits).toBe(0);
    b.protect = 0;
    b.flight!.roll = 0.3; // in the middle of a roll
    b.flight!.rollCd = 9;
    const out = arena.step();
    // anything that arrives mid-roll passes through
    expect(out.events.filter((e) => e[0] === "h")).toHaveLength(0);
  });

  it("bullets run out of reach", () => {
    const { arena, a, b } = duel(600);
    a.controls.fire = true;
    arena.step();
    a.controls.fire = false;
    for (let i = 0; i < TICK_HZ * (BULLET_LIFE + 0.2); i++) arena.step();
    expect(arena.bullets).toHaveLength(0);
    expect(b.hp).toBe(CADET.hp);
  });

  it("flying through salvage collects it, grows the plane and levels it up", () => {
    const arena = new Arena(2);
    const p = arena.join("P", "", 0);
    arena.salvage.clear();
    // just short of level 5, where Cadet becomes Wingman
    p.score = levelScore(5) - 1;
    p.level = levelOf(p.score);
    p.stats = statsAt(p.level);
    p.hp = p.stats.hp;
    const hpBefore = p.stats.hp;
    const f = p.flight!;
    // put a piece right in front of the plane
    const s = { id: 99999, x: f.x, y: f.y, v: 3, ox: f.x, oy: f.y, expires: Infinity };
    arena.salvage.set(s.id, s);
    const out = arena.step();
    expect(arena.salvage.has(s.id)).toBe(false);
    expect(out.salvageRemoved).toContain(s.id);
    expect(out.events).toContainEqual(["u", p.id, 5, 1]); // level 5, and a new rank
    expect(Math.floor(p.level)).toBe(5);
    expect(p.stats.hp).toBeGreaterThan(hpBefore);
    expect(p.hp).toBe(p.stats.hp); // the new plating arrives undamaged
  });

  it("a single point makes a plane tougher without any level-up", () => {
    const arena = new Arena(3);
    const p = arena.join("P", "", 0);
    arena.salvage.clear();
    p.score = levelScore(12) + 1;
    p.level = levelOf(p.score);
    p.stats = statsAt(p.level);
    const f = p.flight!;
    arena.salvage.set(1, { id: 1, x: f.x, y: f.y, v: 1, ox: f.x, oy: f.y, expires: Infinity });
    const before = p.stats;
    const out = arena.step();
    expect(out.events.filter((e) => e[0] === "u")).toHaveLength(0);
    expect(p.stats.hp).toBeGreaterThan(before.hp);
    expect(p.stats.dmg).toBeGreaterThan(before.dmg);
  });

  it("bots fill an empty sky and make way for people", () => {
    expect(botsFor(0)).toBe(0);
    expect(botsFor(1)).toBe(6);
    expect(botsFor(20)).toBe(0);
    const arena = new Arena(3);
    arena.join("solo", "", 0);
    arena.balanceBots();
    expect([...arena.pilots.values()].filter((p) => p.bot)).toHaveLength(6);
    for (let i = 0; i < 6; i++) arena.join(`p${i}`, "", 0);
    arena.balanceBots();
    expect([...arena.pilots.values()].filter((p) => p.bot)).toHaveLength(2);
  });

  it("bots fight: a few minutes of bots alone sees several shot down", () => {
    let kills = 0;
    for (const seed of [4, 5, 6]) {
      const arena = new Arena(seed);
      arena.join("watcher", "", 0).protect = 1e9; // a person, out of reach, so bots spawn
      arena.balanceBots();
      for (let i = 0; i < TICK_HZ * 60; i++) for (const e of arena.step().events) if (e[0] === "k") kills++;
    }
    expect(kills).toBeGreaterThanOrEqual(3);
  });

  it("no more than two bots chase one person", () => {
    const arena = new Arena(6);
    const me = arena.join("solo", "", 0);
    arena.balanceBots();
    let worst = 0;
    for (let i = 0; i < TICK_HZ * 40; i++) {
      arena.step();
      const on = [...arena.pilots.values()].filter((p) => p.brain && p.flight && p.brain.target === me.id).length;
      worst = Math.max(worst, on);
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("the leaderboard lists flying pilots by score", () => {
    const arena = new Arena(5);
    const a = arena.join("a", "", 0);
    const b = arena.join("b", "", 0);
    b.score = 50;
    a.score = 10;
    expect(arena.leaderboard().map((r) => r[0])).toEqual([b.id, a.id]);
    expect(arena.leave(a.id)?.score).toBe(10);
    expect(arena.leaderboard()).toHaveLength(1);
  });
});

describe("names and countries", () => {
  it("cleans call signs", () => {
    expect(cleanName("  Red   Baron  ", 1)).toBe("Red Baron");
    expect(cleanName("a​b‮c", 1)).toBe("abc");
    expect(cleanName("x".repeat(40), 1)).toHaveLength(16);
    expect(cleanName("", 7)).toMatch(/^Pilot \d{4}$/);
    expect(cleanName(42, 7)).toMatch(/^Pilot \d{4}$/);
    expect(cleanName("fuck", 7)).toMatch(/^Pilot \d{4}$/);
    expect(cleanName("Scunthorpe", 7)).toBe("Scunthorpe");
  });
  it("keeps only real country codes", () => {
    expect(cleanCountry("ca")).toBe("CA");
    expect(cleanCountry("XX")).toBe("");
    expect(cleanCountry("T1")).toBe("");
    expect(cleanCountry("<b>")).toBe("");
    expect(cleanCountry(null)).toBe("");
  });
});
