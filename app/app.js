/**
 * app.js – Spiel-Logik für "Fun with Flags".
 * Zeigt je Flagge 5 Ländernamen zur Auswahl (siehe choices.js),
 * genau einer ist richtig. Klick auf einen Namen markiert die Antwort
 * (grün = richtig, rot = falsch); "Weiter" bringt zur nächsten Flagge.
 *
 * Modi:  "Komplettes Deck" (alle Flaggen einer Stufe, gemischt)
 *        "10er-Runde"      (10 zufällige Flaggen einer Stufe)
 */
(() => {
  'use strict';

  const LEVEL_NAMES = { 1: 'Leicht', 2: 'Mittel', 3: 'Schwer' };
  const LEVEL_ORDER = [1, 2, 3];
  const DECKS = window.DECKS || {};
  const CHOICES = window.CHOICES || {};
  const STORAGE_KEY = 'funwithflags.stats.v1';
  const TEN_SIZE = 10;

  // ---------- Elemente ----------
  const views = {
    start: document.getElementById('view-start'),
    quiz: document.getElementById('view-quiz'),
    done: document.getElementById('view-done'),
  };
  const levelButtons = document.getElementById('level-buttons');
  const statsBodyDeck = document.getElementById('stats-body-deck');
  const statsBodyTen = document.getElementById('stats-body-ten');
  const resetStatsBtn = document.getElementById('reset-stats');
  const flagImg = document.getElementById('flag-img');
  const flagNumber = document.getElementById('flag-number');
  const quizLevel = document.getElementById('quiz-level');
  const quizProgress = document.getElementById('quiz-progress');
  const choicesEl = document.getElementById('choices');
  const btnNext = document.getElementById('btn-next');
  const btnQuit = document.getElementById('quit');
  const undoLink = document.getElementById('undo');
  const doneTitle = document.getElementById('done-title');
  const doneSummary = document.getElementById('done-summary');
  const btnAgain = document.getElementById('again');
  const btnBack = document.getElementById('back-to-start');
  const fullscreenBtn = document.getElementById('fullscreen-btn');

  // ---------- Statistik ----------
  function makeEntry() {
    return { played: 0, answered: 0, correct: 0, bestRate: null, bestStreak: 0 };
  }

  function emptyStats() {
    const stats = { deck: {}, ten: {} };
    for (const level of LEVEL_ORDER) {
      stats.deck[level] = makeEntry();
      stats.ten[level] = makeEntry();
    }
    return stats;
  }

  function loadStats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      // Migration alter Schlüssel ("1"/"2"/"3") -> "deck-1"/"deck-2"/"deck-3"
      for (const level of LEVEL_ORDER) {
        if (parsed[String(level)] && !parsed[`deck-${level}`]) {
          parsed[`deck-${level}`] = parsed[String(level)];
          delete parsed[String(level)];
        }
      }
      const stats = emptyStats();
      for (const mode of ['deck', 'ten']) {
        for (const level of LEVEL_ORDER) {
          const s = parsed[`${mode}-${level}`];
          if (!s) continue;
          stats[mode][level] = {
            played: Number(s.played) || 0,
            answered: Number(s.answered) || 0,
            correct: Number(s.correct) || 0,
            bestRate: typeof s.bestRate === 'number' ? s.bestRate : null,
            bestStreak: Number(s.bestStreak) || 0,
          };
        }
      }
      return stats;
    } catch (err) {
      console.warn('Statistik konnte nicht geladen werden:', err);
      return emptyStats();
    }
  }

  function saveStats(stats) {
    try {
      const flat = {};
      for (const mode of ['deck', 'ten']) {
        for (const level of LEVEL_ORDER) {
          flat[`${mode}-${level}`] = stats[mode][level];
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(flat));
    } catch (err) {
      console.warn('Statistik konnte nicht gespeichert werden:', err);
    }
  }

  // ---------- Zustand des laufenden Spiels ----------
  // run: { mode: 'deck'|'ten', level, order: [num...], index,
  //        history: [{num, correct}], streak, bestStreak, answered }
  let run = null;
  let lastStart = null; // { level, mode }

  // ---------- Hilfsfunktionen ----------
  function showView(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
  }

  /** Zur Startseite – Statistik dabei immer aktualisieren. */
  function goToStart() {
    run = null;
    renderStats();
    showView('start');
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pad3(num) {
    return String(num).padStart(3, '0');
  }

  function deckCount(level) {
    return (DECKS[level] || []).length;
  }

  // ---------- Ansichten ----------
  function renderStart() {
    levelButtons.innerHTML = '';
    for (const level of LEVEL_ORDER) {
      const count = deckCount(level);

      const card = document.createElement('div');
      card.className = 'level-card';

      const name = document.createElement('span');
      name.className = 'level-name';
      name.textContent = LEVEL_NAMES[level];

      const countSpan = document.createElement('span');
      countSpan.className = 'level-count';
      countSpan.textContent =
        count === 0 ? 'noch keine Flaggen' : `${count} Flagge${count === 1 ? '' : 'n'}`;

      const actions = document.createElement('div');
      actions.className = 'level-actions';

      const tenBtn = document.createElement('button');
      tenBtn.type = 'button';
      tenBtn.className = 'btn btn-ten';
      const n = Math.min(TEN_SIZE, count);
      tenBtn.textContent = `${n} zufällige`;
      tenBtn.disabled = count === 0;
      tenBtn.addEventListener('click', () => startRun(level, 'ten'));

      const deckBtn = document.createElement('button');
      deckBtn.type = 'button';
      deckBtn.className = 'btn btn-deck';
      deckBtn.textContent = 'Komplettes Deck';
      deckBtn.disabled = count === 0;
      deckBtn.addEventListener('click', () => startRun(level, 'deck'));

      actions.append(tenBtn, deckBtn);
      card.append(name, countSpan, actions);
      levelButtons.appendChild(card);
    }
  }

  function renderStatsGroup(tbody, mode) {
    const stats = loadStats();
    tbody.innerHTML = '';
    for (const level of LEVEL_ORDER) {
      const s = stats[mode][level];
      const rate = s.answered > 0 ? Math.round((s.correct / s.answered) * 100) + ' %' : '–';
      const tr = document.createElement('tr');
      const cells = [
        LEVEL_NAMES[level],
        String(s.played),
        String(s.answered),
        String(s.correct),
        rate,
        String(s.bestStreak),
      ];
      cells.forEach((text, i) => {
        const cell = document.createElement(i === 0 ? 'th' : 'td');
        cell.textContent = text;
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    }
  }

  function renderStats() {
    renderStatsGroup(statsBodyDeck, 'deck');
    renderStatsGroup(statsBodyTen, 'ten');
  }

  function startRun(level, mode) {
    let order = shuffled(DECKS[level] || []);
    if (order.length === 0) return;
    if (mode === 'ten') order = order.slice(0, Math.min(TEN_SIZE, order.length));
    lastStart = { level, mode };
    run = { mode, level, order, index: 0, history: [], streak: 0, bestStreak: 0, answered: false };
    showView('quiz');
    renderQuestion();
  }

  function renderQuestion() {
    const num = run.order[run.index];
    const numStr = pad3(num);
    flagImg.src = `flags/${numStr}.png`;
    flagImg.alt = `Flagge Nr. ${numStr}`;
    flagNumber.textContent = `Nr. ${numStr}`;
    quizLevel.textContent =
      LEVEL_NAMES[run.level] + (run.mode === 'ten' ? ' · 10er-Runde' : ' · komplettes Deck');
    quizProgress.textContent = `${run.index + 1} / ${run.order.length}`;
    undoLink.hidden = run.history.length === 0;
    run.answered = false;
    btnNext.hidden = true;
    renderChoices(num);
  }

  /** Rendert die 5 gemischten Antwort-Buttons für eine Flaggen-Nummer. */
  function renderChoices(num) {
    choicesEl.innerHTML = '';
    const options = CHOICES[num];
    if (!options || options.length === 0) {
      // Defensiv-Fallback: Frage ohne Optionen überspringbar machen
      // (zählt nicht in der Statistik, da kein History-Eintrag entsteht)
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = `Keine Antwort-Optionen für Nr. ${pad3(num)} – bitte choices.js prüfen.`;
      choicesEl.appendChild(note);
      run.answered = true;
      btnNext.hidden = false;
      return;
    }
    const correctName = options[0];
    for (const { name } of shuffled(options.map((name) => ({ name })))) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';
      btn.textContent = name;
      btn.addEventListener('click', () => pickChoice(btn, name, correctName));
      choicesEl.appendChild(btn);
    }
  }

  /** Wählt eine Antwort aus und markiert richtig/falsch. */
  function pickChoice(btn, name, correctName) {
    if (!run || run.answered || run.index >= run.order.length) return;
    run.answered = true;
    const correct = name === correctName;
    run.history.push({ num: run.order[run.index], correct });
    recomputeStreak();
    for (const el of choicesEl.children) {
      el.disabled = true;
      if (el.textContent === correctName) el.classList.add('correct');
      else if (el === btn) el.classList.add('wrong');
    }
    undoLink.hidden = run.history.length === 0;
    btnNext.hidden = false;
    btnNext.focus();
  }

  /** Weiter zur nächsten Frage (oder zur Auswertung). */
  function next() {
    if (!run || run.index >= run.order.length) return;
    run.index++;
    if (run.index >= run.order.length) finishRun();
    else renderQuestion();
  }

  function recomputeStreak() {
    let cur = 0;
    let best = 0;
    for (const entry of run.history) {
      cur = entry.correct ? cur + 1 : 0;
      if (cur > best) best = cur;
    }
    run.streak = cur;
    run.bestStreak = best;
  }

  function undo() {
    if (!run || run.history.length === 0) return;
    // Aktuelle Frage bereits beantwortet -> Antwort zurücknehmen;
    // sonst (auch bei übersprungener Frage) -> zur vorherigen Frage.
    const answeredCurrent = run.history.length === run.index + 1;
    run.history.pop();
    if (!answeredCurrent) run.index--;
    recomputeStreak();
    renderQuestion();
  }

  function finishRun() {
    const total = run.history.length;
    const correct = run.history.filter((entry) => entry.correct).length;
    const rate = total > 0 ? Math.round((correct / total) * 100) : null;

    const stats = loadStats();
    const s = stats[run.mode][run.level];
    s.played += 1;
    s.answered += total;
    s.correct += correct;
    if (rate !== null && (s.bestRate === null || rate > s.bestRate)) s.bestRate = rate;
    if (run.bestStreak > s.bestStreak) s.bestStreak = run.bestStreak;
    saveStats(stats);

    doneTitle.textContent = run.mode === 'ten' ? '10er-Runde geschafft!' : 'Geschafft!';
    let summary = `${LEVEL_NAMES[run.level]}`;
    if (run.mode === 'ten') summary += ' · 10er-Runde';
    summary += `: ${correct} von ${total} richtig`;
    if (rate !== null) summary += ` (${rate} %)`;
    summary += ` – beste Serie: ${run.bestStreak}`;
    doneSummary.textContent = summary;
    showView('done');
  }

  function quitRun() {
    if (!run) return;
    if (run.history.length > 0 && !window.confirm('Lauf wirklich abbrechen? Der Stand geht verloren.')) {
      return;
    }
    goToStart();
  }

  // ---------- Vollbild ----------
  const fullscreenSupported = Boolean(
    document.documentElement?.requestFullscreen ||
      document.documentElement?.webkitRequestFullscreen,
  );

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function syncFullscreenButton() {
    const active = isFullscreen();
    fullscreenBtn.title = active ? 'Vollbild beenden (Esc)' : 'Vollbild aktivieren (Esc beendet)';
    fullscreenBtn.setAttribute('aria-pressed', String(active));
    fullscreenBtn.classList.toggle('active', active);
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      const el = document.documentElement;
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (request) request.call(el).catch(() => {});
    }
  }

  if (fullscreenSupported) {
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFullscreenButton);
    document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
    syncFullscreenButton();
  } else {
    fullscreenBtn.hidden = true;
  }

  // ---------- Ereignisse ----------
  btnNext.addEventListener('click', next);
  undoLink.addEventListener('click', undo);
  btnQuit.addEventListener('click', quitRun);
  btnAgain.addEventListener('click', () => {
    if (lastStart) startRun(lastStart.level, lastStart.mode);
  });
  btnBack.addEventListener('click', goToStart);
  resetStatsBtn.addEventListener('click', () => {
    if (!window.confirm('Gesamte Statistik wirklich zurücksetzen?')) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignorieren */
    }
    renderStats();
  });

  document.addEventListener('keydown', (event) => {
    if (views.quiz.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter' || event.key === 'ArrowRight') {
      if (!btnNext.hidden) {
        event.preventDefault();
        next();
      }
      return;
    }
    const idx = '12345'.indexOf(event.key);
    if (idx < 0 || (run && run.answered)) return;
    const btn = choicesEl.children[idx];
    if (btn && btn.tagName === 'BUTTON') {
      event.preventDefault();
      btn.click();
    }
  });

  // ---------- Start ----------
  renderStart();
  renderStats();
  showView('start');
})();
