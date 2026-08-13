import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageHero } from "../components/page-hero";

interface PawgenOrder {
  id: string;
  order_no?: number | null;
  created_at: string;
  source: "stripe" | "nowpayments";
  method: "card" | "crypto";
  payment_status: string;
  amount_usd: number;
  pack_id: string;
  pack_label: string;
  quantity: number;
  bac_addon_qty: number;
  customer_name: string | null;
  customer_email: string | null;
  fulfillment_status: string;
  tracking_number: string | null;
  carrier: string | null;
  // What ShippingEasy itself reports for this order — distinguishes "waiting to
  // be shipped" from "never made it into fulfilment at all".
  shipping_easy?:
    | { state: "unconfigured" }
    | { state: "error"; message: string }
    | { state: "missing" }
    | { state: "present"; seStatus: string | null; seOrderId: string | null; trackingNumber: string | null };
}

// Every field is optional: an error response (503 "not connected", 500) carries
// only `error`, and the fetch below resolves it like any other body. Optional
// fields make the compiler force a guard at each read.
interface OrdersResponse {
  orders?: PawgenOrder[];
  stats?: { paidOrders: number; revenue: number; refunded: number; toFulfill: number };
  statuses?: Record<string, number>;
  pagination?: { page: number; limit: number; total: number; pages: number };
  shippingEasyConfigured?: boolean;
  error?: string;
}

function SeCell({ se }: { se: PawgenOrder["shipping_easy"] }) {
  if (!se || se.state === "unconfigured") return <span className="text-ops-text-muted">—</span>;
  if (se.state === "error") return <span className="text-yellow-500" title={se.message}>check failed</span>;
  if (se.state === "missing") {
    return (
      <span className="rounded px-2 py-0.5 text-xs font-medium bg-red-500/15 text-red-400" title="This order was never found in ShippingEasy — the push most likely failed.">
        not in ShippingEasy
      </span>
    );
  }
  return (
    <span className="text-ops-text-muted" title={se.seOrderId ? `ShippingEasy order ${se.seOrderId}` : undefined}>
      {(se.seStatus ?? "in ShippingEasy").replace(/_/g, " ")}
    </span>
  );
}

function Badge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    paid: "bg-fitscript-green/15 text-fitscript-green",
    pending: "bg-yellow-500/15 text-yellow-400",
    refunded: "bg-red-500/15 text-red-400",
    unfulfilled: "bg-ops-text-muted/15 text-ops-text-muted",
    processing: "bg-blue-500/15 text-blue-400",
    shipped: "bg-purple-500/15 text-purple-400",
    delivered: "bg-fitscript-green/15 text-fitscript-green",
    cancelled: "bg-red-500/15 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || "bg-ops-border text-ops-text-muted"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-4 shadow-card">
      <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-bold text-ops-text">{value}</div>
    </div>
  );
}

