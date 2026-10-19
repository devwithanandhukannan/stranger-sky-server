import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const db = createClient(config.supabaseUrl || 'http://localhost', config.supabaseSecret || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function must({ data, error }) {
  if (error) {
    const e = new Error(error.message);
    e.code = error.code;
    throw e;
  }
  return data;
}
