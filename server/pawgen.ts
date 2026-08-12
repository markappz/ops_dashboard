/**
 * pawgen dashboard API — orders + refunds against the pawgen Supabase Postgres.
 * Reads via `pawgenPool` (raw parameterized SQL). Refunds hit pawgen's OWN Stripe
 * account (PAWGEN_STRIPE_SECRET_KEY, separate from FitScript's key) and reverse
 * loyalty points in pawgen's `points_ledger`. If the pool/key is unset, endpoints
 * return 503 so the UI shows a graceful "not connected" state.
 */
import type { Express, Request, Response } from "express";
import Stripe from "stripe";
import { pawgenPool } from "./db";
import * as rest from "./pawgen-rest";

const pawgenStripe = process.env.PAWGEN_STRIPE_SECRET_KEY
  ? new Stripe(process.env.PAWGEN_STRIPE_SECRET_KEY)
  : null;

/**
 * Two ways in, because the Postgres route needs the project DB password AND the
 * session-pooler's `postgres.<ref>` user — the exact thing that was failing with
 * `password authentication failed for user "postgres"`. The REST route reuses the
 * service-role key pawgen's own app already runs on.
 *
 * REST wins when it's configured. That ordering matters: `new Pool()` never
 * connects eagerly, so `pawgenPool` is non-null whenever PAWGEN_DATABASE_URL is
 * merely *set* — including when its credentials are garbage. "Pool exists" is
 * therefore no evidence the pool works, while the REST vars being present is an
 * explicit choice someone made. Preferring the pool here meant a stale, broken
 * DATABASE_URL silently shadowed a working REST config.
 */
type Source = "pool" | "rest";

function source(): Source | null {
  if (rest.pawgenRestConfigured()) return "rest";
  if (pawgenPool) return "pool";
  return null;
}

function ensureSource(res: Response): Source | null {
  const s = source();
  if (!s) {
    res.status(503).json({
      error:
        "pawgen database not connected — set PAWGEN_SUPABASE_URL + PAWGEN_SUPABASE_SERVICE_ROLE_KEY (or a valid PAWGEN_DATABASE_URL)",
    });
    return null;
  }
  return s;
}

const PACK_LABELS: Record<string, string> = {
  "1-pack": "1 pack",
  "2-pack": "2 packs",
  "4-pack": "4 packs",
};

