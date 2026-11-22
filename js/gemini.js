// Gemini client and every prompt the app uses. Prompts are copied from the Mac app so cards, grading,
// readings and conversations behave the same on both devices.
import { settings, store, grammarBlock, weightedSample, isLearned, isOverdue, ERROR_TAGS, level, run } from './store.js';
import { normalize, shuffle, sleep, uuid, trim } from './util.js';

export class GeminiError extends Error {
  constructor(message, code = 0) { super(message); this.code = code; }
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

function key() {
  const k = trim(settings.get('geminiKey'));
  if (!k) throw new GeminiError('No Gemini API key. Add one in Settings.');
  return k;
}

export async function postGenerate(body, { model, timeout = 150000 } = {}) {
  const name = model || settings.get('model') || 'gemini-3.8-flash';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(BASE + encodeURIComponent(name) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new GeminiError(e.name === 'AbortError' ? 'The request timed out.' : 'Network error. Check your connection.', -1);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error.message || text; } catch {}
    if (res.status === 429) throw new GeminiError('Rate limit hit (free tier). Wait a minute and try again. ' + msg, 429);
    throw new GeminiError(`Gemini error ${res.status}: ${msg}`, res.status);
  }
  return JSON.parse(text);
}

const transient = (e) => e.code === 429 || e.code >= 500 || e.code === -1;

async function withRetry(op) {
  let attempt = 0;
  for (;;) {
    try { return await op(); } catch (e) {
      attempt++;
      if (attempt > 2 || !transient(e)) throw e;
      await sleep(attempt === 1 ? 2000 : 5000);
    }
  }
}

/** Text generation. Tries low thinking effort first (faster), falls back if the model rejects it. */
export async function generate(prompt, { temperature = 0.7, json = true, parts: extra = [] } = {}) {
  const send = async (low) => {
    const config = { temperature };
    if (json) config.responseMimeType = 'application/json';
    if (low) config.thinkingConfig = { thinkingLevel: 'low' };
    const obj = await postGenerate({ contents: [{ parts: [{ text: prompt }, ...extra] }], generationConfig: config });
    const parts = obj.candidates?.[0]?.content?.parts;
    if (!parts) throw new GeminiError('Unexpected response format (possibly blocked or empty).');
    return parts.map((p) => p.text || '').join('');
  };
  try {
    return await withRetry(() => send(true));
  } catch (e) {
    if (e.code === 400 && /think/i.test(e.message)) return await withRetry(() => send(false));
    throw e;
  }
}

function cleanJSON(t) {
  t = trim(t);
  if (t.startsWith('```')) t = trim(t.replace(/```json/g, '').replace(/```/g, ''));
  return JSON.parse(t);
}
function asList(t) {
  const v = cleanJSON(t);
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const x of Object.values(v)) if (Array.isArray(x)) return x;
  throw new Error('not a list');
}

async function generateJSON(prompt, temperature, parse, opts = {}) {
  let last = new GeminiError('The AI returned something unreadable. Try again.');
  for (let i = 0; i < 2; i++) {
    const text = await generate(prompt, { temperature, ...opts });
    try { return parse(text); } catch { last = new GeminiError('Could not parse the AI response.'); }
  }
  throw last;
}

// ---------- Cards ----------

