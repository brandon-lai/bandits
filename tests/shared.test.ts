import { describe, expect, it } from "vitest";
import { Arena, botsFor } from "../shared/arena";
import { BULLET_LIFE, HIT_POINTS, TICK_HZ, TIERS, WORLD, fly, newFlight, tierFor, wrapDelta } from "../shared/game";
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
    const t = TIERS[0];
    for (let i = 0; i < 3; i++) fly(f, { aim: Math.PI / 2, fire: false, boost: false, roll: false }, t, 1 / 30);
    expect(f.yaw).toBeGreaterThan(0);
    expect(Math.abs(f.yawRate)).toBeLessThanOrEqual(t.turn + 1e-9);
    for (let i = 0; i < 90; i++) fly(f, { aim: Math.PI / 2, fire: false, boost: false, roll: false }, t, 1 / 30);
    expect(f.yaw).toBeCloseTo(Math.PI / 2, 1);
  });

  it("wraps round the edge of the world", () => {
    const f = newFlight(5, 5, 0);
    fly(f, { aim: 0, fire: false, boost: false, roll: false }, TIERS[0], 0.2);
    expect(f.y).toBeGreaterThan(WORLD - 20);
    expect(wrapDelta(WORLD - 2 - 3)).toBe(-5);
  });

  it("the afterburner needs energy, drains it, and goes faster", () => {
    const f = newFlight(0, 0, 0);
    const c = { aim: 0, fire: false, boost: true, roll: false };
    let fast = 0;
    for (let i = 0; i < 30; i++) fast = fly(f, c, TIERS[0], 1 / 30);
    expect(fast).toBeGreaterThan(TIERS[0].speed * 1.5);
    expect(f.energy).toBeLessThan(70);
    while (f.energy > 0) fly(f, c, TIERS[0], 1 / 30);
    // run dry, it stays out until there is enough to relight, even with the button held
    for (let i = 0; i < 30; i++) {
      fly(f, c, TIERS[0], 1 / 30);
      expect(f.burning).toBe(false);
    }
  });

  it("a barrel roll has a cooldown", () => {
    const f = newFlight(0, 0, 0);
    fly(f, { aim: 0, fire: false, boost: false, roll: true }, TIERS[0], 1 / 30);
    expect(f.roll).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 30; i++) fly(f, { aim: 0, fire: false, boost: false, roll: false }, TIERS[0], 1 / 30);
    expect(f.roll).toBe(-1);
    fly(f, { aim: 0, fire: false, boost: false, roll: true }, TIERS[0], 1 / 30);
    expect(f.roll).toBe(-1); // still cooling down
  });
});

describe("tiers", () => {
  it("score buys tiers in order, and bigger planes turn slower", () => {
    expect(tierFor(0)).toBe(0);
    expect(tierFor(TIERS[3].score)).toBe(3);
    expect(tierFor(99999)).toBe(TIERS.length - 1);
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i].score).toBeGreaterThan(TIERS[i - 1].score);
      expect(TIERS[i].hp).toBeGreaterThan(TIERS[i - 1].hp);
      expect(TIERS[i].turn).toBeLessThan(TIERS[i - 1].turn);
      expect(TIERS[i].scale).toBeGreaterThan(TIERS[i - 1].scale);
    }
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
    expect(kill).toEqual(["k", a.id, b.id, expect.any(Number), expect.any(Number), 0]);
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
    b.tier = tierFor(200);
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
    expect(b.hp).toBe(TIERS[0].hp);
  });

  it("flying through salvage collects it and promotes the pilot", () => {
    const arena = new Arena(2);
    const p = arena.join("P", "", 0);
    p.score = TIERS[1].score - 1;
    p.tier = tierFor(p.score);
    const f = p.flight!;
    // put a piece right in front of the plane
    const s = { id: 99999, x: f.x, y: f.y, v: 3, ox: f.x, oy: f.y, expires: Infinity };
    arena.salvage.set(s.id, s);
    const out = arena.step();
    expect(arena.salvage.has(s.id)).toBe(false);
    expect(out.salvageRemoved).toContain(s.id);
    expect(out.events).toContainEqual(["u", p.id, 1]);
    expect(p.tier).toBe(1);
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

  it("bots fight: a minute of bots alone ends with someone shot down", () => {
    const arena = new Arena(4);
    arena.join("watcher", "", 0).protect = 1e9; // a person, out of reach, so bots spawn
    arena.balanceBots();
    let kills = 0;
    for (let i = 0; i < TICK_HZ * 60; i++) for (const e of arena.step().events) if (e[0] === "k") kills++;
    expect(kills).toBeGreaterThan(0);
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
