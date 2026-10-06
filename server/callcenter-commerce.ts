/**
 * Call Center → Real Peptides commerce adapters.
 *
 * Ops owns NO commerce data. Sources, in authority order:
 *  - Public catalog/pricing: the storefront's public /api/search (live public
 *    prices + stock — exactly what an agent may quote to an unverified caller).
 *  - Orders: the site's token-gated /api/ops-orders feed (RP_SITE_API_URL +
 *    RP_SITE_OPS_TOKEN), minimal fields only, gated behind verification.
 *  - Wholesale: the site's /api/ops-wholesale feed (existing quotes/orders).
 * Internal costs, margins and negotiated prices never pass through here.
 */

const PUBLIC_SITE = (process.env.RP_PUBLIC_SITE_URL || "https://www.realpeptides.co").replace(/\/$/, "");

function siteCfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

export interface CatalogVariant {
  variantId: string;
  sku: string;
  label: string;
  price: string;           // public price, dollars
  listPrice: string | null;
  discountName: string | null;
  stock: number | null;
  packEligible: boolean;
}
export interface CatalogProduct {
  productId: string;
  name: string;
  slug: string;
  url: string;
  coaUrl: string;
  categories: string[];
  variants: CatalogVariant[];
  checkedAt: string;
  source: "site-search";
}

/* ---------------- product name matching ---------------- */

/** Transcription fixes the voice agents actually hit. Keys are normalized. */
const PRODUCT_ALIASES: Record<string, string> = {
  bromatane: "bromantane", bromontane: "bromantane", bromantaine: "bromantane",
  "bpc157": "bpc-157", "bpc 157": "bpc-157",
  "tb500": "tb-500", "tb 500": "tb-500",
  semax: "semax", selank: "selank",
  epitalon: "epithalon", epitalone: "epithalon",
  "nad plus": "nad+", "nad +": "nad+",
};