export async function makeCards({ count = 5, direction = 'mixed', avoid = [] } = {}) {
  const vocab = store.vocab;
  const patterns = store.weakPatterns(4);
  const rules = store.grammarRules();
  const lvl = level();
  const active = vocab.filter((v) => !isLearned(v));
  const dueLearned = vocab.filter(isOverdue).sort((a, b) => (a.lastSeen ?? -1e12) - (b.lastSeen ?? -1e12));
  let focus;
  if (active.length >= 5) {
    const spot = dueLearned.slice(0, dueLearned.length > 10 ? 2 : 1);
    focus = [...weightedSample(active, 6 - spot.length), ...spot];
  } else {
    const spot = dueLearned.slice(0, 2);
    const rest = vocab.filter((v) => !spot.some((s) => s.id === v.id));
    focus = [...spot, ...weightedSample(rest, Math.min(6 - spot.length, rest.length))];
  }
  const focusIDs = new Set(focus.map((v) => v.id));
  const others = shuffle(vocab.filter((v) => !focusIDs.has(v.id))).slice(0, 250);
  const focusList = focus.map((v, i) => `F${i + 1}: ${v.french} = ${v.english}`).join('\n');
  const otherList = others.map((v) => `${v.french} = ${v.english}`).join('; ');
  const patternBlock = !patterns.length ? '' :
    "LEARNER'S RECURRING MISTAKES (make at least 2 of the sentences exercise these patterns, using the words above):\n" +
    patterns.map((p) => '- ' + p).join('\n') + '\n';
  const grammarRule = !rules.blocked.length ? '' :
    '\n- In "grammar", list the exact titles from the not-yet-studied list that the sentence would need (use [] if none). Re-read each sentence and be strict: any sentence that lists a title is discarded.';
  const avoidBlock = !avoid.length ? '' :
    'ALREADY USED SENTENCES (do not repeat or closely paraphrase any of these):\n' + avoid.map((a) => '- ' + a).join('\n') + '\n';

  const prompt = `You are a French tutor writing practice sentences for an English-speaking learner at CEFR level ${lvl}.

FOCUS WORDS (every sentence must use at least one of these):
${focusList}

OTHER KNOWN WORDS (use freely):
${otherList}

${patternBlock}
${grammarBlock(rules)}
${avoidBlock}
Rules:
- Write ${count} natural French sentences, 4 to 12 words each.
- Build them from the focus words and known words, plus very common function words (pronouns, articles, prepositions, conjunctions, etre, avoir, aller, faire). Avoid other new vocabulary.
- Everyday, practical situations. Vary subjects and sentence types (statements, questions, negatives).
- Tenses and structures: obey the GRAMMAR LIMITS section exactly.
- Give a natural English translation for each.
- In "targets", list the codes (for example "F1", "F4") of the focus words used in that sentence. A focus word may appear conjugated or with a different article.${grammarRule}

Return only a JSON array: [{"french": "...", "english": "...", "targets": ["F1"], "grammar": []}]`;

  const blocked = new Set(rules.blocked.map(normalize));
  let cards = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await generateJSON(prompt, 0.9, asList);
    cards = generated.map((g) => {
      const f = trim(g.french), e = trim(g.english);
      if (!f || !e) return null;
      if ((g.grammar || []).some((x) => blocked.has(normalize(x)))) return null;
      let ids = [];
      for (const t of g.targets || []) {
        const code = trim(String(t)).toUpperCase();
        const n = parseInt(code.slice(1), 10);
        if (!code.startsWith('F') || !(n >= 1 && n <= focus.length)) continue;
        const id = focus[n - 1].id;
        if (!ids.includes(id)) ids.push(id);
      }
      if (!ids.length) {
        const padded = ' ' + normalize(f) + ' ';
        ids = focus.filter((v) => padded.includes(' ' + normalize(v.french) + ' ')).map((v) => v.id);
      }
      let dir = direction;
      if (dir === 'mixed') dir = Math.random() < 0.5 ? 'frToEn' : 'enToFr';
      return { id: uuid(), french: f, english: e, direction: dir, targetIDs: ids };
    }).filter(Boolean);
    if (cards.length >= 2) break;
  }
  return cards;
}

export const prompt = (c) => (c.direction === 'enToFr' ? c.english : c.french);
export const reference = (c) => (c.direction === 'enToFr' ? c.french : c.english);

