// Shared helpers. Dates are stored the way the Mac app stores them (seconds since 1 Jan 2001),
// and IDs as uppercase UUIDs, so the same JSON can be read by both apps.

export const REF = 978307200;
export const now = () => Date.now() / 1000 - REF;
export const toJS = (s) => new Date((s + REF) * 1000);
export const fromJS = (d) => d.getTime() / 1000 - REF;
export const DAY = 86400;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

/** Lowercase, no accents, letters/digits/spaces only. Matches the Mac app's Tutor.normalize. */
export function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Like normalize but keeps accents, so a missing accent in typed French is noticed. */
export function normalizeStrict(s) {
  return (s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export const trim = (s) => (s || '').trim();

export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function relTime(sec) {
  const d = toJS(sec);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
