import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, must } from './db.js';
import { authn, withProfile } from './auth.js';
import { blockedSet, areBonded } from './social.js';
import { getNumber, getList } from './settings.js';
import { ah, cleanText, containsBlocked, hasLink, pick } from './util.js';

const MAX_HOPS = 6;
const HOLD_HOURS = 48;
const MAX_REPLIES = 20;
const REASONS = ['harassment', 'sexual_content', 'nudity', 'underage', 'spam', 'scam', 'hate', 'other'];
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const bad = (res, error, status = 400) => res.status(status).json({ error });
const idSchema = z.coerce.number().int().positive();
const text = (max) => z.string().transform((s) => cleanText(s, max)).pipe(z.string().min(1));

let lastRecycle = 0;
// A lantern nobody answers drifts on to someone else instead of sitting in one inbox forever.
async function recycle() {
  if (Date.now() - lastRecycle < 60_000) return;
  lastRecycle = Date.now();
  await db.from('lanterns').update({ holder: null, caught_at: null }).eq('status', 'floating').lt('caught_at', iso(HOLD_HOURS * 3_600_000));
}

const load = async (lid) => must(await db.from('lanterns').select('*').eq('id', lid).maybeSingle());

export function buildLanterns(rt) {
  const r = express.Router();
  r.use(authn, withProfile);
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.auth.uid });

  async function candidates(me) {
    const [rows, blocked] = await Promise.all([
      db.from('lanterns').select('id,author,body,galaxy,hops').eq('status', 'floating').is('holder', null).neq('author', me.id).order('created_at', { ascending: false }).limit(40),
      blockedSet(me.id),
    ]);
    const list = must(rows).filter((l) => !blocked.has(l.author));
    if (!list.length) return [];
    const seen = new Set(must(await db.from('lantern_seen').select('lantern_id').eq('user_id', me.id).in('lantern_id', list.map((l) => l.id))).map((s) => s.lantern_id));
    return list.filter((l) => !seen.has(l.id));
  }

  // Release a lantern into the sky.
  r.post('/', limit, ah(async (req, res) => {
    const p = z.object({ body: text(getNumber('limits.lantern_max_length')), galaxy: z.string().max(24).optional() }).safeParse(req.body);
    if (!p.success) return bad(res, 'invalid_input');
    const { body } = p.data;
    if (hasLink(body) || containsBlocked(body, getList('moderation.blocked_words'))) return bad(res, 'content_not_allowed');
    const sent = must(await db.from('lanterns').select('id').eq('author', req.me.id).gte('created_at', iso(24 * 3_600_000)));
    const cap = getNumber('limits.lanterns_per_day');
    if (sent.length >= cap) return bad(res, 'daily_limit', 429);
    const row = must(await db.from('lanterns').insert({ author: req.me.id, body, galaxy: p.data.galaxy || req.me.galaxy }).select('id').single());
    rt?.broadcastLanternDrift?.(p.data.galaxy || req.me.galaxy);
    res.json({ id: row.id, left: cap - sent.length - 1 });
  }));

  // Is there a lantern drifting toward me? (cheap check so the sky can show one)
  r.get('/drift', ah(async (req, res) => {
    await recycle();
    res.json({ available: (await candidates(req.me)).length > 0 });
  }));

  // Catch the lantern: first come first served (compare-and-set on `holder`).
  r.post('/catch', limit, ah(async (req, res) => {
    const held = must(await db.from('lanterns').select('id').eq('holder', req.me.id).eq('status', 'floating'));
    if (held.length >= 3) return bad(res, 'too_many_held', 429);
    const list = await candidates(req.me);
    for (let n = 0; n < 4 && list.length; n++) {
      const same = list.filter((l) => l.galaxy === req.me.galaxy);
      const l = pick(same.length && n < 2 ? same : list);
      list.splice(list.indexOf(l), 1);
      const won = must(await db.from('lanterns').update({ holder: req.me.id, caught_at: new Date().toISOString() }).eq('id', l.id).eq('status', 'floating').is('holder', null).select('id'));
      if (!won.length) continue;
      must(await db.from('lantern_seen').upsert({ lantern_id: l.id, user_id: req.me.id }, { onConflict: 'lantern_id,user_id', ignoreDuplicates: true }));
      return res.json({ lantern: { id: l.id, body: l.body, hops: l.hops, galaxy: l.galaxy } });
    }
    res.json({ lantern: null });
  }));

  // Let a held lantern go on to the next stranger.
  r.post('/:id/release', limit, ah(async (req, res) => {
    const lid = idSchema.safeParse(req.params.id);
    if (!lid.success) return bad(res, 'invalid_input');
    const l = await load(lid.data);
    if (!l || l.holder !== req.me.id || l.status !== 'floating') return bad(res, 'not_found', 404);
    const hops = l.hops + 1;
    must(await db.from('lanterns').update(hops >= MAX_HOPS ? { holder: null, hops, status: 'landed', caught_at: null } : { holder: null, hops, caught_at: null }).eq('id', l.id).eq('holder', req.me.id));
    res.json({ ok: true });
  }));

  // Delete a lantern created by me.
  r.delete('/:id', limit, ah(async (req, res) => {
    const lid = idSchema.safeParse(req.params.id);
    if (!lid.success) return bad(res, 'invalid_input');
    const l = await load(lid.data);
    if (!l || l.author !== req.me.id || l.status === 'removed') return bad(res, 'not_found', 404);
    must(await db.from('lanterns').update({ status: 'removed', holder: null }).eq('id', l.id).eq('author', req.me.id));
    res.json({ ok: true });
  }));

  async function party(req, res) {
    const lid = idSchema.safeParse(req.params.id);
    if (!lid.success) { bad(res, 'invalid_input'); return null; }
    const l = await load(lid.data);
    if (!l || l.status === 'removed') { bad(res, 'not_found', 404); return null; }
    const isAuthor = l.author === req.me.id;
    if (!isAuthor && l.holder !== req.me.id) { bad(res, 'not_found', 404); return null; }
    const other = isAuthor ? l.holder : l.author;
    if (!other) { bad(res, 'no_recipient', 409); return null; }
    if ((await blockedSet(req.me.id)).has(other)) { bad(res, 'not_found', 404); return null; }
    return { l, other, isAuthor };
  }

  // Reply (holder -> author, author -> holder). Both stay anonymous.
  r.post('/:id/reply', limit, ah(async (req, res) => {
    const b = z.object({ body: text(getNumber('limits.max_message_length')) }).safeParse(req.body);
    if (!b.success) return bad(res, 'invalid_input');
    const pt = await party(req, res);
    if (!pt) return;
    if (hasLink(b.data.body) || containsBlocked(b.data.body, getList('moderation.blocked_words'))) return bad(res, 'content_not_allowed');
    const count = must(await db.from('lantern_replies').select('id').eq('lantern_id', pt.l.id));
    if (count.length >= MAX_REPLIES) return bad(res, 'thread_full', 409);
    must(await db.from('lantern_replies').insert({ lantern_id: pt.l.id, from_id: req.me.id, to_id: pt.other, body: b.data.body }));
    // once someone answers, the lantern "lands" and stops drifting
    if (!pt.isAuthor && pt.l.status === 'floating') must(await db.from('lanterns').update({ status: 'landed' }).eq('id', pt.l.id));
    rt?.notify(pt.other, 'lantern:reply', { id: pt.l.id });
    res.json({ ok: true });
  }));

  // Both sides keep each other -> a bond; names are revealed only now.
  r.post('/:id/keep', limit, ah(async (req, res) => {
    const pt = await party(req, res);
    if (!pt) return;
    must(await db.from('keeps').upsert({ from_id: req.me.id, to_id: pt.other }, { onConflict: 'from_id,to_id', ignoreDuplicates: true }));
    if (!(await areBonded(req.me.id, pt.other))) return res.json({ bonded: false });
    const o = must(await db.from('profiles').select('id,display_name').eq('id', pt.other).single());
    rt?.onBondChange(req.me.id, pt.other, true); rt?.onBondChange(pt.other, req.me.id, true);
    rt?.notify(pt.other, 'bond:new', { id: req.me.id, name: req.me.display_name, online: !!rt.isOnline(req.me.id) });
    res.json({ bonded: true, with: { id: o.id, name: o.display_name } });
  }));

  // My lanterns: ones I released and ones I am holding, with their anonymous threads.
  r.get('/inbox', ah(async (req, res) => {
    const me = req.me.id;
    const [sent, held] = await Promise.all([
      db.from('lanterns').select('id,body,status,hops,created_at,holder').eq('author', me).neq('status', 'removed').order('created_at', { ascending: false }).limit(20),
      db.from('lanterns').select('id,body,status,hops,created_at,author').eq('holder', me).neq('status', 'removed').order('caught_at', { ascending: false }).limit(10),
    ]);
    const s = must(sent), h = must(held);
    const ids = [...s.map((x) => x.id), ...h.map((x) => x.id)];
    const replies = ids.length ? must(await db.from('lantern_replies').select('lantern_id,from_id,body,created_at').in('lantern_id', ids).order('created_at', { ascending: true })) : [];
    const mine = must(await db.from('keeps').select('to_id').eq('from_id', me));
    const kept = (o) => !!o && mine.some((k) => k.to_id === o);
    const thread = (lid) => replies.filter((x) => x.lantern_id === lid).map((x) => ({ mine: x.from_id === me, body: x.body, at: x.created_at }));
    res.json({
      sent: s.map((l) => ({ id: l.id, body: l.body, status: l.status, hops: l.hops, caught: !!l.holder, thread: thread(l.id), kept: kept(l.holder) })),
      held: h.map((l) => ({ id: l.id, body: l.body, status: l.status, hops: l.hops, thread: thread(l.id), kept: kept(l.author) })),
    });
  }));

  r.post('/:id/report', limit, ah(async (req, res) => {
    const b = z.object({ reason: z.enum(REASONS), details: z.string().max(300).default('') }).safeParse(req.body);
    if (!b.success) return bad(res, 'invalid_input');
    const lid = idSchema.safeParse(req.params.id);
    if (!lid.success) return bad(res, 'invalid_input');
    const l = await load(lid.data);
    if (!l || (l.author !== req.me.id && l.holder !== req.me.id)) return bad(res, 'not_found', 404);
    const other = l.author === req.me.id ? l.holder : l.author;
    if (!other) return bad(res, 'no_recipient', 409);
    const thread = must(await db.from('lantern_replies').select('from_id,body,created_at').eq('lantern_id', l.id).order('created_at', { ascending: true }).limit(30));
    must(await db.from('reports').insert({
      reporter: req.me.id, reported: other, kind: 'lantern', lantern_id: l.id, reason: b.data.reason, details: cleanText(b.data.details, 300),
      evidence: { lantern: l.body, at: new Date().toISOString(), thread: thread.map((t) => ({ who: t.from_id === req.me.id ? 'reporter' : 'reported', t: t.body, ts: t.created_at })) },
    }));
    must(await db.from('blocks').upsert({ blocker: req.me.id, blocked: other }, { onConflict: 'blocker,blocked', ignoreDuplicates: true }));
    rt?.onBlockRest(req.me.id, other);
    res.json({ ok: true });
  }));

  return r;
}
