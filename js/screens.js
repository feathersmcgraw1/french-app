// Home, Review and Settings screens.
import { html, useState, useWatch, Bold } from './ui.js';
import { store, settings, level, isLearned } from './store.js';
import { now, toJS, trim } from './util.js';
import { session } from './practice.js';
import { syncState, syncNow, configured, resetSync, passphraseID } from './sync.js';
import { useEffect } from './ui.js';
import { speak, unlockAudio, voiceState, LEVEL_NAMES } from './audio.js';
import { generate } from './gemini.js';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

function SyncBadge() {
  useWatch(syncState);
  if (!configured()) return html`<span class="chip warn-chip">Sync off</span>`;
  const t = { ok: 'Synced', syncing: 'Syncing…', error: 'Sync error', offline: 'Offline', off: 'Sync', empty: 'No data found' }[syncState.status] || 'Sync';
  return html`<button class=${'chip' + (syncState.status === 'error' || syncState.status === 'empty' ? ' warn-chip' : '')} onClick=${syncNow}>${t}</button>`;
}

export function HomeView({ go }) {
  useWatch();
  const goal = settings.get('dailyGoal');
  const today = store.stat();
  const frac = Math.min(today.cards / Math.max(goal, 1), 1);
  const due = store.dueMistakeCount;
  const streak = store.streak(goal);
  const hasKey = !!trim(settings.get('geminiKey'));
  return html`<div class="home">
    <div class="row between">
      <div><h1 class="greet">${greeting()}</h1><p class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      <div class="col-end"><${SyncBadge} /><button class="icon-btn" aria-label="Settings" onClick=${() => go('settings')}>⚙︎</button></div>
    </div>
    ${!hasKey ? html`<div class="card warn-card"><b>Add your Gemini key</b><p class="small">Needed for cards, grading and voices.</p><button class="btn brand" onClick=${() => go('settings')}>Open settings</button></div>` : null}
    ${!configured() ? html`<div class="card warn-card"><b>Connect sync</b><p class="small">To get your vocab and progress from the Mac.</p><button class="btn brand" onClick=${() => go('settings')}>Set up sync</button></div>` : null}
    <div class="hero">
      <p class="hero-label">Today's goal</p>
      <p class="hero-num"><b>${today.cards}</b> of ${goal} cards</p>
      <div class="bar"><i style=${`width:${frac * 100}%`} /></div>
      <p class="small">${today.cards >= goal ? 'Goal reached. Anything more is a bonus.' : `${goal - today.cards} cards to reach today's goal`}</p>
      <button class="btn yellow" onClick=${() => { unlockAudio(); settings.set('practiceMode', 'sentences'); go('practice'); if (session.phase === 'idle') session.start(); }}>${today.cards === 0 ? 'Start session' : 'Keep going'}</button>
    </div>
    <button class=${'card review-block' + (due ? ' due' : '')} onClick=${() => go('review')}>
      <b class="big-num">${due || '✓'}</b><span>${due ? (due === 1 ? 'mistake to review' : 'mistakes to review') : 'No mistakes are due'}</span>
    </button>
    <div class="stats">
      <div><span class="label">Streak</span><b>${streak}</b><span class="small muted">${streak === 1 ? 'day' : 'days'}</span></div>
      <div><span class="label">Accuracy today</span><b>${today.cards ? Math.round((today.correct / today.cards) * 100) + '%' : '-'}</b><span class="small muted">${today.correct} of ${today.cards}</span></div>
      <div><span class="label">Words learned</span><b>${store.learnedCount}</b><span class="small muted">of ${store.vocab.length}</span></div>
      <div><span class="label">Level</span><b>${level()}</b><span class="small muted">${settings.get('levelMode') === 'Auto' ? 'from grammar' : 'set'}</span></div>
    </div>
  </div>`;
}

export function ReviewView({ go }) {
  useWatch();
  const [showAll, setShowAll] = useState(false);
  const t = now();
  const open = store.mistakes.filter((m) => !m.resolved).sort((a, b) => a.due - b.due);
  const due = open.filter((m) => m.due <= t);
  const list = showAll ? open : due;
  const tags = store.tagCounts(true).slice(0, 5);
  const top = Math.max(1, ...tags.map((x) => x.count));
  return html`<div class="review">
    <div class="card hero-lite">
      <b class="big-num">${due.length}</b><span>${due.length === 1 ? 'mistake due now' : 'mistakes due now'}</span>
      <button class="btn brand" disabled=${!due.length} onClick=${() => { unlockAudio(); session.start(true); go('practice'); }}>Start review</button>
      <p class="small muted">Each one comes back after 2 minutes, then 1, 3, 7 and 14 days.</p>
    </div>
    ${tags.length ? html`<div class="card"><h3>What to work on</h3>${tags.map((x) => html`<div class="tagbar"><div class="row between"><span>${x.tag.charAt(0).toUpperCase() + x.tag.slice(1)}</span><b class="small">${x.count}</b></div><div class="bar thin"><i style=${`width:${(x.count / top) * 100}%`} /></div></div>`)}</div>` : null}
    <div class="row between"><h3>${showAll ? 'All open mistakes' : 'Due now'}</h3><button class="link" onClick=${() => setShowAll(!showAll)}>${showAll ? 'Due only' : `All open (${open.length})`}</button></div>
    ${!list.length ? html`<p class="muted">Nothing here.</p>` : null}
    ${list.slice(0, 80).map((m) => html`<div class="card mistake">
      <p class="fr">${m.french}</p>
      <p class="small muted">${m.english}</p>
      ${m.lastAnswer && m.lastAnswer !== '(skipped)' ? html`<p class="small">You: ${m.lastAnswer}</p>` : null}
      ${m.detail ? html`<p class="small warn-text">${m.detail}</p>` : null}
      <div class="row between"><span class="small muted">${m.tags.join(', ')}</span><span class="small muted">${m.due <= t ? 'due' : 'due ' + toJS(m.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div>
      ${m.notes?.length ? html`<details><summary class="small">Tutor notes (${m.notes.length})</summary>${m.notes.map((n) => html`<p class="small"><b>${n.question}</b><br /><${Bold} text=${n.answer} /></p>`)}</details>` : null}
    </div>`)}
  </div>`;
}

const VOICES = ['Kore', 'Aoede', 'Leda', 'Sulafat', 'Achird', 'Puck', 'Charon', 'Zephyr'];

function Field({ label, k, type = 'text', placeholder }) {
  const [v, setV] = useState(settings.get(k));
  return html`<label class="field"><span>${label}</span>
    <input type=${type} value=${v} placeholder=${placeholder || ''} autocapitalize="off" autocorrect="off" spellcheck="false"
      onInput=${(e) => setV(e.target.value)} onBlur=${() => settings.set(k, type === 'number' ? +v : trim(String(v)))} />
  </label>`;
}
function Toggle({ label, k }) {
  useWatch();
  return html`<label class="toggle"><span>${label}</span><input type="checkbox" checked=${settings.get(k)} onChange=${(e) => settings.set(k, e.target.checked)} /></label>`;
}

export function SettingsView({ go }) {
  useWatch(syncState, voiceState);
  const [test, setTest] = useState('');
  const [pid, setPid] = useState('');
  useEffect(() => { passphraseID().then(setPid); }, [settings.get('syncSecret')]);
  async function testKey() {
    setTest('Testing...');
    try { setTest('Response: ' + trim(await generate('Reply with the single word OK.', { temperature: 0, json: false }))); }
    catch (e) { setTest(e.message); }
  }
  function newSecret() {
    // No look-alike characters (l, I, 1, O, 0), so it can be copied by eye onto the Mac.
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = crypto.getRandomValues(new Uint8Array(24));
    const s = [...b].map((x) => abc[x % abc.length]).join('');
    settings.set('syncSecret', s);
  }
  return html`<div class="settings">
    <div class="row between"><button class="link" onClick=${() => go('home')}>‹ Home</button><h2>Settings</h2><span /></div>

    <section class="card"><h3>Gemini</h3>
      <${Field} label="API key" k="geminiKey" type="password" placeholder="Paste key" />
      <${Field} label="Model" k="model" />
      <div class="row gap"><button class="btn soft" onClick=${testKey}>Test connection</button><span class="small muted">${test}</span></div>
      <label class="field"><span>Level</span>
        <select class="select" value=${settings.get('levelMode')} onChange=${(e) => settings.set('levelMode', e.target.value)}>
          ${['Auto', 'A1', 'A2', 'B1', 'B2', 'C1'].map((l) => html`<option value=${l} selected=${settings.get('levelMode') === l}>${l}</option>`)}
        </select></label>
      ${settings.get('levelMode') === 'Auto' ? html`<p class="small muted">Auto follows your ticked grammar. Right now: ${level()}.</p>` : null}
    </section>

    <section class="card"><h3>Voice</h3>
      <${Toggle} label="Hands-free (speak the card, then open the mic)" k="autoVoice" />
      <${Toggle} label="Check my answer when I stop speaking" k="autoCheck" />
      <${Toggle} label="Second try with a hint when almost right" k="secondTry" />
      <${Toggle} label="Listen only (hide the card text)" k="hideText" />
      <${Toggle} label="Sound effects" k="soundEffects" />
      <${Toggle} label="Natural French voice (Gemini)" k="naturalVoice" />
      <label class="field"><span>Voice</span>
        <select class="select" value=${settings.get('ttsVoice')} onChange=${(e) => settings.set('ttsVoice', e.target.value)}>${VOICES.map((v) => html`<option value=${v} selected=${settings.get('ttsVoice') === v}>${v}</option>`)}</select></label>
      <label class="field"><span>Speed: ${LEVEL_NAMES[settings.get('speechLevel')]}</span>
        <input type="range" min="0" max="3" step="1" value=${settings.get('speechLevel')} onInput=${(e) => settings.set('speechLevel', +e.target.value)} /></label>
      <${Field} label="TTS model" k="ttsModel" />
      <button class="btn soft" onClick=${() => { unlockAudio(); speak("Bonjour ! Comment ça va aujourd'hui ? Moi, ça va très bien.", 'fr-FR', { force: true }); }}>▶ Play sample</button>
      ${voiceState.notice ? html`<p class="small warn-text">${voiceState.notice}</p>` : null}
      <${Field} label="Daily goal (cards)" k="dailyGoal" type="number" />
    </section>

    <section class="card"><h3>Sync with your Mac</h3>
      <p class="small muted">Use the same three values here and in the Mac app's Settings.</p>
      <${Field} label="Supabase project URL" k="syncURL" placeholder="https://xxxx.supabase.co" />
      <${Field} label="Supabase anon key" k="syncKey" />
      <${Field} label="Sync passphrase (16+ characters)" k="syncSecret" key=${settings.get('syncSecret')} />
      ${!settings.get('syncSecret') ? html`<button class="link" onClick=${newSecret}>Generate a passphrase</button>` : null}
      <div class="row gap"><button class="btn brand" disabled=${!configured()} onClick=${() => { resetSync(); syncNow(); }}>Sync now</button>
        <span class="small muted">${syncState.message || (syncState.last ? 'Last synced ' + syncState.last.toLocaleTimeString() : '')}</span></div>
      ${pid ? html`<p class="small muted">Passphrase ID: <b>${pid}</b> (must match the Mac's)</p>` : null}
      <p class="small muted">${store.vocab.length} words, ${store.vocab.filter(isLearned).length} learned, ${store.mistakes.length} logged mistakes on this phone.</p>
    </section>
  </div>`;
}
