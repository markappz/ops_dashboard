import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, ShieldAlert, Target, Plus, Check, X } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * Per-brand Growth Model (2026-10-11, Michael's ask): AI drafts the model —
 * drivers, constraints, assumptions WITH how to challenge each — from the
 * same live feed the Command Center reads; Paul/Michael apply judgment and
 * turn suggestions into owned initiatives, each with a person and a KPI.
 */

interface Driver { name: string; why: string; lever: string }
interface Constraint { name: string; impact: string; mitigation?: string }
interface Assumption { statement: string; confidence: "high" | "medium" | "low"; how_to_challenge: string }
interface Suggestion { title: string; driver: string; kpi_label: string; kpi_metric?: string; kpi_target?: number; rationale: string }
interface Model {
  id: number; summary: string; drivers: Driver[]; constraints: Constraint[];
  assumptions: Assumption[]; suggested_initiatives: Suggestion[]; generated_by: string; created_at: string;
}
interface Initiative {
  id: number; title: string; driver: string | null; owner: string | null; kpi_label: string | null;
  kpi_metric: string | null; kpi_target: number | null; kpi_current: number | null; kpi_live: number | null;
  due_label: string | null; status: string; notes: string | null;
}
interface GrowthData { model: Model | null; initiatives: Initiative[]; people: string[]; aiReady: boolean; vitals: Record<string, number | null> }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...(init?.body ? { headers: { "Content-Type": "application/json" } } : {}), ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || r.statusText);
  return r.json();
}

const METRIC_LABEL: Record<string, string> = {
  revenue_30d: "Revenue (30d)", orders_30d: "Orders (30d)", sessions_30d: "Sessions (30d)",
  leads_30d: "Leads (30d)", revenue_growth_pct: "Revenue growth %", manual: "Manual",
};
const CONF_TONE: Record<string, string> = {
  high: "text-emerald-400 border-emerald-400/30", medium: "text-amber-400 border-amber-400/30", low: "text-red-400 border-red-400/30",
};
const fmtNum = (v: number | null | undefined, metric?: string | null) =>
  v == null ? "—" : metric === "revenue_30d" ? v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
  : metric === "revenue_growth_pct" ? `${v > 0 ? "+" : ""}${v}%` : v.toLocaleString();

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{children}</div>;
}

function KpiCell({ i }: { i: Initiative }) {
  const current = i.kpi_live ?? i.kpi_current;
  if (!i.kpi_label) return <span className="text-ops-text-muted">—</span>;
  const pctDone = i.kpi_target && current != null ? Math.min(100, Math.max(0, (Number(current) / Number(i.kpi_target)) * 100)) : null;
  return (
    <div className="min-w-[150px]">
      <div className="text-xs text-ops-text">{i.kpi_label}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xs tabular-nums text-ops-text-muted">
        <span>{fmtNum(current, i.kpi_metric)}{i.kpi_target != null && <> / {fmtNum(Number(i.kpi_target), i.kpi_metric)}</>}</span>
        {i.kpi_live != null && <span className="rounded border border-ops-border px-1 text-[9px] uppercase tracking-wide text-emerald-400">live</span>}
      </div>
      {pctDone != null && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-ops-border/40">
          <div className="h-full rounded bg-emerald-400/80" style={{ width: `${pctDone}%` }} />
        </div>
      )}
    </div>
  );
}

