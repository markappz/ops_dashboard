import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, Search } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * Audience — the whole list, browsable (Paul, 2026-10-02: "an activity log for the entire
 * audience", the Resend contacts view but ours). Search anyone, see their segments and status
 * at a glance, click through to their full Activity timeline. Below it, the live engagement
 * feed: the latest opens/clicks/bounces across everyone, straight from the ledger.
 */

interface Row { email: string; firstName: string | null; source: string; segments: string[]; createdAt: string; unsubscribed: boolean; suppressed: boolean; sends: number; opens: number; clicks: number }
interface Ev { type: string; email: string; createdAt: string; broadcastId: string | null }

const EV: Record<string, { label: string; tone: string }> = {
  "email.sent": { label: "sent", tone: "text-ops-text-muted" },
  "email.opened": { label: "opened", tone: "text-brand-blue-400" },
  "email.clicked": { label: "clicked", tone: "text-emerald-400" },
  "email.bounced": { label: "bounced", tone: "text-red-400" },
  "email.complained": { label: "spam complaint", tone: "text-red-400" },
  "email.unsubscribed": { label: "unsubscribed", tone: "text-amber-400" },
};

export default function RealPeptidesAudience() {
  const [, navigate] = useLocation();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const contacts = useQuery({
    queryKey: ["rp-audience", q, page],
    queryFn: async () => {
      const r = await fetch(`/api/ops/realpeptides/marketing/contacts?q=${encodeURIComponent(q)}&page=${page}&pageSize=50`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as { total: number; page: number; pageSize: number; rows: Row[] };
    },
    retry: 1,
  });
  const feed = useQuery({
    queryKey: ["rp-audience-feed"],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/marketing/recent-events?limit=60", { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as { events: Ev[] };
    },
    refetchInterval: 60_000,
  });

  const d = contacts.data;
  const pages = typeof d?.total === "number" && d.pageSize ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <PageHero title="Audience" subtitle="Every contact we hold — searchable, with live segment membership. Click anyone for their full activity timeline." />

      <form className="flex max-w-xl items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQ(input.trim()); setPage(1); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search by email or name…"
          className="flex-1 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-brand-blue-500 focus:outline-none" />
        <button type="submit" className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-sm font-semibold text-white"><Search size={14} /> Search</button>
      </form>

      {contacts.error && <div className="max-w-xl rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{String((contacts.error as Error).message)}</div>}

      <div className="rounded-2xl border border-ops-border bg-ops-surface">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-bold text-ops-text">Contacts <span className="font-normal text-ops-text-muted">· {typeof d?.total === "number" ? d.total.toLocaleString() : "…"}{q ? ` matching “${q}”` : ""}</span></span>
          {contacts.isFetching && <Loader2 size={14} className="animate-spin text-ops-text-muted" />}
        </div>
        <div className="overflow-x-auto border-t border-ops-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-ops-text-muted">
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Segments</th>
                <th className="px-4 py-2 font-medium">Engagement</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {(d?.rows ?? []).map((r) => (
                <tr key={r.email} className="cursor-pointer border-t border-ops-border/60 hover:bg-ops-bg/50" onClick={() => navigate(`/realpeptides/activity?email=${encodeURIComponent(r.email)}`)}>
                  <td className="px-4 py-2">
                    <span className="font-medium text-ops-text">{r.email}</span>
                    {r.firstName && <span className="text-ops-text-muted"> · {r.firstName}</span>}
                  </td>
                  <td className="max-w-64 px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      {r.segments.slice(0, 3).map((sg) => <span key={sg} className="rounded-full border border-ops-border px-1.5 py-0.5 text-[10px] text-ops-text-muted">{sg}</span>)}
                      {r.segments.length > 3 && <span className="text-[10px] text-ops-text-muted">+{r.segments.length - 3}</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ops-text-muted">{r.sends} sent · {r.opens} opens · {r.clicks} clicks</td>
                  <td className="px-4 py-2">
                    {r.suppressed ? <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">Suppressed</span>
                      : r.unsubscribed ? <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400">Unsubscribed</span>
                      : <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">Subscribed</span>}
                  </td>
                  <td className="px-4 py-2 text-ops-text-muted">{new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                </tr>
              ))}
              {d && !d.rows.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-ops-text-muted">No contacts match.</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-ops-border px-4 py-2 text-xs text-ops-text-muted">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-ops-border px-2.5 py-1 font-semibold text-ops-text disabled:opacity-30">Newer</button>
            <span>page {page} of {pages.toLocaleString()}</span>
            <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-lg border border-ops-border px-2.5 py-1 font-semibold text-ops-text disabled:opacity-30">Older</button>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
        <h2 className="mb-2 text-sm font-bold text-ops-text">Live engagement <span className="font-normal text-ops-text-muted">· latest events across the whole audience, refreshes every minute</span></h2>
        <ol className="space-y-1">
          {(feed.data?.events ?? []).map((e, i) => {
            const t = EV[e.type] ?? { label: e.type, tone: "text-ops-text-muted" };
            return (
              <li key={i} className="flex flex-wrap items-center gap-2 border-t border-ops-border/40 pt-1 text-xs first:border-t-0 first:pt-0">
                <span className="w-28 shrink-0 text-[11px] text-ops-text-muted">{new Date(e.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                <button type="button" onClick={() => navigate(`/realpeptides/activity?email=${encodeURIComponent(e.email)}`)} className="font-medium text-ops-text hover:underline">{e.email}</button>
                <span className={t.tone}>{t.label}</span>
                {e.broadcastId && <span className="text-ops-text-muted">· {e.broadcastId}</span>}
              </li>
            );
          })}
          {feed.data && !feed.data.events.length && <li className="py-4 text-center text-xs text-ops-text-muted">Quiet right now.</li>}
        </ol>
      </div>
    </div>
  );
}
