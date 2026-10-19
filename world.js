import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { config } from './config.js';
import { db, must } from './db.js';
import { verifyFirebaseToken, getProfileByUid } from './auth.js';
import { getNumber, getList, getPipeList, galaxyDefs, publicConfig, addDynamicGalaxy } from './settings.js';
import { blockedSet, bondSet, bondList, markActive } from './social.js';
import { cleanText, containsBlocked, hasLink, clamp, rand, pick, hoursSince } from './util.js';

export const MOODS = 8; // client maps 0..7 to colours
const BOUND = 1000;     // world is [-BOUND, BOUND]^2
const SCALE = 16;       // Int16 fixed-point for positions
const TICK_MS = 200;
const SNAPSHOT_EVERY = 25; // full position snapshot every 5 s (also resyncs lost volatile packets)
const F = { NEW: 1, BUSY: 2, THOUGHT: 4, ECHO: 8, VET: 16 };
export const REASONS = ['harassment', 'sexual_content', 'nudity', 'underage', 'spam', 'scam', 'hate', 'other'];
const PULSE_WINDOW = 120_000;

const sid = () => crypto.randomBytes(6).toString('hex');
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function getDistanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function bucket(c, key, limit, windowMs) {
  const now = Date.now();
  const b = (c.rl[key] ||= { t: now, n: 0 });
  if (now - b.t > windowMs) { b.t = now; b.n = 0; }
  return ++b.n <= limit;
}