export async function judge(card, answer, { typed = false, focus = [] } = {}) {
  const lvl = level();
  const task = card.direction === 'frToEn'
    ? 'The learner saw a French sentence and translated it into English.'
    : 'The learner saw an English sentence and translated it into French.';
  const typedNote = typed
    ? 'The French answer was TYPED. Ignore punctuation and capitalization, but a missing or wrong accent is a spelling mistake: use verdict partial (not correct) and the tag spelling or accents.'
    : 'The answer may come from speech recognition. Ignore punctuation, capitalization, missing accents, and small transcription artifacts.';
  const spokenFrench = !typed && card.direction === 'enToFr';
  const pronunciationRule = spokenFrench
    ? '\n- Pronunciation: if the words and meaning are right (counting homophones as right) but the transcription shows an audible slip, such as a similar-sounding word that is NOT pronounced the same (for example rue heard as roue), or a dropped or added sound in an ending or liaison, use verdict "pronunciation" and say in the feedback which word to work on and how it should sound. Do not use "pronunciation" for a wrong word, a grammar error, or a mere homophone.'
    : '';
  const verdictChoices = spokenFrench ? '"correct" | "partial" | "incorrect" | "pronunciation"' : '"correct" | "partial" | "incorrect"';
  const homophoneRule = "\n- SPOKEN ANSWER: this is speech recognition output, so the spelling is the recognizer's guess. If a word sounds the same, or nearly the same, as the correct word but is spelled differently (for example ou/où, a/à, sont/son, ces/ses/c'est, mer/mère/maire, vers/vert/verre, parle/parles/parlent, et/est, their/there), treat it as correct. The learner may well have said the right one.";
  const speechRules = typed ? '' : homophoneRule + pronunciationRule;
  const focusNote = !focus.length ? '' : `

Focus words in this sentence: ${focus.join('; ')}.
In "wrongWords", list ONLY the focus words (copied exactly as written above) that the learner mistranslated, misused, or left out. Use an empty array if every focus word was handled correctly or the error is elsewhere in the sentence.
`;
  const p = `You are grading a French learner (CEFR ${lvl}). ${task}

Sentence shown: ${prompt(card)}
Reference translation: ${reference(card)}
Learner's answer: ${answer}
${focusNote}
Notes:
- ${typedNote}
- Accept any valid alternative translation, not just the reference.
- "correct": meaning fully conveyed with acceptable grammar.
- "partial": mostly right but with a meaning error, a wrong word, or a grammar error worth fixing.
- "incorrect": meaning missing or wrong.${speechRules}
- For answers in French, check grammar, agreement, and word choice.

Error tags: if the verdict is not "correct", choose 1 to 3 tags from this fixed list that describe HOW the learner went wrong: ${ERROR_TAGS.join(', ')}. Use an empty array when correct or when the verdict is pronunciation.

Return only JSON: {"verdict": ${verdictChoices}, "feedback": "one short sentence in English naming the specific issue or confirming it", "better": "the best natural translation (omit if the answer was already ideal)", "errors": ["tag"], "detail": "one short phrase naming the exact slip, for example: wrote 'le maison' instead of 'la maison' (omit if correct)", "wrongWords": ["focus word"], "cue": "ONLY when the verdict is partial: one short hint in English that points to WHERE the slip is (for example: check the gender of the noun, or: the verb ending does not match the subject) WITHOUT giving the corrected word or any part of the answer. Omit otherwise."}`;
  return generateJSON(p, 0.2, (t) => {
    const j = cleanJSON(t);
    if (!j.verdict) throw new Error('no verdict');
    return j;
  });
}

/** Follow-up question about a card. */
export async function explainCard(card, answer, j, history) {
  const direction = card.direction === 'frToEn'
    ? 'French sentence shown, learner translated to English'
    : 'English sentence shown, learner translated to French';
  const question = [...history].reverse().find((m) => m.isUser)?.text || '';
  const prior = history.slice(0, -1).map((m) => (m.isUser ? 'Learner: ' : 'Tutor: ') + m.text).join('\n');
  const patterns = store.weakPatterns(4);
  const grading = j
    ? `Learner's answer: ${answer}\nGrading given: ${j.verdict}. ${j.feedback}`
    : 'The learner has NOT answered yet. Give only the small hint or clarification they ask for. Do not reveal the full reference translation unless they explicitly ask for it.';
  const p = `You are a friendly, precise French tutor. The learner is an English speaker at CEFR level ${level()} who just finished a flashcard and has a follow-up question.

Card: ${direction}
Sentence shown: ${prompt(card)}
Reference translation: ${reference(card)}
${grading}

Learner's recurring mistakes (mention them only when relevant to the question):
${patterns.length ? patterns.map((x) => '- ' + x).join('\n') : '(none recorded)'}

Conversation so far:
${prior || '(none)'}

Learner's question: ${question}

Answer in English. Be concise (under 120 words unless they ask for more detail). Explain the grammar or vocabulary reason behind the answer. Include one or two short French examples with translations when they help. Plain text; use **bold** only for key French words. No greeting or preamble.`;
  return trim(await generate(p, { temperature: 0.4, json: false }));
}

// ---------- Reading ----------

