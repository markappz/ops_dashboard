import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, ChevronDown, ChevronRight, CalendarClock, Moon, CheckCircle2 } from "lucide-react";
import { PageHero } from "../../components/page-hero";
import { useCc, api, Badge, STATE_META, QUEUE_LABEL, fmtWhen, type CcRequest } from "./api";

const VIEWS = [
  { key: "my", label: "My work" },
  { key: "unassigned", label: "Unassigned" },
  { key: "due_today", label: "Due today" },
  { key: "overdue", label: "Overdue" },
  { key: "awaiting", label: "Awaiting customer" },
  { key: "open", label: "All open" },
  { key: "resolved", label: "Resolved" },
];
const QUEUES = ["", "support", "wholesale", "sales_recovery", "affiliate", "triage"];

export default function CallCenterFollowups() {
  const [view, setView] = useState("open");
  const [queue, setQueue] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const params = new URLSearchParams({ view });
  if (queue) params.set("queue", queue);
  const q = useCc<{ requests: CcRequest[] }>(["requests", view, queue], `/requests?${params}`, { refetchInterval: 30_000 });
  const list = q.data?.requests ?? [];

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides · Call Center"
        title="Follow-ups"
        subtitle="Every request a conversation produced, owned until it's resolved. Recording a call attempt never closes a request — outcomes do."
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" onClick={() => setView(v.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${view === v.key ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>{v.label}</button>
          ))}
        </div>
        <select value={queue} onChange={(e) => setQueue(e.target.value)} aria-label="Queue"
          className="rounded-xl border border-ops-border bg-ops-surface px-3 py-2 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none">
          {QUEUES.map((k) => <option key={k} value={k}>{k ? QUEUE_LABEL[k] : "All queues"}</option>)}
        </select>
      </div>

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading follow-ups…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.data && !list.length && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-10 text-center text-sm text-ops-text-muted shadow-card">
          Nothing in this view. Requests land here from live agent tools and post-call analysis.
        </div>
      )}

      <div className="space-y-2">
        {list.map((r) => <RequestCard key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
      </div>
    </div>
  );
}

function overdue(r: CcRequest): boolean {
  const t = r.callback_at ?? r.due_at;
  return !!t && new Date(t) < new Date() && !["resolved", "closed_no_action"].includes(r.state);
}

