/**
 * Live inventory sync + sales forecasting for Real Peptides.
 *
 * Shelf Planner is dead (it synced from WooCommerce, which the Vercel launch
 * removed). This is its replacement: the site's orders feed drives the COA
 * tracker's stock — every order decrements inventory within a sync cycle —
 * and the same feed powers per-SKU sales velocity for reorder forecasting.
 *
 * Double-count guard: stock was hand-seeded from the Shelf Planner sheet
 * snapshot taken 2026-08-26 ~09:10 ET, so orders before that moment are
 * already reflected in the seed and must never be applied again.
 */
import type { Express } from "express";
import { pool } from "./db";

const SYNC_SINCE = process.env.RP_ORDER_SYNC_SINCE || "2026-08-26T13:00:00Z";
const SYNC_EVERY_MS = 10 * 60_000;

function siteCfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}
function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  return token ? { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token } : null;
}

async function fetchSiteOrders(days: number): Promise<any[]> {
  const cfg = siteCfg();
  if (!cfg) throw new Error("site not configured");
  const r = await fetch(`${cfg.base}/api/ops-orders?days=${days}&limit=1000`, {
    headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`ops-orders ${r.status}`);
  const j = await r.json();
  return j.orders ?? [];
}

let lastSync: { at: string; applied: number; alreadyApplied: number; unmatched: string[]; error?: string } | null = null;

/** One sync pass: replay recent orders into the tracker (idempotent there). */
export async function runRpInventorySync(): Promise<typeof lastSync> {
  const tracker = trackerCfg();
  if (!tracker || !siteCfg()) return null;
  try {
    // 30 days so paid-but-unshipped holds stay visible until they ship or refund.
    const SYNC_DAYS = 30;
    const windowStart = new Date(Math.max(Date.now() - SYNC_DAYS * 86_400_000, Date.parse(SYNC_SINCE))).toISOString();
    const orders = (await fetchSiteOrders(SYNC_DAYS))
      .filter((o) => o.createdAt && o.createdAt >= SYNC_SINCE)
      .map((o) => ({ id: o.id, number: o.number, createdAt: o.createdAt, status: o.status, items: o.items }));
    if (!orders.length) return (lastSync = { at: new Date().toISOString(), applied: 0, alreadyApplied: 0, unmatched: [] });
    const r = await fetch(`${tracker.base}/api/orders/consume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tracker.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ orders, windowStart }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await r.text();
    let j: any;
    try { j = JSON.parse(raw); }
    catch { throw new Error(`consume ${r.status}: ${raw.replace(/<[^>]*>/g, " ").trim().slice(0, 120)}`); }
    if (!r.ok) throw new Error(j.error || `consume ${r.status}`);
    const applied = (j.held ?? 0) + (j.deducted ?? 0) + (j.applied ?? 0);
    lastSync = { at: new Date().toISOString(), applied, alreadyApplied: j.alreadyApplied, unmatched: j.unmatched ?? [] };
    if (applied || j.released) console.log(`[OPS][RP] inventory sync: ${j.held ?? 0} held, ${j.deducted ?? 0} deducted, ${j.released ?? 0} released${j.unmatched?.length ? `, unmatched: ${j.unmatched.join(" | ")}` : ""}`);
    return lastSync;
  } catch (e: any) {
    console.error("[OPS][RP] inventory sync:", e.message);
    lastSync = { at: new Date().toISOString(), applied: 0, alreadyApplied: 0, unmatched: [], error: e.message };
    return lastSync;
  }
}

export function startRpInventorySyncLoop() {
  if (!siteCfg() || !trackerCfg()) {
    console.log("[OPS][RP] inventory sync loop idle (site or tracker not configured)");
    return;
  }
  runRpInventorySync();
  setInterval(runRpInventorySync, SYNC_EVERY_MS);
  console.log(`[OPS][RP] inventory sync loop: every ${SYNC_EVERY_MS / 60000} min, orders since ${SYNC_SINCE}`);
}

// ─── Sales velocity for forecasting ────────────────────────────────

const WINDOW_CHOICES = [14, 28, 42, 56, 84]; // 2/4/6/8/12 weeks
let statsCache: { at: number; key: string; data: any } | null = null;

/**
 * Units sold per SKU across several trailing windows (site order items
 * name-matched via the tracker). One order fetch covers every window; weekly
 * velocity comes from the 28-day window (falling back to the widest asked).
 */
async function velocityBySku(windows: number[]) {
  const key = windows.join(",");
  if (statsCache && statsCache.key === key && Date.now() - statsCache.at < 10 * 60_000) return statsCache.data;
  const tracker = trackerCfg();
  if (!tracker) throw new Error("tracker not configured");
  const maxDays = Math.max(...windows);
  const orders = await fetchSiteOrders(maxDays);
  const cutoffs = windows.map((d) => ({ days: d, since: Date.now() - d * 86_400_000 }));

  const byName = new Map<string, Record<number, number>>();
  for (const o of orders) {
    const at = o.createdAt ? Date.parse(o.createdAt) : NaN;
    if (!Number.isFinite(at)) continue;
    for (const it of o.items ?? []) {
      const nameKey = String(it.sku || it.name || "").trim();
      if (!nameKey) continue;
      const buckets = byName.get(nameKey) ?? {};
      for (const c of cutoffs) if (at >= c.since) buckets[c.days] = (buckets[c.days] ?? 0) + Number(it.qty ?? 1);
      byName.set(nameKey, buckets);
    }
  }

  // Woo-era history (rp_sales_history, loaded 2026-09-04, ends at the 08-24
  // site launch) fills the windows the new site can't reach yet. Same matcher,
  // same buckets — one continuous demand timeline, no overlap by construction.
  try {
    const hist = await pool.query(
      `SELECT item_name, order_date, SUM(qty) AS qty
       FROM rp_sales_history
       WHERE order_date >= NOW() - ($1 || ' days')::interval
       GROUP BY item_name, order_date`, [maxDays]);
    for (const h of hist.rows) {
      const at = new Date(h.order_date).getTime();
      const buckets = byName.get(h.item_name) ?? {};
      for (const c of cutoffs) if (at >= c.since) buckets[c.days] = (buckets[c.days] ?? 0) + Number(h.qty);
      byName.set(h.item_name, buckets);
    }
  } catch (e: any) {
    console.warn("[OPS][RP] sales history blend skipped:", e.message);
  }

  const names = [...byName.keys()];
  const matches = new Map<string, string>();
  for (let i = 0; i < names.length; i += 150) {
    const r = await fetch(`${tracker.base}/api/skus/match`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tracker.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: names.slice(i, i + 150) }),
      signal: AbortSignal.timeout(30_000),
    }).then((x) => x.json());
    for (const m of r.matches ?? []) if (m.sku) matches.set(m.file, m.sku.sku_code);
  }

  const bySku: Record<string, { units: Record<number, number>; weekly: number }> = {};
  const unmatched: string[] = [];
  for (const [name, buckets] of byName) {
    const code = matches.get(name);
    if (!code) { unmatched.push(name); continue; }
    bySku[code] ??= { units: {}, weekly: 0 };
    for (const [d, n] of Object.entries(buckets)) {
      bySku[code].units[Number(d)] = (bySku[code].units[Number(d)] ?? 0) + n;
    }
  }
  const rateWindow = windows.includes(28) ? 28 : maxDays;
  for (const v of Object.values(bySku)) {
    v.weekly = Math.round(((v.units[rateWindow] ?? 0) / (rateWindow / 7)) * 10) / 10;
  }
  const data = { generatedAt: new Date().toISOString(), windows, bySku, unmatched };
  statsCache = { at: Date.now(), key, data };
  return data;
}

export function registerRpInventoryRoutes(app: Express) {
  /** Sales per SKU across trailing windows + last sync state, for the Inventory tab. */
  app.get("/api/ops/realpeptides/inventory-stats", async (req, res) => {
    try {
      if (!siteCfg()) return res.json({ configured: false, lastSync });
      const asked = String(req.query.windows || "28,56").split(",").map((n) => parseInt(n, 10));
      const windows = [...new Set(asked.filter((n) => WINDOW_CHOICES.includes(n)))];
      if (!windows.length) windows.push(28, 56);
      if (!windows.includes(28)) windows.push(28); // weekly velocity anchor
      res.json({ configured: true, lastSync, ...(await velocityBySku(windows.sort((a, b) => a - b))) });
    } catch (e: any) {
      res.json({ configured: true, lastSync, error: e.message, bySku: {} });
    }
  });

  /** Manual sync trigger (the loop also runs every 10 minutes). */
  app.post("/api/ops/realpeptides/inventory/sync", async (_req, res) => {
    const r = await runRpInventorySync();
    if (!r) return res.status(503).json({ error: "Site or tracker not configured" });
    res.json(r);
  });
}
