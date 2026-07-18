/**
 * PeptideU dashboard API — READ-ONLY against the PeptideU Supabase Postgres.
 * Every handler uses raw parameterized SQL on `peptidePool` (matching the FitScript
 * side's convention). If the pool is unset, endpoints return 503 so the UI can show
 * a graceful "not connected" state.
 */
import type { Express, Request, Response } from "express";
import { peptidePool } from "./db";

// Yearly plan ($99.99, the promoted one) monthly-equivalent, for MRR estimate.
const YEARLY_PRICE = 99.99;
const MONTHLY_EQUIV = YEARLY_PRICE / 12;

const RANK_ORDER = ["freshman", "sophomore", "junior", "senior", "graduate"];

function ensurePool(res: Response): boolean {
  if (!peptidePool) {
    res.status(503).json({ error: "PeptideU database not connected (PEPTIDEU_DATABASE_URL unset)" });
    return false;
  }
  return true;
}

export function registerPeptideURoutes(app: Express) {
  // Headline metrics
  app.get("/api/ops/peptideu/snapshot", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`
        SELECT
          (SELECT count(*) FROM profiles) AS total_users,
          (SELECT count(*) FROM profiles WHERE created_at >= now() - interval '7 days') AS signups_7d,
          (SELECT count(*) FROM profiles WHERE created_at >= now() - interval '30 days') AS signups_30d,
          (SELECT count(*) FROM profiles WHERE entitlement = 'premium') AS premium_users,
          (SELECT count(*) FROM profiles WHERE entitlement = 'free' OR entitlement IS NULL) AS free_users,
          (SELECT count(*) FROM profiles WHERE onboarding_complete) AS onboarded,
          (SELECT count(*) FROM profiles WHERE rank = 'graduate') AS graduates,
          (SELECT count(DISTINCT user_id) FROM lesson_progress WHERE completed_at >= now() - interval '7 days') AS active_7d
      `);
      const r = rows[0];
      const premium = Number(r.premium_users);
      const total = Number(r.total_users);
      res.json({
        totalUsers: total,
        signups7d: Number(r.signups_7d),
        signups30d: Number(r.signups_30d),
        premiumUsers: premium,
        freeUsers: Number(r.free_users),
        onboarded: Number(r.onboarded),
        graduates: Number(r.graduates),
        activeUsers7d: Number(r.active_7d),
        conversionRate: total ? premium / total : 0,
        mrrEstimate: Math.round(premium * MONTHLY_EQUIV * 100) / 100,
        arrEstimate: Math.round(premium * YEARLY_PRICE * 100) / 100,
      });
    } catch (error: any) {
      console.error("[PEPTIDEU] snapshot", error);
      res.status(500).json({ error: "Failed to load PeptideU snapshot" });
    }
  });

  // Daily signups, last 30 days (chart)
  app.get("/api/ops/peptideu/signups", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS date, coalesce(c.n, 0)::int AS count
        FROM generate_series(now()::date - interval '29 days', now()::date, interval '1 day') d
        LEFT JOIN (
          SELECT created_at::date AS dt, count(*) AS n
          FROM profiles
          WHERE created_at >= now()::date - interval '29 days'
          GROUP BY 1
        ) c ON c.dt = d::date
        ORDER BY d
      `);
      res.json(rows.map((x) => ({ date: x.date, count: Number(x.count) })));
    } catch (error: any) {
      console.error("[PEPTIDEU] signups", error);
      res.status(500).json({ error: "Failed to load signups" });
    }
  });

  // Rank distribution (Freshman → Graduate)
  app.get("/api/ops/peptideu/ranks", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(
        `SELECT rank::text AS rank, count(*)::int AS count FROM profiles GROUP BY rank`,
      );
      const byRank: Record<string, number> = {};
      rows.forEach((x) => { byRank[x.rank] = Number(x.count); });
      res.json(RANK_ORDER.map((rank) => ({ rank, count: byRank[rank] || 0 })));
    } catch (error: any) {
      console.error("[PEPTIDEU] ranks", error);
      res.status(500).json({ error: "Failed to load ranks" });
    }
  });

  // Per-module completion + quiz pass rates
  app.get("/api/ops/peptideu/curriculum", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`
        SELECT m.id, m.title, m.order_index,
          (SELECT count(*) FROM lessons l WHERE l.module_id = m.id) AS lessons,
          (SELECT count(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
             WHERE l.module_id = m.id AND lp.status = 'completed') AS lessons_completed,
          (SELECT count(DISTINCT lp.user_id) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
             WHERE l.module_id = m.id) AS learners,
          (SELECT count(*) FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
             WHERE q.module_id = m.id) AS quiz_attempts,
          (SELECT count(*) FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
             WHERE q.module_id = m.id AND qa.passed) AS quiz_passes
        FROM modules m
        ORDER BY m.order_index
      `);
      res.json(rows.map((x) => {
        const attempts = Number(x.quiz_attempts);
        return {
          title: x.title,
          orderIndex: Number(x.order_index),
          lessons: Number(x.lessons),
          lessonsCompleted: Number(x.lessons_completed),
          learners: Number(x.learners),
          quizAttempts: attempts,
          quizPasses: Number(x.quiz_passes),
          quizPassRate: attempts ? Number(x.quiz_passes) / attempts : 0,
        };
      }));
    } catch (error: any) {
      console.error("[PEPTIDEU] curriculum", error);
      res.status(500).json({ error: "Failed to load curriculum" });
    }
  });

  // Feature engagement (Ask / COA / Commons / Office Hours / Log)
  app.get("/api/ops/peptideu/engagement", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`
        SELECT
          (SELECT count(*) FROM ask_messages WHERE role = 'user') AS ask_messages,
          (SELECT count(DISTINCT user_id) FROM ask_messages) AS ask_users,
          (SELECT count(*) FROM coa_scans) AS coa_scans,
          (SELECT count(DISTINCT user_id) FROM coa_scans) AS coa_users,
          (SELECT count(*) FROM community_posts) AS posts,
          (SELECT count(DISTINCT user_id) FROM community_posts) AS post_users,
          (SELECT count(*) FROM comments) AS comments,
          (SELECT count(*) FROM oh_rsvps) AS oh_rsvps,
          (SELECT count(DISTINCT user_id) FROM oh_rsvps) AS oh_users,
          (SELECT count(*) FROM research_logs) AS research_logs,
          (SELECT count(DISTINCT user_id) FROM research_logs) AS research_users
      `);
      const r = rows[0];
      res.json({
        ask: { events: Number(r.ask_messages), users: Number(r.ask_users) },
        coa: { events: Number(r.coa_scans), users: Number(r.coa_users) },
        commons: { events: Number(r.posts) + Number(r.comments), users: Number(r.post_users), posts: Number(r.posts), comments: Number(r.comments) },
        officeHours: { events: Number(r.oh_rsvps), users: Number(r.oh_users) },
        researchLog: { events: Number(r.research_logs), users: Number(r.research_users) },
      });
    } catch (error: any) {
      console.error("[PEPTIDEU] engagement", error);
      res.status(500).json({ error: "Failed to load engagement" });
    }
  });

  // Signup → premium funnel
  app.get("/api/ops/peptideu/funnel", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`
        SELECT
          (SELECT count(*) FROM profiles) AS signed_up,
          (SELECT count(*) FROM profiles WHERE onboarding_complete) AS onboarded,
          (SELECT count(DISTINCT user_id) FROM lesson_progress WHERE status = 'completed') AS activated,
          (SELECT count(*) FROM profiles WHERE entitlement = 'premium') AS premium
      `);
      const r = rows[0];
      const top = Number(r.signed_up) || 1;
      const stage = (label: string, n: number) => ({ label, count: n, pct: n / top });
      res.json([
        stage("Signed up", Number(r.signed_up)),
        stage("Onboarded", Number(r.onboarded)),
        stage("Activated (1+ lesson)", Number(r.activated)),
        stage("Premium", Number(r.premium)),
      ]);
    } catch (error: any) {
      console.error("[PEPTIDEU] funnel", error);
      res.status(500).json({ error: "Failed to load funnel" });
    }
  });

  // ── Member management ──────────────────────────────────────────────────────
  // GETs are visible to viewers; every mutation below is admin-only for free —
  // opsGate blocks non-GET for the viewer role (403 read_only). Writes go direct
  // (peptidePool connects as postgres, bypassing RLS) since the dashboard is the
  // authority here, gated by its own Google-OAuth admin.
  const PU_ROLES = ["member", "coach", "moderator", "admin", "owner"];

  app.get("/api/ops/peptideu/members", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const q = String(req.query.q ?? "").trim().toLowerCase();
    try {
      const { rows } = q
        ? await peptidePool!.query(
            `SELECT id, email, display_name, role, entitlement, points, created_at
             FROM profiles WHERE lower(email) LIKE $1 OR lower(display_name) LIKE $1
             ORDER BY created_at DESC LIMIT 50`, [`%${q}%`])
        : await peptidePool!.query(
            `SELECT id, email, display_name, role, entitlement, points, created_at
             FROM profiles ORDER BY created_at DESC LIMIT 50`);
      res.json(rows);
    } catch (error: any) {
      console.error("[PEPTIDEU] members", error);
      res.status(500).json({ error: "Failed to load members" });
    }
  });

  app.post("/api/ops/peptideu/members/:id/entitlement", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const { id } = req.params;
    const entitlement = String(req.body?.entitlement ?? "");
    if (!["free", "premium"].includes(entitlement)) return res.status(400).json({ error: "bad_entitlement" });
    try {
      const upd = await peptidePool!.query(`UPDATE profiles SET entitlement = $1 WHERE id = $2`, [entitlement, id]);
      if (upd.rowCount === 0) return res.status(404).json({ error: "not_found" });
      if (entitlement === "premium") {
        await peptidePool!.query(
          `INSERT INTO membership_grants (user_id, kind, source)
           SELECT $1, 'lifetime', 'ops_comp'
           WHERE NOT EXISTS (SELECT 1 FROM membership_grants WHERE user_id = $1 AND source LIKE '%comp')`, [id]);
      }
      res.json({ ok: true, entitlement });
    } catch (error: any) {
      console.error("[PEPTIDEU] set entitlement", error);
      res.status(500).json({ error: "Failed to update entitlement" });
    }
  });

  app.post("/api/ops/peptideu/members/:id/role", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const { id } = req.params;
    const role = String(req.body?.role ?? "");
    if (!PU_ROLES.includes(role)) return res.status(400).json({ error: "bad_role" });
    try {
      const upd = await peptidePool!.query(`UPDATE profiles SET role = $1 WHERE id = $2`, [role, id]);
      if (upd.rowCount === 0) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true, role });
    } catch (error: any) {
      console.error("[PEPTIDEU] set role", error);
      res.status(500).json({ error: "Failed to update role" });
    }
  });
}
