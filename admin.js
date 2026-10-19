import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, must } from './db.js';
import { adminGuard, invalidate } from './auth.js';
import { adminView, updateSettings, publicConfig } from './settings.js';
import { audit } from './social.js';
import { ah } from './util.js';

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// Retention from real activity: D1 = came back the day after joining; "7-day return" = came back on any of days 2..7.
export function retention(profiles, activity) {
  const byUser = new Map();
  for (const a of activity) (byUser.get(a.profile_id) || byUser.set(a.profile_id, new Set()).get(a.profile_id)).add(a.day);
  const add = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
  let d1Base = 0, d1 = 0, d7Base = 0, d7 = 0;
  for (const p of profiles) {
    const joined = p.created_at.slice(0, 10);
    const days = byUser.get(p.id) || new Set();
    if (joined <= day(-2)) { d1Base++; if (days.has(add(joined, 1))) d1++; }
    if (joined <= day(-8)) { d7Base++; for (let i = 2; i <= 7; i++) if (days.has(add(joined, i))) { d7++; break; } }
  }
  const pct = (n, b) => (b ? Math.round((n / b) * 1000) / 10 : null);
  return { d1: pct(d1, d1Base), d1Base, d7: pct(d7, d7Base), d7Base };
}

export function buildAdmin(rt) {
  const r = express.Router();
  r.use(express.json({ limit: '20kb' }));
  r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.use(rateLimit({ windowMs: 5 * 60_000, limit: 400, standardHeaders: true, legacyHeaders: false }));

  // The admin app needs the Firebase config to show its own sign-in page.
  r.get('/config', (req, res) => { const c = publicConfig(); res.json({ appName: c.appName, firebase: c.firebase }); });

  r.use(adminGuard);
  const writes = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.auth.uid });

  r.get('/me', (req, res) => res.json({ email: req.me.email, name: req.me.display_name }));

  r.get('/overview', ah(async (req, res) => {
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [users, newUsers, profiles, activity, sessions, openReports, floating, held] = await Promise.all([
      db.from('profiles').select('id', { count: 'exact', head: true }),
      db.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
      db.from('profiles').select('id,created_at').gte('created_at', since30).limit(5000),
      db.from('daily_activity').select('profile_id,day').gte('day', day(-31)).limit(30000),
      db.from('planet_sessions').select('duration_s,msgs,kept').gte('ended_at', new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(5000),
      db.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      db.from('lanterns').select('id', { count: 'exact', head: true }).eq('status', 'floating').is('holder', null),
      db.from('lanterns').select('id', { count: 'exact', head: true }).eq('status', 'floating').not('holder', 'is', null),
    ]);
    const act = must(activity);
    const dauToday = act.filter((a) => a.day === day()).length;
    const wau = new Set(act.filter((a) => a.day >= day(-6)).map((a) => a.profile_id)).size;
    const ss = must(sessions);
    const chats = ss.length;
    const real = ss.filter((s) => s.msgs > 0);
    const avgMin = real.length ? Math.round((real.reduce((a, s) => a + s.duration_s, 0) / real.length / 60) * 10) / 10 : 0;
    const keptPct = chats ? Math.round((ss.filter((s) => s.kept).length / chats) * 1000) / 10 : null;
    res.json({
      users: users.count, newToday: newUsers.count, dau: dauToday, wau,
      retention: retention(must(profiles), act),
      chats7d: chats, avgChatMinutes: avgMin, keptPct,
      openReports: openReports.count, lanternsFloating: floating.count, lanternsHeld: held.count,
      live: rt.stats(),
    });
  }));

  r.get('/live', (req, res) => res.json(rt.stats()));

  r.get('/users', ah(async (req, res) => {
    const q = z.object({ q: z.string().max(60).default(''), status: z.enum(['', 'active', 'suspended', 'banned']).default(''), page: z.coerce.number().int().min(0).max(500).default(0) }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_input' });
    let s = db.from('profiles').select('id,display_name,email,status,role,created_at,last_seen,galaxy').order('created_at', { ascending: false }).range(q.data.page * 50, q.data.page * 50 + 49);
    if (q.data.status) s = s.eq('status', q.data.status);
    if (q.data.q) s = s.or(`display_name.ilike.%${q.data.q.replace(/[%,()]/g, '')}%,email.ilike.%${q.data.q.replace(/[%,()]/g, '')}%`);
    const rows = must(await s);
    const reps = rows.length ? must(await db.from('reports').select('reported').eq('status', 'open').in('reported', rows.map((u) => u.id))) : [];
    const cnt = new Map();
    for (const x of reps) cnt.set(x.reported, (cnt.get(x.reported) || 0) + 1);
    res.json({ users: rows.map((u) => ({ ...u, openReports: cnt.get(u.id) || 0, online: rt.isOnline(u.id) })) });
  }));

  r.patch('/users/:id', writes, ah(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const b = z.object({ status: z.enum(['active', 'suspended', 'banned']) }).safeParse(req.body);
    if (!id.success || !b.success) return res.status(400).json({ error: 'invalid_input' });
    if (id.data === req.me.id) return res.status(400).json({ error: 'cannot_change_self' });
    const t = must(await db.from('profiles').select('id,role,status').eq('id', id.data).maybeSingle());
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (t.role === 'admin') return res.status(400).json({ error: 'cannot_change_admin' });
    must(await db.from('profiles').update({ status: b.data.status }).eq('id', t.id));
    invalidate();
    if (b.data.status !== 'active') rt.kick(t.id, b.data.status);
    await audit(req.me.id, 'user.' + b.data.status, t.id, { from: t.status });
    res.json({ ok: true });
  }));

  // Reports, with open-report counts so the worst cases are reviewed first. Nothing is auto-banned.
  r.get('/reports', ah(async (req, res) => {
    const q = z.object({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).default('open') }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_input' });
    const rows = must(await db.from('reports').select('*').eq('status', q.data.status).order('created_at', { ascending: false }).limit(100));
    const ids = [...new Set(rows.flatMap((x) => [x.reporter, x.reported]).filter(Boolean))];
    const names = ids.length ? must(await db.from('profiles').select('id,display_name,status').in('id', ids)) : [];
    const nm = new Map(names.map((n) => [n.id, n]));
    const open = ids.length ? must(await db.from('reports').select('reported').eq('status', 'open').in('reported', ids)) : [];
    const cnt = new Map();
    for (const x of open) cnt.set(x.reported, (cnt.get(x.reported) || 0) + 1);
    const out = rows.map((x) => ({
      ...x, reporterName: nm.get(x.reporter)?.display_name || null, reportedName: nm.get(x.reported)?.display_name || null,
      reportedStatus: nm.get(x.reported)?.status || null, openAgainstReported: cnt.get(x.reported) || 0,
    })).sort((a, b) => b.openAgainstReported - a.openAgainstReported || (a.reason === 'underage' ? -1 : 0));
    res.json({ reports: out });
  }));

  r.patch('/reports/:id', writes, ah(async (req, res) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const b = z.object({ status: z.enum(['reviewing', 'actioned', 'dismissed']), action: z.enum(['none', 'suspend', 'ban', 'remove_lantern']).default('none') }).safeParse(req.body);
    if (!id.success || !b.success) return res.status(400).json({ error: 'invalid_input' });
    const rep = must(await db.from('reports').select('*').eq('id', id.data).maybeSingle());
    if (!rep) return res.status(404).json({ error: 'not_found' });
    const { action } = b.data;
    if (action === 'suspend' || action === 'ban') {
      const t = must(await db.from('profiles').select('id,role').eq('id', rep.reported).maybeSingle());
      if (t && t.role !== 'admin') {
        const status = action === 'ban' ? 'banned' : 'suspended';
        must(await db.from('profiles').update({ status }).eq('id', t.id));
        invalidate(); rt.kick(t.id, status);
        await audit(req.me.id, 'user.' + status, t.id, { report: rep.id });
      }
    }
    if (action === 'remove_lantern' && rep.lantern_id) {
      must(await db.from('lanterns').update({ status: 'removed' }).eq('id', rep.lantern_id));
      await audit(req.me.id, 'lantern.remove', rep.lantern_id, { report: rep.id });
    }
    must(await db.from('reports').update({ status: b.data.status, resolved_by: req.me.id, resolved_at: new Date().toISOString() }).eq('id', rep.id));
    await audit(req.me.id, 'report.' + b.data.status, rep.id, { action });
    res.json({ ok: true });
  }));

  r.get('/lanterns', ah(async (req, res) => {
    const rows = must(await db.from('lanterns').select('id,body,status,hops,galaxy,created_at,holder').order('created_at', { ascending: false }).limit(100));
    res.json({ lanterns: rows.map((l) => ({ ...l, held: !!l.holder, holder: undefined })) });
  }));
  r.patch('/lanterns/:id', writes, ah(async (req, res) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'invalid_input' });
    must(await db.from('lanterns').update({ status: 'removed' }).eq('id', id.data));
    await audit(req.me.id, 'lantern.remove', id.data);
    res.json({ ok: true });
  }));

  r.get('/settings', (req, res) => res.json({ settings: adminView() }));
  r.put('/settings', writes, ah(async (req, res) => {
    const b = z.object({ values: z.record(z.string(), z.string()).default({}), clear: z.array(z.string()).default([]) }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: 'invalid_input' });
    try {
      const changed = await updateSettings(b.data.values, b.data.clear, req.me.id);
      await audit(req.me.id, 'settings.update', null, { keys: changed }); // key names only, never values
      res.json({ ok: true, changed, settings: adminView() });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.code || 'bad_value', message: e.message });
      throw e;
    }
  }));

  r.get('/audit', ah(async (req, res) => {
    const rows = must(await db.from('audit_logs').select('id,action,target,meta,created_at,admin_id').order('created_at', { ascending: false }).limit(100));
    res.json({ logs: rows });
  }));

  return r;
}
