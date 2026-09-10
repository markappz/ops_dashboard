import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wand2, X, ExternalLink, Check, Ban, RotateCcw } from "lucide-react";

/**
 * "Request a change": anyone on the team describes what the dashboard should
 * do differently. The request is queued, posted to Slack, and Claude Code
 * builds it into a pull request; admins approve or reject in Settings →
 * Requests. Approve merges and CI deploys.
 */

export interface ChangeRequest {
  id: number; company: string | null; area: string | null; title: string; body: string; requested_by: string;
  status: "queued" | "building" | "pr_open" | "failed" | "approved" | "merged" | "rejected";
  branch: string | null; pr_number: number | null; pr_url: string | null; summary: string | null; error: string | null;
  decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string;
}

const STATUS: Record<ChangeRequest["status"], { label: string; cls: string }> = {
  queued: { label: "queued", cls: "bg-ops-border text-ops-text-muted" },
  building: { label: "building", cls: "bg-amber-500/15 text-amber-500" },
  pr_open: { label: "ready to review", cls: "bg-brand-blue-500/15 text-brand-blue-500" },
  failed: { label: "failed", cls: "bg-red-500/15 text-red-400" },
  approved: { label: "approved", cls: "bg-fitscript-green/15 text-fitscript-green" },
  merged: { label: "live", cls: "bg-fitscript-green/15 text-fitscript-green" },
  rejected: { label: "rejected", cls: "bg-ops-border text-ops-text-muted" },
};

const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-subtle focus:border-fitscript-green focus:outline-none";

export function RequestChangeButton({ area, company, className }: { area: string; company?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "inline-flex items-center gap-1.5 rounded-lg border border-ops-border bg-ops-surface px-3 py-2 text-sm text-ops-text hover:border-ops-text-muted"} title="Ask for a change to this page — Claude Code builds it, Paul approves">
        <Wand2 size={15} /> Request a change
      </button>
      {open && <RequestChangeModal area={area} company={company} onClose={() => setOpen(false)} />}
    </>
  );
}

function RequestChangeModal({ area, company, onClose }: { area: string; company?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [done, setDone] = useState<ChangeRequest | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/ops/change-requests", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, body, area, company }) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.statusText);
      return j as ChangeRequest;
    },
    onSuccess: (r) => { setDone(r); qc.invalidateQueries({ queryKey: ["change-requests"] }); },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-2xl bg-ops-surface shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Request a change · {area}</h2>
            <p className="text-xs text-ops-text-muted">Describe it like you'd tell a developer. It's built into a pull request; Paul approves before it goes live.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        {done ? (
          <div className="space-y-3 p-5 text-sm text-ops-text">
            <div>Request <strong>#{done.id}</strong> filed{done.status === "building" ? " — Claude Code is building it now." : " — queued for a human."}</div>
            <div className="text-xs text-ops-text-muted">You'll see it in Settings → Requests with a status. Paul gets a Slack ping and approves or rejects it there.</div>
            <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-lg bg-fitscript-green px-3 py-2 text-sm font-medium text-white">Done</button></div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3 p-5">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="One line — e.g. Show weeks of cover on the PO PDF" className={input} required autoFocus />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="What should change, where, and why. Mention the exact column, button or number if you can." className={input} required />
            {m.isError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{(m.error as Error).message}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-ops-border px-3 py-2 text-sm text-ops-text">Cancel</button>
              <button type="submit" disabled={m.isPending || !title.trim() || !body.trim()} className="rounded-lg bg-fitscript-green px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{m.isPending ? "Filing…" : "File request"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Settings → Requests: the queue with approve / reject / retry. */
export function ChangeRequestsPanel() {
  const qc = useQueryClient();
  const me = useQuery<{ role?: string }>({ queryKey: ["ops-me"], queryFn: () => fetch("/api/ops/auth/me", { credentials: "include" }).then((r) => r.json()), staleTime: Infinity });
  const isAdmin = me.data?.role !== "viewer";
  const q = useQuery<{ requests: ChangeRequest[]; pipeline: { github: boolean; ci: boolean; repo: string } }>({
    queryKey: ["change-requests"],
    queryFn: () => fetch("/api/ops/change-requests", { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30_000,
  });
  const act = useMutation({
    mutationFn: async ({ id, path, body }: { id: number; path: string; body?: unknown }) => {
      const r = await fetch(`/api/ops/change-requests/${id}/${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.statusText);
      return j;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["change-requests"] }),
  });
  const rows = q.data?.requests ?? [];
  const p = q.data?.pipeline;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ops-text-muted">Plain-English requests from the team. Claude Code builds each one into a pull request on <span className="text-ops-text">{p?.repo}</span>; approving merges it and CI deploys.</p>
        <RequestChangeButton area="settings" />
      </div>
      {p && (!p.github || !p.ci) && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
          Pipeline not fully configured: {!p.github && "GitHub token missing on ops. "}{!p.ci && "OPS_CI_TOKEN missing on ops. "}Requests still queue and post to Slack.
        </div>
      )}
      {act.isError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{(act.error as Error).message}</div>}
      {!rows.length && !q.isLoading && <div className="rounded-xl border border-dashed border-ops-border p-8 text-center text-sm text-ops-text-muted">No requests yet. Every page with a "Request a change" button files here.</div>}
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-ops-border bg-ops-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ops-text">#{r.id} · {r.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS[r.status]?.cls ?? ""}`}>{STATUS[r.status]?.label ?? r.status}</span>
                </div>
                <div className="mt-0.5 text-xs text-ops-text-muted">{r.requested_by} · {r.area ?? "—"}{r.company ? ` · ${r.company}` : ""} · {new Date(r.created_at).toLocaleString()}{r.decided_by ? ` · ${r.status} by ${r.decided_by}` : ""}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {r.pr_url && <a href={r.pr_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1.5 text-xs text-ops-text hover:border-ops-text-muted"><ExternalLink size={12} /> PR #{r.pr_number}</a>}
                {isAdmin && r.status === "pr_open" && (
                  <>
                    <button type="button" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, path: "decide", body: { decision: "approve" } })} className="inline-flex items-center gap-1 rounded-lg bg-fitscript-green px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"><Check size={12} /> Approve & deploy</button>
                    <button type="button" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, path: "decide", body: { decision: "reject" } })} className="inline-flex items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1.5 text-xs text-ops-text-muted hover:text-red-400 disabled:opacity-50"><Ban size={12} /> Reject</button>
                  </>
                )}
                {isAdmin && (r.status === "failed" || r.status === "queued") && (
                  <button type="button" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, path: "retry" })} className="inline-flex items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1.5 text-xs text-ops-text hover:border-ops-text-muted disabled:opacity-50"><RotateCcw size={12} /> Retry</button>
                )}
                {isAdmin && (r.status === "failed" || r.status === "queued" || r.status === "building") && (
                  <button type="button" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, path: "decide", body: { decision: "reject" } })} className="rounded-lg px-2 py-1.5 text-xs text-ops-text-muted hover:text-red-400 disabled:opacity-50">Dismiss</button>
                )}
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ops-text">{r.body}</p>
            {r.summary && <div className="mt-2 rounded-lg border border-ops-border bg-ops-bg/50 p-3 text-xs text-ops-text"><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ops-text-muted">What Claude Code changed</div><div className="whitespace-pre-wrap">{r.summary}</div></div>}
            {r.error && <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400 whitespace-pre-wrap">{r.error}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