export function createWorld(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.webOrigins, credentials: false },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 4_000,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    perMessageDeflate: false, // positions are tiny; compression costs CPU for nothing
    allowRequest: (req, cb) => {
      const o = req.headers.origin;
      cb(null, !o || config.webOrigins.includes(o));
    },
  });

  const galaxies = new Map(); // slug -> {slug, ents:Map(idx->ent), bySid:Map, free:[], next, changed, echoes:[], meteor}
  const online = new Map();   // profileId -> ent
  const planets = new Map();  // pid -> planet
  const evidence = new Map(); // "a|b" -> {at, msgs}
  const bySocket = new WeakMap();

  const G = (slug) => {
    let g = galaxies.get(slug);
    if (!g) galaxies.set(slug, (g = { slug, ents: new Map(), bySid: new Map(), free: [], next: 0, changed: true, echoes: [], meteor: null, echoCount: 0 }));
    return g;
  };
  const room = (slug) => 'g:' + slug;
  const validSlug = (s) => galaxyDefs().some((g) => g.slug === s);
  const realCount = (g) => { let n = 0; for (const e of g.ents.values()) if (!e.echo) n++; return n; };

  function flagsOf(e) {
    let f = 0;
    if (e.isNew) f |= F.NEW;
    if (e.vet) f |= F.VET;
    if (e.thought) f |= F.THOUGHT;
    if (e.planet) f |= F.BUSY;
    if (e.echo) f |= F.ECHO;
    return f;
  }
  const pub = (e) => ({ i: e.idx, sid: e.sid, x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10, m: e.mood, f: flagsOf(e) });
  const emit = (e, ev, p) => { if (e.socket) e.socket.emit(ev, p); };

  // ---------- roster ----------
  function addEntity(g, e) {
    e.idx = g.free.length ? g.free.pop() : g.next++;
    e.galaxy = g.slug;
    g.ents.set(e.idx, e);
    g.bySid.set(e.sid, e);
    g.changed = true;
  }
  function removeEntity(e) {
    const g = galaxies.get(e.galaxy);
    if (!g || g.ents.get(e.idx) !== e) return;
    g.ents.delete(e.idx);
    g.bySid.delete(e.sid);
    g.free.push(e.idx);
    g.changed = true;
    io.to(room(g.slug)).emit('roster:del', { i: e.idx, sid: e.sid });
  }
  function hideFor(viewer, g) {
    const out = [];
    const isNeighbours = g.slug === 'neighbours';
    for (const e of g.ents.values()) {
      if (e === viewer) continue;
      if (!e.echo && viewer.blocked.has(e.profileId)) {
        out.push(e.sid);
        continue;
      }
      if (isNeighbours) {
        if (viewer.lat == null || viewer.lon == null || e.lat == null || e.lon == null) {
          out.push(e.sid);
        } else {
          const d = getDistanceKm(viewer.lat, viewer.lon, e.lat, e.lon);
          if (d == null || d > 100) out.push(e.sid);
        }
      }
    }
    return out;
  }
  function enterGalaxy(c, slug) {
    const g = G(slug);
    c.socket.join(room(slug));
    c.x = rand(-500, 500); c.y = rand(-500, 500); c.lastMove = Date.now();
    addEntity(g, c);
    c.near = new Map();
    const roster = [];
    for (const e of g.ents.values()) if (e !== c) roster.push(pub(e));
    c.socket.emit('galaxy:enter', { galaxy: slug, you: pub(c), roster, hide: hideFor(c, g), census: census() });
    c.socket.to(room(slug)).emit('roster:add', pub(c));
    for (const e of g.ents.values()) {
      if (!e.echo && e !== c) {
        if (e.blocked.has(c.profileId) || (slug === 'neighbours' && hideFor(e, g).includes(c.sid))) {
          emit(e, 'hide', { sids: [c.sid] });
        }
      }
    }
  }
  function leaveGalaxy(c) {
    if (c.planet) endPlanet(c.planet, 'left');
    if (c.thought && galaxies.has(c.galaxy)) {
      const g = galaxies.get(c.galaxy);
      g.echoes.push({ x: c.x, y: c.y, t: c.thought, m: c.mood, at: Date.now() });
      if (g.echoes.length > 40) g.echoes.shift();
    }
    c.socket.leave(room(c.galaxy));
    removeEntity(c);
  }
  function pickGalaxy(wanted) {
    const cap = getNumber('world.galaxy_cap');
    const order = [wanted, ...galaxyDefs().map((d) => d.slug)].filter((s, i, a) => s && validSlug(s) && a.indexOf(s) === i);
    return order.find((s) => realCount(G(s)) < cap) || null;
  }

  // ---------- neighbours (thoughts appear only when lights drift close) ----------
  function computeNear(g) {
    const R = getNumber('world.reveal_radius');
    const R2 = R * R, H2 = (R * 1.15) ** 2, cell = R * 1.2;
    const grid = new Map();
    const key = (cx, cy) => cx * 100003 + cy;
    for (const e of g.ents.values()) {
      const k = key(Math.floor(e.x / cell), Math.floor(e.y / cell));
      const a = grid.get(k);
      a ? a.push(e) : grid.set(k, [e]);
    }
    for (const c of g.ents.values()) {
      if (c.echo) continue;
      const cx = Math.floor(c.x / cell), cy = Math.floor(c.y / cell);
      const now = new Map();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const e of arr) {
          if (e === c) continue;
          if (!e.echo && (c.blocked.has(e.profileId) || e.blocked.has(c.profileId))) continue;
          if (g.slug === 'neighbours') {
            if (c.lat == null || c.lon == null || e.lat == null || e.lon == null) continue;
            const dist = getDistanceKm(c.lat, c.lon, e.lat, e.lon);
            if (dist == null || dist > 100) continue;
          }
          const d = dist2(c, e);
          if (d < R2 || (c.near.has(e.sid) && d < H2)) now.set(e.sid, e.tv);
        }
      }
      for (const [s, v] of now) {
        if (c.near.get(s) === v) continue;
        const e = g.bySid.get(s);
        if (e) {
          const distKm = (g.slug === 'neighbours' && c.lat != null && e.lat != null)
            ? getDistanceKm(c.lat, c.lon, e.lat, e.lon)
            : null;
          c.socket.emit('near:in', { i: e.idx, sid: s, t: e.thought, m: e.mood, f: flagsOf(e), distKm });
        }
      }
      for (const s of c.near.keys()) if (!now.has(s)) c.socket.emit('near:out', { sid: s });
      c.near = now;
    }
  }

  // ---------- echoes: faint traces of earlier visitors + seed thoughts, so the sky never feels empty ----------
  function tendEchoes(g, snapshot) {
    if (process.env.NODE_ENV !== 'test') {
      for (const e of g.ents.values()) {
        if (e.echo) removeEntity(e);
      }
      return;
    }
    const real = realCount(g);
    const want = real === 0 ? 0 : real < 40 ? 14 : real < 150 ? 8 : 4;
    const ttl = getNumber('world.echo_hours') * 3_600_000;
    g.echoes = g.echoes.filter((e) => Date.now() - e.at < ttl);
    let have = 0;
    for (const e of g.ents.values()) if (e.echo) have++;
    if (snapshot) {
      while (have < want) {
        const past = g.echoes.length ? g.echoes.splice(crypto.randomInt(g.echoes.length), 1)[0] : null;
        const seeds = getPipeList('world.seed_thoughts');
        const e = {
          echo: true, sid: 'e' + sid(), profileId: null, blocked: new Set(), near: new Map(), tv: 1,
          x: past?.x ?? rand(-BOUND * 0.8, BOUND * 0.8), y: past?.y ?? rand(-BOUND * 0.8, BOUND * 0.8),
          mood: past?.m ?? crypto.randomInt(MOODS), thought: past?.t ?? pick(seeds) ?? '', isNew: false, vet: false, planet: null,
        };
        addEntity(g, e);
        io.to(room(g.slug)).emit('roster:add', pub(e));
        have++;
      }
      for (const e of g.ents.values()) {
        if (!e.echo) continue;
        if (have > want) { removeEntity(e); have--; continue; }
        e.x = clamp(e.x + rand(-25, 25), -BOUND, BOUND);
        e.y = clamp(e.y + rand(-25, 25), -BOUND, BOUND);
        g.changed = true;
      }
    }
  }

  // ---------- tick ----------
  let tickN = 0;
  const timer = setInterval(() => {
    tickN++;
    const snap = tickN % SNAPSHOT_EVERY === 0;
    for (const g of galaxies.values()) {
      if (!g.ents.size) continue;
      tendEchoes(g, snap);
      const list = [];
      for (const e of g.ents.values()) if (snap || e.dirty) { list.push(e); e.dirty = false; }
      if (list.length) {
        const buf = new Int16Array(list.length * 3);
        list.forEach((e, n) => { buf[n * 3] = e.idx; buf[n * 3 + 1] = Math.round(e.x * SCALE); buf[n * 3 + 2] = Math.round(e.y * SCALE); });
        io.to(room(g.slug)).volatile.emit('pos', Buffer.from(buf.buffer));
      }
      if (g.changed) { g.changed = false; computeNear(g); }
      if (g.meteor && Date.now() > g.meteor.until) g.meteor = null;
    }
    for (const [k, v] of evidence) if (Date.now() - v.at > 6 * 3_600_000) evidence.delete(k);
  }, TICK_MS);
  timer.unref?.();

  // Automated shooting stars removed to ensure all sky activity is authentic and user-driven
  const meteorTimer = null;

  function census() {
    const counts = {};
    let total = 0;
    for (const g of galaxies.values()) { const n = realCount(g); if (n) { counts[g.slug] = n; total += n; } }
    return { counts, total };
  }
  const censusTimer = setInterval(() => { if (online.size) io.emit('census', census()); }, 20_000);
  censusTimer.unref?.();

  // ---------- planets (private 1:1 chats; messages live in memory only) ----------
  const pairKey = (a, b) => [a, b].sort().join('|');
  function openPlanet(a, b, known) {
    const p = { id: sid(), a, b, msgs: [], start: Date.now(), keep: new Set(), count: 0, known, promptAt: 0, ended: false, lastMsg: new Map() };
    planets.set(p.id, p);
    a.planet = b.planet = p.id;
    a.pulsedBy.delete(b.sid); b.pulsedBy.delete(a.sid);
    const prompt = '';
    for (const [me, other] of [[a, b], [b, a]]) {
      const distKm = (me.lat != null && other.lat != null) ? getDistanceKm(me.lat, me.lon, other.lat, other.lon) : null;
      emit(me, 'planet:open', { pid: p.id, sid: other.sid, m: other.mood, t: other.thought, known, with: known ? { id: other.profileId, name: other.name } : null, prompt, distKm });
      broadcastFlag(me);
    }
    return p;
  }
  function endPlanet(pid, reason) {
    const p = planets.get(pid);
    if (!p || p.ended) return;
    p.ended = true;
    planets.delete(pid);
    for (const e of [p.a, p.b]) {
      if (e.planet === pid) e.planet = null;
      emit(e, 'planet:end', { reason });
      if (galaxies.get(e.galaxy)?.ents.get(e.idx) === e) broadcastFlag(e);
    }
    evidence.set(pairKey(p.a.profileId, p.b.profileId), { at: Date.now(), msgs: p.msgs.slice(-60) });
    db.from('planet_sessions').insert({ duration_s: Math.round((Date.now() - p.start) / 1000), msgs: p.count, kept: p.keep.size === 2 })
      .then(() => {}, () => {});
  }
  function broadcastFlag(e) {
    const g = galaxies.get(e.galaxy);
    if (g) { g.changed = true; io.to(room(g.slug)).emit('flag', { i: e.idx, f: flagsOf(e), m: e.mood }); }
  }
  const partner = (c) => { const p = c.planet && planets.get(c.planet); return p ? (p.a === c ? p.b : p.a) : null; };

  async function makeBond(a, b) {
    must(await db.from('keeps').upsert([{ from_id: a.profileId, to_id: b.profileId }, { from_id: b.profileId, to_id: a.profileId }], { onConflict: 'from_id,to_id', ignoreDuplicates: true }));
    a.bonds.add(b.profileId); b.bonds.add(a.profileId);
    emit(a, 'bond:new', { id: b.profileId, name: b.name, online: true });
    emit(b, 'bond:new', { id: a.profileId, name: a.name, online: true });
    const p = planets.get(a.planet);
    if (p) { p.known = true; }
  }

  // ---------- connection handling ----------
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length > 4000) return next(new Error('unauthenticated'));
      const a = await verifyFirebaseToken(token);
      if (!a.emailVerified) return next(new Error('email_not_verified'));
      const p = await getProfileByUid(a.uid);
      if (!p) return next(new Error('no_profile'));
      if (p.status !== 'active') return next(new Error('account_' + p.status));
      socket.data.profile = p;
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', async (socket) => {
    const p = socket.data.profile;
    const old = online.get(p.id);
    if (old) { emit(old, 'kicked', { reason: 'other_session' }); old.socket.disconnect(true); }

    const c = {
      socket, sid: sid(), profileId: p.id, name: p.display_name, mood: 0, thought: '', tv: 1, x: 0, y: 0, idx: -1,
      isNew: hoursSince(p.created_at) < 24, vet: hoursSince(p.created_at) > 24 * 30,
      blocked: new Set(), bonds: new Set(), near: new Map(), pulsedBy: new Map(), pulsedTo: new Map(), ring: new Map(),
      planet: null, rl: {}, dirty: false, galaxy: '', echo: false, lastMove: Date.now(), alive: true,
      lat: null, lon: null,
    };
    bySocket.set(socket, c);
    online.set(p.id, c);

    const on = (ev, fn) => socket.on(ev, async (...args) => {
      if (!c.alive) return;
      try { await fn(...args); } catch (e) { console.warn('[world]', ev, e.message); }
    });
    const ack = (cb, v) => { if (typeof cb === 'function') cb(v); };

    try {
      const [blk, bonds] = await Promise.all([blockedSet(p.id), bondList(p.id)]);
      c.blocked = blk;
      for (const b of bonds) c.bonds.add(b.id);
      if (!socket.connected) { c.alive = false; if (online.get(p.id) === c) online.delete(p.id); return; }
      const cfg = publicConfig();
      socket.emit('hello', {
        sid: c.sid, id: p.id, name: p.display_name, radius: getNumber('world.reveal_radius'), bound: BOUND, scale: SCALE,
        thoughtMax: getNumber('world.thought_max'), galaxies: cfg.galaxies, skyTheme: cfg.skyTheme, announcement: cfg.announcement,
        bonds: bonds.map((b) => ({ ...b, online: online.has(b.id) })),
      });
      const slug = pickGalaxy(validSlug(p.galaxy) ? p.galaxy : galaxyDefs()[0].slug);
      if (!slug) { socket.emit('full', {}); socket.disconnect(true); return; }
      enterGalaxy(c, slug);
      for (const id of c.bonds) { const o = online.get(id); if (o) emit(o, 'bond:presence', { id: p.id, online: true }); }
      markActive(p.id);
    } catch (e) {
      console.warn('[world] connect failed', e.message);
      socket.disconnect(true);
      return;
    }

    on('move', (d) => {
      if (!d || !num(d.x) || !num(d.y)) return;
      const now = Date.now();
      const dt = clamp(now - c.lastMove, 50, 1000) / 1000;
      c.lastMove = now;
      let nx = clamp(d.x, -BOUND, BOUND), ny = clamp(d.y, -BOUND, BOUND);
      const maxd = getNumber('world.max_speed') * dt * 1.3 + 4;
      const dx = nx - c.x, dy = ny - c.y, len = Math.hypot(dx, dy);
      if (len > maxd) { nx = c.x + (dx / len) * maxd; ny = c.y + (dy / len) * maxd; }
      if (nx === c.x && ny === c.y) return;
      c.x = nx; c.y = ny; c.dirty = true;
      const g = galaxies.get(c.galaxy); if (g) g.changed = true;
    });

    on('thought', (d, cb) => {
      if (!bucket(c, 'thought', 6, 60_000)) return ack(cb, { error: 'slow_down' });
      const text = cleanText(d?.text, getNumber('world.thought_max'));
      const mood = Number.isInteger(d?.mood) && d.mood >= 0 && d.mood < MOODS ? d.mood : c.mood;
      if (text && (hasLink(text) || containsBlocked(text, getList('moderation.blocked_words')))) return ack(cb, { error: 'not_allowed' });
      c.thought = text; c.mood = mood; c.tv++;
      broadcastFlag(c);
      ack(cb, { ok: true });
    });

    on('travel', (d, cb) => {
      if (!bucket(c, 'travel', 6, 60_000)) return ack(cb, { error: 'slow_down' });
      const slug = d?.galaxy;
      if (typeof slug !== 'string' || !validSlug(slug) || slug === c.galaxy) return ack(cb, { error: 'invalid' });
      if (realCount(G(slug)) >= getNumber('world.galaxy_cap')) return ack(cb, { error: 'full' });
      leaveGalaxy(c);
      enterGalaxy(c, slug);
      ack(cb, { ok: true });
    });

    on('galaxy:add', (d, cb) => {
      if (!bucket(c, 'galaxy:add', 5, 60_000)) return ack(cb, { error: 'slow_down' });
      const name = cleanText(d?.name, 24);
      if (!name || name.length < 2) return ack(cb, { error: 'invalid' });
      if (containsBlocked(name, getList('moderation.blocked_words'))) return ack(cb, { error: 'not_allowed' });
      const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'interest-' + Math.random().toString(36).slice(2, 6);
      const color = (typeof d?.color === 'string' && /^#[0-9a-f]{6}$/i.test(d.color)) ? d.color : pick(['#7aa2ff', '#ff8fb1', '#79e6b6', '#7fdcff', '#ffd27a', '#c4a0ff', '#ffb07a', '#a5b4fc']);
      const def = addDynamicGalaxy({ slug, name, color });
      io.emit('galaxies:update', { galaxies: galaxyDefs() });
      ack(cb, { ok: true, galaxy: def });
    });

    on('hop', () => {
      if (!bucket(c, 'hop', 3, 20_000)) return;
      const g = galaxies.get(c.galaxy);
      const cands = [...g.ents.values()].filter((e) => !e.echo && e !== c && !c.blocked.has(e.profileId) && !e.blocked.has(c.profileId));
      const t = pick(cands);
      if (!t) return;
      c.x = clamp(t.x + rand(-70, 70), -BOUND, BOUND); c.y = clamp(t.y + rand(-70, 70), -BOUND, BOUND);
      c.dirty = true; g.changed = true; c.lastMove = Date.now();
      socket.emit('warp', { x: c.x, y: c.y });
    });

    on('location:set', (d, cb) => {
      if (!d || !num(d.lat) || !num(d.lon)) return ack(cb, { error: 'invalid' });
      if (d.lat < -90 || d.lat > 90 || d.lon < -180 || d.lon > 180) return ack(cb, { error: 'invalid' });
      c.lat = Math.round(d.lat * 100) / 100;
      c.lon = Math.round(d.lon * 100) / 100;
      if (c.galaxy && galaxies.has(c.galaxy)) {
        const g = galaxies.get(c.galaxy);
        emit(c, 'hide', { sids: hideFor(c, g) });
        for (const other of g.ents.values()) {
          if (!other.echo && other !== c) {
            emit(other, 'hide', { sids: hideFor(other, g) });
          }
        }
        g.changed = true;
      }
      ack(cb, { ok: true, lat: c.lat, lon: c.lon });
    });

    on('location:clear', (cb) => {
      c.lat = null;
      c.lon = null;
      if (c.galaxy && galaxies.has(c.galaxy)) {
        const g = galaxies.get(c.galaxy);
        emit(c, 'hide', { sids: hideFor(c, g) });
        for (const other of g.ents.values()) {
          if (!other.echo && other !== c) {
            emit(other, 'hide', { sids: hideFor(other, g) });
          }
        }
        g.changed = true;
      }
      ack(cb, { ok: true });
    });

    // list view (low-end devices / no WebGL): a sample of nearby thoughts that can also be pulsed
    on('feed', (d, cb) => {
      if (!bucket(c, 'feed', 1, 4_000)) return ack(cb, { error: 'slow_down' });
      const g = galaxies.get(c.galaxy);
      const isNeighbours = c.galaxy === 'neighbours';
      const cands = [...g.ents.values()].filter((e) => {
        if (e === c || !e.thought) return false;
        if (!e.echo && (c.blocked.has(e.profileId) || e.blocked.has(c.profileId))) return false;
        if (isNeighbours) {
          if (c.lat == null || c.lon == null || e.lat == null || e.lon == null) return false;
          const dist = getDistanceKm(c.lat, c.lon, e.lat, e.lon);
          return dist != null && dist <= 100;
        }
        return true;
      });
      const out = [];
      while (cands.length && out.length < 24) {
        const e = cands.splice(crypto.randomInt(cands.length), 1)[0];
        c.near.set(e.sid, e.tv);
        const distKm = (isNeighbours && c.lat != null && e.lat != null) ? getDistanceKm(c.lat, c.lon, e.lat, e.lon) : null;
        out.push({ i: e.idx, sid: e.sid, t: e.thought, m: e.mood, f: flagsOf(e), distKm });
      }
      ack(cb, { lights: out });
    });

    on('pulse', (d) => {
      const t = typeof d?.sid === 'string' ? galaxies.get(c.galaxy)?.bySid.get(d.sid) : null;
      if (!t || t === c) return;
      if (!bucket(c, 'pulse', getNumber('limits.pulses_per_min'), 60_000)) return socket.emit('pulse:limit', {});
      if (c.planet) return;
      if (t.echo) return socket.emit('pulse:echo', { sid: t.sid });
      const replying = c.pulsedBy.has(t.sid) && Date.now() - c.pulsedBy.get(t.sid) < PULSE_WINDOW;
      if (!replying && !c.near.has(t.sid)) return;
      if (c.blocked.has(t.profileId) || t.blocked.has(c.profileId)) return;
      if (t.planet) return socket.emit('pulse:busy', { sid: t.sid });
      if (replying) { openPlanet(c, t, false); return; }
      c.pulsedTo.set(t.sid, Date.now());
      t.pulsedBy.set(c.sid, Date.now());
      socket.emit('pulse:sent', { sid: t.sid });
      emit(t, 'pulse:in', { sid: c.sid, i: c.idx, m: c.mood });
    });

    on('planet:send', (d, cb) => {
      const p2 = c.planet && planets.get(c.planet);
      if (!p2) return ack(cb, { error: 'no_planet' });
      const limit = getNumber('limits.messages_per_10s');
      if (!bucket(c, 'msg', limit, 10_000)) return ack(cb, { error: 'slow_down' });
      const text = cleanText(d?.text, getNumber('limits.max_message_length'));
      if (!text) return;
      if (hasLink(text) || containsBlocked(text, getList('moderation.blocked_words'))) return ack(cb, { error: 'not_allowed' });
      const other = partner(c);
      const ts = Date.now();
      p2.msgs.push({ from: c.profileId, t: text, ts }); if (p2.msgs.length > 200) p2.msgs.shift();
      p2.count++;
      emit(other, 'planet:msg', { t: text, ts });
      ack(cb, { ok: true, ts });
    });
    on('planet:typing', () => { if (bucket(c, 'typing', 8, 10_000)) emit(partner(c) || {}, 'planet:typing', {}); });
    on('planet:prompt', () => {
      const p2 = c.planet && planets.get(c.planet);
      if (!p2 || Date.now() - p2.promptAt < 20_000) return;
      p2.promptAt = Date.now();
      const q = pick(getPipeList('world.prompts'));
      if (q) { emit(p2.a, 'planet:prompt', { q }); emit(p2.b, 'planet:prompt', { q }); }
    });
    on('planet:keep', async () => {
      const p2 = c.planet && planets.get(c.planet);
      if (!p2 || p2.keep.has(c.profileId)) return;
      p2.keep.add(c.profileId);
      socket.emit('planet:kept', { mine: true });
      if (p2.keep.size === 2) await makeBond(p2.a, p2.b);
    });
    on('planet:leave', () => { if (c.planet) endPlanet(c.planet, 'left'); });

    on('bond:call', (d) => {
      const t = typeof d?.id === 'string' ? online.get(d.id) : null;
      if (!t || !c.bonds.has(t.profileId) || c.planet || t.planet) return;
      if (!bucket(c, 'ring', 4, 60_000)) return;
      t.ring.set(c.profileId, Date.now());
      emit(t, 'bond:ring', { id: c.profileId, name: c.name });
    });
    on('bond:answer', (d) => {
      const t = typeof d?.id === 'string' ? online.get(d.id) : null;
      if (!t) return;
      const at = c.ring.get(t.profileId);
      c.ring.delete(t.profileId);
      if (!d.accept || !at || Date.now() - at > 40_000 || c.planet || t.planet || !c.bonds.has(t.profileId)) return emit(t, 'bond:declined', { id: c.profileId });
      openPlanet(t, c, true);
    });

    on('meteor:catch', (d, cb) => {
      const g = galaxies.get(c.galaxy), m = g?.meteor;
      if (!m || d?.id !== m.id || m.caught.has(c.profileId)) return ack(cb, { error: 'gone' });
      if (dist2(c, m) > 260 * 260) return ack(cb, { error: 'too_far' });
      m.caught.add(c.profileId);
      ack(cb, { prompt: m.prompt });
    });

    on('block', async (d, cb) => {
      const t = typeof d?.sid === 'string' ? galaxies.get(c.galaxy)?.bySid.get(d.sid) : null;
      if (!t || t.echo || t === c) return ack(cb, { error: 'invalid' });
      if (!bucket(c, 'block', 20, 60_000)) return ack(cb, { error: 'slow_down' });
      await applyBlock(c, t);
      ack(cb, { ok: true });
    });

    on('report', async (d, cb) => {
      const g = galaxies.get(c.galaxy);
      const t = typeof d?.sid === 'string' ? g?.bySid.get(d.sid) : null;
      if (!t || t.echo || t === c || !REASONS.includes(d.reason)) return ack(cb, { error: 'invalid' });
      if (!(c.near.has(t.sid) || partner(c) === t)) return ack(cb, { error: 'invalid' });
      if (!bucket(c, 'report', 6, 600_000)) return ack(cb, { error: 'slow_down' });
      const inPlanet = partner(c) === t;
      const pl = inPlanet ? planets.get(c.planet) : null;
      const ev = {
        galaxy: g.slug, at: new Date().toISOString(), thought: t.thought, mood: t.mood,
        transcript: pl ? pl.msgs.slice(-40).map((m) => ({ who: m.from === c.profileId ? 'reporter' : 'reported', t: m.t, ts: m.ts })) : undefined,
      };
      must(await db.from('reports').insert({
        reporter: c.profileId, reported: t.profileId, kind: inPlanet ? 'planet' : 'light', reason: d.reason,
        details: cleanText(d.details, 300), evidence: ev,
      }));
      await applyBlock(c, t);
      ack(cb, { ok: true });
    });

    socket.on('disconnect', () => {
      if (!c.alive) return;
      c.alive = false;
      if (online.get(p.id) === c) online.delete(p.id);
      if (c.idx >= 0 && galaxies.get(c.galaxy)?.ents.get(c.idx) === c) leaveGalaxy(c);
      for (const id of c.bonds) { const o = online.get(id); if (o) emit(o, 'bond:presence', { id: p.id, online: false }); }
    });
  });

  async function applyBlock(c, t) {
    must(await db.from('blocks').upsert({ blocker: c.profileId, blocked: t.profileId }, { onConflict: 'blocker,blocked', ignoreDuplicates: true }));
    c.blocked.add(t.profileId); t.blocked.add(c.profileId);
    if (c.planet && partner(c) === t) endPlanet(c.planet, 'blocked');
    emit(c, 'hide', { sids: [t.sid] });
    emit(t, 'hide', { sids: [c.sid] });
    c.near.delete(t.sid); t.near.delete(c.sid);
    const g = galaxies.get(c.galaxy); if (g) g.changed = true;
  }

  return {
    io,
    isOnline: (id) => online.has(id),
    kick(id, reason = 'removed') { const e = online.get(id); if (e) { emit(e, 'kicked', { reason }); e.socket.disconnect(true); } },
    notify(id, ev, payload) { const e = online.get(id); if (e) emit(e, ev, payload); },
    // a REST-side block (e.g. from a bond list) must take effect in the live sky immediately
    refreshBlocks: async (id) => { const e = online.get(id); if (e) { e.blocked = await blockedSet(id); const g = galaxies.get(e.galaxy); if (g) { emit(e, 'hide', { sids: hideFor(e, g) }); g.changed = true; } } },
    onBlockRest(a, b) {
      const ea = online.get(a), eb = online.get(b);
      if (ea) ea.blocked.add(b);
      if (eb) eb.blocked.add(a);
      if (ea && eb) { ea.bonds.delete(b); eb.bonds.delete(a); if (ea.planet && partner(ea) === eb) endPlanet(ea.planet, 'blocked'); emit(ea, 'hide', { sids: [eb.sid] }); emit(eb, 'hide', { sids: [ea.sid] }); }
    },
    onBondChange(id, otherId, on) { const e = online.get(id); if (e) { on ? e.bonds.add(otherId) : e.bonds.delete(otherId); } },
    getEvidence: (a, b) => evidence.get(pairKey(a, b))?.msgs || [],
    stats() {
      const gs = galaxyDefs().map((d) => ({ slug: d.slug, name: d.name, count: galaxies.has(d.slug) ? realCount(galaxies.get(d.slug)) : 0 }));
      return { online: online.size, planets: planets.size, galaxies: gs, memMb: Math.round(process.memoryUsage().rss / 1048576) };
    },
    close() { clearInterval(timer); if (meteorTimer) clearInterval(meteorTimer); clearInterval(censusTimer); io.close(); },
  };
}
