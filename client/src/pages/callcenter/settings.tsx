import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, Download, Plus, Trash2 } from "lucide-react";
import { PageHero } from "../../components/page-hero";
import { useCc, api, fmtWhen } from "./api";
import { Link } from "wouter";

interface Dest { key: string; label: string; number: string; hours: string | null; enabled: boolean }
interface Health {
  retell: { configured: boolean; agents: number };
  webhook: { url: string; lastReceived: string | null; inbox: Record<string, number> };
  reconcile: Array<{ key: string; value: any; updated_at: string }>;
  phone: { connected: boolean; note?: string; numbers?: string[] };
  sms: { connected: boolean; note?: string };
  dialer: { connected: boolean; note?: string };
  verification: { connected: boolean; note?: string };
  sendResource: { connected: boolean; note?: string };
  commerce: { site: string; catalog: { lastOk: string | null; lastError: string | null; source: string } };
  handoffDestinations: Dest[];
}

export default function CallCenterSettings() {
  const qc = useQueryClient();
  const q = useCc<Health>(["health"], "/health", { refetchInterval: 60_000 });
  const dead = useCc<{ rows: Array<{ id: number; event_type: string; external_id: string | null; attempts: number; last_error: string | null; received_at: string }> }>(
    ["deadletters"], "/deadletters", { refetchInterval: 60_000 });

  const [msg, setMsg] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: ({ path }: { path: string }) => api<any>(path, { method: "POST" }),
    onSuccess: (r: any) => { setMsg(r.note ? `Done — ${r.note}` : `Done${r.calls !== undefined ? ` — ${r.calls} calls, ${r.chats} chats refreshed` : ""}`); qc.invalidateQueries({ queryKey: ["cc"] }); },
    onError: (e: Error) => setMsg(e.message),
  });

  const h = q.data;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides · Call Center"
        title="Settings & health"
        subtitle="What's connected, what isn't yet, and the recovery controls. Nothing here fakes a connection — a capability shows green only after it's configured and tested."
      />

      {msg && <div className="mb-4 rounded-xl border border-ops-border bg-ops-surface px-4 py-2.5 text-sm text-ops-text shadow-card">{msg}</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading health…</div>}

      {h && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Capabilities">
              <Cap ok={h.retell.configured} name="Retell API" note={h.retell.configured ? `${h.retell.agents} RP agents on the allowlist` : "Add RETELL_API_KEY on the Integrations page"} />
              <Cap ok={!!h.webhook.lastReceived} name="Webhook ingestion" note={h.webhook.lastReceived ? `last event ${fmtWhen(h.webhook.lastReceived)}` : `register ${h.webhook.url} via the sync script — no events yet`} />
              <Cap ok={h.phone.connected} name="Phone line" note={h.phone.connected ? (h.phone.numbers ?? []).join(", ") : h.phone.note} />
              <Cap ok={h.sms.connected} name="Two-way SMS" note={h.sms.note} />
              <Cap ok={h.dialer.connected} name="Staff browser dialer" note={h.dialer.note} />
              <Cap ok={h.verification.connected} name="Order verification codes" note={h.verification.note} />
              <Cap ok={h.sendResource.connected} name="Send links to customers" note={h.sendResource.note} />
              <Cap ok={h.commerce.site === "configured"} name="RP site feeds" note={h.commerce.site === "configured" ? "orders + wholesale reachable" : "RP_SITE_API_URL / RP_SITE_OPS_TOKEN missing"} />
              <Cap ok={!h.commerce.catalog.lastError} name="Live catalog" note={h.commerce.catalog.lastError ?? `source: ${h.commerce.catalog.source}`} />
              <div className="mt-3 text-xs text-ops-text-muted">Retell keys live on the <Link href="/realpeptides/integrations" className="text-brand-blue-500 hover:underline">Integrations page</Link>; agent/webhook configuration ships via <code className="text-ops-text">scripts/retell-sync.ts</code> (dry-run → diff → apply, with rollback).</div>
            </Card>

            <Card title="Event pipeline">
              <div className="mb-3 grid grid-cols-4 gap-2 text-center">
                {["pending", "processed", "failed", "dead"].map((s) => (
                  <div key={s} className="rounded-lg border border-ops-border bg-ops-bg p-2">
                    <div className={`text-lg font-semibold tabular-nums ${s === "dead" && (h.webhook.inbox[s] ?? 0) > 0 ? "text-red-400" : "text-ops-text"}`}>{h.webhook.inbox[s] ?? 0}</div>
                    <div className="text-[10.5px] uppercase tracking-wider text-ops-text-muted">{s}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={run.isPending} onClick={() => run.mutate({ path: "/reconcile" })}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-1.5 text-sm font-medium text-ops-text hover:border-ops-border-strong disabled:opacity-50">
                  <RefreshCw className="h-4 w-4" /> Reconcile now
                </button>
                <button type="button" disabled={run.isPending} onClick={() => run.mutate({ path: "/backfill" })}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-1.5 text-sm font-medium text-ops-text hover:border-ops-border-strong disabled:opacity-50">
                  <Download className="h-4 w-4" /> Backfill history
                </button>
              </div>
              <div className="mt-2 text-xs text-ops-text-muted">Reconcile pulls recent Retell calls/chats behind a watermark (webhooks stay the primary path). Backfill resumes from its stored cursor on each run. Neither touches Google Voice history.</div>
              {h.reconcile.map((w) => (
                <div key={w.key} className="mt-2 text-xs text-ops-text-muted">{w.key}: last run {fmtWhen(w.value?.lastRun)} · {w.value?.calls ?? 0} calls, {w.value?.chats ?? 0} chats</div>
              ))}
            </Card>
          </div>

          <HandoffEditor initial={h.handoffDestinations} onSaved={() => qc.invalidateQueries({ queryKey: ["cc"] })} />

          <Card title={`Failed & dead-lettered events (${dead.data?.rows.length ?? 0})`}>
            {!dead.data?.rows.length && <div className="text-sm text-ops-text-muted">Nothing stuck. Failed events retry with backoff; after 5 attempts they land here for replay.</div>}
            <div className="space-y-1.5">
              {(dead.data?.rows ?? []).map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-xs">
                  <span className="font-medium text-ops-text">{r.event_type}</span>
                  <span className="text-ops-text-muted">{r.external_id ?? "—"} · {r.attempts} attempts · {fmtWhen(r.received_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-red-400" title={r.last_error ?? ""}>{r.last_error}</span>
                  <button type="button" disabled={run.isPending} onClick={() => run.mutate({ path: `/inbox/${r.id}/replay` })}
                    className="inline-flex items-center gap-1 rounded-md border border-ops-border px-2 py-1 font-medium text-ops-text-muted hover:text-ops-text">
                    <RotateCcw className="h-3 w-3" /> Replay
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{title}</div>
      {children}
    </div>
  );
}

function Cap({ ok, name, note }: { ok: boolean; name: string; note?: string | null }) {
  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-500"}`} />
      <div className="min-w-0">
        <span className="font-medium text-ops-text">{name}</span>
        <span className={`ml-2 text-xs ${ok ? "text-ops-text-muted" : "text-amber-500"}`}>{ok ? note : note || "not connected"}</span>
      </div>
    </div>
  );
}

/** Approved live-transfer destinations. Agents can ONLY offer what's listed and
 *  enabled here — a transfer number is never inferred from conversation text,
 *  and the public inbound number itself would loop, so don't add it. */
function HandoffEditor({ initial, onSaved }: { initial: Dest[]; onSaved: () => void }) {
  const [dests, setDests] = useState<Dest[]>(initial);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api("/settings", { method: "PATCH", body: JSON.stringify({ handoff_destinations: dests }) }),
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2500); onSaved(); },
  });
  const upd = (i: number, patch: Partial<Dest>) => setDests(dests.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <Card title="Approved live-transfer destinations">
      {!dests.length && <div className="mb-2 text-sm text-ops-text-muted">None configured — agents offer a saved callback instead of a transfer. Never add the public inbound number here (that creates a loop).</div>}
      <div className="space-y-2">
        {dests.map((d, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input value={d.key} onChange={(e) => upd(i, { key: e.target.value })} placeholder="key" aria-label="Destination key"
              className="w-28 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text" />
            <input value={d.label} onChange={(e) => upd(i, { label: e.target.value })} placeholder="Label (e.g. Joshua — support)" aria-label="Destination label"
              className="w-56 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text" />
            <input value={d.number} onChange={(e) => upd(i, { number: e.target.value })} placeholder="+1…" aria-label="Destination number"
              className="w-36 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text" />
            <input value={d.hours ?? ""} onChange={(e) => upd(i, { hours: e.target.value || null })} placeholder="Hours (e.g. 9–5 ET Mon–Fri)" aria-label="Hours"
              className="w-44 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text" />
            <label className="flex items-center gap-1.5 text-sm text-ops-text-muted">
              <input type="checkbox" checked={d.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> enabled
            </label>
            <button type="button" onClick={() => setDests(dests.filter((_, j) => j !== i))} aria-label="Remove destination"
              className="rounded-md p-1.5 text-ops-text-muted hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => setDests([...dests, { key: "", label: "", number: "", hours: null, enabled: false }])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-1.5 text-sm text-ops-text-muted hover:text-ops-text">
          <Plus className="h-4 w-4" /> Add destination
        </button>
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}
          className="rounded-lg bg-fitscript-green px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">Save</button>
        {saved && <span className="text-sm text-emerald-400">Saved.</span>}
        {save.error && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
      </div>
    </Card>
  );
}
