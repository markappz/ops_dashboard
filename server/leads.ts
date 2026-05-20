/**
 * Leads — visitors and signups who haven't converted to paid yet.
 *
 * Source data:
 *   - visitor_sessions / touchpoints (first-party tracking, fed by the pixel)
 *   - attribution (computed on identify; carries first/last-touch + revenue)
 *   - users (FitScript app data)
 *
 * Status classification:
 *   - Paid          → user_id exists AND attribution.total_revenue > 0
 *   - Hot           → signed up + uploaded labs / completed quiz / visited
 *                     ≥3 sessions, within last 14 days
 *   - Engaged       → signed up but no high-intent action OR
 *                     >2 sessions / quiz_started but no signup
 *   - Cold          → 1-2 sessions, no signup
 *
 * The funnel uses the existing /api/ops/funnel structure but breaks
 * out the stages so the page can render conversion rates per step.
 */
import type { Express } from "express";
import { pool } from "./db";

interface LeadRow {
  visitorId: string;
  userId: string | null;
  email: string | null;
  firstName: string | null;
  status: "Paid" | "Hot" | "Engaged" | "Cold";
  source: string | null;
  medium: string | null;
  campaign: string | null;
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  daysSinceFirstTouch: number;
  daysSinceLastTouch: number;
  sessions: number;
  touchpoints: number;
  revenue: number;
  signedUp: boolean;
}

