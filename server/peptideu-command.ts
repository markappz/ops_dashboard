/**
 * PeptideU Command Center feed — the app's Supabase, windowed like every other
 * brand: signups, activations, engagement and community counts for the chosen
 * range vs the previous range of equal length, plus the standing membership
 * picture (premium, MRR estimate, funnel) and the queues that need a human.
 */
import type { Express, Request, Response } from "express";
import { peptidePool } from "./db";
import { windowOf, type Window } from "./lib/window";

const cache = new Map<string, { at: number; data: any }>();
const CACHE_MS = 60_000;
const PLAN_MONTHLY = Number(process.env.PEPTIDEU_PREMIUM_MONTHLY_USD || "8.33"); // $99.99/yr
const DAY = 86_400_000;

async function counts(from: Date, to: Date) {
  const { rows } = await peptidePool!.query(`
    SELECT
      (SELECT count(*) FROM profiles WHERE created_at >= $1 AND created_at <= $2)::int AS signups,
      (SELECT count(*) FROM profiles WHERE onboarding_complete AND created_at >= $1 AND created_at <= $2)::int AS onboarded,
      (SELECT count(DISTINCT user_id) FROM lesson_progress WHERE completed_at >= $1 AND completed_at <= $2)::int AS active_learners,
      (SELECT count(*) FROM lesson_progress WHERE status = 'completed' AND completed_at >= $1 AND completed_at <= $2)::int AS lessons_completed,
      (SELECT count(*) FROM quiz_attempts WHERE created_at >= $1 AND created_at <= $2)::int AS quiz_attempts,
      (SELECT count(*) FROM quiz_attempts WHERE passed AND created_at >= $1 AND created_at <= $2)::int AS quiz_passes,
      (SELECT count(*) FROM ask_messages WHERE role = 'user' AND created_at >= $1 AND created_at <= $2)::int AS questions,
      (SELECT count(DISTINCT user_id) FROM ask_messages WHERE role = 'user' AND created_at >= $1 AND created_at <= $2)::int AS askers,
      (SELECT count(*) FROM coa_scans WHERE created_at >= $1 AND created_at <= $2)::int AS coa_scans,
      (SELECT count(*) FROM community_posts WHERE created_at >= $1 AND created_at <= $2)::int AS posts,
      (SELECT count(*) FROM comments WHERE created_at >= $1 AND created_at <= $2)::int AS comments,
      (SELECT count(*) FROM oh_rsvps WHERE created_at >= $1 AND created_at <= $2)::int AS oh_rsvps,
      (SELECT count(*) FROM research_logs WHERE created_at >= $1 AND created_at <= $2)::int AS research_logs,
      (SELECT coalesce(sum(entries), 0) FROM sweepstakes_entries WHERE created_at >= $1 AND created_at <= $2)::int AS drawing_entries,
      (SELECT count(*) FROM membership_grants WHERE granted_at >= $1 AND granted_at <= $2)::int AS memberships_granted,
      (SELECT count(DISTINCT user_id) FROM (
         SELECT user_id FROM lesson_progress WHERE completed_at >= $1 AND completed_at <= $2
         UNION SELECT user_id FROM ask_messages WHERE created_at >= $1 AND created_at <= $2
         UNION SELECT user_id FROM community_posts WHERE created_at >= $1 AND created_at <= $2
         UNION SELECT user_id FROM research_logs WHERE created_at >= $1 AND created_at <= $2
         UNION SELECT user_id FROM coa_scans WHERE created_at >= $1 AND created_at <= $2
       ) a)::int AS active_members
  `, [from, to]);
  return rows[0];
}

async function standing() {
  const { rows } = await peptidePool!.query(`
    SELECT
      (SELECT count(*) FROM profiles)::int AS total_users,
      (SELECT count(*) FROM profiles WHERE entitlement = 'premium')::int AS premium,
      (SELECT count(*) FROM profiles WHERE entitlement = 'premium' AND comp_until IS NOT NULL AND comp_until > now())::int AS comped,
      (SELECT count(*) FROM profiles WHERE onboarding_complete)::int AS onboarded,
      (SELECT count(DISTINCT user_id) FROM lesson_progress WHERE status = 'completed')::int AS activated,
      (SELECT count(*) FROM profiles WHERE rank = 'graduate')::int AS graduates,
      (SELECT count(*) FROM peptide_requests WHERE status = 'pending')::int AS peptide_requests,
      (SELECT count(*) FROM brand_requests WHERE status = 'pending')::int AS brand_requests,
      (SELECT count(*) FROM feature_requests WHERE status = 'pending')::int AS feature_requests,
      (SELECT count(*) FROM library_updates WHERE status = 'pending')::int AS library_updates,
      (SELECT count(*) FROM drawings WHERE status IN ('scheduled','live'))::int AS drawings_scheduled,
      (SELECT count(*) FROM profiles WHERE entitlement = 'premium' AND subscription_expires_at IS NOT NULL AND subscription_expires_at < now() + interval '14 days')::int AS expiring_14d
  `);
  return rows[0];
}

async function daily(win: Window) {
  const { rows } = await peptidePool!.query(`
    SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
           coalesce((SELECT count(*) FROM profiles p WHERE p.created_at::date = d::date), 0)::int AS signups,
           coalesce((SELECT count(DISTINCT user_id) FROM lesson_progress lp WHERE lp.completed_at::date = d::date), 0)::int AS learners
    FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY 1`, [win.from, win.to]);
  return rows;
}

async function build(win: Window) {
  const [cur, prev, s, series] = await Promise.all([counts(win.from, win.to), counts(win.prevFrom, win.prevTo), standing(), daily(win)]);
  const today = await counts(new Date(Date.now() - DAY), new Date());
  const premiumPaying = Number(s.premium) - Number(s.comped);
  return {
    generatedAt: new Date().toISOString(),
    window: { from: win.from.toISOString(), to: win.to.toISOString(), days: win.days, custom: win.custom },
    current: cur, previous: prev, today,
    members: {
      total: s.total_users, premium: s.premium, comped: s.comped, paying: premiumPaying,
      mrrEstimate: Math.round(premiumPaying * PLAN_MONTHLY), arrEstimate: Math.round(premiumPaying * PLAN_MONTHLY * 12),
      conversion: s.total_users ? s.premium / s.total_users : 0,
      onboarded: s.onboarded, activated: s.activated, graduates: s.graduates, expiring14d: s.expiring_14d,
    },
    queues: { peptideRequests: s.peptide_requests, brandRequests: s.brand_requests, featureRequests: s.feature_requests, libraryUpdates: s.library_updates, drawingsScheduled: s.drawings_scheduled },
    series,
  };
}

export function registerPeptideUCommand(app: Express) {
  app.get("/api/ops/peptideu/command", async (req: Request, res: Response) => {
    if (!peptidePool) return res.json({ configured: false, hint: "PeptideU database not connected — set PEPTIDEU_DATABASE_URL." });
    const win = windowOf(req.query as Record<string, unknown>);
    const hit = cache.get(win.key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
      const data = { configured: true, ...(await build(win)) };
      cache.set(win.key, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      console.error("[OPS][peptideu] command:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
