---
version: alpha
name: Bandits
description: Flight-line stencil paint on deep navy, over a living pixel-art sea.
colors:
  primary: "#f0580e"
  primary-ink: "#0b1a33"
  sea: "#2468b4"
  panel: "#0b1a33"
  ink: "#eef2f8"
  ink-muted: "#a9b5c9"
  hull: "#7fd36b"
  warn: "#f2c230"
  danger: "#f04a3a"
  salvage: "#ffd65c"
typography:
  display:
    fontFamily: Big Shoulders Stencil
    fontWeight: 800
    fontSize: 4.6rem
    lineHeight: 0.95
  body:
    fontFamily: B612
    fontWeight: 400
    fontSize: 16px
    lineHeight: 1.5
  figures:
    fontFamily: B612 Mono
    fontWeight: 700
    fontSize: 13px
rounded:
  sm: 2px
  md: 3px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.md}"
    height: 52px
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
---

# Bandits design

**Mode:** Experience. The game is the artifact and the interface recedes: every panel is a
small, flat, translucent navy plate parked in a corner, never over the middle of the sky
while you fly.

**Scene:** someone on a laptop or phone in a spare ten minutes, often in a dim room, eyes on
the middle of the screen where the dogfight is. That decides a dark interface over a
bright, saturated world, and short labels that can be read in a glance from the corner of
the eye.

**World:** the flight line. The things this audience knows by heart are the stencilled
markings on aircraft, the rows of kill marks painted under a canopy, squadron boards,
pilots' kneeboards and cockpit displays. The kill-mark row carries the mechanism best:
you shoot planes down and your plane grows, so the interface counts kills the way a ground
crew would, in stencilled silhouettes.

**Atoms**
- Colour posture: *committed*. The sea (from the original fragment's world) covers most of
  every screen; panels are the original's own help-line navy (`#0b1a33`); the one accent is
  the jet's own signal orange (`#f0580e`), used only for the primary action and for "you"
  in lists.
- Faces: **Big Shoulders Stencil** for the wordmark, tier names and the big moments (it is
  literally stencil paint); **B612** and **B612 Mono** for everything else. B612 was drawn
  by Airbus for cockpit displays, for legibility at a glance under stress, which is exactly
  the HUD's job. Buttons use B612 bold, because the stencil cut breaks letters like L apart.
- Radius 3px (the original's own), flat panels with a 1px hairline, one two-layer shadow
  only on the floating sheets. Text over the world gets a 1px dark drop, as the original's
  help line did.
- Motion: 220ms ease-out entrances on sheets and toasts, hard pixels in the world. Nothing
  in the interface loops.

**Signature:** a shot-down plane comes apart slice by slice. The sprite stack that builds
the jet is pulled apart, each slice tumbling and spreading as it falls through its own
fireball, leaving salvage behind. Your kill marks fill in on the kneeboard as it happens.

**Mirror test:** a neighbouring ".io shooter" lands on neon-on-black with a sans display
face and glowing edges. This one keeps the bright daylight sea and puts the interface in
stencil and cockpit type instead. Changed from the first idea: the leaderboard was going to
be a chalk "squadron board", dropped because chalk texture fights the pixel art.
