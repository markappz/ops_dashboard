import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Phone, MessageSquare, ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { PageHero } from "../../components/page-hero";
import { useCc, api, Badge, STATE_META, fmtWhen, fmtDuration, type Conversation, type CcRequest } from "./api";
import { Link } from "wouter";

interface ListPayload { conversations: Conversation[]; page: number; agents: Record<string, string> }
interface DetailPayload {
  conversation: Conversation & { transcript: string | null; recording_url: string | null; analysis: any; to_number: string | null; phone_e164: string | null; email_norm: string | null };
  events: Array<{ id: number; actor_type: string; actor: string | null; type: string; data: any; created_at: string }>;
  requests: CcRequest[];
  toolCalls: Array<{ tool: string; status: string; created_at: string; customer_message: string | null }>;
}

const CHANNELS = [
  { key: "", label: "All" },
  { key: "voice", label: "Calls" },
  { key: "chat", label: "Chat" },
];
const FOLLOWUP = [
  { key: "", label: "Any follow-up" },
  { key: "open", label: "Open follow-up" },
  { key: "none", label: "No follow-up" },
];

export default function CallCenterConversations() {
  const [days, setDays] = useState(30);
  const [channel, setChannel] = useState("");
  const [agent, setAgent] = useState("");
  const [followup, setFollowup] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const params = new URLSearchParams({ days: String(days) });
  if (channel) params.set("channel", channel);
  if (agent) params.set("agent", agent);
  if (followup) params.set("followup", followup);
  if (query.trim()) params.set("q", query.trim());
  const q = useCc<ListPayload>(["conversations", days, channel, agent, followup, query], `/conversations?${params}`, { refetchInterval: 30_000 });

  const list = q.data?.conversations ?? [];
  const agents = q.data?.agents ?? {};

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides · Call Center"
        title="Conversations"
        subtitle="Every call and website chat the agents handled, with transcripts, analysis and the follow-up each one produced."
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
            {[7, 30, 90].map((n) => (
              <button key={n} type="button" onClick={() => setDays(n)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${days === n ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>{n}d</button>
            ))}
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ops-text-muted" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Customer, number, email, order, product…"
            aria-label="Search conversations"
            className="w-72 rounded-xl border border-ops-border bg-ops-surface py-2 pl-9 pr-3 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-brand-blue-500 focus:outline-none"
          />
        </div>
        <Select value={channel} onChange={setChannel} options={CHANNELS} aria="Channel" />
        <Select value={agent} onChange={setAgent} aria="Agent"
          options={[{ key: "", label: "All agents" }, ...Object.entries(agents).map(([k, v]) => ({ key: k, label: v }))]} />
        <Select value={followup} onChange={setFollowup} options={FOLLOWUP} aria="Follow-up status" />
      </div>

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading conversations…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.data && !list.length && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-10 text-center text-sm text-ops-text-muted shadow-card">
          No conversations in this window yet. They appear here the moment Retell sends the first webhook (or after a reconcile pull from Settings).
        </div>
      )}

      <div className="space-y-2">
        {list.map((c) => (
          <ConversationRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} />
        ))}
      </div>
    </div>
  );
}

