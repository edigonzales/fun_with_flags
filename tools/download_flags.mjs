#!/usr/bin/env node
/**
 * download_flags.mjs
 * -------------------
 * Lädt die Nationalflaggen aller UN-Mitgliedsstaaten sowie des Vatikans
 * und Palästinas von Wikimedia Commons herunter und speichert sie als
 * app/flags/NNN.png (Breite 960 px).
 *
 * Ablauf (läuft nur lokal, einmalig):
 *   1. Wikidata-SPARQL: aktuelle UN-Mitglieder (P463 -> Q1065, ohne
 *      aufgelöste Staaten) + Vatikan, Palästina, Dänemark, Niederlande.
 *      Ausgeschlossen: Taiwan, "Third Hellenic Republic",
 *      "Königreich Dänemark", "Königreich der Niederlande".
 *   2. Englisches Wikipedia-Lemma je Land (Sitelink), Infobox lesen
 *      (Parameter image_flag) -> aktuelle Flaggen-Datei.
 *   3. Fallback, falls image_flag fehlt: Wikidata-Eigenschaft P41.
 *   4. Thumbnail-URL direkt nach Wikimedia-Schema bauen (MD5-Pfad,
 *      erlaubte Größen: 960/500/330 px). Fallback für Dateien, die nur
 *      lokal auf en.wikipedia.org liegen: MediaWiki-API imageinfo.
 *
 * Ausgaben:
 *   - app/flags/NNN.png            (nummerierte Flaggen,
 *                                   alphabetisch nach deutschem Namen)
 *   - tools/report.csv             (Nummer; Land_de; Land_en;
 *                                   Wikipedia-Artikel; Flaggen-Datei;
 *                                   Status; Bild-URL)
 *   - private/flaggen-vorlage.csv  (Vorlage: Schwierigkeit eintragen)
 *   - app/decks.js                 (vorläufig: alle Flaggen in Stufe 2)
 *
 * Verwendung:  node tools/download_flags.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCountries,
  flagFromArticle,
  flagFromP41,
  buildThumbUrl,
  downloadImage,
  sleep,
  THUMB_WIDTHS,
  REQUEST_DELAY_MS,
} from './lib/wikimedia.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const FLAGS_DIR = path.join(APP_DIR, 'flags');
const TOOLS_DIR = path.join(ROOT, 'tools');
const PRIVATE_DIR = path.join(ROOT, 'private');

function csvLine(fields) {
  return (
    fields
      .map((f) => `"${String(f ?? '').replaceAll('"', '""')}"`)
      .join(';') + '\n'
  );
}

/** Kleiner CSV-Parser (wie in generate_decks.mjs). */
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

