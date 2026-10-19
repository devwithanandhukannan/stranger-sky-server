import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db, must } from './db.js';
import { config } from './config.js';
import { getSetting } from './settings.js';
import { ah } from './util.js';

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
  { cooldownDuration: 30_000, cacheMaxAge: 6 * 60 * 60 * 1000 }
);

// Verifies a Firebase ID token locally: signature, issuer, audience and expiry. No service account needed.
export async function verifyFirebaseToken(token) {
  const projectId = getSetting('firebase.projectId');
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  });
  if (!payload.sub) throw new Error('no subject');
  return {
    uid: payload.sub,
    email: (payload.email || '').toLowerCase(),
    emailVerified: payload.email_verified === true,
    authTime: Number(payload.auth_time) || 0,
  };
}

const cache = new Map();
const TTL = 15_000;

export function invalidate(uid) {
  if (uid) cache.delete(uid);
  else cache.clear();
}

export async function getProfileByUid(uid) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.t < TTL) return hit.p;
  let p = must(await db.from('profiles').select('*').eq('uid', uid).maybeSingle());
  if (p) {
    const patch = {};
    if (p.role !== 'admin' && config.adminEmails.includes((p.email || '').toLowerCase())) patch.role = 'admin';
    if (Date.now() - new Date(p.last_seen).getTime() > 5 * 60_000) patch.last_seen = new Date().toISOString();
    if (Object.keys(patch).length) p = must(await db.from('profiles').update(patch).eq('id', p.id).select('*').single());
  }
  cache.set(uid, { p, t: Date.now() });
  return p;
}

export const authn = ah(async (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'unauthenticated' });
  try {
    req.auth = await verifyFirebaseToken(m[1]);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (!req.auth.emailVerified) return res.status(403).json({ error: 'email_not_verified' });
  next();
});

export const withProfile = ah(async (req, res, next) => {
  req.me = await getProfileByUid(req.auth.uid);
  if (!req.me) return res.status(404).json({ error: 'no_profile' });
  if (req.me.status !== 'active') return res.status(403).json({ error: 'account_' + req.me.status });
  next();
});

// Admin guard: valid login + verified email + admin role + a RECENT sign-in + request from the admin origin.
// A non-admin gets the same generic 403 as a missing page, so the admin surface is not advertised.
export const adminGuard = [
  authn,
  withProfile,
  (req, res, next) => {
    if (req.me?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const age = Date.now() / 1000 - (req.auth.authTime || 0);
    if (age > config.adminMaxAuthAgeHours * 3600) return res.status(401).json({ error: 'reauth_required' });
    const origin = req.headers.origin;
    if (origin && config.adminOrigin && origin !== config.adminOrigin) return res.status(403).json({ error: 'forbidden' });
    next();
  },
];