function daysSince(iso: string | null): number {
  if (!iso) return -1;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function classifyStatus(args: {
  revenue: number;
  signedUp: boolean;
  sessions: number;
  daysSinceLastTouch: number;
  hasLabUpload: boolean;
  hasQuiz: boolean;
}): LeadRow["status"] {
  if (args.revenue > 0) return "Paid";

  if (
    args.signedUp &&
    (args.hasLabUpload || args.hasQuiz || args.sessions >= 3) &&
    args.daysSinceLastTouch <= 14
  ) {
    return "Hot";
  }

  if (args.signedUp || args.sessions >= 3 || args.hasQuiz) {
    return "Engaged";
  }

  return "Cold";
}

export function registerLeadsRoutes(app: Express) {
  // List leads. Filters: ?status=Cold|Engaged|Hot|Paid, ?source=...,
  // ?days=N (only visitors with activity in last N days), ?limit=N.
  app.get("/api/ops/leads", async (req, res) => {
    try {
      const statusFilter = (req.query.status as string) || "";
      const sourceFilter = (req.query.source as string) || "";
      const days = Math.min(
        Math.max(parseInt((req.query.days as string) || "90"), 1),
        365,
      );
      const limit = Math.min(
        Math.max(parseInt((req.query.limit as string) || "200"), 1),
        1000,
      );

      // Detect whether the tracking schema exists yet. The ingest endpoint
      // lazy-creates `visitor_sessions`, `touchpoints`, `attribution`, etc.
      // on first event; if no events have flowed in yet, the tables may not
      // exist.
      const tablesExist = await pool.query(
        `SELECT
           EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'visitor_sessions') AS vs,
           EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'touchpoints') AS tp,
           EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'attribution') AS attr`,
      );
      const { vs, tp } = tablesExist.rows[0];
      if (!vs || !tp) {
        return res.json({
          leads: [],
          totals: { all: 0, byStatus: {} },
          sources: [],
          tablesReady: false,
          note: "Tracking tables do not exist yet. Install the pixel on fitscript.me and wait for the first visitor.",
        });
      }

      const sinceDate = new Date(Date.now() - days * 86400000).toISOString();

      // Pull one row per visitor with attribution + activity aggregates.
      // LEFT JOIN to users so signed-up visitors get email/name; non-signups
      // come back with NULLs.
      const result = await pool.query(
        `WITH visitor_agg AS (
           SELECT
             vs.visitor_id,
             MAX(vs.user_id) AS user_id,
             MIN(vs.utm_source) FILTER (WHERE vs.utm_source IS NOT NULL) AS first_source,
             MIN(vs.utm_medium) FILTER (WHERE vs.utm_medium IS NOT NULL) AS first_medium,
             MIN(vs.utm_campaign) FILTER (WHERE vs.utm_campaign IS NOT NULL) AS first_campaign,
             MIN(vs.created_at) AS first_touch_at,
             MAX(vs.created_at) AS last_touch_at,
             COUNT(*) AS session_count
           FROM visitor_sessions vs
           WHERE vs.created_at >= $1
           GROUP BY vs.visitor_id
         ),
         touch_agg AS (
           SELECT
             tp.visitor_id,
             COUNT(*) AS touchpoint_count,
             COALESCE(SUM(tp.revenue), 0) AS revenue_total,
             BOOL_OR(tp.event_type = 'quiz_started' OR tp.event_type = 'quiz_completed') AS has_quiz,
             BOOL_OR(tp.event_type = 'lab_uploaded' OR tp.event_type = 'lab_order_paid') AS has_lab,
             BOOL_OR(tp.event_type = 'signup' OR tp.event_type = 'subscription_started') AS has_signup
           FROM touchpoints tp
           WHERE tp.created_at >= $1
           GROUP BY tp.visitor_id
         )
         SELECT
           va.visitor_id,
           va.user_id,
           u.email,
           u.first_name,
           va.first_source,
           va.first_medium,
           va.first_campaign,
           va.first_touch_at,
           va.last_touch_at,
           va.session_count,
           COALESCE(ta.touchpoint_count, 0) AS touchpoint_count,
           COALESCE(ta.revenue_total, 0) AS revenue_total,
           COALESCE(ta.has_quiz, FALSE) AS has_quiz,
           COALESCE(ta.has_lab, FALSE) AS has_lab,
           COALESCE(ta.has_signup, FALSE) AS has_signup,
           a.total_revenue AS attr_revenue
         FROM visitor_agg va
         LEFT JOIN touch_agg ta ON ta.visitor_id = va.visitor_id
         LEFT JOIN users u ON u.id = va.user_id
         LEFT JOIN attribution a ON a.user_id = va.user_id
         ORDER BY va.last_touch_at DESC
         LIMIT $2`,
        [sinceDate, limit],
      );

      const all: LeadRow[] = result.rows.map((r: any) => {
        const revenue = parseFloat(r.attr_revenue || r.revenue_total || 0);
        const signedUp = !!r.user_id || !!r.has_signup;
        const sessions = parseInt(r.session_count || 0);
        const dsl = daysSince(r.last_touch_at);
        const status = classifyStatus({
          revenue,
          signedUp,
          sessions,
          daysSinceLastTouch: dsl,
          hasLabUpload: !!r.has_lab,
          hasQuiz: !!r.has_quiz,
        });
        return {
          visitorId: r.visitor_id,
          userId: r.user_id,
          email: r.email,
          firstName: r.first_name,
          status,
          source: r.first_source || "direct",
          medium: r.first_medium,
          campaign: r.first_campaign,
          firstTouchAt: r.first_touch_at,
          lastTouchAt: r.last_touch_at,
          daysSinceFirstTouch: daysSince(r.first_touch_at),
          daysSinceLastTouch: dsl,
          sessions,
          touchpoints: parseInt(r.touchpoint_count || 0),
          revenue,
          signedUp,
        };
      });

      // Apply filters AFTER classification so the totals reflect the raw
      // dataset; we still report totals.byStatus across the full window.
      const filtered = all.filter((l) => {
        if (statusFilter && l.status !== statusFilter) return false;
        if (sourceFilter && l.source !== sourceFilter) return false;
        return true;
      });

      const byStatus: Record<string, number> = { Cold: 0, Engaged: 0, Hot: 0, Paid: 0 };
      for (const l of all) byStatus[l.status] = (byStatus[l.status] || 0) + 1;

      const sourceCounts: Record<string, number> = {};
      for (const l of all) {
        const s = l.source || "direct";
        sourceCounts[s] = (sourceCounts[s] || 0) + 1;
      }
      const sources = Object.entries(sourceCounts)
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        leads: filtered,
        totals: { all: all.length, byStatus },
        sources,
        tablesReady: true,
      });
    } catch (error: any) {
      console.error("[OPS] Leads error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Funnel breakdown — visitor → quiz → signup → paid with conversion %
  // tied to the same time window as the leads list. Different from
  // /api/ops/funnel (in tracking.ts) which is all-time.
  app.get("/api/ops/leads/funnel", async (req, res) => {
    try {
      const days = Math.min(
        Math.max(parseInt((req.query.days as string) || "90"), 1),
        365,
      );
      const sinceDate = new Date(Date.now() - days * 86400000).toISOString();

      // Same table-existence guard as above.
      const tablesExist = await pool.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'visitor_sessions') AS exists`,
      );
      if (!tablesExist.rows[0].exists) {
        return res.json({
          stages: [],
          tablesReady: false,
        });
      }

      const r = await pool.query(
        `SELECT
           (SELECT COUNT(DISTINCT visitor_id) FROM visitor_sessions WHERE created_at >= $1) AS visitors,
           (SELECT COUNT(DISTINCT visitor_id) FROM touchpoints WHERE event_type IN ('quiz_started','quiz_completed') AND created_at >= $1) AS quiz_started,
           (SELECT COUNT(DISTINCT user_id) FROM touchpoints WHERE event_type IN ('signup','subscription_started') AND created_at >= $1 AND user_id IS NOT NULL) AS signups,
           (SELECT COUNT(*) FROM attribution WHERE total_revenue > 0 AND first_payment_at >= $1) AS paid`,
        [sinceDate],
      );

      const row = r.rows[0];
      const visitors = parseInt(row.visitors || 0);
      const quiz = parseInt(row.quiz_started || 0);
      const signups = parseInt(row.signups || 0);
      const paid = parseInt(row.paid || 0);

      const stages = [
        { key: "visitors", label: "Visitors", count: visitors, pctOfTop: 100 },
        {
          key: "quiz_started",
          label: "Quiz Started",
          count: quiz,
          pctOfTop: visitors > 0 ? (quiz / visitors) * 100 : 0,
          pctOfPrev: visitors > 0 ? (quiz / visitors) * 100 : 0,
        },
        {
          key: "signups",
          label: "Signups",
          count: signups,
          pctOfTop: visitors > 0 ? (signups / visitors) * 100 : 0,
          pctOfPrev: quiz > 0 ? (signups / quiz) * 100 : 0,
        },
        {
          key: "paid",
          label: "Paid",
          count: paid,
          pctOfTop: visitors > 0 ? (paid / visitors) * 100 : 0,
          pctOfPrev: signups > 0 ? (paid / signups) * 100 : 0,
        },
      ];

      res.json({ stages, tablesReady: true, windowDays: days });
    } catch (error: any) {
      console.error("[OPS] Leads funnel error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });
}
