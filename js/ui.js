// Shared UI pieces.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { store } from './store.js';
import { voiceState, micState, speak, stopSpeaking, unlockAudio } from './audio.js';

export { html };

/** Re-renders the component whenever any of the given observables change. */
export function useWatch(...sources) {
  const [, bump] = useState(0);
  useEffect(() => {
    const offs = (sources.length ? sources : [store]).map((s) => s.subscribe(() => bump((x) => x + 1)));
    return () => offs.forEach((o) => o());
  }, []);
}

export function Bold({ text }) {
  const parts = (text || '').split(/(\*\*[^*]+\*\*)/g);
  return html`${parts.map((p) => (p.startsWith('**') && p.endsWith('**') ? html`<b>${p.slice(2, -2)}</b>` : p))}`;
}

export function Paragraphs({ text }) {
  return html`<div class="prose">${(text || '').split(/\n+/).filter(Boolean).map((l) => html`<p><${Bold} text=${l} /></p>`)}</div>`;
}

const ACCENTS = ['à', 'â', 'ç', 'é', 'è', 'ê', 'ë', 'î', 'ï', 'ô', 'ù', 'û', 'œ'];
/** A row of accented letters for French typing. Keeps the keyboard up by not stealing focus. */
export function AccentBar({ inputRef, value, onInput }) {
  const [upper, setUpper] = useState(false);
  const insert = (ch) => {
    const el = inputRef.current;
    const c = upper ? ch.toUpperCase() : ch;
    if (!el) return onInput(value + c);
    const s = el.selectionStart ?? value.length, e = el.selectionEnd ?? value.length;
    const next = value.slice(0, s) + c + value.slice(e);
    onInput(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + 1, s + 1); });
    setUpper(false);
  };
  return html`<div class="accents">
    <button class=${'acc' + (upper ? ' on' : '')} onPointerDown=${(e) => { e.preventDefault(); setUpper(!upper); }}>⇧</button>
    ${ACCENTS.map((a) => html`<button class="acc" onPointerDown=${(e) => { e.preventDefault(); insert(a); }}>${upper ? a.toUpperCase() : a}</button>`)}
  </div>`;
}

export function SpeakerButton({ text, lang = 'fr-FR', label }) {
  useWatch(voiceState);
  return html`<button class="icon-btn" aria-label="Listen" onClick=${() => { unlockAudio(); voiceState.speaking ? stopSpeaking() : speak(text, lang, { force: true }); }}>
    ${voiceState.speaking ? '◼' : '🔊'}${label ? html`<span>${label}</span>` : null}
  </button>`;
}

export function MicMeter() {
  useWatch(micState);
  if (!micState.active) return null;
  const n = 5;
  return html`<span class="meter">${Array.from({ length: n }, (_, i) => html`<i style=${`opacity:${micState.level * n > i ? 1 : 0.25}`} />`)}</span>`;
}

export function Sheet({ open, onClose, title, children }) {
  if (!open) return null;
  return html`<div class="sheet-wrap" onClick=${onClose}>
    <div class="sheet" onClick=${(e) => e.stopPropagation()}>
      <div class="sheet-head"><b>${title}</b><button class="link" onClick=${onClose}>Done</button></div>
      <div class="sheet-body">${children}</div>
    </div>
  </div>`;
}

export function Segmented({ options, value, onChange }) {
  return html`<div class="seg">${options.map(([v, label]) => html`<button class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${label}</button>`)}</div>`;
}

export function Notice() {
  useWatch(voiceState);
  return voiceState.notice ? html`<p class="notice">${voiceState.notice}</p>` : null;
}

export function Spinner({ text }) {
  return html`<div class="spinner-wrap"><div class="spinner" /><p class="muted">${text}</p></div>`;
}

/** Text whose words can be tapped for a definition. */
export function TapText({ text, onWord, big }) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  return html`<p class=${'taptext' + (big ? ' big' : '')}>${words.map((w) => html`<span class="tw" onClick=${() => onWord(w)}>${w}</span> `)}</p>`;
}

export function useAutoGrow(ref, value) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [value]);
}

export { useState, useEffect, useRef };
