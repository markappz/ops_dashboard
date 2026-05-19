import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";

interface AdminAction {
  id: number;
  admin_email: string;
  action_type: string;
  target_kind: string;
  target_id: string;
  target_label: string | null;
  status: "ok" | "failed";
  error: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface Resp {
  actions: AdminAction[];
  totals: { ok: number; failed: number };
  byKind: Array<{ target_kind: string; count: number }>;
}

function formatActionType(t: string): string {
  return t.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTargetKind(k: string): string {
  return k
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AdminActions() {
  const [kindFilter, setKindFilter] = useState<string>("");
  const [adminFilter, setAdminFilter] = useState<string>("");

  const params = new URLSearchParams({ limit: "100" });
  if (kindFilter) params.set("target_kind", kindFilter);
  if (adminFilter) params.set("admin_email", adminFilter);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["ops-admin-actions", kindFilter, adminFilter],
    queryFn: () =>
      fetch(`/api/ops/admin-actions?${params.toString()}`).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const actions = data?.actions || [];
  const totals = data?.totals;
  const byKind = data?.byKind || [];

  const uniqueAdmins = Array.from(new Set(actions.map((a) => a.admin_email)));

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Admin Actions</h1>
        <p className="text-sm text-ops-text-muted mt-1">
          Every write action performed through this dashboard. Auto-refreshes every 30s.
        </p>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">Total</div>
          <div className="text-2xl font-bold text-ops-text">
            {actions.length.toLocaleString()}
          </div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">Successful</div>
          <div className="text-2xl font-bold text-fitscript-green">
            {totals?.ok ?? 0}
          </div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">Failed</div>
          <div
            className={`text-2xl font-bold ${
              (totals?.failed ?? 0) > 0 ? "text-red-400" : "text-ops-text-muted"
            }`}
          >
            {totals?.failed ?? 0}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div>
          <label className="block text-[10px] text-ops-text-muted uppercase tracking-wider mb-1">
            Target kind
          </label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
          >
            <option value="">All</option>
            {byKind.map((b) => (
              <option key={b.target_kind} value={b.target_kind}>
                {formatTargetKind(b.target_kind)} ({b.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-ops-text-muted uppercase tracking-wider mb-1">
            Admin
          </label>
          <select
            value={adminFilter}
            onChange={(e) => setAdminFilter(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
          >
            <option value="">All</option>
            {uniqueAdmins.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {(kindFilter || adminFilter) && (
          <div className="flex items-end">
            <button
              onClick={() => {
                setKindFilter("");
                setAdminFilter("");
              }}
              className="px-3 py-1.5 text-xs text-ops-text-muted hover:text-ops-text"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        ) : actions.length === 0 ? (
          <div className="p-8 text-center text-sm text-ops-text-muted">
            No admin actions yet. Pause/Activate a flow on{" "}
            <Link href="/email" className="text-fitscript-green hover:underline">
              Email
            </Link>{" "}
            to write the first row.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
              <tr>
                <th className="text-left px-5 py-3 font-medium">When</th>
                <th className="text-left px-5 py-3 font-medium">Admin</th>
                <th className="text-left px-5 py-3 font-medium">Action</th>
                <th className="text-left px-5 py-3 font-medium">Target</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border">
              {actions.map((a) => (
                <tr key={a.id} className="hover:bg-ops-surface-hover">
                  <td className="px-5 py-3 text-ops-text-muted text-xs">
                    <div>{timeAgo(a.created_at)}</div>
                    <div className="text-[10px] opacity-60">
                      {new Date(a.created_at).toLocaleString()}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-ops-text text-xs">{a.admin_email}</td>
                  <td className="px-5 py-3 text-ops-text font-medium">
                    {formatActionType(a.action_type)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-sm text-ops-text">
                      {a.target_label || (
                        <span className="text-ops-text-muted italic">unnamed</span>
                      )}
                    </div>
                    <div className="text-[10px] text-ops-text-muted font-mono">
                      {formatTargetKind(a.target_kind)} · {a.target_id}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    {a.status === "ok" ? (
                      <span className="text-xs font-medium text-fitscript-green">OK</span>
                    ) : (
                      <div>
                        <span className="text-xs font-medium text-red-400">Failed</span>
                        {a.error && (
                          <div
                            className="text-[10px] text-red-300/70 max-w-[200px] truncate"
                            title={a.error}
                          >
                            {a.error}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