export function normalizeProductQuery(raw: string): string {
  let q = String(raw ?? "").trim().toLowerCase();
  // "b r o m a n t a n e" (letter-by-letter spelling) → "bromantane"
  if (/^(?:[a-z0-9][\s.-]+){3,}[a-z0-9]$/.test(q)) q = q.replace(/[\s.-]+/g, "");
  q = q.replace(/\s+/g, " ");
  return PRODUCT_ALIASES[q] ?? PRODUCT_ALIASES[q.replace(/[^a-z0-9 ]/g, "")] ?? q;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/* ---------------- catalog via public search ---------------- */

const searchCache = new Map<string, { at: number; products: CatalogProduct[] }>();
const byIdCache = new Map<string, { at: number; product: CatalogProduct }>();
const SEARCH_TTL = 2 * 60_000;
let catalogLastOk: string | null = null;
let catalogLastError: string | null = null;

function mapProduct(p: any): CatalogProduct {
  return {
    productId: String(p.id),
    name: String(p.name),
    slug: String(p.slug),
    url: `${PUBLIC_SITE}/products/${p.slug}/`,
    coaUrl: `${PUBLIC_SITE}/coas/`,
    categories: (p.categories ?? []).map((c: any) => String(c.name)),
    variants: (p.variants ?? []).map((v: any) => ({
      variantId: String(v.id),
      sku: String(v.sku ?? ""),
      label: String(v.label ?? ""),
      price: String(v.price ?? ""),
      listPrice: v.listPrice != null ? String(v.listPrice) : null,
      discountName: v.discountName ?? null,
      stock: Number.isFinite(Number(v.stock)) ? Number(v.stock) : null,
      packEligible: !!v.packEligible,
    })),
    checkedAt: new Date().toISOString(),
    source: "site-search",
  };
}

async function rawSearch(q: string): Promise<CatalogProduct[]> {
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.products;
  const r = await fetch(`${PUBLIC_SITE}/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`site search ${r.status}`);
  const j = await r.json();
  const products: CatalogProduct[] = (j.products ?? []).map(mapProduct);
  searchCache.set(key, { at: Date.now(), products });
  for (const p of products) {
    byIdCache.set(p.productId, { at: Date.now(), product: p });
    for (const v of p.variants) byIdCache.set(v.variantId, { at: Date.now(), product: p });
  }
  catalogLastOk = new Date().toISOString();
  catalogLastError = null;
  return products;
}

export interface SearchOutcome {
  status: "ok" | "not_found" | "ambiguous" | "unavailable";
  products: CatalogProduct[];
  correctedQuery?: string;
}

export async function searchProducts(rawQuery: string): Promise<SearchOutcome> {
  const corrected = normalizeProductQuery(rawQuery);
  try {
    let products = await rawSearch(corrected);
    if (!products.length && corrected !== rawQuery.toLowerCase().trim()) products = await rawSearch(rawQuery.trim());
    if (!products.length) {
      // last resort: fuzzy against the site's own product names via a broad probe
      const first = corrected.replace(/[^a-z0-9]/g, "").slice(0, 4);
      if (first.length >= 3) {
        const broad = await rawSearch(first);
        products = broad.filter((p) => editDistance(p.name.toLowerCase().replace(/[^a-z0-9]/g, ""), corrected.replace(/[^a-z0-9]/g, "")) <= 2);
      }
    }
    if (!products.length) return { status: "not_found", products: [], correctedQuery: corrected };
    if (products.length > 6) return { status: "ambiguous", products: products.slice(0, 6), correctedQuery: corrected };
    return { status: "ok", products, correctedQuery: corrected !== rawQuery.trim().toLowerCase() ? corrected : undefined };
  } catch (e: any) {
    catalogLastError = e.message;
    return { status: "unavailable", products: [] };
  }
}

export async function getProductById(id: string): Promise<CatalogProduct | null> {
  const hit = byIdCache.get(id);
  if (hit && Date.now() - hit.at < SEARCH_TTL * 5) {
    // refresh price in the background when stale-ish but still serve fast
    return hit.product;
  }
  return null; // caller should re-search by name; IDs come from a prior search
}

export function catalogHealth() {
  return { lastOk: catalogLastOk, lastError: catalogLastError, source: `${PUBLIC_SITE}/api/search` };
}

/* ---------------- orders (verified access only) ---------------- */

let ordersCache: { at: number; orders: any[] } | null = null;
const ORDERS_TTL = 5 * 60_000;

async function siteOrders(): Promise<any[]> {
  const c = siteCfg();
  if (!c) throw new Error("RP site feed not configured (RP_SITE_API_URL / RP_SITE_OPS_TOKEN)");
  if (ordersCache && Date.now() - ordersCache.at < ORDERS_TTL) return ordersCache.orders;
  const r = await fetch(`${c.base}/api/ops-orders?days=365&limit=1000`, {
    headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`ops-orders ${r.status}`);
  const j = await r.json();
  ordersCache = { at: Date.now(), orders: j.orders ?? [] };
  return ordersCache.orders;
}

export interface OrderLookup {
  found: boolean;
  order?: {
    reference: string;
    createdAt: string;
    status: string;              // the site's own OrderStatus vocabulary
    items: Array<{ name: string; qty: number }>;
    trackingNumber?: string | null;
    trackingCarrier?: string | null;
    email?: string | null;       // internal: verification routing only — never returned to callers
  };
}

/** Internal lookup — callers of this function MUST hold a verification grant
 *  before any of it reaches a caller (except the email, which is only used to
 *  route a verification challenge and is never spoken). */
export async function findOrder(ref: string | null, email?: string | null): Promise<OrderLookup> {
  const orders = await siteOrders();
  const wanted = String(ref ?? "").replace(/[^a-z0-9#-]/gi, "").toLowerCase();
  const mail = email?.toLowerCase() ?? null;
  const match = orders.find((o) => {
    const num = String(o.number ?? o.id ?? "").toLowerCase();
    if (wanted && (num === wanted || num === wanted.replace(/^#/, ""))) return true;
    if (!wanted && mail && String(o.email ?? "").toLowerCase() === mail) return true;
    return false;
  });
  if (!match) return { found: false };
  return {
    found: true,
    order: {
      reference: String(match.number ?? match.id),
      createdAt: String(match.createdAt ?? ""),
      status: String(match.status ?? "unknown"),
      items: (match.items ?? []).map((i: any) => ({ name: String(i.name ?? i.sku ?? "item"), qty: Number(i.qty ?? 1) })),
      trackingNumber: match.trackingNumber ?? null,
      trackingCarrier: match.trackingCarrier ?? null,
      email: match.email ?? null,
    },
  };
}

/* ---------------- wholesale ---------------- */

let wholesaleCache: { at: number; rows: any[] } | null = null;

async function wholesaleRows(): Promise<any[]> {
  const c = siteCfg();
  if (!c) return [];
  if (wholesaleCache && Date.now() - wholesaleCache.at < ORDERS_TTL) return wholesaleCache.rows;
  const r = await fetch(`${c.base}/api/ops-wholesale?days=365`, {
    headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`ops-wholesale ${r.status}`);
  const j = await r.json();
  const rows = j.orders ?? j.inquiries ?? j.rows ?? [];
  wholesaleCache = { at: Date.now(), rows };
  return rows;
}

export interface WholesaleMatch { ref: string; status: string; contactName: string | null; repName: string | null }

/** A caller with an existing quote/order is linked, never re-entered as a new lead. */
export async function findWholesaleMatch(by: { phone?: string | null; email?: string | null; business?: string | null }): Promise<WholesaleMatch | null> {
  const rows = await wholesaleRows();
  const phone = (by.phone ?? "").replace(/\D/g, "").slice(-10);
  const email = (by.email ?? "").toLowerCase() || null;
  const match = rows.find((w: any) => {
    if (email && String(w.contactEmail ?? "").toLowerCase() === email) return true;
    if (phone && String(w.contactPhone ?? "").replace(/\D/g, "").slice(-10) === phone) return true;
    return false;
  });
  if (!match) return null;
  return {
    ref: String(match.ref ?? match.id),
    status: String(match.status ?? ""),
    contactName: match.contactName ?? null,
    repName: match.repName ?? null,
  };
}

export function commerceHealth() {
  return {
    site: siteCfg() ? "configured" : "disconnected",
    catalog: catalogHealth(),
    ordersCacheAt: ordersCache ? new Date(ordersCache.at).toISOString() : null,
    wholesaleCacheAt: wholesaleCache ? new Date(wholesaleCache.at).toISOString() : null,
  };
}
