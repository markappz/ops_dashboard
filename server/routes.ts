/**
 * Ops Dashboard API Routes
 *
 * All routes prefixed with /api/ops/
 * Reads from the same database as the main FitScript app.
 */
import type { Express } from "express";
import { pool } from "./db";
import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export function registerRoutes(app: Express) {
  // ─── Command Center ────────────────────────────────────────────────

  // Executive snapshot — all key metrics in one call
  // Uses raw SQL for reliability — Drizzle ORM date comparisons can be quirky
  app.get("/api/ops/snapshot", async (_req, res) => {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const snapshot = await pool.query(`
        SELECT
          (SELECT count(*) FROM users) AS total_users,
          (SELECT count(*) FROM users WHERE created_at >= $1) AS signups_today,
          (SELECT count(*) FROM users WHERE created_at >= $2) AS signups_week,
          (SELECT count(*) FROM users WHERE created_at >= $3) AS signups_month,
          (SELECT count(*) FROM users WHERE subscription_tier != 'free' AND subscription_status = 'active') AS active_subscribers,
          (SELECT count(*) FROM subscriptions WHERE status = 'canceled') AS cancelled_total,
          (SELECT count(*) FROM lab_uploads) AS total_labs,
          (SELECT count(*) FROM consultations) AS total_consultations,
          (SELECT count(*) FROM ai_advisor_conversations) AS total_atlas_chats,
          (SELECT count(*) FROM information_schema.tables WHERE table_name = 'waitlist_entries') AS has_waitlist
      `, [today.toISOString(), sevenDaysAgo.toISOString(), thirtyDaysAgo.toISOString()]);

      const s = snapshot.rows[0];

      // Tier breakdown
      const tierResult = await pool.query(`
        SELECT COALESCE(subscription_tier, 'free') AS tier, count(*) AS count
        FROM users GROUP BY subscription_tier
      `);
      const tiers: Record<string, number> = {};
      for (const row of tierResult.rows) {
        tiers[row.tier || "free"] = parseInt(row.count);
      }

      const totalUsers = parseInt(s.total_users);
      const activeSubscribers = parseInt(s.active_subscribers);
      const cancelledMonth = parseInt(s.cancelled_total);

      // Stripe MRR (if connected)
      let mrr = 0;
      let totalRevenue = 0;
      if (stripe) {
        try {
          // Get active subscriptions for MRR
          const subs = await stripe.subscriptions.list({ status: "active", limit: 100 });
          mrr = subs.data.reduce((sum, sub) => {
            const item = sub.items.data[0];
            if (!item?.price?.unit_amount) return sum;
            const monthly = sub.items.data[0].price.recurring?.interval === "year"
              ? item.price.unit_amount / 12
              : item.price.unit_amount;
            return sum + monthly;
          }, 0) / 100; // cents to dollars

          // Get balance transactions for total revenue (last 30 days)
          const charges = await stripe.charges.list({
            created: { gte: Math.floor(thirtyDaysAgo.getTime() / 1000) },
            limit: 100,
          });
          totalRevenue = charges.data
            .filter((c) => c.paid && !c.refunded)
            .reduce((sum, c) => sum + c.amount, 0) / 100;
        } catch (e) {
          console.warn("[OPS] Stripe query failed:", (e as Error).message);
        }
      }

      res.json({
        totalUsers,
        tiers,
        activeSubscribers,
        signupsToday: parseInt(s.signups_today),
        signupsWeek: parseInt(s.signups_week),
        signupsMonth: parseInt(s.signups_month),
        cancelledMonth,
        churnRate: activeSubscribers > 0
          ? ((cancelledMonth / (activeSubscribers + cancelledMonth)) * 100).toFixed(1)
          : "0",
        totalLabs: parseInt(s.total_labs),
        totalConsultations: parseInt(s.total_consultations),
        totalAtlasChats: parseInt(s.total_atlas_chats),
        waitlistCount: 0, // TODO: query if table exists
        mrr: Math.round(mrr),
        arr: Math.round(mrr * 12),
        revenueMonth: Math.round(totalRevenue),
      });
    } catch (error) {
      console.error("[OPS] Snapshot error:", error);
      res.status(500).json({ error: "Failed to load snapshot" });
    }
  });

  // ─── Members ───────────────────────────────────────────────────────

  // List all members with pagination, search, filters
  app.get("/api/ops/members", async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = (req.query.search as string) || "";
      const tier = req.query.tier as string;
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: (string | number)[] = [];
      let paramIdx = 1;

      if (search) {
        conditions.push(`(email ILIKE $${paramIdx} OR first_name ILIKE $${paramIdx} OR last_name ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
      }
      if (tier && tier !== "all") {
        conditions.push(`subscription_tier = $${paramIdx}`);
        params.push(tier);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Check if attribution table exists (tracking tables auto-create on startup)
      const attrCheck = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'attribution')");
      const hasAttr = attrCheck.rows[0].exists;

      const membersResult = await pool.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.subscription_tier, u.subscription_status,
               u.stripe_customer_id, u.created_at, u.last_active_date
               ${hasAttr ? ", a.first_touch_source, a.ltv_lifetime, a.total_revenue, a.first_touch_campaign" : ""}
        FROM users u
        ${hasAttr ? "LEFT JOIN attribution a ON a.user_id = u.id" : ""}
        ${where}
        ORDER BY u.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `, [...params, limit, offset]);

      const totalResult = await pool.query(`SELECT count(*) FROM users ${where}`, params);
      const total = parseInt(totalResult.rows[0].count);

      const members = membersResult.rows.map((r: any) => ({
        id: r.id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        subscriptionTier: r.subscription_tier,
        subscriptionStatus: r.subscription_status,
        stripeCustomerId: r.stripe_customer_id,
        createdAt: r.created_at,
        lastActiveDate: r.last_active_date,
        source: r.first_touch_source || null,
        campaign: r.first_touch_campaign || null,
        ltv: r.ltv_lifetime ? parseFloat(r.ltv_lifetime) : 0,
        totalRevenue: r.total_revenue ? parseFloat(r.total_revenue) : 0,
      }));

      res.json({
        members,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (error) {
      console.error("[OPS] Members error:", error);
      res.status(500).json({ error: "Failed to load members" });
    }
  });

  // Get single member detail
  app.get("/api/ops/members/:id", async (req, res) => {
    try {
      const memberResult = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
      if (memberResult.rows.length === 0) return res.status(404).json({ error: "Member not found" });
      const member = memberResult.rows[0];

      const subResult = await pool.query("SELECT * FROM subscriptions WHERE user_id = $1", [req.params.id]);
      const sub = subResult.rows[0] || null;

      const labResult = await pool.query("SELECT count(*) FROM lab_uploads WHERE user_id = $1", [req.params.id]);
      const chatResult = await pool.query("SELECT count(*) FROM ai_advisor_conversations WHERE user_id = $1", [req.params.id]);

      // Get Stripe data if available
      let stripeData = null;
      if (stripe && member.stripe_customer_id) {
        try {
          const charges = await stripe.charges.list({ customer: member.stripe_customer_id, limit: 100 });
          const totalPaid = charges.data
            .filter((c) => c.paid && !c.refunded)
            .reduce((sum, c) => sum + c.amount, 0) / 100;
          stripeData = {
            totalPaid,
            chargeCount: charges.data.length,
            lastCharge: charges.data[0]?.created ? new Date(charges.data[0].created * 1000).toISOString() : null,
          };
        } catch {}
      }

      res.json({
        member: {
          id: member.id,
          email: member.email,
          firstName: member.first_name,
          lastName: member.last_name,
          subscriptionTier: member.subscription_tier,
          subscriptionStatus: member.subscription_status,
          stripeCustomerId: member.stripe_customer_id,
          stripeSubscriptionId: member.stripe_subscription_id,
          createdAt: member.created_at,
          lastActiveDate: member.last_active_date,
          sex: member.sex,
          dateOfBirth: member.date_of_birth,
        },
        subscription: sub ? {
          tier: sub.tier,
          status: sub.status,
          period: sub.period,
          startDate: sub.current_period_start,
          renewalDate: sub.current_period_end,
        } : null,
        labCount: parseInt(labResult.rows[0].count),
        chatCount: parseInt(chatResult.rows[0].count),
        stripe: stripeData,
      });
    } catch (error) {
      console.error("[OPS] Member detail error:", error);
      res.status(500).json({ error: "Failed to load member" });
    }
  });

  // ─── Member Actions ─────────────────────────────────────────────────

  // Helper: get member by ID using raw SQL
  async function getMember(id: string) {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows[0] || null;
  }

  // Cancel a member's subscription
  app.post("/api/ops/members/:id/cancel", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const member = await getMember(req.params.id);
      if (!member) return res.status(404).json({ error: "Member not found" });
      if (!member.stripe_subscription_id) return res.status(400).json({ error: "No active subscription" });

      const immediate = req.body.immediate === true;

      if (immediate) {
        await stripe.subscriptions.cancel(member.stripe_subscription_id);
      } else {
        await stripe.subscriptions.update(member.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
      }

      // Update local DB
      await pool.query("UPDATE users SET subscription_status = $1 WHERE id = $2", [immediate ? "canceled" : "active", req.params.id]);

      if (immediate) {
        await pool.query("UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1", [req.params.id]);
      }

      console.log(`[OPS] Subscription ${immediate ? "cancelled" : "set to cancel at period end"} for ${member.email}`);
      res.json({ success: true, immediate });
    } catch (error: any) {
      console.error("[OPS] Cancel error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Pause a member's subscription
  app.post("/api/ops/members/:id/pause", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const member = await getMember(req.params.id);
      if (!member?.stripeSubscriptionId) return res.status(400).json({ error: "No active subscription" });

      await stripe.subscriptions.update(member.stripe_subscription_id, {
        pause_collection: { behavior: "void" },
      });

      await pool.query("UPDATE users SET subscription_status = 'paused' WHERE id = $1", [req.params.id]);

      console.log(`[OPS] Subscription paused for ${member.email}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[OPS] Pause error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Resume a paused subscription
  app.post("/api/ops/members/:id/resume", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const member = await getMember(req.params.id);
      if (!member?.stripeSubscriptionId) return res.status(400).json({ error: "No active subscription" });

      await stripe.subscriptions.update(member.stripe_subscription_id, {
        pause_collection: "",
      } as any);

      await pool.query("UPDATE users SET subscription_status = 'active' WHERE id = $1", [req.params.id]);

      console.log(`[OPS] Subscription resumed for ${member.email}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[OPS] Resume error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Change subscription tier
  app.post("/api/ops/members/:id/change-tier", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const { tier } = req.body;
      if (!tier) return res.status(400).json({ error: "tier required" });

      const member = await getMember(req.params.id);
      if (!member) return res.status(404).json({ error: "Member not found" });

      // Update local DB
      await pool.query("UPDATE users SET subscription_tier = $1 WHERE id = $2", [tier, req.params.id]);
      await pool.query("UPDATE subscriptions SET tier = $1 WHERE user_id = $2", [tier, req.params.id]);

      console.log(`[OPS] Tier changed to ${tier} for ${member.email}`);
      res.json({ success: true, tier });
    } catch (error: any) {
      console.error("[OPS] Change tier error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Issue refund
  app.post("/api/ops/members/:id/refund", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const { amount, chargeId, reason } = req.body;

      const member = await getMember(req.params.id);
      if (!member) return res.status(404).json({ error: "Member not found" });

      let targetChargeId = chargeId;

      // If no specific charge, refund the most recent one
      if (!targetChargeId && member.stripe_customer_id) {
        const charges = await stripe.charges.list({ customer: member.stripe_customer_id, limit: 1 });
        if (charges.data.length === 0) return res.status(400).json({ error: "No charges found" });
        targetChargeId = charges.data[0].id;
      }

      if (!targetChargeId) return res.status(400).json({ error: "No charge to refund" });

      const refundParams: any = { charge: targetChargeId };
      if (amount) refundParams.amount = Math.round(amount * 100); // dollars to cents
      if (reason) refundParams.reason = reason; // duplicate, fraudulent, requested_by_customer

      const refund = await stripe.refunds.create(refundParams);

      console.log(`[OPS] Refund issued: $${(refund.amount / 100).toFixed(2)} for ${member.email}`);
      res.json({
        success: true,
        refundId: refund.id,
        amount: refund.amount / 100,
        status: refund.status,
      });
    } catch (error: any) {
      console.error("[OPS] Refund error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Comp free months (extend subscription end date)
  app.post("/api/ops/members/:id/comp", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const { months } = req.body;
      if (!months || months < 1) return res.status(400).json({ error: "months required (1+)" });

      const member = await getMember(req.params.id);
      if (!member?.stripeSubscriptionId) return res.status(400).json({ error: "No active subscription" });

      // Get current subscription
      const sub = await stripe.subscriptions.retrieve(member.stripe_subscription_id);
      const currentEnd = sub.current_period_end;
      const newTrialEnd = currentEnd + months * 30 * 24 * 60 * 60;

      // Add free time by setting trial_end
      await stripe.subscriptions.update(member.stripe_subscription_id, {
        trial_end: newTrialEnd,
        proration_behavior: "none",
      });

      console.log(`[OPS] Comped ${months} month(s) for ${member.email}`);
      res.json({ success: true, months, newTrialEnd: new Date(newTrialEnd * 1000).toISOString() });
    } catch (error: any) {
      console.error("[OPS] Comp error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Get Stripe payment history for a member
  app.get("/api/ops/members/:id/payments", async (req, res) => {
    try {
      if (!stripe) return res.json({ payments: [] });

      const member = await getMember(req.params.id);
      if (!member?.stripeCustomerId) return res.json({ payments: [] });

      const charges = await stripe.charges.list({ customer: member.stripe_customer_id, limit: 50 });

      const payments = charges.data.map((c) => ({
        id: c.id,
        amount: c.amount / 100,
        currency: c.currency,
        status: c.status,
        paid: c.paid,
        refunded: c.refunded,
        amountRefunded: c.amount_refunded / 100,
        description: c.description,
        created: new Date(c.created * 1000).toISOString(),
        receiptUrl: c.receipt_url,
      }));

      res.json({ payments });
    } catch (error: any) {
      console.error("[OPS] Payments error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Order Actions ─────────────────────────────────────────────────

  // Update order status
  app.patch("/api/ops/orders/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: "status required" });

      await pool.query("UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2", [status, req.params.id]);

      console.log(`[OPS] Order ${req.params.id} status → ${status}`);
      res.json({ success: true, status });
    } catch (error: any) {
      console.error("[OPS] Order status error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Update order tracking
  app.patch("/api/ops/orders/:id/tracking", async (req, res) => {
    try {
      const { trackingNumber, carrier } = req.body;

      await pool.query(
        "UPDATE orders SET tracking_number = $1, carrier = $2, status = 'SHIPPED', shipped_at = NOW(), updated_at = NOW() WHERE id = $3",
        [trackingNumber, carrier || null, req.params.id]
      );

      console.log(`[OPS] Order ${req.params.id} shipped: ${trackingNumber}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[OPS] Tracking error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Refund an order
  app.post("/api/ops/orders/:id/refund", async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: "Stripe not connected" });

      const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: "Order not found" });

      const order = result.rows[0];
      if (!order.stripe_payment_intent_id) return res.status(400).json({ error: "No payment intent" });

      const refund = await stripe.refunds.create({
        payment_intent: order.stripe_payment_intent_id,
        reason: "requested_by_customer",
      });

      await pool.query(
        "UPDATE orders SET payment_status = 'refunded', status = 'CANCELLED', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );

      console.log(`[OPS] Order ${order.visible_id} refunded: $${refund.amount / 100}`);
      res.json({ success: true, amount: refund.amount / 100 });
    } catch (error: any) {
      console.error("[OPS] Order refund error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Recent Activity ───────────────────────────────────────────────

  app.get("/api/ops/activity", async (_req, res) => {
    try {
      // Combined activity feed via raw SQL
      const result = await pool.query(`
        (SELECT 'signup' AS type, email, first_name AS name, subscription_tier AS tier, NULL AS status, created_at AS ts FROM users ORDER BY created_at DESC LIMIT 15)
        UNION ALL
        (SELECT 'lab_upload' AS type, NULL AS email, NULL AS name, NULL AS tier, status, uploaded_at AS ts FROM lab_uploads ORDER BY uploaded_at DESC LIMIT 15)
        ORDER BY ts DESC LIMIT 20
      `);

      const activity = result.rows.map((r: any) => ({
        type: r.type,
        email: r.email,
        name: r.name,
        tier: r.tier,
        status: r.status,
        timestamp: r.ts,
      }));

      res.json({ activity });
    } catch (error) {
      console.error("[OPS] Activity error:", error);
      res.status(500).json({ error: "Failed to load activity" });
    }
  });

  // ─── Orders ────────────────────────────────────────────────────────

  // Rx orders list
  app.get("/api/ops/orders", async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string;
      const offset = (page - 1) * limit;

      // Use raw SQL for reliability
      const statusFilter = status && status !== "all" ? `WHERE o.status = $3` : "";
      const params: (string | number)[] = [limit, offset];
      if (status && status !== "all") params.push(status);

      const result = await pool.query(`
        SELECT o.*, u.email, u.first_name, u.last_name
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        ${statusFilter}
        ORDER BY o.created_at DESC
        LIMIT $1 OFFSET $2
      `, params);

      const [totalResult] = (await pool.query(`SELECT count(*) FROM orders ${statusFilter ? `WHERE status = $1` : ""}`, status && status !== "all" ? [status] : [])).rows;

      // Order statuses summary
      const statusSummary = await pool.query(`
        SELECT status, count(*) FROM orders GROUP BY status
      `);

      res.json({
        orders: result.rows,
        statuses: Object.fromEntries(statusSummary.rows.map((r: any) => [r.status, parseInt(r.count)])),
        pagination: {
          page,
          limit,
          total: parseInt(totalResult.count),
          pages: Math.ceil(parseInt(totalResult.count) / limit),
        },
      });
    } catch (error) {
      console.error("[OPS] Orders error:", error);
      res.status(500).json({ error: "Failed to load orders" });
    }
  });

  // Lab orders list
  app.get("/api/ops/lab-orders", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT lo.*, u.email, u.first_name, u.last_name
        FROM lab_orders lo
        LEFT JOIN users u ON lo.user_id = u.id
        ORDER BY lo.created_at DESC
        LIMIT 100
      `);

      const statusSummary = await pool.query(`
        SELECT status, count(*) FROM lab_orders GROUP BY status
      `);

      res.json({
        orders: result.rows,
        statuses: Object.fromEntries(statusSummary.rows.map((r: any) => [r.status, parseInt(r.count)])),
      });
    } catch (error) {
      console.error("[OPS] Lab orders error:", error);
      res.status(500).json({ error: "Failed to load lab orders" });
    }
  });

  // Revenue breakdown
  app.get("/api/ops/revenue", async (_req, res) => {
    try {
      if (!stripe) return res.json({ error: "Stripe not connected" });

      const now = new Date();
      const thirtyDaysAgo = Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
      const ninetyDaysAgo = Math.floor((now.getTime() - 90 * 24 * 60 * 60 * 1000) / 1000);

      // Recent charges grouped by day
      const charges = await stripe.charges.list({ created: { gte: ninetyDaysAgo }, limit: 100 });
      const dailyRevenue: Record<string, number> = {};
      let totalRefunds = 0;

      for (const charge of charges.data) {
        if (!charge.paid) continue;
        const date = new Date(charge.created * 1000).toISOString().split("T")[0];
        dailyRevenue[date] = (dailyRevenue[date] || 0) + charge.amount / 100;
        if (charge.refunded) totalRefunds += charge.amount_refunded / 100;
      }

      // Sort by date
      const chartData = Object.entries(dailyRevenue)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, revenue]) => ({ date, revenue: Math.round(revenue) }));

      // Subscription counts
      const activeSubs = await stripe.subscriptions.list({ status: "active", limit: 100 });
      const canceledSubs = await stripe.subscriptions.list({ status: "canceled", limit: 20 });

      res.json({
        chartData,
        totalRefunds: Math.round(totalRefunds),
        activeSubscriptions: activeSubs.data.length,
        canceledRecent: canceledSubs.data.filter(
          (s) => s.canceled_at && s.canceled_at > thirtyDaysAgo
        ).length,
      });
    } catch (error) {
      console.error("[OPS] Revenue error:", error);
      res.status(500).json({ error: "Failed to load revenue" });
    }
  });
}
