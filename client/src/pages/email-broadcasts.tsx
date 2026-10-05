import { useEffect, useMemo, useRef, useState } from "react";
import { CampaignDetail, type CampaignLike } from "../components/campaign-detail";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEngine } from "@/hooks/use-engines";
import { Check, Eye, Loader2, Monitor, Pencil, Send, Smartphone, Sparkles, X } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * The broadcast builder — the daily driver for Josh and the team (Paul, 2026-10-02: "make it
 * special, a beautiful UX, easy for staff"), generalized to every brand with its own engine
 * (brand-engines registry): write it, pick who gets it, watch the rendered email update as you
 * type, test it to your own inbox, then Review & send with the live recipient count standing
 * between you and the audience.
 *
 * Plumbing rules that must not regress:
 *  - Every html payload from this page ships base64 (html_b64): the WAF in front of ops eats
 *    raw email HTML in JSON. The ops server decodes; the ops→site leg is direct ALB.
 *  - Sending is two-step SERVER-side (send-rp): no confirm, no send - a UI bug cannot skip it.
 *  - Drafts are ops_email_plans rows, shared with the calendar (and, for RP, the rp-email MCP).
 */

interface Plan { id: number; title: string; subject: string | null; preheader: string | null; status: string; send_date: string | null; audience_id: string | null; html: string | null; resend_broadcast_id: string | null; updated_at: string; created_by?: string }
interface Campaign { broadcastId: string; name: string; sentAt?: string; sends: number; uniqueOpens: number; uniqueClicks: number; openRate: number | null; clickRate: number | null; bounces: number; complaints: number; attributedOrders: number; attributedRevenueCents: number }
interface Segment { slug: string; name: string; description: string; count: number }

const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-brand-blue-500 focus:outline-none";

/** Rich HTML in JSON trips the WAF in front of ops, so every html payload ships base64. */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const SectionLabel = ({ n, children }: { n: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-2">
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-blue-500/15 text-[10px] font-bold text-brand-blue-400">{n}</span>
    <span className="text-[11px] font-semibold uppercase tracking-wider text-ops-text-muted">{children}</span>
  </div>
);

function CharCount({ value, ideal, max }: { value: string; ideal: number; max: number }) {
  const n = value.length;
  const tone = n === 0 ? "text-ops-text-muted" : n <= ideal ? "text-emerald-400" : n <= max ? "text-amber-400" : "text-red-400";
  return <span className={`text-[10px] tabular-nums ${tone}`}>{n}{n > ideal ? `/${max}` : ""}</span>;
}

export default function EmailBroadcasts({ company, label }: { company: string; label: string }) {
  const qc = useQueryClient();
  const engine = useEngine(company);
  const plans = useQuery({
    queryKey: ["email-plans-list", company],
    // The planner answers { plans, resendConnected, defaultFrom } - unwrap to the rows.
    queryFn: async () => {
      const r = await fetch(`/api/ops/email-plans?company=${company}`, { credentials: "include" });
      const j = (await r.json()) as { plans?: Plan[]; error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j.plans ?? [];
    },
  });
  const segments = useQuery({
    queryKey: ["marketing-segments", company],
    queryFn: async () => {
      const r = await fetch(`/api/ops/${company}/marketing/segments`, { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as { all: number; segments: Segment[] };
    },
    staleTime: 5 * 60_000,
  });
  const stats = useQuery({
    queryKey: ["brand-email-90", company],
    queryFn: async () => (await fetch(`/api/ops/${company}/email?range=90`, { credentials: "include" })).json() as Promise<{ campaigns?: Campaign[] }>,
    staleTime: 10 * 60_000,
  });

  const [planId, setPlanId] = useState<number | null>(null);
  const [f, setF] = useState({ title: "", subject: "", preheader: "", segment: "", html: "" });
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testTo, setTestTo] = useState<string>(() => {
    try {
      return localStorage.getItem(`ops-test-inbox-${company}`)
        ?? (company === "realpeptides" ? localStorage.getItem("rp-test-inbox") : null)
        ?? "";
    } catch { return ""; }
  });
  const [confirmInfo, setConfirmInfo] = useState<{ recipients: number; segment: string } | null>(null);
  const [sentInfo, setSentInfo] = useState<{ sent: number; of: number; tag: string; subject: string } | null>(null);
  const [openCampaign, setOpenCampaign] = useState<CampaignLike | null>(null);
  const [listTab, setListTab] = useState<"sent" | "drafts">("sent");
  // "Send later": date/time/zone for the server-side scheduler. Zone is the wall clock the
  // time means — not per-recipient (tz segments exist for that targeting).
  const [sched, setSched] = useState<{ on: boolean; date: string; time: string; tz: string; confirm: null | { recipients: number; segment: string } }>(
    { on: false, date: "", time: "09:00", tz: "America/Los_Angeles", confirm: null });
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setConfirmInfo(null); };

  const selectedSegment = segments.data?.segments?.find((sg) => sg.slug === f.segment);
  const reach = f.segment ? selectedSegment?.count : segments.data?.all;

  async function loadPlan(p: Plan) {
    setPlanId(p.id);
    setMsg(null); setConfirmInfo(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    // The list omits the heavy html column - fetch the full plan for the editor.
    const r = await fetch(`/api/ops/email-plans/${p.id}`, { credentials: "include" });
    const full = r.ok ? await r.json() : p;
    setF({ title: full.title ?? "", subject: full.subject ?? "", preheader: full.preheader ?? "", segment: full.audience_id ?? "", html: full.html ?? "" });
  }
  function newDraft() {
    setPlanId(null);
    setF({ title: "", subject: "", preheader: "", segment: "", html: "" });
    setMsg(null); setConfirmInfo(null);
  }

  async function save(): Promise<number | null> {
    setBusy("save"); setMsg(null);
    const body = { company, title: f.title || f.subject || "Untitled broadcast", subject: f.subject || null, preheader: f.preheader || null, audience_id: f.segment || null, html_b64: f.html ? b64(f.html) : null, status: "draft" };
    const r = await fetch(planId ? `/api/ops/email-plans/${planId}` : "/api/ops/email-plans", {
      method: planId ? "PATCH" : "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); return null; }
    const id = planId ?? j.id;
    setPlanId(id);
    qc.invalidateQueries({ queryKey: ["email-plans-list", company] });
    return id;
  }

  async function sendTest() {
    if (!(await save())) return;
    setBusy("test");
    try { localStorage.setItem(`ops-test-inbox-${company}`, testTo.trim()); } catch { /* convenience only */ }
    const r = await fetch(`/api/ops/${company}/marketing/test`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: f.subject, html_b64: b64(f.html), to: testTo.trim() }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: `Test sent to ${testTo.trim()} — check that inbox before the real send.` } : { tone: "bad", text: j.error || `HTTP ${r.status}` });
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
    // Clear the loaded email the moment it has sent (Paul 10-02: a sent blast must never sit
    // in the builder looking one click from re-sending) and show the confirmation screen.
    setSentInfo({ sent: j.sent, of: j.of, tag: j.tag, subject: f.subject });
    setPlanId(null);
    setF({ title: "", subject: "", preheader: "", segment: "", html: "" });
    setMsg(null);
    qc.invalidateQueries({ queryKey: ["email-plans-list", company] });
  }

  async function scheduleIt(confirmed: boolean) {
    if (!sched.date || !sched.time) { setMsg({ tone: "bad", text: "Pick the date and time first." }); return; }
    if (!confirmed) {
      // Same server preview the send uses - the count shown is the count that fires.
      const id = await save();
      if (!id) return;
      setBusy("schedule");
      const r = await fetch(`/api/ops/email-plans/${id}/send-rp`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      setBusy(null);
      if (!r.ok) return setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
      setSched((x) => ({ ...x, confirm: { recipients: j.recipients, segment: j.segment } }));
      return;
    }
    setBusy("schedule");
    const r = await fetch(`/api/ops/email-plans/${planId}`, {
      method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "scheduled", send_date: sched.date, send_time: sched.time, send_tz: sched.tz }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setSched((x) => ({ ...x, confirm: null })); return setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` }); }
    const tzShort = sched.tz === "America/Los_Angeles" ? "PT" : sched.tz === "America/Denver" ? "MT" : sched.tz === "America/Chicago" ? "CT" : "ET";
    setMsg({ tone: "ok", text: `Scheduled — fires automatically ${sched.date} at ${sched.time} ${tzShort}. It's in Drafts & scheduled below; set it back to draft to cancel.` });
    setSched({ on: false, date: "", time: "09:00", tz: sched.tz, confirm: null });
    setPlanId(null);
    setF({ title: "", subject: "", preheader: "", segment: "", html: "" });
    qc.invalidateQueries({ queryKey: ["email-plans-list", company] });
  }

  const statByTag = useMemo(() => new Map((stats.data?.campaigns ?? []).map((c) => [c.broadcastId, c])), [stats.data]);
  const byNewest = (a: Plan, b: Plan) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  const drafts = (plans.data ?? []).filter((p) => p.status !== "sent").sort(byNewest);
  const sent = (plans.data ?? []).filter((p) => p.status === "sent").sort(byNewest);

  return (
    <div className="space-y-5">
      <PageHero title="Broadcasts" subtitle="Write it, watch the real email render as you type, test it, send it — all from our own engine and audience."
        actions={<div className="flex items-center gap-2">
          <a href={`/${company}/compose`} className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-2 text-xs font-semibold text-ops-text hover:bg-ops-bg"><Sparkles size={13} /> Compose with AI</a>
          <button type="button" onClick={newDraft} className="rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-3 py-2 text-xs font-semibold text-white hover:opacity-95">New broadcast</button>
        </div>} />

      {engine && !engine.configured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {label}&rsquo;s email engine isn&rsquo;t connected to ops yet (env pending) &mdash; drafts save fine, but segments, tests and sends light up once it&rsquo;s staged.
        </div>
      )}
      {plans.error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{String((plans.error as Error).message)}</div>}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ── Compose ─────────────────────────────────────────── */}
        <div className="space-y-4 rounded-2xl border border-ops-border bg-ops-surface p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Name this campaign…"
              className="w-full bg-transparent text-base font-semibold text-ops-text placeholder:text-ops-text-muted focus:outline-none" />
            {planId
              ? <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ops-text-muted"><Pencil size={11} /> draft #{planId} <button type="button" onClick={newDraft} className="text-brand-blue-400 hover:underline">new</button></span>
              : <span className="shrink-0 text-[11px] text-ops-text-muted">unsaved</span>}
          </div>

          <div className="space-y-2">
            <SectionLabel n="1">Message</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-ops-text-muted">
                <span className="flex items-center justify-between">Subject <CharCount value={f.subject} ideal={50} max={80} /></span>
                <input value={f.subject} onChange={(e) => set("subject", e.target.value)} placeholder="The one line that earns the open" className={`${input} mt-1`} />
              </label>
              <label className="block text-xs text-ops-text-muted">
                <span className="flex items-center justify-between">Preheader <CharCount value={f.preheader} ideal={90} max={140} /></span>
                <input value={f.preheader} onChange={(e) => set("preheader", e.target.value)} placeholder="The gray line after the subject" className={`${input} mt-1`} />
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <SectionLabel n="2">Audience</SectionLabel>
            <select value={f.segment} onChange={(e) => set("segment", e.target.value)} className={input}>
              <option value="">Everyone mailable{segments.data ? ` (${segments.data.all.toLocaleString()})` : ""}</option>
              {(segments.data?.segments ?? []).map((sg) => <option key={sg.slug} value={sg.slug}>{sg.name} ({sg.count.toLocaleString()})</option>)}
            </select>
            <div className="text-[11px] text-ops-text-muted">
              {selectedSegment ? selectedSegment.description : "Every contact who can be mailed."}{" "}
              {typeof reach === "number" && <span className="font-semibold text-ops-text">Reaches {reach.toLocaleString()}.</span>} Unsubscribed &amp; suppressed always excluded.
            </div>
          </div>

          <div className="space-y-2">
            <SectionLabel n="3">Content</SectionLabel>
            <textarea value={f.html} onChange={(e) => set("html", e.target.value)} rows={13}
              placeholder={"<h1>…</h1>\nPaste HTML from any builder, or let ✨ Compose with AI write it.\nThe brand header, footer and unsubscribe link are added automatically."}
              className={`${input} font-mono text-xs leading-relaxed`} />
          </div>

          {msg && (
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
              {msg.tone === "ok" ? <Check size={13} /> : <X size={13} />} {msg.text}
            </div>
          )}

          {openCampaign && <CampaignDetail c={openCampaign} onClose={() => setOpenCampaign(null)} />}
          {sentInfo && (
            <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20"><Check size={24} className="text-emerald-400" /></div>
              <div className="text-lg font-bold text-ops-text">Sent to {sentInfo.sent.toLocaleString()} of {sentInfo.of.toLocaleString()} recipients</div>
              <div className="mt-1 text-xs text-ops-text-muted">"{sentInfo.subject}" · tag <code className="rounded bg-ops-bg px-1.5 py-0.5">{sentInfo.tag}</code></div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <a href={`/${company}/email`} className="rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-sm font-semibold text-white">View analytics →</a>
                <button type="button" onClick={() => setSentInfo(null)} className="rounded-lg border border-ops-border px-4 py-2 text-sm text-ops-text hover:bg-ops-bg">Start a new email</button>
              </div>
              <div className="mt-3 text-[11px] text-ops-text-muted">Opens, clicks and any bounces land in the ledger as webhook events arrive — usually within minutes.</div>
            </div>
          )}

          {confirmInfo && (
            <div className="ops-warn flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2.5">
              <span className="text-xs">This sends <b>{confirmInfo.recipients.toLocaleString()}</b> real emails ({confirmInfo.segment === "all" ? "everyone" : `segment ${confirmInfo.segment}`}). No undo.</span>
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => setConfirmInfo(null)} className="text-xs text-ops-text-muted hover:text-ops-text">Cancel</button>
                <button type="button" disabled={busy !== null} onClick={() => reviewOrSend(true)} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40">
                  {busy === "send" ? <Loader2 size={13} className="animate-spin" /> : `Send to ${confirmInfo.recipients.toLocaleString()} now`}
                </button>
              </span>
            </div>
          )}

          {sched.confirm && (
            <div className="ops-warn flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2.5">
              <span className="text-xs">Schedule for <b>{sched.date} {sched.time}</b> ({sched.tz.split("/")[1]?.replace("_", " ")}) → will auto-send to <b>{sched.confirm.recipients.toLocaleString()}</b> recipients ({sched.confirm.segment === "all" ? "everyone" : `segment ${sched.confirm.segment}`}).</span>
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => setSched((x) => ({ ...x, confirm: null }))} className="text-xs underline">Cancel</button>
                <button type="button" disabled={busy !== null} onClick={() => scheduleIt(true)} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">
                  {busy === "schedule" ? <Loader2 size={13} className="animate-spin" /> : "Confirm schedule"}
                </button>
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-ops-border pt-3">
            <label className="flex items-center gap-1.5 text-xs text-ops-text-muted">
              <input type="checkbox" checked={sched.on} onChange={(e) => setSched((x) => ({ ...x, on: e.target.checked, confirm: null }))} className="h-3.5 w-3.5 accent-[#2E5BFF]" />
              Send later
            </label>
            {sched.on && (
              <span className="flex flex-wrap items-center gap-1.5">
                <input type="date" value={sched.date} onChange={(e) => setSched((x) => ({ ...x, date: e.target.value, confirm: null }))}
                  className="rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text" />
                <input type="time" value={sched.time} onChange={(e) => setSched((x) => ({ ...x, time: e.target.value, confirm: null }))}
                  className="rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text" />
                <select value={sched.tz} onChange={(e) => setSched((x) => ({ ...x, tz: e.target.value, confirm: null }))}
                  className="rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text">
                  <option value="America/Los_Angeles">Pacific</option>
                  <option value="America/Denver">Mountain</option>
                  <option value="America/Chicago">Central</option>
                  <option value="America/New_York">Eastern</option>
                </select>
                <button type="button" disabled={busy !== null || !f.subject || !f.html || !sched.date || !!sched.confirm} onClick={() => scheduleIt(false)}
                  className="rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  {busy === "schedule" && !sched.confirm ? <Loader2 size={13} className="animate-spin" /> : "Schedule"}
                </button>
              </span>
            )}
            <span className="mr-auto flex items-center gap-1.5">
              <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="your@inbox.com"
                className="w-44 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-2 text-xs text-ops-text placeholder:text-ops-text-muted focus:outline-none" />
              <button type="button" disabled={busy !== null || !testTo.trim() || !f.subject || !f.html} onClick={sendTest}
                title="One rendered test send, exactly as the broadcast would look"
                className="rounded-lg border border-ops-border px-3 py-2 text-xs font-semibold text-ops-text hover:bg-ops-bg disabled:opacity-40">
                {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : "Send test"}
              </button>
            </span>
            <button type="button" disabled={busy !== null || (!f.title.trim() && !f.subject.trim())} onClick={() => void save()}
              className="rounded-lg border border-ops-border px-4 py-2 text-sm text-ops-text hover:bg-ops-bg disabled:opacity-40">
              {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : "Save draft"}
            </button>
            <button type="button" disabled={busy !== null || !f.subject || !f.html || !!confirmInfo} onClick={() => reviewOrSend(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40">
              {busy === "send" && !confirmInfo ? <Loader2 size={14} className="animate-spin" /> : <Send size={13} />} Review &amp; send{typeof reach === "number" ? ` · ${reach.toLocaleString()}` : ""}
            </button>
          </div>
        </div>

        {/* ── Inbox preview ───────────────────────────────────── */}
        <LivePreview company={company} label={label} subject={f.subject} preheader={f.preheader} html={f.html} />
      </div>

      {(plans.data ?? []).filter((p) => p.status === "send_failed" || p.status === "missed").map((p) => (
        <div key={`fail-${p.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-red-500/60 bg-red-500/10 px-4 py-3">
          <span className="text-sm font-semibold text-red-400">⚠️ "{p.title}" {p.status === "missed" ? "missed its window" : "failed at send time"} — nobody was emailed. Open it to fix and reschedule.</span>
          <button type="button" onClick={() => loadPlan(p)} className="rounded-lg bg-red-500 px-3.5 py-2 text-xs font-bold text-white">Open</button>
        </div>
      ))}

      {/* ── The ledger: full-width below the builder; drafts live behind a sub-tab ── */}
      <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center rounded-lg border border-ops-border p-0.5">
            <button type="button" onClick={() => setListTab("sent")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${listTab === "sent" ? "bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
              Sent · {sent.length}
            </button>
            <button type="button" onClick={() => setListTab("drafts")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${listTab === "drafts" ? "bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
              Drafts &amp; scheduled · {drafts.length}
            </button>
          </div>
          <span className="text-[11px] text-ops-text-muted">{listTab === "sent" ? "newest first · click a campaign for the full performance view" : "drafts, approved and scheduled — newest first"}</span>
        </div>
        {listTab === "drafts" ? (<div>
          {!drafts.length && <div className="rounded-lg border border-dashed border-ops-border py-6 text-center text-xs text-ops-text-muted">Nothing in progress. Start above, or let ✨ AI write the first version.</div>}
          {drafts.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 border-t border-ops-border/60 py-2.5 first:border-t-0">
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-ops-text">{p.title}</span>
                <span className="block truncate text-[11px] text-ops-text-muted">{p.subject ?? "no subject yet"}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ops-text-muted">
                  <span className={`rounded-full border px-1.5 py-px font-semibold ${p.status === "draft" ? "border-ops-border" : "border-brand-blue-500/40 bg-brand-blue-500/10 text-brand-blue-400"}`}>{p.status}</span>
                  <span>{p.audience_id || "everyone"}</span>
                  {(p.created_by?.startsWith("mcp:") || p.created_by?.startsWith("automation:")) && <span className="rounded-full border border-purple-500/40 bg-purple-500/10 px-1.5 py-px font-semibold text-purple-400">🤖 agent</span>}
                </span>
              </span>
              <button type="button" onClick={() => loadPlan(p)} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1.5 text-[11px] font-semibold text-ops-text hover:bg-ops-bg"><Eye size={11} /> Open</button>
            </div>
          ))}
        </div>) : (<div>
          {!sent.length && <div className="rounded-lg border border-dashed border-ops-border py-6 text-center text-xs text-ops-text-muted">Sends from the engine land here with opens, clicks and revenue.</div>}
          {sent.map((p) => {
            const st = p.resend_broadcast_id ? statByTag.get(p.resend_broadcast_id) : undefined;
            const rate = (n: number, d: number) => { if (d <= 0) return "—"; const x = (n / d) * 100; return `${x >= 10 ? Math.round(x) : x.toFixed(1)}%`; };
            return (
              <div key={p.id} role={st ? "button" : undefined} tabIndex={st ? 0 : undefined}
                onClick={() => st && setOpenCampaign({ ...st, prettyName: p.subject || p.title })}
                onKeyDown={(e) => { if (e.key === "Enter" && st) setOpenCampaign({ ...st, prettyName: p.subject || p.title }); }}
                className={`border-t border-ops-border/60 py-2.5 first:border-t-0 ${st ? "-mx-2 cursor-pointer rounded-lg px-2 transition-colors hover:bg-ops-bg/50" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-xs font-semibold ${st ? "text-brand-blue-400" : "text-ops-text"}`}>{p.title}</span>
                  <span className="shrink-0 text-[11px] text-ops-text-muted">{new Date(p.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                </div>
                {st ? (
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                    <span className="rounded-full border border-ops-border px-1.5 py-px text-ops-text">{st.sends.toLocaleString()} sent</span>
                    <span className="rounded-full border border-brand-blue-500/40 bg-brand-blue-500/10 px-1.5 py-px font-semibold text-brand-blue-400">{rate(st.uniqueOpens, st.sends)} open</span>
                    <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px font-semibold text-emerald-400">{rate(st.uniqueClicks, st.sends)} click</span>
                    <span className="rounded-full border border-ops-border px-1.5 py-px font-semibold text-ops-text">{st.attributedOrders} orders · ${(st.attributedRevenueCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  </div>
                ) : <div className="mt-0.5 text-[11px] text-ops-text-muted">stats land as webhook events arrive</div>}
              </div>
            );
          })}
        </div>)}
      </div>

      {company === "realpeptides" && <McpConnectCard />}
    </div>
  );
}

function LivePreview({ company, label, subject, preheader, html }: { company: string; label: string; subject: string; preheader: string; html: string }) {
  const [doc, setDoc] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(timer.current);
    if (!html.trim()) { setDoc(""); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/ops/${company}/marketing/render-broadcast`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ html_b64: b64(html) }),
        });
        const j = await r.json().catch(() => ({}));
        // An engine without the render action still gets a useful preview: the raw HTML
        // (the engine adds its brand shell + unsubscribe footer at send time regardless).
        setDoc(r.ok && j.html ? j.html : html);
      } catch {
        setDoc(html);
      } finally { setLoading(false); }
    }, 600);
    return () => clearTimeout(timer.current);
  }, [html, company]);
  const initials = label.replace(/[^A-Za-z ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "✉";
  return (
    <div className="rounded-2xl border border-ops-border bg-ops-surface p-4 sm:p-5 xl:sticky xl:top-4 xl:self-start">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-ops-text">Inbox preview {loading && <Loader2 size={12} className="ml-1 inline animate-spin text-ops-text-muted" />}</h2>
        <div className="flex overflow-hidden rounded-lg border border-ops-border">
          {([["desktop", Monitor], ["mobile", Smartphone]] as const).map(([d, Icon]) => (
            <button key={d} type="button" onClick={() => setDevice(d)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold ${device === d ? "bg-brand-blue-500/15 text-brand-blue-400" : "text-ops-text-muted hover:text-ops-text"}`}>
              <Icon size={12} /> {d === "desktop" ? "Desktop" : "Phone"}
            </button>
          ))}
        </div>
      </div>

      {/* the inbox row, as Gmail would show it */}
      <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-ops-border bg-ops-bg px-3 py-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ops-text text-[11px] font-bold text-ops-surface">{initials}</span>
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-xs font-semibold text-ops-text">{label}</span>
            <span className="shrink-0 text-[10px] text-ops-text-muted">just now</span>
          </span>
          <span className="block truncate text-xs font-semibold text-ops-text">{subject || <span className="font-normal text-ops-text-muted">Subject line…</span>}</span>
          <span className="block truncate text-[11px] text-ops-text-muted">{preheader || "Preheader shows here — the gray line that sells the open."}</span>
        </span>
      </div>

      {doc ? (
        <div className={device === "mobile" ? "flex justify-center" : undefined}>
          <iframe title="Broadcast preview" sandbox="" srcDoc={doc}
            className={device === "mobile"
              ? "h-[60vh] w-[375px] max-w-full rounded-[1.4rem] border-4 border-ops-border bg-white shadow-card"
              : "h-[60vh] w-full rounded-lg border border-ops-border bg-white"} />
        </div>
      ) : (
        <div className="flex h-[60vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ops-border text-center text-xs text-ops-text-muted">
          <Send size={18} className="opacity-40" />
          <span>The rendered email appears here as you type —<br />brand header, footer and unsubscribe link included.</span>
        </div>
      )}
    </div>
  );
}

/**
 * Agent access — the "simple MCP UX": everything an agent builder needs to connect, in one card
 * with copy buttons. RP-only (the MCP endpoint is RP-scoped). The token itself is never displayed
 * (it lives with Paul); the card explains exactly what an agent can and cannot do.
 */
function McpConnectCard() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const URL_ = "https://ops.fitscript.me/api/mcp/rp-email";
  const CONFIG = `{
  "mcpServers": {
    "rp-email": {
      "url": "${URL_}",
      "headers": { "Authorization": "Bearer <TOKEN — ask Paul>" }
    }
  }
}`;
  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 1500); } catch { /* manual copy fallback */ }
  };
  return (
    <div className="rounded-2xl border border-ops-border bg-ops-surface">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-bold text-ops-text">🤖 Agent access (MCP) <span className="font-normal text-ops-text-muted">· connect Claude or any agent builder to draft campaigns here</span></span>
        <span className="text-xs text-ops-text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-ops-border p-4 text-xs text-ops-text-muted">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ops-text">Endpoint</span>
            <code className="rounded bg-ops-bg px-2 py-1 text-[11px] text-ops-text">{URL_}</code>
            <button type="button" onClick={() => copy("url", URL_)} className="rounded-lg border border-ops-border px-2 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg">{copied === "url" ? "Copied ✓" : "Copy"}</button>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="font-semibold text-ops-text">Config (Claude Desktop / any MCP client)</span>
              <button type="button" onClick={() => copy("cfg", CONFIG)} className="rounded-lg border border-ops-border px-2 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg">{copied === "cfg" ? "Copied ✓" : "Copy"}</button>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-ops-border bg-ops-bg p-3 text-[11px] leading-relaxed text-ops-text">{CONFIG}</pre>
            <div className="mt-1">The bearer token is NOT shown here — ask Paul for it. Keep it out of repos and prompts.</div>
          </div>
          <div>
            <span className="font-semibold text-ops-text">What the agent can do:</span> list segments with live counts, preview audience sizes, create and update campaign <b>drafts</b> (they appear in the list above with a 🤖 badge), send tests to a named inbox, and read campaign stats.
            <span className="font-semibold text-ops-text"> What it can't:</span> mass-send. Every real send is a human clicking Review &amp; send on this page.
          </div>
          <div>
            <span className="font-semibold text-ops-text">Gotcha:</span> pass email HTML as <code>html_base64</code> (base64-encoded) — the firewall rejects raw HTML inside JSON.
          </div>
        </div>
      )}
    </div>
  );
}
