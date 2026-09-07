/**
 * lib/flag-similarity.mjs
 * ------------------------
 * Gemeinsame Pixel-Analyse der Flaggen (app/flags/*.png):
 * Flaggen-Profile und paarweise Distanz.
 * Wird von assign_difficulty.mjs und generate_choices.mjs genutzt.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FLAGS_DIR = path.join(ROOT, 'app', 'flags');

// Ab dieser Distanz (mittlere RGB-Differenz, 0..1) gilt eine Flagge
// als "sehr ähnlich" zu einer anderen.
export const SIMILARITY_THRESHOLD = 0.13;

// Obergrenze für "knapp ähnliche" Paare (Review-Kandidaten).
export const REVIEW_THRESHOLD = 0.16;

/**
 * Profil-Merkmale: mittlere RGB-Farbe pro Spalte (200 Punkte) und pro
 * Zeile (140 Punkte), jeweils relativ zur Bildgröße abgetastet.
 * Erfasst horizontale UND vertikale Streifenstruktur exakt.
 */
export function flagProfiles(png) {
  const { width: W, height: H, data } = png;
  const colProf = [];
  const rowProf = [];
  for (let k = 0; k < 200; k++) {
    const x = Math.min(W - 1, Math.round((k * W) / 200));
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
    }
    colProf.push(sr / H / 255, sg / H / 255, sb / H / 255);
  }
  for (let k = 0; k < 140; k++) {
    const y = Math.min(H - 1, Math.round((k * H) / 140));
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
    }
    rowProf.push(sr / W / 255, sg / W / 255, sb / W / 255);
  }
  return { colProf, rowProf };
}

/** Flache RGB-Triple-Folge umkehren (Reihenfolge, nicht Kanäle!). */
export function reverseTriples(f) {
  const out = new Array(f.length);
  for (let i = 0; i < f.length; i += 3) {
    out[f.length - 3 - i] = f[i];
    out[f.length - 2 - i] = f[i + 1];
    out[f.length - 1 - i] = f[i + 2];
  }
  return out;
}

/**
 * Distanz zweier Flaggen-Profile (0..1). Varianten:
 *  none = direkt | v = vertikal gespiegelt | h = horizontal gespiegelt
 */
export function pairDist(fa, fb, flip) {
  const colsB = flip === 'h' ? reverseTriples(fb.colProf) : fb.colProf;
  const rowsB = flip === 'v' ? reverseTriples(fb.rowProf) : fb.rowProf;
  let s = 0;
  let n = 0;
  for (let i = 0; i < fa.colProf.length; i++) {
    const d = fa.colProf[i] - colsB[i];
    s += d * d;
    n++;
  }
  for (let i = 0; i < fa.rowProf.length; i++) {
    const d = fa.rowProf[i] - rowsB[i];
    s += d * d;
    n++;
  }
  return Math.sqrt(s / n);
}

/** Lädt die Flaggen-PNGs zu Nummern und berechnet ihre Profile. */
export async function loadFlagImages(numbers) {
  const profiles = new Map();
  for (const num of numbers) {
    const file = path.join(FLAGS_DIR, `${String(num).padStart(3, '0')}.png`);
    const buf = await readFile(file);
    const png = PNG.sync.read(buf);
    profiles.set(num, flagProfiles(png));
  }
  return profiles;
}

/**
 * Alle Paar-Distanzen (Minimum über Spiegelungen) als Liste
 * [{ a, b, d }], aufsteigend sortiert.
 */
export function allPairDistances(numbers, profiles) {
  const pairs = [];
  for (let i = 0; i < numbers.length; i++) {
    for (let j = i + 1; j < numbers.length; j++) {
      const a = numbers[i];
      const b = numbers[j];
      const fa = profiles.get(a);
      const fb = profiles.get(b);
      const d = Math.min(pairDist(fa, fb, 'none'), pairDist(fa, fb, 'v'), pairDist(fa, fb, 'h'));
      pairs.push({ a, b, d });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  return pairs;
}
