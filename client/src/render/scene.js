// Sprite-stack arena renderer: a small software renderer, adapted from the Forge "fighter"
// fragment (pixel-art fighter jet built by sprite stacking, over stacked islands).
//
// Everything is drawn into one low-resolution pixel buffer, the way the technique works:
//   · each jet is a stack of horizontal slices drawn 1 px apart, turned to any angle
//   · the islands and the clouds are stacks too (a height per ground pixel)
// The buffer is then shown scaled up with hard pixels.
//
// The original had overhead, chase and cockpit cameras flying one jet. The arena keeps the
// overhead view only (north up, so aiming with a pointer is predictable) and draws many jets,
// each with its own paint and size, plus tracers, salvage, explosions and wrecks that come
// apart slice by slice.

import {
  JET_W, JET_L, JET_H, JET_PALETTE, decodeJet,
  JET_PIVOT_K, JET_PIVOT_Y, JET_ENGINE_A, JET_ENGINE_Y, JET_ENGINE_R, JET_NOZZLE_K,
  JET_WINGTIP_A, JET_WINGTIP_K, JET_WINGTIP_Y,
} from './jet-model.js'

export const WORLD_PARAMS = {
  clouds: 0.45,
  land: 0.33,
  seed: 7,
  afterburner: 1,
  flameStyle: 'realistic',
  trails: true,
  shadow: true,
  bodyColor: '#545969',
  canopyColor: '#1e8ca0',
}

// ───────────────────────────────────────────────────────────── constants
const N = 2048 // world size (wraps); must match WORLD in shared/game.ts
const NM = N - 1
const NSHIFT = 11

const NC = 1024 // cloud map size (wraps)
const NCM = NC - 1
const NCSHIFT = 10
const CK = 8 // cloud stack height
const CLOUD_ALT = 40
const ZTOP = CLOUD_ALT + CK

const PIV_K = JET_PIVOT_K
const PIV_Y = JET_PIVOT_Y
const ENGINE_A = JET_ENGINE_A
const ENGINE_Y = JET_ENGINE_Y
const ENGINE_R = JET_ENGINE_R
const NOZZLE_K = JET_NOZZLE_K
const WINGTIP_A = JET_WINGTIP_A
const WINGTIP_K = JET_WINGTIP_K
const WINGTIP_Y = JET_WINGTIP_Y

const TRAIL_N = 120
const SMOKE_N = 480
const SMOKE_F = 10 // x, y, z, born, size, push x, push y, strength, life, heat
const SHADOW_MAX = 8
const FLAME_MAX = 48 // smooth flames: two a jet
const FLAME_F = 16
const FLAME_GROW = 1.3
const WRECK_TIME = 1.7 // seconds a wreck takes to come apart and fall away
const SPAWN_TIME = 0.9 // the stack-up when a jet appears

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

// ───────────────────────────────────────────────────────────── helpers
function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}
const pack = (r, g, b) => ((255 << 24) | (clamp255(b) << 16) | (clamp255(g) << 8) | clamp255(r)) >>> 0
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
const wrapD = (d) => d - N * Math.round(d / N)

function mulberry32(seed) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hash8(o) {
  let h = Math.imul(o ^ (o >>> 13), 0x5bd1e995)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  return (h >>> 24) & 255
}