export async function makeText(topic) {
  const vocab = store.vocab;
  const learning = vocab.filter((v) => !isLearned(v) && v.seen > 0);
  const targets = weightedSample(learning.length ? learning : vocab, Math.min(6, vocab.length));
  const tIDs = new Set(targets.map((v) => v.id));
  const known = vocab.filter((v) => !tIDs.has(v.id)).sort((a, b) => run(b) - run(a)).slice(0, 300);
  const topicLine = trim(topic) ? `Topic: ${topic}` : 'Pick a simple everyday topic.';
  const p = `Write a short French reading text for an English-speaking learner at CEFR level ${level()}.

${topicLine}

Words to recycle (use EACH of these at least twice, in different sentences):
${targets.map((v) => `${v.french} = ${v.english}`).join('; ')}

Known vocabulary (build the rest of the text from these):
${known.map((v) => `${v.french} = ${v.english}`).join('; ')}

${grammarBlock(store.grammarRules())}
Rules:
- 120 to 170 words.
- Write varied, fuller sentences, not a list of short simple ones. Join ideas with connectors (et, mais, parce que, alors, quand, donc, puis, pourtant), add details with adjectives, adverbs and prepositional phrases, and mix sentence lengths. Stay inside the grammar limits: complexity comes from combining what is allowed, never from grammar that is not allowed.
- Include 4 to 6 new nouns that are NOT in either list but are among the most common nouns in everyday French (the kind a native speaker uses daily, such as household items, places, food, time, work, weather). Use each one in a context that makes its meaning guessable. No rare, technical or literary nouns.
- Apart from those new nouns, build the text from the two lists above and very common function words.
- Provide a faithful English translation.
- Add 3 short comprehension questions in simple French about the text, each with a short answer in French.

Return only JSON: {"title": "French title", "french": "the text", "english": "the translation", "questions": [{"q": "question in French", "a": "short answer in French"}]}`;
  return generateJSON(p, 0.8, (t) => {
    const j = cleanJSON(t);
    if (!j.french) throw new Error('no text');
    return j;
  });
}

export async function translateWord(word, passage) {
  const p = `A learner of French tapped the word "${word}" in this passage.

Passage: ${passage}

Give the dictionary form (the infinitive for verbs, the singular for nouns together with its article, for example "le chat") and its English meaning as used in this passage. If the tapped word is an inflected or contracted form, say so in one short phrase (for example "present tense of vouloir"). Otherwise leave the note empty.

Return only JSON: {"lemma": "...", "english": "...", "note": "..."}`;
  return generateJSON(p, 0.1, cleanJSON);
}

// ---------- Conversations ----------

export async function converse({ scenario, turns, known, focus }) {
  const knownList = known.map((v) => `${v.french} = ${v.english}`).join('; ');
  const focusList = focus.map((v) => `${v.french} = ${v.english}`).join('; ');
  const recent = turns.slice(-14);
  const lastUser = recent.length && recent[recent.length - 1].isUser ? recent[recent.length - 1].french : null;
  const earlier = lastUser == null ? recent : recent.slice(0, -1);
  const transcript = earlier.map((t) => (t.isUser ? 'Learner: ' : 'You: ') + t.french).join('\n');
  const latest = lastUser != null ? `Learner's latest message: ${lastUser}` : 'The learner has not said anything yet. You open the conversation.';
  const scenarioLine = !scenario
    ? 'Open conversation: respond naturally to whatever the learner says and keep it interesting.'
    : `Scenario: ${scenario}. Play the other person in this situation. If the learner has not spoken yet, you speak first.`;
  const p = `You are a real person chatting with a French learner (CEFR level ${level()}): a friendly, curious French-speaking friend with your own small life, opinions and experiences. This is a genuine human conversation that happens to be in simple French. It is not a drill, a quiz or a vocabulary exercise.

${scenarioLine}

COHERENCE COMES FIRST. Every reply must make sense as a response to what the learner just said:
- Read the learner's message and react to its actual content first (agree, be surprised, share a quick related detail about yourself, joke gently). Then, only if it feels natural, ask one follow-up question about what THEY said.
- Never change the subject, never ask something unrelated to the last message, and never say something random just to use a word. If a message has small errors, understand the intended meaning and answer that.
- Do not ask a question in every reply. Mix statements, reactions, opinions and questions the way a friend would. Do not interrogate.
- Keep one consistent identity and a consistent set of facts about yourself across the conversation (look at what "You" already said). Do not contradict earlier turns.
- When opening with no scenario given, greet them naturally and ask one simple, common opener (how they are, what they did today). Do not invent odd facts about yourself in the first line.
- In a scenario, behave exactly as that person would in that real situation, with believable details and a clear direction toward the goal of the situation.

VOCABULARY (a soft guide, never a reason to be unnatural):
KNOWN WORDS (the learner knows these):
${knownList}

OPTIONAL WORDS the learner is still learning: ${focusList}
Use one of these ONLY if it fits the conversation perfectly. If none fits, use none. Never force one in.

${grammarBlock(store.grammarRules())}

Rules for your reply:
- French only, 1 to 3 short sentences (about 25 words at most), at the learner's level.
- Prefer known words plus very common function words (pronouns, articles, prepositions, conjunctions, etre, avoir, aller, faire). If the known words cannot express a natural reply, use a simpler phrasing or one very common or guessable word (for example a cognate) rather than changing the subject. Never more than one unfamiliar word.
- Obey the GRAMMAR LIMITS exactly.
- Sound like a person texting a friend: warm, relaxed, natural. Never write the learner's side. Never reply in English.
- If the learner wrote English words, answer in French and add the French equivalents to newWords.

Conversation so far:
${transcript || '(nothing yet)'}

${latest}

Analyse the learner's latest message (use null and empty arrays when there is no latest message):
- "correction": if it has a real error in grammar, agreement, word choice or word order, give {"original": "their sentence", "corrected": "the fixed sentence", "note": "one short English sentence naming the slip"}. Ignore capitalization and punctuation. Use null if it is fine.
- "usedCorrectly": words from the KNOWN or WORK-IN lists that the learner used correctly in meaning and form. Write each in the dictionary form exactly as listed.
- "usedIncorrectly": words from those lists that the learner used wrongly. Same form.
- "newWords": French words the learner used correctly that are NOT in those lists, as dictionary forms (nouns with article) with an English meaning. Skip very basic function words.

Return only JSON: {"reply": "...", "correction": null, "usedCorrectly": ["..."], "usedIncorrectly": [], "newWords": [{"french": "...", "english": "..."}]}`;
  return generateJSON(p, 0.7, (t) => {
    const j = cleanJSON(t);
    if (typeof j.reply !== 'string') throw new Error('no reply');
    return j;
  });
}

