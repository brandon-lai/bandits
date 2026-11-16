# Bandits

**A pixel-art dogfighting arena in the browser: pick a call sign, shoot down other pilots,
and your plane grows from Cadet to Air Marshal.** No account. Live at
**https://bandits-game.vercel.app**. (`bandits.vercel.app` belongs to another Vercel account;
the project's default domain is `bandits-zeta.vercel.app`.)

Design direction: [DESIGN.md](DESIGN.md).

## How the original was built

The starting point was the Forge fragment
[“fighter”](https://forge.ui8.ai/share/frag_1eb8944c-57b1-42ca-a909-5c2d7e517c24). Under the
share page's React shell, the fragment itself is:

- **A React 19 component** (`fighter-jet-scene.tsx`) loaded from esm.sh, which owns a
  `<canvas>`, input handling and a `requestAnimationFrame` loop. It has no images or 3D engine.
- **A small CPU software renderer** (`lib/scene.ts`, ~2,100 lines) that writes every pixel
  of a low-resolution `Uint32Array` frame, shown scaled up with `image-rendering: pixelated`.
- **Sprite stacking:** the jet is 13 horizontal voxel slices of 34×46 px, stored as
  run-length-encoded palette indices in `lib/jet-model.ts`. Each slice is drawn one pixel
  above the last and rotated to the jet's heading, roll and pitch, which fakes 3D.
- **A procedural world:** a 2048×2048 wrapping heightmap built from six octaves of tileable
  value noise, terraced into sea, surf, sand, grass, rock and snow, with forests stamped on
  as little cones and clouds as stacked puffs. The ground is drawn as stacks too.
- **A WebGL overlay** (`lib/flame-layer.ts`) that draws the afterburner plumes as shaded
  noise along a curve, at full screen resolution over the pixel frame.
- A cockpit view (`lib/cockpit.ts`) and a chase camera, which the arena does not use.

## What Bandits keeps and adds

`client/src/render/` keeps the renderer's world, voxel jet, palettes, outlines, shadows,
wingtip trails, exhaust smoke and the WebGL flames (`jet-model.js` and `flame-layer.js` are
unchanged). `scene.js` is a rewrite for the arena: overhead camera only (north up, so a
pointer aim is predictable), any number of jets with their own paint and size, tracers,
salvage, fireballs, sparks, a stack-up when a plane spawns, and wrecks that come apart slice
by slice.

```
client/   Vite page: renderer, game loop (prediction + interpolation), DOM interface
shared/   the rules (game.ts), the arena simulation (arena.ts), the wire protocol, name cleaning
worker/   Cloudflare Worker + one Durable Object that runs the arena at 30 ticks a second
tests/    shared.test.ts (rules, offline) and server.test.ts (a real local Worker)
```

The server is authoritative: it steps every plane, bullet and pickup, decides every hit and
sends 15 snapshots a second. Your own plane is flown in the browser with the same `fly()`
code and nudged toward the server's version, so steering has no lag. Everyone else is drawn
150 ms in the past, smoothly between snapshots.

## The mechanics (decided here)

- **Score** comes from salvage (1 point a piece, scattered around the map) and kills
  (20 + 20% of the victim's score). A downed plane also drops salvage worth half its score.
- **Eight tiers:** Cadet, Wingman, Flight Lead, Ace, Double Ace, Squadron Leader, Wing
  Commander, Air Marshal. Each step means a bigger plane, more hull (100 → 380), harder hits
  (10 → 18), more guns (1 → 4, spreading wider) and a faster fire rate. **It also means a
  slower turn (2.3 → 1.3 rad/s)**, so a Cadet can always out-turn an Air Marshal. That is
  the agar.io balance: big is strong and slow, small is weak and nimble.
- **Afterburner:** 1.75× speed, drains energy and refills after a pause.
- **Barrel roll:** bullets pass through you for most of a 0.7 s roll, with a 3.2 s cooldown.
- **Spawn protection:** 3 s, ends early if you fire. Hull repairs itself after 5 s untouched.
- **Death:** you respawn as a Cadet with 0 points, as in agar.io.
- **Bots:** with 1 person on there are 6 bots, tapering to none at 9 people. They are
  marked `bot` everywhere, score at half rate so people stay on top, hunt across the map,
  lead their shots, flee when hurt and break out of turning circles.

## Open questions, and the answers shipped

- **Show country? (controversial?)** Shipped as **on by default, one checkbox to turn
  off**, with the country named on the join card. The country comes from Cloudflare's
  `CF-IPCountry` (no permission prompt, no lookup service), is only sent when the box is
  ticked, and the IP itself is never stored. The real risks are nationalist pile-ons and
  disputed territories. They are kept small because flags are opt-out per join, shown
  as a flag only (other pilots never see a country name), and never used in scoring or
  matchmaking. VPN users get their exit country. That is acceptable for a game.
- **Leaderboard:** a live one (top 10 in the arena, plus your own rank) and **today's best**
  (top 10 peak scores of the UTC day, from scores of 30+). The second one gives a short
  session something to aim at, which agar.io never did.
- **Names:** 16 characters, NFKC-normalised, control and bidi characters stripped, and
  slurs or profanity (the `obscenity` English set) replaced with “Pilot ####”.
- **Arena size:** one shared arena, 40 people at most, 4 connections per address.
  Sharding into several arenas is the next step if it ever fills up.

## Run it

```bash
npm install && (cd worker && npm install)
(cd worker && npx wrangler dev --port 8787)   # the arena
npm run dev                                   # the page, http://localhost:5207
npm test                                      # rules (15 tests)
npm run test:server                           # a real local Worker (6 tests)
npm run typecheck
```

The page connects to `ws://localhost:8787` in dev, and to
`wss://bandits.flockfield-server.workers.dev` in production. Override it with
`VITE_SERVER` or `?server=wss://…`.

## Deploys

- **Page:** Vercel, git-connected. Pushing to `main` deploys it.
- **Arena:** Cloudflare Worker `bandits` with one SQLite Durable Object, at
  `https://bandits.flockfield-server.workers.dev` (`/health`, `/best`). The first deploy was
  made from a `git archive` of `main`. After that, `.github/workflows/worker.yml` deploys
  `worker/` and `shared/` on every push to `main`, once the repo has the secrets below.

## Owner checklist

1. **Cloudflare token for Worker deploys from GitHub:** `CLOUDFLARE_ACCOUNT_ID` is set.
   Create an API token with the *Edit Cloudflare Workers* template, then
   `gh secret set CLOUDFLARE_API_TOKEN -R brandon-lai/bandits`. Until then the workflow
   skips (green), and Worker changes need `cd worker && npx wrangler deploy`.
2. **Playtest with real people.** Bots and probes have flown it; humans on two machines
   have not. Watch for rubber-banding on high-latency connections.
3. **Cloudflare plan limits:** the arena Durable Object runs while anyone is connected and
   sleeps when the last person leaves. On the free plan, a full day of continuous play should fit
   inside the daily duration allowance, but each player's inputs count as requests. The page
   sends its aim at most 10 times a second and only when it moves (about 0.4 requests a
   second for a player steering hard, near zero flying straight). Many players for many hours will need Workers Paid ($5/mo).
4. **Credit and permission:** the renderer is adapted from the “fighter” Forge fragment
   with its author's permission (confirmed 2026-11-16). It is credited in the About dialog.
5. **The `flockfield-server` workers.dev subdomain** is shared with Flock and Labyrinth. A
   custom domain would make the arena URL your own.
