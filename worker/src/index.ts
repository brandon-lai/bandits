// Worker entry: routes to the one arena, adds the country Cloudflare already knows, and
// serves today's best. The game page itself is on Vercel; this is only the realtime backend.

import { ArenaDO, type Env } from "./arena-do";

export { ArenaDO };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

const withCors = (r: Response, cache = "no-store") => {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  out.headers.set("Cache-Control", cache);
  return out;
};

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const arena = env.ARENA.get(env.ARENA.idFromName("main"));

    if (url.pathname === "/ws") {
      // the country comes from Cloudflare, for free; the address is only hashed, kept in memory
      // to cap connections per household, and never written anywhere
      const headers = new Headers(req.headers);
      const cf = (req as { cf?: { country?: string } }).cf;
      headers.set("x-country", req.headers.get("CF-IPCountry") ?? cf?.country ?? "");
      headers.set("x-ip", await sha(req.headers.get("CF-Connecting-IP") ?? "local"));
      return arena.fetch(new Request("https://arena/ws", { headers }));
    }
    if (url.pathname === "/best") return withCors(await arena.fetch("https://arena/best"), "public, max-age=20");
    if (url.pathname === "/health") return withCors(await arena.fetch("https://arena/health"));
    if (url.pathname === "/") return withCors(new Response("Bandits arena server. Play at https://bandits.vercel.app\n"));
    return withCors(new Response("not found", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
