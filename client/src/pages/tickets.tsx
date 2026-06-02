import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { ModalPortal } from "../components/modal-portal";

type Status = "new" | "triaged" | "approved" | "pr_open" | "pr_implemented" | "merged" | "closed" | "wontfix" | "duplicate";
type Category = "bug" | "ux" | "performance" | "feature" | "question" | "unknown";
type Severity = "critical" | "high" | "medium" | "low";

interface TicketRow {
  id: string;
  source_url: string;
  user_note: string | null;
  user_email: string | null;
  screenshot_s3_key: string | null;
  element_selector: string | null;
  status: Status;
  category: Category;
  severity: Severity;
  cluster_id: string | null;
  ai_summary: string | null;
  ai_triaged_at: string | null;
  assignee_email: string | null;
  resolution_pr_url: string | null;
  created_at: string;
  updated_at: string;
  duplicate_count: number;
}

interface TicketDetail extends TicketRow {
  console_errors: unknown;
  viewport_width: number | null;
  viewport_height: number | null;
  user_agent: string | null;
  ai_suggested_fix: string | null;
  resolution_pr_url: string | null;
  closed_at: string | null;
}

const STATUS_META: Record<Status, { label: string; tone: string }> = {
  new: { label: "New", tone: "bg-brand-blue-500/10 text-brand-blue-400 border-brand-blue-400/30" },
  triaged: { label: "Triaged", tone: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  approved: { label: "Approved", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  pr_open: { label: "PR open", tone: "bg-purple-500/10 text-purple-400 border-purple-500/30" },
  pr_implemented: { label: "PR coded", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  merged: { label: "Merged", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  closed: { label: "Closed", tone: "bg-ops-bg text-ops-text-muted border-ops-border" },
  wontfix: { label: "Won't fix", tone: "bg-ops-bg text-ops-text-muted border-ops-border" },
  duplicate: { label: "Duplicate", tone: "bg-ops-bg text-ops-text-subtle border-ops-border" },
};

const SEVERITY_META: Record<Severity, { label: string; tone: string }> = {
  critical: { label: "Critical", tone: "bg-red-500/15 text-red-400 border-red-500/40" },
  high: { label: "High", tone: "bg-amber-500/15 text-amber-400 border-amber-500/40" },
  medium: { label: "Med", tone: "bg-ops-bg text-ops-text-muted border-ops-border" },
  low: { label: "Low", tone: "bg-ops-bg text-ops-text-subtle border-ops-border" },
};

const CATEGORY_META: Record<Category, { label: string }> = {
  bug: { label: "🐛 Bug" },
  ux: { label: "✨ UX" },
  performance: { label: "⚡ Perf" },
  feature: { label: "💡 Feature" },
  question: { label: "❓ Question" },
  unknown: { label: "❔ Unknown" },
};

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Tickets() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"" | Status>("");
  const [severityFilter, setSeverityFilter] = useState<"" | Severity>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queryUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter) p.set("status", statusFilter);
    if (severityFilter) p.set("severity", severityFilter);
    return `/api/ops/tickets${p.toString() ? `?${p.toString()}` : ""}`;
  }, [statusFilter, severityFilter]);

  const { data, isLoading } = useQuery<{ tickets: TicketRow[]; status_counts: Record<string, number> }>({
    queryKey: ["ops-tickets", statusFilter, severityFilter],
    queryFn: () => fetch(queryUrl).then((r) => r.json()),
    refetchInterval: 30_000, // tickets land async after AI triage
  });
  const tickets = data?.tickets ?? [];
  const counts = data?.status_counts ?? {};

  // Feature-detect: hide auto-fix buttons when prod env is missing the PAT.
  // Otherwise every approve click renders a red "not configured" banner.
  const { data: config } = useQuery<{ github_pat_configured: boolean; ai_configured: boolean; github_repo: string }>({
    queryKey: ["ops-tickets-config"],
    queryFn: () => fetch("/api/ops/tickets/config").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const autoFixEnabled = !!(config?.github_pat_configured && config?.ai_configured);

  // Per-row action state: tickets currently being approved or denied.
  // Map: ticketId → { kind: "approving" | "denying", message?: string }
  const [rowState, setRowState] = useState<Record<string, { kind: "approving" | "denying"; message?: string }>>({});

  // Run the full Approve flow atomically in three sequential calls:
  //   1. PATCH status → 'approved' (if not already)
  //   2. POST /open-fix-pr (creates branch + DRAFT PR with the proposal)
  //   3. POST /auto-implement (Claude writes the actual diff + commits)
  // If any step fails, surface the message in the row and stop.
  async function handleApprove(t: TicketRow) {
    setRowState((s) => ({ ...s, [t.id]: { kind: "approving", message: "Promoting…" } }));
    try {
      if (t.status !== "approved" && t.status !== "pr_open" && t.status !== "pr_implemented") {
        const r = await fetch(`/api/ops/tickets/${t.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved" }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      let prUrl: string | null = t.resolution_pr_url ?? null;
      if (!prUrl) {
        setRowState((s) => ({ ...s, [t.id]: { kind: "approving", message: "Opening PR…" } }));
        const r1 = await fetch(`/api/ops/tickets/${t.id}/open-fix-pr`, { method: "POST" });
        const j1 = await r1.json().catch(() => ({}));
        if (!r1.ok) throw new Error(j1.error || `HTTP ${r1.status}`);
        prUrl = j1.pr_url;
      }
      setRowState((s) => ({ ...s, [t.id]: { kind: "approving", message: "Claude editing files…" } }));
      const r2 = await fetch(`/api/ops/tickets/${t.id}/auto-implement`, { method: "POST" });
      const j2 = await r2.json().catch(() => ({}));
      if (!r2.ok) throw new Error(j2.error || `HTTP ${r2.status}`);
      queryClient.invalidateQueries({ queryKey: ["ops-tickets"] });
      setRowState((s) => {
        const next = { ...s };
        delete next[t.id];
        return next;
      });
    } catch (e: any) {
      setRowState((s) => ({ ...s, [t.id]: { kind: "approving", message: `Error: ${e.message}` } }));
      setTimeout(() => {
        setRowState((s) => {
          const next = { ...s };
          delete next[t.id];
          return next;
        });
      }, 6000);
    }
  }

  async function handleDeny(t: TicketRow) {
    setRowState((s) => ({ ...s, [t.id]: { kind: "denying", message: "Denying…" } }));
    try {
      const r = await fetch(`/api/ops/tickets/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "wontfix" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      queryClient.invalidateQueries({ queryKey: ["ops-tickets"] });
      setRowState((s) => {
        const next = { ...s };
        delete next[t.id];
        return next;
      });
    } catch (e: any) {
      setRowState((s) => ({ ...s, [t.id]: { kind: "denying", message: `Error: ${e.message}` } }));
      setTimeout(() => {
        setRowState((s) => {
          const next = { ...s };
          delete next[t.id];
          return next;
        });
      }, 6000);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const newCount = counts["new"] ?? 0;
  const criticalCount = tickets.filter((t) => t.severity === "critical").length;

  return (
    <div>
      <PageHero
        eyebrow="Workspace"
        title="Tech tickets"
        subtitle="Bug + UX + perf reports from FitScript users. AI triages on ingest, you approve, fixes land via PR."
        actions={
          <div className="flex gap-2 items-center">
            {newCount > 0 && (
              <span className="text-[11px] px-2 py-1 rounded bg-brand-blue-500/15 text-brand-blue-400 border border-brand-blue-400/30">
                {newCount} new
              </span>
            )}
            {criticalCount > 0 && (
              <span className="text-[11px] px-2 py-1 rounded bg-red-500/15 text-red-400 border border-red-500/30">
                {criticalCount} critical
              </span>
            )}
          </div>
        }
      />

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 mb-5">
        <div className="flex flex-wrap gap-2 mb-3">
          {(["", "new", "triaged", "approved", "pr_open", "merged", "closed"] as const).map((s) => {
            const active = statusFilter === s;
            const label = s === "" ? `All (${total})` : `${STATUS_META[s as Status].label} (${counts[s as string] ?? 0})`;
            return (
              <button
                key={s || "all"}
                onClick={() => setStatusFilter(s)}
                className={`text-[12px] font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                  active ? "bg-brand-blue-500/10 text-brand-blue-500 border-brand-blue-400/40"
                         : "bg-ops-bg text-ops-text-muted border-ops-border hover:text-ops-text"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          {(["", "critical", "high", "medium", "low"] as const).map((s) => {
            const active = severityFilter === s;
            return (
              <button
                key={s || "all-sev"}
                onClick={() => setSeverityFilter(s)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                  active ? "bg-brand-blue-500/10 text-brand-blue-500 border-brand-blue-400/40"
                         : "bg-ops-bg text-ops-text-muted border-ops-border hover:text-ops-text"
                }`}
              >
                {s === "" ? "All severity" : SEVERITY_META[s as Severity].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
        {isLoading ? (
          <div className="px-4 py-12 text-center text-sm text-ops-text-muted">Loading…</div>
        ) : tickets.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-sm text-ops-text-muted">No tickets match this filter.</div>
            <div className="text-[11px] text-ops-text-subtle mt-1">Reports land here when users tag issues on fitscript.me.</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ops-text-muted border-b border-ops-border">
                  <th className="px-4 py-2 font-semibold">Issue</th>
                  <th className="px-4 py-2 font-semibold">Category</th>
                  <th className="px-4 py-2 font-semibold">Severity</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold w-0"></th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => {
                  const sm = SEVERITY_META[t.severity];
                  const stm = STATUS_META[t.status];
                  const cm = CATEGORY_META[t.category];
                  return (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className="border-b border-ops-border last:border-b-0 hover:bg-ops-surface-hover cursor-pointer"
                    >
                      <td className="px-4 py-3 max-w-md">
                        <div className="text-ops-text font-medium truncate" title={t.ai_summary || t.user_note || "—"}>
                          {t.ai_summary || t.user_note || "(no summary)"}
                        </div>
                        <div className="text-[11px] text-ops-text-muted truncate mt-0.5" title={t.source_url}>
                          {t.source_url}
                        </div>
                        {t.duplicate_count > 0 && (
                          <div className="text-[10px] text-ops-text-subtle mt-0.5">
                            + {t.duplicate_count} duplicate report{t.duplicate_count === 1 ? "" : "s"}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-ops-text-muted whitespace-nowrap">{cm.label}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${sm.tone}`}>{sm.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${stm.tone}`}>{stm.label}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-ops-text-subtle whitespace-nowrap">{fmtRelative(t.created_at)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <TicketRowActions
                          t={t}
                          autoFixEnabled={autoFixEnabled}
                          rowState={rowState[t.id]}
                          onApprove={() => handleApprove(t)}
                          onDeny={() => handleDeny(t)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedId && (
        <TicketDetailDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["ops-tickets"] })}
        />
      )}
    </div>
  );
}

/**
 * Row-level Approve / Deny actions. Replaces the legacy "View →" link so
 * the admin can act on a ticket without opening the drawer.
 *
 * Hides itself for tickets already in terminal states. Greys out when the
 * GitHub PAT isn't configured on the server (we already gated this via the
 * /api/ops/tickets/config feature-detect to keep the UX clean instead of
 * surfacing a red error banner per click).
 */
function TicketRowActions({
  t,
  autoFixEnabled,
  rowState,
  onApprove,
  onDeny,
}: {
  t: TicketRow;
  autoFixEnabled: boolean;
  rowState: { kind: "approving" | "denying"; message?: string } | undefined;
  onApprove: () => void;
  onDeny: () => void;
}) {
  // Terminal states get a label instead of buttons.
  const TERMINAL: Status[] = ["pr_implemented", "merged", "closed", "wontfix", "duplicate"];
  if (TERMINAL.includes(t.status)) {
    const labelMap: Partial<Record<Status, string>> = {
      pr_implemented: "✓ Fixed",
      merged: "✓ Merged",
      closed: "Closed",
      wontfix: "Denied",
      duplicate: "Duplicate",
    };
    const tone = t.status === "pr_implemented" || t.status === "merged"
      ? "text-emerald-400"
      : "text-ops-text-subtle";
    return <span className={`text-[11px] font-semibold ${tone}`}>{labelMap[t.status]}</span>;
  }

  if (rowState) {
    const isError = rowState.message?.startsWith("Error:");
    return (
      <span className={`text-[11px] ${isError ? "text-red-400" : "text-ops-text-muted"}`}>
        {rowState.message}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={onApprove}
        disabled={!autoFixEnabled}
        title={autoFixEnabled
          ? "Open PR + let Claude write the fix on the existing draft branch"
          : "GITHUB_PAT_FITSCRIPT_FIX missing on the ops server — configure to enable"}
        className="text-[11px] font-semibold px-2.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        Approve & fix
      </button>
      <button
        onClick={onDeny}
        title="Mark as won't fix"
        className="text-[11px] font-semibold px-2.5 py-1 rounded border border-ops-border bg-ops-bg text-ops-text-muted hover:bg-ops-surface-hover hover:text-ops-text transition-colors"
      >
        Deny
      </button>
    </div>
  );
}

function TicketDetailDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useQuery<{
    ticket: TicketDetail;
    screenshotUrl: string | null;
    duplicates: Array<{ id: string; user_note: string | null; user_email: string | null; ai_summary: string | null; created_at: string }>;
  }>({
    queryKey: ["ops-ticket-detail", id],
    queryFn: () => fetch(`/api/ops/tickets/${id}`).then((r) => r.json()),
  });
  const t = data?.ticket;
  const [patching, setPatching] = useState(false);
  const [triaging, setTriaging] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const patch = async (body: Partial<TicketDetail>) => {
    setPatching(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/ops/tickets/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); return; }
      onChanged();
      refetch();
    } finally { setPatching(false); }
  };

  const retriage = async () => {
    setTriaging(true); setMsg(null);
    try {
      const r = await fetch(`/api/ops/tickets/${id}/triage`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); return; }
      onChanged();
      refetch();
      setMsg({ tone: "ok", text: "✓ AI triage refreshed" });
    } finally { setTriaging(false); }
  };

  // Auto-fix flow (Step 1 + Step 2) moved to row-level Approve buttons on the
  // list view. The drawer is now read-only for that surface.

  const del = async () => {
    if (!confirm("Delete this ticket permanently?")) return;
    const r = await fetch(`/api/ops/tickets/${id}`, { method: "DELETE" });
    if (r.ok) { onChanged(); onClose(); }
  };

  return (
    <ModalPortal onClose={onClose}>
      <div
        className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-ops-surface px-5 py-4 border-b border-ops-border flex items-center justify-between z-10">
          <h3 className="text-base font-bold text-ops-text">Ticket detail</h3>
          <button onClick={onClose} className="text-ops-text-muted hover:text-ops-text text-xl leading-none">×</button>
        </div>

        {isLoading || !t ? (
          <div className="px-5 py-12 text-center text-sm text-ops-text-muted">Loading…</div>
        ) : (
          <div className="px-5 py-5 space-y-5">
            <div>
              <div className="text-base font-semibold text-ops-text mb-1">{t.ai_summary || t.user_note || "(no summary)"}</div>
              <div className="text-xs text-ops-text-muted break-all">{t.source_url}</div>
              <div className="text-[11px] text-ops-text-subtle mt-1">
                Reported {fmtRelative(t.created_at)} {t.user_email && `by ${t.user_email}`}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Pick label="Status" value={t.status} options={Object.keys(STATUS_META) as Status[]}
                    onChange={(v) => patch({ status: v as Status })} disabled={patching} renderLabel={(v) => STATUS_META[v as Status].label} />
              <Pick label="Category" value={t.category} options={Object.keys(CATEGORY_META) as Category[]}
                    onChange={(v) => patch({ category: v as Category })} disabled={patching} renderLabel={(v) => CATEGORY_META[v as Category].label} />
              <Pick label="Severity" value={t.severity} options={Object.keys(SEVERITY_META) as Severity[]}
                    onChange={(v) => patch({ severity: v as Severity })} disabled={patching} renderLabel={(v) => SEVERITY_META[v as Severity].label} />
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-ops-text-muted mb-1">Assignee</label>
                <input
                  type="email"
                  value={t.assignee_email ?? ""}
                  onChange={(e) => patch({ assignee_email: e.target.value || null })}
                  placeholder="email@…"
                  disabled={patching}
                  className="w-full bg-ops-bg border border-ops-border rounded px-2 py-1 text-xs text-ops-text focus:outline-none focus:border-brand-blue-500"
                />
              </div>
            </div>

            {t.user_note && (
              <Section title="User note">
                <div className="text-sm text-ops-text whitespace-pre-wrap">{t.user_note}</div>
              </Section>
            )}

            {data?.screenshotUrl && (
              <Section title="Screenshot">
                <a href={data.screenshotUrl} target="_blank" rel="noreferrer">
                  <img src={data.screenshotUrl} alt="Ticket screenshot" className="rounded border border-ops-border max-h-72 hover:opacity-90 cursor-zoom-in" />
                </a>
              </Section>
            )}

            <Section title="AI analysis" titleAccessory={
              <button onClick={retriage} disabled={triaging} className="text-[10px] font-semibold text-brand-blue-500 hover:text-brand-blue-600 disabled:opacity-50">
                {triaging ? "Re-triaging…" : "Re-run AI"}
              </button>
            }>
              {t.ai_summary || t.ai_suggested_fix ? (
                <div className="space-y-2">
                  {t.ai_summary && <div className="text-sm text-ops-text">{t.ai_summary}</div>}
                  {t.ai_suggested_fix && (
                    <div className="text-xs text-ops-text-muted bg-ops-bg border border-ops-border rounded p-3 whitespace-pre-wrap">
                      {t.ai_suggested_fix}
                    </div>
                  )}
                  {t.ai_triaged_at && <div className="text-[10px] text-ops-text-subtle">Triaged {fmtRelative(t.ai_triaged_at)}</div>}
                </div>
              ) : (
                <div className="text-xs text-ops-text-muted italic">Not yet triaged. Click "Re-run AI" above.</div>
              )}
            </Section>

            {!!data?.duplicates?.length && (
              <Section title={`Duplicates (${data.duplicates.length})`}>
                <ul className="space-y-1">
                  {data.duplicates.map((d) => (
                    <li key={d.id} className="text-xs text-ops-text-muted">
                      <span className="text-ops-text">{d.ai_summary || d.user_note || "(no summary)"}</span>
                      <span className="text-ops-text-subtle ml-2">— {d.user_email ?? "anonymous"}, {fmtRelative(d.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Technical context">
              <div className="text-[11px] text-ops-text-muted space-y-1">
                {t.element_selector && <div><span className="text-ops-text-subtle">Element:</span> <code className="bg-ops-bg px-1.5 py-0.5 rounded font-mono">{t.element_selector}</code></div>}
                {(t.viewport_width || t.viewport_height) && <div><span className="text-ops-text-subtle">Viewport:</span> {t.viewport_width}×{t.viewport_height}</div>}
                {t.user_agent && <div className="break-all"><span className="text-ops-text-subtle">UA:</span> {t.user_agent}</div>}
                {t.console_errors != null && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-ops-text-subtle hover:text-ops-text">Console errors</summary>
                    <pre className="mt-1 text-[10px] font-mono bg-ops-bg border border-ops-border rounded p-2 overflow-x-auto max-h-48">
                      {JSON.stringify(t.console_errors, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </Section>

            {t.resolution_pr_url && (
              <Section title="Resolution PR">
                <a href={t.resolution_pr_url} target="_blank" rel="noreferrer" className="text-xs text-brand-blue-500 hover:text-brand-blue-600 underline break-all">
                  {t.resolution_pr_url}
                </a>
              </Section>
            )}

            {/* The drawer used to have a 2-step "Open PR" / "Approve & implement"
                pair. That moved to row-level Approve & fix buttons on the list.
                Here we just surface the linked PR when one exists. */}

            {msg && (
              <div className={`px-3 py-2 rounded-lg text-xs ${msg.tone === "ok" ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}>
                {msg.text}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button onClick={del} className="text-[11px] text-red-400 hover:text-red-300 px-3 py-1.5">
                Delete ticket
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalPortal>
  );
}

function Pick({ label, value, options, onChange, disabled, renderLabel }: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
  renderLabel: (v: string) => string;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-ops-text-muted mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full bg-ops-bg border border-ops-border rounded px-2 py-1 text-xs text-ops-text focus:outline-none focus:border-brand-blue-500"
      >
        {options.map((o) => <option key={o} value={o}>{renderLabel(o)}</option>)}
      </select>
    </div>
  );
}

function Section({ title, titleAccessory, children }: { title: string; titleAccessory?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-ops-bg border border-ops-border rounded-lg p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ops-text-muted">{title}</div>
        {titleAccessory}
      </div>
      {children}
    </div>
  );
}