export default function Growth({ company, label }: { company: string; label: string }) {
  const qc = useQueryClient();
  const [guidance, setGuidance] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", owner: "", kpi_label: "", kpi_metric: "manual", kpi_target: "" });
  const { data: d, isLoading } = useQuery<GrowthData>({ queryKey: ["growth", company], queryFn: () => api(`/api/ops/growth/${company}`) });

  const generate = useMutation({
    mutationFn: () => api(`/api/ops/growth/${company}/generate`, { method: "POST", body: JSON.stringify({ guidance }) }),
    onSuccess: () => { setGuidance(""); qc.invalidateQueries({ queryKey: ["growth", company] }); },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/ops/growth/${company}/initiatives/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["growth", company] }),
  });
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/ops/growth/${company}/initiatives`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { setAdding(false); setDraft({ title: "", owner: "", kpi_label: "", kpi_metric: "manual", kpi_target: "" }); qc.invalidateQueries({ queryKey: ["growth", company] }); },
  });
  const adopt = (s: Suggestion) => add.mutate({
    model_id: d?.model?.id, title: s.title, driver: s.driver, kpi_label: s.kpi_label,
    kpi_metric: s.kpi_metric && s.kpi_metric !== "manual" ? s.kpi_metric : null, kpi_target: s.kpi_target ?? null, notes: s.rationale,
  });

  const m = d?.model;
  const adoptedTitles = new Set((d?.initiatives ?? []).map((i) => i.title.toLowerCase()));

  return (
    <div className="space-y-4">
      <PageHero
        eyebrow={label}
        title="Growth Model"
        subtitle="The factors that enhance or limit growth — drafted by AI from live numbers, challenged and owned by humans. Every initiative gets a person and the KPI that proves it worked."
      />

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-ops-border bg-ops-surface p-6 text-sm text-ops-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : (
        <>
          {/* Generate / regenerate — guidance is the judgment input, not optional decoration */}
          <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Sparkles className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ops-accent" />
                <input
                  value={guidance} onChange={(e) => setGuidance(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && d?.aiReady && !generate.isPending) generate.mutate(); }}
                  placeholder={m ? "What changed? Steer the regeneration — constraints you see, bets you want pressure-tested…" : "Optional steer: what you and Michael believe about this brand's growth…"}
                  className="w-full rounded-lg border border-ops-border bg-ops-bg py-2.5 pl-9 pr-3 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-ops-accent focus:outline-none"
                />
              </div>
              <button
                onClick={() => generate.mutate()} disabled={!d?.aiReady || generate.isPending}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-ops-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {m ? "Regenerate model" : "Generate growth model"}
              </button>
            </div>
            {generate.isError && <div className="mt-2 text-xs text-red-400">{(generate.error as Error).message}</div>}
            {generate.isPending && <div className="mt-2 text-xs text-ops-text-muted">Reading this brand's live numbers and drafting — takes ~20s…</div>}
            {!d?.aiReady && <div className="mt-2 text-xs text-amber-400">AI isn't configured on this deploy — model generation is disabled.</div>}
          </div>

          {m && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card lg:col-span-2">
                <SectionLabel>How {label} grows · drafted {new Date(m.created_at).toLocaleDateString()} · challenge this in the next meeting</SectionLabel>
                <p className="max-w-3xl text-sm leading-relaxed text-ops-text">{m.summary}</p>
              </div>

              <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
                <SectionLabel>Growth drivers — the levers</SectionLabel>
                <div className="space-y-3">
                  {m.drivers.map((dr, i) => (
                    <div key={i} className="rounded-lg border border-ops-border/60 p-3">
                      <div className="text-sm font-semibold text-ops-text">{dr.name}</div>
                      <div className="mt-0.5 text-xs text-ops-text-muted">{dr.why}</div>
                      <div className="mt-1.5 text-xs text-emerald-400">→ {dr.lever}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
                  <SectionLabel>Constraints — what gates it</SectionLabel>
                  <div className="space-y-2.5">
                    {m.constraints.map((c, i) => (
                      <div key={i} className="flex gap-2.5 text-xs">
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <div>
                          <span className="font-semibold text-ops-text">{c.name}.</span>{" "}
                          <span className="text-ops-text-muted">{c.impact}</span>
                          {c.mitigation && <span className="text-ops-text-muted"> Mitigation: {c.mitigation}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
                  <SectionLabel>Assumptions — each one names its own test</SectionLabel>
                  <div className="space-y-2.5">
                    {m.assumptions.map((a, i) => (
                      <div key={i} className="rounded-lg border border-ops-border/60 p-3 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-ops-text">{a.statement}</span>
                          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${CONF_TONE[a.confidence] ?? CONF_TONE.medium}`}>{a.confidence}</span>
                        </div>
                        <div className="mt-1 text-ops-text-muted">Challenge it: {a.how_to_challenge}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {m && m.suggested_initiatives.filter((s) => !adoptedTitles.has(s.title.toLowerCase())).length > 0 && (
            <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
              <SectionLabel>Suggested initiatives — adopt what you believe in, ignore the rest</SectionLabel>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {m.suggested_initiatives.filter((s) => !adoptedTitles.has(s.title.toLowerCase())).map((s, i) => (
                  <div key={i} className="flex flex-col rounded-lg border border-ops-border/60 p-3">
                    <div className="text-sm font-semibold text-ops-text">{s.title}</div>
                    <div className="mt-1 flex-1 text-xs text-ops-text-muted">{s.rationale}</div>
                    <div className="mt-2 text-xs text-ops-text-muted">KPI: <span className="text-ops-text">{s.kpi_label}</span>{s.kpi_target != null && <> → {fmtNum(s.kpi_target, s.kpi_metric)}</>}</div>
                    <button onClick={() => adopt(s)} disabled={add.isPending}
                      className="mt-2.5 inline-flex items-center justify-center gap-1.5 rounded-lg border border-ops-accent/50 px-3 py-1.5 text-xs font-semibold text-ops-accent hover:bg-ops-accent/10 disabled:opacity-50">
                      <Plus className="h-3.5 w-3.5" />Adopt — assign an owner next
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <div className="flex items-center justify-between p-5 pb-3">
              <SectionLabel><span className="inline-flex items-center gap-1.5"><Target className="h-3.5 w-3.5" />Initiatives — who owns what, proven by which number</span></SectionLabel>
              <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-1.5 text-xs font-semibold text-ops-text hover:border-ops-accent">
                {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{adding ? "Cancel" : "Add initiative"}
              </button>
            </div>
            {adding && (
              <div className="grid grid-cols-2 gap-2 border-t border-ops-border/60 p-4 md:grid-cols-5">
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Initiative title" className="col-span-2 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-ops-accent focus:outline-none" />
                <select value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} className="rounded-lg border border-ops-border bg-ops-bg px-2 py-2 text-sm text-ops-text">
                  <option value="">Owner…</option>
                  {(d?.people ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input value={draft.kpi_label} onChange={(e) => setDraft({ ...draft, kpi_label: e.target.value })} placeholder="KPI label" className="rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-ops-accent focus:outline-none" />
                <div className="flex gap-2">
                  <input value={draft.kpi_target} onChange={(e) => setDraft({ ...draft, kpi_target: e.target.value })} placeholder="Target" inputMode="decimal" className="w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-ops-accent focus:outline-none" />
                  <button
                    onClick={() => add.mutate({ title: draft.title, owner: draft.owner || null, kpi_label: draft.kpi_label || null, kpi_metric: null, kpi_target: draft.kpi_target ? Number(draft.kpi_target) : null })}
                    disabled={!draft.title || add.isPending}
                    className="rounded-lg bg-ops-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"><Check className="h-4 w-4" /></button>
                </div>
              </div>
            )}
            {(d?.initiatives ?? []).length === 0 ? (
              <div className="border-t border-ops-border/60 p-6 text-sm text-ops-text-muted">No initiatives yet — generate a model and adopt the ones worth running, or add your own.</div>
            ) : (
              <div className="overflow-x-auto border-t border-ops-border/60">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[10.5px] uppercase tracking-[0.1em] text-ops-text-muted">
                      <th className="px-5 py-2.5 font-medium">Initiative</th>
                      <th className="px-4 py-2.5 font-medium">Owner</th>
                      <th className="px-4 py-2.5 font-medium">KPI</th>
                      <th className="px-4 py-2.5 font-medium">Due</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d?.initiatives ?? []).map((i) => (
                      <tr key={i.id} className={`border-t border-ops-border/40 ${i.status === "done" ? "opacity-50" : ""}`}>
                        <td className="max-w-[320px] px-5 py-3">
                          <div className="font-medium text-ops-text">{i.title}</div>
                          {i.driver && <div className="mt-0.5 text-xs text-ops-text-muted">feeds: {i.driver}</div>}
                        </td>
                        <td className="px-4 py-3">
                          <select value={i.owner ?? ""} onChange={(e) => patch.mutate({ id: i.id, body: { owner: e.target.value || null } })}
                            className="rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text">
                            <option value="">Unassigned</option>
                            {(d?.people ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                            {i.owner && !(d?.people ?? []).includes(i.owner) && <option value={i.owner}>{i.owner}</option>}
                          </select>
                        </td>
                        <td className="px-4 py-3"><KpiCell i={i} /></td>
                        <td className="px-4 py-3">
                          <input defaultValue={i.due_label ?? ""} placeholder="Q4…"
                            onBlur={(e) => { if (e.target.value !== (i.due_label ?? "")) patch.mutate({ id: i.id, body: { due_label: e.target.value || null } }); }}
                            className="w-20 rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text placeholder:text-ops-text-muted focus:border-ops-accent focus:outline-none" />
                        </td>
                        <td className="px-4 py-3">
                          <select value={i.status} onChange={(e) => patch.mutate({ id: i.id, body: { status: e.target.value } })}
                            className="rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text">
                            <option value="active">Active</option>
                            <option value="done">Done</option>
                            <option value="dropped">Dropped</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {m && (d?.initiatives ?? []).some((i) => i.kpi_metric && i.kpi_metric !== "manual") && (
            <p className="text-xs text-ops-text-muted">KPIs marked <span className="text-emerald-400">live</span> read the Command Center feed and update themselves; manual KPIs are updated here.</p>
          )}
        </>
      )}
    </div>
  );
}
