# Fun with Flags

Kleines Flaggen-Quiz für den Browser – ohne Backend, ohne Texteingabe.
Jede Flagge hat eine eindeutige Nummer; die Zuordnung Nummer → Land
liegt nur in einer privaten Liste außerhalb dieses Repos.

## Struktur

- `app/` – die Web-App (`index.html`, `style.css`, `app.js`, `decks.js`, `flags/`)
- `tools/` – lokale Hilfsskripte (laufen nur auf dem eigenen Rechner)
- `private/` – private Listen (nicht versioniert, siehe `.gitignore`)

## Spielen

`app/index.html` direkt im Browser öffnen oder den Inhalt von `app/`
auf GitHub Pages veröffentlichen. Ablauf:

1. Stufe wählen (Leicht / Mittel / Schwer) und Modus:
   „10 zufällige“ (10 zufällige Flaggen aus der Stufe, blauer Knopf)
   oder „Komplettes Deck“ (alle Flaggen der Stufe)
2. Flagge erscheint mit ihrer Nummer (immer sichtbar)
3. Antwort mündlich nennen, dann „Richtig“ oder „Falsch“ klicken
   (Tastatur: `R` / `F`) → nächste Flagge
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

## Wichtig: Privatsphäre

`private/`, `tools/report.csv` und alle CSV/XLSX-Dateien enthalten die
Zuordnung Nummer → Land und dürfen **niemals** committet oder auf
GitHub Pages veröffentlicht werden (in `.gitignore` ausgeschlossen).
Öffentlich wird ausschließlich der Inhalt von `app/`.
