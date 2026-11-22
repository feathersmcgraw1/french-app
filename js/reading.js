// Reading: generated texts with tap-to-define words, and the shared word lookup sheet.
import { html, useState, useEffect, useWatch, Sheet, TapText, Spinner, SpeakerButton } from './ui.js';
import { store } from './store.js';
import { makeText, translateWord } from './gemini.js';
import { speak, stopSpeaking, unlockAudio } from './audio.js';
import { uuid, now, trim, relTime } from './util.js';

const clean = (w) => w.replace(/^[«"“(\[]+|[»"”)\].,;:!?…]+$/g, '').replace(/^[«"“(]+/, '');

export function LookupSheet({ word, passage, onClose }) {
  useWatch();
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [added, setAdded] = useState(false);
  const w = word ? clean(word) : '';
  useEffect(() => {
    if (!w) return;
    setR(null); setErr(null); setAdded(false);
    translateWord(w, passage).then(setR).catch((e) => setErr(e.message));
  }, [word]);
  const inVocab = r && store.inVocab(r.lemma);
  return html`<${Sheet} open=${!!word} onClose=${onClose} title=${w}>
    ${!r && !err ? html`<${Spinner} text="Looking it up..." />` : null}
    ${err ? html`<p class="error">${err}</p>` : null}
    ${r ? html`
      <div class="row between"><p class="lemma">${r.lemma}</p><${SpeakerButton} text=${r.lemma} /></div>
      <p class="meaning">${r.english}</p>
      ${trim(r.note) ? html`<p class="small muted">${r.note}</p>` : null}
      ${inVocab || added
        ? html`<p class="small good-text">${added ? 'Added to your vocab.' : 'Already in your vocab.'}</p>`
        : html`<button class="btn brand" onClick=${() => { store.addPairs([{ french: r.lemma, english: r.english }]); setAdded(true); }}>Add to vocab</button>`}
    ` : null}
  </${Sheet}>`;
}

export function ReadingView() {
  useWatch();
  const [topic, setTopic] = useState('');
  const [text, setText] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [english, setEnglish] = useState(false);
  const [revealed, setRevealed] = useState(new Set());
  const [lookup, setLookup] = useState(null);
  const [showSaved, setShowSaved] = useState(false);
  const saved = text && store.readings.some((r) => r.french === text.french);

  async function generate() {
    setLoading(true); setErr(null);
    try {
      const t = await makeText(topic);
      setText(t); setEnglish(false); setRevealed(new Set());
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }
  function save() {
    if (!text || saved) return;
    const r = { id: uuid(), date: now(), title: text.title, french: text.french, english: text.english };
    if (text.questions) r.questions = text.questions;
    store.readings.unshift(r);
    store.save('readings');
  }
  function open(r) { stopSpeaking(); setText(r); setEnglish(false); setRevealed(new Set()); setShowSaved(false); }

  return html`<div class="reading">
    <div class="answer-row">
      <input value=${topic} placeholder="Topic (optional), e.g. ordering at a café" onInput=${(e) => setTopic(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && generate()} />
      <button class="btn brand" onClick=${generate} disabled=${loading || store.vocab.length < 5}>Generate</button>
    </div>
    <button class="link" onClick=${() => setShowSaved(true)}>Saved readings (${store.readings.length})</button>
    ${store.vocab.length < 5 ? html`<p class="muted">Add at least 5 vocab items first.</p>` : null}
    ${loading ? html`<${Spinner} text="Writing a text from your words..." />` : null}
    ${err ? html`<p class="error">${err}</p>` : null}
    ${text && !loading ? html`
      <div class="card">
        <${TapText} text=${text.title} big onWord=${(w) => setLookup(w)} />
        <p class="small muted">Tap any word for its meaning.</p>
        <${TapText} text=${text.french} onWord=${(w) => setLookup(w)} />
        <div class="row gap wrap">
          <button class="btn soft" onClick=${() => { unlockAudio(); speak(text.french, 'fr-FR', { force: true }); }}>🔊 Listen</button>
          <button class="btn soft" onClick=${stopSpeaking}>Stop</button>
          <button class="btn soft" onClick=${save} disabled=${saved}>${saved ? 'Saved' : 'Save'}</button>
          <button class="btn soft" onClick=${() => setEnglish(!english)}>${english ? 'Hide English' : 'Show English'}</button>
        </div>
        ${english ? html`<p class="muted english">${text.english}</p>` : null}
      </div>
      ${text.questions?.length ? html`<div class="card">
        <h3>Check your understanding</h3>
        ${text.questions.map((q) => html`<div class="qa">
          <p>${q.q}</p>
          ${revealed.has(q.q) ? html`<p class="answer">${q.a}</p>` : html`<button class="link" onClick=${() => setRevealed(new Set([...revealed, q.q]))}>Show answer</button>`}
        </div>`)}
      </div>` : null}
    ` : null}
    <${LookupSheet} word=${lookup} passage=${text ? text.title + '. ' + text.french : ''} onClose=${() => setLookup(null)} />
    <${Sheet} open=${showSaved} onClose=${() => setShowSaved(false)} title="Saved readings">
      ${!store.readings.length ? html`<p class="muted">Nothing saved yet.</p>` : null}
      ${store.readings.map((r) => html`<div class="list-row">
        <button class="link left" onClick=${() => open(r)}><b>${r.title}</b><span class="small muted"> ${relTime(r.date)}</span></button>
        <button class="link danger" onClick=${() => { store.readings = store.readings.filter((x) => x.id !== r.id); store.save('readings'); }}>Delete</button>
      </div>`)}
    </${Sheet}>
  </div>`;
}
