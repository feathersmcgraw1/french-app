// Conversations: chat by text or voice with a French-speaking friend. Port of the Mac app's Conversations.
import { html, useState, useEffect, useRef, useWatch, AccentBar, Bold, Sheet, MicMeter, Notice, useAutoGrow } from './ui.js';
import { store, weightedSample, vocabKey } from './store.js';
import { converse, explainChat } from './gemini.js';
import { speak, stopSpeaking, listen, stopListening, micState, unlockAudio } from './audio.js';
import { uuid, now, trim, normalizeStrict, relTime } from './util.js';
import { LookupSheet } from './reading.js';

const SCENARIOS = ['Ordering at a café', 'Asking for directions', 'Meeting a new neighbour', 'Buying food at the market', 'Talking about the weekend', 'Checking in at a hotel'];

// Kept outside the component so a conversation survives switching tabs.
const convo = {
  active: false, scenario: '', turns: [], known: [], thinking: false, error: null,
  used: [], wrong: [], candidates: [], side: [], notes: [], summary: false, autoSpeak: true,
  listeners: new Set(),
  emit() { for (const f of this.listeners) f(); },
  subscribe(f) { this.listeners.add(f); return () => this.listeners.delete(f); },
};

function resetConvo() {
  Object.assign(convo, { active: false, scenario: '', turns: [], known: [], thinking: false, error: null, used: [], wrong: [], candidates: [], side: [], notes: [], summary: false });
  convo.emit();
}

async function requestReply(userTurnID = null, restore = '', setInput) {
  convo.thinking = true; convo.error = null; convo.emit();
  try {
    const r = await converse({ scenario: convo.scenario, turns: convo.turns, known: convo.known, focus: weightedSample(store.vocab, 4) });
    if (!convo.active) return;
    if (userTurnID) {
      const c = r.correction;
      const t = convo.turns.find((x) => x.id === userTurnID);
      if (c && trim(c.corrected) && normalizeStrict(c.corrected) !== normalizeStrict(c.original) && t) t.correction = c;
      const res = store.recordChat(r.usedCorrectly || [], r.usedIncorrectly || []);
      for (const w of res.credited) if (!convo.used.includes(w)) convo.used.push(w);
      for (const w of res.penalized) if (!convo.wrong.includes(w)) convo.wrong.push(w);
      for (const p of r.newWords || []) {
        const f = trim(p.french), e = trim(p.english);
        if (!f || !e || store.inVocab(f) || convo.candidates.some((c) => vocabKey(c.french) === vocabKey(f))) continue;
        convo.candidates.push({ french: f, english: e, picked: true });
      }
    }
    const reply = trim(r.reply);
    if (reply) convo.turns.push({ id: uuid(), isUser: false, french: reply });
    convo.thinking = false;
    convo.emit();
    if (convo.autoSpeak && reply) speak(reply, 'fr-FR');
  } catch (e) {
    convo.error = e.message;
    if (userTurnID) { convo.turns = convo.turns.filter((t) => t.id !== userTurnID); setInput?.(restore); }
    convo.thinking = false;
    convo.emit();
  }
}

