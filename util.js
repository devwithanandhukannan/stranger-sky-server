import crypto from 'node:crypto';

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const randInt = (lo, hi) => crypto.randomInt(lo, hi + 1);
export const pick = (arr) => (arr.length ? arr[crypto.randomInt(arr.length)] : undefined);
export const rand = (lo, hi) => lo + (crypto.randomInt(1_000_000) / 1_000_000) * (hi - lo);

export function ageFrom(dob) {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return -1;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

// strip control / bidi-override / zero-width characters and collapse whitespace
export function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

export function containsBlocked(text, words) {
  if (!words.length) return false;
  const t = text.toLowerCase();
  return words.some((w) => w && t.includes(w));
}

// links and handles are the main scam / spam vector in a stranger app
export const hasLink = (t) => /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|co|in|app|xyz|ru|cn|tk|ly|gg|link)\b|t\.me\/|wa\.me\/)/i.test(t);

export const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3_600_000;
