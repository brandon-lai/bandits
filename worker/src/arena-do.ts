// One Durable Object holds the whole arena: it steps the simulation 30 times a second while
// anyone is connected, and goes quiet (bots and all) when the last person leaves.

import { Arena, type LifeEnd } from "../../shared/arena";
import { SNAPSHOT_EVERY, TICK_HZ } from "../../shared/game";
import { cleanCountry, cleanName } from "../../shared/names";
import type { BestRow, BulletRow, ClientMsg, Ev, SalvageRow } from "../../shared/protocol";

export interface Env {
  ARENA: DurableObjectNamespace;
  MAX_HUMANS?: string;
  PER_IP?: string;
}

interface Conn {
  ws: WebSocket;
  pilot: number; // -1 until they join
  ip: string;
  country: string;
  window: number; // messages in the current second
  windowStart: number;
}

const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export class ArenaDO implements DurableObject {
  private arena = new Arena();
  private conns = new Set<Conn>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private pending = { b: [] as BulletRow[], sa: [] as SalvageRow[], sr: [] as number[], e: [] as Ev[] };
  private stats = { msgs: 0, rejected: 0, ticks: 0, slowTicks: 0, joins: 0 };
  private sql: SqlStorage;

  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS best (
      day TEXT NOT NULL, name TEXT NOT NULL, cc TEXT NOT NULL, score INTEGER NOT NULL,
      kills INTEGER NOT NULL, tier INTEGER NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS best_day ON best (day, score DESC)");
  }

  private get maxHumans() {
    return Number(this.env.MAX_HUMANS ?? 40) || 40;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return this.upgrade(req);
    if (url.pathname === "/best") return Response.json(this.best());
    if (url.pathname === "/health") {
      let bots = 0;
      for (const p of this.arena.pilots.values()) if (p.bot) bots++;
      return Response.json({
        ok: true, running: !!this.loop, sockets: this.conns.size, humans: this.arena.humans, bots,
        salvage: this.arena.salvage.size, bullets: this.arena.bullets.length, ...this.stats,
      });
    }
    return new Response("not found", { status: 404 });
  }

  private best(): BestRow[] {
    return this.sql
      .exec("SELECT name, cc, score, kills, tier FROM best WHERE day = ? ORDER BY score DESC, at ASC LIMIT 10", day())
      .toArray() as unknown as BestRow[];
  }

  private upgrade(req: Request): Response {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const ip = req.headers.get("x-ip") ?? "local";
    const perIp = Number(this.env.PER_IP ?? 4) || 4;
    let same = 0;
    for (const c of this.conns) if (c.ip === ip) same++;
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    // (newer runtimes deliver binary frames as Blobs; this protocol is text, but be explicit)
    (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    if (same >= perIp) {
      ws.send(JSON.stringify({ t: "full", max: perIp }));
      ws.close(1008, "too many connections from one address");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const conn: Conn = { ws, pilot: -1, ip, country: cleanCountry(req.headers.get("x-country")), window: 0, windowStart: Date.now() };
    this.conns.add(conn);
    ws.send(JSON.stringify({ t: "lobby", humans: this.arena.humans, max: this.maxHumans, cc: conn.country }));
    ws.addEventListener("message", (e) => this.onMessage(conn, e.data));
    const bye = () => this.drop(conn);
    ws.addEventListener("close", bye);
    ws.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private drop(conn: Conn) {
    if (!this.conns.delete(conn)) return;
    if (conn.pilot >= 0) {
      const ends = this.arena.leave(conn.pilot);
      if (ends) this.lifeEnded(ends);
    }
    this.arena.balanceBots();
    this.flushJoinsAndQuits();
    if (this.arena.humans === 0) this.stop();
  }

  private onMessage(conn: Conn, data: unknown) {
    const now = Date.now();
    if (now - conn.windowStart > 1000) { conn.window = 0; conn.windowStart = now; }
    conn.window++;
    this.stats.msgs++;
    if (conn.window > 120) { conn.ws.close(1008, "too many messages"); return; }
    if (conn.window > 60 || typeof data !== "string" || data.length > 300) { this.stats.rejected++; return; }
    let m: ClientMsg;
    try { m = JSON.parse(data); } catch { this.stats.rejected++; return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "in" && conn.pilot >= 0) {
      this.arena.input(conn.pilot, Number(m.a), Number(m.b) | 0);
    } else if (m.t === "ping") {
      conn.ws.send(JSON.stringify({ t: "pong", c: Number(m.c) || 0, tk: this.arena.tick }));
    } else if (m.t === "respawn" && conn.pilot >= 0) {
      this.arena.respawn(conn.pilot);
    } else if (m.t === "join" && conn.pilot < 0) {
      if (this.arena.humans >= this.maxHumans) {
        conn.ws.send(JSON.stringify({ t: "full", max: this.maxHumans }));
        return;
      }
      const name = cleanName(m.name, this.stats.joins * 7919 + now);
      const p = this.arena.join(name, m.flag === true ? conn.country : "", Number(m.paint) | 0);
      conn.pilot = p.id;
      this.stats.joins++;
      this.arena.balanceBots();
      // everyone else hears about the newcomer (and any bots that came or went) first
      this.flushJoinsAndQuits(conn);
      conn.ws.send(JSON.stringify({
        t: "welcome", id: p.id, tk: this.arena.tick,
        pilots: [...this.arena.pilots.values()].map((q) => this.arena.info(q)),
        salvage: this.arena.allSalvage(),
      }));
      this.start();
    }
  }

  /** tell everyone about pilots that joined or left outside a tick */
  private flushJoinsAndQuits(skip?: Conn) {
    for (const p of this.arena.pilots.values()) {
      if (this.known.has(p.id)) continue;
      this.known.add(p.id);
      this.broadcast(JSON.stringify({ t: "pj", p: this.arena.info(p) }), skip);
    }
    for (const id of [...this.known]) {
      if (this.arena.pilots.has(id)) continue;
      this.known.delete(id);
      this.broadcast(JSON.stringify({ t: "pq", id }), skip);
    }
  }
  private known = new Set<number>();

  private start() {
    if (this.loop) return;
    this.loop = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  private stop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    // with nobody watching, start the next session fresh
    this.arena = new Arena();
    this.known.clear();
    this.pending = { b: [], sa: [], sr: [], e: [] };
  }

  private tick() {
    const t0 = Date.now();
    const out = this.arena.step();
    this.stats.ticks++;
    this.pending.b.push(...out.bullets);
    this.pending.sa.push(...out.salvageAdded);
    this.pending.sr.push(...out.salvageRemoved);
    this.pending.e.push(...out.events);
    for (const end of out.lifeEnds) this.lifeEnded(end);
    if (out.events.some((e) => e[0] === "j" || e[0] === "q")) this.flushJoinsAndQuits();

    if (this.arena.tick % SNAPSHOT_EVERY === 0) {
      const base = JSON.stringify({ t: "s", tk: this.arena.tick, p: this.arena.planes(), ...this.pending });
      const head = base.slice(0, -1) + ',"me":';
      for (const c of this.conns) {
        if (c.pilot < 0) continue;
        this.send(c, head + JSON.stringify(this.arena.me(c.pilot)) + "}");
      }
      this.pending = { b: [], sa: [], sr: [], e: [] };
    }
    if (this.arena.tick % TICK_HZ === 0) {
      const all = this.arena.leaderboard();
      const top = all.slice(0, 10);
      for (const c of this.conns) {
        if (c.pilot < 0) continue;
        const rank = all.findIndex((r) => r[0] === c.pilot) + 1;
        this.send(c, JSON.stringify({ t: "lb", top, rank, n: all.length }));
      }
    }
    if (Date.now() - t0 > 20) this.stats.slowTicks++;
  }

  private lifeEnded(end: LifeEnd) {
    const p = end.pilot;
    if (p.bot) return;
    for (const c of this.conns) {
      if (c.pilot !== p.id) continue;
      this.send(c, JSON.stringify({
        t: "dead", by: end.killer ? end.killer.id : -1, byName: end.killer ? end.killer.name : "",
        score: end.score, kills: end.kills, seconds: Math.round(end.seconds), level: end.level,
      }));
    }
    if (end.score >= 30) {
      this.sql.exec("INSERT INTO best (day, name, cc, score, kills, tier, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        day(), p.name, p.cc, end.score, end.kills, end.level, Date.now());
      // keep a few days, and only the rows that could still matter
      this.sql.exec("DELETE FROM best WHERE day < ?", day(Date.now() - 3 * 86400_000));
      this.sql.exec(`DELETE FROM best WHERE day = ?1 AND rowid NOT IN
        (SELECT rowid FROM best WHERE day = ?1 ORDER BY score DESC LIMIT 50)`, day());
    }
  }

  private send(c: Conn, s: string) {
    try { c.ws.send(s); } catch { this.drop(c); }
  }

  private broadcast(s: string, skip?: Conn) {
    for (const c of this.conns) if (c.pilot >= 0 && c !== skip) this.send(c, s);
  }
}
