import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, must } from './db.js';
import { authn, getProfileByUid, invalidate } from './auth.js';
import { buildLanterns } from './lanterns.js';
import { bondList, blockedSet } from './social.js';
import { publicConfig, getBool, getNumber, getList, galaxyDefs } from './settings.js';
import { ah, ageFrom, cleanText, containsBlocked } from './util.js';

const mine = (p) => ({ id: p.id, name: p.display_name, galaxy: p.galaxy, age: ageFrom(p.dob), createdAt: p.created_at });
const profileSchema = z.object({
  displayName: z.string().transform((s) => cleanText(s, 30)).pipe(z.string().min(1)),
  galaxy: z.string().max(24).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function buildApi(rt) {
  const r = express.Router();
  r.use(express.json({ limit: '10kb' }));
  r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.use(rateLimit({ windowMs: 5 * 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

  r.get('/config', (req, res) => {
    const c = publicConfig();
    res.set('Cache-Control', 'public, max-age=30').json(c);
  });

  r.use(authn);
  const writeLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.auth.uid });

  r.get('/me', ah(async (req, res) => {
    const p = await getProfileByUid(req.auth.uid);
    if (p && p.status !== 'active') return res.status(403).json({ error: 'account_' + p.status });
    res.json({ profile: p ? mine(p) : null });
  }));

  // Create (first time, needs date of birth) or update the profile. Nothing else is collected.
  r.post('/profile', writeLimit, ah(async (req, res) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', fields: parsed.error.issues.map((i) => i.path.join('.')) });
    const d = parsed.data;
    if (containsBlocked(d.displayName, getList('moderation.blocked_words'))) return res.status(400).json({ error: 'content_not_allowed' });
    const galaxy = d.galaxy && galaxyDefs().some((g) => g.slug === d.galaxy) ? d.galaxy : undefined;
    const existing = await getProfileByUid(req.auth.uid);
    let row;
    if (existing) {
      if (existing.status !== 'active') return res.status(403).json({ error: 'account_' + existing.status });
      row = must(await db.from('profiles').update({ display_name: d.displayName, ...(galaxy ? { galaxy } : {}) }).eq('id', existing.id).select('*').single());
    } else {
      if (!getBool('app.registration_open')) return res.status(403).json({ error: 'registration_closed' });
      if (!d.dob) return res.status(400).json({ error: 'invalid_input', fields: ['dob'] });
      const age = ageFrom(d.dob);
      if (age < 0 || age > 110) return res.status(400).json({ error: 'invalid_input', fields: ['dob'] });
      if (age < (getNumber('app.min_age') || 18)) return res.status(403).json({ error: 'underage' });
      try {
        row = must(await db.from('profiles').insert({ uid: req.auth.uid, email: req.auth.email, display_name: d.displayName, dob: d.dob, ...(galaxy ? { galaxy } : {}) }).select('*').single());
      } catch (e) {
        if (e.code !== '23505') throw e; // double-submit: the profile already exists
        row = await getProfileByUid(req.auth.uid);
      }
    }
    invalidate(req.auth.uid);
    res.json({ profile: mine(row) });
  }));

  r.use(ah(async (req, res, next) => {
    req.me = await getProfileByUid(req.auth.uid);
    if (!req.me) return res.status(404).json({ error: 'no_profile' });
    if (req.me.status !== 'active') return res.status(403).json({ error: 'account_' + req.me.status });
    next();
  }));

  r.get('/bonds', ah(async (req, res) => {
    const list = await bondList(req.me.id);
    res.json({ bonds: list.map((b) => ({ ...b, online: !!rt?.isOnline(b.id) })) });
  }));

  // Block a bonded person (also removes the bond). Blocking someone in the sky goes through the live socket.
  r.post('/blocks', writeLimit, ah(async (req, res) => {
    const b = z.object({ id: z.string().uuid() }).safeParse(req.body);
    if (!b.success || b.data.id === req.me.id) return res.status(400).json({ error: 'invalid_input' });
    const o = must(await db.from('profiles').select('id').eq('id', b.data.id).maybeSingle());
    if (!o) return res.status(404).json({ error: 'not_found' });
    must(await db.from('blocks').upsert({ blocker: req.me.id, blocked: o.id }, { onConflict: 'blocker,blocked', ignoreDuplicates: true }));
    must(await db.from('keeps').delete().or(`and(from_id.eq.${req.me.id},to_id.eq.${o.id}),and(from_id.eq.${o.id},to_id.eq.${req.me.id})`));
    rt?.onBlockRest(req.me.id, o.id);
    res.json({ ok: true });
  }));

  r.delete('/bonds/:id', writeLimit, ah(async (req, res) => {
    const o = z.string().uuid().safeParse(req.params.id);
    if (!o.success) return res.status(400).json({ error: 'invalid_input' });
    must(await db.from('keeps').delete().or(`and(from_id.eq.${req.me.id},to_id.eq.${o.data}),and(from_id.eq.${o.data},to_id.eq.${req.me.id})`));
    rt?.onBondChange(req.me.id, o.data, false); rt?.onBondChange(o.data, req.me.id, false);
    res.json({ ok: true });
  }));

  // Your data, as a file you can keep.
  r.get('/me/export', ah(async (req, res) => {
    const [lanterns, bonds, blocks] = await Promise.all([
      db.from('lanterns').select('body,galaxy,status,created_at').eq('author', req.me.id),
      bondList(req.me.id),
      blockedSet(req.me.id),
    ]);
    res.set('Content-Disposition', 'attachment; filename="my-data.json"').json({
      profile: { name: req.me.display_name, dob: req.me.dob, email: req.me.email, galaxy: req.me.galaxy, createdAt: req.me.created_at },
      lanterns: must(lanterns), bonds: bonds.map((b) => b.name), blockedCount: blocks.size,
    });
  }));

  // Right to erasure: removes the profile and everything linked to it. The client then deletes the Firebase login.
  r.delete('/me', rateLimit({ windowMs: 3_600_000, limit: 5, keyGenerator: (req) => req.auth.uid }), ah(async (req, res) => {
    must(await db.from('profiles').delete().eq('id', req.me.id));
    invalidate(req.auth.uid);
    rt?.kick(req.me.id, 'deleted');
    res.json({ ok: true });
  }));

  r.use('/lanterns', buildLanterns(rt));
  return r;
}
