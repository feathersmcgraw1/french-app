// Sentence practice: a port of the Mac app's PracticeModel and PracticeView.
import { html, useState, useEffect, useRef, useWatch, AccentBar, Bold, MicMeter, Notice, Spinner, Segmented, useAutoGrow } from './ui.js';
import { store, settings, isCorrect, isPartial } from './store.js';
import { makeCards, judge, explainCard, prompt, reference } from './gemini.js';
import { speak, stopSpeaking, prepare, prefetch, listen, stopListening, micState, voiceState, unlockAudio, chime, LEVEL_NAMES } from './audio.js';
import { normalize, normalizeStrict, trim } from './util.js';

const BUFFER = 5;

class Session {
  constructor() {
    this.listeners = new Set();
    this.reset();
  }
  reset() {
    this.phase = 'idle'; // idle | loading | preparing | asking | judging | result
    this.current = null;
    this.judgement = null;
    this.error = null;
    this.correct = 0;
    this.total = 0;
    this.cue = null;
    this.assisted = false;
    this.overridden = false;
    this.reviewOnly = false;
    this.queue = [];
    this.firstTry = null;
    this.snapshot = null;
    this.submitted = '';
    this.fetching = false;
    this.retryAfter = 0;
    this.token = 0;
    this.prepToken = (this.prepToken || 0) + 1;
  }
  emit() { for (const f of this.listeners) f(); }
  subscribe(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  set(p) { Object.assign(this, p); this.emit(); }

  get direction() { return settings.get('direction'); }

  async start(reviewOnly = false) {
    const t = this.token + 1;
    this.reset();
    this.token = t;
    this.reviewOnly = reviewOnly;
    if (reviewOnly) {
      const due = store.dueMistakes(20);
      if (!due.length) { this.set({ error: 'Nothing is due for review right now.', reviewOnly: false }); return; }
      this.queue = due.map((m) => store.cardFromMistake(m));
      this.advance();
      return;
    }
    this.set({ phase: 'loading' });
    await this.fetch();
  }

  async fetch() {
    if (this.fetching || this.reviewOnly) return;
    this.fetching = true;
    const token = this.token;
    try {
      const generated = await makeCards({ count: 5, direction: this.direction, avoid: store.history.slice(-25) });
      if (token !== this.token) return;
      const fresh = generated.filter((c) => !store.hasSeen(c.french));
      const cards = fresh.length ? fresh : generated;
      if (!cards.length) {
        this.error = 'No cards fit your ticked grammar this time. Try again, or tick more grammar.';
        this.retryAfter = Date.now() + 10000;
      } else {
        const inFlight = new Set(this.queue.map((c) => normalize(c.french)));
        if (this.current) inFlight.add(normalize(this.current.french));
        const batch = [...cards];
        store.dueMistakes(2, inFlight).map((m) => store.cardFromMistake(m)).forEach((r, n) => batch.splice(Math.min(batch.length, 1 + n * 2), 0, r));
        const d = this.direction;
        this.queue.push(...batch.filter((c) => d === 'mixed' || c.direction === d));
        this.error = null;
        prefetch(this.upcomingFrench());
      }
    } catch (e) {
      if (token !== this.token) return;
      this.error = e.message;
      this.retryAfter = Date.now() + 10000;
    } finally {
      if (token === this.token) this.fetching = false;
    }
    if (token !== this.token) return;
    if (this.phase === 'loading') {
      if (this.error) this.set({ phase: 'idle' }); else this.advance();
    } else this.emit();
  }

  upcomingFrench() { return this.queue.slice(0, 3).filter((c) => c.direction === 'frToEn').map((c) => c.french); }

  refill() {
    if (this.reviewOnly || this.queue.length >= BUFFER) return;
    if (this.error && Date.now() < this.retryAfter) return;
    this.fetch();
  }

  advance() {
    Object.assign(this, { judgement: null, cue: null, firstTry: null, assisted: false, overridden: false, submitted: '' });
    const next = this.queue.shift();
    if (next) {
      this.refill();
      // Hold the card until its voice is ready, so it appears and speaks together.
      const spoken = settings.get('autoVoice') && next.direction === 'frToEn';
      if (!spoken) { this.set({ current: next, phase: 'asking' }); return; }
      const token = ++this.prepToken;
      this.set({ current: null, phase: 'preparing' });
      prepare(next.french).then(() => {
        if (token !== this.prepToken || this.phase !== 'preparing') return;
        this.set({ current: next, phase: 'asking' });
      });
    } else if (this.reviewOnly) {
      this.set({ current: null, reviewOnly: false, phase: 'idle' });
    } else {
      this.set({ current: null, error: null, phase: 'loading' });
      this.fetch();
    }
  }

  next() { stopSpeaking(); stopListening(); this.advance(); }

  async submit(answer, typed) {
    const card = this.current;
    if (!card || this.phase !== 'asking') return;
    const a = trim(answer);
    if (!a) return;
    this.submitted = a;
    const strict = typed && card.direction === 'enToFr';
    const same = strict ? normalizeStrict(a) === normalizeStrict(reference(card)) : normalize(a) === normalize(reference(card));
    if (same) return this.settle(card, { verdict: 'correct', feedback: 'Exact match.' });
    this.set({ phase: 'judging' });
    try {
      const focus = card.targetIDs.map((id) => store.byID(id)?.french).filter(Boolean);
      const j = await judge(card, a, { typed: strict, focus });
      this.error = null;
      this.settle(card, j);
    } catch (e) {
      this.set({ error: e.message, phase: 'asking' });
    }
  }

  settle(card, j) {
    if (this.firstTry && isCorrect(j)) {
      return this.finish(card, { verdict: 'correct', feedback: 'Right on the second try. ' + this.firstTry.feedback });
    }
    if (this.firstTry) {
      const f = this.firstTry;
      return this.finish(card, {
        verdict: 'partial', feedback: isCorrect(j) ? 'You fixed it on the second try. ' + f.feedback : j.feedback,
        better: j.better || f.better || reference(card), errors: f.errors, detail: f.detail, wrongWords: f.wrongWords,
      });
    }
    if (settings.get('secondTry') && isPartial(j) && trim(j.cue)) {
      this.firstTry = j;
      this.set({ cue: trim(j.cue), phase: 'asking' });
      return;
    }
    this.finish(card, j);
  }

  giveUp() {
    const card = this.current;
    if (!card || this.phase !== 'asking') return;
    this.submitted = '(skipped)';
    if (this.firstTry) {
      const f = this.firstTry;
      return this.finish(card, { verdict: 'partial', feedback: f.feedback, better: f.better || reference(card), errors: f.errors, detail: f.detail, wrongWords: f.wrongWords });
    }
    this.finish(card, { verdict: 'incorrect', feedback: 'Skipped.', better: reference(card), errors: ['vocabulary not known'] });
  }

  finish(card, j) {
    this.overridden = false;
    this.snapshot = store.snapshot(card);
    store.logResult(card, this.submitted, j);
    this.judgement = j;
    this.total += 1;
    if (isCorrect(j)) this.correct += 1;
    if (!(this.assisted && isCorrect(j))) store.recordCard(card, j);
    store.recordDay(isCorrect(j));
    store.markSeen(card.french);
    this.set({ phase: 'result' });
    chime(isCorrect(j));
    if (card.direction === 'enToFr') {
      setTimeout(() => { if (this.current === card && this.phase === 'result') speak(card.french, 'fr-FR'); }, settings.get('soundEffects') ? 700 : 0);
    }
  }

  markCorrect() {
    const card = this.current, j = this.judgement;
    if (this.phase !== 'result' || this.overridden || !card || !j || isCorrect(j) || !this.snapshot) return;
    store.revert(this.snapshot, card);
    const ok = { verdict: 'correct', feedback: 'Marked correct by you.' };
    store.logResult(card, '', ok);
    store.recordCard(card, ok);
    store.recordDayFix();
    this.correct += 1;
    this.set({ judgement: ok, overridden: true });
  }
}

export const session = new Session();

function verdictStyle(j) {
  const v = (j.verdict || '').toLowerCase();
  if (v === 'pronunciation') return ['info', 'Right, but check your pronunciation'];
  if (isCorrect(j)) return ['good', 'Correct'];
  if (isPartial(j)) return ['warn', 'Almost'];
  return ['bad', 'Not quite'];
}

export function PracticeView({ startReview }) {
  useWatch(session, voiceState, micState);
  const s = session;
  const [answer, setAnswer] = useState('');
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef(null);
  const flow = useRef(0);
  useAutoGrow(inputRef, answer);
  const handsFree = settings.get('autoVoice');

  // A new card: clear the field, speak the prompt, then open the mic.
  useEffect(() => {
    setAnswer('');
    setRevealed(false);
    if (s.current && s.phase === 'asking') runFlow(true);
    return () => { flow.current++; };
  }, [s.current?.id]);

  useEffect(() => { if (startReview) { unlockAudio(); s.start(true); } }, [startReview]);

  async function runFlow(auto) {
    const card = s.current;
    if (!card) return;
    const my = ++flow.current;
    if (auto && handsFree) {
      if (card.direction === 'frToEn') await speak(card.french, 'fr-FR');
      else await speak(card.english, 'en-US');
    }
    if (my !== flow.current || !handsFree || s.phase !== 'asking' || s.current !== card) return;
    const heard = await listen(card.direction === 'frToEn' ? 'en-US' : 'fr-FR');
    if (my !== flow.current || s.phase !== 'asking' || s.current !== card || !heard) return;
    setAnswer(heard);
    if (settings.get('autoCheck')) s.submit(heard, false);
  }

  async function mic() {
    unlockAudio();
    if (micState.active) return stopListening();
    stopSpeaking();
    flow.current++;
    const card = s.current;
    const heard = await listen(card.direction === 'frToEn' ? 'en-US' : 'fr-FR');
    if (heard && s.current === card) {
      setAnswer(heard);
      if (settings.get('autoCheck')) s.submit(heard, false);
    }
  }

  const check = () => { unlockAudio(); flow.current++; stopListening(); s.submit(answer, true); };

  if (s.phase === 'idle') {
    return html`<div class="center-col">
      <${Controls} />
      ${s.error ? html`<p class="error">${s.error}</p>` : null}
      <button class="btn brand big" onClick=${() => { unlockAudio(); s.start(); }} disabled=${store.vocab.length < 5}>Start session</button>
      ${store.vocab.length < 5 ? html`<p class="muted">Add at least 5 words on your Mac first. They sync here.</p>` : null}
    </div>`;
  }
  if (s.phase === 'loading' || s.phase === 'preparing' || !s.current) {
    return html`<${Spinner} text="Preparing your cards..." />`;
  }

  const card = s.current;
  const j = s.judgement;
  const hide = settings.get('hideText') && !revealed && s.phase !== 'result';
  return html`<div class="practice">
    <div class="row between">
      <span class="chip">${s.reviewOnly ? 'Review' : card.direction === 'frToEn' ? 'FR → EN' : 'EN → FR'}${card.retryOf && !s.reviewOnly ? ' · retry' : ''}</span>
      <span class="chip">${s.correct}/${s.total}</span>
    </div>

    <div class="card prompt-card">
      ${hide
        ? html`<button class="link" onClick=${() => setRevealed(true)}>Show text</button>`
        : html`<p class=${card.direction === 'frToEn' ? 'prompt fr' : 'prompt'}>${prompt(card)}</p>`}
      <button class="icon-btn replay" disabled=${s.phase !== 'asking' && s.phase !== 'result'} onClick=${() => { unlockAudio(); s.phase === 'asking' ? runFlow(true) : speak(prompt(card), card.direction === 'frToEn' ? 'fr-FR' : 'en-US', { force: true }); }}>🔊</button>
    </div>

    ${s.phase === 'result' && j ? html`
      <div class=${'result ' + verdictStyle(j)[0]}>
        <h3>${verdictStyle(j)[1]}</h3>
        ${s.submitted ? html`<p class="small muted">You said</p><p class="said">${s.submitted}</p>` : null}
        <p><${Bold} text=${j.feedback} /></p>
        ${s.assisted && isCorrect(j) && !s.overridden ? html`<p class="small muted">You asked the tutor first, so this one is practice and does not count toward learning the words.</p>` : null}
        ${j.better ? html`<p class="small muted">Better</p><p class="better">${j.better}</p>` : null}
        ${!isCorrect(j) && s.submitted !== '(skipped)' ? html`<button class="btn soft" onClick=${() => s.markCorrect()}>I got it right (transcription error)</button>` : null}
        ${s.overridden ? html`<p class="small">Counted as correct. Removed from your mistake log.</p>` : null}
      </div>
      <div class="row gap">
        <button class="btn soft" onClick=${() => { unlockAudio(); speak(card.french, 'fr-FR', { force: true }); }}>🔊 Hear it</button>
        <button class="btn brand grow" onClick=${() => { unlockAudio(); s.next(); }}>Next</button>
      </div>
    ` : html`
      ${s.phase === 'judging' ? html`<p class="status">Checking...</p>` : micState.active ? html`<p class="status">Listening... <${MicMeter} /></p>` : voiceState.speaking ? html`<p class="status">Speaking...</p>` : null}
      ${s.cue ? html`<div class="cue"><b>Almost. One more try.</b><p>${s.cue}</p></div>` : null}
      ${card.direction === 'enToFr' ? html`<${AccentBar} inputRef=${inputRef} value=${answer} onInput=${setAnswer} />` : null}
      <div class="answer-row">
        <textarea ref=${inputRef} rows="1" value=${answer} disabled=${s.phase === 'judging'}
          placeholder=${card.direction === 'frToEn' ? 'Say or type the English' : 'Dites ou écrivez en français'}
          onInput=${(e) => setAnswer(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); check(); } }} />
        <button class=${'mic' + (micState.active ? ' on' : '')} onClick=${mic} disabled=${s.phase === 'judging'} aria-label="Answer by voice">🎤</button>
      </div>
      <div class="row gap">
        <button class="btn soft" disabled=${s.phase === 'judging'} onClick=${() => { flow.current++; stopSpeaking(); stopListening(); s.giveUp(); }}>I don't know</button>
        <button class="btn brand grow" disabled=${!trim(answer) || s.phase === 'judging'} onClick=${check}>Check</button>
      </div>
    `}
    ${s.error ? html`<p class="error">${s.error}</p>` : null}
    <${Notice} />
    <${AskTutor} card=${card} answer=${s.submitted} judgement=${j} key=${card.id} />
    ${s.phase !== 'result' ? html`<div class="row center"><${Controls} compact /></div>` : null}
  </div>`;
}

