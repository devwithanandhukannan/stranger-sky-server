import { db, must } from './db.js';

// Everyone who has blocked `id` or been blocked by `id` (never shown to each other).
export async function blockedSet(id) {
  const [a, b] = await Promise.all([
    db.from('blocks').select('blocked').eq('blocker', id),
    db.from('blocks').select('blocker').eq('blocked', id),
  ]);
  return new Set([...must(a).map((r) => r.blocked), ...must(b).map((r) => r.blocker)]);
}

// A bond = both people chose to keep in touch.
export async function bondSet(id) {
  const [a, b] = await Promise.all([
    db.from('keeps').select('to_id').eq('from_id', id),
    db.from('keeps').select('from_id').eq('to_id', id),
  ]);
  const out = new Set(must(a).map((r) => r.to_id));
  const bonds = new Set();
  for (const r of must(b)) if (out.has(r.from_id)) bonds.add(r.from_id);
  return bonds;
}

export async function areBonded(a, b) {
  const rows = must(await db.from('keeps').select('from_id,to_id').in('from_id', [a, b]).in('to_id', [a, b]));
  return rows.filter((r) => r.from_id !== r.to_id).length >= 2;
}

export async function audit(adminId, action, target, meta) {
  try {
    await db.from('audit_logs').insert({ admin_id: adminId, action, target: target == null ? null : String(target), meta: meta || null });
  } catch (e) {
    console.warn('audit failed', e.message);
  }
}

let seenDay = '';
let seen = new Set();
export async function markActive(profileId) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== seenDay) { seenDay = day; seen = new Set(); }
  if (seen.has(profileId)) return;
  seen.add(profileId);
  try {
    await db.from('daily_activity').upsert({ profile_id: profileId, day }, { onConflict: 'profile_id,day', ignoreDuplicates: true });
  } catch { /* analytics must never break the sky */ }
}

// Bonded people with their names (names are only ever revealed to the other side of a mutual keep).
export async function bondList(id) {
  const ids = [...(await bondSet(id))];
  if (!ids.length) return [];
  const rows = must(await db.from('profiles').select('id,display_name,status').in('id', ids));
  return rows.filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.display_name }));
}
