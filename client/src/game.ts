// The game as the browser sees it: other planes are drawn a little in the past, smoothly
// between server snapshots; your own plane is flown right here, with the same rules the server
// uses, and quietly nudged back whenever the two disagree.

import {
  BULLET_LIFE, BULLET_SPEED, BOOST_MULT, CRUISE_Z, type Controls, type Flight, PAINTS, TICK_HZ, TIERS,
  clamp, fly, gunAngles, gunOffsets, newFlight, pickRadius, wrapAngle, wrapDelta, wrapPos,
} from "../../shared/game";
import type { BulletRow, Ev, Me, PilotInfo, PlaneRow, ServerMsg } from "../../shared/protocol";
import { Net } from "./net";
import { createFlameLayer } from "./render/flame-layer.js";
import { createScene } from "./render/scene.js";
import { type Ui, flagEmoji } from "./ui";

const TICK_MS = 1000 / TICK_HZ;
const INTERP = 4.5; // ticks the others are drawn behind the server (150 ms)
// Each message counts toward Cloudflare's request allowance, so the aim goes out at most
// 10 times a second and only when it has moved; a button change goes at once.
const SEND_MS = 100;
const AIM_STEP = 0.02; // radians the aim must move before it is worth sending

interface Remote {
  rows: { tk: number; r: PlaneRow }[];
  fresh: boolean;
}
interface LocalBullet { x: number; y: number; vx: number; vy: number; t: number }
interface Salvage { id: number; x: number; y: number; v: number; ox: number; oy: number; born: number; hiddenAt: number }
type Queued = { tk: number; run: () => void };

export class Game {
  net = new Net();
  scene = createScene();
  myId = -1;
  me: Me | null = null;
  pilots = new Map<number, PilotInfo>();
  remotes = new Map<number, Remote>();
  bullets = new Map<number, { r: BulletRow; mine: boolean }>();
  myBullets: LocalBullet[] = [];
  salvage = new Map<number, Salvage>();
  queue: Queued[] = [];
  mine: Flight | null = null;
  myTier = 0;
  history: { t: number; x: number; y: number }[] = [];
  controls: Controls = { aim: 0, fire: false, boost: false, roll: false };
  rollPending = false;
  gunCd = 0;
  offset = NaN; // local ms minus server tick ms (smoothed toward the earliest arrivals)
  rtt = 120;
  lastSend = 0;
  lastBits = 0;
  lastAim = 0;
  joined = false;
  camX = 1024;
  camY = 1024;
  killer = -1;
  deadAt = 0;
  lobbyCc = "";

  // input
  pointer: { x: number; y: number } | null = null;
  keyTurn = 0;
  keys = new Set<string>();
  mouseFire = false;
  mouseBoost = false;
  touchFire = false;
  touchBoost = false;

  // drawing
  canvas: HTMLCanvasElement;
  fire: HTMLCanvasElement;
  labels: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lctx: CanvasRenderingContext2D;
  image: ImageData | null = null;
  layer: ReturnType<typeof createFlameLayer> | null = null;
  fireDead = false;
  px = 3;
  ox = 0;
  oy = 0;
  dpr = 1;