function Select({ value, onChange, options, aria }: { value: string; onChange: (v: string) => void; options: Array<{ key: string; label: string }>; aria: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={aria}
      className="rounded-xl border border-ops-border bg-ops-surface px-3 py-2 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none">
      {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  );
}

function ConversationRow({ c, open, onToggle }: { c: Conversation; open: boolean; onToggle: () => void }) {
  const failed = (c.disconnect_reason ?? "").includes("error") || c.provider_status === "error";
  return (
    <div className="overflow-hidden rounded-xl border border-ops-border bg-ops-surface shadow-card">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ops-border/20">
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-ops-text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ops-text-muted" />}
        {c.channel === "voice" ? <Phone className="h-4 w-4 shrink-0 text-brand-blue-500" /> : <MessageSquare className="h-4 w-4 shrink-0 text-violet-400" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ops-text">{c.contact_name || c.business_name || c.from_number || "Web visitor"}</span>
            {c.is_test && <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-500"><FlaskConical className="h-3 w-3" />test</span>}
            {failed && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-400">failed</span>}
            {c.open_state && <Badge meta={STATE_META[c.open_state]} />}
            {c.request_count > 0 && !c.open_state && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-400">handled</span>}
          </div>
          <div className="mt-0.5 truncate text-sm text-ops-text-muted">{c.summary || c.intent || (c.analysis_status === "pending" ? "Analysis pending…" : "No summary")}</div>
        </div>
        <div className="shrink-0 text-right text-xs text-ops-text-muted">
          <div>{fmtWhen(c.started_at)}</div>
          <div>{c.agent_name ?? "—"} · {fmtDuration(c.duration_ms)}</div>
        </div>
      </button>
      {open && <ConversationDetail id={c.id} />}
    </div>
  );
}

export function ConversationDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useCc<DetailPayload>(["conversation", id], `/conversations/${id}`);
  const [showTranscript, setShowTranscript] = useState(false);
  const flagTest = useMutation({
    mutationFn: (is_test: boolean) => api(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ is_test }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cc"] }),
  });

  if (q.isLoading) return <div className="border-t border-ops-border px-5 py-6 text-sm text-ops-text-muted">Loading detail…</div>;
  if (q.error) return <div className="border-t border-ops-border px-5 py-4 text-sm text-red-400">{(q.error as Error).message}</div>;
  const d = q.data!;
  const conv = d.conversation;
  const custom = conv.analysis?.custom_analysis_data ?? {};

  return (
    <div className="space-y-4 border-t border-ops-border px-5 py-4">
      {/* Summary + next step first — never buried under the transcript */}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <SectionLabel>Summary</SectionLabel>
          <p className="text-sm text-ops-text">{conv.summary || "No analysis summary yet."}</p>
          {custom.open_questions && <p className="mt-1 text-sm text-amber-500">Open: {String(custom.open_questions)}</p>}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ops-text-muted">
            {conv.intent && <span>Intent: <span className="text-ops-text">{conv.intent}</span></span>}
            {custom.order_reference && <span>Order ref: <span className="text-ops-text">{String(custom.order_reference)}</span></span>}
            {custom.product_request && <span>Product: <span className="text-ops-text">{String(custom.product_request)}</span></span>}
            <span>ID: {conv.external_id}</span>
          </div>
        </div>
        <div>
          <SectionLabel>Customer</SectionLabel>
          <div className="text-sm text-ops-text">{conv.contact_name || custom.contact_name || "Unknown"}{conv.business_name ? ` · ${conv.business_name}` : ""}</div>
          <div className="mt-1 space-y-0.5 text-xs text-ops-text-muted">
            {conv.from_number && <div>From: {conv.from_number}</div>}
            {conv.phone_e164 && conv.phone_e164 !== conv.from_number && <div>Contact: {conv.phone_e164}</div>}
            {conv.email_norm && <div>Email: {conv.email_norm}</div>}
            <div className="text-[11px]">A matching number suggests the contact — it isn't verified identity.</div>
          </div>
        </div>
      </div>

      {d.requests.length > 0 && (
        <div>
          <SectionLabel>Follow-ups from this conversation</SectionLabel>
          <div className="space-y-1.5">
            {d.requests.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm">
                <Badge meta={STATE_META[r.state]} />
                <span className="text-ops-text">{r.concern?.slice(0, 120) || r.reason}</span>
                <span className="text-xs text-ops-text-muted">· {r.queue}{r.owner_email ? ` · ${r.owner_email}` : " · unassigned"}</span>
                {(r as any).wi_quote_ref && <span className="text-xs text-brand-blue-500">quote {(r as any).wi_quote_ref}</span>}
                <Link href="/realpeptides/call-center/follow-ups" className="ml-auto text-xs font-medium text-brand-blue-500 hover:underline">Work it →</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {d.toolCalls.length > 0 && (
        <div>
          <SectionLabel>Agent tool activity</SectionLabel>
          <div className="space-y-1 text-xs text-ops-text-muted">
            {d.toolCalls.map((t, i) => (
              <div key={i}><span className={t.status === "ok" ? "text-emerald-400" : "text-red-400"}>{t.tool}</span> · {fmtWhen(t.created_at)}{t.customer_message ? ` — "${t.customer_message}"` : ""}</div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-3">
          <SectionLabel>Transcript</SectionLabel>
          {conv.transcript && (
            <button type="button" onClick={() => setShowTranscript(!showTranscript)} className="text-xs font-medium text-brand-blue-500 hover:underline">
              {showTranscript ? "Hide" : "Show"}
            </button>
          )}
          {conv.recording_url && (
            <audio controls preload="none" src={conv.recording_url} className="h-8 max-w-60" aria-label="Call recording" />
          )}
        </div>
        {!conv.transcript && <div className="text-sm text-ops-text-muted">{conv.provider_status === "ended" ? "No transcript was delivered for this conversation." : "Transcript arrives when the conversation ends."}</div>}
        {showTranscript && conv.transcript && (
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-ops-border bg-ops-bg p-3 text-xs leading-relaxed text-ops-text">{conv.transcript}</pre>
        )}
      </div>

      <div>
        <SectionLabel>Timeline</SectionLabel>
        <div className="space-y-1 text-xs text-ops-text-muted">
          {d.events.map((e) => (
            <div key={e.id}>
              <span className="tabular-nums">{fmtWhen(e.created_at)}</span> · <span className="text-ops-text">{e.type}</span>
              {e.actor_type === "staff" && e.actor ? ` by ${e.actor}` : ""}
              {e.type === "note" && e.data?.note ? ` — ${e.data.note}` : ""}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-ops-border pt-3">
        <button type="button" disabled={flagTest.isPending}
          onClick={() => flagTest.mutate(!conv.is_test)}
          className="rounded-lg border border-ops-border px-3 py-1.5 text-xs font-medium text-ops-text-muted hover:text-ops-text">
          {conv.is_test ? "Unflag test session" : "Flag as test session"}
        </button>
        <span className="text-[11px] text-ops-text-muted">Test sessions stay stored but leave every metric.</span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{children}</div>;
}
