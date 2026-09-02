import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, X, Trash2, Loader2, Send, Eye, CalendarDays } from "lucide-react";

/**
 * Email content calendar — one per brand, mounted inside its Email tab.
 * Plan campaigns weeks ahead: each slot holds the copy, the pasted HTML
 * design (previewed inline), and — when Resend is connected for the brand —
 * a one-click push that creates the broadcast and schedules it for the slot.
 */

interface Plan {
  id: number;
  company: string;
  title: string;
  subject: string | null;
  preheader: string | null;
  status: "idea" | "draft" | "approved" | "scheduled" | "sent";
  send_date: string | null;
  send_time: string | null;
  from_address: string | null;
  audience_id: string | null;
  notes: string | null;
  resend_broadcast_id: string | null;
  has_design: boolean;
}

const STATUS_CHIP: Record<string, string> = {
  idea: "bg-ops-border text-ops-text-muted",
  draft: "bg-amber-500/15 text-amber-500",
  approved: "bg-brand-blue-500/15 text-brand-blue-400",
  scheduled: "bg-emerald-500/15 text-emerald-400",
  sent: "bg-emerald-500/25 text-emerald-300",
};

const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none";
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function EmailCalendar({ company }: { company: string }) {
  const qc = useQueryClient();
  const today = new Date();
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [newDate, setNewDate] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["email-plans", company],
    queryFn: async () => (await fetch(`/api/ops/email-plans?company=${company}`, { credentials: "include" })).json() as
      Promise<{ plans: Plan[]; resendConnected: boolean; defaultFrom: string | null; error?: string }>,
  });
  const plans = q.data?.plans ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["email-plans", company] });

  const byDay = useMemo(() => {
    const m = new Map<string, Plan[]>();
    for (const p of plans) {
      if (!p.send_date) continue;
      const k = String(p.send_date).slice(0, 10);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return m;
  }, [plans]);
  const unscheduled = plans.filter((p) => !p.send_date);

  // Monday-first grid covering the whole month.
  const cells = useMemo(() => {
    const first = new Date(month);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(1 - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);
  const todayKey = ymd(today);
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="mb-6 rounded-2xl border border-ops-border bg-ops-surface p-4 shadow-card sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ops-text"><CalendarDays size={15} /> Email calendar</h3>
          <p className="text-[11px] text-ops-text-muted">
            Plan the month, paste the design, {q.data?.resendConnected ? "push straight to Resend." : "and push to Resend once it's connected for this brand."}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="rounded-lg border border-ops-border p-1.5 text-ops-text-muted hover:text-ops-text"><ChevronLeft size={15} /></button>
          <span className="w-40 text-center text-sm font-semibold text-ops-text">{monthLabel}</span>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="rounded-lg border border-ops-border p-1.5 text-ops-text-muted hover:text-ops-text"><ChevronRight size={15} /></button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-ops-text-muted">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d) => {
              const k = ymd(d);
              const inMonth = d.getMonth() === month.getMonth();
              const dayPlans = byDay.get(k) ?? [];
              return (
                <button key={k} type="button"
                  onClick={() => { setNewDate(k); setOpenId("new"); }}
                  className={`min-h-[76px] rounded-lg border p-1.5 text-left align-top transition ${
                    k === todayKey ? "border-brand-blue-500/60 bg-brand-blue-500/5" : "border-ops-border/60"
                  } ${inMonth ? "bg-ops-bg/40 hover:border-brand-blue-500/40" : "opacity-40"}`}>
                  <div className="text-[10px] tabular-nums text-ops-text-muted">{d.getDate()}</div>
                  <div className="mt-1 flex flex-col gap-1">
                    {dayPlans.map((p) => (
                      <span key={p.id} role="button" tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setOpenId(p.id); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setOpenId(p.id); } }}
                        className={`block truncate rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CHIP[p.status]} hover:opacity-80`}>
                        {p.send_time ? `${p.send_time} · ` : ""}{p.title}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-ops-border pt-3">
          <span className="text-[11px] text-ops-text-muted">No date yet:</span>
          {unscheduled.map((p) => (
            <button key={p.id} type="button" onClick={() => setOpenId(p.id)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_CHIP[p.status]} hover:opacity-80`}>
              {p.title}
            </button>
          ))}
        </div>
      )}

      {openId !== null && (
        <PlanEditor
          company={company}
          planId={openId === "new" ? null : openId}
          defaultDate={openId === "new" ? newDate : null}
          defaultFrom={q.data?.defaultFrom ?? null}
          resendConnected={!!q.data?.resendConnected}
          onClose={() => setOpenId(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function PlanEditor({ company, planId, defaultDate, defaultFrom, resendConnected, onClose, onSaved }: {
  company: string; planId: number | null; defaultDate: string | null; defaultFrom: string | null;
  resendConnected: boolean; onClose: () => void; onSaved: () => void;
}) {
  const isNew = planId === null;
  const full = useQuery({
    queryKey: ["email-plan", planId],
    queryFn: async () => (await fetch(`/api/ops/email-plans/${planId}`, { credentials: "include" })).json(),
    enabled: !isNew,
  });
  const audiences = useQuery({
    queryKey: ["resend-audiences", company],
    queryFn: async () => (await fetch(`/api/ops/email-plans/resend/audiences?company=${company}`, { credentials: "include" })).json() as
      Promise<{ connected: boolean; audiences: { id: string; name: string }[] }>,
    enabled: resendConnected,
    staleTime: 10 * 60_000,
  });

  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState<"save" | "push" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [preview, setPreview] = useState(false);

  const p = full.data;
  if (!isNew && p && f === null) {
    setF({
      title: p.title ?? "", subject: p.subject ?? "", preheader: p.preheader ?? "",
      status: p.status ?? "idea",
      send_date: p.send_date ? String(p.send_date).slice(0, 10) : "",
      send_time: p.send_time ?? "",
      from_address: p.from_address ?? defaultFrom ?? "",
      audience_id: p.audience_id ?? "",
      html: p.html ?? "", notes: p.notes ?? "",
    });
  }
  if (isNew && f === null) {
    setF({ title: "", subject: "", preheader: "", status: "idea", send_date: defaultDate ?? "", send_time: "", from_address: defaultFrom ?? "", audience_id: "", html: "", notes: "" });
  }
  if (f === null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
        <Loader2 size={22} className="animate-spin text-ops-text-muted" />
      </div>
    );
  }
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  async function save(): Promise<number | null> {
    setBusy("save"); setMsg(null);
    const body = {
      company, title: f.title, subject: f.subject || null, preheader: f.preheader || null,
      status: f.status, send_date: f.send_date || null, send_time: f.send_time || null,
      from_address: f.from_address || null, audience_id: f.audience_id || null,
      html: f.html || null, notes: f.notes || null,
    };
    const r = await fetch(isNew ? "/api/ops/email-plans" : `/api/ops/email-plans/${planId}`, {
      method: isNew ? "POST" : "PATCH", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); return null; }
    onSaved();
    return isNew ? j.id : planId;
  }

  async function saveAndClose() {
    if (await save()) onClose();
    else if (isNew) onClose();
  }

  async function push() {
    const id = await save();
    if (!id) return;
    setBusy("push"); setMsg(null);
    const r = await fetch(`/api/ops/email-plans/${id}/push`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
    setMsg({ tone: "ok", text: j.scheduledFor ? `Broadcast created and scheduled for ${j.scheduledFor}.` : "Broadcast created in Resend (no date set — schedule it there or add a date here)." });
    onSaved();
  }

  async function remove() {
    if (isNew || !confirm(`Delete "${f.title}"?`)) return;
    await fetch(`/api/ops/email-plans/${planId}`, { method: "DELETE", credentials: "include" });
    onSaved(); onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-2 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className="my-4 w-full max-w-3xl rounded-2xl border border-ops-border bg-ops-surface shadow-card sm:my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-4">
          <input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Campaign name…"
            className="w-full bg-transparent text-base font-semibold text-ops-text placeholder:text-ops-text-muted focus:outline-none" autoFocus={isNew} />
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ops-text-muted">Subject line
              <input value={f.subject} onChange={(e) => set("subject", e.target.value)} className={`${input} mt-1`} />
            </label>
            <label className="text-xs text-ops-text-muted">Preheader
              <input value={f.preheader} onChange={(e) => set("preheader", e.target.value)} className={`${input} mt-1`} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-ops-text-muted">Send date
                <input type="date" value={f.send_date} onChange={(e) => set("send_date", e.target.value)} className={`${input} mt-1`} />
              </label>
              <label className="text-xs text-ops-text-muted">Time (ET)
                <input type="time" value={f.send_time} onChange={(e) => set("send_time", e.target.value)} className={`${input} mt-1`} />
              </label>
            </div>
            <label className="text-xs text-ops-text-muted">Status
              <select value={f.status} onChange={(e) => set("status", e.target.value)} className={`${input} mt-1`}>
                <option value="idea">Idea</option><option value="draft">Draft</option>
                <option value="approved">Approved</option><option value="scheduled">Scheduled</option>
                <option value="sent">Sent</option>
              </select>
            </label>
            <label className="text-xs text-ops-text-muted">From
              <input value={f.from_address} onChange={(e) => set("from_address", e.target.value)} placeholder="Real Peptides <hello@realpeptides.co>" className={`${input} mt-1`} />
            </label>
            <label className="text-xs text-ops-text-muted">Resend audience
              {audiences.data?.audiences?.length ? (
                <select value={f.audience_id} onChange={(e) => set("audience_id", e.target.value)} className={`${input} mt-1`}>
                  <option value="">Pick an audience…</option>
                  {audiences.data.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              ) : (
                <input value={f.audience_id} onChange={(e) => set("audience_id", e.target.value)}
                  placeholder={resendConnected ? "audience id" : "connects when Resend key is set"} className={`${input} mt-1`} />
              )}
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-ops-text-muted">Design (paste the email HTML)</span>
              {f.html && (
                <button type="button" onClick={() => setPreview(!preview)}
                  className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue-400 hover:text-brand-blue-300">
                  <Eye size={12} /> {preview ? "Edit HTML" : "Preview"}
                </button>
              )}
            </div>
            {preview && f.html ? (
              <iframe title="Email preview" sandbox="" srcDoc={f.html}
                className="h-[420px] w-full rounded-lg border border-ops-border bg-white" />
            ) : (
              <textarea value={f.html} onChange={(e) => set("html", e.target.value)} rows={8}
                placeholder="<!doctype html>…  (paste from your design tool)"
                className={`${input} font-mono text-xs leading-relaxed`} />
            )}
          </div>

          <label className="block text-xs text-ops-text-muted">Notes
            <input value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Offer, segment thinking, links…" className={`${input} mt-1`} />
          </label>

          {msg && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
              {msg.text}
            </div>
          )}
          {p?.resend_broadcast_id && (
            <div className="text-[11px] text-ops-text-muted">Resend broadcast: <code>{p.resend_broadcast_id}</code></div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ops-border pt-3">
            <button type="button" onClick={remove} disabled={isNew}
              className="flex items-center gap-1.5 text-xs text-ops-text-muted hover:text-red-400 disabled:opacity-0">
              <Trash2 size={13} /> Delete
            </button>
            <div className="flex items-center gap-2">
              <button type="button" disabled={busy !== null || !f.title.trim()} onClick={saveAndClose}
                className="rounded-lg border border-ops-border px-4 py-2 text-sm text-ops-text hover:bg-ops-bg disabled:opacity-40">
                {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : "Save"}
              </button>
              <button type="button" disabled={busy !== null || !f.title.trim() || !resendConnected} onClick={push}
                title={resendConnected ? "Create the broadcast in Resend and schedule it for the date above" : "Set RESEND_API_KEY for this brand on ops to enable"}
                className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
                {busy === "push" ? <Loader2 size={15} className="animate-spin" /> : <Send size={14} />}
                Push to Resend
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
