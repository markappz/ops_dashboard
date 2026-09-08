/**
 * Real Peptides orders with source attribution.
 *
 * Orders come from the new site's token-gated `GET /api/ops-orders`; the
 * source comes from OUR pixel: the confirmation page fires
 * `fsTrack("purchase", { order_id, revenue })`, which lands as a touchpoint
 * tied to the visitor's session (UTMs, referrer, landing page, first-touch).
 * Join on order_id, classify into human channels. Orders with no matching
 * beacon (pre-beacon history, blocked pixels) show as "untracked" — absent
 * attribution is shown as absent, never guessed.
 */
import type { Express } from "express";
import { pool } from "./db";

const SITE = "realpeptides";

export interface OrderRow {
  id: string;
  number: string;
  createdAt: string;
  email: string | null;
  total: number;
  status: string | null;
  items: { name: string; qty: number }[];
  channel: string;          // affiliate | email | paid-google | paid-meta | paid-tiktok | paid-other | ai | social | blog | organic-search | referral | direct | untracked
  landing: string | null;   // landing page path of the buying session
  campaign: string | null;  // utm_campaign (or utm_source for email)
  referrer: string | null;
  firstTouch: boolean;      // true when attribution came from the remembered first touch
  coupon: string | null;
  affiliate: string | null; // affiliate username/email when a Referral or affiliate coupon is on the order
  attributedBy: "pixel" | "site" | "none";
}

function config() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  if (!base || !token) return null;
  return { base: base.replace(/\/$/, ""), token };
}

const PAGE = 500;
const MAX_PAGES = 40;
const ordersCache = new Map<number, { at: number; orders: any[] }>();
const CACHE_MS = 60_000;

