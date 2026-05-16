/**
 * Unit Economics: AI cost vs revenue per user and platform-wide.
 *
 * Data sources today (Phase 1):
 *   - atlas_turn_analytics — per-turn dollarized cost (Atlas chat only)
 *   - attribution.total_revenue / ltv_lifetime — per-user lifetime revenue
 *
 * Other AI surfaces (protocol, lab analysis, meal vision, embeddings) are
 * not yet dollarized. When `ai_costs` ships from Phase 2, swap atlas_only
 * queries for a UNION over (atlas_turn_analytics, ai_costs).
 */
import type { Express } from "express";
import { pool } from "./db";

type DailyPoint = { date: string; cost_usd: number; revenue_usd: number };

async function aiCostsTableExists(): Promise<boolean> {
  const r = await pool.query(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ai_costs')",
  );
  return r.rows[0].exists;
}

function costExprAtlas() {
  return "COALESCE(total_cost_usd, 0)";
}

async function getPlatformEconomics(days: number) {
  const sinceMtd = new Date();
  sinceMtd.setDate(1);
  sinceMtd.setHours(0, 0, 0, 0);

  const sinceDays = new Date();
  sinceDays.setDate(sinceDays.getDate() - days);
  sinceDays.setHours(0, 0, 0, 0);

  const useUnified = await aiCostsTableExists();

  // Cost (MTD + last N days totals + daily series)
  const costSql = useUnified
    ? `
      WITH src AS (
        SELECT user_id, cost_usd::numeric AS cost, created_at FROM ai_costs
        UNION ALL
        SELECT user_id, ${costExprAtlas()} AS cost, created_at FROM atlas_turn_analytics
      )
      SELECT
        (SELECT COALESCE(SUM(cost), 0) FROM src WHERE created_at >= $1) AS cost_mtd,
        (SELECT COALESCE(SUM(cost), 0) FROM src WHERE created_at >= $2) AS cost_window,
        (SELECT COALESCE(SUM(cost), 0) FROM src) AS cost_ltd,
        (SELECT COUNT(DISTINCT user_id) FROM src WHERE created_at >= $1 AND user_id IS NOT NULL) AS users_mtd
    `
    : `
      SELECT
        (SELECT COALESCE(SUM(${costExprAtlas()}), 0) FROM atlas_turn_analytics WHERE created_at >= $1) AS cost_mtd,
        (SELECT COALESCE(SUM(${costExprAtlas()}), 0) FROM atlas_turn_analytics WHERE created_at >= $2) AS cost_window,
        (SELECT COALESCE(SUM(${costExprAtlas()}), 0) FROM atlas_turn_analytics) AS cost_ltd,
        (SELECT COUNT(DISTINCT user_id) FROM atlas_turn_analytics WHERE created_at >= $1 AND user_id IS NOT NULL) AS users_mtd
    `;
  const costTotals = await pool.query(costSql, [sinceMtd, sinceDays]);

  // Daily cost series (last N days)
  const dailyCostSql = useUnified
    ? `
      WITH src AS (
        SELECT cost_usd::numeric AS cost, created_at FROM ai_costs
        UNION ALL
        SELECT ${costExprAtlas()} AS cost, created_at FROM atlas_turn_analytics
      )
      SELECT date_trunc('day', created_at)::date AS d, SUM(cost)::numeric(12,4) AS cost
      FROM src WHERE created_at >= $1
      GROUP BY 1 ORDER BY 1
    `
    : `
      SELECT date_trunc('day', created_at)::date AS d, SUM(${costExprAtlas()})::numeric(12,4) AS cost
      FROM atlas_turn_analytics WHERE created_at >= $1
      GROUP BY 1 ORDER BY 1
    `;
  const dailyCost = await pool.query(dailyCostSql, [sinceDays]);

  // Revenue MTD via attribution.total_revenue; daily series via attribution.last_payment_at
  // (best-effort — attribution updates lag Stripe slightly, but is consistent within ops dashboard)
  const revMtd = await pool.query(
    `SELECT COALESCE(SUM(total_revenue), 0)::numeric(12,2) AS rev FROM attribution WHERE last_payment_at >= $1`,
    [sinceMtd],
  );
  const revWindow = await pool.query(
    `SELECT COALESCE(SUM(total_revenue), 0)::numeric(12,2) AS rev FROM attribution WHERE last_payment_at >= $1`,
    [sinceDays],
  );
  const revLtd = await pool.query(
    `SELECT COALESCE(SUM(total_revenue), 0)::numeric(12,2) AS rev FROM attribution`,
  );
  const dailyRev = await pool.query(
    `SELECT date_trunc('day', last_payment_at)::date AS d, SUM(total_revenue)::numeric(12,2) AS rev
     FROM attribution WHERE last_payment_at >= $1
     GROUP BY 1 ORDER BY 1`,
    [sinceDays],
  );

  // Merge daily cost + rev into one series
  const seriesMap = new Map<string, DailyPoint>();
  for (let i = 0; i < days; i++) {
    const d = new Date(sinceDays);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    seriesMap.set(key, { date: key, cost_usd: 0, revenue_usd: 0 });
  }
  for (const row of dailyCost.rows) {
    const key = row.d.toISOString().slice(0, 10);
    const pt = seriesMap.get(key);
    if (pt) pt.cost_usd = parseFloat(row.cost);
  }
  for (const row of dailyRev.rows) {
    const key = row.d.toISOString().slice(0, 10);
    const pt = seriesMap.get(key);
    if (pt) pt.revenue_usd = parseFloat(row.rev);
  }
  const series = Array.from(seriesMap.values());

  // Top 5 most-expensive users MTD
  const topUsersSql = useUnified
    ? `
      WITH src AS (
        SELECT user_id, cost_usd::numeric AS cost FROM ai_costs WHERE created_at >= $1
        UNION ALL
        SELECT user_id, ${costExprAtlas()} AS cost FROM atlas_turn_analytics WHERE created_at >= $1
      )
      SELECT s.user_id, u.email,
             SUM(s.cost)::numeric(10,4) AS cost_usd,
             COUNT(*) AS calls,
             COALESCE(a.total_revenue, 0)::numeric(10,2) AS revenue_usd
      FROM src s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN attribution a ON a.user_id = s.user_id
      WHERE s.user_id IS NOT NULL
      GROUP BY s.user_id, u.email, a.total_revenue
      ORDER BY cost_usd DESC
      LIMIT 5
    `
    : `
      SELECT t.user_id, u.email,
             SUM(${costExprAtlas()})::numeric(10,4) AS cost_usd,
             COUNT(*) AS calls,
             COALESCE(a.total_revenue, 0)::numeric(10,2) AS revenue_usd
      FROM atlas_turn_analytics t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN attribution a ON a.user_id = t.user_id
      WHERE t.user_id IS NOT NULL AND t.created_at >= $1
      GROUP BY t.user_id, u.email, a.total_revenue
      ORDER BY cost_usd DESC
      LIMIT 5
    `;
  const topUsers = await pool.query(topUsersSql, [sinceMtd]);

  const costMtd = parseFloat(costTotals.rows[0].cost_mtd);
  const revenueMtd = parseFloat(revMtd.rows[0].rev);
  const grossMargin = revenueMtd > 0 ? ((revenueMtd - costMtd) / revenueMtd) * 100 : null;

  return {
    coverage: useUnified ? "all_surfaces" : "atlas_only",
    cost_mtd: costMtd,
    cost_window: parseFloat(costTotals.rows[0].cost_window),
    cost_ltd: parseFloat(costTotals.rows[0].cost_ltd),
    revenue_mtd: revenueMtd,
    revenue_window: parseFloat(revWindow.rows[0].rev),
    revenue_ltd: parseFloat(revLtd.rows[0].rev),
    gross_margin_pct: grossMargin,
    users_mtd: parseInt(costTotals.rows[0].users_mtd),
    series,
    top_users: topUsers.rows.map((r: any) => ({
      user_id: r.user_id,
      email: r.email,
      cost_usd: parseFloat(r.cost_usd),
      calls: parseInt(r.calls),
      revenue_usd: parseFloat(r.revenue_usd),
    })),
  };
}

