// App data and learning logic. A direct port of the Mac app's AppStore, Mistakes, Stats and Grammar logic,
// so a word or mistake behaves the same on both devices.
import { now, DAY, uuid, normalize, dayKey, shuffle } from './util.js';
import { GRAMMAR } from './grammar-data.js';

export const DOCS = ['vocab', 'mistakes', 'grammar', 'lessons', 'history', 'stats', 'readings', 'conversations', 'conjugations'];
const EMPTY = {
  vocab: [], mistakes: [], grammar: null, lessons: {}, history: [], stats: {},
  readings: [], conversations: [], conjugations: {},
};

// ---------- Vocab rules ----------

export const LEARNED_RUN = 6;
export const GAPS = [0, 600, 20 * 3600, 2 * DAY, 4 * DAY, 7 * DAY];
export const CHAT_WEIGHT = 0.5;

export const run = (v) => v.streak ?? (v.missed === 0 ? v.seen : 0);
export const isLearned = (v) => run(v) >= LEARNED_RUN;
const revisitDays = (v) => 14 * Math.pow(2, Math.min(Math.max(run(v) - LEARNED_RUN, 0), 4));
export function dueAt(v) {
  const base = v.stepAt ?? v.lastSeen ?? -1e12;
  if (isLearned(v)) return base + revisitDays(v) * DAY;
  return base + GAPS[Math.min(Math.max(run(v), 0), GAPS.length - 1)];
}
export const isDue = (v) => now() >= dueAt(v);
export const isOverdue = (v) => isLearned(v) && isDue(v);
export function weight(v) {
  if (isLearned(v)) return 0.12;
  if (!isDue(v)) return 0.05;
  return 1 + (3 * (v.missed + 1)) / (v.seen + 2);
}
function creditStep(v) {
  if (now() < dueAt(v)) return false;
  v.streak = run(v) + 1;
  v.stepAt = now();
  return true;
}
function lapse(v) {
  v.streak = Math.floor(run(v) / 2);
  v.stepAt = now();
}

