import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { ModalPortal } from "../components/modal-portal";

type Status = "new" | "triaged" | "approved" | "pr_open" | "merged" | "closed" | "wontfix" | "duplicate";
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
                      <td className="px-4 py-3 text-right">
                        <span className="text-[11px] text-brand-blue-500 font-semibold">View →</span>
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

  const [opening, setOpening] = useState(false);
  const openFixPr = async () => {
    if (!confirm("Generate an AI fix proposal and open a draft PR on the FitScript repo?\n\nThe PR will contain a markdown spec — a human still writes the actual code.")) return;
    setOpening(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/ops/tickets/${id}/open-fix-pr`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); return; }
      onChanged();
      refetch();
      setMsg({ tone: "ok", text: `✓ Draft PR opened: ${j.pr_url}` });
    } catch (e: any) {
      setMsg({ tone: "bad", text: e.message });
    } finally { setOpening(false); }
  };

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

            {!t.resolution_pr_url && (t.status === "approved" || t.status === "triaged") && (
              <Section title="AI auto-fix">
                <p className="text-xs text-ops-text-muted mb-2">
                  Generate a structured fix proposal + open a <strong>draft PR</strong> on the FitScript repo. The PR contains a markdown plan — a human writes the actual code.
                </p>
                <button
                  onClick={openFixPr}
                  disabled={opening}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded bg-gradient-to-r from-purple-500/15 to-purple-500/15 border border-purple-500/40 text-purple-400 hover:bg-purple-500/25 disabled:opacity-50"
                >
                  {opening ? "Generating proposal + opening PR…" : "🤖 Auto-fix via PR"}
                </button>
              </Section>
            )}

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
