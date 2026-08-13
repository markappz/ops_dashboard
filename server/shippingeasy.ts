/**
 * Fulfilment status for pawgen orders.
 *
 * pawgen's site PUSHES paid orders into ShippingEasy fire-and-forget, and our
 * `fulfillment_status` only changes when ShippingEasy calls the shipment webhook
 * back. So a push that failed and an order merely awaiting shipment look
 * identical in our data: "unfulfilled" forever. This tells them apart.
 *
 * It asks pawgen rather than ShippingEasy directly. pawgen already holds the
 * ShippingEasy credentials to do the push; copying them here would mean two
 * systems to keep in sync and a regenerated key silently breaking order flow.
 * One shared bearer token instead of three replicated secrets.
 *
 * Needs PAWGEN_OPS_TOKEN (and optionally PAWGEN_OPS_URL, default
 * https://pawgen.com). Unset → every order reports `unconfigured` and the UI
 * shows "—" instead of erroring.
 */

const DEFAULT_BASE = "https://pawgen.com";

function baseUrl(): string {
  return (process.env.PAWGEN_OPS_URL || DEFAULT_BASE).replace(/\/+$/, "");
}
function token(): string {
  return process.env.PAWGEN_OPS_TOKEN ?? "";
}

export function isShippingEasyConfigured(): boolean {
  return Boolean(token());
}

export type SeStatus =
  | { state: "unconfigured" }
  | { state: "error"; message: string }
  | { state: "missing" }
  | { state: "present"; seStatus: string | null; seOrderId: string | null; trackingNumber: string | null };

/**
 * Verdict per order id. Never throws — a pawgen or ShippingEasy outage must not
 * take down the orders tab, and must never be reported as "missing", which would
 * wrongly imply the order never reached fulfilment.
 */
export async function statusForOrderIds(ids: string[]): Promise<Record<string, SeStatus>> {
  const out: Record<string, SeStatus> = {};
  if (ids.length === 0) return out;

  if (!isShippingEasyConfigured()) {
    for (const id of ids) out[id] = { state: "unconfigured" };
    return out;
  }

  try {
    const res = await fetch(`${baseUrl()}/api/ops/fulfillment-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token()}`,
      },
      body: JSON.stringify({ orderIds: ids }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    if (!res.ok) {
      let msg = `pawgen fulfilment lookup ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j?.error) msg = j.error;
      } catch {
        /* keep the status-code message */
      }
      throw new Error(msg);
    }

    const data = JSON.parse(text) as {
      configured?: boolean;
      statuses?: Record<string, SeStatus>;
    };

    if (data.configured === false) {
      for (const id of ids) out[id] = { state: "unconfigured" };
      return out;
    }

    for (const id of ids) {
      out[id] = data.statuses?.[id] ?? { state: "missing" };
    }
    return out;
  } catch (e: any) {
    const message = e?.name === "TimeoutError" ? "pawgen fulfilment lookup timed out" : e?.message ?? "lookup failed";
    console.error("[OPS fulfilment]", message);
    for (const id of ids) out[id] = { state: "error", message };
    return out;
  }
}
