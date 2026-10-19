import 'dotenv/config';

const list = (s) => (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const origins = (s) => (s || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
const isProd = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT) || 4000,
  isProd,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSecret: process.env.SUPABASE_SECRET_KEY || '',
  encKey: process.env.SETTINGS_ENCRYPTION_KEY || '',
  adminEmails: list(process.env.ADMIN_EMAILS),
  // The user app and the admin app live on different origins on purpose.
  webOrigins: origins(process.env.WEB_ORIGIN || (isProd ? '' : 'http://localhost:3000')),
  adminOrigin: origins(process.env.ADMIN_ORIGIN || (isProd ? '' : 'http://localhost:3001'))[0] || '',
  adminMaxAuthAgeHours: Number(process.env.ADMIN_MAX_AUTH_AGE_HOURS) || 12,
};

export function assertConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseSecret) missing.push('SUPABASE_SECRET_KEY');
  if (config.isProd && !config.webOrigins.length) missing.push('WEB_ORIGIN');
  if (config.isProd && !config.adminOrigin) missing.push('ADMIN_ORIGIN');
  if (missing.length) {
    console.error('Missing required env: ' + missing.join(', ') + ' (see .env.example)');
    process.exit(1);
  }
  if (!config.encKey) console.warn('SETTINGS_ENCRYPTION_KEY not set: secret settings cannot be saved from the admin app.');
}
