import type { Express, Request, Response } from "express";
import { pool } from "./db";
import { windowOf } from "./lib/window";
import { fsWindowRevenue, fsMrrCents } from "./lib/fitscript-revenue";

/**
 * The FitScript Overview feed (2026-10-12, Paul: "sorted by the calendar…
 * new users today, active users, billing for the day and what it equals
 * for the year or monthly"). ONE window from the picker drives every
 * figure here; the only point-in-time numbers are MRR/ARR and the tier
 * counts, which are labeled "now". Pace equivalents are explicitly "if
 * every day ran like this window" — an extrapolation Paul asked to see,
 * never a forecast.
 */
export function registerFitscriptOverviewRoutes(app: Express) {
  app.get("/api/ops/fitscript/overview", async (req: Request, res: Response) => {
    try {
      const win = windowOf(req.query as Record<string, unknown>);
      const [cur, prev, mrrCents, usersQ, subsQ, sessionsQ, activityQ] = await Promise.all([
        fsWindowRevenue(win.from, win.to),
        fsWindowRevenue(win.prevFrom, win.prevTo),
        fsMrrCents(),
        pool.query(
          `SELECT (SELECT count(*) FROM users)::int AS total,
                  (SELECT count(*) FROM users WHERE created_at >= $1 AND created_at <= $2)::int AS new_cur,
                  (SELECT count(*) FROM users WHERE created_at >= $3 AND created_at <= $4)::int AS new_prev,
                  (SELECT count(*) FROM users WHERE last_active_date >= $1 AND last_active_date <= $2)::int AS active`,
          [win.from, win.to, win.prevFrom, win.prevTo],
        ),
        pool.query(
          `SELECT (SELECT count(*) FROM users WHERE subscription_tier != 'free' AND subscription_status = 'active')::int AS active_subs,
                  (SELECT count(*) FROM users WHERE subscription_tier = 'free' OR subscription_tier IS NULL)::int AS free,
                  (SELECT count(*) FROM users WHERE subscription_tier = 'essentials' AND subscription_status = 'active')::int AS essentials,
                  (SELECT count(*) FROM users WHERE subscription_tier = 'complete' AND subscription_status = 'active')::int AS complete,
                  (SELECT count(DISTINCT user_id) FROM membership_charges mc
                    WHERE mc.status = 'paid' AND mc.created_at >= $1 AND mc.created_at <= $2
                      AND NOT EXISTS (SELECT 1 FROM membership_charges p
                                       WHERE p.user_id = mc.user_id AND p.status = 'paid' AND p.created_at < $1))::int AS new_paying,
                  (SELECT count(*) FROM subscriptions WHERE status = 'canceled'
                      AND COALESCE(updated_at, created_at) >= $1 AND COALESCE(updated_at, created_at) <= $2)::int AS cancels`,
          [win.from, win.to],
        ),
        pool.query(
          `SELECT count(*) FILTER (WHERE created_at >= $1 AND created_at <= $2)::int AS cur,
                  count(*) FILTER (WHERE created_at >= $3 AND created_at <= $4)::int AS prev
             FROM visitor_sessions WHERE site = 'fitscript' AND created_at >= $3`,
          [win.from, win.to, win.prevFrom, win.prevTo],
        ),
        pool.query(
          `SELECT (SELECT count(*) FROM lab_uploads WHERE uploaded_at >= $1 AND uploaded_at <= $2)::int AS labs,
                  (SELECT count(*) FROM ai_advisor_conversations WHERE created_at >= $1 AND created_at <= $2)::int AS chats`,
          [win.from, win.to],
        ),
      ]);

      // Pace: window total scaled by elapsed time. For "Today" that is
      // today-so-far × (period / elapsed fraction) — Paul's "what today's
      // billing equals for the month/year". Clamped to ≥ 1 hour elapsed so
      // 12:01am never claims a million-dollar year.
      const elapsedMs = Math.max(Math.min(Date.now(), win.to.getTime()) - win.from.getTime(), 3_600_000);
      const perDay = cur.cents / (elapsedMs / 86_400_000);
      const series: { date: string; cents: number }[] = [];
      for (let t = win.from.getTime(); t <= win.to.getTime(); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        series.push({ date: d, cents: cur.byDay[d] ?? 0 });
      }

      res.json({
        window: { from: win.from.toISOString(), to: win.to.toISOString(), days: win.days },
        revenue: {
          cents: cur.cents, prevCents: prev.cents, orders: cur.orders,
          byRail: cur.byRail, series,
          paceDailyCents: Math.round(perDay),
          paceMonthlyCents: Math.round(perDay * 30.44),
          paceAnnualCents: Math.round(perDay * 365.25),
          paceNote: "if every day ran like this window",
          basis: "Wizlo membership charges + supplement orders + lab orders, net of refunds",
        },
        mrr: { cents: mrrCents, arrCents: mrrCents * 12 },
        users: {
          total: usersQ.rows[0].total,
          newInWindow: usersQ.rows[0].new_cur, newPrev: usersQ.rows[0].new_prev,
          activeInWindow: usersQ.rows[0].active,
        },
        subscribers: {
          activeNow: subsQ.rows[0].active_subs,
          tiers: { free: subsQ.rows[0].free, essentials: subsQ.rows[0].essentials, complete: subsQ.rows[0].complete },
          newPayingInWindow: subsQ.rows[0].new_paying,
          cancelsInWindow: subsQ.rows[0].cancels,
        },
        sessions: { cur: sessionsQ.rows[0].cur, prev: sessionsQ.rows[0].prev },
        activity: { labUploads: activityQ.rows[0].labs, atlasChats: activityQ.rows[0].chats },
      });
    } catch (e) {
      console.error("[OPS][FS-OVERVIEW]", e);
      res.status(500).json({ error: "Failed to load FitScript overview" });
    }
  });
}
