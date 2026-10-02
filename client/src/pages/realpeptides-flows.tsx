import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

const fmtDelay = (h: number) => (h === 0 ? "immediately" : h % 24 === 0 ? `+${h / 24}d` : `+${h}h`);

export default function RealPeptidesFlows() {
  const flows = useQuery({
    queryKey: ["rp-flows"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/marketing/flows", { credentials: "include" })).json() as Promise<{ flows: Flow[]; instant?: InstantSend[] }>,
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState<{ flowKey?: string; stepIndex?: number; instant?: string; subject: string } | null>(null);

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
          </div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-ops-text-muted">
                <th className="pb-1 pr-2 font-medium">#</th>
                <th className="pb-1 pr-2 font-medium">Delay</th>
                <th className="pb-1 pr-2 font-medium">Subject</th>
                <th className="pb-1 pr-2 font-medium">Copy source</th>
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
                    {s.handAuthored ? (
                      <span className="rounded-full border border-brand-blue-500/30 bg-brand-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-blue-400">Josh's copy (salvaged)</span>
                    ) : (
                      <span className="rounded-full border border-ops-border px-2 py-0.5 text-[10px] text-ops-text-muted">engine render</span>
                    )}
                  </td>
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
      {open && <PreviewModal {...open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PreviewModal({ flowKey, stepIndex, instant, subject, onClose }: { flowKey?: string; stepIndex?: number; instant?: string; subject: string; onClose: () => void }) {
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
            <div className="text-[11px] text-ops-text-muted">{instant ? "instant send" : `${flowKey} · step ${(stepIndex ?? 0) + 1}`}{q.data ? ` · ${q.data.source === "hand-authored" ? "Josh's salvaged copy" : "engine render"}` : ""}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={18} /></button>
        </div>
        <div className="p-3">
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
