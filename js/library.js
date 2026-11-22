// Library: vocab list and grammar checklist.
import { html, useState, useEffect, useWatch, Sheet, Segmented, Paragraphs, Spinner, SpeakerButton } from './ui.js';
import { store, run, isLearned, LEARNED_RUN, topicID } from './store.js';
import { GRAMMAR } from './grammar-data.js';
import { lesson, extractVocab } from './gemini.js';
import { now, normalize, trim, relTime } from './util.js';

export function LibraryView() {
  const [tab, setTab] = useState('vocab');
  return html`<div>
    <${Segmented} value=${tab} onChange=${setTab} options=${[['vocab', 'Vocab'], ['grammar', 'Grammar']]} />
    <div class="pad-top">${tab === 'vocab' ? html`<${VocabView} />` : html`<${GrammarView} />`}</div>
  </div>`;
}

function dotColor(v) {
  if (!v.seen) return 'rgba(20,43,80,0.22)';
  if (isLearned(v)) return 'var(--good)';
  if (run(v) >= 3) return 'rgba(10,98,42,0.6)';
  const rate = (v.seen - v.missed) / v.seen;
  if (rate >= 0.8) return 'rgba(10,98,42,0.6)';
  if (rate >= 0.5) return 'var(--orange)';
  return 'var(--bad)';
}

const SORTS = [['recent', 'Newest'], ['az', 'A–Z'], ['progress', 'Progress'], ['weak', 'Weakest']];

function VocabView() {
  useWatch();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [show, setShow] = useState('all');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const total = store.vocab.length;
  const learned = store.learnedCount;
  const k = normalize(q);
  let list = store.vocab.filter((v) => !k || normalize(v.french).includes(k) || normalize(v.english).includes(k));
  if (show === 'learning') list = list.filter((v) => v.seen && !isLearned(v));
  if (show === 'learned') list = list.filter(isLearned);
  if (show === 'new') list = list.filter((v) => !v.seen);
  const rate = (v) => (v.seen ? (v.seen - v.missed) / v.seen : 2);
  list = [...list].sort({
    recent: (a, b) => b.added - a.added,
    az: (a, b) => normalize(a.french).localeCompare(normalize(b.french)),
    progress: (a, b) => run(b) - run(a),
    weak: (a, b) => rate(a) - rate(b),
  }[sort]);
  return html`<div class="vocab">
    <div class="card">
      <div class="row between"><b>${learned} of ${total} learned</b><button class="btn brand small-btn" onClick=${() => setAdding(true)}>+ Add words</button></div>
      <div class="bar thin"><i style=${`width:${total ? (learned / total) * 100 : 0}%`} /></div>
      <p class="small muted">Learned = ${LEARNED_RUN} correct recalls spread over days.</p>
      ${total >= 20 && learned / total >= 0.8 ? html`<p class="small good-text">Most of your vocab is solid. Time to add new words.</p>` : null}
    </div>
    <input value=${q} placeholder="Search French or English" onInput=${(e) => setQ(e.target.value)} />
    <div class="row gap wrap">
      <select class="select half" onChange=${(e) => setShow(e.target.value)}>
        ${[['all', 'All words'], ['learning', 'In progress'], ['learned', 'Learned'], ['new', 'Not started']].map(([v, l]) => html`<option value=${v} selected=${show === v}>${l}</option>`)}
      </select>
      <select class="select half" onChange=${(e) => setSort(e.target.value)}>
        ${SORTS.map(([v, l]) => html`<option value=${v} selected=${sort === v}>${l}</option>`)}
      </select>
    </div>
    <p class="small muted">${list.length} words</p>
    <div class="word-list">
      ${list.map((v) => html`<button class="word-row" onClick=${() => setOpen(v)}>
        <i class="dot" style=${`background:${dotColor(v)}`} />
        <span class="wtext"><b>${v.french}</b><span class="muted">${v.english}</span></span>
        ${v.seen ? html`<span class="chip">${isLearned(v) ? 'Learned' : `${run(v)}/${LEARNED_RUN}`}</span>` : null}
      </button>`)}
    </div>
    <${AddWords} open=${adding} onClose=${() => setAdding(false)} />
    <${WordSheet} word=${open} onClose=${() => setOpen(null)} />
  </div>`;
}

function WordSheet({ word, onClose }) {
  const [confirm, setConfirm] = useState(false);
  if (!word) return null;
  const v = word;
  return html`<${Sheet} open=${true} onClose=${() => { setConfirm(false); onClose(); }} title="Word">
    <div class="row between"><p class="lemma">${v.french}</p><${SpeakerButton} text=${v.french} /></div>
    <p class="meaning">${v.english}</p>
    <div class="stats">
      <div><span class="label">Progress</span><b>${isLearned(v) ? 'Learned' : `${run(v)}/${LEARNED_RUN}`}</b></div>
      <div><span class="label">Seen</span><b>${v.seen}</b><span class="small muted">${v.missed} missed</span></div>
    </div>
    <p class="small muted">Added ${relTime(v.added)}${v.lastSeen ? ' · last practiced ' + relTime(v.lastSeen) : ''}${v.chatUses ? ` · used ${v.chatUses}× in conversation` : ''}</p>
    ${confirm
      ? html`<div class="row gap"><button class="btn soft grow" onClick=${() => setConfirm(false)}>Keep</button>
          <button class="btn danger-btn grow" onClick=${() => { store.vocab = store.vocab.filter((x) => x.id !== v.id); store.save('vocab'); setConfirm(false); onClose(); }}>Delete word</button></div>`
      : html`<button class="link danger" onClick=${() => setConfirm(true)}>Delete this word…</button>`}
  </${Sheet}>`;
}

