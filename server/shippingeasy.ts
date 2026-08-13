/**
 * ShippingEasy read client for the ops dashboard.
 *
 * pawgen's site PUSHES paid orders into ShippingEasy fire-and-forget
 * (`push(...).catch(console.error)`), and our `fulfillment_status` only ever
 * changes when ShippingEasy calls the shipment webhook back. So a push that
 * failed, or a webhook that never arrived, both look identical in our DB:
 * "unfulfilled" forever, with nothing to distinguish "waiting to be shipped"
 * from "never reached fulfilment at all".
 *
 * This reads the truth back out of ShippingEasy so the dashboard can tell those
 * apart. Signing matches pawgen's lib/shippingeasy.server.ts exactly — HMAC-SHA256
 * over METHOD&path&sorted-params&body, with the signature appended afterwards.
 *
 * Needs SHIPPINGEASY_API_KEY / _API_SECRET / _STORE_API_KEY. Unset → every call
 * reports `configured: false` and the UI degrades instead of erroring.
 */
import crypto from "crypto";

const BASE_URL = "https://app.shippingeasy.com";

const API_KEY = () => process.env.SHIPPINGEASY_API_KEY;
const API_SECRET = () => process.env.SHIPPINGEASY_API_SECRET;
const STORE_API_KEY = () => process.env.SHIPPINGEASY_STORE_API_KEY;

export function isShippingEasyConfigured(): boolean {
  return Boolean(API_KEY() && API_SECRET() && STORE_API_KEY());
}

function sign(method: string, path: string, params: Record<string, string>, body: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHmac("sha256", API_SECRET()!)
    .update([method.toUpperCase(), path, sorted, body || ""].join("&"))
    .digest("hex");
}

async function get<T>(path: string, extraParams: Record<string, string> = {}): Promise<T> {
  const params: Record<string, string> = {
    ...extraParams,
    api_key: API_KEY()!,
    api_timestamp: Math.floor(Date.now() / 1000).toString(),
  };
  // Signature covers every other param, so it must be computed before being added.
  params.api_signature = sign("GET", path, params, "");
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");

  const res = await fetch(`${BASE_URL}${path}?${query}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ShippingEasy API ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export type SeOrder = {
  externalId: string | null;
  seOrderId: string | null;
  status: string | null;
  trackingNumber: string | null;
  orderedAt: string | null;
};

type SeOrdersResponse = {
  orders?: Array<Record<string, any>>;
  meta?: { total_pages?: number; current_page?: number };
};

/**
 * Recent orders from the store, keyed by the external identifier we set on push
 * (pawgen's Supabase order UUID). Paged because a busy store will exceed one page
 * and a missing order is exactly what we're trying to detect — stopping early
 * would manufacture false "not in ShippingEasy" results.
 */
export async function fetchSeOrders(maxPages = 5): Promise<Map<string, SeOrder>> {
  const byExternalId = new Map<string, SeOrder>();
  const path = `/api/stores/${STORE_API_KEY()}/orders`;

  for (let page = 1; page <= maxPages; page++) {
    const data = await get<SeOrdersResponse>(path, { page: String(page), per_page: "100" });
    const orders = data.orders ?? [];
    for (const o of orders) {
      const externalId =
        o.external_order_identifier ?? o.external_order_id ?? o.order_number ?? null;
      if (!externalId) continue;
      byExternalId.set(String(externalId), {
        externalId: String(externalId),
        seOrderId: o.id != null ? String(o.id) : null,
        status: o.status ?? o.order_status ?? null,
        trackingNumber: o.tracking_number ?? null,
        orderedAt: o.ordered_at ?? null,
      });
    }
    const totalPages = data.meta?.total_pages ?? 1;
    if (orders.length === 0 || page >= totalPages) break;
  }

  return byExternalId;
}

/** Shape used by the dashboard: what ShippingEasy says about one of our orders. */
export type SeStatus =
  | { state: "unconfigured" }
  | { state: "error"; message: string }
  | { state: "missing" }
  | { state: "present"; seStatus: string | null; seOrderId: string | null; trackingNumber: string | null };

/**
 * Look up many of our order ids at once. Returns a per-id verdict, and never
 * throws — a ShippingEasy outage must not take down the orders tab.
 */
export async function statusForOrderIds(ids: string[]): Promise<Record<string, SeStatus>> {
  const out: Record<string, SeStatus> = {};
  if (!isShippingEasyConfigured()) {
    for (const id of ids) out[id] = { state: "unconfigured" };
    return out;
  }
  try {
    const map = await fetchSeOrders();
    for (const id of ids) {
      const hit = map.get(id);
      out[id] = hit
        ? { state: "present", seStatus: hit.status, seOrderId: hit.seOrderId, trackingNumber: hit.trackingNumber }
        : { state: "missing" };
    }
  } catch (e: any) {
    const message = e?.message ?? "ShippingEasy request failed";
    console.error("[OPS shippingeasy]", message);
    for (const id of ids) out[id] = { state: "error", message };
  }
  return out;
}
