import crypto from 'node:crypto';
import { db, must } from './db.js';
import { config } from './config.js';

const GALAXIES = 'neighbours|Neighbours (Near Me)|#38ef7d;music|Music|#7aa2ff;cinema|Cinema|#ff8fb1;games|Games|#79e6b6;tech|Tech|#7fdcff;travel|Travel|#ffd27a;learn|Languages|#c4a0ff;night|Night thoughts|#9fb0ff;kerala|Kerala|#ffb07a';
const SEEDS = "";
const PROMPTS = 'What is a small thing that made you smile today?|If you could ask a stranger anything, what would it be?|Describe your day in three words.|What song is stuck in your head?|What is a place you miss?|What would you do with a free day?|Two truths and a lie: go!|What is something you are quietly proud of?|What did you want to be when you were small?|What is the best thing you ate this week?';

const slugOk = (s) => /^[a-z0-9_-]{1,32}$/.test(s);
const parseGalaxies = (raw) =>
  String(raw || '').split(';').map((p) => p.split('|').map((x) => x.trim())).filter((p) => slugOk(p[0]) && p[1])
    .slice(0, 100).map(([slug, name, color]) => ({ slug, name: name.slice(0, 24), color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#9fb0ff' }));

// Every editable setting. `public` values are sent to browsers. `secret` values are AES-256-GCM
// encrypted in the database and never returned. Leave values empty and fill them in later.
export const SPEC = [
  { key: 'app.name', label: 'App name', group: 'General', public: true, def: 'Lumen' },
  { key: 'app.min_age', label: 'Minimum age', group: 'General', public: true, def: '18', type: 'number' },
  { key: 'app.registration_open', label: 'Registration open (true/false)', group: 'General', def: 'true' },
  { key: 'app.announcement', label: 'Announcement shown in the sky (empty = none)', group: 'General', public: true, def: '' },

  { key: 'firebase.apiKey', label: 'API key', group: 'Firebase (web config)', public: true, def: 'AIzaSyAydMVet7JSq6S9zkZE0FOXN_5pUpIj9CU' },
  { key: 'firebase.authDomain', label: 'Auth domain', group: 'Firebase (web config)', public: true, def: 'stranger-social-41bc5.firebaseapp.com' },
  { key: 'firebase.projectId', label: 'Project ID (also verifies login tokens)', group: 'Firebase (web config)', public: true, def: 'stranger-social-41bc5' },
  { key: 'firebase.appId', label: 'App ID', group: 'Firebase (web config)', public: true, def: '1:758529337031:web:48a255a0dfe0de557c40e2' },
  { key: 'firebase.messagingSenderId', label: 'Messaging sender ID', group: 'Firebase (web config)', public: true, def: '758529337031' },
  { key: 'firebase.storageBucket', label: 'Storage bucket', group: 'Firebase (web config)', public: true, def: 'stranger-social-41bc5.firebasestorage.app' },

  { key: 'world.galaxies', label: 'Galaxies: slug|Name|#color separated by ;', group: 'Sky world', public: true, def: GALAXIES, validate: (v) => parseGalaxies(v).length >= 1 },
  { key: 'world.sky_theme', label: 'Sky theme: auto, midnight, dawn, dusk, onam, diwali, christmas', group: 'Sky world', public: true, def: 'auto', validate: (v) => ['auto', 'midnight', 'dawn', 'dusk', 'onam', 'diwali', 'christmas'].includes(v) },
  { key: 'world.reveal_radius', label: 'How close lights must be to see thoughts', group: 'Sky world', public: true, def: '160', type: 'number' },
  { key: 'world.max_speed', label: 'Max light speed (units per second)', group: 'Sky world', public: true, def: '220', type: 'number' },
  { key: 'world.thought_max', label: 'Max thought length', group: 'Sky world', public: true, def: '120', type: 'number' },
  { key: 'world.galaxy_cap', label: 'Max lights per galaxy', group: 'Sky world', def: '400', type: 'number' },
  { key: 'world.echo_hours', label: 'How long echoes of past visitors stay (hours)', group: 'Sky world', def: '12', type: 'number' },
  { key: 'world.seed_thoughts', label: 'Seed thoughts that keep the sky from feeling empty (separate with |)', group: 'Sky world', def: SEEDS },
  { key: 'world.prompts', label: 'Shooting-star questions (separate with |)', group: 'Sky world', def: PROMPTS },

  { key: 'limits.messages_per_10s', label: 'Max planet messages per 10 seconds', group: 'Limits', def: '10', type: 'number' },
  { key: 'limits.max_message_length', label: 'Max planet message length', group: 'Limits', def: '400', type: 'number' },
  { key: 'limits.lanterns_per_day', label: 'Lanterns a person can release per day', group: 'Limits', def: '5', type: 'number' },
  { key: 'limits.lantern_max_length', label: 'Max lantern length', group: 'Limits', def: '200', type: 'number' },
  { key: 'limits.pulses_per_min', label: 'Max pulses per minute', group: 'Limits', def: '8', type: 'number' },
  { key: 'moderation.blocked_words', label: 'Blocked words (comma separated)', group: 'Moderation', def: '' },
];

const BY_KEY = new Map(SPEC.map((s) => [s.key, s]));
let cache = new Map();

const encKey = () => crypto.createHash('sha256').update(config.encKey).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['enc', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
function decrypt(stored) {
  try {
    const [, iv, tag, data] = stored.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export async function loadSettings() {
  const next = new Map(SPEC.map((s) => [s.key, s.def]));
  try {
    for (const r of must(await db.from('app_settings').select('key,value,is_secret'))) {
      const spec = BY_KEY.get(r.key);
      if (!spec) continue;
      next.set(r.key, r.is_secret ? (config.encKey ? decrypt(r.value) : '') : r.value);
    }
  } catch (e) {
    console.warn('Could not load settings from the database, using defaults:', e.message);
  }
  cache = next;
}

export const getSetting = (key) => cache.get(key) ?? BY_KEY.get(key)?.def ?? '';
export const getNumber = (key) => Number(getSetting(key)) || Number(BY_KEY.get(key)?.def) || 0;
export const getBool = (key) => String(getSetting(key)).toLowerCase() === 'true';
export const getList = (key) => getSetting(key).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const getPipeList = (key) => getSetting(key).split('|').map((s) => s.trim()).filter(Boolean);

let gCache = { raw: null, val: [] };
const dynamicGalaxies = [];
export function addDynamicGalaxy(g) {
  const all = galaxyDefs();
  const existing = all.find((x) => x.slug === g.slug);
  if (existing) return existing;
  const def = { slug: g.slug, name: g.name.slice(0, 24), color: /^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : '#9fb0ff' };
  dynamicGalaxies.push(def);
  return def;
}

export function galaxyDefs() {
  const raw = getSetting('world.galaxies');
  if (gCache.raw !== raw) gCache = { raw, val: parseGalaxies(raw) };
  const base = gCache.val.length ? gCache.val : parseGalaxies(GALAXIES);
  const bySlug = new Map();
  if (!base.some((g) => g.slug === 'neighbours')) {
    bySlug.set('neighbours', { slug: 'neighbours', name: 'Neighbours (Near Me)', color: '#38ef7d' });
  }
  for (const g of base) bySlug.set(g.slug, g);
  for (const g of dynamicGalaxies) if (!bySlug.has(g.slug)) bySlug.set(g.slug, g);
  return Array.from(bySlug.values());
}

export function publicConfig() {
  const firebase = {};
  for (const s of SPEC) if (s.key.startsWith('firebase.')) firebase[s.key.slice(9)] = getSetting(s.key);
  return {
    appName: getSetting('app.name'),
    minAge: getNumber('app.min_age'),
    firebase,
    skyTheme: getSetting('world.sky_theme'),
    announcement: getSetting('app.announcement'),
    galaxies: galaxyDefs(),
  };
}

export function adminView() {
  return SPEC.map((s) => ({
    key: s.key, label: s.label, group: s.group, secret: !!s.secret, type: s.type || 'text',
    value: s.secret ? '' : getSetting(s.key), isSet: !!getSetting(s.key),
  }));
}

const bad = (msg, code = 'bad_value') => Object.assign(new Error(msg), { status: 400, code });

export async function updateSettings(values, clear, adminId) {
  const changed = [];
  const rows = [];
  const now = new Date().toISOString();
  for (const [key, raw] of Object.entries(values || {})) {
    const spec = BY_KEY.get(key);
    if (!spec || typeof raw !== 'string') continue;
    const v = raw.trim().slice(0, 2000);
    if (spec.secret) {
      if (!v) continue; // empty = leave unchanged
      if (!config.encKey) throw bad('SETTINGS_ENCRYPTION_KEY is not configured', 'no_encryption_key');
    }
    if (spec.type === 'number' && !/^\d{1,6}$/.test(v)) throw bad('bad number: ' + key);
    if (key.startsWith('firebase.') && !v) throw bad('Firebase values cannot be empty');
    if (spec.validate && !spec.validate(v)) throw bad('invalid value for ' + key);
    rows.push({ key, value: spec.secret ? encrypt(v) : v, is_secret: !!spec.secret, updated_by: adminId, updated_at: now });
    changed.push(key);
  }
  for (const key of clear || []) {
    const spec = BY_KEY.get(key);
    if (!spec || !spec.secret) continue;
    rows.push({ key, value: '', is_secret: true, updated_by: adminId, updated_at: now });
    changed.push(key);
  }
  if (rows.length) must(await db.from('app_settings').upsert(rows, { onConflict: 'key' }));
  await loadSettings();
  return changed;
}
