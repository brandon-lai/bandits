// Integration tests against a real local Worker + Durable Object (wrangler dev), for the rules
// that involve identity and the shared board: names are cleaned, the flag is opt-in per join,
// connections per address are capped, the board records the day's best and stores no address.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 8798;
const B = `http://localhost:${PORT}`;
let proc: ChildProcess;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const state = mkdtempSync(join(tmpdir(), "bandits-test-"));
  try {
    await fetch(B);
    throw new Error(`port ${PORT} is already serving; stop the old wrangler first`);
  } catch (e) {
    if ((e as Error).message.startsWith("port")) throw e;
  }
  proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--var", "PER_IP:3", "--var", "MAX_HUMANS:5", "--persist-to", state], {
    cwd: new URL("../worker", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${B}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("wrangler dev did not start");
}, 60_000);

// npx spawns wrangler which spawns workerd: kill the whole group
afterAll(() => {
  if (proc?.pid) process.kill(-proc.pid, "SIGTERM");
});

type Msg = { t: string; [k: string]: any };

class Client {
  ws!: WebSocket;
  msgs: Msg[] = [];
  closed = false;
  static async open(country = "CA") {
    const c = new Client();
    // wrangler dev passes CF-IPCountry through from the request, which is how we fake a country
    c.ws = new WebSocket(`${B.replace("http", "ws")}/ws`, { headers: { "CF-IPCountry": country } } as any);
    c.ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data as string));
    c.ws.onclose = () => { c.closed = true; };
    await new Promise((r, j) => { c.ws.onopen = r; c.ws.onerror = j; });
    await c.waitFor((m) => m.t === "lobby" || m.t === "full");
    return c;
  }
  send(m: unknown) { this.ws.send(typeof m === "string" ? m : JSON.stringify(m)); }
  async waitFor(pred: (m: Msg) => boolean, ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out; saw ${[...new Set(this.msgs.map((m) => m.t))].join(",")}`);
      await sleep(30);
    }
  }
  async join(name: string, flag = true) {
    this.send({ t: "join", name, paint: 2, flag });
    return this.waitFor((m) => m.t === "welcome");
  }
  close() { this.ws.close(); }
}

describe("the arena server", () => {
  it("welcomes a pilot, fills the sky with bots, and streams snapshots", async () => {
    const c = await Client.open("CA");
    const lobby = c.msgs.find((m) => m.t === "lobby")!;
    expect(lobby.cc).toBe("CA");
    const w = await c.join("Tester");
    const me = w.pilots.find((p: any) => p.id === w.id);
    expect(me).toMatchObject({ name: "Tester", cc: "CA", paint: 2, bot: false });
    expect(w.pilots.filter((p: any) => p.bot)).toHaveLength(6);
    expect(w.salvage.length).toBeGreaterThan(100);
    const s = await c.waitFor((m) => m.t === "s" && m.me);
    expect(s.me.alive).toBe(true);
    expect(s.p.some((r: number[]) => r[0] === w.id)).toBe(true);
    const lb = await c.waitFor((m) => m.t === "lb", 3000);
    expect(lb.n).toBe(7);
    c.close();
  });

  it("hides the flag when the pilot turns it off", async () => {
    const c = await Client.open("FR");
    const w = await c.join("NoFlag", false);
    expect(w.pilots.find((p: any) => p.id === w.id).cc).toBe("");
    c.close();
  });

  it("cleans call signs: control characters, length, and slurs", async () => {
    const a = await Client.open();
    const w1 = await a.join("  Ace​‮   High  but this is far too long  ");
    expect(w1.pilots.find((p: any) => p.id === w1.id).name).toBe("Ace High but thi");
    const b = await Client.open();
    const w2 = await b.join("shithead");
    expect(w2.pilots.find((p: any) => p.id === w2.id).name).toMatch(/^Pilot \d{4}$/);
    a.close();
    b.close();
  });

  it("ignores garbage and floods without falling over", async () => {
    const c = await Client.open();
    await c.join("Robust");
    c.send("not json");
    c.send({ t: "in", a: "NaN", b: "x" });
    c.send({ t: "in", a: 1e309, b: 7 });
    c.send("x".repeat(5000));
    await c.waitFor((m) => m.t === "s");
    // more than the per-second limit closes the socket
    for (let i = 0; i < 200; i++) c.send({ t: "in", a: 0, b: 0 });
    for (let i = 0; i < 40 && !c.closed; i++) await sleep(50);
    expect(c.closed).toBe(true);
    const h = await (await fetch(`${B}/health`)).json();
    expect(h.rejected).toBeGreaterThan(0);
  });

  it("caps connections from one address", async () => {
    await sleep(300);
    const open = [await Client.open(), await Client.open(), await Client.open()];
    const fourth = await Client.open();
    expect(fourth.msgs[0]).toMatchObject({ t: "full" });
    for (let i = 0; i < 40 && !fourth.closed; i++) await sleep(50);
    expect(fourth.closed).toBe(true);
    for (const c of open) c.close();
  });

  it("serves today's best with no addresses in it, and stops when the last pilot leaves", async () => {
    await sleep(300);
    const best = await (await fetch(`${B}/best`)).json();
    expect(Array.isArray(best)).toBe(true);
    for (const r of best) expect(Object.keys(r).sort()).toEqual(["cc", "kills", "name", "score", "tier"]);
    for (let i = 0; i < 40; i++) {
      const h = await (await fetch(`${B}/health`)).json();
      if (!h.running) {
        expect(h.humans).toBe(0);
        return;
      }
      await sleep(100);
    }
    throw new Error("the arena kept running with nobody in it");
  });
});
