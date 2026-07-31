import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHero } from "../components/page-hero";

interface PawgenOrder {
  id: string;
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
}

interface OrdersResponse {
  orders: PawgenOrder[];
  stats: { paidOrders: number; revenue: number; refunded: number; toFulfill: number };
  statuses: Record<string, number>;
  pagination: { page: number; limit: number; total: number; pages: number };
  error?: string;
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

const FILTERS = ["all", "unfulfilled", "processing", "shipped", "delivered", "cancelled"];

export default function PawgenOrders() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery<OrdersResponse>({
    queryKey: ["pawgen-orders", page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      return fetch(`/api/ops/pawgen/orders?${params}`).then((r) => r.json());
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
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{data.error}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Revenue (paid)" value={stats ? `$${stats.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"} />
        <StatCard label="Paid orders" value={stats?.paidOrders ?? "—"} />
        <StatCard label="To fulfill" value={stats?.toFulfill ?? "—"} />
        <StatCard label="Refunded" value={stats?.refunded ?? "—"} />
      </div>

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
                <td colSpan={8} className="px-5 py-12 text-center text-sm text-ops-text-muted">No orders found</td>
              </tr>
            ) : (
              data.orders.map((o) => (
                <>
                  <tr
                    key={o.id}
                    className={`border-t border-ops-border hover:bg-ops-surface-hover transition-colors cursor-pointer ${expanded === o.id ? "bg-ops-surface-hover" : ""}`}
                    onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                  >
                    <td className="px-5 py-3 text-sm font-mono text-fitscript-green">{o.id.slice(0, 8)}</td>
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
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data && data.pagination.pages > 1 && (
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
              disabled={page >= data.pagination.pages}
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
