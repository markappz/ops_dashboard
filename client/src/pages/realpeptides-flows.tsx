import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, ShieldCheck, Upload, X } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * The flow review gallery + suppression import — the "show me everything in the browser before
 * anything sends" surface (Paul, 2026-10-02, the night Resend suspended the account).
 *
 * Every flow step renders through the site's engine itself (/api/ops/realpeptides/marketing/render
 * proxies the token-gated bridge), so what this page shows IS what a customer would receive —
 * hand-authored salvage included. Flow sends stay paused in the engine until Paul approves here
 * and the hold is lifted in code.
 */

interface FlowStep { stepIndex: number; subject: string; delayHours: number; handAuthored: boolean }
interface Flow { key: string; banner: string; exitOnPurchase: boolean; steps: FlowStep[] }
interface InstantSend { key: string; name: string }

const b64 = (x: string) => btoa(String.fromCharCode(...new TextEncoder().encode(x)));

const fmtDelay = (h: number) => (h === 0 ? "immediately" : h % 24 === 0 ? `+${h / 24}d` : `+${h}h`);

export default function RealPeptidesFlows() {
  const flows = useQuery({
    queryKey: ["rp-flows"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/marketing/flows", { credentials: "include" })).json() as Promise<{ flows: Flow[]; instant?: InstantSend[] }>,
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState<{ flowKey?: string; stepIndex?: number; instant?: string; subject: string } | null>(null);
  const overrides = useQuery({
    queryKey: ["rp-overrides"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/marketing/overrides", { credentials: "include" })).json() as
      Promise<{ overrides: { alias: string; enabled: boolean }[] }>,
    staleTime: 60_000,
  });
  const overrideState = (alias: string) => overrides.data?.overrides.find((o) => o.alias === alias);
  // 90-day ledger stats joined onto each step - review and performance in one place.
  const stats = useQuery({
    queryKey: ["rp-email-90"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/email?range=90", { credentials: "include" })).json() as
      Promise<{ flows?: { flowKey: string; attributedRevenueCents: number; steps: { stepIndex: number; sends: number; openRate: number | null; clickRate: number | null }[] }[] }>,
    staleTime: 10 * 60_000,
  });
  const stepStats = (flowKey: string, stepIndex: number) =>
    stats.data?.flows?.find((f) => f.flowKey === flowKey)?.steps.find((st) => st.stepIndex === stepIndex);
  const flowRevenue = (flowKey: string) => stats.data?.flows?.find((f) => f.flowKey === flowKey)?.attributedRevenueCents ?? 0;
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

  return (
    <div className="space-y-6">
      <PageHero title="Email Flows — Review" subtitle="Each step renders through the live engine, exactly as it would send. Flow sends are paused until this review is complete." />
      <UnsubImport />
      {flows.isLoading && <Loader2 className="animate-spin text-ops-text-muted" />}
      {!!flows.data?.instant?.length && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-ops-text">Instant sends</h2>
          <p className="mb-3 text-xs text-ops-text-muted">One-off marketing emails that fire the moment something happens — not flow steps, but customers receive them, so they belong in this review. The welcome offer-code email is what delivers each subscriber's unique 40% code; the flow continues the story from the next day.</p>
          {flows.data.instant.map((i) => (
            <div key={i.key} className="flex items-center justify-between border-t border-ops-border/60 py-2 text-xs">
              <span className="font-medium text-ops-text">{i.name}</span>
              <button type="button" onClick={() => setOpen({ instant: i.key, subject: i.name })}
                className="inline-flex items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg">
                <Eye size={12} /> Preview
              </button>
            </div>
          ))}
        </div>
      )}
      {flows.data?.flows?.map((f) => (
        <div key={f.key} className="rounded-2xl border border-ops-border bg-ops-surface p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-ops-text">{f.banner}</h2>
            <code className="rounded bg-ops-bg px-1.5 py-0.5 text-[11px] text-ops-text-muted">{f.key}</code>
            {f.exitOnPurchase && (
              <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                <ShieldCheck size={11} /> exits on purchase
              </span>
            )}
            {flowRevenue(f.key) > 0 && (
              <span className="ml-auto rounded-full border border-ops-border px-2 py-0.5 text-[10px] font-semibold text-ops-text">
                ${(flowRevenue(f.key) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} attributed · 90d
              </span>
            )}
          </div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-ops-text-muted">
                <th className="pb-1 pr-2 font-medium">#</th>
                <th className="pb-1 pr-2 font-medium">Delay</th>
                <th className="pb-1 pr-2 font-medium">Subject</th>
                <th className="pb-1 pr-2 font-medium">Copy source</th>
                <th className="pb-1 pr-2 font-medium">Sends · 90d</th>
                <th className="pb-1 pr-2 font-medium">Open · click</th>
                <th className="pb-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {f.steps.map((s) => (
                <tr key={s.stepIndex} className="border-t border-ops-border/60">
                  <td className="py-2 pr-2 text-ops-text-muted">{s.stepIndex + 1}</td>
                  <td className="py-2 pr-2 text-ops-text-muted">{fmtDelay(s.delayHours)}</td>
                  <td className="py-2 pr-2 font-medium text-ops-text">{s.subject}</td>
                  <td className="py-2 pr-2">
                    {(() => { const o = overrideState(`flow-${f.key}-${s.stepIndex + 1}`); return o ? (
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${o.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-ops-border text-ops-text-muted"}`}>{o.enabled ? "✏️ edited (live)" : "✏️ edit saved (off)"}</span>
                    ) : s.handAuthored ? (
                      <span className="rounded-full border border-brand-blue-500/30 bg-brand-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-blue-400">Josh's copy (salvaged)</span>
                    ) : (
                      <span className="rounded-full border border-ops-border px-2 py-0.5 text-[10px] text-ops-text-muted">engine render</span>
                    ); })()}
                  </td>
                  <td className="py-2 pr-2 text-ops-text-muted">{stepStats(f.key, s.stepIndex)?.sends?.toLocaleString() ?? "—"}</td>
                  <td className="py-2 pr-2 text-ops-text-muted">{pct(stepStats(f.key, s.stepIndex)?.openRate)} · {pct(stepStats(f.key, s.stepIndex)?.clickRate)}</td>
                  <td className="py-2 text-right">
                    <button type="button" onClick={() => setOpen({ flowKey: f.key, stepIndex: s.stepIndex, subject: s.subject })}
                      className="inline-flex items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg">
                      <Eye size={12} /> Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <SiteEmailCatalog onPreview={(key, name) => setOpen({ instant: key, subject: name })} />
      {open && <PreviewModal {...open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PreviewModal({ flowKey, stepIndex, instant, subject, onClose }: { flowKey?: string; stepIndex?: number; instant?: string; subject: string; onClose: () => void }) {
  const qc2 = useQueryClient();
  const alias = instant ?? `flow-${flowKey}-${(stepIndex ?? 0) + 1}`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [draftDoc, setDraftDoc] = useState("");
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();

  async function startEdit(currentHtml: string) {
    // Prefill with the saved override when one exists, else fork the current render.
    const r = await fetch(`/api/ops/realpeptides/marketing/override?alias=${encodeURIComponent(alias)}`, { credentials: "include" });
    const j = await r.json().catch(() => ({}));
    const o = j.override;
    setDraft(o?.html ?? currentHtml);
    setDraftSubject(o?.subject ?? "");
    setEnabled(o?.enabled ?? false);
    setHasOverride(!!o);
    setSaveMsg(null);
    setEditing(true);
  }

  useEffect(() => {
    if (!editing) return;
    clearTimeout(draftTimer.current);
    if (!draft.trim()) { setDraftDoc(""); return; }
    draftTimer.current = setTimeout(async () => {
      const r = await fetch("/api/ops/realpeptides/marketing/render-draft", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ html_b64: b64(draft) }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDraftDoc(j.html);
    }, 700);
    return () => clearTimeout(draftTimer.current);
  }, [editing, draft]);

  async function saveOverride(enable: boolean) {
    setSaving(true); setSaveMsg(null);
    const r = await fetch("/api/ops/realpeptides/marketing/set-override", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias, html_b64: b64(draft), subject: draftSubject || undefined, enabled: enable }),
    });
    const j = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) return setSaveMsg(j.error || `HTTP ${r.status}`);
    setEnabled(j.enabled); setHasOverride(true);
    setSaveMsg(j.enabled ? "Saved — this copy is LIVE for customers (within a minute)." : "Saved as a draft — customers still get the default.");
    qc2.invalidateQueries({ queryKey: ["rp-overrides"] });
    qc2.invalidateQueries({ queryKey: ["rp-flow-render", flowKey, stepIndex, instant] });
  }

  async function removeOverride() {
    if (!confirm("Remove this edit and return to the default copy?")) return;
    setSaving(true);
    await fetch("/api/ops/realpeptides/marketing/delete-override", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias }),
    });
    setSaving(false); setEditing(false); setHasOverride(false);
    qc2.invalidateQueries({ queryKey: ["rp-overrides"] });
    qc2.invalidateQueries({ queryKey: ["rp-flow-render", flowKey, stepIndex, instant] });
  }

  const q = useQuery({
    queryKey: ["rp-flow-render", flowKey, stepIndex, instant],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/marketing/render", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify(instant ? { instant } : { flowKey, stepIndex }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j as { subject: string; html: string; source: string };
    },
    staleTime: 10 * 60_000,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div className="my-2 w-full max-w-2xl rounded-2xl border border-ops-border bg-ops-surface shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ops-text">{q.data?.subject ?? subject}</div>
            <div className="text-[11px] text-ops-text-muted">{instant ? "instant send" : `${flowKey} · step ${(stepIndex ?? 0) + 1}`}{q.data ? ` · ${q.data.source === "override" ? "✏️ ops-edited copy (LIVE)" : q.data.source === "hand-authored" ? "Josh's salvaged copy" : "engine render"}` : ""}</div>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            {!editing && q.data && (
              <button type="button" onClick={() => startEdit(q.data!.html)}
                className="rounded-lg border border-ops-border px-2.5 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg">✏️ Edit copy</button>
            )}
            <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={18} /></button>
          </span>
        </div>
        <div className="p-3">
          {editing ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-2">
                {!instant && (
                  <label className="block text-[11px] text-ops-text-muted">Subject override (blank = keep the default)
                    <input value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} placeholder={subject}
                      className="mt-1 w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-2 text-xs text-ops-text focus:outline-none" />
                  </label>
                )}
                <label className="block text-[11px] text-ops-text-muted">Email document ({'{{{firstName}}}'}, {'{{{couponCode}}}'}, {'{{{siteUrl}}}'}, {'{{{unsubscribeUrl}}}'} substitute per recipient)
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={18}
                    className="mt-1 w-full rounded-lg border border-ops-border bg-ops-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ops-text focus:outline-none" />
                </label>
                {saveMsg && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-400">{saveMsg}</div>}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button type="button" disabled={saving} onClick={() => saveOverride(false)}
                    className="rounded-lg border border-ops-border px-3 py-1.5 text-[11px] font-semibold text-ops-text hover:bg-ops-bg disabled:opacity-40">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : "Save draft"}
                  </button>
                  <button type="button" disabled={saving || !draft.trim()} onClick={() => saveOverride(true)}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-40">
                    {enabled ? "Save & keep live" : "Save & make LIVE"}
                  </button>
                  {hasOverride && (
                    <button type="button" disabled={saving} onClick={removeOverride}
                      className="rounded-lg border border-red-500/40 px-3 py-1.5 text-[11px] font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-40">
                      Remove edit (back to default)
                    </button>
                  )}
                  <button type="button" onClick={() => setEditing(false)} className="ml-auto text-[11px] text-ops-text-muted hover:text-ops-text">Back to preview</button>
                </div>
                <div className="text-[10px] text-ops-text-muted">Live = customers receive this copy on their next send (within a minute). Draft = saved but customers keep getting the default.</div>
              </div>
              <div>
                {draftDoc
                  ? <iframe title="Draft preview" sandbox="" srcDoc={draftDoc} className="h-[62vh] w-full rounded-lg border border-ops-border bg-white" />
                  : <div className="flex h-[62vh] items-center justify-center rounded-lg border border-dashed border-ops-border text-[11px] text-ops-text-muted">Draft preview renders here as you type.</div>}
              </div>
            </div>
          ) : (<>
          {q.isLoading && <div className="flex h-40 items-center justify-center"><Loader2 className="animate-spin text-ops-text-muted" /></div>}
          {q.error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">{String((q.error as Error).message)}</div>}
          {q.data && (
            <>
              <div className="mb-2 rounded-lg border border-brand-blue-500/30 bg-brand-blue-500/10 px-3 py-1.5 text-[11px] text-brand-blue-300">
                Preview uses sample values: <code>SAMPLE10</code> stands in for the contact's unique promo code (minted per person at opt-in), "Alex" for their first name. Real sends substitute each recipient's own values.
              </div>
              <iframe title="Email preview" sandbox="" srcDoc={q.data.html} className="h-[68vh] w-full rounded-lg border border-ops-border bg-white" />
            </>
          )}
          </>)}
        </div>
      </div>
    </div>
  );
}

/** Minimal CSV parsing that honors quoted fields - enough for the Resend contacts export. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function UnsubImport() {
  const [parsed, setParsed] = useState<{ fileName: string; unsubs: string[] } | null>(null);
  const [progress, setProgress] = useState<{ sent: number; updated: number; matched: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suppResult, setSuppResult] = useState<string | null>(null);

  async function importSalvagedSuppressions() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/ops/realpeptides/marketing/import-salvaged-suppressions", { method: "POST", credentials: "include" });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(j.error || `HTTP ${r.status}`);
    setSuppResult(`${j.listed} salvaged bounce/complaint addresses processed — ${j.newlySuppressed} newly suppressed (the rest were already flagged by our own webhooks).`);
  }
  const done = useMemo(() => !!(parsed && progress && progress.sent >= parsed.unsubs.length && !busy), [parsed, progress, busy]);

  async function onFile(file: File) {
    setErr(null); setProgress(null);
    const rows = parseCsv(await file.text());
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const emailIdx = header.indexOf("email");
    const unsubIdx = header.indexOf("unsubscribed");
    if (emailIdx < 0 || unsubIdx < 0) return setErr('This CSV needs "email" and "unsubscribed" columns (the Resend contacts export has both).');
    const unsubs = [...new Set(rows.slice(1).filter((r) => /^true$/i.test((r[unsubIdx] ?? "").trim())).map((r) => (r[emailIdx] ?? "").trim().toLowerCase()).filter(Boolean))];
    setParsed({ fileName: file.name, unsubs });
  }

  async function run() {
    if (!parsed) return;
    setBusy(true); setErr(null);
    const totals = { sent: 0, updated: 0, matched: 0 };
    try {
      for (let i = 0; i < parsed.unsubs.length; i += 2000) {
        const chunk = parsed.unsubs.slice(i, i + 2000);
        const r = await fetch("/api/ops/realpeptides/marketing/import-unsubscribes", {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ emails: chunk }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        totals.sent += chunk.length; totals.updated += j.updated; totals.matched += j.matched;
        setProgress({ ...totals });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-bold text-ops-text"><Upload size={15} className="text-amber-400" /> Import Resend unsubscribes</div>
      <p className="mb-3 text-xs text-ops-text-muted">
        Unsubscribes from Resend-hosted broadcast links never reached our database. Pick the Resend contacts export
        (contacts-*.csv) — only addresses marked unsubscribed are imported, and the import only ever SETS the flag.
        Do this before lifting the send hold.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-xs text-ops-text-muted file:mr-3 file:rounded-lg file:border file:border-ops-border file:bg-ops-bg file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ops-text" />
        {parsed && !done && (
          <button type="button" disabled={busy || !parsed.unsubs.length} onClick={run}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40">
            {busy ? <Loader2 size={13} className="animate-spin" /> : `Import ${parsed.unsubs.length.toLocaleString()} unsubscribes`}
          </button>
        )}
      </div>
      {parsed && <div className="mt-2 text-[11px] text-ops-text-muted">{parsed.fileName}: {parsed.unsubs.length.toLocaleString()} unsubscribed addresses found.</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-500/20 pt-3">
        <button type="button" disabled={busy || !!suppResult} onClick={importSalvagedSuppressions}
          className="rounded-lg border border-ops-border px-3 py-1.5 text-xs font-semibold text-ops-text hover:bg-ops-bg disabled:opacity-40">
          Import salvaged bounce/complaint list (388)
        </button>
        {suppResult && <span className="text-[11px] text-emerald-400">{suppResult}</span>}
      </div>
      {progress && (
        <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${done ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-ops-border text-ops-text-muted"}`}>
          {progress.sent.toLocaleString()} processed · {progress.matched.toLocaleString()} matched contacts · {progress.updated.toLocaleString()} newly flagged{done ? " — done. The difference is addresses already unsubscribed here or not in our CRM." : "…"}
        </div>
      )}
      {err && <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
    </div>
  );
}

interface SiteEmail { key: string; name: string; group: string; trigger: string; to: string; preview?: string }

/** Every transactional + notification email the site sends, grouped like the old Resend folders. */
function SiteEmailCatalog({ onPreview }: { onPreview: (key: string, name: string) => void }) {
  const q = useQuery({
    queryKey: ["rp-site-emails"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/marketing/site-emails", { credentials: "include" })).json() as Promise<{ emails: SiteEmail[] }>,
    staleTime: 30 * 60_000,
  });
  if (!q.data?.emails) return null;
  const groups = [...new Set(q.data.emails.map((e) => e.group))];
  const TO: Record<string, string> = { customer: "customer", internal: "team", affiliate: "affiliate", wholesale: "wholesale" };
  return (
    <div className="rounded-2xl border border-ops-border bg-ops-surface p-4">
      <h2 className="mb-1 text-sm font-bold text-ops-text">Site emails — transactional &amp; notifications <span className="font-normal text-ops-text-muted">· {q.data.emails.length} active</span></h2>
      <p className="mb-3 text-xs text-ops-text-muted">Everything the site sends on real events (orders, claims, subscriptions, logins…). All of these route through the new engine — they never stopped. Previews render where a sample renderer exists; in-dashboard editing of these is the next build.</p>
      {groups.map((g) => (
        <div key={g} className="mb-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ops-text-muted">{g}</div>
          {q.data!.emails.filter((e) => e.group === g).map((e) => (
            <div key={e.key} className="flex flex-wrap items-center gap-2 border-t border-ops-border/50 py-1.5 text-xs">
              <span className="w-64 shrink-0 font-medium text-ops-text">{e.name}</span>
              <span className="rounded-full border border-ops-border px-1.5 py-0.5 text-[10px] text-ops-text-muted">{TO[e.to] ?? e.to}</span>
              <span className="min-w-0 flex-1 truncate text-ops-text-muted" title={e.trigger}>{e.trigger}</span>
              {e.preview && (
                <button type="button" onClick={() => onPreview(e.preview!, e.name)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ops-border px-2.5 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg">
                  <Eye size={11} /> Preview
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
