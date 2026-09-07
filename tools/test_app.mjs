/**
 * test_app.mjs – Wegwerf-Test für app/app.js mit minimalem DOM-Stub.
 * Verwendung:  node tools/test_app.mjs
 * (kann gefahrlos gelöscht werden; prüft nur die Spiel-Logik)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeEl(id, tag = 'BUTTON') {
  const el = {
    id: id ?? '',
    tagName: String(tag ?? 'BUTTON').toUpperCase(),
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
    focus() {},
    setAttribute(name, value) {
      this[`attr:${name}`] = value;
    },
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
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
  'flag-number', 'quiz-level', 'quiz-progress', 'choices',
  'btn-next', 'quit', 'undo', 'done-title', 'done-summary',
  'again', 'back-to-start', 'fullscreen-btn',
];
const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));

globalThis.document = {
  getElementById: (id) => els[id],
  createElement: (tag) => makeEl(undefined, tag),
  addEventListener: () => {},
  documentElement: { requestFullscreen: () => Promise.resolve() },
};

// Antwort-Optionen je Nummer: erster Name ist der richtige.
const CHOICES_STUB = {};
for (let n = 1; n <= 200; n++) {
  CHOICES_STUB[n] = [
    `Land ${String(n).padStart(3, '0')}`,
    `Option A-${n}`,
    `Option B-${n}`,
    `Option C-${n}`,
    `Option D-${n}`,
  ];
}
delete CHOICES_STUB[102]; // fehlt absichtlich (Fallback-Test, Stufe 3)

globalThis.window = {
  DECKS: {
    1: Array.from({ length: 65 }, (_, i) => i + 1),
    2: [],
    3: [100, 101, 102],
  },
  CHOICES: CHOICES_STUB,
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

// ---------- Hilfen für die Tests ----------
function currentNum() {
  const m = /^Nr\. (\d{3})$/.exec(els['flag-number'].textContent);
  return m ? parseInt(m[1], 10) : -1;
}

function choiceButtons() {
  return els['choices'].children.filter((c) => c.tagName === 'BUTTON');
}

function clickChoice(wantCorrect) {
  const correct = CHOICES_STUB[currentNum()][0];
  const btns = choiceButtons();
  const target = wantCorrect
    ? btns.find((b) => b.textContent === correct)
    : btns.find((b) => b.textContent !== correct);
  assert(Boolean(target), `Antwort-Button gefunden (richtig=${wantCorrect})`);
  target.click();
  return target;
}

// ---------- Startseite ----------
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

// ---------- 10er-Runde Stufe 1 ----------
a1[0].click();
assert(els['view-quiz'].hidden === false, 'Quiz-Ansicht sichtbar nach 10er-Start');
assert(els['quiz-progress'].textContent === '1 / 10', 'Fortschritt "1 / 10"');
assert(els['quiz-level'].textContent === 'Leicht · 10er-Runde', 'Kopfzeile zeigt "Leicht · 10er-Runde"');
assert(/flags\/\d{3}\.png/.test(els['flag-img'].src), 'Flaggen-Pfad gesetzt: ' + els['flag-img'].src);
assert(/^Nr\. \d{3}$/.test(els['flag-number'].textContent), 'Nummer angezeigt: ' + els['flag-number'].textContent);

const btns = choiceButtons();
assert(btns.length === 5, 'fünf Antwort-Buttons gerendert');
const correctName = CHOICES_STUB[currentNum()][0];
assert(btns.filter((b) => b.textContent === correctName).length === 1, 'genau eine richtige Option');
assert(new Set(btns.map((b) => b.textContent)).size === 5, 'alle fünf Namen verschieden');
assert(els['btn-next'].hidden === true, '"Weiter" zunächst versteckt');

// Falsch antworten: Feedback erscheint, aber es geht nicht automatisch weiter
const wrongBtn = clickChoice(false);
assert(els['quiz-progress'].textContent === '1 / 10', 'Fortschritt bleibt nach Antwort bei 1 / 10');
assert(wrongBtn.classList.contains('wrong'), 'falsche Wahl rot markiert');
const correctBtn = btns.find((b) => b.textContent === correctName);
assert(correctBtn.classList.contains('correct'), 'richtiger Name grün markiert');
assert(btns.every((b) => b.disabled), 'alle Buttons nach Antwort deaktiviert');
assert(els['btn-next'].hidden === false, '"Weiter" sichtbar nach Antwort');
assert(els['undo'].hidden === false, 'Korrektur-Link sichtbar nach Antwort');

// Zweiter Klick nach der Antwort ändert nichts
correctBtn.click();
assert(els['quiz-progress'].textContent === '1 / 10', 'zweiter Klick wird ignoriert');

// "Weiter" bringt zur nächsten Frage
els['btn-next'].click();
assert(els['quiz-progress'].textContent === '2 / 10', 'nach "Weiter": 2 / 10');
assert(els['btn-next'].hidden === true, '"Weiter" wieder versteckt');
const btns2 = choiceButtons();
assert(btns2.every((b) => !b.disabled), 'Buttons der neuen Frage aktiv');
assert(btns2.every((b) => !b.classList.contains('correct') && !b.classList.contains('wrong')), 'neue Frage ohne Markierung');

// Richtig antworten und weiter
clickChoice(true);
els['btn-next'].click();
assert(els['quiz-progress'].textContent === '3 / 10', 'nach 2 Antworten: 3 / 10');

// Restliche 8 Fragen richtig beantworten
for (let i = 0; i < 8; i++) {
  clickChoice(true);
  els['btn-next'].click();
}
assert(els['view-done'].hidden === false, 'Ergebnis-Ansicht sichtbar');
assert(els['done-title'].textContent === '10er-Runde geschafft!', 'Titel "10er-Runde geschafft!"');
assert(/Leicht · 10er-Runde: 9 von 10 richtig \(90 %\)/.test(els['done-summary'].textContent), 'Auswertung: ' + els['done-summary'].textContent);
assert(/beste Serie: 9/.test(els['done-summary'].textContent), 'beste Serie: 9');

const stats = JSON.parse(store['funwithflags.stats.v1']);
assert(stats['ten-1'].played === 1 && stats['ten-1'].answered === 10 && stats['ten-1'].correct === 9, '10er-Statistik gezählt (9 richtig)');
assert(stats['deck-1'].played === 2 && stats['deck-1'].correct === 30, 'alte Statistik nach deck-1 migriert');
assert(!('1' in stats), 'alter Schlüssel "1" entfernt');

// Zurück zur Auswahl: Statistik-Tabelle muss den aktuellen Stand zeigen
els['back-to-start'].click();
const tenRows = els['stats-body-ten'].children;
const deckRows = els['stats-body-deck'].children;
assert(tenRows.length === 3 && deckRows.length === 3, 'Statistik-Tabellen mit je 3 Zeilen gerendert');
assert(tenRows[0].children[1].textContent === '1', '10er-Tabelle Leicht: Spiele = 1');
assert(tenRows[0].children[2].textContent === '10', '10er-Tabelle Leicht: Antworten = 10');
assert(tenRows[0].children[3].textContent === '9', '10er-Tabelle Leicht: Richtig = 9');
assert(tenRows[0].children[4].textContent === '90 %', '10er-Tabelle Leicht: Quote = 90 %');
assert(tenRows[0].children[5].textContent === '9', '10er-Tabelle Leicht: beste Serie = 9');
assert(deckRows[0].children[1].textContent === '2', 'Deck-Tabelle Leicht: Spiele = 2 (migriert)');
assert(deckRows[0].children[4].textContent === '75 %', 'Deck-Tabelle Leicht: Quote = 75 % (migriert)');

// "Nochmal" startet neue 10er-Runde
els['again'].click();
assert(els['quiz-progress'].textContent === '1 / 10', '"Nochmal" startet neue 10er-Runde');

// ---------- Komplettes Deck Stufe 1 + Korrektur (undo) ----------
els['back-to-start'].click();
a1[1].click();
assert(els['quiz-progress'].textContent === '1 / 65', 'Deck-Modus: Fortschritt "1 / 65"');
assert(els['quiz-level'].textContent === 'Leicht · komplettes Deck', 'Kopfzeile zeigt "komplettes Deck"');

clickChoice(false);
assert(els['btn-next'].hidden === false, 'Deck: "Weiter" nach Antwort sichtbar');
els['undo'].click();
assert(els['quiz-progress'].textContent === '1 / 65', 'undo: Frage wieder offen bei 1 / 65');
const btnsU = choiceButtons();
assert(btnsU.every((b) => !b.disabled && !b.classList.contains('correct') && !b.classList.contains('wrong')), 'undo: Buttons aktiv und ohne Markierung');
assert(els['btn-next'].hidden === true, 'undo: "Weiter" wieder versteckt');
clickChoice(true);
els['btn-next'].click();
assert(els['quiz-progress'].textContent === '2 / 65', 'nach Korrektur weiter zu 2 / 65');

// ---------- Fallback: Nummer ohne Optionen (102) ----------
els['back-to-start'].click();
a3[0].click();
assert(els['quiz-progress'].textContent === '1 / 3', '3er-Runde gestartet');
for (let q = 1; q <= 3; q++) {
  if (currentNum() === 102) {
    const kids = els['choices'].children;
    assert(kids.length === 1 && kids[0].tagName === 'P', 'Fallback: Hinweistext statt Buttons');
    assert(els['btn-next'].hidden === false, 'Fallback: "Weiter" sofort sichtbar');
    els['btn-next'].click();
  } else {
    clickChoice(true);
    els['btn-next'].click();
  }
}
assert(els['view-done'].hidden === false, 'Fallback-Runde endet normal');
const stats3 = JSON.parse(store['funwithflags.stats.v1']);
assert(stats3['ten-3'].played === 1 && stats3['ten-3'].answered === 2 && stats3['ten-3'].correct === 2, 'Fallback-Frage nicht mitgezählt');

// ---------- Vollbild-Knopf ----------
const fsBtn = els['fullscreen-btn'];
assert(fsBtn.hidden === false, 'Vollbild-Knopf sichtbar (API vorhanden)');
assert(fsBtn['attr:aria-pressed'] === 'false', 'Vollbild-Knopf initial nicht aktiv');
fsBtn.click();
assert(fsBtn['attr:aria-pressed'] === 'false', 'nach Klick (Stub) weiterhin konsistent');

console.log('\nAlle Tests abgeschlossen.');
