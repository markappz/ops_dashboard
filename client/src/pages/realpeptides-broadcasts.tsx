import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Send, Sparkles, Trash2 } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * The broadcast builder — Klaviyo-meets-Resend, in one page (Paul, 2026-10-02): compose on the
 * left, see the REAL rendered email (brand shell, unsubscribe footer) on the right as you type,
 * pick the audience with live counts, test-send to an inbox, then Review & send with the
 * recipient-count confirm. Sent campaigns sit below with their ledger stats.
 *
 * Drafts live in ops_email_plans (shared with the calendar and Josh's MCP), and the send door is
 * the same two-step server gate everything else uses — this page is a better cockpit, not a
 * second engine.
 */

interface Plan { id: number; title: string; subject: string | null; preheader: string | null; status: string; send_date: string | null; audience_id: string | null; html: string | null; resend_broadcast_id: string | null; updated_at: string }
interface Campaign { broadcastId: string; name: string; sentAt?: string; sends: number; uniqueOpens: number; uniqueClicks: number; bounces: number; complaints: number; attributedOrders: number; attributedRevenueCents: number }

const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-brand-blue-500 focus:outline-none";

export default function RealPeptidesBroadcasts() {
  const qc = useQueryClient();
  const plans = useQuery({
    queryKey: ["rp-plans"],
    // The planner answers { plans, resendConnected, defaultFrom } - unwrap to the rows.
    queryFn: async () => {
      const r = await fetch("/api/ops/email-plans?company=realpeptides", { credentials: "include" });
      const j = (await r.json()) as { plans?: Plan[]; error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j.plans ?? [];
    },
  });
  const segments = useQuery({
    queryKey: ["rp-marketing-segments-full"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/marketing/segments", { credentials: "include" })).json() as
      Promise<{ all: number; segments: { slug: string; name: string; count: number }[] }>,
    staleTime: 5 * 60_000,
  });
  const stats = useQuery({
    queryKey: ["rp-email-90"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/email?range=90", { credentials: "include" })).json() as Promise<{ campaigns?: Campaign[] }>,
    staleTime: 10 * 60_000,
  });

  const [planId, setPlanId] = useState<number | null>(null);
  const [f, setF] = useState({ title: "", subject: "", preheader: "", segment: "", html: "" });
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [confirmInfo, setConfirmInfo] = useState<{ recipients: number; segment: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setConfirmInfo(null); };

  function loadPlan(p: Plan) {
    setPlanId(p.id);
    setF({ title: p.title ?? "", subject: p.subject ?? "", preheader: p.preheader ?? "", segment: p.audience_id ?? "", html: p.html ?? "" });
    setMsg(null); setConfirmInfo(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function newDraft() {
    setPlanId(null);
    setF({ title: "", subject: "", preheader: "", segment: "", html: "" });
    setMsg(null); setConfirmInfo(null);
  }

  async function save(): Promise<number | null> {
    setBusy("save"); setMsg(null);
    const body = { company: "realpeptides", title: f.title || f.subject || "Untitled broadcast", subject: f.subject || null, preheader: f.preheader || null, audience_id: f.segment || null, html: f.html || null, status: "draft" };
    const r = await fetch(planId ? `/api/ops/email-plans/${planId}` : "/api/ops/email-plans", {
      method: planId ? "PATCH" : "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); return null; }
    const id = planId ?? j.id;
    setPlanId(id);
    qc.invalidateQueries({ queryKey: ["rp-plans"] });
    return id;
  }

  async function sendTest() {
    if (!(await save())) return;
    setBusy("test");
    const r = await fetch("/api/ops/realpeptides/marketing/test", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: f.subject, html: f.html, to: testTo.trim() }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: `Test sent to ${testTo.trim()}.` } : { tone: "bad", text: j.error || `HTTP ${r.status}` });
  }

  async function reviewOrSend(confirmed: boolean) {
    const id = await save();
    if (!id) return;
    setBusy("send");
    const r = await fetch(`/api/ops/email-plans/${id}/send-rp`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify(confirmed ? { confirm: true } : {}),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setConfirmInfo(null); return setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); }
    if (j.preview) return setConfirmInfo({ recipients: j.recipients, segment: j.segment });
    setConfirmInfo(null);
    setMsg({ tone: "ok", text: `Sent to ${j.sent.toLocaleString()} of ${j.of.toLocaleString()} recipients (${j.tag}).` });
    qc.invalidateQueries({ queryKey: ["rp-plans"] });
  }

  const statByTag = useMemo(() => new Map((stats.data?.campaigns ?? []).map((c) => [c.broadcastId, c])), [stats.data]);
  const drafts = (plans.data ?? []).filter((p) => p.status !== "sent");
  const sent = (plans.data ?? []).filter((p) => p.status === "sent");

  return (
    <div className="space-y-5">
      <PageHero title="Broadcasts" subtitle="Compose, preview exactly what lands in the inbox, test, and send — all from our own engine and audience."
        actions={<div className="flex items-center gap-2">
          <a href="/realpeptides/compose" className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-2 text-xs font-semibold text-ops-text hover:bg-ops-bg"><Sparkles size={13} /> Compose with AI</a>
          <button type="button" onClick={newDraft} className="rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-3 py-2 text-xs font-semibold text-white hover:opacity-95">New broadcast</button>
        </div>} />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ── Compose ─────────────────────────────────────────── */}
        <div className="space-y-3 rounded-2xl border border-ops-border bg-ops-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ops-text">{planId ? `Editing draft #${planId}` : "New broadcast"}</h2>
            {planId && <button type="button" onClick={newDraft} className="text-[11px] text-ops-text-muted hover:text-ops-text">start fresh</button>}
          </div>
          <label className="block text-xs text-ops-text-muted">Campaign name (internal)
            <input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="EOS Sale · Day 1 · Open 180d" className={`${input} mt-1`} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-ops-text-muted">Subject
              <input value={f.subject} onChange={(e) => set("subject", e.target.value)} className={`${input} mt-1`} />
            </label>
            <label className="block text-xs text-ops-text-muted">Preheader
              <input value={f.preheader} onChange={(e) => set("preheader", e.target.value)} className={`${input} mt-1`} />
            </label>
          </div>
          <label className="block text-xs text-ops-text-muted">Audience (live counts · unsubscribed + suppressed excluded)
            <select value={f.segment} onChange={(e) => set("segment", e.target.value)} className={`${input} mt-1`}>
              <option value="">Everyone{segments.data ? ` (${segments.data.all.toLocaleString()})` : ""}</option>
              {(segments.data?.segments ?? []).map((sg) => <option key={sg.slug} value={sg.slug}>{sg.name} ({sg.count.toLocaleString()})</option>)}
            </select>
          </label>
          <label className="block text-xs text-ops-text-muted">Email HTML (the preview adds the brand shell + unsubscribe footer automatically)
            <textarea value={f.html} onChange={(e) => set("html", e.target.value)} rows={14} placeholder="<h1>…</h1> — paste from any builder, or use Compose with AI"
              className={`${input} mt-1 font-mono text-xs leading-relaxed`} />
          </label>

          {msg && <div className={`rounded-lg border px-3 py-2 text-xs ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>{msg.text}</div>}

          {confirmInfo && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
              <span className="text-xs text-amber-300">This sends <b>{confirmInfo.recipients.toLocaleString()}</b> real emails ({confirmInfo.segment === "all" ? "everyone" : `segment ${confirmInfo.segment}`}). No undo.</span>
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => setConfirmInfo(null)} className="text-xs text-ops-text-muted hover:text-ops-text">Cancel</button>
                <button type="button" disabled={busy !== null} onClick={() => reviewOrSend(true)} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40">
                  {busy === "send" ? <Loader2 size={13} className="animate-spin" /> : `Send to ${confirmInfo.recipients.toLocaleString()} now`}
                </button>
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ops-border pt-3">
            <span className="mr-auto flex items-center gap-1.5">
              <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="test inbox…" className="w-40 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-2 text-xs text-ops-text placeholder:text-ops-text-muted focus:outline-none" />
              <button type="button" disabled={busy !== null || !testTo.trim() || !f.subject || !f.html} onClick={sendTest}
                className="rounded-lg border border-ops-border px-3 py-2 text-xs font-semibold text-ops-text hover:bg-ops-bg disabled:opacity-40">
                {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : "Send test"}
              </button>
            </span>
            <button type="button" disabled={busy !== null || !f.title.trim()} onClick={() => void save()}
              className="rounded-lg border border-ops-border px-4 py-2 text-sm text-ops-text hover:bg-ops-bg disabled:opacity-40">
              {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : "Save draft"}
            </button>
            <button type="button" disabled={busy !== null || !f.subject || !f.html || !!confirmInfo} onClick={() => reviewOrSend(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
              {busy === "send" && !confirmInfo ? <Loader2 size={14} className="animate-spin" /> : <Send size={13} />} Review &amp; send
            </button>
          </div>
        </div>

        {/* ── Live preview ────────────────────────────────────── */}
        <LivePreview subject={f.subject} preheader={f.preheader} html={f.html} />
      </div>

      {/* ── Drafts & sent ─────────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-ops-text">Drafts &amp; scheduled <span className="font-normal text-ops-text-muted">· {drafts.length}</span></h2>
          {!drafts.length && <div className="py-4 text-center text-xs text-ops-text-muted">Nothing in progress — start one above or ✨ Compose with AI.</div>}
          {drafts.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 border-t border-ops-border/60 py-2 text-xs first:border-t-0">
              <span className="min-w-0">
                <span className="block truncate font-medium text-ops-text">{p.title}</span>
                <span className="text-[11px] text-ops-text-muted">{p.status}{p.audience_id ? ` · ${p.audience_id}` : " · everyone"}{p.send_date ? ` · ${String(p.send_date).slice(0, 10)}` : ""} · by {p.id}</span>
              </span>
              <button type="button" onClick={() => loadPlan(p)} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg"><Eye size={11} /> Open</button>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-ops-text">Sent <span className="font-normal text-ops-text-muted">· stats from our ledger</span></h2>
          {!sent.length && <div className="py-4 text-center text-xs text-ops-text-muted">No sends from the new engine yet.</div>}
          {sent.map((p) => {
            const st = p.resend_broadcast_id ? statByTag.get(p.resend_broadcast_id) : undefined;
            return (
              <div key={p.id} className="border-t border-ops-border/60 py-2 text-xs first:border-t-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ops-text">{p.title}</span>
                  <span className="shrink-0 text-[11px] text-ops-text-muted">{new Date(p.updated_at).toLocaleDateString()}</span>
                </div>
                <div className="text-[11px] text-ops-text-muted">
                  {st ? <>{st.sends.toLocaleString()} sent · {st.uniqueOpens.toLocaleString()} opens · {st.uniqueClicks.toLocaleString()} clicks · {st.attributedOrders} orders (${(st.attributedRevenueCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })})</> : "stats land as webhook events arrive"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LivePreview({ subject, preheader, html }: { subject: string; preheader: string; html: string }) {
  const [doc, setDoc] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(timer.current);
    if (!html.trim()) { setDoc(""); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/ops/realpeptides/marketing/render-broadcast", {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ html }),
        });
        const j = await r.json();
        if (r.ok) setDoc(j.html);
      } finally { setLoading(false); }
    }, 600);
    return () => clearTimeout(timer.current);
  }, [html]);
  return (
    <div className="rounded-2xl border border-ops-border bg-ops-surface p-4 xl:sticky xl:top-4 xl:self-start">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold text-ops-text">Inbox preview</h2>
        {loading && <Loader2 size={13} className="animate-spin text-ops-text-muted" />}
      </div>
      <div className="mb-2 rounded-lg border border-ops-border bg-ops-bg px-3 py-2">
        <div className="truncate text-xs font-semibold text-ops-text">{subject || <span className="text-ops-text-muted">Subject line…</span>}</div>
        <div className="truncate text-[11px] text-ops-text-muted">{preheader || "Preheader…"}</div>
      </div>
      {doc
        ? <iframe title="Broadcast preview" sandbox="" srcDoc={doc} className="h-[64vh] w-full rounded-lg border border-ops-border bg-white" />
        : <div className="flex h-[64vh] items-center justify-center rounded-lg border border-dashed border-ops-border text-xs text-ops-text-muted">The rendered email appears here as you type — brand shell and unsubscribe footer included.</div>}
    </div>
  );
}