function parse(text) {
  const out = [];
  for (const line of text.split(/\n/)) {
    for (const sep of ['\t', ' ; ', ';', ' - ', ' = ', ',']) {
      const i = line.indexOf(sep);
      if (i >= 0) { out.push({ french: line.slice(0, i), english: line.slice(i + sep.length) }); break; }
    }
  }
  return out;
}

function AddWords({ open, onClose }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function images(files) {
    setBusy(true);
    let found = 0, added = 0;
    for (const f of files) {
      try {
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
        const pairs = await extractVocab(b64, f.type || 'image/png');
        found += pairs.length;
        added += store.addPairs(pairs);
        setStatus(`Read ${found} pairs, added ${added} new.`);
      } catch (e) { setStatus('Error: ' + e.message); }
    }
    setBusy(false);
  }
  return html`<${Sheet} open=${open} onClose=${() => { setStatus(''); onClose(); }} title="Add words">
    <p class="small muted">One pair per line, for example: le chat ; the cat. Tab, dash, equals and comma also work.</p>
    <textarea rows="6" value=${text} onInput=${(e) => setText(e.target.value)} placeholder="le chat ; the cat" />
    <button class="btn brand" disabled=${!trim(text)} onClick=${() => { const p = parse(text); const n = store.addPairs(p); setStatus(`Parsed ${p.length} lines, added ${n} new.`); setText(''); }}>Add pasted lines</button>
    <label class="btn soft file-btn">${busy ? 'Reading screenshots…' : 'Import Babbel screenshots'}
      <input type="file" accept="image/*" multiple hidden onChange=${(e) => images([...e.target.files])} disabled=${busy} />
    </label>
    ${status ? html`<p class="small">${status}</p>` : null}
  </${Sheet}>`;
}

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function GrammarView() {
  useWatch();
  const [level, setLevel] = useState('A1');
  const [hideKnown, setHideKnown] = useState(false);
  const [topic, setTopic] = useState(null);
  const scope = GRAMMAR.filter((t) => t.level === level);
  const known = scope.filter((t) => store.isKnown(t)).length;
  const groups = [];
  for (const t of scope) {
    if (hideKnown && store.isKnown(t)) continue;
    let g = groups.find((x) => x.name === t.category);
    if (!g) groups.push((g = { name: t.category, items: [] }));
    g.items.push(t);
  }
  function toggle(t) {
    const id = topicID(t);
    if (store.grammar[id] != null) delete store.grammar[id];
    else store.grammar[id] = now();
    store.save('grammar');
  }
  return html`<div class="grammar">
    <p class="small muted">Tick a topic once you've learned it. Flashcards, readings and conversations only use grammar you've ticked.</p>
    <div class="seg">${LEVELS.map((l) => html`<button class=${l === level ? 'on' : ''} onClick=${() => setLevel(l)}>${l}</button>`)}</div>
    <div class="row between"><b>${known} of ${scope.length} in ${level}</b>
      <label class="small row gap"><input type="checkbox" class="cb" checked=${hideKnown} onChange=${(e) => setHideKnown(e.target.checked)} /> Hide ticked</label></div>
    ${groups.map((g) => html`<div class="card">
      <h3>${g.name}</h3>
      ${g.items.map((t) => html`<div class="topic">
        <input type="checkbox" class="cb" checked=${store.isKnown(t)} onChange=${() => toggle(t)} />
        <button class="link left" onClick=${() => setTopic(t)}><span>${t.title}</span><span class="small muted ex">${t.example}</span></button>
      </div>`)}
    </div>`)}
    <${LessonSheet} topic=${topic} onClose=${() => setTopic(null)} />
  </div>`;
}

function LessonSheet({ topic, onClose }) {
  useWatch();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const id = topic ? topicID(topic) : null;
  async function load() {
    setBusy(true); setErr(null);
    try { store.lessons[id] = await lesson(topic); store.save('lessons'); } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  useEffect(() => { setErr(null); if (topic && !store.lessons[id]) load(); }, [id]);
  if (!topic) return null;
  const text = store.lessons[id];
  return html`<${Sheet} open=${true} onClose=${onClose} title=${topic.title}>
    <p class="small muted">${topic.level} · ${topic.category}</p>
    ${text ? html`<${Paragraphs} text=${text} />` : busy ? html`<${Spinner} text="Writing the lesson..." />` : null}
    ${err ? html`<p class="error">${err}</p><button class="btn soft" onClick=${load}>Try again</button>` : null}
    <label class="toggle"><span>I know this topic</span><input type="checkbox" checked=${store.isKnown(topic)} onChange=${() => {
      if (store.grammar[id] != null) delete store.grammar[id]; else store.grammar[id] = now();
      store.save('grammar');
    }} /></label>
  </${Sheet}>`;
}
