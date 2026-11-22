// Answer checking for the silent drills (no AI calls). Port of the Mac app's DrillCheck.
import { normalize, normalizeStrict, trim } from './util.js';
import { GRAMMAR } from './grammar-data.js';

export const isRight = (v) => v === 'correct' || v === 'typo';

export function distance(a, b) {
  const x = [...a], y = [...b];
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

const compact = (s) => s.replace(/ /g, '');
function stripEnglish(k) {
  for (const a of ['to ', 'the ', 'an ', 'a ']) if (k.startsWith(a)) return k.slice(a.length);
  return k;
}

export function englishAlternatives(meaning) {
  const t = meaning.replace(/\([^)]*\)/g, '');
  const out = [];
  const add = (s) => {
    const k = compact(stripEnglish(normalize(s)));
    if (k && !out.includes(k)) out.push(k);
  };
  add(t);
  for (const p of t.split(/[;/,]/)) add(p);
  return out;
}

export function checkEnglish(answer, meaning) {
  const a = compact(stripEnglish(normalize(answer)));
  if (!a) return 'incorrect';
  const alts = englishAlternatives(meaning);
  if (alts.includes(a)) return 'correct';
  for (const alt of alts) {
    const limit = alt.length >= 9 ? 2 : alt.length >= 4 ? 1 : 0;
    if (limit > 0 && distance(a, alt) <= limit) return 'typo';
  }
  return 'incorrect';
}

const ARTICLES = ['de la ', "de l'", 'du ', 'des ', 'les ', 'le ', 'la ', "l'", 'une ', 'un '];
export function splitArticle(s) {
  const t = trim(s.replace(/’/g, "'")).toLowerCase();
  for (const a of ARTICLES) if (t.startsWith(a)) return { article: a.trim(), rest: t.slice(a.length) };
  return { article: null, rest: t };
}
function articleGroup(a) {
  return { le: 'm', un: 'm', la: 'f', une: 'f', les: 'p', des: 'p', "l'": 'any' }[a] || a;
}

export function checkFrench(answer, expected) {
  if (normalizeStrict(answer) === normalizeStrict(expected)) return 'correct';
  const a = splitArticle(answer), e = splitArticle(expected);
  if (normalizeStrict(a.rest) === normalizeStrict(e.rest)) {
    if (!a.article || !e.article) return 'correct';
    const ga = articleGroup(a.article), ge = articleGroup(e.article);
    return ga === ge || ga === 'any' || ge === 'any' ? 'correct' : 'wrongArticle';
  }
  if (normalize(a.rest) === normalize(e.rest)) return 'accents';
  return 'incorrect';
}

export function message(v, expected, skipped) {
  switch (v) {
    case 'correct': return { title: 'Correct', detail: expected };
    case 'typo': return { title: 'Correct, watch the spelling', detail: 'Spelling: ' + expected };
    case 'accents': return { title: 'Check the accents', detail: 'Answer: ' + expected };
    case 'wrongArticle': return { title: 'Wrong article', detail: 'Answer: ' + expected };
    default: return { title: skipped ? 'Skipped' : 'Not quite', detail: 'Answer: ' + expected };
  }
}

export function tag(v, skipped) {
  if (skipped) return 'vocabulary not known';
  if (v === 'accents') return 'spelling or accents';
  if (v === 'wrongArticle') return 'noun gender or article';
  return 'wrong word';
}

export function gender(french) {
  const s = splitArticle(french);
  if (!s.article || !s.rest) return null;
  const g = articleGroup(s.article);
  if (g === 'm') return { gender: 'm', bare: s.rest };
  if (g === 'f') return { gender: 'f', bare: s.rest };
  return null;
}

export function genderTip(bare, g) {
  const b = bare.toLowerCase();
  for (const e of ['tion', 'sion', 'xion', 'ette', 'ance', 'ence', 'ure', 'ise', 'té']) {
    if (b.endsWith(e)) return `Nouns ending in -${e} are usually feminine.` + (g === 'f' ? '' : ' This one is an exception.');
  }
  for (const e of ['ment', 'isme', 'eau', 'ier', 'oir', 'age']) {
    if (b.endsWith(e)) return `Nouns ending in -${e} are usually masculine.` + (g === 'm' ? '' : ' This one is an exception.');
  }
  return null;
}

export function isVerb(v) {
  let f = trim(v.french).toLowerCase().replace(/’/g, "'");
  if (f.startsWith('se ')) f = f.slice(3); else if (f.startsWith("s'")) f = f.slice(2);
  if (f.includes(' ')) return false;
  const ends = f.endsWith('er') || f.endsWith('ir') || f.endsWith('re') || f.endsWith('oir');
  return ends && trim(v.english).toLowerCase().startsWith('to ');
}

export const TENSES = [
  { name: 'Présent', unlock: [] },
  { name: 'Passé composé', unlock: ['Passé composé with avoir', 'Passé composé with être'] },
  { name: 'Imparfait', unlock: ['Imparfait (formation)'] },
  { name: 'Futur simple', unlock: ['Futur simple (regular verbs)', 'Futur simple (irregular stems)'] },
  { name: 'Conditionnel présent', unlock: ['Conditionnel présent (politeness, wishes)'] },
  { name: 'Subjonctif présent', unlock: ['Subjonctif présent (formation)'] },
];

export function studiedTenses(store) {
  const studied = TENSES.filter((t) => !t.unlock.length || GRAMMAR.some((g) => t.unlock.includes(g.title) && store.isKnown(g)));
  return studied.length ? studied : [TENSES[0]];
}

export const conjKey = (verb, tense) => normalize(verb) + '|' + tense;

/** Splits "j'ai mangé" into ("j'", "ai mangé") and "tu manges" into ("tu", "manges"). */
export function conjParts(form) {
  const f = trim(form.replace(/’/g, "'"));
  const i = [...f].findIndex((c) => c === ' ' || c === "'");
  if (i < 0) return { label: '', rest: f };
  if (f[i] === "'") return { label: f.slice(0, i + 1), rest: f.slice(i + 1) };
  return { label: f.slice(0, i), rest: trim(f.slice(i + 1)) };
}
export function conjLabel(form) {
  const l = conjParts(form).label.toLowerCase();
  return l === 'il' ? 'il / elle' : l === 'ils' ? 'ils / elles' : conjParts(form).label;
}

export function checkConj(answer, form) {
  const { rest: expected } = conjParts(form);
  const label = conjLabel(form).toLowerCase();
  let t = trim(answer.replace(/’/g, "'")).toLowerCase();
  const options = [t];
  for (const p of [label, 'il', 'elle', 'on', 'ils', 'elles', 'je', "j'", 'tu', 'nous', 'vous']) {
    const prefix = p.endsWith("'") ? p : p + ' ';
    if (t.startsWith(prefix)) { t = t.slice(prefix.length); options.push(t); break; }
  }
  if (options.some((o) => normalizeStrict(o) === normalizeStrict(expected))) return 'correct';
  if (options.some((o) => normalize(o) === normalize(expected))) return 'accents';
  return 'incorrect';
}