export async function explainChat(turns, side) {
  const transcript = turns.slice(-16).map((t) => (t.isUser ? 'Learner: ' : 'Friend: ') + t.french).join('\n');
  const question = [...side].reverse().find((m) => m.isUser)?.text || '';
  const prior = side.slice(0, -1).map((m) => (m.isUser ? 'Learner: ' : 'Tutor: ') + m.text).join('\n');
  const p = `You are a friendly, precise French tutor. The learner (English speaker, CEFR level ${level()}) is in the middle of a practice conversation in French and asks a quick side question.

French conversation so far:
${transcript}

Earlier side questions:
${prior || '(none)'}

Learner's question: ${question}

Answer in English, in under 80 words unless asked for more. If they ask how to say something, give the French first, then a one-line note. If they ask what the friend meant, translate it and note any new word. If they ask why something was or was not said, give the grammar or vocabulary reason. Plain text; use **bold** only for key French words. No greeting or preamble.`;
  return trim(await generate(p, { temperature: 0.4, json: false }));
}

// ---------- Conjugation tables ----------

export async function conjugations(requests) {
  const list = requests.map((r, i) => `${i + 1}. ${r.verb} | ${r.tense}`).join('\n');
  const p = `Conjugate each French verb in the requested tense for these six subjects, in this order: je, tu, il, nous, vous, ils.

Rules:
- Write every form WITH its subject pronoun, exactly as written in French: j' before a vowel or mute h (j'aime), and the reflexive pronoun for reflexive verbs (je me lave, tu te laves, il se lave, nous nous lavons, vous vous lavez, ils se lavent).
- Use "il" for the third person singular and "ils" for the third person plural.
- Compound tenses: write the auxiliary and the participle in full, using the masculine form of the participle (nous sommes allés, ils sont allés).
- Subjonctif: write the subject and verb without "que" (je mange, nous mangions).
- Standard modern French. Be exact with accents, irregular stems and spelling changes (manger: nous mangeons; appeler: j'appelle).

Requests (number. verb | tense):
${list}

Return only JSON: [{"id": 1, "forms": ["je ...", "tu ...", "il ...", "nous ...", "vous ...", "ils ..."]}]`;
  const results = await generateJSON(p, 0, asList);
  const out = {};
  for (const r of results) {
    if (Array.isArray(r.forms) && r.forms.length === 6 && r.forms.every((f) => trim(f))) out[r.id] = r.forms.map(trim);
  }
  return out;
}

// ---------- Speech to text (used when the phone's own recognizer is unavailable) ----------

export async function transcribe(wavBase64, lang) {
  const language = lang.startsWith('fr') ? 'French' : 'English';
  const p = `Transcribe exactly what is said in this ${language} audio clip. It is a language learner answering a flashcard, so keep their mistakes as spoken; do not correct grammar or translate. Return only the transcription text, with no quotes or notes. If nothing intelligible is said, return an empty string.`;
  const text = await generate(p, { temperature: 0, json: false, parts: [{ inline_data: { mime_type: 'audio/wav', data: wavBase64 } }] });
  return trim(text).replace(/^"|"$/g, '');
}
