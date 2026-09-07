#!/usr/bin/env node
/**
 * assign_difficulty.mjs
 * ----------------------
 * Errechnet einen Schwierigkeits-Entwurf (1 = leicht, 2 = mittel,
 * 3 = schwer) für alle Flaggen und trägt ihn in die Spalte
 * "Schwierigkeit" von private/flaggen-vorlage.csv ein.
 *
 * Kriterien:
 *   - Bekanntheit über Einwohnerzahl (Wikidata P1082):
 *       >= 30 Mio. -> 1 | 5-30 Mio. -> 2 | < 5 Mio. -> 3
 *   - Nachbarländer der Schweiz (feste Liste) -> hart Stufe 1
 *   - Westafrika (feste Liste)                -> hart Stufe 3
 *   - Middle East (feste Liste)               -> mindestens Stufe 2
 *   - Flaggen mit sehr ähnlichem Aussehen (Pixel-Analyse der
 *     app/flags/*.png)                        -> +1 Stufe (max. 3)
 *
 * Danach: Entwurf in Excel/LibreOffice prüfen und wie gewohnt
 *   node tools/generate_decks.mjs
 * ausführen.
 *
 * Verwendung:  node tools/assign_difficulty.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadFlagImages,
  allPairDistances,
  SIMILARITY_THRESHOLD,
  REVIEW_THRESHOLD,
} from './lib/flag-similarity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = path.join(ROOT, 'private', 'flaggen-vorlage.csv');

const USER_AGENT = 'FunWithFlags/1.0 (privates Lernspiel; lokaler Download)';
const REQUEST_DELAY_MS = 200;

// Einwohnerzahl-Schwellen für die Basis-Einstufung
const POP_EASY = 20_000_000;
const POP_MEDIUM = 1_000_000;

// Schweiz und Nachbarn (Deutschland, Frankreich, Italien, Österreich,
// Liechtenstein) – für eine Schweizer Spielerin alle sehr vertraut
const SWISS_NEIGHBORS = new Set(['Q39', 'Q183', 'Q142', 'Q38', 'Q40', 'Q347']);

// Middle East (feste Liste; Modellierung in Wikidata ist uneinheitlich)
const MIDDLE_EAST = new Set([
  'Q398', // Bahrain
  'Q79', // Ägypten
  'Q796', // Irak
  'Q794', // Iran
  'Q801', // Israel
  'Q805', // Jemen
  'Q810', // Jordanien
  'Q846', // Katar
  'Q817', // Kuwait
  'Q822', // Libanon
  'Q842', // Oman
  'Q851', // Saudi-Arabien
  'Q858', // Syrien
  'Q43', // Türkei
  'Q878', // Vereinigte Arabische Emirate
  'Q219060', // Palästina
  'Q1049', // Sudan (gleiche Flaggenfamilie)
]);

// Westafrika (feste Liste)
const WEST_AFRICA = new Set([
  'Q962', // Benin
  'Q965', // Burkina Faso
  'Q1011', // Kap Verde
  'Q1008', // Elfenbeinküste
  'Q1005', // Gambia
  'Q117', // Ghana
  'Q1006', // Guinea
  'Q1007', // Guinea-Bissau
  'Q1014', // Liberia
  'Q912', // Mali
  'Q1025', // Mauretanien
  'Q1032', // Niger
  'Q1033', // Nigeria
  'Q1041', // Senegal
  'Q1044', // Sierra Leone
  'Q945', // Togo
]);

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

// Gleiche Länderliste wie in download_flags.mjs (-> gleiche Nummerierung)
const SPARQL_QUERY = `
SELECT ?country ?countryLabel ?countryLabel_en
       (MAX(?pop) AS ?maxPop)
       (GROUP_CONCAT(DISTINCT STR(?region); separator="|") AS ?regions)
WHERE {
  { ?country wdt:P463 wd:Q1065. }
  UNION
  { VALUES ?country { wd:Q237 wd:Q219060 wd:Q35 wd:Q55 } }
  FILTER NOT EXISTS { ?country wdt:P576 ?end. }
  FILTER(?country NOT IN (wd:Q865, wd:Q17765809, wd:Q756617, wd:Q29999))
  OPTIONAL { ?country wdt:P1082 ?pop. }
  OPTIONAL { ?country wdt:P361 ?region. }
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
  console.log('Frage Wikidata nach Ländern und Einwohnerzahlen …');
  const data = await fetchJson(url, 'Wikidata-SPARQL');
  const countries = [];
  for (const b of data.results.bindings) {
    const qid = b.country.value.split('/').pop();
    const regions = new Set((b.regions?.value ?? '').split('|').filter(Boolean).map((u) => u.split('/').pop()));
    countries.push({
      qid,
      nameDe: b.countryLabel?.value ?? null,
      nameEn: b.countryLabel_en?.value ?? null,
      pop: b.maxPop?.value ? Number(b.maxPop.value) : null,
      regions,
    });
  }
  return countries;
}

/**
 * Profil-Merkmale und paarweise Flaggen-Distanzen liegen in
 * lib/flag-similarity.mjs (auch von generate_choices.mjs genutzt).
 */