async function getMemberEconomics(userId: string) {
  const useUnified = await aiCostsTableExists();
  const sinceMtd = new Date();
  sinceMtd.setDate(1);
  sinceMtd.setHours(0, 0, 0, 0);
  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  since30.setHours(0, 0, 0, 0);

  // Atlas-specific (always available)
  const atlas = await pool.query(
    `SELECT
       COALESCE(SUM(${costExprAtlas()}), 0)::numeric(10,4) AS cost_ltd,
       COALESCE(SUM(${costExprAtlas()}) FILTER (WHERE created_at >= $2), 0)::numeric(10,4) AS cost_mtd,
       COUNT(*) AS turns,
       COUNT(*) FILTER (WHERE created_at >= $2) AS turns_mtd,
       AVG(${costExprAtlas()})::numeric(10,6) AS avg_cost_per_turn,
       AVG(total_latency_ms)::int AS avg_latency_ms
     FROM atlas_turn_analytics WHERE user_id = $1`,
    [userId, sinceMtd],
  );

  // Per-surface breakdown if unified table exists
  let surfaces: { surface: string; cost_usd: number; calls: number }[] = [
    {
      surface: "atlas",
      cost_usd: parseFloat(atlas.rows[0].cost_ltd),
      calls: parseInt(atlas.rows[0].turns),
    },
  ];
  if (useUnified) {
    const r = await pool.query(
      `SELECT surface, SUM(cost_usd)::numeric(10,4) AS cost_usd, COUNT(*) AS calls
       FROM ai_costs WHERE user_id = $1 GROUP BY surface ORDER BY cost_usd DESC`,
      [userId],
    );
    surfaces = r.rows.map((r: any) => ({
      surface: r.surface,
      cost_usd: parseFloat(r.cost_usd),
      calls: parseInt(r.calls),
    }));
    // Merge atlas total in if not already represented
    if (!surfaces.find((s) => s.surface === "atlas")) {
      surfaces.unshift({
        surface: "atlas",
        cost_usd: parseFloat(atlas.rows[0].cost_ltd),
        calls: parseInt(atlas.rows[0].turns),
      });
    }
  }

  // Model mix on Atlas turns
  const modelMix = await pool.query(
    `SELECT model_used, COUNT(*) AS turns, SUM(${costExprAtlas()})::numeric(10,4) AS cost_usd
     FROM atlas_turn_analytics WHERE user_id = $1 GROUP BY model_used ORDER BY cost_usd DESC`,
    [userId],
  );

  // Last 30d daily sparkline (atlas only for now)
  const daily = await pool.query(
    `SELECT date_trunc('day', created_at)::date AS d, SUM(${costExprAtlas()})::numeric(10,4) AS cost
     FROM atlas_turn_analytics WHERE user_id = $1 AND created_at >= $2
     GROUP BY 1 ORDER BY 1`,
    [userId, since30],
  );

  // Revenue
  const rev = await pool.query(
    `SELECT
       COALESCE(total_revenue, 0)::numeric(10,2) AS revenue_total,
       COALESCE(ltv_lifetime, 0)::numeric(10,2) AS ltv,
       last_payment_at
     FROM attribution WHERE user_id = $1`,
    [userId],
  );
  const revenueTotal = rev.rows[0] ? parseFloat(rev.rows[0].revenue_total) : 0;
  const ltv = rev.rows[0] ? parseFloat(rev.rows[0].ltv) : 0;

  const totalCost = parseFloat(atlas.rows[0].cost_ltd);
  const costToRevenuePct = revenueTotal > 0 ? (totalCost / revenueTotal) * 100 : null;

  return {
    coverage: useUnified ? "all_surfaces" : "atlas_only",
    cost_mtd: parseFloat(atlas.rows[0].cost_mtd),
    cost_ltd: totalCost,
    turns_mtd: parseInt(atlas.rows[0].turns_mtd),
    turns_ltd: parseInt(atlas.rows[0].turns),
    avg_cost_per_turn: atlas.rows[0].avg_cost_per_turn
      ? parseFloat(atlas.rows[0].avg_cost_per_turn)
      : 0,
    avg_latency_ms: atlas.rows[0].avg_latency_ms,
    revenue_total: revenueTotal,
    ltv,
    cost_to_revenue_pct: costToRevenuePct,
    surfaces,
    model_mix: modelMix.rows.map((r: any) => ({
      model: r.model_used,
      turns: parseInt(r.turns),
      cost_usd: parseFloat(r.cost_usd),
    })),
    daily_last_30d: daily.rows.map((r: any) => ({
      date: r.d.toISOString().slice(0, 10),
      cost_usd: parseFloat(r.cost),
    })),
  };
}

