// Silent drills: words, gender and conjugation. Port of the Mac app's drill views.
import { html, useState, useEffect, useRef, useWatch, AccentBar, Segmented, Spinner } from './ui.js';
import { store, settings, weightedSample } from './store.js';
import * as D from './drills.js';
import { conjugations } from './gemini.js';
import { uuid, trim, shuffle } from './util.js';
import { chime } from './audio.js';

function Outcome({ o }) {
  return html`<div class=${'result ' + (o.ok ? 'good' : o.verdict === 'accents' || o.verdict === 'wrongArticle' ? 'warn' : 'bad')}>
    <h3>${o.title}</h3>${o.detail ? html`<p>${o.detail}</p>` : null}${o.tip ? html`<p class="small">${o.tip}</p>` : null}
  </div>`;
}

function Score({ c, t }) { return html`<span class="chip">${c}/${t}</span>`; }

export function WordDrill() {
  useWatch();
  const [st, setSt] = useState({ word: null, dir: 'frToEn', outcome: null, card: null, snap: null, overridden: false });
  const [answer, setAnswer] = useState('');
  const [score, setScore] = useState({ c: 0, t: 0 });
  const ref = useRef(null);
  const dirSetting = settings.get('wordDirection');

  function next() {
    let pick = weightedSample(store.vocab, 1)[0];
    if (pick && st.word && pick.id === st.word.id && store.vocab.length > 1) pick = weightedSample(store.vocab.filter((v) => v.id !== pick.id), 1)[0];
    if (!pick) return;
    let d = settings.get('wordDirection');
    if (d === 'mixed') d = Math.random() < 0.5 ? 'frToEn' : 'enToFr';
    setAnswer('');
    setSt({ word: pick, dir: d, outcome: null, snap: null, overridden: false, card: { id: uuid(), french: pick.french, english: pick.english, direction: d, targetIDs: [pick.id] } });
    setTimeout(() => ref.current?.focus(), 50);
  }
  useEffect(() => { if (store.vocab.length >= 5) next(); }, [dirSetting]);

  function finish(v, said, skipped = false) {
    const { word: w, card: c, dir } = st;
    if (!w || st.outcome) return;
    const ok = D.isRight(v);
    const expected = dir === 'frToEn' ? w.english : w.french;
    const m = D.message(v, expected, skipped);
    const snap = store.snapshot(c);
    store.logDrill(c, said, ok, m.title, expected, D.tag(v, skipped));
    store.recordIDs([w.id], ok);
    store.recordDay(ok);
    setScore((s) => ({ c: s.c + (ok ? 1 : 0), t: s.t + 1 }));
    chime(ok);
    setSt({ ...st, snap, outcome: { verdict: v, ok, title: m.title, detail: m.detail } });
  }
  function check() {
    const t = trim(answer);
    if (!t || !st.word) return;
    finish(st.dir === 'frToEn' ? D.checkEnglish(t, st.word.english) : D.checkFrench(t, st.word.french), t);
  }
  function markCorrect() {
    const { word: w, card: c, snap, outcome: o } = st;
    if (!snap || !o || o.ok || st.overridden) return;
    store.revert(snap, c);
    store.logDrill(c, answer, true, 'Marked correct by you.', null, '');
    store.recordIDs([w.id], true);
    store.recordDayFix();
    setScore((s) => ({ ...s, c: s.c + 1 }));
    setSt({ ...st, overridden: true, outcome: { ...o, verdict: 'correct', ok: true, title: 'Counted as correct' } });
  }

  if (store.vocab.length < 5) return html`<p class="muted">Add at least 5 vocab items first.</p>`;
  const w = st.word;
  if (!w) return null;
  return html`<div class="drill">
    <div class="row between">
      <${Segmented} value=${dirSetting} onChange=${(v) => settings.set('wordDirection', v)} options=${[['frToEn', 'FR → EN'], ['enToFr', 'EN → FR'], ['mixed', 'Mixed']]} />
      <${Score} ...${score} />
    </div>
    <div class="card prompt-card"><p class="small muted">${st.dir === 'frToEn' ? 'Type the English meaning' : 'Type the French'}</p><p class="prompt">${st.dir === 'frToEn' ? w.french : w.english}</p></div>
    ${st.outcome ? html`
      <${Outcome} o=${st.outcome} />
      ${st.dir === 'frToEn' && st.outcome.verdict !== 'correct' ? html`<p class="small muted">Your answer: ${answer}</p>` : null}
      <div class="row gap">
        ${!st.outcome.ok && !st.overridden ? html`<button class="btn soft" onClick=${markCorrect}>I was right</button>` : null}
        <button class="btn brand grow" onClick=${next}>Next</button>
      </div>` : html`
      ${st.dir === 'enToFr' ? html`<${AccentBar} inputRef=${ref} value=${answer} onInput=${setAnswer} />` : null}
      <div class="answer-row">
        <input ref=${ref} value=${answer} autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"
          placeholder=${st.dir === 'frToEn' ? 'English meaning' : 'En français'} onInput=${(e) => setAnswer(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && check()} />
      </div>
      <div class="row gap">
        <button class="btn soft" onClick=${() => finish('incorrect', '(skipped)', true)}>I don't know</button>
        <button class="btn brand grow" disabled=${!trim(answer)} onClick=${check}>Check</button>
      </div>`}
  </div>`;
}

export function GenderDrill() {
  useWatch();
  const pool = store.vocab.filter((v) => D.gender(v.french));
  const [st, setSt] = useState(null);
  const [score, setScore] = useState({ c: 0, t: 0 });
  function next() {
    const items = store.vocab.filter((v) => D.gender(v.french));
    if (!items.length) return;
    let pick = weightedSample(items, 1)[0];
    if (st && pick.id === st.noun.id && items.length > 1) pick = weightedSample(items.filter((v) => v.id !== pick.id), 1)[0];
    const g = D.gender(pick.french);
    setSt({ noun: pick, truth: g.gender, bare: g.bare, chosen: null });
  }
  useEffect(() => { if (pool.length) next(); }, []);
  function choose(g) {
    if (!st || st.chosen) return;
    const ok = g === st.truth;
    const said = (g === 'm' ? 'le ' : 'la ') + st.bare;
    const c = { id: uuid(), french: st.noun.french, english: st.noun.english, direction: 'enToFr', targetIDs: [st.noun.id] };
    store.logDrill(c, said, ok, ok ? 'Right gender.' : 'Wrong gender.', st.noun.french, 'noun gender or article');
    store.recordSkill(st.noun.id, ok);
    store.recordDay(ok);
    setScore((s) => ({ c: s.c + (ok ? 1 : 0), t: s.t + 1 }));
    chime(ok);
    setSt({ ...st, chosen: g });
  }
  if (!pool.length) return html`<p class="muted">No nouns with le, la, un or une in your vocab yet.</p>`;
  if (!st) return null;
  const tint = (g) => (!st.chosen ? '' : g === st.truth ? ' good' : g === st.chosen ? ' bad' : '');
  return html`<div class="drill">
    <div class="row between"><span class="small muted">Masculine or feminine?</span><${Score} ...${score} /></div>
    <div class="card prompt-card"><p class="prompt">${st.bare}</p><p class="small muted">${st.noun.english}</p></div>
    <div class="row gap">
      <button class=${'btn gender grow' + tint('m')} onClick=${() => choose('m')}><b>le / un</b><span>masculine</span></button>
      <button class=${'btn gender grow' + tint('f')} onClick=${() => choose('f')}><b>la / une</b><span>feminine</span></button>
    </div>
    ${st.chosen ? html`
      <${Outcome} o=${{ ok: st.chosen === st.truth, verdict: st.chosen === st.truth ? 'correct' : 'incorrect', title: st.chosen === st.truth ? 'Correct' : 'Not quite', detail: st.noun.french, tip: D.genderTip(st.bare, st.truth) }} />
      <button class="btn brand" onClick=${next}>Next</button>` : null}
  </div>`;
}

export function ConjugationDrill() {
  useWatch();
  const verbs = store.vocab.filter(D.isVerb);
  const tenseSetting = settings.get('conjTense');
  const queue = useRef([]);
  const [cur, setCur] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [answer, setAnswer] = useState('');
  const [outcome, setOutcome] = useState(null);
  const [snap, setSnap] = useState(null);
  const [overridden, setOverridden] = useState(false);
  const [score, setScore] = useState({ c: 0, t: 0 });
  const ref = useRef(null);
  const loadingRef = useRef(false);

  const activeTenses = () => {
    const t = D.TENSES.find((x) => x.name === tenseSetting);
    return t ? [t] : D.studiedTenses(store);
  };

  async function ensure() {
    if (loadingRef.current || queue.current.length >= 4 || !verbs.length) return;
    loadingRef.current = true;
    setLoading(true);
    const tenses = activeTenses();
    const picks = weightedSample(verbs, Math.min(5, verbs.length));
    const wanted = picks.map((v) => ({ verb: v, tense: tenses[Math.floor(Math.random() * tenses.length)].name }));
    try {
      const missing = wanted.filter((w) => !store.conjugations[D.conjKey(w.verb.french, w.tense)]);
      if (missing.length) {
        const got = await conjugations(missing.map((m) => ({ verb: m.verb.french, tense: m.tense })));
        missing.forEach((m, n) => { if (got[n + 1]) store.conjugations[D.conjKey(m.verb.french, m.tense)] = got[n + 1]; });
        store.save('conjugations');
      }
      for (const w of wanted) {
        const forms = store.conjugations[D.conjKey(w.verb.french, w.tense)];
        if (forms?.length === 6) queue.current.push({ ...w, forms, slot: Math.floor(Math.random() * 6) });
      }
      setErr(null);
    } catch (e) { setErr(e.message); }
    loadingRef.current = false;
    setLoading(false);
  }

  async function advance() {
    setAnswer(''); setOutcome(null); setSnap(null); setOverridden(false);
    if (!queue.current.length) { setCur(null); await ensure(); }
    const item = queue.current.shift();
    if (item) {
      setCur({ ...item, card: { id: uuid(), french: item.forms[item.slot], english: `${item.verb.french}, ${item.tense}, ${D.conjLabel(item.forms[item.slot])}`, direction: 'enToFr', targetIDs: [item.verb.id] } });
      setTimeout(() => ref.current?.focus(), 50);
    }
    ensure();
  }
  useEffect(() => { queue.current = []; if (verbs.length) advance(); }, [tenseSetting]);

  function finish(v, said, skipped = false) {
    if (!cur || outcome) return;
    const ok = D.isRight(v);
    const full = cur.forms[cur.slot];
    const m = D.message(v, full, skipped);
    setSnap(store.snapshot(cur.card));
    store.logDrill(cur.card, said, ok, m.title, full, 'verb conjugation');
    store.recordSkill(cur.verb.id, ok);
    store.recordDay(ok);
    setScore((s) => ({ c: s.c + (ok ? 1 : 0), t: s.t + 1 }));
    chime(ok);
    setOutcome({ verdict: v, ok, title: m.title, detail: m.detail });
  }
  function markCorrect() {
    if (!snap || !outcome || outcome.ok || overridden) return;
    store.revert(snap, cur.card);
    store.logDrill(cur.card, answer, true, 'Marked correct by you.', null, '');
    store.recordSkill(cur.verb.id, true);
    store.recordDayFix();
    setScore((s) => ({ ...s, c: s.c + 1 }));
    setOverridden(true);
    setOutcome({ ...outcome, ok: true, verdict: 'correct', title: 'Counted as correct' });
  }
  function reportBad() {
    if (snap) store.revert(snap, cur.card);
    delete store.conjugations[D.conjKey(cur.verb.french, cur.tense)];
    store.save('conjugations');
    advance();
  }

  const picker = html`<select class="select" value=${tenseSetting} onChange=${(e) => settings.set('conjTense', e.target.value)}>
    <option value="mix" selected=${tenseSetting === 'mix'}>Mix (tenses you've studied)</option>
    ${D.TENSES.map((t) => html`<option value=${t.name} selected=${tenseSetting === t.name}>${t.name}</option>`)}
  </select>`;

  if (!verbs.length) return html`<p class="muted">No verbs in your vocab yet (infinitives with an English meaning starting with "to").</p>`;
  if (!cur) return html`<div class="drill">${picker}${err ? html`<p class="error">${err}</p><button class="btn soft" onClick=${advance}>Try again</button>` : html`<${Spinner} text="Fetching conjugation tables..." />`}</div>`;
  const form = cur.forms[cur.slot];
  return html`<div class="drill">
    <div class="row between">${picker}<${Score} ...${score} /></div>
    <div class="card prompt-card">
      <p class="small muted">${cur.tense}</p>
      <p class="prompt">${cur.verb.french}</p>
      <p class="small muted">${cur.verb.english}</p>
      <p class="conj-label">${D.conjLabel(form)} …</p>
    </div>
    ${outcome ? html`
      <${Outcome} o=${outcome} />
      <table class="conj">${cur.forms.map((f, i) => html`<tr class=${i === cur.slot ? 'hl' : ''}><td>${f}</td></tr>`)}</table>
      <div class="row gap">
        ${!outcome.ok && !overridden ? html`<button class="btn soft" onClick=${markCorrect}>I was right</button>` : null}
        <button class="btn soft" onClick=${reportBad}>Table is wrong</button>
        <button class="btn brand grow" onClick=${advance}>Next</button>
      </div>` : html`
      <${AccentBar} inputRef=${ref} value=${answer} onInput=${setAnswer} />
      <div class="answer-row">
        <input ref=${ref} value=${answer} autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Conjugated form"
          onInput=${(e) => setAnswer(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && trim(answer) && finish(D.checkConj(answer, form), trim(answer))} />
      </div>
      <div class="row gap">
        <button class="btn soft" onClick=${() => finish('incorrect', '(skipped)', true)}>I don't know</button>
        <button class="btn brand grow" disabled=${!trim(answer)} onClick=${() => finish(D.checkConj(answer, form), trim(answer))}>Check</button>
      </div>`}
    ${loading && !cur ? html`<p class="muted small">Loading...</p>` : null}
  </div>`;
}

void shuffle;
