// Sync through a free Supabase database. Each data file is one row. A change is pushed a few seconds after it
// happens; on open (and every minute while open) newer copies are pulled. If both devices changed the same file
// since the last sync, the two copies are merged item by item so no practice is lost.
import { store, settings, DOCS } from './store.js';
import { normalize } from './util.js';

const META = 'fr.sync';
const meta = () => { try { return JSON.parse(localStorage.getItem(META)) || {}; } catch { return {}; } };
const saveMeta = (m) => localStorage.setItem(META, JSON.stringify(m));

export const syncState = {
  status: 'off', message: '', last: null, listeners: new Set(),
  subscribe(f) { this.listeners.add(f); return () => this.listeners.delete(f); },
};
function setStatus(status, message = '') {
  syncState.status = status;
  syncState.message = message;
  for (const f of syncState.listeners) f();
}

export const configured = () => !!(settings.get('syncURL') && settings.get('syncKey') && (settings.get('syncSecret') || '').length >= 16);

async function rpc(fn, body) {
  const url = settings.get('syncURL').replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
  const key = settings.get('syncKey');
  const res = await fetch(url, {
    method: 'POST',
    // New-style publishable keys (sb_publishable_...) go only in apikey; older JWT anon keys also go in Authorization.
    headers: { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sync error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Merging ----------

const activity = (v) => [(v.seen || 0) + (v.missed || 0), v.chatUses || 0, v.stepAt ?? -1e12, v.lastSeen ?? -1e12];
function newer(a, b, key) {
  const x = key(a), y = key(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
  return a;
}
function mergeList(local, remote, { id = (x) => x.id, alt, pick }) {
  const out = [];
  const index = new Map(), altIndex = new Map();
  const put = (x) => {
    const i = out.length;
    out.push(x);
    index.set(id(x), i);
    if (alt) altIndex.set(alt(x), i);
  };
  for (const x of local) put(x);
  for (const r of remote) {
    let i = index.get(id(r));
    if (i === undefined && alt) i = altIndex.get(alt(r));
    if (i === undefined) put(r);
    else out[i] = pick(out[i], r);
  }
  return out;
}

const MERGE = {
  vocab: (l, r) => mergeList(l, r, { alt: (v) => normalize(v.french), pick: (a, b) => newer(a, b, activity) }),
  mistakes: (l, r) => mergeList(l, r, {
    alt: (m) => normalize(m.french),
    pick: (a, b) => {
      const w = newer(a, b, (m) => [m.attempts || 0, m.date || 0]);
      const notes = mergeList(a.notes || [], b.notes || [], { pick: (x) => x });
      return { ...w, notes };
    },
  }),
  readings: (l, r) => mergeList(l, r, { pick: (a) => a }),
  conversations: (l, r) => mergeList(l, r, { pick: (a) => a }).sort((a, b) => (b.date || 0) - (a.date || 0)),
  history: (l, r) => {
    const seen = new Set(l.map(normalize));
    const out = [...l];
    for (const s of r) if (!seen.has(normalize(s))) { seen.add(normalize(s)); out.push(s); }
    return out.slice(-3000);
  },
  stats: (l, r) => {
    const out = { ...r };
    for (const [k, v] of Object.entries(l)) {
      const o = out[k];
      out[k] = o ? { cards: Math.max(o.cards, v.cards), correct: Math.max(o.correct, v.correct) } : v;
    }
    return out;
  },
  grammar: (l, r) => ({ ...r, ...l }),
  lessons: (l, r) => ({ ...r, ...l }),
  conjugations: (l, r) => ({ ...r, ...l }),
};

// ---------- Pull and push ----------

let pushTimer = null, running = false;

export function markDirty(name) {
  const m = meta();
  m.dirty = [...new Set([...(m.dirty || []), name])];
  saveMeta(m);
  if (!configured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), 3000);
}

export async function syncNow() {
  if (!configured() || running) return;
  if (!navigator.onLine) { setStatus('offline', 'Offline. Changes will sync when you reconnect.'); return; }
  running = true;
  setStatus('syncing');
  try {
    const secret = settings.get('syncSecret');
    let m = meta();
    const rows = await rpc('french_pull', { p_secret: secret, p_since: m.lastPull || '1970-01-01T00:00:00Z' });
    let latest = m.lastPull || null;
    const dirty = new Set(m.dirty || []);
    for (const row of rows) {
      if (!DOCS.includes(row.name)) continue;
      if (dirty.has(row.name)) {
        store[row.name] = MERGE[row.name](store[row.name], row.data);
      } else {
        store[row.name] = row.data;
      }
      store.save(row.name, { fromSync: true });
      if (!latest || row.updated_at > latest) latest = row.updated_at;
    }
    m = meta();
    for (const name of m.dirty || []) {
      const t = await rpc('french_push', { p_secret: secret, p_name: name, p_data: store[name] });
      if (!latest || t > latest) latest = t;
    }
    // Only clear what was pushed; anything changed during the push stays dirty for the next round.
    const after = meta();
    after.dirty = (after.dirty || []).filter((n) => !(m.dirty || []).includes(n));
    after.lastPull = latest;
    saveMeta(after);
    syncState.last = new Date();
    if (!rows.length && !m.lastPull && !store.vocab.length) {
      setStatus('empty', 'Connected, but nothing is stored under this passphrase. Check that it matches the Mac exactly.');
    } else setStatus('ok');
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    running = false;
  }
}

export function startSync() {
  store.onSave = markDirty;
  syncNow();
  setInterval(syncNow, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('online', syncNow);
}

/** Forgets the sync position so the next sync downloads everything again. Unsynced changes here are kept and merged. */
export function resetSync() {
  const m = meta();
  delete m.lastPull;
  saveMeta(m);
}

/** First 10 hex characters of the passphrase's SHA-256: the same ID the database stores, so two devices can be compared. */
export async function passphraseID() {
  const secret = settings.get('syncSecret') || '';
  if (!secret) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}
