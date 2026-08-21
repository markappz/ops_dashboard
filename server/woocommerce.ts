/**
 * Real Peptides sales via the WooCommerce REST API (the live WordPress store).
 *
 * Uses WooCommerce Analytics (`wc-analytics/reports/*`) — server-side totals,
 * so a 2,400-order month is two requests, not 25 pages. Paging `wc/v3/orders`
 * silently truncated the previous window at the page cap (118 shown vs ~2,140
 * real) — don't go back to it for aggregates.
 *
 * Read-only key with *Read* permission:
 *   WP admin → WooCommerce → Settings → Advanced → REST API → Add key
 *   RP_WOO_CONSUMER_KEY=ck_…  RP_WOO_CONSUMER_SECRET=cs_…  (RP_WOO_URL optional)
 *
 * Until the key lands every caller gets `{ configured: false }` and the UI
 * shows the connect state — never a fabricated zero.
 */

export interface SalesWindow {
  revenue: number;      // net revenue: after coupons and refunds, before shipping/tax
  grossSales: number;
  orders: number;
  aov: number;
  customers: number;
  itemsSold: number;
  refunds: number;
  coupons: number;
}

export interface SalesSummary {
  configured: true;
  source: "woocommerce";
  range: number;
  current: SalesWindow;
  previous: SalesWindow;
  daily: { date: string; revenue: number; orders: number }[];
  topProducts: { name: string; units: number; revenue: number; orders: number }[];
  pending: number;
  fetchedAt: string;
}

const cache = new Map<number, { at: number; data: SalesSummary }>();
const CACHE_MS = 10 * 60_000;

function config() {
  const key = process.env.RP_WOO_CONSUMER_KEY;
  const secret = process.env.RP_WOO_CONSUMER_SECRET;
  if (!key || !secret) return null;
  return { base: (process.env.RP_WOO_URL || "https://www.realpeptides.co").replace(/\/$/, ""), key, secret };
}

export const wooConfigured = () => !!config();

async function woo<T = any>(path: string, params: Record<string, string>, head = false): Promise<{ body: T; headers: Headers }> {
  const cfg = config();
  if (!cfg) throw new Error("WooCommerce key not configured");
  const qs = new URLSearchParams(params);
  const r = await fetch(`${cfg.base}/wp-json/${path}?${qs}`, {
    method: head ? "HEAD" : "GET",
    headers: { Authorization: "Basic " + Buffer.from(`${cfg.key}:${cfg.secret}`).toString("base64"), "User-Agent": "FitScriptOps/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`WooCommerce ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { body: head ? (null as T) : ((await r.json()) as T), headers: r.headers };
}

const iso = (d: Date) => d.toISOString().slice(0, 19);
const r2 = (n: number) => +Number(n || 0).toFixed(2);

function toWindow(t: any): SalesWindow {
  return {
    revenue: r2(t.net_revenue), grossSales: r2(t.gross_sales), orders: Number(t.orders_count || 0),
    aov: r2(t.avg_order_value), customers: Number(t.total_customers || 0), itemsSold: Number(t.num_items_sold || 0),
    refunds: r2(t.refunds), coupons: r2(t.coupons),
  };
}

async function revenueStats(after: Date, before: Date) {
  const { body } = await woo<{ totals: any; intervals: any[] }>("wc-analytics/reports/revenue/stats", {
    after: iso(after), before: iso(before), interval: "day", per_page: "100",
  });
  return body;
}

export async function salesSummary(range: number): Promise<SalesSummary> {
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const now = new Date();
  const curStart = new Date(now.getTime() - range * 86400_000);
  const prevStart = new Date(now.getTime() - 2 * range * 86400_000);

  const [cur, prev, products, pendingHead] = await Promise.all([
    revenueStats(curStart, now),
    revenueStats(prevStart, curStart),
    woo<any[]>("wc-analytics/reports/products", { after: iso(curStart), before: iso(now), orderby: "net_revenue", order: "desc", per_page: "8", extended_info: "true" }),
    woo("wc/v3/orders", { after: iso(curStart), "status[]": "pending", per_page: "1" }, true).catch(() => null),
  ]);

  const data: SalesSummary = {
    configured: true, source: "woocommerce", range,
    current: toWindow(cur.totals), previous: toWindow(prev.totals),
    daily: (cur.intervals || []).map((i: any) => ({ date: String(i.date_start).slice(0, 10), revenue: r2(i.subtotals?.net_revenue), orders: Number(i.subtotals?.orders_count || 0) })).sort((a: any, b: any) => a.date.localeCompare(b.date)),
    topProducts: (products.body || []).map((p: any) => ({ name: p.extended_info?.name || `Product ${p.product_id}`, units: Number(p.items_sold || 0), revenue: r2(p.net_revenue), orders: Number(p.orders_count || 0) })),
    pending: Number(pendingHead?.headers.get("x-wp-total") || 0),
    fetchedAt: now.toISOString(),
  };
  cache.set(range, { at: Date.now(), data });
  return data;
}