function RequestCard({ r, open, onToggle }: { r: CcRequest; open: boolean; onToggle: () => void }) {
  const late = overdue(r);
  return (
    <div className={`overflow-hidden rounded-xl border bg-ops-surface shadow-card ${late ? "border-red-500/40" : "border-ops-border"}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ops-border/20">
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-ops-text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ops-text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge meta={STATE_META[r.state]} />
            <span className="rounded-full bg-ops-border px-2 py-0.5 text-[11px] text-ops-text-muted">{QUEUE_LABEL[r.queue] ?? r.queue}</span>
            {r.priority !== "normal" && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-400">{r.priority}</span>}
            {r.needs_scheduling && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-500">needs scheduling</span>}
            {late && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-400">overdue</span>}
            <span className="font-medium text-ops-text">{r.contact_name || r.business_name || r.phone_e164 || r.from_number || "Unknown contact"}</span>
          </div>
          <div className="mt-0.5 truncate text-sm text-ops-text-muted">{r.concern || r.conversation_summary || r.reason}</div>
        </div>
        <div className="shrink-0 text-right text-xs text-ops-text-muted">
          <div>{r.owner_email || "unassigned"}</div>
          <div>{r.callback_at ? `callback ${fmtWhen(r.callback_at)}` : fmtWhen(r.created_at)}</div>
        </div>
      </button>
      {open && <RequestActions r={r} />}
    </div>
  );
}

function RequestActions({ r }: { r: CcRequest }) {
  const qc = useQueryClient();
  const [owner, setOwner] = useState(r.owner_email ?? "");
  const [note, setNote] = useState("");
  const [snoozeReason, setSnoozeReason] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [resolution, setResolution] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/requests/${r.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ["cc"] }); },
    onError: (e: Error) => setErr(e.message),
  });
  const attempt = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/requests/${r.id}/attempts`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ["cc"] }); },
    onError: (e: Error) => setErr(e.message),
  });

  const busy = patch.isPending || attempt.isPending;
  const phone = r.phone_e164 || r.from_number;
  const window_ = r.callback_window_raw;

  return (
    <div className="space-y-4 border-t border-ops-border px-5 py-4">
      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">{err}</div>}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Request</div>
          <p className="text-sm text-ops-text">{r.concern || "—"}</p>
          <div className="mt-2 space-y-0.5 text-xs text-ops-text-muted">
            {window_ && <div>Asked for: <span className="text-ops-text">“{window_}”</span>{r.needs_scheduling && " — timezone unconfirmed, schedule below"}</div>}
            {r.order_reference && <div>Order ref: <span className="text-ops-text">{r.order_reference}</span></div>}
            {(r.product_refs ?? []).length > 0 && <div>Products: {(r.product_refs as any[]).map((p) => `${p.name}${p.qty ? ` ×${p.qty}` : ""}`).join(", ")}</div>}
            {r.wholesale_refs?.orderRef && <div>Existing wholesale order: <span className="text-brand-blue-500">{String(r.wholesale_refs.orderRef)}</span> ({String(r.wholesale_refs.status ?? "")})</div>}
            {r.contact_permission === false && <div className="text-red-400">Customer declined contact — do not call.</div>}
            <div>Source: {r.source === "live_tool" ? "saved live during the conversation" : r.source === "webhook_analysis" ? "post-call analysis" : "staff"} · {r.attempt_count ?? 0} attempt(s){r.last_attempt_at ? `, last ${fmtWhen(r.last_attempt_at)}` : ""}</div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Owner</div>
          <div className="flex gap-2">
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="email@…" aria-label="Owner email"
              className="w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none" />
            <button type="button" disabled={busy} onClick={() => patch.mutate({ owner_email: owner || null })}
              className="rounded-lg bg-fitscript-green px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Set</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["in_progress", "awaiting_customer"].map((s) => (
              <button key={s} type="button" disabled={busy} onClick={() => patch.mutate({ state: s })}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${r.state === s ? "border-brand-blue-500 text-brand-blue-500" : "border-ops-border text-ops-text-muted hover:text-ops-text"}`}>
                {STATE_META[s].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Call customer: honest about what's connected. The tracked browser dialer
          needs a telephony provider; until then this is a labeled phone-app link
          plus explicit outcome logging. Logging an attempt never closes the task. */}
      <div>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Call customer</div>
        {r.contact_permission === false ? (
          <div className="text-sm text-red-400">Contact was explicitly declined.</div>
        ) : phone ? (
          <div className="flex flex-wrap items-center gap-2">
            <a href={`tel:${phone}`} className="inline-flex items-center gap-1.5 rounded-lg bg-fitscript-green px-3 py-1.5 text-sm font-medium text-white">
              <Phone className="h-4 w-4" /> {phone}
            </a>
            <span className="text-[11px] text-ops-text-muted">Opens your phone app (temporary fallback — the in-browser dialer activates once a telephony provider is connected in Settings). Log the outcome:</span>
            {(["connected", "no_answer", "voicemail", "failed"] as const).map((o) => (
              <button key={o} type="button" disabled={busy} onClick={() => attempt.mutate({ outcome: o, provider: "manual" })}
                className="rounded-lg border border-ops-border px-2.5 py-1 text-xs font-medium text-ops-text-muted hover:text-ops-text">{o.replace("_", " ")}</button>
            ))}
          </div>
        ) : (
          <div className="text-sm text-ops-text-muted">No phone number on this request{r.email_norm ? ` — email is ${r.email_norm}` : ""}.</div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted"><CalendarClock className="h-3.5 w-3.5" />Schedule callback (ET)</div>
          <div className="flex gap-2">
            <input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} aria-label="Callback time"
              className="w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none" />
            <button type="button" disabled={busy || !callbackAt}
              onClick={() => patch.mutate({ callback_at: new Date(callbackAt).toISOString(), callback_tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}
              className="rounded-lg border border-ops-border px-3 py-1.5 text-sm text-ops-text-muted hover:text-ops-text disabled:opacity-50">Set</button>
          </div>
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted"><Moon className="h-3.5 w-3.5" />Snooze</div>
          <div className="flex gap-2">
            <input value={snoozeReason} onChange={(e) => setSnoozeReason(e.target.value)} placeholder="Reason (required)" aria-label="Snooze reason"
              className="w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none" />
            {[1, 3].map((days) => (
              <button key={days} type="button" disabled={busy || !snoozeReason.trim()}
                onClick={() => patch.mutate({ snooze_until: new Date(Date.now() + days * 86400_000).toISOString(), snooze_reason: snoozeReason })}
                className="rounded-lg border border-ops-border px-2.5 py-1.5 text-sm text-ops-text-muted hover:text-ops-text disabled:opacity-50">{days}d</button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted"><CheckCircle2 className="h-3.5 w-3.5" />Outcome</div>
          <div className="flex gap-2">
            <input value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What happened" aria-label="Resolution"
              className="w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none" />
            <button type="button" disabled={busy || !resolution.trim()} onClick={() => patch.mutate({ state: "resolved", resolution })}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Resolve</button>
            <button type="button" disabled={busy} onClick={() => patch.mutate({ state: "closed_no_action", resolution: resolution || "No action needed" })}
              className="rounded-lg border border-ops-border px-3 py-1.5 text-sm text-ops-text-muted hover:text-ops-text disabled:opacity-50">Close</button>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the timeline…" aria-label="Note"
          onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) { patch.mutate({ note }); setNote(""); } }}
          className="w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none" />
        <button type="button" disabled={busy || !note.trim()} onClick={() => { patch.mutate({ note }); setNote(""); }}
          className="rounded-lg border border-ops-border px-3 py-1.5 text-sm text-ops-text-muted hover:text-ops-text disabled:opacity-50">Note</button>
      </div>
    </div>
  );
}
