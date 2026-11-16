// Call signs: what a pilot typed, made safe to show to everyone else.
// Only the server runs this; the client just trims as a courtesy.

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

export const NAME_MAX = 16;

let matcher: RegExpMatcher | null = null;
const getMatcher = () =>
  (matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers }));

/** a call sign for someone who typed nothing (or something we will not show) */
export function fallbackName(seed: number) {
  return `Pilot ${(1000 + (Math.abs(seed | 0) % 9000)).toString()}`;
}

export function cleanName(raw: unknown, seed: number): string {
  if (typeof raw !== "string") return fallbackName(seed);
  const s = raw
    .normalize("NFKC")
    // control characters, zero-width and bidi tricks, combining-mark stacks
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "")
    .replace(/\p{M}{2,}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...s].slice(0, NAME_MAX).join("").trim();
  if (!cut) return fallbackName(seed);
  if (getMatcher().hasMatch(cut)) return fallbackName(seed);
  return cut;
}

/** an ISO country code from Cloudflare, or "" when there is none worth showing */
export function cleanCountry(raw: unknown): string {
  const c = typeof raw === "string" ? raw.toUpperCase() : "";
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : "";
}