/** Prüft, ob die Datei ein gültiges heruntergeladenes Bild ist. */
async function isValidImage(filePath) {
  try {
    const buf = await readFile(filePath);
    if (buf.length <= 200) return false;
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buf.subarray(0, 8).equals(pngMagic) || (buf[0] === 0xff && buf[1] === 0xd8);
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(FLAGS_DIR, { recursive: true });
  await mkdir(PRIVATE_DIR, { recursive: true });

  const countries = await loadCountries();
  console.log(`${countries.length} Länder gefunden.`);
  if (countries.length < 190) {
    console.warn('Warnung: unerwartet wenige Treffer – Ergebnis bitte prüfen!');
  }

  const sortName = (c) => c.nameDe ?? c.nameEn ?? c.qid;
  countries.sort((a, b) =>
    sortName(a).localeCompare(sortName(b), 'de', { sensitivity: 'base' }),
  );

  const total = countries.length;
  const report = [
    ['Nummer', 'Land_de', 'Land_en', 'Wikipedia-Artikel', 'Flaggen-Datei', 'Status', 'Bild-URL'],
  ];
  const template = [['Nummer', 'Land_de', 'Land_en', 'Schwierigkeit']];

  // Vorhandenen Report übernehmen, damit bereits geladene Flaggen
  // beim erneuten Lauf ihre Datei-Infos behalten.
  let oldReportRows = new Map();
  try {
    const oldText = await readFile(path.join(TOOLS_DIR, 'report.csv'), 'utf8');
    oldReportRows = new Map(
      parseCsv(oldText)
        .slice(1)
        .filter((r) => r.length >= 6 && r[0])
        .map((r) => [r[0].trim(), r]),
    );
  } catch {
    /* kein alter Report vorhanden */
  }

  const okNumbers = [];
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < total; i++) {
    const country = countries[i];
    const num = i + 1;
    const numStr = String(num).padStart(3, '0');
    const dest = path.join(FLAGS_DIR, `${numStr}.png`);
    const totalStr = String(total).padStart(3, '0');
    process.stdout.write(`[${numStr}/${totalStr}] ${sortName(country)} … `);

    // Bereits vorhandene, gültige Datei überspringen
    if (await isValidImage(dest)) {
      const old = oldReportRows.get(numStr);
      okNumbers.push(num);
      okCount++;
      console.log('bereits vorhanden – übersprungen');
      report.push([
        numStr,
        country.nameDe ?? '',
        country.nameEn ?? '',
        country.article ?? '',
        old?.[4] ?? '',
        'OK (bereits vorhanden)',
        old?.[6] ?? '',
      ]);
      template.push([numStr, country.nameDe ?? '', country.nameEn ?? '', '']);
      continue;
    }

    let status = 'OK';
    let fileName = '';
    let imageUrl = '';
    try {
      if (!country.article) throw new Error('kein Wikipedia-Artikel (Sitelink)');
      try {
        fileName = await flagFromArticle(country.article);
      } catch {
        fileName = await flagFromP41(country.qid);
        status = 'OK (P41-Fallback, bitte prüfen)';
      }
      imageUrl = buildThumbUrl(fileName, THUMB_WIDTHS[0]);
      const bytes = await downloadImage(fileName, dest);
      okNumbers.push(num);
      okCount++;
      console.log(`OK (${(bytes / 1024).toFixed(0)} KB)${status.startsWith('OK (') ? ' – ' + status : ''}`);
    } catch (err) {
      status = `FEHLER: ${err.message}`;
      failCount++;
      console.log(`FEHLER: ${err.message}`);
    }

    report.push([numStr, country.nameDe ?? '', country.nameEn ?? '', country.article ?? '', fileName, status, imageUrl]);
    template.push([numStr, country.nameDe ?? '', country.nameEn ?? '', '']);
    await sleep(REQUEST_DELAY_MS);
  }

  // report.csv
  const reportPath = path.join(TOOLS_DIR, 'report.csv');
  await writeFile(reportPath, report.map(csvLine).join(''), 'utf8');

  // Vorlage für die Schwierigkeits-Einträge
  const templatePath = path.join(PRIVATE_DIR, 'flaggen-vorlage.csv');
  await writeFile(templatePath, template.map(csvLine).join(''), 'utf8');

  // Vorläufiges decks.js: alle erfolgreichen Flaggen in Stufe 2
  const decksPath = path.join(APP_DIR, 'decks.js');
  const decksContent = `// ============================================================
// decks.js – Flaggen-Nummern je Schwierigkeitsstufe.
// Automatisch erzeugt – enthält absichtlich KEINE Ländernamen.
//
// VORLÄUFIGE Version: alle Flaggen in Stufe 2 (mittel).
// Nach dem Ausfüllen der XLSX-/CSV-Liste ersetzen mit:
//   node tools/generate_decks.mjs
// ============================================================
window.DECKS = {
  1: [],
  2: [${okNumbers.join(', ')}],
  3: [],
};
`;
  await writeFile(decksPath, decksContent, 'utf8');

  console.log('');
  console.log('=== Zusammenfassung ===');
  console.log(`Erfolgreich: ${okCount}  |  Fehlgeschlagen: ${failCount}`);
  console.log(`Flaggen:      ${FLAGS_DIR}`);
  console.log(`Report:       ${reportPath}`);
  console.log(`Vorlage:      ${templatePath}`);
  console.log(`Decks:        ${decksPath}`);
  if (failCount > 0) {
    console.log('');
    console.warn('Es gab Fehler – Details stehen im Report (tools/report.csv).');
    console.warn('Fehlende Flaggen bitte manuell ergänzen, bevor es weitergeht.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Abbruch mit Fehler:', err.message);
  process.exitCode = 1;
});