export function ConvoView() {
  useWatch(convo, micState);
  const [scenario, setScenario] = useState('');
  const [input, setInput] = useState('');
  const [lookup, setLookup] = useState(null);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [past, setPast] = useState(false);
  const inputRef = useRef(null);
  const endRef = useRef(null);
  useAutoGrow(inputRef, input);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [convo.turns.length, convo.thinking]);

  function begin(text) {
    unlockAudio();
    resetConvo();
    Object.assign(convo, { active: true, scenario: trim(text), known: store.sampleKnown(300) });
    convo.emit();
    if (convo.scenario) requestReply();
  }
  function send() {
    const text = trim(input);
    if (!text || convo.thinking) return;
    unlockAudio(); stopListening(); stopSpeaking();
    const turn = { id: uuid(), isUser: true, french: text };
    convo.turns.push(turn);
    setInput('');
    convo.emit();
    requestReply(turn.id, text, setInput);
  }
  async function mic() {
    unlockAudio();
    if (micState.active) return stopListening();
    stopSpeaking();
    const t = await listen('fr-FR');
    if (trim(t)) setInput(t);
  }
  function end() {
    stopListening(); stopSpeaking();
    if (convo.turns.some((t) => t.isUser)) {
      store.conversations.unshift({ id: uuid(), date: now(), scenario: convo.scenario, turns: convo.turns, notes: convo.notes });
      store.save('conversations');
      convo.summary = true;
      convo.emit();
    } else resetConvo();
  }

  if (convo.summary) return html`<${Summary} />`;

  if (!convo.active) {
    return html`<div class="convo-start">
      <p class="muted">Chat with a French-speaking friend. Start open, or pick a situation.</p>
      <div class="answer-row">
        <input value=${scenario} placeholder="Scenario (optional)" onInput=${(e) => setScenario(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && begin(scenario)} />
      </div>
      <div class="chips">${SCENARIOS.map((s) => html`<button class="chip-btn" onClick=${() => setScenario(s)}>${s}</button>`)}</div>
      <button class="btn brand big" disabled=${store.vocab.length < 5} onClick=${() => begin(scenario)}>${trim(scenario) ? 'Start scenario' : 'Start open conversation'}</button>
      ${store.vocab.length < 5 ? html`<p class="muted">Add at least 5 vocab items first.</p>` : null}
      <button class="link" onClick=${() => setPast(true)}>Past conversations (${store.conversations.length})</button>
      <${PastSheet} open=${past} onClose=${() => setPast(false)} />
    </div>`;
  }

  return html`<div class="convo">
    <div class="row between convo-bar">
      <span class="chip">${convo.scenario || 'Open conversation'}</span>
      <div class="row gap">
        <button class=${'chip-btn' + (convo.autoSpeak ? ' on' : '')} onClick=${() => { convo.autoSpeak = !convo.autoSpeak; convo.emit(); }}>🔊 ${convo.autoSpeak ? 'On' : 'Off'}</button>
        <button class="chip-btn" onClick=${() => setTutorOpen(true)}>Ask tutor</button>
        <button class="chip-btn danger" onClick=${end}>End</button>
      </div>
    </div>
    <div class="chat">
      ${!convo.turns.length && !convo.thinking ? html`<p class="muted center">Say bonjour to start.</p>` : null}
      ${convo.turns.map((t) => html`<div class=${'turn ' + (t.isUser ? 'me' : 'them')}>
        <div class=${'bubble ' + (t.isUser ? 'me' : 'them')}>
          ${t.isUser ? t.french : t.french.split(/\s+/).map((w) => html`<span class="tw" onClick=${() => setLookup({ w, passage: t.french })}>${w}</span> `)}
          ${!t.isUser ? html`<button class="mini" onClick=${() => { unlockAudio(); speak(t.french, 'fr-FR', { force: true }); }}>🔊</button>` : null}
        </div>
        ${t.correction ? html`<div class="correction"><span class="fix">${t.correction.corrected}</span>${t.correction.note ? html`<span class="small muted"> ${t.correction.note}</span>` : null}</div>` : null}
      </div>`)}
      ${convo.thinking ? html`<div class="turn them"><div class="bubble them typing">…</div></div>` : null}
      <div ref=${endRef} />
    </div>
    ${convo.error ? html`<p class="error">${convo.error}</p>` : null}
    <${Notice} />
    <div class="composer">
      <${AccentBar} inputRef=${inputRef} value=${input} onInput=${setInput} />
      <div class="answer-row">
        <textarea ref=${inputRef} rows="1" value=${input} placeholder="Écrivez ou parlez en français" onInput=${(e) => setInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button class=${'mic' + (micState.active ? ' on' : '')} onClick=${mic} aria-label="Speak">${micState.active ? html`<${MicMeter} />` : '🎤'}</button>
        <button class="btn brand" onClick=${send} disabled=${!trim(input) || convo.thinking}>Send</button>
      </div>
    </div>
    <${LookupSheet} word=${lookup?.w} passage=${lookup?.passage || ''} onClose=${() => setLookup(null)} />
    <${TutorSheet} open=${tutorOpen} onClose=${() => setTutorOpen(false)} />
  </div>`;
}

