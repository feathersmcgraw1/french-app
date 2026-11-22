// App shell: bottom tabs and screen routing.
import { html, render } from '../vendor/preact-htm.js';
import { useState, useWatch, Segmented } from './ui.js';
import { store, settings } from './store.js';
import { PracticeView, session } from './practice.js';
import { WordDrill, GenderDrill, ConjugationDrill } from './drillsview.js';
import { ReadingView } from './reading.js';
import { ConvoView } from './convo.js';
import { HomeView, ReviewView, SettingsView } from './screens.js';
import { startSync } from './sync.js';
import { stopSpeaking, stopListening } from './audio.js';

const TABS = [
  ['home', 'Home', '⌂'],
  ['practice', 'Practice', '◉'],
  ['review', 'Review', '↻'],
  ['reading', 'Read', '❡'],
  ['chat', 'Chat', '💬'],
];

function PracticeHub() {
  useWatch();
  const mode = settings.get('practiceMode') || 'sentences';
  return html`<div>
    <${Segmented} value=${mode} onChange=${(m) => { stopSpeaking(); stopListening(); settings.set('practiceMode', m); }}
      options=${[['sentences', 'Sentences'], ['words', 'Words'], ['gender', 'Gender'], ['conj', 'Verbs']]} />
    <div class="pad-top">
      ${mode === 'sentences' ? html`<${PracticeView} />` : mode === 'words' ? html`<${WordDrill} />` : mode === 'gender' ? html`<${GenderDrill} />` : html`<${ConjugationDrill} />`}
    </div>
  </div>`;
}

function App() {
  useWatch(store, session);
  const [tab, setTab] = useState('home');
  const go = (t) => {
    if (t !== tab) { stopListening(); }
    if (t === 'practice' && (session.phase !== 'idle' || session.reviewOnly)) settings.set('practiceMode', 'sentences');
    setTab(t);
    window.scrollTo(0, 0);
  };
  const due = store.dueMistakeCount;
  return html`<div class="app">
    <main>
      ${tab === 'home' ? html`<${HomeView} go=${go} />`
        : tab === 'practice' ? html`<${PracticeHub} />`
        : tab === 'review' ? html`<${ReviewView} go=${go} />`
        : tab === 'reading' ? html`<${ReadingView} />`
        : tab === 'chat' ? html`<${ConvoView} />`
        : html`<${SettingsView} go=${go} />`}
    </main>
    <nav class="tabs">${TABS.map(([id, label, icon]) => html`<button class=${tab === id ? 'on' : ''} onClick=${() => go(id)}>
      <span class="ti">${icon}${id === 'review' && due ? html`<em>${due > 99 ? '99+' : due}</em>` : null}</span><span>${label}</span></button>`)}
    </nav>
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
startSync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
