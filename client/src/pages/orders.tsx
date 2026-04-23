import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface Order {
  id: string;
  visible_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  category: string | null;
  status: string;
  total: string;
  payment_status: string;
  tracking_number: string | null;
  carrier: string | null;
  created_at: string;
}

interface OrdersResponse {
  orders: Order[];
  statuses: Record<string, number>;
  pagination: { page: number; limit: number; total: number; pages: number };
}

interface LabOrder {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  plan_type: string;
  price_cents: number;
  status: string;
  created_at: string;
}

interface LabOrdersResponse {
  orders: LabOrder[];
  statuses: Record<string, number>;
}

const RX_STATUS_FLOW = [
  "PENDING_PROVIDER_REVIEW",
  "APPROVED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
];

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING_PROVIDER_REVIEW: "bg-yellow-500/15 text-yellow-400",
    AWAITING_PROVIDER: "bg-orange-500/15 text-orange-400",
    APPROVED: "bg-fitscript-green/15 text-fitscript-green",
    PROCESSING: "bg-blue-500/15 text-blue-400",
    SHIPPED: "bg-purple-500/15 text-purple-400",
    DELIVERED: "bg-fitscript-green/15 text-fitscript-green",
    CANCELLED: "bg-red-500/15 text-red-400",
    paid: "bg-fitscript-green/15 text-fitscript-green",
    draft: "bg-ops-text-muted/15 text-ops-text-muted",
    pending_payment: "bg-yellow-500/15 text-yellow-400",
    pending_approval: "bg-yellow-500/15 text-yellow-400",
    cancelled: "bg-red-500/15 text-red-400",
    refunded: "bg-red-500/15 text-red-400",
    shipped: "bg-purple-500/15 text-purple-400",
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

function OrderActionPanel({ order, onDone }: { order: Order; onDone: () => void }) {
  const [tracking, setTracking] = useState(order.tracking_number || "");
  const [carrier, setCarrier] = useState(order.carrier || "");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const doAction = async (url: string, method: string, body?: object) => {
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFeedback({ type: "success", msg: "Done" });
      setTimeout(() => { setFeedback(null); onDone(); }, 1000);
    } catch (e: any) {
      setFeedback({ type: "error", msg: e.message });
    }
  };

  const currentIdx = RX_STATUS_FLOW.indexOf(order.status);
  const nextStatus = currentIdx >= 0 && currentIdx < RX_STATUS_FLOW.length - 1
    ? RX_STATUS_FLOW[currentIdx + 1]
    : null;

  return (
    <div className="border-t border-ops-border px-5 py-4 bg-ops-bg/50">
      {feedback && (
        <div className={`mb-3 px-3 py-2 rounded text-sm ${feedback.type === "success" ? "bg-fitscript-green/15 text-fitscript-green" : "bg-red-500/15 text-red-400"}`}>
          {feedback.msg}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* Advance status */}
        {nextStatus && (
          <button
            onClick={() => doAction(`/api/ops/orders/${order.id}/status`, "PATCH", { status: nextStatus })}
            className="px-3 py-2 text-sm rounded-lg bg-fitscript-green/10 text-fitscript-green hover:bg-fitscript-green/20"
          >
            Move to {nextStatus.replace(/_/g, " ")}
          </button>
        )}

        {/* Add tracking */}
        {(order.status === "PROCESSING" || order.status === "APPROVED") && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Tracking #"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text w-40"
            />
            <input
              type="text"
              placeholder="Carrier"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text w-28"
            />
            {tracking && (
              <button
                onClick={() => doAction(`/api/ops/orders/${order.id}/tracking`, "PATCH", { trackingNumber: tracking, carrier })}
                className="px-3 py-2 text-sm rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20"
              >
                Ship
              </button>
            )}
          </div>
        )}

        {/* Cancel */}
        {order.status !== "CANCELLED" && order.status !== "DELIVERED" && (
          <button
            onClick={() => {
              if (confirm(`Cancel order ${order.visible_id}?`)) {
                doAction(`/api/ops/orders/${order.id}/status`, "PATCH", { status: "CANCELLED" });
              }
            }}
            className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"
          >
            Cancel Order
          </button>
        )}

        {/* Refund */}
        {order.payment_status === "paid" && (
          <button
            onClick={() => {
              if (confirm(`Refund order ${order.visible_id} ($${parseFloat(order.total).toFixed(2)})?`)) {
                doAction(`/api/ops/orders/${order.id}/refund`, "POST");
              }
            }}
            className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"
          >
            Refund
          </button>
        )}
      </div>
    </div>
  );
}

