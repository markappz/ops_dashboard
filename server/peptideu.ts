/**
 * PeptideU dashboard API — READ-ONLY against the PeptideU Supabase Postgres.
 * Every handler uses raw parameterized SQL on `peptidePool` (matching the FitScript
 * side's convention). If the pool is unset, endpoints return 503 so the UI can show
 * a graceful "not connected" state.
 */
import type { Express, Request, Response } from "express";
import { peptidePool } from "./db";
import { anthropic, BEDROCK_MODELS } from "./lib/bedrock";

// Library-entry generation prompt. KEEP IN SYNC with the PeptideU edge function
// `admin-generate-peptide` (supabase/functions/) — same compliance wall, so a
// draft made from the portal reads identically to one made from the app.
const GEN_SYSTEM = `You write a single factual, evidence-first encyclopedia entry for PeptideU — a peptide EDUCATION and research-tracking library. It teaches what the published research describes; it never advises.

HARD RULES — a violation makes the entry unusable:
- NEVER include a dose, dosing schedule, cycle, titration, administration route, reconstitution amount, or "how to use/take/inject" — not even ranges, not even "commonly." If research is expressed in doses, describe the finding qualitatively without the numbers.
- NEVER recommend/encourage acquiring or using it. No vendors, no "where to buy," no product/brand names.
- No therapeutic promises or cure claims. Describe what studies observed, with honest uncertainty.
- Grade evidence HONESTLY — most peptides are early/preclinical/theoretical; say so.

VOICE: calm, precise, third-person reference tone; technical but readable; define terms inline. Attribute findings to the research ("studies describe", "the literature frames"); name genuine debates explicitly; no hype adjectives.

Output STRICT JSON ONLY (no markdown): {"name":string,"aka":string[],"category":string,"class_label":string,"aa_count":number|null,"half_life":string|null,"regulatory_note":string,"summary":string,"mechanism":{"intro":string,"points":[{"label":string,"text":string}],"together":string},"reported":[{"value":string,"label":string}],"the_catch":string,"evidence_tier":"established"|"promising"|"early"|"preclinical"|"theoretical"|"disputed"}`;

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// Curriculum-gap analysis prompt. Clusters real member questions into themes,
// checks them against the existing modules, and proposes new modules / office
// hours. INTERNAL ops planning only — the output is topic labels for Paul, never
// member-facing content, so the same compliance wall still applies: no doses, no
// protocols, no "what to take" in any rationale.
const INSIGHTS_SYSTEM = `You analyse what PeptideU members are asking (the Professor AI + the Commons) to help plan curriculum. You cluster questions into themes, check each theme against the existing modules, and surface gaps.

RULES:
- This is internal planning. Output TOPIC LABELS and rationale only. NEVER put a dose, dosing schedule, protocol, or "what to take/how much" in any field — describe the SUBJECT people are asking about, not an answer to it.
- "covered" is true only when an existing module clearly teaches that theme; if a theme is adjacent but not really taught, mark it uncovered.
- Rank demand honestly from how often the theme appears in the sample. Do not invent themes that are not in the questions.
- Keep titles short and concrete. Rationale = one sentence on why it is worth building, referencing the demand.

Output STRICT JSON ONLY (no markdown): {"themes":[{"topic":string,"demand":"high"|"medium"|"low","covered":boolean,"coveredBy":string|null,"example":string}],"moduleSuggestions":[{"title":string,"rationale":string}],"officeHoursSuggestions":[{"topic":string,"rationale":string}]}`;

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

  // ── Moderation queue ───────────────────────────────────────────────────────
  // No reports table + reviews/posts are AI-moderated on submit, so this is
  // post-hoc: browse what's LIVE and pull anything the AI let through. Remove =
  // delete a post (cascades) or reject a review (drops it from the members' view).
  app.get("/api/ops/peptideu/moderation", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const [posts, pr, br] = await Promise.all([
        peptidePool!.query(`
          SELECT cp.id, cp.body, cp.created_at, p.display_name, ch.name AS channel
          FROM community_posts cp JOIN profiles p ON p.id = cp.user_id
          LEFT JOIN channels ch ON ch.id = cp.channel_id
          ORDER BY cp.created_at DESC LIMIT 40`),
        peptidePool!.query(`
          SELECT r.id, r.note, r.rating, r.created_at, p.display_name, pep.name AS subject
          FROM peptide_reviews r JOIN profiles p ON p.id = r.user_id
          JOIN peptides pep ON pep.id = r.peptide_id
          WHERE r.status = 'approved' AND r.note IS NOT NULL
          ORDER BY r.created_at DESC LIMIT 40`),
        peptidePool!.query(`
          SELECT r.id, r.note, r.rating, r.created_at, p.display_name, b.name AS subject
          FROM brand_reviews r JOIN profiles p ON p.id = r.user_id
          JOIN brands b ON b.id = r.brand_id
          WHERE r.status = 'approved' AND r.note IS NOT NULL
          ORDER BY r.created_at DESC LIMIT 40`),
      ]);
      res.json({ posts: posts.rows, peptideReviews: pr.rows, brandReviews: br.rows });
    } catch (error: any) {
      console.error("[PEPTIDEU] moderation", error);
      res.status(500).json({ error: "Failed to load moderation queue" });
    }
  });

  app.post("/api/ops/peptideu/moderation/remove", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const { type, id } = req.body ?? {};
    try {
      if (type === "post") await peptidePool!.query(`DELETE FROM community_posts WHERE id = $1`, [id]);
      else if (type === "peptide_review") await peptidePool!.query(`UPDATE peptide_reviews SET status = 'rejected' WHERE id = $1`, [id]);
      else if (type === "brand_review") await peptidePool!.query(`UPDATE brand_reviews SET status = 'rejected' WHERE id = $1`, [id]);
      else return res.status(400).json({ error: "bad_type" });
      res.json({ ok: true });
    } catch (error: any) {
      console.error("[PEPTIDEU] remove", error);
      res.status(500).json({ error: "Failed to remove" });
    }
  });

  // ── Request approval ───────────────────────────────────────────────────────
  app.get("/api/ops/peptideu/requests", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const [pep, brand] = await Promise.all([
        peptidePool!.query(`SELECT id, name, category, why, created_at FROM peptide_requests WHERE status = 'pending' ORDER BY created_at`),
        peptidePool!.query(`SELECT id, name, note, created_at FROM brand_requests WHERE status = 'pending' ORDER BY created_at`),
      ]);
      res.json({ peptides: pep.rows, brands: brand.rows });
    } catch (error: any) {
      console.error("[PEPTIDEU] requests", error);
      res.status(500).json({ error: "Failed to load requests" });
    }
  });

  // Deny either kind, or approve a brand (marks it; brand entries stay manual).
  app.post("/api/ops/peptideu/requests/:kind/:id/:decision", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const { kind, id, decision } = req.params;
    if (!["peptide", "brand"].includes(kind) || !["approved", "denied"].includes(decision))
      return res.status(400).json({ error: "bad_request" });
    // peptide approvals go through AI generation, not this endpoint
    if (kind === "peptide" && decision === "approved")
      return res.status(400).json({ error: "use_generate" });
    try {
      const table = kind === "peptide" ? "peptide_requests" : "brand_requests";
      await peptidePool!.query(`UPDATE ${table} SET status = $1, reviewed_at = now() WHERE id = $2 AND status = 'pending'`, [decision, id]);
      res.json({ ok: true, decision });
    } catch (error: any) {
      console.error("[PEPTIDEU] decide request", error);
      res.status(500).json({ error: "Failed to update request" });
    }
  });

  // Approve a peptide request → generate an unpublished DRAFT (published=false).
  // Never goes live here; an admin publishes it from the Library review.
  app.post("/api/ops/peptideu/requests/peptide/:id/generate", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const { id } = req.params;
    try {
      const { rows } = await peptidePool!.query(`SELECT id, name, category, status FROM peptide_requests WHERE id = $1`, [id]);
      const reqRow = rows[0];
      if (!reqRow) return res.status(404).json({ error: "not_found" });

      const ai: any = await (anthropic as any).messages.create({
        model: BEDROCK_MODELS.HIGH_IQ,
        max_tokens: 2500,
        system: GEN_SYSTEM,
        messages: [{ role: "user", content: `Write the Library entry for: "${reqRow.name}"${reqRow.category ? ` (member filed it under: ${reqRow.category})` : ""}. Return the JSON only.` }],
      });
      const text = (ai.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      let entry: any;
      try { entry = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, "")); }
      catch { return res.status(502).json({ error: "model returned non-JSON" }); }

      let slug = slugify(entry.name || reqRow.name);
      const clash = await peptidePool!.query(`SELECT 1 FROM peptides WHERE slug = $1`, [slug]);
      if (clash.rowCount) slug = `${slug}-${String(id).slice(0, 6)}`;

      const ins = await peptidePool!.query(
        `INSERT INTO peptides (slug, name, aka, category, class_label, aa_count, half_life, regulatory, regulatory_note, summary, mechanism, reported, the_catch, evidence_tier, published)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'other',$8,$9,$10,$11,$12,$13,false) RETURNING id, slug, name`,
        [slug, entry.name ?? reqRow.name, Array.isArray(entry.aka) ? entry.aka : [], entry.category ?? reqRow.category ?? null,
         entry.class_label ?? null, typeof entry.aa_count === "number" ? entry.aa_count : null, entry.half_life ?? null,
         entry.regulatory_note ?? null, entry.summary ?? null, entry.mechanism ?? null, entry.reported ?? null,
         entry.the_catch ?? null, entry.evidence_tier ?? "theoretical"]);
      const draft = ins.rows[0];

      await peptidePool!.query(`UPDATE peptide_requests SET status = 'approved', reviewed_at = now(), peptide_id = $1 WHERE id = $2`, [draft.id, id]);
      res.json({ ok: true, draft, published: false });
    } catch (error: any) {
      console.error("[PEPTIDEU] generate", error);
      res.status(500).json({ error: "Generation failed" });
    }
  });

  // ── Grant Drawing ──────────────────────────────────────────────────────────
  // Leaderboard + totals + past winners. Read; safe for viewers.
  app.get("/api/ops/peptideu/drawing", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      await peptidePool!.query(`SELECT reconcile_entries()`); // pull in latest module-pass entries
      const [lb, win, tot, draws, flag] = await Promise.all([
        peptidePool!.query(`SELECT * FROM entry_leaderboard(NULL, 25)`),
        peptidePool!.query(`SELECT * FROM recent_winners(10)`),
        peptidePool!.query(`SELECT count(DISTINCT user_id)::int AS players, coalesce(sum(entries),0)::int AS entries, current_season() AS season FROM sweepstakes_entries WHERE season = current_season()`),
        peptidePool!.query(`SELECT id, prize, num_winners, scheduled_at, seed_hash, status, drawn_at FROM drawings ORDER BY scheduled_at DESC LIMIT 12`),
        peptidePool!.query(`SELECT coalesce((SELECT enabled FROM app_flags WHERE key='drawings_live'), false) AS live`),
      ]);
      res.json({ leaderboard: lb.rows, winners: win.rows, totals: tot.rows[0], drawings: draws.rows, live: flag.rows[0].live });
    } catch (error: any) {
      console.error("[PEPTIDEU] drawing", error);
      res.status(500).json({ error: "Failed to load drawing" });
    }
  });

  // Schedule a provably-fair drawing (mints + commits a seed hash). Admin-only.
  app.post("/api/ops/peptideu/drawings/schedule", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const prize = String(req.body?.prize ?? "Grant").slice(0, 80);
    const winners = Math.min(10, Math.max(1, Math.floor(Number(req.body?.winners ?? 3))));
    const at = req.body?.scheduled_at ? new Date(req.body.scheduled_at) : null;
    if (!at || isNaN(at.getTime())) return res.status(400).json({ error: "bad_date" });
    try {
      const { rows } = await peptidePool!.query(`SELECT schedule_drawing($1,$2,$3) AS r`, [prize, winners, at.toISOString()]);
      res.json(rows[0].r);
    } catch (error: any) {
      console.error("[PEPTIDEU] schedule drawing", error);
      res.status(500).json({ error: "Schedule failed" });
    }
  });

  // Execute a scheduled drawing (provably-fair; refuses unless the legal flag is on
  // and the scheduled time has passed). Admin-only.
  app.post("/api/ops/peptideu/drawings/:id/execute", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`SELECT execute_drawing($1) AS r`, [req.params.id]);
      res.json(rows[0].r);
    } catch (error: any) {
      console.error("[PEPTIDEU] execute drawing", error);
      res.status(500).json({ error: "Execute failed" });
    }
  });

  // The LEGAL kill-switch. Flip only after attorney sign-off + state registration.
  app.post("/api/ops/peptideu/drawings/flag", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const enabled = !!req.body?.enabled;
    try {
      await peptidePool!.query(`UPDATE app_flags SET enabled=$1, updated_at=now() WHERE key='drawings_live'`, [enabled]);
      res.json({ ok: true, live: enabled });
    } catch (error: any) {
      console.error("[PEPTIDEU] flag", error);
      res.status(500).json({ error: "Flag update failed" });
    }
  });

  // ── Coach queue: most-asked questions ───────────────────────────────────────
  // Live list of what members actually ask the Professor, grouped by normalized
  // text so repeats bubble up (with a distinct-user count). Read; safe for
  // viewers. The answer shown is what the Professor gave the most recent asker —
  // Q&A share an insert timestamp, so we match the assistant row on created_at.
  app.get("/api/ops/peptideu/questions", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const { rows } = await peptidePool!.query(`
        SELECT t.n, t.users, t.example, t.last_at,
          (SELECT a.content FROM ask_messages a
             WHERE a.role = 'assistant' AND a.created_at = t.last_at LIMIT 1) AS answer
        FROM (
          SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS users,
                 (array_agg(content ORDER BY created_at DESC))[1] AS example,
                 max(created_at) AS last_at
          FROM ask_messages
          WHERE role = 'user' AND length(btrim(content)) > 2
          GROUP BY lower(btrim(content))
          ORDER BY count(*) DESC, max(created_at) DESC
          LIMIT 20
        ) t
      `);
      res.json(rows.map((r) => ({
        question: r.example,
        asks: Number(r.n),
        users: Number(r.users),
        lastAt: r.last_at,
        answer: r.answer ?? null,
      })));
    } catch (error: any) {
      console.error("[PEPTIDEU] questions", error);
      res.status(500).json({ error: "Failed to load questions" });
    }
  });

  // ── Curriculum-gap analysis (AI) ─────────────────────────────────────────────
  // POST (admin-only via opsGate — it spends an AI call, so viewers can't trigger
  // it). Feeds recent Professor + Commons questions and the module list to the
  // model, which clusters themes, flags gaps, and proposes modules / office hours.
  app.post("/api/ops/peptideu/question-insights", async (_req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    try {
      const [ask, posts, mods] = await Promise.all([
        peptidePool!.query(`SELECT content FROM ask_messages WHERE role = 'user' AND length(btrim(content)) > 2 ORDER BY created_at DESC LIMIT 300`),
        peptidePool!.query(`SELECT body FROM community_posts WHERE byline IS NULL AND length(btrim(body)) > 2 ORDER BY created_at DESC LIMIT 150`),
        peptidePool!.query(`SELECT order_index, title FROM modules ORDER BY order_index`),
      ]);
      const questions = [
        ...ask.rows.map((r) => String(r.content)),
        ...posts.rows.map((r) => String(r.body)),
      ];
      if (questions.length === 0) return res.json({ themes: [], moduleSuggestions: [], officeHoursSuggestions: [], sampleSize: 0 });
      const moduleList = mods.rows.map((m) => `${Number(m.order_index) + 1}. ${m.title}`).join("\n");
      const sample = questions.map((x) => `- ${x.slice(0, 240)}`).join("\n");

      const ai: any = await (anthropic as any).messages.create({
        model: BEDROCK_MODELS.HIGH_IQ,
        max_tokens: 2200,
        system: INSIGHTS_SYSTEM,
        messages: [{ role: "user", content: `Existing modules:\n${moduleList}\n\nRecent member questions (${questions.length}, Professor + Commons):\n${sample}\n\nReturn the JSON only.` }],
      });
      const text = (ai.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      let out: any;
      try { out = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, "")); }
      catch { return res.status(502).json({ error: "model returned non-JSON" }); }

      res.json({
        themes: Array.isArray(out.themes) ? out.themes : [],
        moduleSuggestions: Array.isArray(out.moduleSuggestions) ? out.moduleSuggestions : [],
        officeHoursSuggestions: Array.isArray(out.officeHoursSuggestions) ? out.officeHoursSuggestions : [],
        sampleSize: questions.length,
      });
    } catch (error: any) {
      console.error("[PEPTIDEU] question-insights", error);
      res.status(500).json({ error: "Analysis failed" });
    }
  });

  // Run the weighted-random draw (admin-only via opsGate on non-GET).
  app.post("/api/ops/peptideu/drawing/run", async (req: Request, res: Response) => {
    if (!ensurePool(res)) return;
    const prize = String(req.body?.prize ?? "Grant").slice(0, 80);
    const season = req.body?.season ? String(req.body.season) : null;
    // 3 winners/month (Paul); clamp to a sane range. run_drawing picks distinct
    // weighted-random winners.
    const winners = Math.min(10, Math.max(1, Math.floor(Number(req.body?.winners ?? 3))));
    try {
      const { rows } = await peptidePool!.query(`SELECT run_drawing($1, $2, $3) AS result`, [season, prize, winners]);
      res.json(rows[0].result);
    } catch (error: any) {
      console.error("[PEPTIDEU] run drawing", error);
      res.status(500).json({ error: "Draw failed" });
    }
  });
}
