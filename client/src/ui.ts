// Everything around the picture: the join card, the kneeboard HUD, the leaderboard, the kill
// feed, toasts, the shot-down card and the connection banner.

import { PAINTS, PAINT_NAMES, TIERS } from "../../shared/game";
import type { BestRow, Me, PilotInfo, ServerMsg } from "../../shared/protocol";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function flagEmoji(cc: string) {
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
function countryName(cc: string) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}
const store = {
  get(k: string) {
    try { return localStorage.getItem(`bandits.${k}`); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(`bandits.${k}`, v); } catch { /* private mode: it just will not remember */ }
  },
};
function el(tag: string, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function tierPerks(t: number) {
  const a = TIERS[t];
  const b = TIERS[t - 1];
  const bits: string[] = [];
  if (b && a.guns > b.guns) bits.push(a.guns === 2 ? "twin guns" : `${a.guns} guns`);
  if (b) bits.push(`hull ${a.hp}`);
  if (b && a.dmg > b.dmg) bits.push(`hits for ${a.dmg}`);
  return bits.join(", ");
}

export interface UiHooks {
  fly(name: string, paint: number, flag: boolean): void;
  again(): void;
  reconnect(): void;
  leave(): void;
  touchFire(on: boolean): void;
  touchBoost(on: boolean): void;
  roll(): void;
  refreshBest(): Promise<BestRow[] | null>;
}

export class Ui {
  private paint = 0;
  private flying = false;
  private dying = false;
  private deadShown = false;
  private toastTimer = 0;
  private hintTimer = 0;
  private lastKills = -1;
  private lastHp = 1;
  private lobbyCc = "";
  private hooks!: UiHooks;

  init(hooks: UiHooks) {
    this.hooks = hooks;
    const name = $<HTMLInputElement>("name");
    name.value = store.get("name") ?? "";
    this.paint = Math.min(PAINTS.length - 1, Math.max(0, Number(store.get("paint") ?? Math.floor(Math.random() * PAINTS.length)) || 0));
    const flag = $<HTMLInputElement>("flag");
    flag.checked = store.get("flag") !== "0";

    const row = $("paints");
    PAINTS.forEach((c, i) => {
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "paint";
      r.className = "paint";
      r.value = String(i);
      r.checked = i === this.paint;
      r.style.setProperty("--swatch", c);
      r.setAttribute("aria-label", PAINT_NAMES[i]);
      r.addEventListener("change", () => { this.paint = i; });
      row.append(r);
    });

    $("join-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = $<HTMLButtonElement>("fly");
      if (btn.disabled) return;
      store.set("name", name.value.trim());
      store.set("paint", String(this.paint));
      store.set("flag", flag.checked ? "1" : "0");
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
      this.status("");
      hooks.fly(name.value.trim(), this.paint, flag.checked);
    });
    $("again").addEventListener("click", () => this.again());
    $("change").addEventListener("click", () => {
      // a new call sign or paint is a new pilot: leave the arena and come back in
      $("dead").hidden = true;
      this.deadShown = false;
      hooks.leave();
      this.showJoin();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.deadShown && !$("dead").hidden && document.activeElement?.tagName !== "BUTTON") {
        e.preventDefault();
        this.again();
      }
    });
    const about = $<HTMLDialogElement>("about");
    $("about-open").addEventListener("click", () => about.showModal());
    about.addEventListener("click", (e) => { if (e.target === about) about.close(); });

    // touch: hold to fire or burn, tap to roll
    const hold = (id: string, on: (v: boolean) => void) => {
      const b = $(id);
      const set = (v: boolean) => { b.setAttribute("aria-pressed", String(v)); on(v); };
      b.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        try { b.setPointerCapture(e.pointerId); } catch { /* the touch already ended */ }
        set(true);
      });
      for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, () => set(false));
      b.addEventListener("contextmenu", (e) => e.preventDefault());
    };
    hold("t-fire", (v) => hooks.touchFire(v));
    hold("t-boost", (v) => hooks.touchBoost(v));
    $("t-roll").addEventListener("pointerdown", (e) => { e.stopPropagation(); hooks.roll(); });

    this.loadBest();
  }

  private again() {
    if (!this.deadShown) return;
    this.deadShown = false;
    $("dead").hidden = true;
    this.hooks.again();
  }

  private status(msg: string, error = false) {
    const s = $("join-status");
    s.textContent = msg;
    s.classList.toggle("error", error);
  }

  private showJoin() {
    this.flying = false;
    $("join").hidden = false;
    $("hud").hidden = true;
    $("board").hidden = true;
    $("touch").hidden = true;
    $("hint").hidden = true;
    const btn = $<HTMLButtonElement>("fly");
    btn.removeAttribute("aria-busy");
    this.loadBest();
    $<HTMLInputElement>("name").focus({ preventScroll: true });
  }

  async loadBest() {
    const list = $("best");
    const rows = await this.hooks.refreshBest();
    list.replaceChildren();
    if (!rows) {
      list.append(el("li", "empty", "Can’t reach the board right now."));
      return;
    }
    if (rows.length === 0) {
      list.append(el("li", "empty", "Nobody has made the board today. Score 30 to be first."));
      return;
    }
    rows.forEach((r, i) => {
      const li = el("li");
      li.append(el("span", "n", String(i + 1)), el("span", "who", `${r.cc ? flagEmoji(r.cc) + " " : ""}${r.name}`), el("span", "pts", r.score.toLocaleString()));
      list.append(li);
    });
  }

  // ── from the game
  lobby(humans: number, max: number, cc: string) {
    this.lobbyCc = cc;
    const btn = $<HTMLButtonElement>("fly");
    if (!this.flying) {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.querySelector(".btn-label")!.textContent = "Fly";
    }
    $("online").textContent = humans === 0 ? "The sky is empty. Be the first up." : humans === 1 ? "1 pilot flying" : `${humans} pilots flying`;
    const flagRow = $("flag-row");
    if (cc) {
      flagRow.hidden = false;
      $("flag-text").textContent = `Show my flag ${flagEmoji(cc)} ${countryName(cc)}`;
    } else flagRow.hidden = true;
    void max;
  }

  full(max: number) {
    const btn = $<HTMLButtonElement>("fly");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    this.status(`The arena is full (${max} pilots). Try again in a minute.`, true);
  }

  connection(state: "connecting" | "open" | "closed", why?: string, wasJoined?: boolean) {
    const banner = $("conn");
    const btn = $<HTMLButtonElement>("fly");
    if (state === "open") {
      banner.hidden = true;
      return;
    }
    if (state === "connecting") {
      btn.disabled = true;
      btn.querySelector(".btn-label")!.textContent = "Connecting";
      return;
    }
    // closed
    btn.disabled = true;
    btn.querySelector(".btn-label")!.textContent = "Offline";
    banner.replaceChildren();
    const msg = why && /too many/.test(why)
      ? "Too many connections from your network. Close another Bandits tab, then reconnect."
      : wasJoined ? "Lost the connection to the arena." : "Can’t reach the arena right now.";
    const retry = el("button", "btn", "Reconnect") as HTMLButtonElement;
    retry.type = "button";
    retry.addEventListener("click", () => this.hooks.reconnect());
    banner.append(el("span", "", msg), retry);
    banner.hidden = false;
    if (wasJoined || this.flying) {
      $("dead").hidden = true;
      this.deadShown = false;
      this.showJoin();
    }
  }

  joined() {
    this.flying = true;
    this.dying = false;
    $("hud").classList.remove("down");
    this.lastKills = -1;
    $("join").hidden = true;
    $("dead").hidden = true;
    $("hud").hidden = false;
    $("board").hidden = false;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    $("touch").hidden = !coarse;
    const hint = $("hint");
    hint.hidden = coarse;
    hint.classList.remove("gone");
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => hint.classList.add("gone"), 14000);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  hud(me: Me) {
    this.mySnapshotScore = me.sc;
    const t = TIERS[me.tier];
    const next = TIERS[me.tier + 1];
    $("tier").textContent = t.name;
    $("score").textContent = me.sc.toLocaleString();
    const set = (id: string, v: number) => $(id).style.setProperty("--v", String(Math.max(0, Math.min(1, v))));
    if (next) {
      $("next-label").textContent = `Next: ${next.name} at ${next.score.toLocaleString()}`;
      set("next-bar", (me.sc - t.score) / (next.score - t.score));
    } else {
      $("next-label").textContent = "Top rank. Hold it.";
      set("next-bar", 1);
    }
    const hp = me.hp / me.max;
    set("hp-bar", hp);
    $("hp-num").textContent = String(me.hp);
    const hpm = $("hp-bar").parentElement!.parentElement!;
    hpm.classList.toggle("low", hp <= 0.25);
    hpm.classList.toggle("mid", hp > 0.25 && hp <= 0.5);
    set("en-bar", me.en / 100);
    const roll = $("roll");
    roll.classList.toggle("ready", me.cd <= 0);
    roll.textContent = me.cd <= 0 ? "Roll" : me.cd.toFixed(1);
    if (me.k !== this.lastKills) {
      this.lastKills = me.k;
      this.tally($("tally"), me.k, 14);
      $("tally").setAttribute("aria-label", `Kills this flight: ${me.k}`);
    }
    this.lastHp = hp;
  }

  /** kill marks: five stencilled slots to start with, filled in as kills land */
  private tally(box: HTMLElement, kills: number, max: number) {
    box.replaceChildren();
    const slots = Math.max(5, Math.min(kills, max));
    for (let i = 0; i < slots; i++) box.append(el("i", i < kills ? "on" : ""));
    if (kills > max) box.append(el("span", "more", `+${kills - max}`));
  }

  leaderboard(rows: { id: number; score: number; kills: number; tier: number; p: PilotInfo | undefined }[], myId: number, rank: number, n: number) {
    const list = $("board-list");
    list.replaceChildren();
    const add = (r: (typeof rows)[0] | null, i: number, meScore?: number) => {
      const li = el("li");
      const id = r ? r.id : myId;
      if (id === myId) li.classList.add("me");
      const who = el("span", "who");
      const p = r?.p;
      who.append(el("span", "nm", `${p?.cc ? flagEmoji(p.cc) + " " : ""}${p ? p.name : "You"}`));
      if (p?.bot) {
        li.classList.add("bot");
        who.append(el("span", "bot-tag", "bot"));
      }
      li.append(el("span", "n", String(i)), who, el("span", "pts", (r ? r.score : (meScore ?? 0)).toLocaleString()));
      list.append(li);
    };
    rows.forEach((r, i) => add(r, i + 1));
    if (rank > rows.length && rank > 0) {
      list.append(el("li", "gap"));
      const me = this.mySnapshotScore;
      add(null, rank, me);
    }
    $("board-title").textContent = `${n} flying`;
  }
  mySnapshotScore = 0;

  feed(killer: string, victim: string, iKilled: boolean, iDied: boolean) {
    const list = $("feed");
    const li = el("li");
    if (iKilled || iDied) li.classList.add("mine");
    if (killer && iDied) li.append(el("b", "", killer), " shot you down");
    else if (killer) li.append(el("b", "", iKilled ? "You" : killer), " shot down ", el("b", "", victim));
    else li.append(el("b", "", iDied ? "You" : victim), " went down");
    list.prepend(li);
    while (list.children.length > 5) list.lastElementChild!.remove();
    setTimeout(() => li.classList.add("dying"), 6000);
    setTimeout(() => li.remove(), 6500);
  }

  toast(text: string, kind: "kill" | "promo", sub = "") {
    const box = $("toast");
    const p = el("p", kind, text);
    if (sub) p.append(el("small", "", sub));
    box.replaceChildren(p);
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => p.classList.add("out"), kind === "promo" ? 2600 : 1600);
  }

  promoted(tier: number) {
    this.toast(`Promoted: ${TIERS[tier].name}`, "promo", tierPerks(tier));
  }

  hurt() {
    const h = $("hurt");
    h.classList.add("on");
    requestAnimationFrame(() => requestAnimationFrame(() => h.classList.remove("on")));
    if (navigator.vibrate && window.matchMedia("(pointer: coarse)").matches) navigator.vibrate(20);
  }

  hitMarker() {}
  fired() {}

  dead(m: Extract<ServerMsg, { t: "dead" }>) {
    if (this.dying) return;
    this.dying = true;
    $("dead-by").textContent = m.byName ? `by ${m.byName}` : "Out of the fight.";
    $("d-score").textContent = m.score.toLocaleString();
    $("d-kills").textContent = String(m.kills);
    $("d-time").textContent = `${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, "0")}`;
    $("d-tier").textContent = TIERS[m.tier].name;
    this.tally($("dead-tally"), m.kills, 24);
    $("touch").hidden = true;
    $("hud").classList.add("down");
    // let the wreck come apart first
    setTimeout(() => {
      if (!this.flying) return;
      $("dead").hidden = false;
      this.deadShown = true;
      $("again").focus({ preventScroll: true });
    }, 1300);
  }

  respawned() {
    $("hud").classList.remove("down");
    this.dying = false;
    this.deadShown = false;
    $("dead").hidden = true;
    $("touch").hidden = !window.matchMedia("(pointer: coarse)").matches;
  }
}
