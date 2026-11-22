// App shell: bottom tabs, the Practice menu, and screen routing.
import { html, render } from '../vendor/preact-htm.js';
import { useState, useWatch, Sheet } from './ui.js';
import { store, settings } from './store.js';
import { PracticeView, session } from './practice.js';
import { WordDrill, GenderDrill, ConjugationDrill } from './drillsview.js';
import { ReadingView } from './reading.js';
import { ConvoView } from './convo.js';
import { HomeView, ReviewView, SettingsView, ProgressView } from './screens.js';
import { LibraryView } from './library.js';
import { startSync } from './sync.js';
import { stopSpeaking, stopListening, unlockAudio } from './audio.js';

const TABS = [
  ['home', 'Home', '⌂'],
  ['practice', 'Practice', '◉'],
  ['library', 'Library', '▤'],
  ['progress', 'Progress', '▮▯'],
  ['settings', 'Settings', '⚙︎'],
];

export const MODES = [
  ['sentences', 'Flashcards', 'Sentences from your words, spoken and graded', '🗂'],
  ['review', 'Review', 'Mistakes that are due again', '↻'],
  ['words', 'Words', 'Quick single-word recall', 'Aa'],
  ['gender', 'Gender', 'Le or la?', '♂♀'],
  ['conj', 'Verbs', 'Conjugation drills', '✎'],
  ['reading', 'Reading', 'Short texts, tap any word', '❡'],
  ['chat', 'Conversations', 'Chat with a French friend', '💬'],
];

function PracticeScreen({ mode, go, openMenu }) {
  const m = MODES.find((x) => x[0] === mode) || MODES[0];
  const body = {
    sentences: html`<${PracticeView} />`,
    review: html`<${ReviewView} go=${go} />`,
    words: html`<${WordDrill} />`,
    gender: html`<${GenderDrill} />`,
    conj: html`<${ConjugationDrill} />`,
    reading: html`<${ReadingView} />`,
    chat: html`<${ConvoView} />`,
  }[m[0]];
  return html`<div>
    <div class="row between mode-head">
      <h2>${m[1]}</h2>
      <button class="chip-btn" onClick=${openMenu}>Switch ▾</button>
    </div>
    ${body}
  </div>`;
}

function PracticeMenu({ open, onClose, onPick }) {
  useWatch(store, session);
  const due = store.dueMistakeCount;
  return html`<${Sheet} open=${open} onClose=${onClose} title="Practice">
    <div class="menu">
      ${MODES.map(([id, title, sub, icon]) => html`<button class="menu-item" onClick=${() => onPick(id)}>
        <span class="mi-icon">${icon}</span>
        <span class="mi-text"><b>${title}</b><span class="small muted">${id === 'review' && due ? `${due} due now` : id === 'sentences' && session.phase !== 'idle' ? 'Session in progress' : sub}</span></span>
        <span class="muted">›</span>
      </button>`)}
    </div>
  </${Sheet}>`;
}

function App() {
  useWatch(store, session);
  const [tab, setTab] = useState('home');
  const [menu, setMenu] = useState(false);
  const mode = settings.get('practiceMode') || 'sentences';

  const go = (t, m) => {
    unlockAudio();
    if (t !== tab || (m && m !== mode)) { stopListening(); }
    if (m) {
      if (m !== mode) stopSpeaking();
      settings.set('practiceMode', m);
    }
    setTab(t);
    setMenu(false);
    window.scrollTo(0, 0);
  };
  const tapTab = (t) => (t === 'practice' ? setMenu(true) : go(t));
  const due = store.dueMistakeCount;

  return html`<div class="app">
    <main>
      ${tab === 'home' ? html`<${HomeView} go=${go} />`
        : tab === 'practice' ? html`<${PracticeScreen} mode=${mode} go=${go} openMenu=${() => setMenu(true)} />`
        : tab === 'library' ? html`<${LibraryView} />`
        : tab === 'progress' ? html`<${ProgressView} />`
        : html`<${SettingsView} go=${go} />`}
    </main>
    <nav class="tabs">${TABS.map(([id, label, icon]) => html`<button class=${tab === id ? 'on' : ''} onClick=${() => tapTab(id)}>
      <span class="ti">${icon}${id === 'practice' && due ? html`<em>${due > 99 ? '99+' : due}</em>` : null}</span><span>${label}</span></button>`)}
    </nav>
    <${PracticeMenu} open=${menu} onClose=${() => setMenu(false)} onPick=${(m) => go('practice', m)} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
startSync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
