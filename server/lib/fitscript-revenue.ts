import { pool } from "../db";

/**
 * THE FitScript revenue ledger (2026-10-12). Stripe was deleted 09-02, so
 * every FitScript money figure anywhere in ops must come from the three
 * rails the main app actually writes — membership_charges (Wizlo/Gr4vy, net
 * of Gr4vy-reconciled refunds), captured supplement_orders, and lab_orders.
 * The Overview tab, the Command Center aggregator, the snapshot tiles, the
 * revenue chart and unit economics ALL call this module; a tile computing
 * its own revenue from another source is a regression (that drift is
 * exactly what Paul caught: a chart on dead Stripe, an MTD on a stale
 * attribution stamp and three signup clocks on one screen).
 */
const THREE_RAIL = `
  SELECT created_at AS ts, amount_cents - COALESCE(refunded_amount_cents, 0) AS net, 'membership' AS rail
    FROM membership_charges WHERE status IN ('paid','refunded')
  UNION ALL
  SELECT created_at, (ROUND(COALESCE(total_amount,'0')::numeric * 100))::bigint - COALESCE(discount_cents, 0), 'supplements'
    FROM supplement_orders WHERE wizlo_pay_transaction_id IS NOT NULL
  UNION ALL
  SELECT paid_at, price_cents - COALESCE(discount_cents, 0), 'labs'
    FROM lab_orders WHERE refunded_at IS NULL AND paid_at IS NOT NULL`;

export interface FsRevenueWindow {
  cents: number;
  orders: number;
  byRail: Record<string, number>;
  /** YYYY-MM-DD -> cents, only days with revenue. */
  byDay: Record<string, number>;
}

export async function fsWindowRevenue(from: Date, to: Date): Promise<FsRevenueWindow> {
  const r = await pool.query(
    `SELECT to_char(ts::date, 'YYYY-MM-DD') AS d, rail, SUM(net)::bigint AS c, COUNT(*)::int AS n
       FROM (${THREE_RAIL}) rails WHERE ts >= $1 AND ts <= $2 GROUP BY 1, 2`,
    [from, to],
  );
  const out: FsRevenueWindow = { cents: 0, orders: 0, byRail: {}, byDay: {} };
  for (const row of r.rows) {
    const c = Number(row.c);
    out.cents += c;
    out.orders += row.n;
    out.byRail[row.rail] = (out.byRail[row.rail] ?? 0) + c;
    out.byDay[row.d] = (out.byDay[row.d] ?? 0) + c;
  }
  return out;
}

/** MRR from the newest paid charge per user, counted while its period runs (monthly 35d, annual 370d). */
export async function fsMrrCents(): Promise<number> {
  const m = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN period = 'annual' THEN amount_cents / 12.0 ELSE amount_cents END), 0)::bigint AS mrr
       FROM (SELECT DISTINCT ON (user_id) user_id, amount_cents, period, created_at
               FROM membership_charges
              WHERE status = 'paid' AND created_at >= now() - interval '370 days'
              ORDER BY user_id, created_at DESC) latest
      WHERE (period = 'annual' AND created_at >= now() - interval '370 days')
         OR (period <> 'annual' AND created_at >= now() - interval '35 days')`,
  );
  return Number(m.rows[0].mrr);
}
