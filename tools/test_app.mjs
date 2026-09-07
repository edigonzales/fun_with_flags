/**
 * test_app.mjs – Wegwerf-Test für app/app.js mit minimalem DOM-Stub.
 * Verwendung:  node tools/test_app.mjs
 * (kann gefahrlos gelöscht werden; prüft nur die Spiel-Logik)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeEl(id) {
  const el = {
    id: id ?? '',
    hidden: false,
    textContent: '',
    src: '',
    alt: '',
    className: '',
    disabled: false,
    children: [],
    listeners: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(n) {
      this.children.push(n);
      return n;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    click() {
      for (const fn of this.listeners.click ?? []) fn();
    },
    setAttribute(name, value) {
      this[`attr:${name}`] = value;
    },
    classList: {
      _set: new Set(),
      toggle(name, force) {
        const want = force === undefined ? !this._set.has(name) : Boolean(force);
        if (want) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
  };
  // innerHTML = '' muss wie im DOM die Kinder leeren
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._html ?? '';
    },
    set(v) {
      el._html = v;
      el.children = [];
    },
  });
  return el;
}

const ids = [
  'view-start', 'view-quiz', 'view-done', 'level-buttons',
  'stats-body-deck', 'stats-body-ten', 'reset-stats', 'flag-img',
  'flag-number', 'quiz-level', 'quiz-progress', 'btn-right',
  'btn-wrong', 'quit', 'undo', 'done-title', 'done-summary',
  'again', 'back-to-start', 'fullscreen-btn',
];
const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));

globalThis.document = {
  getElementById: (id) => els[id],
  createElement: () => makeEl(),
  addEventListener: () => {},
  documentElement: { requestFullscreen: () => Promise.resolve() },
};
globalThis.window = {
  DECKS: {
    1: Array.from({ length: 65 }, (_, i) => i + 1),
    2: [],
    3: [100, 101, 102],
  },
  confirm: () => true,
};
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = v;
  },
  removeItem: (k) => {
    delete store[k];
  },
};

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FEHLER:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
};

// Alte Statistik vorbelegen, um Migration zu testen
store['funwithflags.stats.v1'] = JSON.stringify({
  1: { played: 2, answered: 40, correct: 30, bestRate: 75, bestStreak: 8 },
});

eval(readFileSync(path.join(ROOT, 'app', 'app.js'), 'utf8'));

const cards = els['level-buttons'].children;
assert(cards.length === 3, 'drei Stufen-Karten gerendert');

const [c1, c2, c3] = cards;
assert(c1.children.length === 3, 'Karte hat Name, Anzahl, Aktionen');
const a1 = c1.children[2].children;
const a2 = c2.children[2].children;
const a3 = c3.children[2].children;
assert(a1.length === 2 && a1[0].textContent === '10 zufällige', 'Karte 1: 10er-Knopf (primär, oben)');
assert(a1[1].textContent === 'Komplettes Deck', 'Karte 1: Deck-Knopf (sekundär)');
assert(a2[0].disabled && a2[1].disabled, 'Karte 2 (leer): beide Knöpfe deaktiviert');
assert(a3[0].textContent === '3 zufällige', 'Karte 3 (3 Flaggen): "3 zufällige"');

// 10er-Runde Stufe 1 starten
a1[0].click();
assert(els['view-quiz'].hidden === false, 'Quiz-Ansicht sichtbar nach 10er-Start');
assert(els['quiz-progress'].textContent === '1 / 10', 'Fortschritt "1 / 10"');
assert(els['quiz-level'].textContent === 'Leicht · 10er-Runde', 'Kopfzeile zeigt "Leicht · 10er-Runde"');
assert(/flags\/\d{3}\.png/.test(els['flag-img'].src), 'Flaggen-Pfad gesetzt: ' + els['flag-img'].src);
assert(/^Nr\. \d{3}$/.test(els['flag-number'].textContent), 'Nummer angezeigt: ' + els['flag-number'].textContent);

// 10-mal "Richtig" klicken
for (let i = 0; i < 9; i++) els['btn-right'].click();
assert(els['quiz-progress'].textContent === '10 / 10', 'Fortschritt "10 / 10" vor letzter Antwort');
els['btn-right'].click();
assert(els['view-done'].hidden === false, 'Ergebnis-Ansicht sichtbar');
assert(els['done-title'].textContent === '10er-Runde geschafft!', 'Titel "10er-Runde geschafft!"');
assert(/Leicht · 10er-Runde: 10 von 10 richtig \(100 %\)/.test(els['done-summary'].textContent), 'Auswertung: ' + els['done-summary'].textContent);

const stats = JSON.parse(store['funwithflags.stats.v1']);
assert(stats['ten-1'].played === 1 && stats['ten-1'].answered === 10 && stats['ten-1'].correct === 10, '10er-Statistik gezählt');
assert(stats['deck-1'].played === 2 && stats['deck-1'].correct === 30, 'alte Statistik nach deck-1 migriert');
assert(!('1' in stats), 'alter Schlüssel "1" entfernt');

// Zurück zur Auswahl: Statistik-Tabelle muss den aktuellen Stand zeigen
els['back-to-start'].click();
const tenRows = els['stats-body-ten'].children;
const deckRows = els['stats-body-deck'].children;
assert(tenRows.length === 3 && deckRows.length === 3, 'Statistik-Tabellen mit je 3 Zeilen gerendert');
assert(tenRows[0].children[1].textContent === '1', '10er-Tabelle Leicht: Spiele = 1');
assert(tenRows[0].children[2].textContent === '10', '10er-Tabelle Leicht: Antworten = 10');
assert(tenRows[0].children[3].textContent === '10', '10er-Tabelle Leicht: Richtig = 10');
assert(tenRows[0].children[4].textContent === '100 %', '10er-Tabelle Leicht: Quote = 100 %');
assert(tenRows[0].children[5].textContent === '10', '10er-Tabelle Leicht: beste Serie = 10');
assert(deckRows[0].children[1].textContent === '2', 'Deck-Tabelle Leicht: Spiele = 2 (migriert)');
assert(deckRows[0].children[4].textContent === '75 %', 'Deck-Tabelle Leicht: Quote = 75 % (migriert)');

// "Nochmal" startet neue 10er-Runde
els['again'].click();
assert(els['quiz-progress'].textContent === '1 / 10', '"Nochmal" startet neue 10er-Runde');

// Komplettes Deck Stufe 1
els['back-to-start'].click();
a1[1].click();
assert(els['quiz-progress'].textContent === '1 / 65', 'Deck-Modus: Fortschritt "1 / 65"');
assert(els['quiz-level'].textContent === 'Leicht · komplettes Deck', 'Kopfzeile zeigt "komplettes Deck"');

// Vollbild-Knopf: sichtbar, initial inaktiv, Klick wirft keinen Fehler
const fsBtn = els['fullscreen-btn'];
assert(fsBtn.hidden === false, 'Vollbild-Knopf sichtbar (API vorhanden)');
assert(fsBtn['attr:aria-pressed'] === 'false', 'Vollbild-Knopf initial nicht aktiv');
fsBtn.click();
assert(fsBtn['attr:aria-pressed'] === 'false', 'nach Klick (Stub) weiterhin konsistent');

// Korrektur-Link (undo)
els['btn-wrong'].click();
assert(els['quiz-progress'].textContent === '2 / 65', 'nach Falsch: weiter zu 2 / 65');
els['undo'].click();
assert(els['quiz-progress'].textContent === '1 / 65', 'undo: zurück zu 1 / 65');

console.log('\nAlle Tests abgeschlossen.');
