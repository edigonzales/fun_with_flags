#!/usr/bin/env node
/**
 * generate_choices.mjs
 * ---------------------
 * Erzeugt app/choices.js – pro Flaggen-Nummer 5 Ländernamen, von denen
 * genau einer richtig ist. Die 4 Ablenker werden so gewählt:
 *
 *   1. Namen von Flaggen mit sehr ähnlichem Aussehen (Pixel-Analyse
 *      der app/flags/*.png, Distanz < 0.13; falls zu wenige Kandidaten,
 *      zusätzlich "Review-Paare" bis 0.16)
 *   2. Für Länder in Afrika, Südamerika und Asien: Namen der
 *      Nachbarländer (Wikidata P47)
 *   3. Rest: zufällige Länder (deterministisch, Seed = Nummer, damit
 *      wiederholte Läufe dieselbe Ausgabe erzeugen)
 *
 * Quellen:
 *   - Ländernamen: erste gefundene Datei wie in generate_decks.mjs:
 *       1. private/flaggen.xlsx
 *       2. private/flaggen.csv
 *       3. private/flaggen-vorlage.csv
 *     Falls keine Liste existiert, werden die Namen direkt aus Wikidata
 *     übernommen (Warnung – Nummerierung kann dann nicht abgesichert
 *     werden).
 *   - Kontinent (P30) und Nachbarn (P47): Wikidata-SPARQL (gleiche
 *     Länderliste wie download_flags.mjs / assign_difficulty.mjs).
 *
 * Ausgabe: app/choices.js (enthält absichtlich die Ländernamen).
 *
 * Vorher:  node tools/download_flags.mjs   (legt Flaggen und private
 *          Vorlage an) und node tools/generate_decks.mjs
 *
 * Verwendung:  node tools/generate_choices.mjs
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadFlagImages,
  allPairDistances,
  SIMILARITY_THRESHOLD,
  REVIEW_THRESHOLD,
} from './lib/flag-similarity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const FLAGS_DIR = path.join(APP_DIR, 'flags');
const PRIVATE_DIR = path.join(ROOT, 'private');

const XLSX_PATH = path.join(PRIVATE_DIR, 'flaggen.xlsx');
const CSV_PATH = path.join(PRIVATE_DIR, 'flaggen.csv');
const TEMPLATE_PATH = path.join(PRIVATE_DIR, 'flaggen-vorlage.csv');

const USER_AGENT = 'FunWithFlags/1.0 (privates Lernspiel; lokaler Download)';
const REQUEST_DELAY_MS = 200;

// Kontinente, für die Nachbarn als Ablenker verwendet werden
const NEIGHBOR_CONTINENTS = new Set(['Q15', 'Q18', 'Q48']); // Afrika, Südamerika, Asien

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 20;
        console.log(`   (HTTP 429 – warte ${retryAfter} s)`);
        await sleep(Math.min(retryAfter, 60) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

// Gleiche Länderliste wie in download_flags.mjs (-> gleiche Nummerierung);
// zusätzlich Kontinent (P30) und Nachbarländer (P47).
const SPARQL_QUERY = `
SELECT ?country ?countryLabel ?countryLabel_en
       (GROUP_CONCAT(DISTINCT STR(?continent); separator="|") AS ?continents)
       (GROUP_CONCAT(DISTINCT STR(?neighbor); separator="|") AS ?neighbors)
WHERE {
  { ?country wdt:P463 wd:Q1065. }
  UNION
  { VALUES ?country { wd:Q237 wd:Q219060 wd:Q35 wd:Q55 } }
  FILTER NOT EXISTS { ?country wdt:P576 ?end. }
  FILTER(?country NOT IN (wd:Q865, wd:Q17765809, wd:Q756617, wd:Q29999))
  OPTIONAL { ?country wdt:P30 ?continent. }
  OPTIONAL { ?country wdt:P47 ?neighbor. }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "de".
    ?country rdfs:label ?countryLabel.
  }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
    ?country rdfs:label ?countryLabel_en.
  }
}
GROUP BY ?country ?countryLabel ?countryLabel_en`;

async function loadCountries() {
  const url =
    'https://query.wikidata.org/sparql?' +
    new URLSearchParams({ query: SPARQL_QUERY, format: 'json' });
  console.log('Frage Wikidata nach Ländern, Kontinenten und Nachbarn …');
  const data = await fetchJson(url, 'Wikidata-SPARQL');
  const countries = [];
  for (const b of data.results.bindings) {
    const qid = b.country.value.split('/').pop();
    countries.push({
      qid,
      nameDe: b.countryLabel?.value ?? null,
      nameEn: b.countryLabel_en?.value ?? null,
      continents: new Set(
        (b.continents?.value ?? '').split('|').filter(Boolean).map((u) => u.split('/').pop()),
      ),
      neighbors: new Set(
        (b.neighbors?.value ?? '').split('|').filter(Boolean).map((u) => u.split('/').pop()),
      ),
    });
  }
  return countries;
}

// ---------- Ländername je Nummer aus der privaten Liste ----------

function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findColumn(headers, candidates) {
  const idx = headers.findIndex((h) => candidates.includes(normalizeHeader(h)));
  return idx >= 0 ? idx : -1;
}

/** Kleiner CSV-Parser (Anführungszeichen, ; oder , als Trennzeichen). */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const semis = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const delim = semis >= commas ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

