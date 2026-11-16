// The connection to the arena server.

import type { BestRow, ClientMsg, ServerMsg } from "../../shared/protocol";

const DEFAULT_SERVER = import.meta.env.DEV ? "ws://localhost:8787" : "wss://bandits.flockfield-server.workers.dev";
export const SERVER = (import.meta.env.VITE_SERVER as string | undefined) || new URLSearchParams(location.search).get("server") || DEFAULT_SERVER;
const HTTP = SERVER.replace(/^ws/, "http");

export type NetState = "connecting" | "open" | "closed";

export class Net {
  ws: WebSocket | null = null;
  state: NetState = "closed";
  onMessage: (m: ServerMsg) => void = () => {};
  onState: (s: NetState, why?: string) => void = () => {};

  connect() {
    this.close();
    this.state = "connecting";
    this.onState("connecting");
    const ws = new WebSocket(`${SERVER}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.state = "open";
      this.onState("open");
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      try {
        this.onMessage(JSON.parse(e.data) as ServerMsg);
      } catch {
        // a malformed frame is dropped, not fatal
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.state = "closed";
      this.onState("closed", e.reason);
    };
  }

  send(m: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
    this.state = "closed";
  }
}

export async function fetchBest(): Promise<BestRow[] | null> {
  try {
    const r = await fetch(`${HTTP}/best`);
    if (!r.ok) return null;
    return (await r.json()) as BestRow[];
  } catch {
    return null;
  }
}