export default function Orders() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"rx" | "labs">("rx");
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["ops-orders"] });
    queryClient.invalidateQueries({ queryKey: ["ops-lab-orders"] });
    queryClient.invalidateQueries({ queryKey: ["ops-snapshot"] });
  };

  const { data: rxData, isLoading: rxLoading } = useQuery<OrdersResponse>({
    queryKey: ["ops-orders", page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      return fetch(`/api/ops/orders?${params}`).then((r) => r.json());
    },
    enabled: tab === "rx",
  });

  const { data: labData, isLoading: labLoading } = useQuery<LabOrdersResponse>({
    queryKey: ["ops-lab-orders"],
    queryFn: () => fetch("/api/ops/lab-orders").then((r) => r.json()),
    enabled: tab === "labs",
  });

  const rxStatuses = rxData?.statuses || {};
  const totalRx = Object.values(rxStatuses).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ops-text">Orders</h1>
        <p className="text-sm text-ops-text-muted mt-1">Rx prescriptions and lab panel orders</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-ops-surface border border-ops-border rounded-lg p-1 w-fit">
        <button onClick={() => setTab("rx")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === "rx" ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
          Rx Orders
        </button>
        <button onClick={() => setTab("labs")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === "labs" ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
          Lab Orders
        </button>
      </div>

      {tab === "rx" && (
        <>
          <div className="grid grid-cols-6 gap-3 mb-6">
            <StatCard label="Total" value={totalRx} />
            <StatCard label="Pending Review" value={rxStatuses.PENDING_PROVIDER_REVIEW || 0} />
            <StatCard label="Approved" value={rxStatuses.APPROVED || 0} />
            <StatCard label="Processing" value={rxStatuses.PROCESSING || 0} />
            <StatCard label="Shipped" value={rxStatuses.SHIPPED || 0} />
            <StatCard label="Delivered" value={rxStatuses.DELIVERED || 0} />
          </div>

          <div className="mb-4">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="bg-ops-surface border border-ops-border rounded-lg px-4 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green">
              <option value="all">All statuses</option>
              <option value="PENDING_PROVIDER_REVIEW">Pending Review</option>
              <option value="APPROVED">Approved</option>
              <option value="PROCESSING">Processing</option>
              <option value="SHIPPED">Shipped</option>
              <option value="DELIVERED">Delivered</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>

          <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
            <table className="w-full">
              <thead>
                <tr className="border-b border-ops-border">
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Order</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Category</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Payment</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Total</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Date</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rxLoading ? (
                  <tr><td colSpan={8} className="px-5 py-12 text-center">
                    <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
                  </td></tr>
                ) : rxData?.orders.length === 0 ? (
                  <tr><td colSpan={8} className="px-5 py-12 text-center text-sm text-ops-text-muted">No orders found</td></tr>
                ) : (
                  rxData?.orders.map((order) => (
                    <>
                      <tr key={order.id}
                          className={`border-t border-ops-border hover:bg-ops-surface-hover transition-colors cursor-pointer ${expandedOrder === order.id ? "bg-ops-surface-hover" : ""}`}
                          onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}>
                        <td className="px-5 py-3 text-sm font-mono text-fitscript-green">{order.visible_id}</td>
                        <td className="px-5 py-3">
                          <div className="text-sm text-ops-text">{order.first_name} {order.last_name}</div>
                          <div className="text-xs text-ops-text-muted">{order.email}</div>
                        </td>
                        <td className="px-5 py-3 text-sm text-ops-text-muted">{order.category || "---"}</td>
                        <td className="px-5 py-3"><StatusBadge status={order.status} /></td>
                        <td className="px-5 py-3"><StatusBadge status={order.payment_status} /></td>
                        <td className="px-5 py-3 text-right text-sm font-medium text-ops-text">${parseFloat(order.total).toFixed(2)}</td>
                        <td className="px-5 py-3 text-sm text-ops-text-muted">{new Date(order.created_at).toLocaleDateString()}</td>
                        <td className="px-5 py-3 text-right">
                          <svg className={`w-4 h-4 text-ops-text-muted transition-transform ${expandedOrder === order.id ? "rotate-180" : ""}`}
                               fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </td>
                      </tr>
                      {expandedOrder === order.id && (
                        <tr key={`${order.id}-actions`}>
                          <td colSpan={8} className="p-0">
                            <OrderActionPanel
                              order={order}
                              onDone={() => { setExpandedOrder(null); invalidate(); }}
                            />
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {rxData && rxData.pagination.pages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-ops-text-muted">Page {rxData.pagination.page} of {rxData.pagination.pages}</div>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-3 py-1.5 text-sm bg-ops-surface border border-ops-border rounded-lg text-ops-text-muted hover:text-ops-text disabled:opacity-40">Previous</button>
                <button onClick={() => setPage((p) => p + 1)} disabled={page >= rxData.pagination.pages}
                  className="px-3 py-1.5 text-sm bg-ops-surface border border-ops-border rounded-lg text-ops-text-muted hover:text-ops-text disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "labs" && (
        <>
          {labData && (
            <div className="grid grid-cols-5 gap-3 mb-6">
              <StatCard label="Total" value={labData.orders.length} />
              {Object.entries(labData.statuses).map(([status, cnt]) => (
                <StatCard key={status} label={status.replace(/_/g, " ")} value={cnt} />
              ))}
            </div>
          )}

          <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
            <table className="w-full">
              <thead>
                <tr className="border-b border-ops-border">
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Panel</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Status</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Price</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border">
                {labLoading ? (
                  <tr><td colSpan={5} className="px-5 py-12 text-center">
                    <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
                  </td></tr>
                ) : labData?.orders.length === 0 ? (
                  <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-ops-text-muted">No lab orders yet</td></tr>
                ) : (
                  labData?.orders.map((order) => (
                    <tr key={order.id} className="hover:bg-ops-surface-hover transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-sm text-ops-text">{order.first_name} {order.last_name}</div>
                        <div className="text-xs text-ops-text-muted">{order.email}</div>
                      </td>
                      <td className="px-5 py-3 text-sm text-ops-text">{order.plan_type}</td>
                      <td className="px-5 py-3"><StatusBadge status={order.status} /></td>
                      <td className="px-5 py-3 text-right text-sm font-medium text-ops-text">${(order.price_cents / 100).toFixed(2)}</td>
                      <td className="px-5 py-3 text-sm text-ops-text-muted">{new Date(order.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