/**
 * Liest die Ländernamen je Nummer aus der ersten gefundenen Liste.
 * Rückgabe: { names: Map(num -> Name), source: Pfad } oder null,
 * falls keine Liste existiert.
 */
async function loadNamesFromList() {
  let rows = null;
  let source = null;
  if (existsSync(XLSX_PATH)) {
    let XLSX;
    try {
      XLSX = await import('xlsx');
    } catch {
      throw new Error(
        `"${XLSX_PATH}" gefunden, aber das Paket "xlsx" fehlt.\n` +
          'Einmalig ausführen:  cd tools && npm install',
      );
    }
    const wb = XLSX.readFile(XLSX_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    source = XLSX_PATH;
  } else if (existsSync(CSV_PATH)) {
    rows = parseCsv(await readFile(CSV_PATH, 'utf8'));
    source = CSV_PATH;
  } else if (existsSync(TEMPLATE_PATH)) {
    rows = parseCsv(await readFile(TEMPLATE_PATH, 'utf8'));
    source = TEMPLATE_PATH;
  }
  if (!rows || rows.length < 2) return null;

  const headers = rows[0].map(String);
  const numCol = findColumn(headers, ['nummer', 'nr', 'nr.', 'no', '#', 'flagge nr', 'flaggen-nr']);
  const landCol = findColumn(headers, ['land_de', 'land', 'land (deutsch)', 'name_de', 'name', 'staat']);
  if (numCol < 0 || landCol < 0) {
    throw new Error(`Liste braucht Spalten "Nummer" und "Land_de". Kopfzeile: ${headers.join(', ')}`);
  }

  const names = new Map();
  for (let i = 1; i < rows.length; i++) {
    const numRaw = String(rows[i][numCol] ?? '').trim();
    const land = String(rows[i][landCol] ?? '').trim();
    if (numRaw === '' && land === '') continue;
    const digits = numRaw.replace(/\D+/g, '');
    if (!digits) {
      throw new Error(`Zeile ${i + 1}: Nummer "${numRaw}" ist nicht lesbar.`);
    }
    names.set(parseInt(digits, 10), land);
  }
  return { names, source };
}

// ---------- Deterministischer Zufall ----------

/** mulberry32 – kleiner PRNG mit festem Seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates-Shuffle mit übergebenem Zufallsgenerator. */
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Hauptablauf ----------

async function main() {
  const countries = await loadCountries();
  console.log(`${countries.length} Länder gefunden.`);

  const sortName = (c) => c.nameDe ?? c.nameEn ?? c.qid;
  countries.sort((a, b) =>
    sortName(a).localeCompare(sortName(b), 'de', { sensitivity: 'base' }),
  );

  // Nummerierung = Position in der sortierten Liste (wie download_flags.mjs)
  const qidToNum = new Map(countries.map((c, i) => [c.qid, i + 1]));

  // Ländernamen je Nummer: private Liste hat Vorrang, sonst Wikidata
  const list = await loadNamesFromList();
  let names;
  if (list) {
    console.log(`Verwende Ländernamen aus ${list.source}`);
    for (const [num, land] of list.names) {
      const expected = countries[num - 1]?.nameDe;
      if (!expected || expected !== land) {
        throw new Error(
          `Nummerierung weicht ab: Liste Nr. ${num} = "${land}", erwartet "${expected ?? '???'}".\n` +
            'Bitte Liste in private/ prüfen (ggf. zuerst node tools/download_flags.mjs ausführen).',
        );
      }
    }
    names = list.names;
  } else {
    console.warn(
      'Warnung: keine Liste in private/ gefunden (flaggen.xlsx, flaggen.csv, flaggen-vorlage.csv).\n' +
        '         Verwende Ländernamen direkt aus Wikidata; die Nummerierung kann nicht\n' +
        '         gegen die Liste abgesichert werden.',
    );
    names = new Map(countries.map((c, i) => [i + 1, c.nameDe ?? c.nameEn ?? c.qid]));
  }

  // Flaggen-Dateien: die Nummern, für die choices.js Einträge braucht
  const flagNumbers = (await readdir(FLAGS_DIR))
    .map((f) => f.match(/^(\d{3})\.png$/)?.[1])
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .sort((a, b) => a - b);
  if (flagNumbers.length === 0) {
    throw new Error('Keine Flaggen unter app/flags/ gefunden – zuerst node tools/download_flags.mjs ausführen.');
  }

  // Flaggen-Ähnlichkeit berechnen
  console.log('Analysiere Flaggen-Ähnlichkeiten …');
  const profiles = await loadFlagImages(flagNumbers);
  const pairs = allPairDistances(flagNumbers, profiles);
  const similarBelowThreshold = pairs.filter((p) => p.d < SIMILARITY_THRESHOLD);
  const reviewBelowThreshold = pairs.filter((p) => p.d < REVIEW_THRESHOLD);
  console.log(
    `  ${similarBelowThreshold.length} Paare unter ${SIMILARITY_THRESHOLD}, ` +
      `${reviewBelowThreshold.length} Paare unter ${REVIEW_THRESHOLD}.`,
  );

  // Ablenker je Nummer bestimmen
  const counts = { similar: 0, neighbor: 0, random: 0 };
  const choices = new Map();

  for (const num of flagNumbers) {
    const country = countries[num - 1];
    const correctName = names.get(num) ?? country?.nameDe;
    const used = new Set();

    // 1) Sehr ähnliche Flaggen (< 0.13) – Review-Paare (0.13–0.16) nur
    //    als Nachschub, falls es an Kandidaten mangelt
    const strictNums = [];
    const reviewNums = [];
    for (const p of pairs) {
      if (p.d >= REVIEW_THRESHOLD) break; // Paare sind aufsteigend sortiert
      if (p.a === num) {
        (p.d < SIMILARITY_THRESHOLD ? strictNums : reviewNums).push(p.b);
      } else if (p.b === num) {
        (p.d < SIMILARITY_THRESHOLD ? strictNums : reviewNums).push(p.a);
      }
    }

    // 2) Nachbarn (nur Afrika, Südamerika, Asien)
    const neighborNums = [];
    const isNeighborContinent = [...country.continents].some((c) => NEIGHBOR_CONTINENTS.has(c));
    if (isNeighborContinent) {
      for (const qid of country.neighbors) {
        const n = qidToNum.get(qid);
        if (n && n !== num) neighborNums.push(n);
      }
      neighborNums.sort((a, b) => a - b);
    }

    // 3) Zufalls-Auffüllung (deterministisch mit Seed = Nummer)
    const rng = mulberry32(num * 2654435761 + 1013904223);
    const randomPool = shuffled(
      flagNumbers.filter((n) => n !== num),
      rng,
    );

    const pick = (candidates, kind) => {
      for (const n of candidates) {
        if (choices.get(num)?.length >= 5) break;
        if (used.has(n)) continue;
        used.add(n);
        choices.get(num).push(names.get(n));
        counts[kind]++;
      }
    };

    choices.set(num, [correctName]);
    pick(strictNums, 'similar');
    pick(neighborNums, 'neighbor');
    pick(reviewNums, 'similar');
    pick(randomPool, 'random');

    if (choices.get(num).length !== 5) {
      throw new Error(`Nummer ${num}: konnte keine 5 Antwort-Optionen erzeugen.`);
    }
  }

  // Validierung vor dem Schreiben
  const errors = [];
  for (const num of flagNumbers) {
    const entry = choices.get(num);
    if (!entry) {
      errors.push(`Nummer ${num} fehlt in den Auswahl-Optionen.`);
      continue;
    }
    if (entry.length !== 5) {
      errors.push(`Nummer ${num}: ${entry.length} statt 5 Optionen.`);
    }
    if (new Set(entry).size !== entry.length) {
      errors.push(`Nummer ${num}: doppelte Namen in den Optionen.`);
    }
    const expected = names.get(num);
    if (entry[0] !== expected) {
      errors.push(`Nummer ${num}: erste Option "${entry[0]}" ist nicht "${expected}".`);
    }
  }
  for (const [num, entry] of choices) {
    if (!flagNumbers.includes(num)) {
      errors.push(`Nummer ${num} hat keine Datei app/flags/${String(num).padStart(3, '0')}.png.`);
    }
  }
  if (errors.length > 0) {
    console.error('Validierung fehlgeschlagen – app/choices.js wurde NICHT verändert:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }

  // app/choices.js schreiben
  const today = new Date().toISOString().slice(0, 10);
  const lines = flagNumbers.map((num) => `  ${num}: ${JSON.stringify(choices.get(num))},`);
  const content = `// ============================================================
// choices.js – Antwort-Optionen je Flaggen-Nummer.
// Automatisch erzeugt am ${today} durch tools/generate_choices.mjs.
// Pro Nummer genau 5 Ländernamen; der ERSTE ist der richtige
// (die App mischt die Reihenfolge bei jeder Frage).
// Ablenker: ähnliche Flaggen, Nachbarn (Afrika/Südamerika/Asien),
// Rest zufällig – siehe tools/generate_choices.mjs.
// Bei Änderungen neu erzeugen mit:
//   node tools/generate_choices.mjs
// ============================================================
window.CHOICES = {
${lines.join('\n')}
};
`;

  const choicesPath = path.join(APP_DIR, 'choices.js');
  await writeFile(choicesPath, content, 'utf8');

  // Zusammenfassung
  const total = counts.similar + counts.neighbor + counts.random;
  console.log('');
  console.log(`app/choices.js erzeugt (${today}): ${choices.size} Flaggen mit je 5 Optionen.`);
  console.log('Herkunft der 4 Ablenker je Flagge (insgesamt):');
  console.log(`  ähnliche Flagge: ${counts.similar}  |  Nachbarland: ${counts.neighbor}  |  zufällig: ${counts.random}  (Summe: ${total})`);
  console.log('');
  console.log(`Sehr ähnliche Flaggen-Paare unter ${SIMILARITY_THRESHOLD}: ${similarBelowThreshold.length}`);
  for (const p of similarBelowThreshold) {
    console.log(
      `  ${String(p.a).padStart(3, '0')} <-> ${String(p.b).padStart(3, '0')}  (${p.d.toFixed(3)})   ${names.get(p.a)} / ${names.get(p.b)}`,
    );
  }
  console.log('');
  console.log('Beispiele:');
  for (const num of [1, 2, 3]) {
    if (choices.has(num)) console.log(`  ${String(num).padStart(3, '0')}: ${choices.get(num).join(' | ')}`);
  }
}

main().catch((err) => {
  console.error('Abbruch mit Fehler:', err.message);
  process.exit(1);
});