  constructor(private wrap: HTMLElement, private ui: Ui) {
    this.canvas = wrap.querySelector("#world") as HTMLCanvasElement;
    this.fire = wrap.querySelector("#fire") as HTMLCanvasElement;
    this.labels = wrap.querySelector("#labels") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.lctx = this.labels.getContext("2d")!;
    this.fire.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.layer = null;
      this.fireDead = true;
      this.scene.setFlameStyle("pixel");
    });
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onState = (s, why) => {
      if (s === "closed") {
        const wasJoined = this.joined;
        this.leaveArena();
        this.ui.connection("closed", why, wasJoined);
      } else this.ui.connection(s);
    };
    this.layout();
    new ResizeObserver(() => this.layout()).observe(wrap);
    this.bindInput();
    setInterval(() => this.net.send({ t: "ping", c: performance.now() }), 5000);
    requestAnimationFrame((t) => this.frame(t));
  }

  connect() {
    this.net.connect();
  }

  join(name: string, paint: number, flag: boolean) {
    this.net.send({ t: "join", name, paint, flag });
  }

  respawn() {
    this.net.send({ t: "respawn" });
  }

  leaveArena() {
    this.joined = false;
    this.myId = -1;
    this.mine = null;
    this.me = null;
    this.remotes.clear();
    this.bullets.clear();
    this.myBullets = [];
    this.salvage.clear();
    this.queue = [];
    this.scene.setJets([]);
  }

  // ── time
  private serverTick(now = performance.now()) {
    return Number.isNaN(this.offset) ? 0 : (now - this.offset) / TICK_MS;
  }
  private renderTick(now = performance.now()) {
    return this.serverTick(now) - INTERP;
  }

  // ── the wire
  private onMessage(m: ServerMsg) {
    const now = performance.now();
    switch (m.t) {
      case "lobby":
        this.lobbyCc = m.cc;
        this.ui.lobby(m.humans, m.max, m.cc);
        break;
      case "full":
        this.ui.full(m.max);
        break;
      case "pong":
        this.rtt += (now - m.c - this.rtt) * 0.3;
        break;
      case "welcome": {
        this.myId = m.id;
        this.joined = true;
        this.pilots.clear();
        for (const p of m.pilots) this.pilots.set(p.id, p);
        this.salvage.clear();
        for (const s of m.salvage) this.salvage.set(s[0], { id: s[0], x: s[1], y: s[2], v: s[3], ox: s[1], oy: s[2], born: -1e9, hiddenAt: 0 });
        this.offset = now - m.tk * TICK_MS;
        this.ui.joined();
        break;
      }
      case "pj":
        this.pilots.set(m.p.id, m.p);
        break;
      case "pq":
        this.pilots.delete(m.id);
        this.remotes.delete(m.id);
        break;
      case "lb":
        this.ui.leaderboard(m.top.map(([id, score, kills, tier]) => ({ id, score, kills, tier, p: this.pilots.get(id) })), this.myId, m.rank, m.n);
        break;
      case "dead":
        this.ui.dead(m);
        break;
      case "s":
        this.onSnapshot(m, now);
        break;
    }
  }

  private onSnapshot(m: Extract<ServerMsg, { t: "s" }>, now: number) {
    const sample = now - m.tk * TICK_MS;
    if (Number.isNaN(this.offset) || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.03;

    const seen = new Set<number>();
    for (const r of m.p) {
      const id = r[0];
      seen.add(id);
      if (id === this.myId) {
        this.reconcile(r, now);
        continue;
      }
      let rem = this.remotes.get(id);
      if (!rem) {
        // a plane we have not seen: it either just spawned (stack it up) or flew into the game
        rem = { rows: [], fresh: this.joined && this.pilots.has(id) && this.everSeen.has(id) };
        this.remotes.set(id, rem);
      }
      this.everSeen.add(id);
      rem.rows.push({ tk: m.tk, r });
      if (rem.rows.length > 12) rem.rows.splice(0, rem.rows.length - 12);
    }
    // planes that vanished were shot down (the "k" event explodes them) or left
    for (const [id, rem] of this.remotes) {
      if (seen.has(id)) continue;
      const last = rem.rows[rem.rows.length - 1];
      if (last && m.tk - last.tk > 6) this.queue.push({ tk: last.tk + 1, run: () => this.remotes.delete(id) });
    }

    // my plane's state
    const prevAlive = this.me?.alive ?? false;
    this.me = m.me;
    if (m.me) {
      if (m.me.tier !== this.myTier) this.myTier = m.me.tier;
      if (!m.me.alive) this.mine = null;
      if (m.me.alive && !prevAlive) this.ui.respawned();
      this.ui.hud(m.me);
    }

    for (const b of m.b) {
      const mineB = b[1] === this.myId;
      this.bullets.set(b[0], { r: b, mine: mineB });
    }
    for (const s of m.sa) {
      const item: Salvage = { id: s[0], x: s[1], y: s[2], v: s[3], ox: s[4], oy: s[5], born: 0, hiddenAt: 0 };
      this.queue.push({ tk: m.tk, run: () => { item.born = performance.now(); this.salvage.set(item.id, item); } });
    }
    for (const id of m.sr) this.queue.push({ tk: m.tk, run: () => this.salvage.delete(id) });
    for (const e of m.e) this.queueEvent(e, m.tk);
  }
  private everSeen = new Set<number>();

  private queueEvent(e: Ev, tk: number) {
    const me = this.myId;
    switch (e[0]) {
      case "h": {
        const [, bid, target, x, y] = e;
        const b = this.bullets.get(bid);
        if (b?.mine) {
          // the hit is on one of my bullets: drop the local tracer nearest the hit, now
          this.dropMyBulletNear(x, y);
          this.bullets.delete(bid);
        }
        if (target === me) {
          if (this.mine) this.scene.hit(this.mine.x, this.mine.y);
          this.ui.hurt();
        } else if (b?.mine) {
          this.scene.hit(x, y);
          this.ui.hitMarker();
        } else {
          this.queue.push({ tk, run: () => { this.scene.hit(x, y); this.bullets.delete(bid); } });
        }
        break;
      }
      case "k": {
        const [, killer, victim, x, y, tier] = e;
        const vp = this.pilots.get(victim);
        const kp = this.pilots.get(killer);
        const accent = PAINTS[vp?.paint ?? 0];
        const scale = TIERS[tier].scale;
        if (victim === me) {
          const at = this.mine ?? { x, y };
          this.scene.explode(victim, at.x, at.y, accent, scale);
          this.mine = null;
          this.killer = killer;
          this.deadAt = performance.now();
        } else {
          this.queue.push({ tk, run: () => { this.scene.explode(victim, x, y, accent, scale); this.remotes.delete(victim); } });
        }
        this.ui.feed(kp ? kp.name : "", vp ? vp.name : "a pilot", killer === me, victim === me);
        if (killer === me) this.ui.toast(`Shot down ${vp ? vp.name : "a pilot"}`, "kill");
        break;
      }
      case "u":
        if (e[1] === me) this.ui.promoted(e[2]);
        break;
      case "p":
        break;
      case "j":
      case "q":
        break;
    }
  }

  private dropMyBulletNear(x: number, y: number) {
    let best = -1;
    let bestD = 80 * 80;
    for (let i = 0; i < this.myBullets.length; i++) {
      const b = this.myBullets[i];
      const d = wrapDelta(b.x - x) ** 2 + wrapDelta(b.y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) this.myBullets.splice(best, 1);
  }

  /** the server's word on my plane: start flying it if it just appeared, else ease toward it */
  private reconcile(r: PlaneRow, now: number) {
    const [, x, y, yaw, yawRate, roll, rollDir, boost] = r;
    if (!this.mine) {
      this.mine = newFlight(x, y, yaw);
      this.mine.yawRate = yawRate;
      this.controls.aim = yaw;
      this.history = [];
      this.mineFresh = true;
      return;
    }
    // compare with where we thought we were one round trip ago
    const when = now - this.rtt;
    let past: { x: number; y: number } | null = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].t <= when) { past = this.history[i]; break; }
    }
    if (!past) past = this.history[0] ?? this.mine;
    const ex = wrapDelta(x - past.x);
    const ey = wrapDelta(y - past.y);
    const f = this.mine;
    if (ex * ex + ey * ey > 140 * 140) {
      f.x = x;
      f.y = y;
      f.yaw = yaw;
      this.history = [];
    } else {
      f.x = wrapPos(f.x + ex * 0.2);
      f.y = wrapPos(f.y + ey * 0.2);
      for (const h of this.history) { h.x += ex * 0.2; h.y += ey * 0.2; }
    }
    // the server decides when a roll happens and how much afterburner is left
    if (roll >= 0 && f.roll < 0) { f.roll = roll; f.rollDir = rollDir; }
    if (this.me) f.energy += (this.me.en - f.energy) * 0.3;
    void boost;
  }
  mineFresh = false;

  // ── input
  private bindInput() {
    const wrap = this.wrap;
    const inUi = (e: Event) => (e.target as HTMLElement).closest?.("[data-ui]");
    wrap.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" && !this.steerTouch) return;
      if (e.pointerType === "touch" && this.steerTouch !== e.pointerId) return;
      this.pointer = { x: e.clientX, y: e.clientY };
      this.keyTurn = 0;
    });
    wrap.addEventListener("pointerdown", (e) => {
      if (inUi(e) || !this.joined) return;
      if (e.pointerType === "touch") {
        if (this.steerTouch === null) {
          this.steerTouch = e.pointerId;
          this.pointer = { x: e.clientX, y: e.clientY };
        }
        return;
      }
      this.pointer = { x: e.clientX, y: e.clientY };
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.mouseBoost = true;
      this.pushInput(true);
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        if (this.steerTouch === e.pointerId) this.steerTouch = null;
        return;
      }
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseBoost = false;
      this.pushInput(true);
    };
    wrap.addEventListener("pointerup", up);
    wrap.addEventListener("pointercancel", up);
    wrap.addEventListener("contextmenu", (e) => { if (!inUi(e)) e.preventDefault(); });
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    };
    window.addEventListener("keydown", (e) => {
      if (typing(e) || !this.joined || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.code;
      if (k === "Space") {
        e.preventDefault();
        if (!e.repeat) this.roll();
        return;
      }
      if (/^(Arrow(Left|Right|Up|Down)|Key[ADWSFJ]|Shift(Left|Right))$/.test(k)) {
        if (k.startsWith("Arrow")) e.preventDefault();
        this.keys.add(k);
        this.pushInput(true);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (this.keys.delete(e.code)) this.pushInput(true);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseFire = this.mouseBoost = this.touchFire = this.touchBoost = false;
      this.pushInput(true);
    });
  }
  steerTouch: number | null = null;

  roll() {
    this.rollPending = true;
    this.pushInput(true);
  }
  setTouchFire(on: boolean) {
    this.touchFire = on;
    this.pushInput(true);
  }
  setTouchBoost(on: boolean) {
    this.touchBoost = on;
    this.pushInput(true);
  }

  private readControls() {
    const k = this.keys;
    const turn = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
    const f = this.mine;
    if (turn !== 0 && f) {
      this.keyTurn = turn;
      this.pointer = null;
    }
    if (f) {
      if (this.keyTurn !== 0 && !this.pointer) {
        this.controls.aim = f.yaw + turn * 1.2;
      } else if (this.pointer) {
        // fly toward the pointer
        const [jx, jy] = this.scene.toFrame(f.x, f.y);
        const cxp = this.ox + jx * this.px;
        const cyp = this.oy + jy * this.px;
        const dx = this.pointer.x - cxp;
        const dy = this.pointer.y - cyp;
        if (dx * dx + dy * dy > 16 * 16) this.controls.aim = Math.atan2(dx, -dy);
      }
    }
    this.controls.fire = this.mouseFire || this.touchFire || k.has("KeyF") || k.has("KeyJ");
    this.controls.boost = this.mouseBoost || this.touchBoost || k.has("ShiftLeft") || k.has("ShiftRight") || k.has("KeyW") || k.has("ArrowUp");
  }

  private pushInput(now = false) {
    if (!this.joined) return;
    this.readControls();
    const bits = (this.controls.fire ? 1 : 0) | (this.controls.boost ? 2 : 0) | (this.rollPending ? 4 : 0);
    const t = performance.now();
    const buttons = bits !== this.lastBits;
    const aimMoved = Math.abs(wrapAngle(this.controls.aim - this.lastAim)) > AIM_STEP;
    if (!buttons && (!aimMoved || t - this.lastSend < SEND_MS)) return;
    if (now && !buttons && t - this.lastSend < 20) return;
    this.lastSend = t;
    this.lastBits = bits & 3;
    this.lastAim = this.controls.aim;
    this.net.send({ t: "in", a: Math.round(this.controls.aim * 1000) / 1000, b: bits });
    if (this.rollPending) {
      this.controls.roll = true;
      this.rollPending = false;
    }
  }

  // ── layout: one low-resolution frame, scaled up with hard pixels
  private layout() {
    const cw = this.wrap.clientWidth;
    const ch = this.wrap.clientHeight;
    if (!cw || !ch) return;
    this.px = clamp(Math.round(Math.sqrt((cw * ch) / 210000)), 2, 6);
    const lw = Math.ceil(cw / this.px);
    const lh = Math.ceil(ch / this.px);
    if (this.canvas.width !== lw || this.canvas.height !== lh) {
      this.canvas.width = lw;
      this.canvas.height = lh;
      this.scene.resize(lw, lh);
      this.image = null;
    }
    this.ox = Math.round((cw - lw * this.px) / 2);
    this.oy = Math.round((ch - lh * this.px) / 2);
    for (const c of [this.canvas, this.fire, this.labels]) {
      c.style.width = `${lw * this.px}px`;
      c.style.height = `${lh * this.px}px`;
      c.style.left = `${this.ox}px`;
      c.style.top = `${this.oy}px`;
    }
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const fw = Math.round(lw * this.px * this.dpr);
    const fh = Math.round(lh * this.px * this.dpr);
    for (const c of [this.fire, this.labels]) {
      if (c.width !== fw || c.height !== fh) {
        c.width = fw;
        c.height = fh;
      }
    }
  }

  // ── each frame
  private last = 0;
  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, Math.max(0, (now - (this.last || now)) / 1000));
    this.last = now;
    if (!this.scene.width) return;

    const rt = this.renderTick(now);
    // events whose moment has come on the drawn timeline
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.tk <= rt);
      if (due.length) {
        this.queue = this.queue.filter((q) => q.tk > rt);
        for (const q of due) q.run();
      }
    }

    this.pushInput();
    const f = this.mine;
    if (f && this.me?.alive) {
      const tier = TIERS[this.myTier];
      fly(f, this.controls, tier, dt);
      this.controls.roll = false;
      this.history.push({ t: now, x: f.x, y: f.y });
      while (this.history.length && now - this.history[0].t > 1500) this.history.shift();
      // my own guns fire here and now, so the tracers leave the nose when the button goes down
      this.gunCd -= dt;
      if (this.controls.fire && this.gunCd <= 0 && f.roll < 0) {
        this.gunCd = tier.fire;
        const speed = tier.speed * (1 + (BOOST_MULT - 1) * f.boost);
        const offs = gunOffsets(tier.guns);
        const angs = gunAngles(tier.guns);
        const cs = Math.cos(f.yaw);
        const sn = Math.sin(f.yaw);
        for (let g = 0; g < offs.length; g++) {
          const a = f.yaw + angs[g];
          const side = offs[g] * tier.scale;
          this.myBullets.push({
            x: f.x + cs * side + sn * 12 * tier.scale, y: f.y + sn * side - cs * 12 * tier.scale,
            vx: Math.sin(a) * (BULLET_SPEED + speed), vy: -Math.cos(a) * (BULLET_SPEED + speed), t: now,
          });
        }
        this.ui.fired();
      }
    }

    // camera: a little ahead of my plane; after a shoot-down, it drifts over to the killer
    let tx = this.camX;
    let ty = this.camY;
    if (f) {
      const look = 26 + 20 * f.boost;
      tx = f.x + Math.sin(f.yaw) * look;
      ty = f.y - Math.cos(f.yaw) * look;
    } else if (this.killer >= 0 && performance.now() - this.deadAt > 900) {
      const k = this.sample(this.killer, rt);
      if (k) { tx = k.x; ty = k.y; }
    } else if (!this.joined) {
      // the menu: a slow drift over the islands
      tx = this.camX + dt * 18;
      ty = this.camY - dt * 9;
    }
    const kc = 1 - Math.exp(-dt * (f ? 6 : 1.6));
    this.camX = wrapPos(this.camX + wrapDelta(tx - this.camX) * kc);
    this.camY = wrapPos(this.camY + wrapDelta(ty - this.camY) * kc);
    this.scene.setCamera(this.camX, this.camY);

    // planes
    const planes: any[] = [];
    if (f && this.me) {
      const tier = TIERS[this.myTier];
      planes.push({
        id: this.myId, x: f.x, y: f.y, yaw: f.yaw, yawRate: f.yawRate, roll: f.roll, rollDir: f.rollDir,
        boost: f.boost, scale: tier.scale, turn: tier.turn, accent: PAINTS[this.pilots.get(this.myId)?.paint ?? 0],
        blink: this.me.prot > 0, firing: this.controls.fire, fresh: this.mineFresh,
      });
      this.mineFresh = false;
    }
    const tags: { x: number; y: number; scale: number; hp: number; tier: number; p: PilotInfo | undefined; me: boolean }[] = [];
    for (const [id, rem] of this.remotes) {
      const s = this.sample(id, rt);
      if (!s) continue;
      const tier = TIERS[s.tier];
      const p = this.pilots.get(id);
      planes.push({
        id, x: s.x, y: s.y, yaw: s.yaw, yawRate: s.yawRate, roll: s.roll, rollDir: s.rollDir, boost: s.boost,
        scale: tier.scale, turn: tier.turn, accent: PAINTS[p?.paint ?? 0], blink: (s.flags & 1) !== 0,
        firing: (s.flags & 2) !== 0, fresh: rem.fresh,
      });
      rem.fresh = false;
      tags.push({ x: s.x, y: s.y, scale: tier.scale, hp: s.hp, tier: s.tier, p, me: false });
    }
    this.scene.setJets(planes);

    // bullets: theirs on the drawn timeline, mine on my own
    const list: { x: number; y: number; vx: number; vy: number }[] = [];
    for (const [id, b] of this.bullets) {
      const r = b.r;
      const age = (rt - r[6]) / TICK_HZ;
      if (age > BULLET_LIFE || (b.mine && (this.serverTick(now) - r[6]) / TICK_HZ > BULLET_LIFE)) { this.bullets.delete(id); continue; }
      if (b.mine || age < 0) continue;
      list.push({ x: r[2] + r[4] * age, y: r[3] + r[5] * age, vx: r[4], vy: r[5] });
    }
    this.myBullets = this.myBullets.filter((b) => (now - b.t) / 1000 < BULLET_LIFE);
    for (const b of this.myBullets) {
      const age = (now - b.t) / 1000;
      list.push({ x: b.x + b.vx * age, y: b.y + b.vy * age, vx: b.vx, vy: b.vy });
    }
    this.scene.setBullets(list);

    // salvage, hiding pieces my plane has just flown through until the server agrees
    const sal: any[] = [];
    const reach = f ? pickRadius(TIERS[this.myTier].scale) : 0;
    for (const s of this.salvage.values()) {
      if (f && !s.hiddenAt) {
        const dx = wrapDelta(s.x - f.x);
        const dy = wrapDelta(s.y - f.y);
        if (dx * dx + dy * dy < reach * reach) s.hiddenAt = now;
      }
      if (s.hiddenAt) {
        if (now - s.hiddenAt < 1200) continue;
        s.hiddenAt = 0;
      }
      sal.push({ id: s.id, x: s.x, y: s.y, v: s.v, ox: s.ox, oy: s.oy, age: (now - s.born) / 1000 });
    }
    this.scene.setSalvage(sal);

    this.scene.step(dt);
    const bytes = this.scene.render();
    if (!this.image) this.image = new ImageData(bytes as unknown as Uint8ClampedArray<ArrayBuffer>, this.scene.width, this.scene.height);
    this.ctx.putImageData(this.image, 0, 0);

    const flames = this.scene.flames;
    if (flames.count > 0 && !this.layer && !this.fireDead) {
      this.layer = createFlameLayer(this.fire);
      if (!this.layer) {
        this.fireDead = true;
        this.scene.setFlameStyle("pixel");
      }
    }
    if (this.layer) this.layer.draw(flames.count, flames.data, this.fire.width / this.scene.width, now / 1000);

    this.drawLabels(tags, f);
  }

  /** a remote plane on the drawn timeline: between the two snapshots around it, or a little past the last */
  sample(id: number, rt: number) {
    const rem = this.remotes.get(id);
    if (!rem || rem.rows.length === 0) return null;
    const rows = rem.rows;
    let a = rows[0];
    let b = rows[0];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].tk <= rt) a = rows[i];
      if (rows[i].tk > rt) { b = rows[i]; break; }
      b = rows[i];
    }
    const ra = a.r;
    const rb = b.r;
    if (a === b || rb[0] !== ra[0]) {
      // past the newest snapshot: carry on along the heading for a moment
      const ahead = clamp((rt - a.tk) / TICK_HZ, 0, 0.25);
      const sp = TIERS[ra[9]].speed * (1 + (BOOST_MULT - 1) * ra[7]);
      return {
        x: wrapPos(ra[1] + Math.sin(ra[3]) * sp * ahead), y: wrapPos(ra[2] - Math.cos(ra[3]) * sp * ahead),
        yaw: ra[3], yawRate: ra[4], roll: ra[5], rollDir: ra[6], boost: ra[7], hp: ra[8], tier: ra[9], flags: ra[10],
      };
    }
    const t = clamp((rt - a.tk) / (b.tk - a.tk), 0, 1);
    const lerp = (u: number, v: number) => u + (v - u) * t;
    let roll = rb[5] >= 0 && ra[5] >= 0 ? lerp(ra[5], rb[5]) : t < 0.5 ? ra[5] : rb[5];
    if (rb[5] >= 0 && ra[5] < 0 && t >= 0.5) roll = rb[5];
    return {
      x: wrapPos(ra[1] + wrapDelta(rb[1] - ra[1]) * t),
      y: wrapPos(ra[2] + wrapDelta(rb[2] - ra[2]) * t),
      yaw: ra[3] + wrapAngle(rb[3] - ra[3]) * t,
      yawRate: lerp(ra[4], rb[4]), roll, rollDir: rb[6], boost: lerp(ra[7], rb[7]), hp: rb[8], tier: rb[9], flags: rb[10],
    };
  }

  // ── names over the planes, and arrows to the ones just out of sight
  private drawLabels(tags: { x: number; y: number; scale: number; hp: number; tier: number; p: PilotInfo | undefined }[], f: Flight | null) {
    const c = this.lctx;
    const k = this.px * this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.labels.width, this.labels.height);
    if (!this.joined) return;
    const W = this.labels.width;
    const H = this.labels.height;
    const d = this.dpr;
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    c.font = `600 ${11 * d}px "IBM Plex Mono", ui-monospace, monospace`;
    for (const t of tags) {
      const [fx, fy] = this.scene.toFrame(t.x, t.y, CRUISE_Z);
      const X = fx * k;
      const Y = fy * k;
      const half = 26 * t.scale * k;
      if (X < -60 * d || Y < -60 * d || X > W + 60 * d || Y > H + 60 * d) {
        this.arrow(c, X, Y, W, H, t.p, f ? Math.hypot(wrapDelta(t.x - f.x), wrapDelta(t.y - f.y)) : 0);
        continue;
      }
      const name = t.p ? t.p.name : "";
      const flag = t.p?.cc ? flagEmoji(t.p.cc) + " " : "";
      const label = `${flag}${name}`;
      const ty = Y - half - 8 * d;
      c.fillStyle = "rgba(6, 14, 30, 0.55)";
      const w = c.measureText(label).width + 10 * d;
      c.fillRect(X - w / 2, ty - 12 * d, w, 16 * d);
      c.fillStyle = "rgba(246, 248, 252, 0.96)";
      c.fillText(label, X, ty);
      // health, under the plane
      const bw = 30 * d * Math.max(0.8, t.scale);
      const by = Y + half * 0.7 + 4 * d;
      c.fillStyle = "rgba(6, 14, 30, 0.6)";
      c.fillRect(X - bw / 2 - d, by - d, bw + 2 * d, 4 * d);
      c.fillStyle = t.hp > 0.5 ? "#7fd36b" : t.hp > 0.25 ? "#f2c230" : "#f04a3a";
      c.fillRect(X - bw / 2, by, bw * clamp(t.hp, 0, 1), 2 * d);
    }
  }

  private arrow(c: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, p: PilotInfo | undefined, dist: number) {
    if (dist > 900) return;
    const d = this.dpr;
    const cx = W / 2;
    const cy = H / 2;
    const ang = Math.atan2(Y - cy, X - cx);
    const m = 22 * d;
    // where the line to the plane leaves the frame
    const sx = (W / 2 - m) / Math.max(1e-6, Math.abs(Math.cos(ang)));
    const sy = (H / 2 - m) / Math.max(1e-6, Math.abs(Math.sin(ang)));
    const r = Math.min(sx, sy);
    const ax = cx + Math.cos(ang) * r;
    const ay = cy + Math.sin(ang) * r;
    const a = clamp(1.15 - dist / 900, 0.25, 1);
    c.save();
    c.translate(ax, ay);
    c.rotate(ang);
    c.globalAlpha = a;
    c.fillStyle = PAINTS[p?.paint ?? 0];
    c.strokeStyle = "rgba(6, 14, 30, 0.8)";
    c.lineWidth = 2 * d;
    c.beginPath();
    c.moveTo(9 * d, 0);
    c.lineTo(-6 * d, -7 * d);
    c.lineTo(-3 * d, 0);
    c.lineTo(-6 * d, 7 * d);
    c.closePath();
    c.stroke();
    c.fill();
    c.restore();
  }
}
