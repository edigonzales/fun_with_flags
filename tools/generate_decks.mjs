#!/usr/bin/env node
/**
 * generate_decks.mjs
 * -------------------
 * Liest die Schwierigkeits-Zuordnung aus der Liste in private/
 * (XLSX oder CSV) und erzeugt app/decks.js – nur Flaggen-Nummern,
 * KEINE Ländernamen.
 *
 * Benötigte Spalten: "Nummer" und "Schwierigkeit".
 *   Schwierigkeit: 1 / 2 / 3  oder  "leicht" / "mittel" / "schwer".
 *
 * Es wird die erste gefundene Datei verwendet:
 *   1. private/flaggen.xlsx          (benötigt einmalig:  cd tools && npm install)
 *   2. private/flaggen.csv           (kein npm nötig; Trennzeichen , oder ;)
 *   3. private/flaggen-vorlage.csv   (Fallback: Entwurf aus
 *                                    tools/assign_difficulty.mjs)
 *
 * Vorher:  node tools/download_flags.mjs   (lädt die Flaggen und legt
 *          private/flaggen-vorlage.csv an, die als Grundlage dient)
 *
 * Verwendung:  node tools/generate_decks.mjs
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const FLAGS_DIR = path.join(APP_DIR, 'flags');
const PRIVATE_DIR = path.join(ROOT, 'private');

const XLSX_PATH = path.join(PRIVATE_DIR, 'flaggen.xlsx');
const CSV_PATH = path.join(PRIVATE_DIR, 'flaggen.csv');
const TEMPLATE_PATH = path.join(PRIVATE_DIR, 'flaggen-vorlage.csv');

const DIFFICULTY_MAP = {
  '1': 1,
  '2': 2,
  '3': 3,
  'leicht': 1,
  'einfach': 1,
  'mittel': 2,
  'schwer': 3,
  'schwierig': 3,
};

const DIFF_NAMES = { 1: 'leicht', 2: 'mittel', 3: 'schwer' };

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

async function loadRows() {
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
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  }
  if (existsSync(CSV_PATH)) {
    const text = await readFile(CSV_PATH, 'utf8');
    return parseCsv(text);
  }
  if (existsSync(TEMPLATE_PATH)) {
    console.warn('Hinweis: keine private/flaggen.csv/xlsx gefunden – verwende private/flaggen-vorlage.csv (Entwurf).');
    const text = await readFile(TEMPLATE_PATH, 'utf8');
    return parseCsv(text);
  }
  throw new Error(
    `Keine Liste gefunden. Erwartet: ${XLSX_PATH}, ${CSV_PATH} oder ${TEMPLATE_PATH}`,
  );
}

function parseNumber(v) {
  const digits = String(v ?? '').replace(/\D+/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return n >= 1 ? n : null;
}

function parseDifficulty(v) {
  return DIFFICULTY_MAP[String(v ?? '').trim().toLowerCase()] ?? null;
}

async function main() {
  const rows = await loadRows();
  if (rows.length < 2) throw new Error('Liste ist leer oder hat keine Kopfzeile.');

  const headers = rows[0].map(String);
  const numCol = findColumn(headers, ['nummer', 'nr', 'nr.', 'no', '#', 'flagge nr', 'flaggen-nr']);
  const diffCol = findColumn(headers, [
    'schwierigkeit',
    'stufe',
    'schwierigkeitsgrad',
    'difficulty',
    'level',
  ]);
  if (numCol < 0) throw new Error(`Spalte "Nummer" nicht gefunden. Kopfzeile: ${headers.join(', ')}`);
  if (diffCol < 0) throw new Error(`Spalte "Schwierigkeit" nicht gefunden. Kopfzeile: ${headers.join(', ')}`);

  const expected = (await readdir(FLAGS_DIR))
    .map((f) => f.match(/^(\d{3})\.png$/)?.[1])
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .sort((a, b) => a - b);
  if (expected.length === 0) {
    throw new Error('Keine Flaggen unter app/flags/ gefunden – zuerst node tools/download_flags.mjs ausführen.');
  }

  const errors = [];
  const entries = new Map(); // Nummer -> { line, diff }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const numRaw = String(row[numCol] ?? '').trim();
    const diffRaw = String(row[diffCol] ?? '').trim();
    if (numRaw === '' && diffRaw === '') continue; // Leerzeile
    const num = parseNumber(numRaw);
    const diff = parseDifficulty(diffRaw);
    if (num === null) {
      errors.push(`Zeile ${i + 1}: Nummer "${numRaw}" ist nicht lesbar.`);
      continue;
    }
    if (diff === null) {
      errors.push(
        `Zeile ${i + 1}: Schwierigkeit "${diffRaw}" ist ungültig (erlaubt: 1, 2, 3 oder leicht/mittel/schwer).`,
      );
      continue;
    }
    if (entries.has(num)) {
      errors.push(`Zeile ${i + 1}: Nummer ${num} kommt mehrfach vor (auch in Zeile ${entries.get(num).line}).`);
      continue;
    }
    entries.set(num, { line: i + 1, diff });
    if (!expected.includes(num)) {
      errors.push(`Zeile ${i + 1}: Nummer ${num} hat keine Datei app/flags/${String(num).padStart(3, '0')}.png.`);
    }
  }

  for (const n of expected) {
    if (!entries.has(n)) {
      errors.push(`Nummer ${n} (app/flags/${String(n).padStart(3, '0')}.png) fehlt in der Liste.`);
    }
  }

  if (errors.length > 0) {
    console.error('Validierung fehlgeschlagen – app/decks.js wurde NICHT verändert:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }

  const decks = { 1: [], 2: [], 3: [] };
  for (const [num, entry] of entries) decks[entry.diff].push(num);
  for (const level of [1, 2, 3]) decks[level].sort((a, b) => a - b);

  const today = new Date().toISOString().slice(0, 10);
  const content = `// ============================================================
// decks.js – Flaggen-Nummern je Schwierigkeitsstufe.
// Automatisch erzeugt am ${today} durch tools/generate_decks.mjs.
// Enthält absichtlich KEINE Ländernamen.
// Bei Änderungen: Liste in private/ anpassen und neu erzeugen mit
//   node tools/generate_decks.mjs
// ============================================================
window.DECKS = {
  1: [${decks[1].join(', ')}],   // leicht
  2: [${decks[2].join(', ')}],   // mittel
  3: [${decks[3].join(', ')}],   // schwer
};
`;

  const decksPath = path.join(APP_DIR, 'decks.js');
  await writeFile(decksPath, content, 'utf8');

  console.log(`app/decks.js erzeugt (${today}):`);
  for (const level of [1, 2, 3]) {
    console.log(`  Stufe ${level} (${DIFF_NAMES[level]}): ${decks[level].length} Flaggen`);
  }
}

main().catch((err) => {
  console.error('Abbruch mit Fehler:', err.message);
  process.exit(1);
});
