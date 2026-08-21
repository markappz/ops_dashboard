/**
 * Real Peptides sales via the WooCommerce REST API (the live WordPress store).
 *
 * Read-only. Needs a WooCommerce API key with *Read* permission:
 *   WP admin → WooCommerce → Settings → Advanced → REST API → Add key
 *   RP_WOO_CONSUMER_KEY=ck_…  RP_WOO_CONSUMER_SECRET=cs_…  (RP_WOO_URL optional)
 *
 * Until the key lands every caller gets `{ configured: false }` and the UI shows
 * the connect state — never a fabricated zero. When the new Vercel site goes
 * live, sales move to its Supabase (RP_DATABASE_URL) and this becomes the
 * historical source.
 */

interface WooOrder {
  id: number;
  status: string;
  total: string;
  date_created_gmt: string;
  billing?: { email?: string };
  line_items?: { name: string; product_id: number; quantity: number; total: string }[];
}

export interface SalesWindow {
  revenue: number;
  orders: number;
  aov: number;
  customers: number;
}

export interface SalesSummary {
  configured: true;
  source: "woocommerce";
  range: number;
  current: SalesWindow;
  previous: SalesWindow;
  daily: { date: string; revenue: number; orders: number }[];
  topProducts: { name: string; units: number; revenue: number }[];
  pending: number;
  fetchedAt: string;
}

const PAID = new Set(["completed", "processing"]);
const cache = new Map<number, { at: number; data: SalesSummary }>();
const CACHE_MS = 10 * 60_000;

function config() {
  const key = process.env.RP_WOO_CONSUMER_KEY;
  const secret = process.env.RP_WOO_CONSUMER_SECRET;
  if (!key || !secret) return null;
  return { base: (process.env.RP_WOO_URL || "https://www.realpeptides.co").replace(/\/$/, ""), key, secret };
}

export const wooConfigured = () => !!config();

async function fetchOrders(after: Date): Promise<WooOrder[]> {
  const cfg = config();
  if (!cfg) throw new Error("WooCommerce key not configured");
  const auth = "Basic " + Buffer.from(`${cfg.key}:${cfg.secret}`).toString("base64");
  const out: WooOrder[] = [];
  for (let page = 1; page <= 30; page++) {
    const qs = new URLSearchParams({ after: after.toISOString(), per_page: "100", page: String(page), status: "any", orderby: "date", order: "desc" });
    const r = await fetch(`${cfg.base}/wp-json/wc/v3/orders?${qs}`, {
      headers: { Authorization: auth, "User-Agent": "FitScriptOps/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`WooCommerce ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const batch = (await r.json()) as WooOrder[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function summarize(orders: WooOrder[]): SalesWindow {
  const paid = orders.filter((o) => PAID.has(o.status));
  const revenue = paid.reduce((s, o) => s + Number(o.total || 0), 0);
  const customers = new Set(paid.map((o) => (o.billing?.email || String(o.id)).toLowerCase())).size;
  return { revenue: +revenue.toFixed(2), orders: paid.length, aov: paid.length ? +(revenue / paid.length).toFixed(2) : 0, customers };
}

export async function salesSummary(range: number): Promise<SalesSummary> {
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const now = Date.now();
  const curStart = new Date(now - range * 86400_000);
  const prevStart = new Date(now - 2 * range * 86400_000);
  const orders = await fetchOrders(prevStart);
  const cur = orders.filter((o) => new Date(o.date_created_gmt + "Z") >= curStart);
  const prev = orders.filter((o) => new Date(o.date_created_gmt + "Z") < curStart);

  const byDay = new Map<string, { revenue: number; orders: number }>();
  for (let i = range - 1; i >= 0; i--) byDay.set(new Date(now - i * 86400_000).toISOString().slice(0, 10), { revenue: 0, orders: 0 });
  const products = new Map<string, { name: string; units: number; revenue: number }>();
  for (const o of cur) {
    if (!PAID.has(o.status)) continue;
    const d = byDay.get(o.date_created_gmt.slice(0, 10));
    if (d) { d.revenue += Number(o.total || 0); d.orders += 1; }
    for (const li of o.line_items || []) {
      const p = products.get(li.name) || { name: li.name, units: 0, revenue: 0 };
      p.units += li.quantity; p.revenue += Number(li.total || 0);
      products.set(li.name, p);
    }
  }

  const data: SalesSummary = {
    configured: true, source: "woocommerce", range,
    current: summarize(cur), previous: summarize(prev),
    daily: [...byDay.entries()].map(([date, v]) => ({ date, revenue: +v.revenue.toFixed(2), orders: v.orders })),
    topProducts: [...products.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8).map((p) => ({ ...p, revenue: +p.revenue.toFixed(2) })),
    pending: cur.filter((o) => o.status === "pending" || o.status === "on-hold").length,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(range, { at: Date.now(), data });
  return data;
}