export function registerPawgenRoutes(app: Express) {
  // ── Orders list + headline stats ──────────────────────────────────────────
  app.get("/api/ops/pawgen/orders", async (req: Request, res: Response) => {
    const src = ensureSource(res);
    if (!src) return;
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = 50;
      const offset = (page - 1) * limit;
      const status = String(req.query.status ?? "all");

      if (src === "rest") {
        const [{ rows, total }, { stats, statuses }] = await Promise.all([
          rest.listOrders(status, limit, offset),
          rest.ordersSummary(),
        ]);
        return res.json({
          orders: rows.map((o) => ({
            ...o,
            pack_label: PACK_LABELS[o.pack_id] ?? o.pack_id,
            amount_usd: Number(o.amount_usd),
          })),
          stats,
          statuses,
          pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        });
      }

      const where: string[] = [];
      const params: any[] = [];
      if (status !== "all") {
        params.push(status);
        where.push(`fulfillment_status = $${params.length}`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const cols =
        "id, created_at, source, method, payment_status, amount_usd, pack_id, quantity, " +
        "bac_addon_qty, customer_name, customer_email, fulfillment_status, tracking_number, carrier";

      const [rowsRes, countRes, statsRes, statusRes] = await Promise.all([
        pawgenPool!.query(
          `SELECT ${cols} FROM orders ${whereSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
        pawgenPool!.query(`SELECT count(*)::int AS n FROM orders ${whereSql}`, params),
        pawgenPool!.query(
          `SELECT
             count(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders,
             coalesce(sum(amount_usd) FILTER (WHERE payment_status = 'paid'), 0)::numeric AS revenue,
             count(*) FILTER (WHERE payment_status = 'refunded')::int AS refunded,
             count(*) FILTER (WHERE payment_status = 'paid'
                              AND fulfillment_status IN ('unfulfilled','processing'))::int AS to_fulfill
           FROM orders`
        ),
        pawgenPool!.query(`SELECT fulfillment_status, count(*)::int AS n FROM orders GROUP BY fulfillment_status`),
      ]);

      const statuses: Record<string, number> = {};
      for (const r of statusRes.rows) statuses[r.fulfillment_status] = r.n;
      const s = statsRes.rows[0] ?? {};

      res.json({
        orders: rowsRes.rows.map((o) => ({
          ...o,
          pack_label: PACK_LABELS[o.pack_id] ?? o.pack_id,
          amount_usd: Number(o.amount_usd),
        })),
        stats: {
          paidOrders: s.paid_orders ?? 0,
          revenue: Number(s.revenue ?? 0),
          refunded: s.refunded ?? 0,
          toFulfill: s.to_fulfill ?? 0,
        },
        statuses,
        pagination: { page, limit, total: countRes.rows[0].n, pages: Math.max(1, Math.ceil(countRes.rows[0].n / limit)) },
      });
    } catch (e: any) {
      console.error("[OPS pawgen] orders error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Overview ──────────────────────────────────────────────────────────────
  // Everything here comes from real orders, so this tab is useful before any
  // analytics integration is connected.
  app.get("/api/ops/pawgen/overview", async (req: Request, res: Response) => {
    const src = ensureSource(res);
    if (!src) return;
    try {
      const days = Math.min(365, Math.max(7, parseInt(String(req.query.days ?? "30"), 10) || 30));
      const rows =
        src === "rest"
          ? await rest.ordersForAnalytics()
          : (
              await pawgenPool!.query(
                `SELECT created_at, amount_usd, shipping_cost, pack_id, method, source,
                        payment_status, fulfillment_status, customer_email
                   FROM orders ORDER BY created_at DESC`
              )
            ).rows;

      const since = Date.now() - days * 86400_000;
      const paid = rows.filter((o: any) => o.payment_status === "paid");
      const inWindow = paid.filter((o: any) => new Date(o.created_at).getTime() >= since);
      const money = (o: any) => Number(o.amount_usd) || 0;
      const sum = (list: any[]) => Math.round(list.reduce((s, o) => s + money(o), 0) * 100) / 100;

      // Revenue per day, zero-filled so the chart has no gaps.
      const byDay = new Map<string, { revenue: number; orders: number }>();
      for (let i = days - 1; i >= 0; i--) {
        byDay.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), { revenue: 0, orders: 0 });
      }
      for (const o of inWindow) {
        const k = new Date(o.created_at).toISOString().slice(0, 10);
        const cur = byDay.get(k);
        if (cur) {
          cur.revenue = Math.round((cur.revenue + money(o)) * 100) / 100;
          cur.orders += 1;
        }
      }

      const tally = (key: string) => {
        const m: Record<string, { orders: number; revenue: number }> = {};
        for (const o of paid) {
          const k = String((o as any)[key] ?? "—");
          m[k] ??= { orders: 0, revenue: 0 };
          m[k].orders += 1;
          m[k].revenue = Math.round((m[k].revenue + money(o)) * 100) / 100;
        }
        return Object.entries(m)
          .map(([k, v]) => ({ key: k, ...v }))
          .sort((a, b) => b.revenue - a.revenue);
      };

      // Repeat buyers — the cheapest signal of whether the product lands.
      const byEmail = new Map<string, number>();
      for (const o of paid) {
        const e = (o.customer_email ?? "").trim().toLowerCase();
        if (e) byEmail.set(e, (byEmail.get(e) ?? 0) + 1);
      }
      const repeatCustomers = [...byEmail.values()].filter((n) => n > 1).length;

      const backlog = rows.filter(
        (o: any) =>
          o.payment_status === "paid" &&
          (o.fulfillment_status === "unfulfilled" || o.fulfillment_status === "processing")
      );
      const oldestBacklogAt = backlog.length
        ? backlog.map((o: any) => new Date(o.created_at).getTime()).sort((a, b) => a - b)[0]
        : null;

      res.json({
        window: { days },
        totals: {
          revenueAllTime: sum(paid),
          ordersAllTime: paid.length,
          revenueWindow: sum(inWindow),
          ordersWindow: inWindow.length,
          aov: paid.length ? Math.round((sum(paid) / paid.length) * 100) / 100 : 0,
          pendingPayments: rows.filter((o: any) => o.payment_status === "pending").length,
          refunded: rows.filter((o: any) => o.payment_status === "refunded").length,
          customers: byEmail.size,
          repeatCustomers,
        },
        backlog: {
          count: backlog.length,
          value: sum(backlog),
          oldestAt: oldestBacklogAt ? new Date(oldestBacklogAt).toISOString() : null,
        },
        series: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
        byPack: tally("pack_id"),
        byMethod: tally("method"),
      });
    } catch (e: any) {
      console.error("[OPS pawgen] overview error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Refund ────────────────────────────────────────────────────────────────
  // Card orders → Stripe refund (full or partial) + status + point reversal.
  // Crypto orders → flagged for manual refund (crypto can't be reversed).
  app.post("/api/ops/pawgen/orders/:id/refund", async (req: Request, res: Response) => {
    const src = ensureSource(res);
    if (!src) return;
    try {
      const { id } = req.params;
      const amount = req.body?.amount != null ? Number(req.body.amount) : null; // dollars, optional (partial)
      const reason = req.body?.reason as string | undefined;

      const order =
        src === "rest"
          ? await rest.getOrder(id)
          : (
              await pawgenPool!.query(
                `SELECT id, source, method, external_id, payment_status, amount_usd, customer_email
                   FROM orders WHERE id = $1`,
                [id]
              )
            ).rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.payment_status !== "paid") {
        return res.status(400).json({ error: `Order is ${order.payment_status}, not refundable` });
      }

      if (order.source !== "stripe") {
        return res.json({
          manual: true,
          message: "Crypto order — refunds must be sent manually to the customer's wallet. No card charge to reverse.",
        });
      }

      if (!pawgenStripe) {
        return res.status(503).json({ error: "pawgen Stripe not configured (PAWGEN_STRIPE_SECRET_KEY unset)" });
      }

      // Resolve the payment intent from the stored checkout-session id.
      const session = await pawgenStripe.checkout.sessions.retrieve(order.external_id);
      const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (!pi) return res.status(400).json({ error: "No payment intent on this order — nothing to refund." });

      const total = Number(order.amount_usd);
      const isPartial = amount != null && amount > 0 && amount < total;
      const refund = await pawgenStripe.refunds.create({
        payment_intent: pi,
        ...(isPartial ? { amount: Math.round(amount! * 100) } : {}),
        ...(reason ? { reason: reason as Stripe.RefundCreateParams.Reason } : {}),
      });

      if (!isPartial) {
        // Full refund → mark refunded/cancelled. Earned points auto-reverse (they're
        // computed only from paid orders). Restore any points the customer redeemed.
        if (src === "rest") {
          await rest.markRefunded(id);
          const r = await rest.findRedemption(id);
          if (r && Number(r.delta) < 0) {
            await rest.restorePoints(r.email, -Number(r.delta), id);
          }
        } else {
          await pawgenPool!.query(
            `UPDATE orders SET payment_status = 'refunded', fulfillment_status = 'cancelled' WHERE id = $1`,
            [id]
          );
          const redeem = await pawgenPool!.query(
            `SELECT email, delta FROM points_ledger WHERE order_id = $1 AND reason = 'redeem' LIMIT 1`,
            [id]
          );
          const r = redeem.rows[0];
          if (r && Number(r.delta) < 0) {
            await pawgenPool!.query(
              `INSERT INTO points_ledger (email, delta, reason, order_id, note)
                 VALUES ($1, $2, 'adjust', $3, 'refund: restored redeemed points')
               ON CONFLICT (email, reason, order_id) WHERE order_id IS NOT NULL DO NOTHING`,
              [r.email, -Number(r.delta), id]
            );
          }
        }
      }

      console.log(`[OPS pawgen] Refund ${isPartial ? "(partial) " : ""}$${(refund.amount / 100).toFixed(2)} for order ${id}`);
      res.json({ success: true, amount: refund.amount / 100, mode: isPartial ? "partial" : "full", status: refund.status });
    } catch (e: any) {
      console.error("[OPS pawgen] refund error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}
