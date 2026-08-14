/**
 * Tracking API — first-party visitor tracking + attribution
 *
 * Endpoints:
 *   POST /api/t          — receive tracking events from client pixel
 *   POST /api/t/identify — link visitor_id to user_id (on signup/login)
 *
 * The client pixel (tracking.ts) sends events here.
 * Attribution is computed on identify and updated on each payment.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { pool } from "./db";

// Allowed origins for the tracking pixel. The pixel lives on fitscript.me
// (and any preview/dev variant) while ingest is on ops.fitscript.me, so
// browsers will block POSTs without explicit CORS allow.
//
// Keep this list narrow — it's NOT a generic CORS — and case-insensitive.
// Origin → brand. The site is derived from the BROWSER-SET Origin header, never
// from a field in the request body: a client-supplied site would let anyone write
// rows into another brand's numbers.
const ORIGIN_SITE: Record<string, string> = {
  "https://fitscript.me": "fitscript",
  "https://www.fitscript.me": "fitscript",
  "https://pawgen.com": "pawgen",
  "https://www.pawgen.com": "pawgen",
  "https://realpeptides.co": "realpeptides",
  "https://www.realpeptides.co": "realpeptides",
  // The three lead-magnet funnels are Real Peptides traffic, not brands of their
  // own — they all sell RP. The landing-page column keeps them distinguishable.
  "https://fatlossbible.co": "realpeptides",
  "https://www.fatlossbible.co": "realpeptides",
  "https://peptideplaybook.com": "realpeptides",
  "https://www.peptideplaybook.com": "realpeptides",
  "https://hairgrowthprotocol.com": "realpeptides",
  "https://www.hairgrowthprotocol.com": "realpeptides",
};
function siteForOrigin(origin: string | undefined): string {
  // Same-origin requests send no Origin header; those can only come from the
  // dashboard's own host, so fitscript is the correct default.
  return ORIGIN_SITE[origin ?? ""] ?? "fitscript";
}

// Every origin that may POST events. Kept in step with ORIGIN_SITE above: an
// origin that isn't in BOTH sets either gets blocked by CORS or lands in the
// wrong brand's numbers.
const TRACKING_ALLOWED_ORIGINS = new Set([
  ...Object.keys(ORIGIN_SITE),
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173",
]);

function trackingCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin || "";
  if (TRACKING_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // navigator.sendBeacon always sends cookies, so the browser treats the
    // pixel POST as a CREDENTIALED cross-origin request. Without this header
    // the preflight fails on www.fitscript.me — every event silently dropped
    // AND a CORS error logged to the console on every page load.
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
}

/**
 * Standalone pixel for sites that aren't React apps — realpeptides.co is
 * WordPress, so it can't import client/src/lib/tracking.ts. One script tag:
 *
 *   <script src="https://ops.fitscript.me/t.js" defer></script>
 *
 * The ingest host is read off the script's own src, so the same file works on
 * staging and locally. Brand is still decided server-side from the Origin — this
 * file never claims which site it is.
 */
const PIXEL_JS = `(function(){
  var s = document.currentScript;
  if (!s) return;
  var api = new URL(s.src).origin + "/api/t";
  var LS = "_fs_vid", SS = "_fs_sid", FT = "_fs_first";

  function id(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,10); }
  function get(store, key){ try { return store.getItem(key); } catch(e){ return null; } }
  function set(store, key, val){ try { store.setItem(key, val); } catch(e){} }

  var vid = get(localStorage, LS) || id(); set(localStorage, LS, vid);
  var sid = get(sessionStorage, SS) || id(); set(sessionStorage, SS, sid);

  var q = new URLSearchParams(location.search);
  var touch = {
    utm_source: q.get("utm_source"), utm_medium: q.get("utm_medium"),
    utm_campaign: q.get("utm_campaign"), utm_content: q.get("utm_content"),
    utm_term: q.get("utm_term"), gclid: q.get("gclid"),
    fbclid: q.get("fbclid"), ttclid: q.get("ttclid")
  };
  var hasUtm = Object.keys(touch).some(function(k){ return touch[k]; });

  // First touch wins and is remembered — a later organic visit must not
  // overwrite the ad that originally brought this visitor in.
  var stored = get(localStorage, FT);
  if (hasUtm) { set(localStorage, FT, JSON.stringify(touch)); }
  else if (stored) { try { touch = JSON.parse(stored); } catch(e){} }

  function device(){
    var w = window.innerWidth;
    return w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop";
  }

  function send(event_type, event_data){
    var body = JSON.stringify(Object.assign({
      visitor_id: vid, session_id: sid, event_type: event_type,
      page_url: location.href, referrer: document.referrer || null,
      device_type: device(), event_data: event_data || {}
    }, touch));
    try {
      fetch(api, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: body, credentials: "omit", keepalive: true
      }).catch(function(){});
    } catch(e){}
  }

  window.fsTrack = send;
  send("page_view");
})();`;