function TutorSheet({ open, onClose }) {
  useWatch(convo);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function ask() {
    const text = trim(q);
    if (!text || busy || !convo.turns.length) return;
    convo.side.push({ isUser: true, text });
    setQ(''); setBusy(true); setErr(null); convo.emit();
    try {
      const reply = await explainChat(convo.turns, convo.side);
      convo.side.push({ isUser: false, text: reply });
      convo.notes.push({ id: uuid(), date: now(), question: text, answer: reply });
    } catch (e) { setErr(e.message); }
    setBusy(false); convo.emit();
  }
  return html`<${Sheet} open=${open} onClose=${onClose} title="Ask the tutor">
    <p class="small muted">What did they mean? How do I say...? Why not...?</p>
    ${convo.side.map((m) => html`<div class=${'bubble ' + (m.isUser ? 'me' : 'them')}><${Bold} text=${m.text} /></div>`)}
    ${busy ? html`<p class="muted small">Thinking...</p>` : null}
    ${err ? html`<p class="error">${err}</p>` : null}
    <div class="answer-row">
      <input value=${q} placeholder=${convo.turns.length ? 'Your question' : 'Start the conversation first'} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && ask()} />
      <button class="btn brand" onClick=${ask} disabled=${busy || !trim(q) || !convo.turns.length}>Ask</button>
    </div>
  </${Sheet}>`;
}

function Summary() {
  useWatch(convo);
  const [added, setAdded] = useState(false);
  const picked = convo.candidates.filter((c) => c.picked);
  return html`<div class="summary">
    <h2>Nice conversation</h2>
    ${convo.used.length ? html`<div class="card"><h3>Words you used well</h3><p>${convo.used.join(', ')}</p><p class="small muted">Each counts for half a flashcard step.</p></div>` : null}
    ${convo.wrong.length ? html`<div class="card"><h3>Words to work on</h3><p>${convo.wrong.join(', ')}</p></div>` : null}
    ${convo.turns.some((t) => t.correction) ? html`<div class="card"><h3>Corrections</h3>${convo.turns.filter((t) => t.correction).map((t) => html`<p><s class="muted">${t.correction.original}</s><br /><b>${t.correction.corrected}</b>${t.correction.note ? html`<br /><span class="small muted">${t.correction.note}</span>` : null}</p>`)}</div>` : null}
    ${convo.candidates.length ? html`<div class="card">
      <h3>New words</h3>
      <p class="small muted">Pick the ones to add to your vocab.</p>
      ${convo.candidates.map((c) => html`<label class="check-row"><input type="checkbox" checked=${c.picked} disabled=${added} onChange=${() => { c.picked = !c.picked; convo.emit(); }} /> <b>${c.french}</b> <span class="muted">${c.english}</span></label>`)}
      ${added ? html`<p class="good-text small">Added.</p>` : html`<button class="btn brand" disabled=${!picked.length} onClick=${() => { store.addPairs(picked); setAdded(true); }}>Add ${picked.length} to vocab</button>`}
    </div>` : null}
    <button class="btn brand big" onClick=${resetConvo}>Done</button>
  </div>`;
}

function PastSheet({ open, onClose }) {
  useWatch();
  const [view, setView] = useState(null);
  return html`<${Sheet} open=${open} onClose=${() => { setView(null); onClose(); }} title=${view ? view.scenario || 'Open conversation' : 'Past conversations'}>
    ${view ? html`
      <button class="link" onClick=${() => setView(null)}>‹ All conversations</button>
      ${view.turns.map((t) => html`<div class=${'turn ' + (t.isUser ? 'me' : 'them')}><div class=${'bubble ' + (t.isUser ? 'me' : 'them')}>${t.french}</div>
        ${t.correction ? html`<div class="correction"><span class="fix">${t.correction.corrected}</span></div>` : null}</div>`)}
    ` : html`
      ${!store.conversations.length ? html`<p class="muted">No conversations yet.</p>` : null}
      ${store.conversations.map((c) => html`<div class="list-row"><button class="link left" onClick=${() => setView(c)}><b>${c.scenario || 'Open conversation'}</b> <span class="small muted">${relTime(c.date)} · ${c.turns.filter((t) => t.isUser).length} messages</span></button></div>`)}
    `}
  </${Sheet}>`;
}