export function weightedSample(items, count) {
  const pool = [...items];
  const out = [];
  while (out.length < count && pool.length) {
    const total = pool.reduce((s, x) => s + weight(x), 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= weight(pool[i]);
      if (r < 0) { idx = i; break; }
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** Matching key for a French word: accents, case, apostrophes and a leading article are ignored. */
export function vocabKey(s) {
  let t = normalize((s || '').replace(/’/g, "'").replace(/'/g, ' '));
  for (const a of ['de la ', 'le ', 'la ', 'les ', 'l ', 'un ', 'une ', 'des ', 'du ']) {
    if (t.startsWith(a)) { t = t.slice(a.length); break; }
  }
  return t;
}

export const ERROR_TAGS = [
  'noun gender or article', 'verb conjugation', 'verb tense', 'subject-verb agreement',
  'adjective agreement', 'word order', 'wrong word', 'missing word', 'extra word',
  'vocabulary not known', 'preposition', 'negation', 'pronoun', 'spelling or accents',
  'misheard (listening)', 'meaning reversed', 'other',
];
const LADDER = [120, DAY, 3 * DAY, 7 * DAY, 14 * DAY];

export const isCorrect = (j) => ['correct', 'pronunciation'].includes((j.verdict || '').toLowerCase());
export const isPartial = (j) => (j.verdict || '').toLowerCase() === 'partial';

// ---------- Store ----------

class Store {
  constructor() {
    this.listeners = new Set();
    this.onSave = null; // set by sync
    for (const n of DOCS) this[n] = this.read(n);
    if (!this.grammar) {
      this.grammar = {};
      for (const t of GRAMMAR) if (t.defaultKnown) this.grammar[topicID(t)] = -63114076800; // distantPast
      this.save('grammar');
    }
    this.rebuildHistory();
  }

  read(name) {
    try {
      const raw = localStorage.getItem('fr.doc.' + name);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn('read', name, e); }
    return structuredClone(EMPTY[name]);
  }

  /** Writes one document locally, tells the UI, and lets sync know it changed. */
  save(name, { fromSync = false } = {}) {
    try { localStorage.setItem('fr.doc.' + name, JSON.stringify(this[name])); } catch (e) { console.warn('save', e); }
    if (name === 'history') this.rebuildHistory();
    if (!fromSync && this.onSave) this.onSave(name);
    this.emit();
  }

  emit() { for (const f of this.listeners) f(); }
  subscribe(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

  // ----- vocab -----
  byID(id) { return this.vocab.find((v) => v.id === id); }

  addPairs(pairs) {
    const known = new Set(this.vocab.map((v) => normalize(v.french)));
    let added = 0;
    for (const p of pairs) {
      const f = (p.french || '').trim(), e = (p.english || '').trim();
      if (!f || !e) continue;
      const k = normalize(f);
      if (known.has(k)) continue;
      known.add(k);
      this.vocab.push({ id: uuid(), french: f, english: e, seen: 0, missed: 0, added: now() });
      added++;
    }
    if (added) this.save('vocab');
    return added;
  }

  inVocab(french) {
    const k = vocabKey(french);
    return !!k && this.vocab.some((v) => vocabKey(v.french) === k);
  }

  recordIDs(ids, correct, { save = true } = {}) {
    for (const id of ids) {
      const v = this.byID(id);
      if (!v) continue;
      v.seen += 1;
      if (correct) creditStep(v);
      else { v.missed += 1; lapse(v); v.chatCredit = 0; }
      v.lastSeen = now();
    }
    if (save) this.save('vocab');
  }

  /** Vocab words in a card's French that are not its focus words. Conjugated verb forms are not matched. */
  incidentalIDs(card) {
    const sentence = ' ' + normalize((card.french || '').replace(/’/g, ' ').replace(/'/g, ' ')) + ' ';
    const targets = new Set(card.targetIDs);
    const out = [];
    for (const v of this.vocab) {
      if (targets.has(v.id)) continue;
      const k = vocabKey(v.french);
      if (k.length >= 2 && sentence.includes(' ' + k + ' ')) out.push(v.id);
    }
    return out;
  }

  /** Credits focus words individually; other known words in the sentence count when the answer is right. */
  recordCard(card, j) {
    const incidental = this.incidentalIDs(card);
    if (isCorrect(j)) { this.recordIDs([...card.targetIDs, ...incidental], true); return; }
    if (j.wrongWords && incidental.length) {
      const keys = new Set(j.wrongWords.map(vocabKey).filter(Boolean));
      const named = incidental.filter((id) => keys.has(vocabKey(this.byID(id)?.french)));
      if (named.length) this.recordIDs(named, false, { save: false });
    }
    if (!isPartial(j) || !j.wrongWords) { this.recordIDs(card.targetIDs, false); return; }
    const keys = new Set(j.wrongWords.map(normalize).filter(Boolean));
    const missed = [], right = [];
    for (const id of card.targetIDs) {
      const v = this.byID(id);
      if (!v) continue;
      (keys.has(normalize(v.french)) ? missed : right).push(id);
    }
    if (keys.size && !missed.length) { this.recordIDs(card.targetIDs, false); return; }
    if (right.length) this.recordIDs(right, true, { save: false });
    if (missed.length) this.recordIDs(missed, false, { save: false });
    this.save('vocab');
  }

  /** Half-step credit for gender and conjugation drills. */
  recordSkill(id, correct) {
    const v = this.byID(id);
    if (!v) return;
    if (correct) {
      let c = (v.chatCredit ?? 0) + CHAT_WEIGHT;
      if (c >= 1) { creditStep(v); c -= 1; }
      v.chatCredit = c;
    } else {
      v.streak = Math.max(0, run(v) - 1);
      v.chatCredit = 0;
    }
    v.lastSeen = now();
    this.save('vocab');
  }

  /** Credits words used in a conversation at half weight. */
  recordChat(correct, wrong) {
    const credited = [], penalized = [], touched = new Set();
    const find = (w) => {
      const k = vocabKey(w);
      return k ? this.vocab.find((v) => vocabKey(v.french) === k) : null;
    };
    for (const w of wrong) {
      const v = find(w);
      if (!v || touched.has(v.id)) continue;
      touched.add(v.id);
      v.streak = Math.max(0, run(v) - 1);
      v.chatCredit = 0;
      penalized.push(v.french);
    }
    for (const w of correct) {
      const v = find(w);
      if (!v || touched.has(v.id)) continue;
      touched.add(v.id);
      v.chatUses = (v.chatUses ?? 0) + 1;
      let c = (v.chatCredit ?? 0) + CHAT_WEIGHT;
      if (c >= 1) { creditStep(v); c -= 1; }
      v.chatCredit = c;
      v.lastSeen = now();
      credited.push(v.french);
    }
    if (touched.size) this.save('vocab');
    return { credited, penalized };
  }

  get learnedCount() { return this.vocab.filter(isLearned).length; }
  get revisitDueCount() { return this.vocab.filter(isOverdue).length; }

  // ----- mistakes -----
  mistakeIndex(french) {
    const k = normalize(french);
    return this.mistakes.findIndex((m) => normalize(m.french) === k);
  }
  targetWords(card) { return card.targetIDs.map((id) => this.byID(id)?.french).filter(Boolean); }

  snapshot(card) {
    const ids = new Set([...card.targetIDs, ...this.incidentalIDs(card)]);
    const i = this.mistakeIndex(card.french);
    return {
      prior: i >= 0 ? structuredClone(this.mistakes[i]) : null,
      vocab: structuredClone(this.vocab.filter((v) => ids.has(v.id))),
    };
  }

  revert(s, card) {
    const i = this.mistakeIndex(card.french);
    if (i >= 0) {
      const notes = this.mistakes[i].notes;
      if (s.prior) { this.mistakes[i] = { ...s.prior, notes }; }
      else if (!notes.length) this.mistakes.splice(i, 1);
      else Object.assign(this.mistakes[i], { misses: 0, resolved: true, tags: [], verdict: 'correct' });
    }
    for (const v of s.vocab) {
      const j = this.vocab.findIndex((x) => x.id === v.id);
      if (j >= 0) this.vocab[j] = v;
    }
    this.save('mistakes');
    this.save('vocab');
  }

  logResult(card, answer, j) {
    const i = this.mistakeIndex(card.french);
    if (isCorrect(j)) {
      if (i < 0) return;
      const m = this.mistakes[i];
      m.attempts += 1;
      if (!m.resolved) {
        m.box += 1;
        if (m.box >= LADDER.length) m.resolved = true;
        else m.due = now() + LADDER[m.box];
      }
      this.save('mistakes');
      return;
    }
    const tags = (j.errors || []).filter(Boolean);
    if (i >= 0) {
      const e = this.mistakes[i];
      Object.assign(e, { date: now(), lastAnswer: answer, verdict: j.verdict, feedback: j.feedback });
      if (j.better) e.better = j.better;
      if (j.detail) e.detail = j.detail;
      for (const t of tags) if (!e.tags.includes(t)) e.tags.push(t);
      Object.assign(e, { box: 0, resolved: false, misses: e.misses + 1, attempts: e.attempts + 1, due: now() + LADDER[0] });
    } else {
      const e = {
        id: uuid(), date: now(), french: card.french, english: card.english, direction: card.direction,
        lastAnswer: answer, verdict: j.verdict, feedback: j.feedback, tags, targets: this.targetWords(card),
        box: 0, due: now() + LADDER[0], attempts: 1, misses: 1, resolved: false, notes: [],
      };
      if (j.better) e.better = j.better;
      if (j.detail) e.detail = j.detail;
      this.mistakes.push(e);
    }
    this.save('mistakes');
  }

  logDrill(card, answer, correct, feedback, better, tag) {
    this.logResult(card, answer, {
      verdict: correct ? 'correct' : 'incorrect', feedback, better,
      errors: correct ? [] : [tag],
    });
  }

  addNote(card, answer, j, question, reply) {
    const note = { id: uuid(), date: now(), question, answer: reply };
    const i = this.mistakeIndex(card.french);
    if (i >= 0) this.mistakes[i].notes.push(note);
    else {
      const e = {
        id: uuid(), date: now(), french: card.french, english: card.english, direction: card.direction,
        lastAnswer: answer, verdict: j?.verdict ?? 'correct', feedback: j?.feedback ?? '', tags: [],
        targets: this.targetWords(card), box: 0, due: now(), attempts: 1, misses: 0, resolved: true, notes: [note],
      };
      if (j?.better) e.better = j.better;
      this.mistakes.push(e);
    }
    this.save('mistakes');
  }

  get dueMistakeCount() { const t = now(); return this.mistakes.filter((m) => !m.resolved && m.due <= t).length; }

  dueMistakes(limit, excluding = new Set()) {
    const t = now();
    return this.mistakes
      .filter((m) => !m.resolved && m.due <= t && !excluding.has(normalize(m.french)))
      .sort((a, b) => a.due - b.due)
      .slice(0, limit);
  }

  cardFromMistake(e) {
    const ids = this.vocab.filter((v) => e.targets.some((t) => normalize(t) === normalize(v.french))).map((v) => v.id);
    return { id: uuid(), french: e.french, english: e.english, direction: e.direction === 'enToFr' ? 'enToFr' : 'frToEn', targetIDs: ids, retryOf: e.id };
  }

  tagCounts(unresolvedOnly = false) {
    const counts = {};
    for (const e of this.mistakes) {
      if (unresolvedOnly && e.resolved) continue;
      for (const t of e.tags) counts[t] = (counts[t] || 0) + Math.max(e.misses, 1);
    }
    return Object.entries(counts).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }

  weakPatterns(limit) {
    return this.tagCounts(true).slice(0, limit).map((t) => {
      const ex = this.mistakes.find((m) => !m.resolved && m.tags.includes(t.tag) && m.detail)?.detail;
      return `${t.tag} (${t.count} times)` + (ex ? `, e.g. ${ex}` : '');
    });
  }

  // ----- history -----
  rebuildHistory() { this.historyKeys = new Set(this.history.map(normalize)); }
  hasSeen(french) { return this.historyKeys.has(normalize(french)); }
  markSeen(french) {
    const k = normalize(french);
    if (this.historyKeys.has(k)) return;
    this.history.push(french);
    if (this.history.length > 3000) this.history.splice(0, this.history.length - 3000);
    this.save('history');
  }

  // ----- stats -----
  stat(d = new Date()) { return this.stats[dayKey(d)] || { cards: 0, correct: 0 }; }
  recordDay(correct) {
    const k = dayKey();
    const s = this.stats[k] || { cards: 0, correct: 0 };
    s.cards += 1;
    if (correct) s.correct += 1;
    this.stats[k] = s;
    this.save('stats');
  }
  recordDayFix() {
    const k = dayKey();
    const s = this.stats[k] || { cards: 0, correct: 0 };
    s.correct = Math.min(s.correct + 1, s.cards);
    this.stats[k] = s;
    this.save('stats');
  }
  streak(goal) {
    const target = Math.max(goal, 1);
    const d = new Date();
    if (this.stat(d).cards < target) d.setDate(d.getDate() - 1);
    let n = 0;
    while (this.stat(d).cards >= target && n < 3650) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ----- grammar -----
  isKnown(t) { return this.grammar[topicID(t)] != null; }
  get derivedLevel() {
    for (const l of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
      const ts = GRAMMAR.filter((t) => t.level === l);
      if (!ts.length) continue;
      if (ts.filter((t) => this.isKnown(t)).length / ts.length < 0.6) return l;
    }
    return 'C2';
  }
  grammarRules() {
    const r = { allowed: [], blocked: [], recent: [] };
    const weekAgo = now() - 7 * DAY;
    for (const t of GRAMMAR) {
      const d = this.grammar[topicID(t)];
      if (d != null) { r.allowed.push(t.title); if (d > weekAgo) r.recent.push(t.title); }
      else r.blocked.push(t.title);
    }
    return r;
  }

  // ----- conversations / readings -----
  sampleKnown(n) { return shuffle(this.vocab).slice(0, n); }
}

export const topicID = (t) => t.level + '|' + t.title;

export function grammarBlock(r) {
  if (!r.allowed.length && !r.blocked.length) return '';
  let s = 'GRAMMAR LIMITS (strict, these override every other rule):\n';
  s += 'The learner has studied ONLY these grammar points: ' + r.allowed.join('; ') + '.\n';
  s += 'Do NOT use any tense, mood, pronoun type, or construction beyond them. These are NOT yet studied and must not appear: ';
  s += r.blocked.join('; ') + '.\n';
  s += 'If a sentence cannot be written within the studied grammar, write a simpler one.\n';
  if (r.recent.length) s += 'RECENTLY LEARNED (feature these in at least 2 sentences): ' + r.recent.join('; ') + '.\n';
  return s;
}

export const store = new Store();

// ----- settings (per device) -----
const SETTINGS_DEFAULTS = {
  geminiKey: '', model: 'gemini-3.8-flash', levelMode: 'Auto', direction: 'mixed', wordDirection: 'mixed',
  autoVoice: true, autoCheck: false, secondTry: true, hideText: false, soundEffects: true,
  naturalVoice: true, ttsModel: 'gemini-3.1-flash-tts-preview', ttsVoice: 'Kore', speechLevel: 1,
  dailyGoal: 20, conjTense: 'mix', syncURL: '', syncKey: '', syncSecret: '',
};
export const settings = {
  get(k) {
    const raw = localStorage.getItem('fr.set.' + k);
    if (raw == null) return SETTINGS_DEFAULTS[k];
    try { return JSON.parse(raw); } catch { return SETTINGS_DEFAULTS[k]; }
  },
  set(k, v) { localStorage.setItem('fr.set.' + k, JSON.stringify(v)); store.emit(); },
};
export const level = () => {
  const m = settings.get('levelMode');
  return m !== 'Auto' ? m : store.derivedLevel;
};