export function parseColor(str, fallback) {
  if (!str) return fallback
  let s = String(str).trim()
  if (s[0] === '#') {
    s = s.slice(1)
    if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('')
    const n = parseInt(s.slice(0, 6), 16)
    if (!isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return fallback
}

// tileable value noise, one octave added into `field`
function addOctave(field, n, cell, amp, rnd) {
  const P = n / cell
  const lat = new Float32Array(P * P)
  for (let i = 0; i < lat.length; i++) lat[i] = rnd()
  const x0 = new Int32Array(n)
  const x1 = new Int32Array(n)
  const tx = new Float32Array(n)
  for (let x = 0; x < n; x++) {
    const g = x / cell
    const i = Math.floor(g)
    const f = g - i
    x0[x] = i % P
    x1[x] = (i + 1) % P
    tx[x] = f * f * (3 - 2 * f)
  }
  for (let y = 0; y < n; y++) {
    const ra = x0[y] * P
    const rb = x1[y] * P
    const ty = tx[y]
    const row = y * n
    for (let x = 0; x < n; x++) {
      const a0 = lat[ra + x0[x]]
      const b0 = lat[rb + x0[x]]
      const va = a0 + (lat[ra + x1[x]] - a0) * tx[x]
      const vb = b0 + (lat[rb + x1[x]] - b0) * tx[x]
      field[row + x] += amp * (va + (vb - va) * ty)
    }
  }
}
function normalise(field) {
  let mn = Infinity
  let mx = -Infinity
  for (let i = 0; i < field.length; i++) {
    const v = field[i]
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const k = 1 / (mx - mn || 1)
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - mn) * k
}

// ───────────────────────────────────────────────────────────── materials
// index: 0 deep · 1 mid · 2 shallow · 3 surf · 4 sand · 5 sand speck · 6 grass · 7 grass dark · 8 grass light
//        9 tree top · 10 tree · 11 tree edge · 12 rock · 13 rock dark · 14 rock light · 15 snow · 16 snow shade
const MAT_TOP = [
  [36, 104, 180], [44, 124, 198], [66, 160, 216], [104, 204, 214],
  [238, 220, 164], [222, 200, 140],
  [96, 178, 52], [70, 148, 44], [134, 206, 76],
  [70, 158, 64], [42, 122, 54], [28, 92, 46],
  [146, 140, 134], [118, 112, 110], [178, 172, 162],
  [246, 250, 255], [214, 226, 244],
]
const MAT_SIDE = [
  [36, 104, 180], [44, 124, 198], [66, 160, 216], [104, 204, 214],
  [204, 180, 122], [204, 180, 122],
  [56, 120, 44], [50, 108, 42], [60, 128, 46],
  [24, 78, 42], [22, 72, 40], [20, 64, 38],
  [96, 90, 92], [86, 82, 86], [104, 98, 98],
  [186, 202, 228], [176, 192, 220],
]
const NMAT = MAT_TOP.length

/**
 * @param {Partial<typeof WORLD_PARAMS>} initial
 */
export function createScene(initial = {}) {
  const p = { ...WORLD_PARAMS, ...initial }

  // ── the jet's slices as lists of voxels
  const slices = decodeJet()
  const sliceA = []
  const sliceB = []
  const sliceC = []
  const shadowMask = new Uint8Array(JET_W * JET_L)
  let firstSlice = JET_H
  for (let y = 0; y < JET_H; y++) {
    const s = slices[y]
    let n = 0
    for (let o = 0; o < s.length; o++) if (s[o]) n++
    const a = new Float32Array(n)
    const b = new Float32Array(n)
    const c = new Uint8Array(n)
    let j = 0
    for (let k = 0; k < JET_L; k++) {
      for (let i = 0; i < JET_W; i++) {
        const v = s[k * JET_W + i]
        if (!v) continue
        a[j] = i - (JET_W - 1) / 2
        b[j] = PIV_K - k
        c[j] = v
        j++
        shadowMask[k * JET_W + i] = 1
      }
    }
    if (n && y < firstSlice) firstSlice = y
    sliceA.push(a)
    sliceB.push(b)
    sliceC.push(c)
  }

  // ── palettes: one set for the world, one per paint job
  const topLit = new Uint32Array(NMAT)
  const topShade = new Uint32Array(NMAT)
  const sideLit = new Uint32Array(NMAT)
  const sideShade = new Uint32Array(NMAT)
  const cloudTop = new Uint32Array(CK)
  const cloudSide = new Uint32Array(CK)
  const flamePal = new Uint32Array(6)
  const trailPal = new Uint32Array(3)
  const outlineCol = pack(13, 15, 26)
  const sunX = 0.5
  const sunY = 0.32
  const sparkA = pack(120, 190, 236)
  const sparkB = pack(236, 250, 255)
  const foamCol = pack(240, 252, 255)
  const cloudUnder = pack(138, 160, 200)
  for (let m = 0; m < NMAT; m++) {
    const t = MAT_TOP[m]
    const s = MAT_SIDE[m]
    topLit[m] = pack(t[0], t[1], t[2])
    sideLit[m] = pack(s[0], s[1], s[2])
    topShade[m] = pack(t[0] * 0.62, t[1] * 0.67, t[2] * 0.8)
    sideShade[m] = pack(s[0] * 0.62, s[1] * 0.67, s[2] * 0.8)
  }
  for (let k = 0; k < CK; k++) {
    const f = k / (CK - 1)
    const ft = Math.min(1, k / 2)
    cloudTop[k] = pack(218 + 37 * ft, 230 + 25 * ft, 247 + 8 * ft)
    cloudSide[k] = pack(158 + 44 * f, 182 + 36 * f, 222 + 18 * f)
  }
  const flames = [[255, 252, 224], [255, 224, 120], [255, 164, 44], [246, 96, 20], [176, 48, 26], [96, 34, 40]]
  for (let i = 0; i < 6; i++) flamePal[i] = pack(flames[i][0], flames[i][1], flames[i][2])
  trailPal[0] = pack(255, 255, 255)
  trailPal[1] = pack(214, 232, 250)
  trailPal[2] = pack(170, 204, 240)
  const tracerHead = pack(255, 252, 214)
  const tracerMid = pack(255, 214, 96)
  const tracerTail = pack(250, 140, 40)
  const salvageA = pack(255, 214, 92)
  const salvageB = pack(196, 140, 40)
  const salvageHi = pack(255, 250, 220)

  const paints = new Map()
  /** the jet palette for one accent colour: [base, lit, dim] */
  function paintFor(accent) {
    let got = paints.get(accent)
    if (got) return got
    const pal = new Uint32Array(96)
    const palLit = new Uint32Array(96)
    const palDim = new Uint32Array(96)
    const keys = {
      0: { key: 4, col: parseColor(p.bodyColor, [84, 89, 105]), def: [84, 89, 105] },
      1: { key: 3, col: parseColor(accent, [240, 88, 14]), def: [240, 88, 14] },
      2: { key: 3, col: parseColor(p.canopyColor, [30, 140, 160]), def: [30, 140, 160] },
    }
    const keyLum = {}
    for (const row of JET_PALETTE) {
      const fam = row[4]
      if (fam < 3 && ((row[0] - 1) & 15) === keys[fam].key) keyLum[fam] = lum([row[1], row[2], row[3]])
    }
    for (const row of JET_PALETTE) {
      const idx = row[0]
      const fam = row[4]
      let c = [row[1], row[2], row[3]]
      if (fam < 3) {
        const k = keys[fam]
        const same = k.col[0] === k.def[0] && k.col[1] === k.def[1] && k.col[2] === k.def[2]
        if (!same) {
          const l = lum(c)
          const kl = keyLum[fam] || 100
          if (l <= kl) {
            const f = l / kl
            c = [k.col[0] * f, k.col[1] * f, k.col[2] * f]
          } else {
            const f = (l - kl) / (255 - kl)
            c = [k.col[0] + (255 - k.col[0]) * f, k.col[1] + (255 - k.col[1]) * f, k.col[2] + (255 - k.col[2]) * f]
          }
        }
      }
      pal[idx] = pack(c[0], c[1], c[2])
    }
    for (const row of JET_PALETTE) {
      const idx = row[0]
      const fam = row[4]
      palLit[idx] = fam < 3 && pal[idx + 1] ? pal[idx + 1] : pal[idx]
      palDim[idx] = fam < 3 && ((idx - 1) & 15) > 0 ? pal[idx - 1] : pal[idx]
    }
    const c = parseColor(accent, [240, 88, 14])
    got = { pal, palLit, palDim, chip: pack(c[0], c[1], c[2]), chipDark: pack(c[0] * 0.55, c[1] * 0.55, c[2] * 0.6) }
    paints.set(accent, got)
    return got
  }

  // ── the world: a height and a material per ground pixel
  const heightMap = new Uint8Array(N * N)
  const matMap = new Uint8Array(N * N)
  const cloudN = new Uint8Array(NC * NC)
  const nz = new Uint8Array(256 * 256)

  function buildWorld() {
    const rnd = mulberry32((p.seed | 0) * 7919 + 13)
    for (let i = 0; i < nz.length; i++) nz[i] = (rnd() * 256) | 0

    const E = new Float32Array(N * N)
    addOctave(E, N, 512, 0.55, rnd)
    addOctave(E, N, 256, 1, rnd)
    addOctave(E, N, 128, 0.5, rnd)
    addOctave(E, N, 64, 0.25, rnd)
    addOctave(E, N, 32, 0.11, rnd)
    addOctave(E, N, 16, 0.05, rnd)
    normalise(E)

    const bins = new Uint32Array(1024)
    for (let o = 0; o < E.length; o++) bins[(E[o] * 1023) | 0]++
    const land = clamp(p.land, 0.02, 0.9)
    let acc = 0
    let sea = 1
    const target = (1 - land) * E.length
    for (let b = 0; b < 1024; b++) {
      acc += bins[b]
      if (acc >= target) { sea = (b + 1) / 1023; break }
    }
    const SAND = 0.012
    const span = Math.max(0.05, 1 - sea - SAND)

    for (let y = 0; y < N; y++) {
      const row = y << NSHIFT
      const rowNW = ((y - 2) & NM) << NSHIFT
      const rowSE = ((y + 2) & NM) << NSHIFT
      for (let x = 0; x < N; x++) {
        const o = row | x
        const e = E[o]
        const hs = hash8(o)
        const d = e - sea
        if (d < 0) {
          const dd = -d + (hs - 128) * 0.00004
          matMap[o] = dd > 0.07 ? 0 : dd > 0.03 ? 1 : dd > 0.008 ? 2 : 3
          heightMap[o] = 0
          continue
        }
        if (d < SAND) {
          matMap[o] = hs < 34 ? 5 : 4
          heightMap[o] = 0
          continue
        }
        const hr = (d - SAND) / span
        let lv = hr < 0.5 ? 1 + ((hr * 16) | 0) : hr < 0.78 ? 9 + (((hr - 0.5) / 0.07) | 0) : 13 + (((hr - 0.78) / 0.09) | 0)
        if (lv > 15) lv = 15
        heightMap[o] = lv <= 8 ? lv * 2 : 16 + (lv - 8) * 3
        const g = E[rowNW | ((x - 2) & NM)] - E[rowSE | ((x + 2) & NM)]
        const lit = g < -0.007
        const shaded = g > 0.007
        if (lv >= 13) matMap[o] = shaded ? 16 : 15
        else if (lv >= 9) matMap[o] = lit ? 14 : shaded ? 13 : hs < 26 ? 13 : 12
        else matMap[o] = lit ? 8 : shaded ? 7 : hs < 22 ? 7 : hs > 240 ? 8 : 6
      }
    }

    // forests: little cones of leaves
    const STEP = 5
    for (let gy = 0; gy < N; gy += STEP) {
      for (let gx = 0; gx < N; gx += STEP) {
        const hs = hash8(gy * 977 + gx * 131 + 7)
        const cx = (gx + (hs & 3)) & NM
        const cy = (gy + ((hs >> 2) & 3)) & NM
        const o = (cy << NSHIFT) | cx
        const m = matMap[o]
        if (m < 6 || m > 8) continue
        const h0 = heightMap[o]
        if (h0 > 14) continue
        const f = E[(((cy + 613) & NM) << NSHIFT) | ((N - 1 - cx + 911) & NM)]
        const pr = (f - sea) * 30
        if (pr <= 0 || pr * 255 < hash8(o + 99)) continue
        const r = 2 + ((hs >> 4) & 1)
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist > r + 0.3) continue
            const oo = (((cy + dy) & NM) << NSHIFT) | ((cx + dx) & NM)
            if (matMap[oo] < 4) continue
            const nh = h0 + 1 + Math.round((1 - dist / (r + 0.5)) * (r + 1))
            if (nh > heightMap[oo]) {
              heightMap[oo] = nh
              matMap[oo] = dist < 1.1 ? 9 : dist < r - 0.5 ? 10 : 11
            }
          }
        }
      }
    }

    // clouds: clusters of round puffs
    cloudN.fill(0)
    for (let i = 0; i < 200; i++) {
      const rank = i & 15
      const cx = rnd() * NC
      const cy = rnd() * NC
      const sc = 0.6 + rnd() * rnd() * 1.25
      const ang = 0.35 + (rnd() - 0.5) * 1.3
      const len = (12 + rnd() * 24) * sc
      const puffs = 4 + ((rnd() * 7) | 0)
      for (let q = 0; q < puffs; q++) {
        const t = (q / (puffs - 1)) * 2 - 1
        const pxc = cx + Math.cos(ang) * t * len + (rnd() - 0.5) * 9 * sc
        const pyc = cy + Math.sin(ang) * t * len + (rnd() - 0.5) * 9 * sc
        const r = (6 + rnd() * 8) * sc * (1 - 0.45 * Math.abs(t))
        const maxT = clamp(Math.round(r * 0.6), 2, CK)
        const ri = Math.ceil(r)
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            const d2 = (dx * dx + dy * dy) / (r * r)
            if (d2 > 1) continue
            const tk = Math.max(1, Math.round(Math.sqrt(1 - d2) * maxT))
            const xx = (Math.round(pxc) + dx) & NCM
            const yy = (Math.round(pyc) + dy) & NCM
            const oo = (yy << NCSHIFT) | xx
            if (tk > (cloudN[oo] & 15)) cloudN[oo] = (rank << 4) | tk
          }
        }
      }
    }
  }
  buildWorld()

  // ── state
  let W = 0
  let H = 0
  let fb = new Uint32Array(0)
  let bytes = new Uint8ClampedArray(0)
  let jetMask = new Uint8Array(0)
  let zbuf = new Float32Array(0)
  let colY = new Int32Array(0)
  let time = 0
  const cam = { x: N / 2, y: N / 2, alt: 82 }
  let Cx = 0
  let Cy = 0
  const smoke = new Float32Array(SMOKE_N * SMOKE_F)
  let smokeHead = 0
  const flameData = new Float32Array(FLAME_MAX * FLAME_F)
  const flameOut = { count: 0, data: flameData }

  /** @type {Map<number, any>} jets by id, kept between frames for their trails and smoothing */
  const jets = new Map()
  /** wrecks: jets that were shot down, coming apart */
  let wrecks = []
  let blasts = [] // fireballs: x, y, z, born, size
  let sparks = [] // bright chips: x, y, z, vx, vy, vz, born, life, colour
  let bullets = []
  let salvage = []

  function makeJet(id) {
    return {
      id, x: 0, y: 0, z: 82, yaw: 0, yawRate: 0, bank: 0, roll: -1, rollDir: 1, scale: 0.6, turn: 2,
      boost: 0, burn: 0, g: 0, paint: paintFor('#f0580e'), accent: '#f0580e', blink: false, born: time,
      trail: [new Float32Array(TRAIL_N * 4), new Float32Array(TRAIL_N * 4)], trailHead: 0, trailLen: 0,
      lastTrailX: 0, lastTrailY: 0, smokeClock: 0, seen: 0, firing: false,
    }
  }

  function resize(w, h) {
    W = Math.max(8, w | 0)
    H = Math.max(8, h | 0)
    const buf = new ArrayBuffer(W * H * 4)
    fb = new Uint32Array(buf)
    bytes = new Uint8ClampedArray(buf)
    jetMask = new Uint8Array(W * H)
    colY = new Int32Array(W)
    zbuf = new Float32Array(W * H)
    Cx = W >> 1
    Cy = H >> 1
  }

  /** world point → screen; the camera looks straight down, north up */
  const sx = (x) => Cx + wrapD(x - cam.x)
  const sy = (y, z) => Cy + wrapD(y - cam.y) - (z - cam.alt)

  /** the jet's own axes in the world (x right, y down the map, z up) */
  function axes(yaw, roll, pitch = 0) {
    const cs = Math.cos(yaw)
    const sn = Math.sin(yaw)
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    const rx = cs * cr
    const ry = sn * cr
    const rz = -sr
    const u2x = cs * sr
    const u2y = sn * sr
    const u2z = cr
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    return {
      rx, ry, rz,
      fx: sn * cp + u2x * sp, fy: -cs * cp + u2y * sp, fz: u2z * sp,
      ux: u2x * cp - sn * sp, uy: u2y * cp + cs * sp, uz: u2z * cp,
      cr,
    }
  }
  const spinOf = (j) => {
    if (j.roll < 0) return 0
    const t = j.roll
    return j.rollDir * Math.PI * 2 * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  }
  const flameLength = (j) => (0.07 + 0.17 * p.afterburner) * JET_L * j.burn * (1 + 1.6 * j.boost)
  const flameBend = (j) => clamp(j.yawRate / Math.max(0.1, j.turn), -1, 1) * 0.36

  // ── the frame's contents, from the game layer
  /**
   * @param {{x:number,y:number}} camera
   * @param {any[]} list planes: id x y yaw yawRate roll rollDir boost scale turn accent blink firing
   */
  function setJets(list) {
    const seen = time
    for (const s of list) {
      let j = jets.get(s.id)
      if (!j) {
        j = makeJet(s.id)
        jets.set(s.id, j)
        j.x = s.x
        j.y = s.y
        j.lastTrailX = s.x
        j.lastTrailY = s.y
        j.born = s.fresh ? time : time - 9
      }
      j.x = s.x
      j.y = s.y
      j.yaw = s.yaw
      j.yawRate = s.yawRate
      j.roll = s.roll
      j.rollDir = s.rollDir || 1
      j.boost = s.boost
      j.scale = s.scale
      j.turn = s.turn
      j.blink = !!s.blink
      j.firing = !!s.firing
      if (j.accent !== s.accent) {
        j.accent = s.accent
        j.paint = paintFor(s.accent)
      }
      j.seen = seen
    }
    for (const [id, j] of jets) if (j.seen !== seen) jets.delete(id)
  }

  /** a jet is shot down: it becomes a wreck that comes apart, with a fireball */
  function explode(id, x, y, accent, scale, yaw = 0) {
    const j = jets.get(id)
    const rnd = mulberry32(id * 7919 + ((time * 1000) | 0))
    const pieces = []
    for (let s = 0; s < JET_H; s++) {
      const a = rnd() * Math.PI * 2
      const sp = 10 + rnd() * 38
      pieces.push({ vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp, vz: -4 - rnd() * 16, spin: (rnd() - 0.5) * 9 })
    }
    const vx = j ? Math.sin(j.yaw) * 60 : 0
    const vy = j ? -Math.cos(j.yaw) * 60 : 0
    wrecks.push({
      x: j ? j.x : x, y: j ? j.y : y, z: j ? j.z : cam.alt, yaw: j ? j.yaw : yaw, bank: j ? j.bank : 0,
      scale: j ? j.scale : scale, paint: paintFor(accent), born: time, vx, vy, pieces,
    })
    if (j) jets.delete(id)
    blast(x, y, cam.alt, scale)
    const paint = paintFor(accent)
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2
      const sp = 30 + rnd() * 110
      sparks.push({
        x, y, z: cam.alt, vx: Math.sin(a) * sp + vx * 0.5, vy: -Math.cos(a) * sp + vy * 0.5, vz: 10 + rnd() * 40,
        born: time, life: 0.5 + rnd() * 0.7, col: i % 3 === 0 ? paint.chip : i % 3 === 1 ? paint.chipDark : flamePal[2 + (i & 1)],
        size: rnd() < 0.3 ? 2 : 1,
      })
    }
  }

  function blast(x, y, z, scale) {
    blasts.push({ x, y, z, born: time, size: 10 + 12 * scale })
    // a column of dark smoke left hanging where it happened
    for (let i = 0; i < 12; i++) {
      const o = smokeHead * SMOKE_F
      const a = i * 2.39
      smoke[o] = x + Math.sin(a) * 4
      smoke[o + 1] = y - Math.cos(a) * 4
      smoke[o + 2] = z - i * 1.5
      smoke[o + 3] = time + i * 0.04
      smoke[o + 4] = 2.4 + (i % 3)
      smoke[o + 5] = Math.sin(a) * 16
      smoke[o + 6] = -Math.cos(a) * 16
      smoke[o + 7] = 0.85
      smoke[o + 8] = 2.2 + (i % 4) * 0.3
      smoke[o + 9] = i < 5 ? 1 : 0
      smokeHead = (smokeHead + 1) % SMOKE_N
    }
  }

  /** a bullet found its mark */
  function hit(x, y) {
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 40 + Math.random() * 70
      sparks.push({
        x, y, z: cam.alt + 2, vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp, vz: 20,
        born: time, life: 0.18 + Math.random() * 0.14, col: i & 1 ? tracerHead : tracerMid, size: 1,
      })
    }
  }

  /** @param {{x:number,y:number,vx:number,vy:number}[]} list */
  function setBullets(list) {
    bullets = list
  }
  /** @param {{x:number,y:number,v:number,ox:number,oy:number,age:number}[]} list */
  function setSalvage(list) {
    salvage = list
  }
  function setCamera(x, y) {
    cam.x = x
    cam.y = y
  }

  // ── simulation of the purely visual parts
  function step(dt) {
    time += dt
    for (const j of jets.values()) {
      // bank into turns, smoothly
      const target = clamp(j.yawRate / Math.max(0.1, j.turn), -1, 1) * 0.9
      j.bank += (target - j.bank) * (1 - Math.exp(-dt * 5))
      j.burn += (1 - j.burn) * (1 - Math.exp(-dt * 5))
      j.z = cam.alt + Math.sin(time * 0.9 + j.id) * 1.5
      const gNow = clamp(Math.abs(j.yawRate) / j.turn + (j.roll >= 0 ? 0.7 : 0) + j.boost * 0.9, 0, 1)
      j.g += (gNow - j.g) * (1 - Math.exp(-dt * 2.5))
      // wingtip trails (a big jump means it wrapped or was corrected: start a new trail)
      const ddx = wrapD(j.x - j.lastTrailX)
      const ddy = wrapD(j.y - j.lastTrailY)
      const d2 = ddx * ddx + ddy * ddy
      if (d2 > 400) {
        j.trailLen = 0
        j.lastTrailX = j.x
        j.lastTrailY = j.y
      } else if (d2 > 6.25) {
        j.lastTrailX = j.x
        j.lastTrailY = j.y
        const ax = axes(j.yaw, j.bank + spinOf(j))
        for (let w = 0; w < 2; w++) {
          const sc = j.scale
          const a = (w === 0 ? -WINGTIP_A : WINGTIP_A) * sc
          const b = (PIV_K - WINGTIP_K) * sc
          const hy = (WINGTIP_Y - PIV_Y) * sc
          const o = j.trailHead * 4
          j.trail[w][o] = j.x + a * ax.rx + b * ax.fx + hy * ax.ux
          j.trail[w][o + 1] = j.y + a * ax.ry + b * ax.fy + hy * ax.uy
          j.trail[w][o + 2] = j.z + a * ax.rz + b * ax.fz + hy * ax.uz
          j.trail[w][o + 3] = time
        }
        j.trailHead = (j.trailHead + 1) % TRAIL_N
        if (j.trailLen < TRAIL_N) j.trailLen++
      }
      // a little dark smoke off the end of each flame
      j.smokeClock += dt
      const every = 0.05 - 0.02 * j.boost
      if (j.smokeClock >= every && j.burn > 0.6 && wrapNear(j.x, j.y, 0.8)) {
        j.smokeClock = 0
        const len = flameLength(j)
        const sc = j.scale
        const ax = axes(j.yaw, j.bank + spinOf(j))
        const side = smokeHead & 1 ? 1 : -1
        const t = len * 0.78
        const a = (side * ENGINE_A + flameBend(j) * ((t * t) / Math.max(1, len))) * sc
        const b = (PIV_K - NOZZLE_K - t) * sc
        const hy = (ENGINE_Y - PIV_Y) * sc
        const o = smokeHead * SMOKE_F
        smoke[o] = j.x + a * ax.rx + b * ax.fx + hy * ax.ux
        smoke[o + 1] = j.y + a * ax.ry + b * ax.fy + hy * ax.uy
        smoke[o + 2] = j.z + a * ax.rz + b * ax.fz + hy * ax.uz
        smoke[o + 3] = time
        smoke[o + 4] = (1.3 + (hash8(smokeHead * 31 + 7) / 255) * 1.2) * sc
        smoke[o + 5] = -Math.sin(j.yaw) * 30 + (hash8(smokeHead * 17 + 3) - 128) * 0.05
        smoke[o + 6] = Math.cos(j.yaw) * 30 + (hash8(smokeHead * 13 + 5) - 128) * 0.05
        smoke[o + 7] = 0.4 + 0.36 * j.boost
        smoke[o + 8] = 0.7 + 0.5 * j.boost + (hash8(smokeHead * 5) / 255) * 0.3
        smoke[o + 9] = 0
        smokeHead = (smokeHead + 1) % SMOKE_N
      }
    }
    for (const w of wrecks) {
      w.x += w.vx * dt
      w.y += w.vy * dt
      w.vx *= Math.exp(-dt * 1.2)
      w.vy *= Math.exp(-dt * 1.2)
    }
    wrecks = wrecks.filter((w) => time - w.born < WRECK_TIME)
    blasts = blasts.filter((b) => time - b.born < 0.6)
    for (const s of sparks) {
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.z += s.vz * dt
      s.vz -= 120 * dt
      s.vx *= Math.exp(-dt * 2)
      s.vy *= Math.exp(-dt * 2)
    }
    sparks = sparks.filter((s) => time - s.born < s.life)
  }

  /** is a world point within `margin` screens of the view? */
  function wrapNear(x, y, margin) {
    return Math.abs(wrapD(x - cam.x)) < W * (0.5 + margin) && Math.abs(wrapD(y - cam.y)) < H * (0.5 + margin)
  }

  // ── drawing

  // The islands and clouds, drawn from the nearest ground to the farthest (the original's
  // general renderer, run here with the camera looking straight down).
  const rowNow = new Int32Array(64)
  const rowPrev = new Int32Array(64)
  const sjx = new Float64Array(SHADOW_MAX)
  const sjy = new Float64Array(SHADOW_MAX)
  const srx = new Float64Array(SHADOW_MAX)
  const sry = new Float64Array(SHADOW_MAX)
  const sfx = new Float64Array(SHADOW_MAX)
  const sfy = new Float64Array(SHADOW_MAX)
  const sic = new Float64Array(SHADOW_MAX)
  const sisc = new Float64Array(SHADOW_MAX)
  function drawWorld() {
    const _fb = fb
    const _zb = zbuf
    _fb.fill(0)
    _zb.fill(1e9)
    colY.fill(H)
    const A = cam.alt
    const bx = cam.x - Math.floor(cam.x / N) * N + N * 2
    const by = cam.y - Math.floor(cam.y / N) * N + N * 2
    const rankMax = Math.round(clamp(p.clouds, 0, 1) * 16)
    const cloudsOn = rankMax > 0
    const cdx = (time * 7) % NC
    const cdy = (time * 3) % NC
    const csx = sunX * CLOUD_ALT - cdx + NC
    const csy = sunY * CLOUD_ALT - cdy + NC
    const tW1 = ((time * 6) | 0) & 1023
    const tW2 = ((time * 4) | 0) & 1023
    const tF = (time * 36) | 0
    // shadows of the jets nearest the middle of the view
    let nShadow = 0
    let reach = 0
    if (p.shadow) {
      const near = [...jets.values()]
        .map((j) => ({ j, d: Math.abs(wrapD(j.x - cam.x)) + Math.abs(wrapD(j.y - cam.y)) }))
        .filter((e) => e.d < W + H)
        .sort((a, b) => a.d - b.d)
        .slice(0, SHADOW_MAX)
      for (const { j: jet } of near) {
        const ax = axes(jet.yaw, jet.bank + spinOf(jet))
        sjx[nShadow] = bx + wrapD(jet.x - cam.x) + sunX * jet.z
        sjy[nShadow] = by + wrapD(jet.y - cam.y) + sunY * jet.z
        const cs = Math.cos(jet.yaw)
        const sn = Math.sin(jet.yaw)
        srx[nShadow] = cs
        sry[nShadow] = sn
        sfx[nShadow] = sn
        sfy[nShadow] = -cs
        sic[nShadow] = 1 / (Math.max(0.3, Math.abs(ax.cr)) * jet.scale)
        sisc[nShadow] = 1 / jet.scale
        reach = Math.max(reach, JET_L * 0.75 * jet.scale + 3)
        nShadow++
      }
    }
    const _h = heightMap
    const _m = matMap
    const _cn = cloudN
    const _nz = nz
    const _cy = colY

    // overhead: each depth step is one screen row (q = 0, slope 1, scale 1)
    let v = (A - ZTOP) - (H - Cy) - 2
    for (let z = 0; z <= ZTOP; z++) rowNow[z] = Math.floor(Cy - (v - A) - z + 1e-5)
    const vEnd = A + Cy + 2
    for (let guard = 0; v < vEnd && guard < 4000; guard++) {
      v += 1
      const R = Cy - (v - A) + 1e-5
      for (let z = 0; z <= ZTOP; z++) {
        rowPrev[z] = rowNow[z]
        rowNow[z] = Math.floor(R - z)
      }
      let wx = bx - Cx
      const wy = by - v
      for (let px = 0; px < W; px++, wx++) {
        if (cloudsOn) {
          const cv = _cn[((((wy - cdy + NC) | 0) & NCM) << NCSHIFT) | (((wx - cdx + NC) | 0) & NCM)]
          if (cv !== 0 && cv >> 4 < rankMax) {
            const tk = cv & 15
            const zt = CLOUD_ALT + tk - 1
            let y0 = rowNow[zt]
            let y1 = rowPrev[zt]
            if (y0 < 0) y0 = 0
            if (y1 > H) y1 = H
            if (y0 < y1) {
              const col = cloudTop[tk - 1]
              for (let y = y0, o = y0 * W + px; y < y1; y++, o += W) {
                if (_fb[o] !== 0 || (tk === 1 && ((px + y) & 1) === 0)) continue
                _fb[o] = col
                _zb[o] = v
              }
            }
            let u0 = rowPrev[CLOUD_ALT]
            let u1 = rowNow[CLOUD_ALT]
            if (u0 < u1) {
              if (u0 < 0) u0 = 0
              if (u1 > H) u1 = H
              for (let y = u0, o = u0 * W + px; y < u1; y++, o += W) {
                if (_fb[o] !== 0 || (tk === 1 && ((px + y) & 1) === 0)) continue
                _fb[o] = cloudUnder
                _zb[o] = v
              }
            }
            for (let k = tk - 2; k >= 0; k--) {
              let ya = rowPrev[CLOUD_ALT + k + 1]
              let yb = rowPrev[CLOUD_ALT + k]
              if (ya < 0) ya = 0
              if (yb > H) yb = H
              if (ya >= yb) continue
              const col = cloudSide[k]
              for (let y = ya, o = ya * W + px; y < yb; y++, o += W) {
                if (_fb[o] === 0) { _fb[o] = col; _zb[o] = v }
              }
            }
          }
        }
        const gx = wx | 0
        const gy = wy | 0
        const idx = ((gy & NM) << NSHIFT) | (gx & NM)
        const h = _h[idx]
        let cY = _cy[px]
        const yT = rowNow[h]
        let yR = rowPrev[h]
        if (yT >= cY && yR >= cY) continue
        const mat = _m[idx]
        let shade = 0
        if (cloudsOn) {
          const sv = _cn[((((gy + csy) | 0) & NCM) << NCSHIFT) | (((gx + csx) | 0) & NCM)]
          if ((sv & 15) > 1 && sv >> 4 < rankMax) shade = 1
        }
        if (shade === 0 && nShadow > 0) {
          for (let j = 0; j < nShadow; j++) {
            const dx = gx - sjx[j] + sunX * h
            const dy = gy - sjy[j] + sunY * h
            if (dx > -reach && dx < reach && dy > -reach && dy < reach) {
              const a = (dx * srx[j] + dy * sry[j]) * sic[j]
              const b = (dx * sfx[j] + dy * sfy[j]) * sisc[j]
              const i = Math.floor(a + JET_W / 2)
              const k = Math.floor(PIV_K - b + 0.5)
              if (i >= 0 && i < JET_W && k >= 0 && k < JET_L && shadowMask[k * JET_W + i] === 1) { shade = 1; break }
            }
          }
        }
        let top
        let side
        if (mat < 4) {
          top = shade ? topShade[mat] : topLit[mat]
          if (mat === 3) {
            if (((_nz[((gy & 255) << 8) | (gx & 255)] + tF) & 255) < 120) top = shade ? topShade[2] : foamCol
          } else if (shade === 0) {
            const n1 = _nz[((gy & 255) << 8) | (((gx + tW1) >> 2) & 255)]
            if (n1 > 243) {
              const n2 = _nz[(((gy + 91) & 255) << 8) | (((gx + 1024 - tW2) >> 2) & 255)]
              if (n2 > 128) top = n1 > 252 ? sparkB : sparkA
            }
          }
          side = top
        } else {
          top = shade ? topShade[mat] : topLit[mat]
          side = shade ? sideShade[mat] : sideLit[mat]
        }
        if (yR < cY) {
          if (yR < 0) yR = 0
          for (let y = yR, o = yR * W + px; y < cY; y++, o += W) {
            if (_fb[o] === 0) { _fb[o] = side; _zb[o] = v }
          }
          cY = yR
        }
        if (yT < cY) {
          const y0 = yT < 0 ? 0 : yT
          for (let y = y0, o = y0 * W + px; y < cY; y++, o += W) {
            if (_fb[o] === 0) { _fb[o] = top; _zb[o] = v }
          }
          cY = yT
        }
        _cy[px] = cY
      }
    }
  }

  function line(x0, y0, x1, y1, col, alpha) {
    const span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    if (span > 400) return
    const steps = Math.max(1, Math.ceil(span))
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / steps)
      const y = Math.round(y0 + ((y1 - y0) * k) / steps)
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      if (alpha < 1 && alpha * 16 <= BAYER[((y & 3) << 2) | (x & 3)]) continue
      fb[y * W + x] = col
    }
  }

  function drawTrails() {
    if (!p.trails) return
    const LIFE = 2.2
    for (const j of jets.values()) {
      if (!wrapNear(j.x, j.y, 0.6)) continue
      for (let w = 0; w < 2; w++) {
        const tr = j.trail[w]
        let px0 = 0
        let py0 = 0
        let has = false
        for (let n = 0; n < j.trailLen; n++) {
          const o = ((j.trailHead - 1 - n + TRAIL_N * 2) % TRAIL_N) * 4
          const age = (time - tr[o + 3]) / (LIFE * (0.3 + 0.7 * j.g))
          if (age >= 1) break
          const x = sx(tr[o])
          const y = sy(tr[o + 1], tr[o + 2])
          if (has) {
            const alpha = age < 0.5 ? 1 : (1 - age) * 2
            const col = age < 0.25 ? trailPal[0] : age < 0.6 ? trailPal[1] : trailPal[2]
            line(px0, py0, x, y, col, alpha)
          }
          px0 = x
          py0 = y
          has = true
        }
      }
    }
  }

  // dark exhaust smoke: soft round puffs that swell, pale and thin out
  function drawSmoke() {
    const _fb = fb
    for (let i = 0; i < SMOKE_N; i++) {
      const o = i * SMOKE_F
      const life = smoke[o + 8]
      if (life <= 0) continue
      const age = time - smoke[o + 3]
      if (age < 0 || age >= life) continue
      const u = age / life
      const push = (1 - Math.exp(-age * 5)) / 5
      const X = sx(smoke[o] + smoke[o + 5] * push)
      const Y = sy(smoke[o + 1] + smoke[o + 6] * push, smoke[o + 2] + age * 2.5)
      const rad = Math.max(0.8, smoke[o + 4] * (1 + 2.4 * u))
      if (X < -rad || Y < -rad || X > W + rad || Y > H + rad) continue
      const alpha = smoke[o + 7] * (1 - u) * (1 - u) * (u < 0.08 ? u / 0.08 : 1)
      // a fireball's smoke starts out glowing
      const hot = smoke[o + 9] * Math.max(0, 1 - u * 4)
      const shade = 26 + 70 * u
      const cr = shade + hot * 200
      const cg = shade + 1 + hot * 90
      const cb = shade + 7
      const x0 = Math.max(0, Math.floor(X - rad))
      const x1 = Math.min(W - 1, Math.ceil(X + rad))
      const y0 = Math.max(0, Math.floor(Y - rad))
      const y1 = Math.min(H - 1, Math.ceil(Y + rad))
      const inv = 1 / (rad * rad)
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d2 = ((x - X) * (x - X) + (y - Y) * (y - Y)) * inv
          if (d2 > 1) continue
          const at = y * W + x
          const k = (alpha * (1 - d2 * 0.7) * 256) | 0
          const bg = _fb[at]
          const r = ((bg & 255) * (256 - k) + clamp255(cr) * k) >> 8
          const g = (((bg >> 8) & 255) * (256 - k) + clamp255(cg) * k) >> 8
          const b = (((bg >> 16) & 255) * (256 - k) + clamp255(cb) * k) >> 8
          _fb[at] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
        }
      }
    }
  }

  // salvage: little glinting pieces bobbing a few pixels under the jets
  function drawSalvage() {
    const _fb = fb
    for (const s of salvage) {
      // dropped salvage is thrown out of the wreck and settles
      const u = clamp(s.age / 0.6, 0, 1)
      const e = 1 - (1 - u) * (1 - u)
      const wx = s.ox + wrapD(s.x - s.ox) * e
      const wy = s.oy + wrapD(s.y - s.oy) * e
      const hop = Math.sin(u * Math.PI) * 10
      const z = cam.alt - 12 + Math.sin(time * 2.2 + s.id * 1.7) * 1.5 + hop
      const X = Math.round(sx(wx))
      const Y = Math.round(sy(wy, z))
      if (X < 4 || Y < 4 || X >= W - 4 || Y >= H - 4) continue
      const big = s.v >= 4
      const glint = ((time * 3 + s.id * 0.37) % 2.2) < 0.18
      const o = Y * W + X
      if (big) {
        // a small crate: 4×4 with a lit corner and a dark rim
        for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 1; dx++) _fb[o + dy * W + dx] = salvageA
        for (let k = -2; k <= 1; k++) { _fb[o + W + k] = salvageB; _fb[o + k * W + 1] = salvageB }
        _fb[o - 2 * W - 2] = glint ? salvageHi : salvageA
        for (let k = -2; k <= 1; k++) {
          _fb[o - 3 * W + k] = outlineCol
          _fb[o + 2 * W + k] = outlineCol
          _fb[o + k * W - 3] = outlineCol
          _fb[o + k * W + 2] = outlineCol
        }
      } else {
        // a diamond, 5 px across, outlined so it reads on sand and surf
        const pts = [[0, -2, 1], [-1, -1, 1], [0, -1, 2], [1, -1, 1], [-2, 0, 1], [-1, 0, 2], [0, 0, 3], [1, 0, 1], [2, 0, 4], [-1, 1, 1], [0, 1, 4], [1, 1, 4], [0, 2, 4]]
        for (const [dx, dy] of [[0, -3], [-1, -2], [1, -2], [-2, -1], [2, -1], [-3, 0], [3, 0], [-2, 1], [2, 1], [-1, 2], [1, 2], [0, 3]]) {
          if (X + dx >= 0 && X + dx < W && Y + dy >= 0 && Y + dy < H) _fb[o + dy * W + dx] = outlineCol
        }
        for (const [dx, dy, c] of pts) _fb[o + dy * W + dx] = c === 2 ? (glint ? salvageHi : salvageA) : c === 3 ? salvageHi : c === 4 ? salvageB : salvageA
      }
    }
  }

  function drawBullets() {
    for (const b of bullets) {
      const X = sx(b.x)
      const Y = sy(b.y, cam.alt)
      if (X < -40 || Y < -40 || X > W + 40 || Y > H + 40) continue
      const k = 0.034 // seconds of tracer behind the head
      const tx = X - b.vx * k
      const ty = Y - b.vy * k
      const mx = X - b.vx * k * 0.4
      const my = Y - b.vy * k * 0.4
      line(tx, ty, mx, my, tracerTail, 0.6)
      line(mx, my, X, Y, tracerMid, 1)
      const xi = Math.round(X)
      const yi = Math.round(Y)
      if (xi >= 0 && yi >= 0 && xi < W - 1 && yi < H - 1) {
        fb[yi * W + xi] = tracerHead
        fb[yi * W + xi + 1] = tracerHead
      }
    }
  }

  function drawSparks() {
    for (const s of sparks) {
      const X = Math.round(sx(s.x))
      const Y = Math.round(sy(s.y, s.z))
      for (let dy = 0; dy < s.size; dy++) {
        for (let dx = 0; dx < s.size; dx++) {
          const x = X + dx
          const y = Y + dy
          if (x < 0 || y < 0 || x >= W || y >= H) continue
          fb[y * W + x] = s.col
        }
      }
    }
  }

  function drawBlasts() {
    for (const b of blasts) {
      const u = (time - b.born) / 0.6
      const rad = b.size * (0.35 + 0.65 * Math.sqrt(u))
      const X = sx(b.x)
      const Y = sy(b.y, b.z)
      const x0 = Math.max(0, Math.floor(X - rad))
      const x1 = Math.min(W - 1, Math.ceil(X + rad))
      const y0 = Math.max(0, Math.floor(Y - rad))
      const y1 = Math.min(H - 1, Math.ceil(Y + rad))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.sqrt((x - X) * (x - X) + (y - Y) * (y - Y)) / rad
          if (d > 1) continue
          // hot in the middle and early on; it burns out from the inside
          const heat = d * 0.8 + u * 1.6 + ((BAYER[((y & 3) << 2) | (x & 3)] / 16) - 0.5) * 0.35
          if (u > 0.5 && d < (u - 0.5) * 1.6) continue
          const i = heat < 0.4 ? 0 : heat < 0.75 ? 1 : heat < 1.1 ? 2 : heat < 1.45 ? 3 : heat < 1.8 ? 4 : 5
          fb[y * W + x] = flamePal[i]
        }
      }
    }
  }

  // ── a jet, slice by slice
  const offX = new Float32Array(64)
  const offY = new Float32Array(64)
  /**
   * @param j       the jet (or a wreck)
   * @param wreck   null, or a wreck coming apart
   */
  function drawJet(j, wreck) {
    const age = wreck ? time - wreck.born : time - j.born
    const sc = j.scale
    const spin = wreck ? 0 : spinOf(j)
    const ax = axes(j.yaw, j.bank + spin)
    const cX = sx(j.x)
    const cY = sy(j.y, j.z)
    const far = JET_L * sc + 60
    if (cX < -far || cY < -far || cX > W + far || cY > H + far) return
    const pal0 = j.paint
    // light: which way each half of the jet faces the sun
    const lx = -sunX
    const ly = -sunY
    const lz = 1.1
    const ll = Math.sqrt(lx * lx + ly * ly + lz * lz)
    const lit = (side) => {
      const nx = ax.ux + side * 0.4 * ax.rx
      const ny = ax.uy + side * 0.4 * ax.ry
      const nz2 = ax.uz + side * 0.4 * ax.rz
      const b = (nx * lx + ny * ly + nz2 * lz) / (ll * Math.sqrt(nx * nx + ny * ny + nz2 * nz2))
      return b > 0.9 ? pal0.palLit : b < 0.66 ? pal0.palDim : pal0.pal
    }
    const palL = lit(-1)
    const palR = lit(1)
    // screen steps for one voxel across the wing (r), along the fuselage (f) and up (u)
    const prx = ax.rx * sc
    const pry = (ax.ry - ax.rz) * sc
    const pfx = ax.fx * sc
    const pfy = (ax.fy - ax.fz) * sc
    const pux = ax.ux * sc
    const puy = (ax.uy - ax.uz) * sc
    const ns = clamp(Math.ceil(sc * 2 - 0.24), 2, 8)
    for (let i = 0; i < ns; i++) {
      for (let k = 0; k < ns; k++) {
        const oi = (i + 0.5) / ns - 0.5
        const ok = (k + 0.5) / ns - 0.5
        offX[i * ns + k] = oi * prx + ok * pfx
        offY[i * ns + k] = oi * pry + ok * pfy
      }
    }
    const nOff = ns * ns
    const _fb = fb
    const _mk = jetMask
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    // seen from above, the stack is drawn bottom slice first (top first when it is upside down)
    const upright = ax.uz + ax.uy >= 0
    // the stack-up when a jet appears: slices fall in from the top and land on the stack
    const dropOf = (y) => {
      if (wreck || age >= SPAWN_TIME + 0.5) return 0
      const tt = (age - (y - firstSlice) * 0.045) / 0.32
      if (tt <= 0) return NaN
      return tt < 1 ? -(1 - tt * tt) * 40 : 0
    }
    // a wreck: every slice flies off on its own, tumbling, spreading and falling, and fades
    const fade = wreck ? clamp(1 - (age - WRECK_TIME * 0.45) / (WRECK_TIME * 0.55), 0, 1) : 1
    // protected jets blink
    if (!wreck && j.blink && ((time * 8) | 0) % 2 === 0) return
    for (let n = 0; n < JET_H; n++) {
      const y = upright ? n : JET_H - 1 - n
      const cnt = sliceC[y].length
      if (cnt === 0) continue
      const drop = dropOf(y)
      if (drop !== drop) continue
      let hx = cX + (y - PIV_Y) * pux
      let hy = cY + (y - PIV_Y) * puy + drop
      let srx2 = prx
      let sry2 = pry
      let sfx2 = pfx
      let sfy2 = pfy
      if (wreck) {
        const pc = wreck.pieces[y]
        const t = age
        hx += pc.vx * t
        // (the stack also comes unstacked: each slice rises away from the one below)
        hy += pc.vy * t - (pc.vz * t - 16 * t * t) - (y - PIV_Y) * sc * t * 5
        // each slice turns about its own middle
        const a = pc.spin * t
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        srx2 = prx * ca - pfx * sa
        sry2 = pry * ca - pfy * sa
        sfx2 = prx * sa + pfx * ca
        sfy2 = pry * sa + pfy * ca
      }
      const A = sliceA[y]
      const B = sliceB[y]
      const C = sliceC[y]
      for (let v = 0; v < cnt; v++) {
        const a = A[v]
        const b = B[v]
        const col = a < 0 ? palL[C[v]] : palR[C[v]]
        const px = hx + a * srx2 + b * sfx2
        const py = hy + a * sry2 + b * sfy2
        let x = 0
        let yy = 0
        for (let o = 0; o < nOff; o++) {
          x = Math.round(px + offX[o])
          yy = Math.round(py + offY[o])
          if (x < 0 || yy < 0 || x >= W || yy >= H) continue
          if (fade < 1 && fade * 16 <= BAYER[((yy & 3) << 2) | (x & 3)]) continue
          const at = yy * W + x
          _fb[at] = col
          _mk[at] = 1
        }
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (yy < y0) y0 = yy
        if (yy > y1) y1 = yy
      }
      if (!wreck && p.flameStyle !== 'realistic') pixelFlames(j, y, hx, hy, ax)
    }
    if (!wreck && p.flameStyle === 'realistic') smoothFlames(j, cX, cY, ax)
    // a dark 1 px outline around the whole stack, so it reads over any ground
    x0 = Math.max(1, x0 - 4)
    y0 = Math.max(1, y0 - 4)
    x1 = Math.min(W - 2, x1 + 4)
    y1 = Math.min(H - 2, y1 + 4)
    if (x0 > x1 || y0 > y1) return
    for (let yy = y0; yy <= y1; yy++) {
      let o = yy * W + x0
      for (let x = x0; x <= x1; x++, o++) {
        if (_mk[o] === 0 && ((_mk[o - 1] | _mk[o + 1] | _mk[o - W] | _mk[o + W]) & 1) === 1) {
          if (fade < 1 && fade * 16 <= BAYER[((yy & 3) << 2) | (x & 3)]) continue
          _fb[o] = outlineCol
        }
      }
    }
    for (let yy = y0 - 1; yy <= y1 + 1; yy++) _mk.fill(0, yy * W + x0 - 1, yy * W + x1 + 2)
  }

  // pixel afterburner, sliced the same way so it stacks with the jet (when there is no WebGL)
  function pixelFlames(j, y, hx, hy, ax) {
    const flameLen = flameLength(j) * (0.82 + 0.18 * Math.sin(time * 47 + j.id) * Math.sin(time * 31))
    const dyv = (y + 0.5 - ENGINE_Y) / (ENGINE_R * 1.25)
    if (dyv <= -1 || dyv >= 1 || flameLen <= 0.5) return
    const prof = Math.sqrt(1 - dyv * dyv)
    const sc = j.scale
    const bend = flameBend(j)
    const wide = 1.15 * (1 + 0.22 * j.boost)
    for (let e = -1; e <= 1; e += 2) {
      for (let t = 0; t < flameLen; t += 0.5) {
        const u = t / flameLen
        const rad = ENGINE_R * wide * Math.pow(1 - u, 0.75) * prof * (0.9 + 0.2 * Math.sin(t * 1.9 - time * 40 + e))
        if (rad < 0.2) continue
        const b = PIV_K - NOZZLE_K - t
        const swing = bend * ((t * t) / flameLen)
        for (let a = -rad; a <= rad; a += 0.5) {
          const aa = e * ENGINE_A + a + swing
          const heat = u * 0.9 + (Math.abs(a) / (rad + 0.01)) * 0.55 + Math.abs(dyv) * 0.3 - 0.16 * j.boost
          const col = flamePal[heat < 0.28 ? 0 : heat < 0.5 ? 1 : heat < 0.75 ? 2 : heat < 1.0 ? 3 : heat < 1.25 ? 4 : 5]
          const fx = Math.round(hx + (aa * ax.rx + b * ax.fx) * sc)
          const fy = Math.round(hy + (aa * (ax.ry - ax.rz) + b * (ax.fy - ax.fz)) * sc)
          if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue
          fb[fy * W + fx] = col
          jetMask[fy * W + fx] = 2
        }
      }
    }
  }

  // a smooth flame is only measured here; the WebGL layer over the picture draws it
  function smoothFlames(j, cX, cY, ax) {
    const flick = 0.82 + 0.18 * Math.sin(time * 47 + j.id * 2) * Math.sin(time * 31)
    const L = flameLength(j) * (0.94 + 0.3 * (flick - 0.82)) * FLAME_GROW
    const wide = ENGINE_R * (1 + 0.12 * j.boost) * 1.5
    if (L <= 0.6) return
    const sc = j.scale
    const bend = flameBend(j)
    const hgt = ENGINE_Y - 0.5 - PIV_Y
    const bx = cX + hgt * ax.ux * sc
    const by = cY + hgt * (ax.uy - ax.uz) * sc
    for (let e = -1; e <= 1; e += 2) {
      if (flameOut.count >= FLAME_MAX) return
      const o = flameOut.count * FLAME_F
      for (let n = 0; n < 3; n++) {
        const curl = n === 2 ? L : 0
        const aa = e * ENGINE_A + bend * curl
        const b = PIV_K - NOZZLE_K - n * 0.5 * L
        flameData[o + n * 2] = bx + (aa * ax.rx + b * ax.fx) * sc
        flameData[o + n * 2 + 1] = by + (aa * (ax.ry - ax.rz) + b * (ax.fy - ax.fz)) * sc
      }
      flameData[o + 6] = wide * sc
      flameData[o + 7] = 1
      flameData[o + 8] = j.boost
      flameData[o + 9] = j.blink && ((time * 8) | 0) % 2 === 0 ? 0 : 1
      flameData[o + 10] = 1
      flameData[o + 11] = 1
      flameData[o + 12] = 1
      flameData[o + 13] = (j.id * 2 + (e > 0 ? 1 : 0)) % 97
      flameData[o + 14] = clamp(p.afterburner, 0, 1)
      flameData[o + 15] = L / wide
      flameOut.count++
    }
  }

  function render() {
    if (W === 0) return bytes
    flameOut.count = 0
    drawWorld()
    drawTrails()
    drawSmoke()
    drawSalvage()
    for (const w of wrecks) drawJet(w, w)
    // jets lower on the screen are drawn last, so they overlap the ones behind them
    const order = [...jets.values()].sort((a, b) => wrapD(a.y - cam.y) - wrapD(b.y - cam.y))
    for (const j of order) drawJet(j, null)
    drawBullets()
    drawBlasts()
    drawSparks()
    return bytes
  }

  return {
    resize,
    setCamera,
    setJets,
    setBullets,
    setSalvage,
    explode,
    hit,
    step,
    render,
    paintFor,
    setFlameStyle(style) { p.flameStyle = style },
    /** world → frame pixel, for labels drawn over the picture */
    toFrame(x, y, z = cam.alt) { return [sx(x), sy(y, z)] },
    get width() { return W },
    get height() { return H },
    get flames() { return flameOut },
    get time() { return time },
  }
}
