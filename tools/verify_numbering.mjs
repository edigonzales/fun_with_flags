#!/usr/bin/env node
/**
 * verify_numbering.mjs
 * ---------------------
 * Prüft für alle Flaggen, ob app/flags/NNN.png wirklich die Flagge
 * des Landes zeigt, das die heutige Wikidata-Liste an Position NNN
 * führt (Nummerierung = alphabetisch nach deutschem Namen, wie beim
 * ursprünglichen Download).
 *
 * Ablauf je Nummer:
 *   1. Aktuelle Flaggen-Datei des erwarteten Landes ermitteln
 *      (Infobox image_flag, Fallback Wikidata P41) und den Thumbnail
 *      von Wikimedia herunterladen.
 *   2. Pixel-Profile beider Bilder vergleichen (lib/flag-similarity.mjs,
 *      Minimum über Spiegelungen) und zusätzlich den Byte-Hash prüfen.
 *
 * Einstufung:
 *   OK           Distanz < 0.05  (ggf. mit "byte-identisch")
 *   PRÜFEN       0.05 – 0.10     (z. B. minimal geändertes Design)
 *   ABWEICHUNG   >= 0.10         (falsches Land oder Flagge geändert)
 *   FEHLER       aktuelle Flagge nicht ladbar
 *
 * Falls eine Liste in private/ existiert (flaggen.xlsx, flaggen.csv,
 * flaggen-vorlage.csv), wird deren Ländername je Nummer zusätzlich
 * gegen den heutigen Wikidata-Namen gehalten (Hinweis, keine Wertung –
 * die Bildprüfung ist die eigentliche Wahrheit).
 *
 * Hinweis: optisch identische Flaggen (z. B. Indonesien/Monaco,
 * Tschad/Rumänien) sind pixeltechnisch nicht unterscheidbar; ein Tausch
 * innerhalb solcher Paare ist nicht erkennbar und fürs Spiel unerheblich.
 *
 * Exit-Code 1 bei mindestens einer ABWEICHUNG oder einem FEHLER.
 *
 * Verwendung:  node tools/verify_numbering.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

import { loadFlagImages, flagProfiles, pairDist, FLAGS_DIR } from './lib/flag-similarity.mjs';
import { loadCountries, flagFromArticle, flagFromP41, fetchThumbnail, sleep, REQUEST_DELAY_MS } from './lib/wikimedia.mjs';

const { PNG } = pngjs;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIR = path.join(ROOT, 'private');

const XLSX_PATH = path.join(PRIVATE_DIR, 'flaggen.xlsx');
const CSV_PATH = path.join(PRIVATE_DIR, 'flaggen.csv');
const TEMPLATE_PATH = path.join(PRIVATE_DIR, 'flaggen-vorlage.csv');

const OK_LIMIT = 0.05; // darunter: gleiche Flagge
const REVIEW_LIMIT = 0.1; // darüber: Abweichung

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

/** Ländername je Nummer aus der ersten gefundenen privaten Liste. */
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
  if (!rows || rows.length < 2) return { names: new Map(), source: null };

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

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** PNG/JPEG-Puffer dekodieren; null, wenn nicht dekodierbar. */
function decodeImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return PNG.sync.read(buf);
  }
  return null; // JPEG o. ä. – hier nicht vergleichbar
}

