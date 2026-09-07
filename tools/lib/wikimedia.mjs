/**
 * lib/wikimedia.mjs
 * ------------------
 * Gemeinsame Wikidata-/Wikimedia-Helfer:
 *   - Länderliste (UN-Mitglieder + Vatikan/Palästina/Dänemark/Niederlande)
 *     mit deutschen und englischen Labels und en.wikipedia-Sitelink
 *   - Aktuelle Flaggen-Datei je Land (Infobox image_flag, Fallback P41)
 *   - Thumbnail-URL-Bau und Download von Wikimedia
 * Wird von download_flags.mjs und verify_numbering.mjs genutzt.
 */

import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Erlaubte Thumbnail-Breiten von Wikimedia (siehe w.wiki/GHai)
export const THUMB_WIDTHS = [960, 500, 330];
export const REQUEST_DELAY_MS = 700;
export const USER_AGENT = 'FunWithFlags/1.0 (privates Lernspiel; lokaler Download)';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url, label, attempts = 5) {
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
export const SPARQL_QUERY = `
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

export async function loadCountries() {
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
export async function flagFromArticle(articleTitle) {
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
export async function flagFromP41(qid) {
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
export function buildThumbUrl(fileName, width) {
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
 * Rückgabe: { data: Buffer, from: 'commons'|'enwiki' } oder null,
 * wenn nichts Brauchbares gefunden wurde.
 */
export async function fetchThumbnail(fileName) {
  for (const width of THUMB_WIDTHS) {
    const res = await fetch(buildThumbUrl(fileName, width), {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? '';
      const buf = Buffer.from(await res.arrayBuffer());
      const isPng =
        buf.length > 8 &&
        buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
      if ((isPng || isJpeg) && buf.length > 200) {
        return { data: buf, from: 'commons', width };
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
  if (!ii || (!ii.thumburl && !ii.url)) return null;
  const res = await fetch(ii.thumburl || ii.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), from: 'enwiki', width: THUMB_WIDTHS[0] };
}

/**
 * Thumbnail herunterladen und als Datei speichern (wie in
 * download_flags.mjs verwendet).
 * Rückgabe: Anzahl Bytes.
 */
export async function downloadImage(fileName, destPath) {
  const result = await fetchThumbnail(fileName);
  if (!result) throw new Error('Datei nirgends gefunden');
  await writeFile(destPath, result.data);
  return result.data.length;
}