function RefundPanel({ order, onDone }: { order: PawgenOrder; onDone: () => void }) {
  const [partial, setPartial] = useState("");
  const [reason, setReason] = useState("requested_by_customer");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);

  const isCrypto = order.source !== "stripe";

  const doRefund = async () => {
    const amt = partial.trim() ? Number(partial) : null;
    const label = amt ? `$${amt.toFixed(2)} (partial)` : `$${order.amount_usd.toFixed(2)} (full)`;
    if (!confirm(`Refund ${label} to ${order.customer_email || "customer"}?`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/ops/pawgen/orders/${order.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt, reason }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.manual) {
        setFeedback({ type: "info", msg: data.message });
        return;
      }
      setFeedback({ type: "success", msg: `Refunded $${data.amount.toFixed(2)} (${data.mode}).` });
      setTimeout(onDone, 1200);
    } catch (e: any) {
      setFeedback({ type: "error", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-ops-border px-5 py-4 bg-ops-bg/50">
      {feedback && (
        <div
          className={`mb-3 px-3 py-2 rounded text-sm ${
            feedback.type === "success"
              ? "bg-fitscript-green/15 text-fitscript-green"
              : feedback.type === "info"
                ? "bg-yellow-500/15 text-yellow-400"
                : "bg-red-500/15 text-red-400"
          }`}
        >
          {feedback.msg}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="text-sm text-ops-text-muted">
          <div>
            Paid <span className="text-ops-text font-medium">${order.amount_usd.toFixed(2)}</span> by{" "}
            {order.method === "crypto" ? "crypto" : "card"}
          </div>
          {order.tracking_number && (
            <div className="text-xs mt-0.5">
              Tracking: {order.carrier ? `${order.carrier} ` : ""}
              {order.tracking_number}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <span className="text-ops-text-muted text-sm">$</span>
          <input
            type="number"
            placeholder="Full"
            value={partial}
            onChange={(e) => setPartial(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text w-24"
          />
        </div>

        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text"
        >
          <option value="requested_by_customer">Requested by customer</option>
          <option value="duplicate">Duplicate</option>
          <option value="fraudulent">Fraudulent</option>
        </select>

        <button
          onClick={doRefund}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
        >
          {busy ? "Refunding…" : isCrypto ? "Refund (crypto — manual)" : partial.trim() ? "Refund partial" : "Refund full"}
        </button>
      </div>
      <p className="text-xs text-ops-text-muted mt-2">
        Full refund reverses the customer&apos;s earned points and restores any points they redeemed. Leave the amount
        blank for a full refund.
      </p>
    </div>
  );
}

interface ReferralSource {
  source: string;
  orders: number;
  paidOrders: number;
  revenue: number;
  lastOrderAt: string | null;
  clicks: number | null;      // null until db/partner_links.sql is run on pawgen
  conversion: number | null;  // paid orders / clicks, %
}
interface ReferralsResponse {
  sources?: ReferralSource[];
  clicksTracked?: boolean;
  error?: string;
}

/** Traffic + revenue by first-touch source. Partner links land here. */
function Referrals() {
  const { data, isLoading } = useQuery<ReferralsResponse>({
    queryKey: ["pawgen-referrals"],
    queryFn: async () => {
      const res = await fetch("/api/ops/pawgen/referrals");
      try {
        return (await res.json()) as ReferralsResponse;
      } catch {
        return { error: `Referrals request failed (HTTP ${res.status})` };
      }
    },
  });

  const sources = data?.sources ?? [];
  const money = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card mb-6 overflow-hidden">
      <div className="flex items-baseline justify-between px-5 py-3 border-b border-ops-border">
        <h2 className="text-sm font-semibold text-ops-text">Where orders come from</h2>
        <span className="text-xs text-ops-text-muted">first-touch attribution</span>
      </div>

      {data?.error && (
        <div className="px-5 py-3 text-sm text-red-400">{data.error}</div>
      )}

      {isLoading ? (
        <div className="px-5 py-8 text-center">
          <div className="w-5 h-5 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : !sources.length ? (
        <div className="px-5 py-8 text-center text-sm text-ops-text-muted">No orders yet</div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-ops-border">
              <th className="text-left px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Source</th>
              <th className="text-right px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Clicks</th>
              <th className="text-right px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Orders</th>
              <th className="text-right px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Paid</th>
              <th className="text-right px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Conv.</th>
              <th className="text-right px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Revenue</th>
              <th className="text-left px-5 py-2 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Last order</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.source} className="border-t border-ops-border">
                <td className="px-5 py-2.5 text-sm">
                  {s.source === "(direct)" ? (
                    <span className="text-ops-text-muted" title="Direct traffic, plus every order placed before attribution existed">
                      direct / untagged
                    </span>
                  ) : (
                    <span className="text-fitscript-green font-medium">{s.source}</span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right text-sm text-ops-text-muted">
                  {s.clicks === null ? "—" : s.clicks.toLocaleString()}
                </td>
                <td className="px-5 py-2.5 text-right text-sm text-ops-text">{s.orders}</td>
                <td className="px-5 py-2.5 text-right text-sm text-ops-text-muted">{s.paidOrders}</td>
                <td className="px-5 py-2.5 text-right text-sm text-ops-text-muted">
                  {s.conversion === null ? "—" : `${s.conversion}%`}
                </td>
                <td className="px-5 py-2.5 text-right text-sm font-medium text-ops-text">{money(s.revenue)}</td>
                <td className="px-5 py-2.5 text-sm text-ops-text-muted">
                  {s.lastOrderAt ? new Date(s.lastOrderAt).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!isLoading && sources.length > 0 && data?.clicksTracked === false && (
        <div className="px-5 py-2.5 text-xs text-ops-text-muted border-t border-ops-border">
          Click counts need <code>db/partner_links.sql</code> run on the pawgen database — until then
          partner links still work, they just aren&apos;t counted.
        </div>
      )}
    </div>
  );
}

const FILTERS = ["all", "unfulfilled", "processing", "shipped", "delivered", "cancelled"];

export default function PawgenOrders() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery<OrdersResponse>({
    queryKey: ["pawgen-orders", page, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/ops/pawgen/orders?${params}`);
      try {
        return (await res.json()) as OrdersResponse;
      } catch {
        return { error: `Orders request failed (HTTP ${res.status})` };
      }
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["pawgen-orders"] });
  };

  const stats = data?.stats;

  return (
    <div>
      <PageHero eyebrow="pawgen" title="Orders" subtitle="K9-REPAIR orders, fulfillment status, and refunds." />

      {data?.error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <div className="font-medium">pawgen orders unavailable</div>
          <div className="mt-0.5 opacity-90">{data.error}</div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Revenue (paid)" value={stats ? `$${stats.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"} />
        <StatCard label="Paid orders" value={stats?.paidOrders ?? "—"} />
        <StatCard label="To fulfill" value={stats?.toFulfill ?? "—"} />
        <StatCard label="Refunded" value={stats?.refunded ?? "—"} />
      </div>

      <Referrals />

      <div className="mb-4">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="bg-ops-surface border border-ops-border rounded-lg px-4 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f === "all" ? "All statuses" : f.charAt(0).toUpperCase() + f.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-x-auto shadow-card">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b border-ops-border">
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Order</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Customer</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Pack</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Payment</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Fulfillment</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">ShippingEasy</th>
              <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Amount</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Date</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center">
                  <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
                </td>
              </tr>
            ) : !data?.orders?.length ? (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-sm text-ops-text-muted">
                  {data?.error ? "Not connected — no orders to show" : "No orders found"}
                </td>
              </tr>
            ) : (
              data.orders.map((o) => (
                <Fragment key={o.id}>
                  <tr
                    key={o.id}
                    className={`border-t border-ops-border hover:bg-ops-surface-hover transition-colors cursor-pointer ${expanded === o.id ? "bg-ops-surface-hover" : ""}`}
                    onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                  >
                    <td className="px-5 py-3 text-sm font-mono text-fitscript-green" title={o.id}>
                      {o.order_no ? `PG-${o.order_no}` : `PG-${o.id.slice(0, 8)}`}
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-sm text-ops-text">{o.customer_name || "—"}</div>
                      <div className="text-xs text-ops-text-muted">{o.customer_email || "—"}</div>
                    </td>
                    <td className="px-5 py-3 text-sm text-ops-text-muted">
                      {o.pack_label}
                      {o.bac_addon_qty > 0 ? ` · +${o.bac_addon_qty} BAC` : ""}
                    </td>
                    <td className="px-5 py-3">
                      <Badge status={o.payment_status} />{" "}
                      <span className="text-xs text-ops-text-muted">{o.method}</span>
                    </td>
                    <td className="px-5 py-3"><Badge status={o.fulfillment_status} /></td>
                    <td className="px-5 py-3 text-sm"><SeCell se={o.shipping_easy} /></td>
                    <td className="px-5 py-3 text-right text-sm font-medium text-ops-text">${o.amount_usd.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm text-ops-text-muted">{new Date(o.created_at).toLocaleDateString()}</td>
                    <td className="px-5 py-3 text-right">
                      <svg
                        className={`w-4 h-4 text-ops-text-muted transition-transform ${expanded === o.id ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </td>
                  </tr>
                  {expanded === o.id && (
                    <tr key={`${o.id}-actions`}>
                      <td colSpan={8} className="p-0">
                        {o.payment_status === "paid" ? (
                          <RefundPanel order={o} onDone={() => { setExpanded(null); invalidate(); }} />
                        ) : (
                          <div className="border-t border-ops-border px-5 py-4 bg-ops-bg/50 text-sm text-ops-text-muted">
                            {o.payment_status === "refunded" ? "This order was refunded." : `Payment ${o.payment_status} — nothing to refund.`}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data?.pagination && data.pagination.pages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-ops-text-muted">Page {data.pagination.page} of {data.pagination.pages}</div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm bg-ops-surface border border-ops-border rounded-lg text-ops-text-muted hover:text-ops-text disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= (data.pagination?.pages ?? 1)}
              className="px-3 py-1.5 text-sm bg-ops-surface border border-ops-border rounded-lg text-ops-text-muted hover:text-ops-text disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
