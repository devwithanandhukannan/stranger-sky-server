import { db } from './db.js';

const iso = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

// Keeps the database small and honours the "temporary" promise. Runs at start and then daily.
export async function maintain() {
  const jobs = [
    db.from('lanterns').update({ status: 'landed', holder: null }).eq('status', 'floating').lt('created_at', iso(14)),
    db.from('planet_sessions').delete().lt('ended_at', iso(90)),
    db.from('daily_activity').delete().lt('day', iso(120).slice(0, 10)),
    db.from('reports').delete().in('status', ['actioned', 'dismissed']).lt('resolved_at', iso(180)),
    db.from('audit_logs').delete().lt('created_at', iso(365)),
    db.from('lantern_replies').delete().lt('created_at', iso(60)),
  ];
  const res = await Promise.allSettled(jobs);
  res.forEach((r) => { if (r.status === 'rejected' || r.value?.error) console.warn('[maintenance]', r.reason?.message || r.value.error.message); });
}
