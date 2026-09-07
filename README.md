# Fun with Flags

Kleines Flaggen-Quiz für den Browser – ohne Backend, ohne Texteingabe.
Pro Flagge stehen 5 Ländernamen zur Auswahl, genau einer ist richtig.

## Struktur

- `app/` – die Web-App (`index.html`, `style.css`, `app.js`, `decks.js`, `choices.js`, `flags/`)
- `tools/` – lokale Hilfsskripte (laufen nur auf dem eigenen Rechner)
- `private/` – Pflege-Listen (nicht versioniert, siehe `.gitignore`)

## Spielen

`app/index.html` direkt im Browser öffnen oder über GitHub Pages
spielen (`.github/workflows/pages.yml` veröffentlicht bei jedem Push
auf `main` den Inhalt von `app/`). Einmalig nötig: in den
Repository-Einstellungen unter **Settings → Pages → Build and
deployment** als Source **„GitHub Actions"** auswählen. Danach ist die
App unter `https://<nutzer>.github.io/fun_with_flags/` erreichbar.

1. Stufe wählen (Leicht / Mittel / Schwer) und Modus:
   „10 zufällige“ (10 zufällige Flaggen aus der Stufe, blauer Knopf)
   oder „Komplettes Deck“ (alle Flaggen der Stufe)
2. Flagge erscheint mit ihrer Nummer (immer sichtbar) und 5 Ländernamen
   in zufälliger Reihenfolge – genau einer ist richtig
3. Name anklicken (Tastatur: `1`–`5`): Die Antwort wird sofort
   markiert – richtig grün, falsch rot; der richtige Name wird immer
   grün angezeigt. „Weiter“ (Tastatur: `Enter` oder `→`) bringt zur
   nächsten Flagge. „Letzte Eingabe korrigieren“ nimmt die Antwort
   zurück.
4. Am Ende erscheint die Zusammenfassung; die Statistik wird getrennt
   nach „Komplettes Deck“ und „10er-Runden“ im Browser gespeichert
   („Statistik zurücksetzen“ löscht sie)

## Stufen pflegen (nur lokal)

1. Flaggen herunterladen (Wikipedia/Wikimedia Commons):
   `node tools/download_flags.mjs`
   → legt `app/flags/NNN.png`, `tools/report.csv` und
   `private/flaggen-vorlage.csv` an.
2. Schwierigkeiten festlegen – zwei Wege:
   - **Automatischer Entwurf:** `node tools/assign_difficulty.mjs`
     (Kriterien: Einwohnerzahl als Bekanntheits-Proxy, Schweiz und
     Nachbarn = leicht, Westafrika = schwer, Middle East = mind. mittel,
     ähnliche Flaggen eine Stufe schwerer). Ergebnis in
     `private/flaggen-vorlage.csv` prüfen und bei Bedarf in
     Excel/LibreOffice korrigieren.
   - Oder von Hand: Spalte „Schwierigkeit“ in
     `private/flaggen-vorlage.csv` ausfüllen (`1`/`2`/`3` oder
     `leicht`/`mittel`/`schwer`).
   Für die eigenen Einstufungen speichern als `private/flaggen.csv`
   – oder als `private/flaggen.xlsx` (dafür einmalig:
   `cd tools && npm install`).
3. Decks erzeugen: `node tools/generate_decks.mjs`
   → schreibt `app/decks.js` (nur Nummern, keine Namen) und prüft,
   dass jede Flagge genau einmal vorkommt.
4. Antwort-Optionen erzeugen: `node tools/generate_choices.mjs`
   → schreibt `app/choices.js` (5 Ländernamen je Nummer, der erste ist
   der richtige). Die 4 Ablenker werden je Flagge so gewählt:
   Namen sehr ähnlicher Flaggen (Pixel-Analyse), für afrikanische,
   südamerikanische und asiatische Länder zusätzlich die Nachbarn
   (Wikidata), Rest zufällig aufgefüllt (deterministisch).
5. Optional prüfen: `node tools/verify_numbering.mjs`
   → lädt für jede Nummer die aktuelle Wikimedia-Flagge des erwarteten
   Landes und vergleicht sie pixelweise mit `app/flags/NNN.png`.
   Ergebnis: `OK` (Distanz < 0.05, ggf. byte-identisch), `prüfen`
   (0.05–0.10, z. B. minimal geändertes Design) oder `Abweichung`
   (≥ 0.10 – falsches Land oder Flagge geändert, vor dem nächsten
   Schritt klären). Laufzeit ca. 10–15 Minuten (Rate-Limit).

## Wichtig: Datenpflege

`app/choices.js` enthält die Ländernamen – bewusst: Sie werden für die
Antwort-Optionen gebraucht und mitveröffentlicht. `private/`,
`tools/report.csv` und alle CSV/XLSX-Dateien sind Arbeitsdaten zur
Pflege der Listen und bleiben unversioniert (`.gitignore`). Änderungen
an Ländern oder Schwierigkeiten immer über die Liste in `private/`
machen und danach beide Dateien neu erzeugen:
`node tools/generate_decks.mjs` und `node tools/generate_choices.mjs`.