async function siteOrdersPage(days: number, before: string | null): Promise<any[]> {
  const cfg = config();
  if (!cfg) throw new Error("not-configured");
  const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
  const r = await fetch(`${cfg.base}/api/ops-orders?days=${days}&limit=${PAGE}${cursor}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, "User-Agent": "FitScriptOps/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 404) throw new Error("endpoint-missing");
  const text = await r.text();
  if (!r.ok) throw new Error(`realpeptides.co ops-orders ${r.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  return j.orders ?? j;
}

/**
 * The site returns newest-first, capped per request, so a busy window needs
 * paging: keep asking for orders strictly older than the oldest seen until a
 * short page comes back. Cached a minute — the tab polls on a timer.
 */
async function siteOrders(days: number): Promise<any[]> {
  const hit = ordersCache.get(days);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.orders;
  const all: any[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await siteOrdersPage(days, before);
    all.push(...batch);
    if (batch.length < PAGE) break;
    const oldest = batch[batch.length - 1]?.createdAt ?? batch[batch.length - 1]?.created_at;
    if (!oldest || oldest === before) break;
    before = String(oldest);
  }
  ordersCache.set(days, { at: Date.now(), orders: all });
  return all;
}

const path = (u: string | null) => { try { return u ? new URL(u, "https://x.co").pathname : null; } catch { return null; } };
const host = (u: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : null; } catch { return null; } };

const SEARCH = /google\.|bing\.|duckduckgo\.|yahoo\.|ecosia\./;
const SOCIAL = /facebook\.|instagram\.|twitter\.|x\.com|t\.co|tiktok\.|reddit\.|youtube\.|linkedin\.|pinterest\.|threads\./;
const AI = /chatgpt\.|openai\.|perplexity\.|claude\.|gemini\.google|copilot\./;
const META_SRC = /^(fb|ig|facebook|instagram|meta|threads)$/;
const TIKTOK_SRC = /^(tt|tiktok)$/;
const GOOGLE_SRC = /^(google|adwords|gads|youtube)$/;
const PAID_MEDIUM = /^(cpc|ppc|paid|paid_social|paidsocial|paid-social|display|cpm|sponsored)$/;
const EMAIL_COUPONS = new Set(["WELCOME", "CARTSAVER", "BIBLE", "COMEBACK"]);

export interface Touch {
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
  gclid?: string | null; fbclid?: string | null; ttclid?: string | null;
  referrer: string | null; landing: string | null;
}

/**
 * One buying session → a channel a marketer recognizes. Precedence, top wins:
 *   affiliate  — a Referral row or an affiliate-owned coupon on the order
 *   email      — utm_medium=email, an email platform as source, or a flow coupon
 *   paid-*     — click ids (gclid/fbclid/ttclid) or a paid utm_medium, split by platform
 *   ai         — ChatGPT / Perplexity / Claude / Gemini referrer
 *   social     — social referrer or utm_medium=social
 *   blog / organic-search — search-engine referrer (blog when the landing page is a post)
 *   referral   — any other external site
 *   direct     — no referrer and no UTMs: typed, bookmarked, or an in-app browser
 *                that stripped the referrer (Instagram/X/TikTok often do)
 */
export function classify(t: Touch, extra: { affiliate?: string | null; couponSource?: string | null } = {}): { channel: string; campaign: string | null } {
  const medium = (t.utm_medium || "").toLowerCase();
  const source = (t.utm_source || "").toLowerCase();
  const ref = host(t.referrer) || "";
  const landing = t.landing || "";
  const campaign = t.utm_campaign || null;

  if (extra.affiliate) return { channel: "affiliate", campaign: extra.affiliate };
  if (medium === "email" || source === "email" || /campaignrefinery|moosend|resend|klaviyo/.test(source) || (extra.couponSource && EMAIL_COUPONS.has(extra.couponSource))) {
    return { channel: "email", campaign: campaign || t.utm_source || (extra.couponSource ? `${extra.couponSource.toLowerCase()} flow` : null) };
  }
  const paid = !!(t.gclid || t.fbclid || t.ttclid) || PAID_MEDIUM.test(medium);
  if (paid) {
    if (t.gclid || GOOGLE_SRC.test(source)) return { channel: "paid-google", campaign };
    if (t.fbclid || META_SRC.test(source)) return { channel: "paid-meta", campaign };
    if (t.ttclid || TIKTOK_SRC.test(source)) return { channel: "paid-tiktok", campaign };
    return { channel: "paid-other", campaign: campaign || t.utm_source };
  }
  if (AI.test(ref) || source === "chatgpt" || source === "perplexity") return { channel: "ai", campaign };
  if (SOCIAL.test(ref) || medium === "social" || META_SRC.test(source) || TIKTOK_SRC.test(source) || source === "x" || source === "twitter") return { channel: "social", campaign: campaign || t.utm_source };
  if (SEARCH.test(ref) || medium === "organic") {
    return { channel: /^\/blogs?\//.test(landing) ? "blog" : "organic-search", campaign };
  }
  if (/^\/blogs?\//.test(landing)) return { channel: "blog", campaign };
  if (ref && !ref.includes("realpeptides")) return { channel: "referral", campaign };
  return { channel: "direct", campaign };
}

/** purchase touchpoints keyed by order_id, with their session's context. */
async function purchaseAttribution(days: number) {
  const { rows } = await pool.query(`
    SELECT t.event_data->>'order_id' AS order_id,
           t.utm_source AS t_source, t.utm_medium AS t_medium, t.utm_campaign AS t_campaign,
           s.utm_source, s.utm_medium, s.utm_campaign, s.gclid, s.fbclid, s.ttclid, s.referrer, s.landing_page
    FROM touchpoints t
    LEFT JOIN visitor_sessions s ON s.visitor_id = t.visitor_id AND s.session_id = t.session_id AND s.site = t.site
    WHERE t.site = $1 AND t.event_type = 'purchase'
      AND t.event_data->>'order_id' IS NOT NULL
      AND t.created_at > NOW() - ($2 || ' days')::interval
  `, [SITE, days + 2]);
  const map = new Map<string, any>();
  for (const r of rows) map.set(String(r.order_id), r);
  return map;
}

export function registerRealPeptidesOrders(app: Express) {
  app.get("/api/ops/realpeptides/orders", async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.range || "30"), 10) || 30));
    try {
      const [orders, attr] = await Promise.all([siteOrders(days), purchaseAttribution(days)]);
      const rows: OrderRow[] = orders.map((o: any) => {
        const a = attr.get(String(o.id)) ?? attr.get(String(o.number));
        const ft = o.firstTouch ?? null;
        let touch: Touch | null = null;
        let firstTouch = false;
        let attributedBy: OrderRow["attributedBy"] = "none";
        if (a) {
          // Event-level UTMs (first-touch memory travels on the event) beat
          // session-level when the session itself arrived clean.
          touch = {
            utm_source: a.t_source || a.utm_source, utm_medium: a.t_medium || a.utm_medium,
            utm_campaign: a.t_campaign || a.utm_campaign, gclid: a.gclid, fbclid: a.fbclid, ttclid: a.ttclid,
            referrer: a.referrer, landing: path(a.landing_page),
          };
          firstTouch = !!(a.t_source && !a.utm_source);
          attributedBy = "pixel";
        } else if (ft) {
          // No pixel purchase beacon (blocked, or fired before the beacon existed):
          // fall back to the site's own first-touch cookie snapshot on the order.
          touch = { utm_source: ft.source, utm_medium: ft.medium, utm_campaign: ft.campaign, referrer: ft.referrer ? `https://${ft.referrer}/` : null, landing: ft.landing };
          firstTouch = true;
          attributedBy = "site";
        }
        const extra = { affiliate: o.affiliate ?? null, couponSource: o.couponSource ?? null };
        let channel = "untracked", campaign: string | null = null;
        if (touch) ({ channel, campaign } = classify(touch, extra));
        else if (extra.affiliate) ({ channel, campaign } = classify({ utm_source: null, utm_medium: null, utm_campaign: null, referrer: null, landing: null }, extra));
        else if (extra.couponSource && EMAIL_COUPONS.has(extra.couponSource)) ({ channel, campaign } = classify({ utm_source: null, utm_medium: "email", utm_campaign: null, referrer: null, landing: null }, extra));
        return {
          id: String(o.id),
          number: String(o.number ?? o.id),
          createdAt: o.createdAt ?? o.created_at,
          email: o.email ?? null,
          total: Math.round(Number(o.totalCents ?? 0)) / 100,
          status: o.status ?? null,
          items: (o.items ?? []).map((i: any) => ({ name: String(i.name), qty: Number(i.qty ?? i.quantity ?? 1) })),
          channel, campaign,
          landing: touch?.landing ?? null,
          referrer: host(touch?.referrer ?? null),
          firstTouch,
          coupon: o.couponCode ?? null,
          affiliate: o.affiliate ?? null,
          attributedBy,
        };
      });

      const byChannel: Record<string, { orders: number; revenue: number }> = {};
      for (const r of rows) {
        byChannel[r.channel] ??= { orders: 0, revenue: 0 };
        byChannel[r.channel].orders++;
        byChannel[r.channel].revenue += r.total;
      }
      res.json({ configured: true, range: days, orders: rows, byChannel, generatedAt: new Date().toISOString() });
    } catch (e: any) {
      if (e.message === "not-configured") {
        return res.json({ configured: false, hint: "Connect the new realpeptides.co backend first (RP_SITE_API_URL + RP_SITE_OPS_TOKEN)." });
      }
      if (e.message === "endpoint-missing") {
        return res.json({ configured: false, hint: "Ops is wired and waiting — the site's /api/ops-orders isn't live yet. The orders list appears automatically once the dev team ships it (spec shared)." });
      }
      console.error("[OPS][RP] orders:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
