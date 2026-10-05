import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Mail, MousePointerClick, Search, ShieldAlert, UserMinus } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * Contact activity — the per-person engagement timeline ("user A opened welcome #2, clicked the
 * EOS broadcast"), per engine brand. Every row comes from the brand's own ledger via its engine
 * bridge; this view is why the webhook writes EmailEvent for every open and click. flowSends is
 * optional in the contract — v1 engines (pawgen, PeptideU) don't serve flows yet, so that card
 * only renders when the payload carries it.
 */

interface Contact {
  email: string; firstName: string | null; source: string; tags: string[]; segments: string[];
  createdAt: string; unsubscribed: boolean; unsubscribedAt: string | null; suppressed: boolean;
  bouncedAt: string | null; complainedAt: string | null;
  sends: number; opens: number; clicks: number;
  lastSendAt: string | null; lastOpenAt: string | null; lastClickAt: string | null;
}
interface Ev { type: string; createdAt: string; broadcastId: string | null; resendId: string | null }
interface FlowSend { stepIndex: number; subject: string; sentAt: string; openedAt: string | null; clickedAt: string | null; bouncedAt: string | null; resendId: string | null; enrollment: { flowKey: string; status: string } }

const TYPE_LABEL: Record<string, { label: string; tone: string }> = {
  "email.sent": { label: "Sent", tone: "border-ops-border text-ops-text-muted" },
  "email.opened": { label: "Opened", tone: "border-brand-blue-500/40 bg-brand-blue-500/10 text-brand-blue-400" },
  "email.clicked": { label: "Clicked", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" },
  "email.bounced": { label: "Bounced", tone: "border-red-500/40 bg-red-500/10 text-red-400" },
  "email.complained": { label: "Spam complaint", tone: "border-red-500/40 bg-red-500/10 text-red-400" },
  "email.unsubscribed": { label: "Unsubscribed", tone: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function EmailActivity({ company }: { company: string }) {
  // Deep-linkable: the Audience table and engagement feed land here with ?email=…
  const fromUrl = new URLSearchParams(window.location.search).get("email");
  const [input, setInput] = useState(fromUrl ?? "");
  const [email, setEmail] = useState<string | null>(fromUrl);
  const q = useQuery({
    queryKey: ["marketing-activity", company, email],
    queryFn: async () => {
      const r = await fetch(`/api/ops/${company}/marketing/activity?email=${encodeURIComponent(email!)}`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as { contact: Contact; events: Ev[]; flowSends?: FlowSend[] };
    },
    enabled: !!email,
    retry: false,
  });

  const d = q.data;
  const flowSends = d?.flowSends;
  const flowByMsg = new Map((flowSends ?? []).filter((f) => f.resendId).map((f) => [f.resendId!, f]));
  const describe = (e: Ev) => {
    if (e.broadcastId) return `broadcast · ${e.broadcastId}`;
    const f = e.resendId ? flowByMsg.get(e.resendId) : null;
    return f ? `${f.enrollment.flowKey} · step ${f.stepIndex + 1} — “${f.subject}”` : "email";
  };

  return (
    <div className="space-y-5">
      <PageHero title="Contact Activity" subtitle="One person's full engagement story — every send, open, click, bounce and unsubscribe, from our own ledger." />
      <form className="flex max-w-xl items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (input.trim()) setEmail(input.trim().toLowerCase()); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="customer@email.com"
          className="flex-1 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-brand-blue-500 focus:outline-none" />
        <button type="submit" disabled={!input.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          <Search size={14} /> Look up
        </button>
      </form>

      {q.isLoading && <Loader2 className="animate-spin text-ops-text-muted" />}
      {q.error && <div className="max-w-xl rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{(q.error as Error).message}</div>}

      {d && (
        <>
          <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-ops-text">{d.contact.firstName ? `${d.contact.firstName} · ` : ""}{d.contact.email}</span>
              {d.contact.unsubscribed && <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400"><UserMinus size={10} /> unsubscribed</span>}
              {d.contact.suppressed && <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400"><ShieldAlert size={10} /> suppressed{d.contact.complainedAt ? " (spam)" : d.contact.bouncedAt ? " (bounce)" : ""}</span>}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-ops-text-muted sm:grid-cols-4">
              <div><Mail size={12} className="mb-0.5 inline" /> {d.contact.sends.toLocaleString()} sends · since {new Date(d.contact.createdAt).toLocaleDateString()}</div>
              <div><MousePointerClick size={12} className="mb-0.5 inline" /> {d.contact.opens.toLocaleString()} opens · {d.contact.clicks.toLocaleString()} clicks</div>
              <div>source: <code className="text-[10px]">{d.contact.source}</code></div>
              <div className="truncate">segments: {d.contact.segments.length ? d.contact.segments.join(", ") : "—"}</div>
            </div>
          </div>

          <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
            <h2 className="mb-2 text-sm font-bold text-ops-text">Timeline <span className="font-normal text-ops-text-muted">· {d.events.length} events{d.events.length === 200 ? " (latest 200)" : ""}</span></h2>
            {!d.events.length && <div className="py-6 text-center text-xs text-ops-text-muted">No ledger events yet — the ledger starts at the tracking instrumentation; older activity shows in the counters above.</div>}
            <ol className="space-y-1.5">
              {d.events.map((e, i) => {
                const t = TYPE_LABEL[e.type] ?? { label: e.type, tone: "border-ops-border text-ops-text-muted" };
                return (
                  <li key={i} className="flex flex-wrap items-center gap-2 border-t border-ops-border/50 pt-1.5 text-xs first:border-t-0 first:pt-0">
                    <span className="w-32 shrink-0 text-[11px] text-ops-text-muted">{when(e.createdAt)}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${t.tone}`}>{t.label}</span>
                    <span className="text-ops-text">{describe(e)}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          {Array.isArray(flowSends) && (
            <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
              <h2 className="mb-2 text-sm font-bold text-ops-text">Flow sends <span className="font-normal text-ops-text-muted">· {flowSends.length}</span></h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead><tr className="text-[10px] uppercase tracking-wide text-ops-text-muted"><th className="pb-1 pr-2 font-medium">Sent</th><th className="pb-1 pr-2 font-medium">Flow · step</th><th className="pb-1 pr-2 font-medium">Subject</th><th className="pb-1 font-medium">Result</th></tr></thead>
                  <tbody>
                    {flowSends.map((f, i) => (
                      <tr key={i} className="border-t border-ops-border/60">
                        <td className="py-1.5 pr-2 text-ops-text-muted">{when(f.sentAt)}</td>
                        <td className="py-1.5 pr-2 text-ops-text">{f.enrollment.flowKey} · {f.stepIndex + 1}</td>
                        <td className="py-1.5 pr-2 text-ops-text">{f.subject}</td>
                        <td className="py-1.5">
                          {f.bouncedAt ? <span className="text-red-400">bounced</span>
                            : f.clickedAt ? <span className="text-emerald-400">clicked {when(f.clickedAt)}</span>
                            : f.openedAt ? <span className="text-brand-blue-400">opened {when(f.openedAt)}</span>
                            : <span className="text-ops-text-muted">delivered</span>}
                        </td>
                      </tr>
                    ))}
                    {!flowSends.length && <tr><td colSpan={4} className="py-4 text-center text-ops-text-muted">No flow sends yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