async function main() {
  // Lokale Flaggen
  const numbers = (await readdir(FLAGS_DIR))
    .map((f) => f.match(/^(\d{3})\.png$/)?.[1])
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .sort((a, b) => a - b);
  if (numbers.length === 0) {
    throw new Error('Keine Flaggen unter app/flags/ gefunden – zuerst node tools/download_flags.mjs ausführen.');
  }
  console.log(`${numbers.length} lokale Flaggen gefunden.`);
  const localProfiles = await loadFlagImages(numbers);

  // Heutige Länderliste (Position = Nummer)
  const countries = await loadCountries();
  console.log(`${countries.length} Länder gefunden.`);
  const sortName = (c) => c.nameDe ?? c.nameEn ?? c.qid;
  countries.sort((a, b) => sortName(a).localeCompare(sortName(b), 'de', { sensitivity: 'base' }));
  if (countries.length !== numbers.length) {
    console.warn(
      `Warnung: Liste hat ${countries.length} Länder, lokal liegen ${numbers.length} Flaggen. ` +
        'Die Nummerierung kann sich verschoben haben – Ergebnis besonders kritisch prüfen.',
    );
  }

  // Private Liste (optional, nur Anzeige)
  const { names: listNames, source: listSource } = await loadNamesFromList();
  if (listSource) console.log(`Private Liste gefunden: ${listSource}`);

  const results = []; // { num, todayName, listName, file, status, distance, note }
  let byteIdenticalCount = 0;

  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i];
    const numStr = String(num).padStart(3, '0');
    const country = countries[num - 1];
    const todayName = country ? sortName(country) : '?? (kein Land in der Liste)';
    const listName = listNames.get(num) ?? null;
    process.stdout.write(`[${numStr}/${String(numbers.length).padStart(3, '0')}] ${todayName} … `);

    let result;
    if (!country) {
      result = { num, todayName, listName, status: 'FEHLER', distance: null, note: 'kein Land an dieser Position in der heutigen Liste' };
      console.log('FEHLER (kein Land)');
    } else {
      let fileName;
      let via = 'image_flag';
      try {
        if (!country.article) throw new Error('kein Wikipedia-Artikel (Sitelink)');
        try {
          fileName = await flagFromArticle(country.article);
        } catch {
          fileName = await flagFromP41(country.qid);
          via = 'P41-Fallback';
        }
        const thumb = await fetchThumbnail(fileName);
        if (!thumb) throw new Error('Thumbnail nirgends gefunden');
        const remotePng = decodeImage(thumb.data);
        if (!remotePng) throw new Error('Thumbnail ist kein PNG (nicht vergleichbar)');
        const remoteProf = flagProfiles(remotePng);
        const localProf = localProfiles.get(num);
        const d = Math.min(
          pairDist(localProf, remoteProf, 'none'),
          pairDist(localProf, remoteProf, 'v'),
          pairDist(localProf, remoteProf, 'h'),
        );
        const localBuf = await readFile(path.join(FLAGS_DIR, `${numStr}.png`));
        const byteIdentical = sha256(localBuf) === sha256(thumb.data);
        if (byteIdentical) byteIdenticalCount++;
        const note = `${via}${byteIdentical ? ', byte-identisch' : ''}`;
        if (d < OK_LIMIT) {
          result = { num, todayName, listName, status: 'OK', distance: d, note };
        } else if (d < REVIEW_LIMIT) {
          result = { num, todayName, listName, status: 'PRÜFEN', distance: d, note };
        } else {
          result = { num, todayName, listName, status: 'ABWEICHUNG', distance: d, note };
        }
        console.log(`${result.status} (${d.toFixed(3)})${byteIdentical ? ' – byte-identisch' : ''}`);
      } catch (err) {
        result = { num, todayName, listName, status: 'FEHLER', distance: null, note: err.message };
        console.log(`FEHLER: ${err.message}`);
      }
    }
    results.push(result);
    await sleep(REQUEST_DELAY_MS);
  }

  // Zusammenfassung
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log('');
  console.log('=== Zusammenfassung ===');
  console.log(
    `OK: ${count('OK')} (davon ${byteIdenticalCount} byte-identisch)  |  ` +
      `prüfen: ${count('PRÜFEN')}  |  Abweichungen: ${count('ABWEICHUNG')}  |  Fehler: ${count('FEHLER')}`,
  );

  const notable = results.filter((r) => r.status !== 'OK');
  if (notable.length > 0) {
    console.log('');
    console.log('Details:');
    for (const r of notable) {
      const parts = [
        String(r.num).padStart(3, '0'),
        r.status,
        r.todayName,
        r.listName && r.listName !== r.todayName ? `(Liste: ${r.listName})` : '',
        r.distance !== null ? `Distanz ${r.distance.toFixed(3)}` : '',
        r.note,
      ].filter(Boolean);
      console.log('  ' + parts.join('  '));
    }
  }

  const listOnly = [];
  for (const [num, name] of [...listNames].sort((a, b) => a[0] - b[0])) {
    const today = countries[num - 1] ? sortName(countries[num - 1]) : null;
    if (today && today !== name) listOnly.push({ num, name, today });
  }
  if (listOnly.length > 0) {
    console.log('');
    console.log('Namensunterschiede zwischen privater Liste und Wikidata heute:');
    for (const e of listOnly) {
      console.log(`  ${String(e.num).padStart(3, '0')}: Liste "${e.name}" – Wikidata heute "${e.today}"`);
    }
  }

  if (count('ABWEICHUNG') > 0 || count('FEHLER') > 0) {
    console.log('');
    console.warn('Es gibt Abweichungen/Fehler – vor node tools/generate_choices.mjs klären!');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Abbruch mit Fehler:', err.message);
  process.exit(1);
});