function Controls({ compact }) {
  useWatch();
  const dir = settings.get('direction');
  const lvl = settings.get('speechLevel');
  return html`<div class=${'controls' + (compact ? ' compact' : '')}>
    ${!compact ? html`<${Segmented} value=${dir} onChange=${(v) => settings.set('direction', v)} options=${[['frToEn', 'FR → EN'], ['enToFr', 'EN → FR'], ['mixed', 'Mixed']]} />` : null}
    <label class="slider">🐢 <input type="range" min="0" max="3" step="1" value=${lvl} onInput=${(e) => settings.set('speechLevel', +e.target.value)} /> <span class="small muted">${LEVEL_NAMES[lvl]}</span></label>
  </div>`;
}

function AskTutor({ card, answer, judgement }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function ask() {
    const text = trim(q);
    if (!text || busy) return;
    if (!judgement) session.assisted = true;
    const history = [...chat, { isUser: true, text }];
    setChat(history); setQ(''); setBusy(true); setErr(null);
    try {
      const reply = await explainCard(card, answer, judgement, history);
      setChat([...history, { isUser: false, text: reply }]);
      store.addNote(card, answer, judgement, text, reply);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  if (!open) return html`<button class="link ask-link" onClick=${() => setOpen(true)}>Ask the tutor about this card</button>`;
  return html`<div class="card tutor">
    ${chat.map((m) => html`<div class=${'bubble ' + (m.isUser ? 'me' : 'them')}><${Bold} text=${m.text} /></div>`)}
    ${busy ? html`<p class="muted small">Thinking...</p>` : null}
    ${err ? html`<p class="error">${err}</p>` : null}
    <div class="answer-row">
      <input value=${q} placeholder=${judgement ? 'Why is it...?' : 'A hint, without the answer'} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && ask()} />
      <button class="btn brand" onClick=${ask} disabled=${busy || !trim(q)}>Ask</button>
    </div>
  </div>`;
}
