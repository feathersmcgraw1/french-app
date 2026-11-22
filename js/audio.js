// Voice output (Gemini natural voice with a cache, system voice as fallback) and voice input
// (the phone's recognizer when available, otherwise a recording transcribed by Gemini).
import { settings } from './store.js';
import { postGenerate, transcribe } from './gemini.js';
import { sleep } from './util.js';

let ctx = null;
export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}
/** iOS only allows audio after a tap. Call this from any button handler. */
export function unlockAudio() {
  const c = audioContext();
  if (c.state === 'suspended') c.resume();
  if (!unlockAudio.done) {
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b; s.connect(c.destination); s.start(0);
    unlockAudio.done = true;
  }
}

// ---------- Cache (IndexedDB) ----------
const DB = 'fr-audio';
function db() {
  if (db.p) return db.p;
  db.p = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return db.p;
}
async function cacheGet(k) {
  try {
    const d = await db();
    return await new Promise((res) => {
      const q = d.transaction('clips').objectStore('clips').get(k);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function cachePut(k, v) {
  try {
    const d = await db();
    d.transaction('clips', 'readwrite').objectStore('clips').put(v, k);
  } catch {}
}

// ---------- Speaking ----------
export const LEVEL_NAMES = ['Everyday French', 'Relaxed conversation', 'Slow, like to a child', 'Every word enunciated'];
const STYLES = [
  'Say in French exactly as a native speaker would in everyday life: natural speed and rhythm, natural liaisons and elisions, relaxed and unhurried but not slowed down, no exaggerated articulation',
  'Say in French in a relaxed, clear, conversational voice at a calm pace slightly slower than normal, with natural intonation and clean pronunciation',
  'Say in French slowly and clearly, the way a patient, friendly adult speaks to a young child learning the language: gentle warm tone, every word easy to pick out, short pauses between phrases',
  'Say in French very slowly with careful, deliberate enunciation: pronounce every single word and syllable distinctly with crisp consonants and fully voiced vowels, and a short pause between each word',
];
const RATES = [1.0, 0.92, 0.78, 0.62];

const lvl = () => Math.min(3, Math.max(0, Math.round(settings.get('speechLevel'))));
const cacheKey = (text) => `${settings.get('ttsModel')}|${settings.get('ttsVoice')}|${lvl()}|${text}`;

const state = { token: 0, source: null, speaking: false, cooldownUntil: 0, inflight: new Map(), listeners: new Set() };
export const voiceState = {
  get speaking() { return state.speaking; },
  notice: null,
  subscribe(f) { state.listeners.add(f); return () => state.listeners.delete(f); },
};
function setSpeaking(v) { state.speaking = v; for (const f of state.listeners) f(); }

async function fetchClip(text) {
  const body = {
    contents: [{ parts: [{ text: `${STYLES[lvl()]}: ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.get('ttsVoice') || 'Kore' } } },
    },
  };
  const obj = await postGenerate(body, { model: settings.get('ttsModel'), timeout: 60000 });
  for (const p of obj.candidates?.[0]?.content?.parts || []) {
    const inline = p.inlineData || p.inline_data;
    if (!inline?.data) continue;
    const mime = inline.mimeType || inline.mime_type || '';
    const m = /rate=(\d+)/.exec(mime);
    return { b64: inline.data, rate: m ? +m[1] : 24000 };
  }
  throw new Error('No audio in the response.');
}

/** Natural audio for a French sentence: cache first, then one request (shared by concurrent callers). */
async function clip(text, { force = false, background = false } = {}) {
  const k = cacheKey(text);
  const hit = await cacheGet(k);
  if (hit) return hit;
  if (state.inflight.has(k)) return state.inflight.get(k);
  if (!force && Date.now() < state.cooldownUntil) return null;
  const p = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const c = await fetchClip(text);
        await cachePut(k, c);
        if (!background) voiceState.notice = null;
        return c;
      } catch (e) {
        const limited = e.code === 429;
        const retry = limited ? attempt === 0 && !background : attempt < 2 && (e.code >= 500 || e.code === -1 || /audio/.test(e.message));
        if (retry) { await sleep(limited ? 4000 : 1000 * (attempt + 1)); continue; }
        state.cooldownUntil = Date.now() + (limited ? 30000 : 10000);
        if (!background) voiceState.notice = limited
          ? 'Natural voice is rate limited, using the system voice for now. It retries on its own.'
          : 'Natural voice unavailable, using the system voice.';
        return null;
      }
    }
    return null;
  })();
  state.inflight.set(k, p);
  const r = await p;
  state.inflight.delete(k);
  return r;
}

function playPCM(c, token) {
  return new Promise((resolve) => {
    const ac = audioContext();
    const bin = atob(c.b64);
    const n = bin.length >> 1;
    const buf = ac.createBuffer(1, n, c.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let s = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (s >= 0x8000) s -= 0x10000;
      ch[i] = s / 32768;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.onended = () => resolve(true);
    if (token !== state.token) return resolve(false);
    state.source = src;
    src.start();
  });
}

function bestVoice(lang) {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  return vs.find((v) => /premium|enhanced/i.test(v.name)) || vs.find((v) => v.lang === lang) || vs[0] || null;
}
function speakSystem(text, lang, token) {
  return new Promise((resolve) => {
    if (token !== state.token || !('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = bestVoice(lang);
    if (v) u.voice = v;
    if (lang.startsWith('fr')) u.rate = RATES[lvl()];
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  state.token++;
  try { state.source?.stop(); } catch {}
  state.source = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  setSpeaking(false);
}

/** Resolves when speech has finished, so the mic can open right after. */
export async function speak(text, lang = 'fr-FR', { force = false } = {}) {
  stopSpeaking();
  const token = state.token;
  setSpeaking(true);
  try {
    if (lang.startsWith('fr') && settings.get('naturalVoice')) {
      const c = await clip(text, { force });
      if (token !== state.token) return;
      if (c && (await playPCM(c, token))) return;
    }
    if (token !== state.token) return;
    await speakSystem(text, lang, token);
  } finally {
    if (token === state.token) setSpeaking(false);
  }
}

/** Waits until a sentence's natural audio is ready, so a card can appear together with its voice. */
export async function prepare(text) {
  if (!settings.get('naturalVoice')) return;
  await clip(text);
}

let prefetchQueue = [], prefetchRunning = false;
export function prefetch(texts) {
  if (!settings.get('naturalVoice')) return;
  prefetchQueue = texts.slice(0, 3);
  if (prefetchRunning) return;
  prefetchRunning = true;
  (async () => {
    while (prefetchQueue.length) {
      let waited = 0;
      while (Date.now() < state.cooldownUntil && waited < 40) { await sleep(1000); waited++; }
      const t = prefetchQueue.shift();
      if (t) await clip(t, { background: true });
      await sleep(800);
    }
    prefetchRunning = false;
  })();
}

// ---------- Sound effects ----------
export function chime(ok) {
  if (!settings.get('soundEffects')) return;
  const ac = audioContext();
  const notes = ok ? [660, 880] : [330, 247];
  notes.forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = ac.currentTime + i * 0.12;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.25);
  });
}

// ---------- Listening ----------
const listenState = { active: false, stop: null, level: 0, listeners: new Set() };
export const micState = {
  get active() { return listenState.active; },
  get level() { return listenState.level; },
  subscribe(f) { listenState.listeners.add(f); return () => listenState.listeners.delete(f); },
};
const notifyMic = () => { for (const f of listenState.listeners) f(); };

export function stopListening() { listenState.stop?.(); }

const Native = window.SpeechRecognition || window.webkitSpeechRecognition;
let nativeBroken = false;

/** Listens until you finish speaking, then returns the text ('' if nothing was heard). */
export async function listen(lang = 'fr-FR', opts = {}) {
  stopListening();
  if (Native && !nativeBroken) {
    const r = await listenNative(lang, opts);
    if (r !== null) return r;
  }
  return listenRecorded(lang, opts);
}

function listenNative(lang, { maxWait = 10 } = {}) {
  return new Promise((resolve) => {
    let rec;
    try { rec = new Native(); } catch { nativeBroken = true; return resolve(null); }
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    let text = '', done = false, heard = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listenState.active = false; listenState.stop = null; notifyMic();
      resolve(v);
    };
    const timer = setTimeout(() => { if (!heard) { try { rec.abort(); } catch {} finish(''); } }, maxWait * 1000);
    rec.onresult = (e) => {
      heard = true;
      text = [...e.results].map((r) => r[0].transcript).join(' ');
      listenState.level = 0.6; notifyMic();
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(e.error) && !heard) {
        nativeBroken = true;
        finish(null);
      } else finish(text.trim());
    };
    rec.onend = () => finish(text.trim());
    listenState.active = true;
    listenState.stop = () => { try { rec.stop(); } catch {} };
    notifyMic();
    try { rec.start(); } catch { nativeBroken = true; finish(null); }
  });
}

async function listenRecorded(lang, { silence = 1.6, maxWait = 10, maxLength = 30 } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    voiceState.notice = 'Microphone access was blocked. Allow it in Settings > Safari > Microphone, or type your answer.';
    return '';
  }
  const ac = audioContext();
  if (ac.state === 'suspended') await ac.resume();
  const src = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let noise = 0.008, calib = 0, heard = false, lastVoice = 0, stopped = false;
  const t0 = performance.now();

  const result = await new Promise((resolve) => {
    const end = () => { if (!stopped) { stopped = true; resolve(); } };
    listenState.stop = end;
    proc.onaudioprocess = (e) => {
      if (stopped) return;
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      const t = (performance.now() - t0) / 1000;
      if (t < 0.35) { calib++; noise = Math.max(0.006, (noise * (calib - 1) + rms) / calib); }
      const loud = rms > Math.max(noise * 3, 0.015);
      listenState.level = Math.min(1, rms * 12);
      notifyMic();
      if (loud) { heard = true; lastVoice = t; }
      if (heard && t - lastVoice > silence) end();
      if (!heard && t > maxWait) end();
      if (t > maxLength) end();
    };
    src.connect(proc);
    proc.connect(ac.destination);
    listenState.active = true;
    notifyMic();
  });

  try { proc.disconnect(); src.disconnect(); } catch {}
  stream.getTracks().forEach((t) => t.stop());
  listenState.active = false; listenState.stop = null; listenState.level = 0; notifyMic();
  void result;
  if (!heard) return '';
  try {
    return await transcribe(encodeWAV(chunks, ac.sampleRate), lang);
  } catch (e) {
    voiceState.notice = 'Could not transcribe: ' + e.message;
    return '';
  }
}

function encodeWAV(chunks, rate) {
  const target = 16000;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = rate / target;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, target, true); v.setUint32(28, target * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