/** Kleinster CSV-Parser (wie in den anderen Tools). */
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
  return rows;
}

function csvLine(fields) {
  return (
    fields
      .map((f) => `"${String(f ?? '').replaceAll('"', '""')}"`)
      .join(';') + '\n'
  );
}

async function main() {
  const countries = await loadCountries();
  console.log(`${countries.length} Länder gefunden.`);

  const sortName = (c) => c.nameDe ?? c.nameEn ?? c.qid;
  countries.sort((a, b) =>
    sortName(a).localeCompare(sortName(b), 'de', { sensitivity: 'base' }),
  );

  // Nummerierung gegen die Vorlage absichern (Nummer = Position wie in
  // download_flags.mjs; Ländernamen müssen übereinstimmen)
  const templateText = await readFile(TEMPLATE_PATH, 'utf8');
  const templateRows = parseCsv(templateText);
  const headers = templateRows[0];
  const numCol = headers.findIndex((h) => String(h).trim().toLowerCase() === 'nummer');
  const landCol = headers.findIndex((h) => String(h).trim().toLowerCase() === 'land_de');
  const diffCol = headers.findIndex((h) => String(h).trim().toLowerCase() === 'schwierigkeit');
  if (numCol < 0 || landCol < 0 || diffCol < 0) {
    throw new Error(`Vorlage braucht Spalten "Nummer", "Land_de" und "Schwierigkeit". Gefunden: ${headers.join(', ')}`);
  }
  for (let i = 1; i < templateRows.length; i++) {
    const row = templateRows[i];
    const num = parseInt(String(row[numCol]).replace(/\D+/g, ''), 10);
    const expectedName = countries[num - 1]?.nameDe;
    if (row[landCol] !== expectedName) {
      throw new Error(`Nummerierung weicht ab: Vorlage Nr. ${num} = "${row[landCol]}", erwartet "${expectedName}".`);
    }
  }
  console.log('Nummerierung stimmt mit der Vorlage überein.');

  // Flaggen-Ähnlichkeit berechnen
  console.log('Analysiere Flaggen-Ähnlichkeiten …');
  const numbers = countries.map((_, i) => i + 1);
  const profiles = await loadFlagImages(numbers);
  const pairs = allPairDistances(numbers, profiles);
  const similarPairs = []; // gezählt (< Schwelle)
  const reviewPairs = []; // alle < Review-Schwelle, zur Ansicht
  for (const { a, b, d } of pairs) {
    if (d < SIMILARITY_THRESHOLD) similarPairs.push([a, b, d]);
    if (d < REVIEW_THRESHOLD) reviewPairs.push([a, b, d]);
  }
  const confusable = new Set();
  for (const [a, b] of similarPairs) {
    confusable.add(a);
    confusable.add(b);
  }

  // Regeln anwenden
  const byQid = new Map(countries.map((c) => [c.qid, c]));
  const levels = new Map(); // Nummer -> Stufe
  for (let i = 0; i < countries.length; i++) {
    const c = countries[i];
    const num = i + 1;
    let level;
    let reason;
    if (SWISS_NEIGHBORS.has(c.qid)) {
      level = 1;
      reason = 'Schweiz-Nachbar';
    } else if (WEST_AFRICA.has(c.qid) || c.regions.has('Q4412')) {
      level = 3;
      reason = 'Westafrika';
    } else {
      level = c.pop >= POP_EASY ? 1 : c.pop >= POP_MEDIUM ? 2 : 3;
      reason = `Einwohnerzahl (${(c.pop / 1e6).toFixed(1)} Mio.)`;
      const isMiddleEast = MIDDLE_EAST.has(c.qid) || c.regions.has('Q7204');
      if (isMiddleEast) {
        if (level < 2) level = 2;
        reason += ' + Middle East';
      }
      // Ähnlichkeit nur ab Stufe 2 hochstufen (schützt weltbekannte Flaggen)
      if (confusable.has(num) && level >= 2) {
        level = Math.min(3, level + 1);
        reason += ' + ähnliche Flagge';
      }
    }
    levels.set(num, { level, reason });
  }

  // Vorlage aktualisieren
  for (let i = 1; i < templateRows.length; i++) {
    const num = parseInt(String(templateRows[i][numCol]).replace(/\D+/g, ''), 10);
    templateRows[i][diffCol] = String(levels.get(num).level);
  }
  await writeFile(TEMPLATE_PATH, templateRows.map(csvLine).join(''), 'utf8');

  // Zusammenfassung
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const { level } of levels.values()) counts[level]++;
  console.log('');
  console.log('=== Einstufung geschrieben nach private/flaggen-vorlage.csv ===');
  console.log(`Stufe 1 (leicht): ${counts[1]}  |  Stufe 2 (mittel): ${counts[2]}  |  Stufe 3 (schwer): ${counts[3]}`);
  console.log('');
  console.log('Schweiz und Nachbarn (hart Stufe 1):');
  for (const c of countries) {
    if (SWISS_NEIGHBORS.has(c.qid)) console.log(`  ${String(countries.indexOf(c) + 1).padStart(3, '0')} ${sortName(c)}`);
  }
  console.log('Westafrika (hart Stufe 3):');
  for (const c of countries) {
    if (WEST_AFRICA.has(c.qid) || c.regions.has('Q4412')) {
      console.log(`  ${String(countries.indexOf(c) + 1).padStart(3, '0')} ${sortName(c)}`);
    }
  }
  console.log('Middle East (mind. Stufe 2):');
  for (const c of countries) {
    if (MIDDLE_EAST.has(c.qid) || c.regions.has('Q7204')) {
      const num = countries.indexOf(c) + 1;
      console.log(`  ${String(num).padStart(3, '0')} ${sortName(c)} -> Stufe ${levels.get(num).level}`);
    }
  }
  console.log('');
  console.log(`Sehr ähnliche Flaggen-Paare unter ${SIMILARITY_THRESHOLD} (zählen für +1 Stufe): ${similarPairs.length}`);
  for (const [a, b, d] of similarPairs) {
    console.log(
      `  ${String(a).padStart(3, '0')} <-> ${String(b).padStart(3, '0')}  (${d.toFixed(3)})   ${sortName(countries[a - 1])} / ${sortName(countries[b - 1])}`,
    );
  }
  console.log('');
  console.log(`Knapp über der Schwelle (${SIMILARITY_THRESHOLD} bis ${REVIEW_THRESHOLD}, zählen NICHT):`);
  for (const [a, b, d] of reviewPairs) {
    if (d >= SIMILARITY_THRESHOLD) {
      console.log(
        `  ${String(a).padStart(3, '0')} <-> ${String(b).padStart(3, '0')}  (${d.toFixed(3)})   ${sortName(countries[a - 1])} / ${sortName(countries[b - 1])}`,
      );
    }
  }
}

main().catch((err) => {
  console.error('Abbruch mit Fehler:', err.message);
  process.exit(1);
});