/**
 * Bulk per-member MTD cost map. Used by the members-list endpoint to
 * inject cost columns without N+1 queries.
 */
export async function getMembersMtdCostMap(): Promise<Map<string, number>> {
  const sinceMtd = new Date();
  sinceMtd.setDate(1);
  sinceMtd.setHours(0, 0, 0, 0);
  const useUnified = await aiCostsTableExists();
  const sql = useUnified
    ? `
      WITH src AS (
        SELECT user_id, cost_usd::numeric AS cost FROM ai_costs WHERE created_at >= $1
        UNION ALL
        SELECT user_id, ${costExprAtlas()} AS cost FROM atlas_turn_analytics WHERE created_at >= $1
      )
      SELECT user_id, SUM(cost)::numeric(10,4) AS cost FROM src
      WHERE user_id IS NOT NULL GROUP BY user_id
    `
    : `
      SELECT user_id, SUM(${costExprAtlas()})::numeric(10,4) AS cost
      FROM atlas_turn_analytics WHERE user_id IS NOT NULL AND created_at >= $1
      GROUP BY user_id
    `;
  const r = await pool.query(sql, [sinceMtd]);
  const m = new Map<string, number>();
  for (const row of r.rows) m.set(row.user_id, parseFloat(row.cost));
  return m;
}

export function registerEconomicsRoutes(app: Express) {
  app.get("/api/ops/economics/platform", async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt((req.query.days as string) || "30"), 7), 180);
      const data = await getPlatformEconomics(days);
      res.json(data);
    } catch (e) {
      console.error("[OPS] Platform economics error:", e);
      res.status(500).json({ error: "Failed to load platform economics" });
    }
  });

  app.get("/api/ops/economics/members/:id", async (req, res) => {
    try {
      const data = await getMemberEconomics(req.params.id);
      res.json(data);
    } catch (e) {
      console.error("[OPS] Member economics error:", e);
      res.status(500).json({ error: "Failed to load member economics" });
    }
  });
}