export function registerTrackingRoutes(app: Express) {
  // Apply CORS to every /api/t/* route. No-op for same-origin requests.
  app.use("/api/t", trackingCors);

  // Public — served to any site that includes it. Contains no secrets.
  app.get("/t.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(PIXEL_JS);
  });

  // ─── Receive tracking events ─────────────────────────────────────
  app.post("/api/t", async (req: Request, res) => {
    try {
      const {
        visitor_id, session_id, event_type, page_url, referrer,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        gclid, fbclid, ttclid, device_type, event_data,
      } = req.body;

      if (!visitor_id || !event_type) {
        return res.status(400).json({ error: "visitor_id and event_type required" });
      }

      const site = siteForOrigin(req.headers.origin);

      // Upsert visitor session
      if (event_type === "page_view") {
        const existing = await pool.query(
          "SELECT id FROM visitor_sessions WHERE visitor_id = $1 AND session_id = $2",
          [visitor_id, session_id]
        );

        if (existing.rows.length === 0) {
          // New session
          await pool.query(`
            INSERT INTO visitor_sessions (visitor_id, session_id, landing_page, exit_page, referrer,
              utm_source, utm_medium, utm_campaign, utm_content, utm_term,
              gclid, fbclid, ttclid, device_type, ip_address, user_agent, page_count, site)
            VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16)
          `, [
            visitor_id, session_id, page_url, referrer,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            gclid, fbclid, ttclid, device_type,
            req.ip, req.headers["user-agent"], site,
          ]);
        } else {
          // Update existing session
          await pool.query(`
            UPDATE visitor_sessions
            SET exit_page = $1, page_count = page_count + 1, updated_at = NOW()
            WHERE visitor_id = $2 AND session_id = $3
          `, [page_url, visitor_id, session_id]);
        }
      }

      // Record touchpoint
      await pool.query(`
        INSERT INTO touchpoints (visitor_id, session_id, event_type, page_url, utm_source, utm_campaign, event_data, revenue, site)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        visitor_id, session_id, event_type, page_url,
        utm_source, utm_campaign,
        JSON.stringify(event_data || {}),
        event_data?.revenue || 0,
        site,
      ]);

      // Auto-discover campaigns
      if (utm_campaign) {
        await pool.query(`
          INSERT INTO campaigns (name, slug, channel, medium, site)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (site, slug) DO NOTHING
        `, [utm_campaign, utm_campaign, utm_source || "unknown", utm_medium || "unknown", site]);
      }

      res.json({ ok: true });
    } catch (error: any) {
      console.error("[TRACK] Error:", error.message);
      res.status(500).json({ error: "tracking failed" });
    }
  });

  // ─── Identify: link visitor to user ──────────────────────────────
  app.post("/api/t/identify", async (req: Request, res) => {
    try {
      const { visitor_id, user_id } = req.body;
      if (!visitor_id || !user_id) {
        return res.status(400).json({ error: "visitor_id and user_id required" });
      }

      // Link all sessions and touchpoints for this visitor to the user
      await pool.query("UPDATE visitor_sessions SET user_id = $1 WHERE visitor_id = $2 AND user_id IS NULL", [user_id, visitor_id]);
      await pool.query("UPDATE touchpoints SET user_id = $1 WHERE visitor_id = $2 AND user_id IS NULL", [user_id, visitor_id]);

      // Compute attribution
      const firstSession = await pool.query(
        "SELECT * FROM visitor_sessions WHERE visitor_id = $1 ORDER BY created_at ASC LIMIT 1",
        [visitor_id]
      );
      const lastSession = await pool.query(
        "SELECT * FROM visitor_sessions WHERE visitor_id = $1 ORDER BY created_at DESC LIMIT 1",
        [visitor_id]
      );
      const sessionCount = await pool.query(
        "SELECT count(*) FROM visitor_sessions WHERE visitor_id = $1",
        [visitor_id]
      );
      const touchpointCount = await pool.query(
        "SELECT count(*) FROM touchpoints WHERE visitor_id = $1",
        [visitor_id]
      );

      const first = firstSession.rows[0];
      const last = lastSession.rows[0];

      if (first) {
        const daysToConvert = Math.max(0, Math.floor(
          (new Date().getTime() - new Date(first.created_at).getTime()) / (1000 * 60 * 60 * 24)
        ));

        await pool.query(`
          INSERT INTO attribution (user_id,
            first_touch_source, first_touch_medium, first_touch_campaign, first_touch_landing, first_touch_at,
            last_touch_source, last_touch_medium, last_touch_campaign, last_touch_landing, last_touch_at,
            converting_session, total_sessions, days_to_convert, total_touchpoints)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (user_id) DO UPDATE SET
            last_touch_source = $7, last_touch_medium = $8, last_touch_campaign = $9,
            last_touch_landing = $10, last_touch_at = $11,
            total_sessions = $13, total_touchpoints = $15, updated_at = NOW()
        `, [
          user_id,
          first.utm_source, first.utm_medium, first.utm_campaign, first.landing_page, first.created_at,
          last?.utm_source, last?.utm_medium, last?.utm_campaign, last?.landing_page, last?.created_at,
          last?.session_id, parseInt(sessionCount.rows[0].count), daysToConvert,
          parseInt(touchpointCount.rows[0].count),
        ]);
      }

      res.json({ ok: true });
    } catch (error: any) {
      console.error("[TRACK] Identify error:", error.message);
      res.status(500).json({ error: "identify failed" });
    }
  });

  // ─── Update revenue (called from Stripe webhook or manually) ────
  app.post("/api/t/revenue", async (req: Request, res) => {
    try {
      const { user_id, amount, event_type } = req.body;
      if (!user_id || amount === undefined) {
        return res.status(400).json({ error: "user_id and amount required" });
      }

      // Update attribution revenue
      await pool.query(`
        UPDATE attribution SET
          total_revenue = total_revenue + $2,
          last_payment_at = NOW(),
          first_payment_at = COALESCE(first_payment_at, NOW()),
          ltv_lifetime = total_revenue + $2,
          updated_at = NOW()
        WHERE user_id = $1
      `, [user_id, amount]);

      // Record touchpoint
      const visitor = await pool.query(
        "SELECT visitor_id FROM visitor_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [user_id]
      );
      if (visitor.rows[0]) {
        await pool.query(`
          INSERT INTO touchpoints (visitor_id, user_id, event_type, revenue, event_data)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          visitor.rows[0].visitor_id, user_id,
          event_type || "payment", amount,
          JSON.stringify({ amount }),
        ]);
      }

      res.json({ ok: true });
    } catch (error: any) {
      console.error("[TRACK] Revenue error:", error.message);
      res.status(500).json({ error: "revenue update failed" });
    }
  });

  // ─── Ops dashboard: attribution data ─────────────────────────────

  // Get attribution for a specific user
  app.get("/api/ops/members/:id/journey", async (req, res) => {
    try {
      // Attribution summary
      const attrResult = await pool.query("SELECT * FROM attribution WHERE user_id = $1", [req.params.id]);

      // All touchpoints for this user
      const touchpointsResult = await pool.query(`
        SELECT * FROM touchpoints WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100
      `, [req.params.id]);

      // All sessions for this user (via visitor_id)
      const sessionsResult = await pool.query(`
        SELECT vs.* FROM visitor_sessions vs
        WHERE vs.user_id = $1
        ORDER BY vs.created_at DESC LIMIT 50
      `, [req.params.id]);

      res.json({
        attribution: attrResult.rows[0] || null,
        touchpoints: touchpointsResult.rows,
        sessions: sessionsResult.rows,
      });
    } catch (error: any) {
      console.error("[OPS] Journey error:", error.message);
      res.status(500).json({ error: "Failed to load journey" });
    }
  });

  // Campaign performance
  app.get("/api/ops/campaigns", async (_req, res) => {
    try {
      const campaigns = await pool.query(`
        SELECT
          c.*,
          COALESCE(t.visitors, 0) AS visitors,
          COALESCE(t.signups, 0) AS signups,
          COALESCE(t.paid, 0) AS paid_conversions,
          COALESCE(t.revenue, 0) AS revenue,
          CASE WHEN c.spend > 0 THEN ROUND(COALESCE(t.revenue, 0) / c.spend, 2) ELSE 0 END AS roas,
          CASE WHEN COALESCE(t.paid, 0) > 0 THEN ROUND(c.spend / t.paid, 2) ELSE 0 END AS cpa
        FROM campaigns c
        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT tp.visitor_id) AS visitors,
            COUNT(DISTINCT CASE WHEN tp.event_type = 'signup' THEN tp.user_id END) AS signups,
            COUNT(DISTINCT CASE WHEN tp.event_type = 'subscription_started' THEN tp.user_id END) AS paid,
            COALESCE(SUM(tp.revenue), 0) AS revenue
          FROM touchpoints tp
          -- Join on site too: campaign slugs are only unique per brand now, so
          -- without this one brand's traffic lands in another's campaign stats.
          WHERE tp.utm_campaign = c.slug AND tp.site = c.site
        ) t ON true
        WHERE c.site = 'fitscript'
        ORDER BY c.created_at DESC
      `);

      res.json({ campaigns: campaigns.rows });
    } catch (error: any) {
      console.error("[OPS] Campaigns error:", error.message);
      res.status(500).json({ error: "Failed to load campaigns" });
    }
  });

  // Attribution overview — all channels
  app.get("/api/ops/attribution", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(first_touch_source, 'direct') AS channel,
          COUNT(*) AS users,
          COUNT(CASE WHEN total_revenue > 0 THEN 1 END) AS paying,
          COALESCE(SUM(total_revenue), 0) AS total_revenue,
          COALESCE(AVG(ltv_lifetime), 0) AS avg_ltv,
          COALESCE(AVG(days_to_convert), 0) AS avg_days_to_convert,
          COALESCE(AVG(total_sessions), 0) AS avg_sessions
        FROM attribution
        GROUP BY first_touch_source
        ORDER BY total_revenue DESC
      `);

      res.json({ channels: result.rows });
    } catch (error: any) {
      console.error("[OPS] Attribution error:", error.message);
      res.status(500).json({ error: "Failed to load attribution" });
    }
  });

  // Funnel data
  app.get("/api/ops/funnel", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(DISTINCT visitor_id) FROM visitor_sessions WHERE site = 'fitscript') AS visitors,
          (SELECT COUNT(DISTINCT visitor_id) FROM touchpoints WHERE site = 'fitscript' AND event_type = 'quiz_started') AS quiz_started,
          (SELECT COUNT(DISTINCT user_id) FROM touchpoints WHERE site = 'fitscript' AND event_type = 'signup') AS signups,
          (SELECT COUNT(DISTINCT user_id) FROM touchpoints WHERE site = 'fitscript' AND event_type = 'subscription_started') AS paid,
          (SELECT COUNT(DISTINCT user_id) FROM touchpoints WHERE site = 'fitscript' AND event_type = 'lab_uploaded') AS labs_uploaded,
          (SELECT COUNT(*) FROM attribution WHERE total_revenue > 0) AS revenue_users
      `);

      res.json(result.rows[0]);
    } catch (error: any) {
      console.error("[OPS] Funnel error:", error.message);
      res.status(500).json({ error: "Failed to load funnel" });
    }
  });
}
