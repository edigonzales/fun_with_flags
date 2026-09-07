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
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const FLAGS_DIR = path.join(APP_DIR, 'flags');
const TOOLS_DIR = path.join(ROOT, 'tools');
const PRIVATE_DIR = path.join(ROOT, 'private');

// Erlaubte Thumbnail-Breiten von Wikimedia (siehe w.wiki/GHai)
const THUMB_WIDTHS = [960, 500, 330];
const REQUEST_DELAY_MS = 700;
const USER_AGENT = 'FunWithFlags/1.0 (privates Lernspiel; lokaler Download)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, label, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 30;
        console.log(`   (HTTP 429 – warte ${retryAfter} s)`);
        await sleep(Math.min(retryAfter, 60) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

/**
 * Aktuelle UN-Mitglieder + Vatikan + Palästina.
 * Dänemark (Q35) und Niederlande (Q55) sind in Wikidata über ihre
 * "Königreich"-Entitäten UN-Mitglied; daher explizit ergänzen und die
 * Königreich-Entitäten ausschließen. Taiwan (Q865) und die
 * Periodisierungs-Entität "Third Hellenic Republic" (Q17765809) sind
 * keine aktuellen UN-Mitglieder.
 */
const SPARQL_QUERY = `
SELECT ?country ?countryLabel ?countryLabel_en ?article WHERE {
  { ?country wdt:P463 wd:Q1065. }
  UNION
  { VALUES ?country { wd:Q237 wd:Q219060 wd:Q35 wd:Q55 } }
  FILTER NOT EXISTS { ?country wdt:P576 ?end. }
  FILTER(?country NOT IN (wd:Q865, wd:Q17765809, wd:Q756617, wd:Q29999))
  OPTIONAL { ?article schema:about ?country; schema:isPartOf <https://en.wikipedia.org/>. }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "de".
    ?country rdfs:label ?countryLabel.
  }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
    ?country rdfs:label ?countryLabel_en.
  }
}`;

async function loadCountries() {
  const url =
    'https://query.wikidata.org/sparql?' +
    new URLSearchParams({ query: SPARQL_QUERY, format: 'json' });
  console.log('Frage Wikidata nach UN-Mitgliedern, Vatikan und Palästina …');
  const data = await fetchJson(url, 'Wikidata-SPARQL');
  const seen = new Set();
  const countries = [];
  for (const b of data.results.bindings) {
    const qid = b.country.value.split('/').pop();
    if (seen.has(qid)) continue;
    seen.add(qid);
    const articleRaw = b.article?.value ?? '';
    countries.push({
      qid,
      nameDe: b.countryLabel?.value ?? null,
      nameEn: b.countryLabel_en?.value ?? null,
      article: articleRaw ? decodeURIComponent(articleRaw.split('/').pop()) : null,
    });
  }
  return countries;
}

/** Flaggen-Dateiname aus dem Infobox-Parameter image_flag des Artikels. */
async function flagFromArticle(articleTitle) {
  const url =
    'https://en.wikipedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'parse',
      page: articleTitle,
      section: '0',
      prop: 'wikitext',
      redirects: '1',
      format: 'json',
      formatversion: '2',
    });
  const data = await fetchJson(url, `Wikipedia-Artikel (${articleTitle})`);
  const wikitext = data?.parse?.wikitext ?? '';
  if (!wikitext) throw new Error('Artikelinhalt leer');
  const m = wikitext.match(/\|\s*(?:image_flag|flag_image)\s*=\s*([^\n]*)/);
  if (!m) throw new Error('image_flag nicht gefunden');
  let value = m[1].trim();
  value = value.replace(/^\[\[(?:File|Datei|Image):/i, '');
  value = value.replace(/^(?:File|Datei|Image):/i, '');
  value = value.split(/[|<\]]/)[0].trim();
  value = value.replace(/\s+/g, ' ');
  if (!value || value.includes('{{')) throw new Error('image_flag unbrauchbar');
  return value;
}

/** Fallback: Wikidata-Eigenschaft P41 (kann historische Flaggen liefern). */
async function flagFromP41(qid) {
  const url =
    'https://query.wikidata.org/sparql?' +
    new URLSearchParams({
      format: 'json',
      query: `SELECT ?flag WHERE { wd:${qid} wdt:P41 ?flag. }`,
    });
  const data = await fetchJson(url, `Wikidata P41 (${qid})`);
  const first = data?.results?.bindings?.[0];
  if (!first) throw new Error('keine P41-Flagge gefunden');
  return decodeURIComponent(first.flag.value.split('/').pop() ?? '');
}

/** Thumbnail-URL nach Wikimedia-Schema direkt bauen (ohne API-Aufruf). */
function buildThumbUrl(fileName, width) {
  const base = fileName.replace(/ /g, '_');
  const hash = createHash('md5').update(base, 'utf8').digest('hex');
  const enc = encodeURIComponent(base).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return (
    `https://upload.wikimedia.org/wikipedia/commons/thumb/${hash[0]}/${hash.slice(0, 2)}/` +
    `${enc}/${width}px-${enc}.png`
  );
}

/**
 * Thumbnail herunterladen. Versucht der Reihe nach:
 * direkte Commons-URL (960/500/330 px), dann enwiki-API imageinfo
 * (für Dateien, die nur lokal auf en.wikipedia.org liegen).
 */
async function downloadImage(fileName, destPath) {
  const attempts = [];
  for (const width of THUMB_WIDTHS) attempts.push({ kind: 'commons', url: buildThumbUrl(fileName, width) });

  for (const attempt of attempts) {
    const res = await fetch(attempt.url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? '';
      const buf = Buffer.from(await res.arrayBuffer());
      const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
      if ((isPng || isJpeg) && buf.length > 200) {
        await writeFile(destPath, buf);
        return buf.length;
      }
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // Fallback: enwiki-API (kennt lokale und Commons-Dateien)
  const url =
    'https://en.wikipedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      titles: `File:${fileName}`,
      prop: 'imageinfo',
      iiprop: 'url',
      iiurlwidth: String(THUMB_WIDTHS[0]),
      format: 'json',
      formatversion: '2',
    });
  const data = await fetchJson(url, `enwiki imageinfo (${fileName})`);
  const page = data?.query?.pages?.[0];
  // Hinweis: Für Redirects auf Commons-Dateien liefert die API
  // missing=true UND gültige imageinfo – daher imageinfo zuerst prüfen.
  const ii = page?.imageinfo?.[0];
  if (!ii || (!ii.thumburl && !ii.url)) throw new Error('Datei nirgends gefunden');
  const res = await fetch(ii.thumburl || ii.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return buf.length;
}

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
