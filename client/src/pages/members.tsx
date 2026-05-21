import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { QueryError, hasApiError } from "../components/query-error";
import { PageHero } from "../components/page-hero";

interface Member {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  createdAt: string | null;
  lastActiveDate: string | null;
  source: string | null;
  campaign: string | null;
  ltv: number;
  totalRevenue: number;
  aiCostMtd: number;
  marginPct: number | null;
}

type SortKey = "default" | "ai_cost" | "ltv" | "margin";

function formatUSD(n: number, digits = 2): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(digits)}`;
}

function MarginBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-ops-text-muted">—</span>;
  }
  const color =
    pct >= 80 ? "text-fitscript-green" : pct >= 50 ? "text-amber-400" : "text-red-400";
  return <span className={`font-medium ${color}`}>{pct.toFixed(0)}%</span>;
}

interface MembersResponse {
  members: Member[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

function TierBadge({ tier }: { tier: string | null }) {
  const t = tier || "free";
  const colors: Record<string, string> = {
    free: "bg-zinc-700 text-zinc-300",
    essentials: "bg-fitscript-green/20 text-fitscript-green",
    complete: "bg-amber-500/20 text-amber-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[t] || colors.free}`}>
      {t}
    </span>
  );
}

function StatusDot({ status }: { status: string | null }) {
  const s = status || "active";
  const color = s === "active" ? "bg-green-400" : s === "canceled" ? "bg-red-400" : "bg-yellow-400";
  return <div className={`w-2 h-2 rounded-full ${color}`} />;
}

export default function Members() {
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("default");

  const { data, isLoading, error, refetch } = useQuery<MembersResponse>({
    queryKey: ["ops-members", page, search, tierFilter],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: "50",
        ...(search && { search }),
        ...(tierFilter !== "all" && { tier: tierFilter }),
      });
      return fetch(`/api/ops/members?${params}`).then((r) => r.json());
    },
  });

  const apiFailed = hasApiError(data) || !!error;

  return (
    <div>
      <PageHero
        eyebrow="Customers"
        title="Members"
        subtitle={`${apiFailed ? "—" : (data?.pagination.total.toLocaleString() || "—")} total paying subscribers and free accounts.`}
      />

      {apiFailed && (
        <div className="mb-6">
          <QueryError
            context="Members list"
            data={data}
            error={error as Error | null}
            onRetry={() => refetch()}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="bg-ops-surface border border-ops-border rounded-lg px-4 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:outline-none focus:border-fitscript-green w-80"
        />
        <select
          value={tierFilter}
          onChange={(e) => { setTierFilter(e.target.value); setPage(1); }}
          className="bg-ops-surface border border-ops-border rounded-lg px-4 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
        >
          <option value="all">All tiers</option>
          <option value="free">Free</option>
          <option value="essentials">Essentials</option>
          <option value="complete">Complete</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-ops-border">
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Member</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Tier</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Status</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Source</th>
              <th
                className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider cursor-pointer hover:text-ops-text"
                onClick={() => setSortKey(sortKey === "ai_cost" ? "default" : "ai_cost")}
                title="AI cost month-to-date (Atlas chat; other surfaces pending instrumentation)"
              >
                AI Cost MTD {sortKey === "ai_cost" && "↓"}
              </th>
              <th
                className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider cursor-pointer hover:text-ops-text"
                onClick={() => setSortKey(sortKey === "ltv" ? "default" : "ltv")}
              >
                LTV {sortKey === "ltv" && "↓"}
              </th>
              <th
                className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider cursor-pointer hover:text-ops-text"
                onClick={() => setSortKey(sortKey === "margin" ? "default" : "margin")}
                title="(Revenue - AI Cost) / Revenue. Higher is better."
              >
                Margin {sortKey === "margin" && "↓"}
              </th>
              <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Signed Up</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ops-border">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center">
                  <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
                </td>
              </tr>
            ) : (
              (() => {
                const rows = data?.members ?? [];
                const sorted = [...rows].sort((a, b) => {
                  if (sortKey === "ai_cost") return b.aiCostMtd - a.aiCostMtd;
                  if (sortKey === "ltv") return b.ltv - a.ltv;
                  if (sortKey === "margin") {
                    const ax = a.marginPct ?? -Infinity;
                    const bx = b.marginPct ?? -Infinity;
                    return bx - ax;
                  }
                  return 0;
                });
                return sorted.map((member) => (
                <tr key={member.id} className="hover:bg-ops-surface-hover transition-colors cursor-pointer"
                    onClick={() => { console.log("Navigating to member:", member.id); navigate(`/members/${member.id}`); }}>
                  <td className="px-5 py-3">
                    <div>
                      <div className="text-sm text-ops-text font-medium">
                        {member.firstName || ""} {member.lastName || ""}
                        {!member.firstName && !member.lastName && <span className="text-ops-text-muted italic">No name</span>}
                      </div>
                      <div className="text-xs text-ops-text-muted">{member.email}</div>
                      <div className="text-[10px] text-ops-text-muted/50 font-mono">{member.id}</div>
                    </div>
                  </td>
                  <td className="px-5 py-3"><TierBadge tier={member.subscriptionTier} /></td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <StatusDot status={member.subscriptionStatus} />
                      <span className="text-sm text-ops-text-muted">{member.subscriptionStatus || "active"}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted">
                    {member.source || "---"}
                    {member.campaign && <div className="text-[10px] text-ops-text-muted/60">{member.campaign}</div>}
                  </td>
                  <td className="px-5 py-3 text-right text-sm">
                    {member.aiCostMtd > 0 ? (
                      <span className="text-amber-300 font-medium">{formatUSD(member.aiCostMtd)}</span>
                    ) : (
                      <span className="text-ops-text-muted">$0</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right text-sm font-medium">
                    {member.ltv > 0 ? <span className="text-fitscript-green">${member.ltv.toFixed(0)}</span> : <span className="text-ops-text-muted">$0</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-sm">
                    <MarginBadge pct={member.marginPct} />
                  </td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted">
                    {member.createdAt ? new Date(member.createdAt).toLocaleDateString() : "---"}
                  </td>
                </tr>
                ));
              })()
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.pagination.pages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-ops-text-muted">
            Page {data.pagination.page} of {data.pagination.pages}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm bg-ops-surface border border-ops-border rounded-lg text-ops-text-muted hover:text-ops-text disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(data.pagination.pages, p + 1))}
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
