import { useState } from "react";
import { X, Copy, Check, Send, FlaskConical, CalendarClock } from "lucide-react";
import { api, ui, type Family } from "./api";
import { buildSummary, type SummarySection } from "./summary";
import { useLabs } from "./FamilyDetail";

export function ActionSummary({ families, onClose }: { families: Family[]; onClose: () => void }) {
  const sections = buildSummary(families);
  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Action Summary</h2>
            <p className="text-xs text-ops-text-muted">Copy a message or push it to Slack</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-4 p-5">
          <KoveraBanner />
          {sections.map((s) => <SectionCard key={s.key} section={s} />)}
        </div>
      </div>
    </div>
  );
}

function KoveraBanner() {
  const { defaultLab } = useLabs();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function post() {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ ok: boolean; anyConfigured: boolean; total: number }>("/notify/kovera-digest", { method: "POST" });
      setMsg(!r.anyConfigured ? "Slack isn't connected on the tracker." : r.ok ? `Posted ${r.total} product(s) to #coa-alerts.` : "Post failed — check the tracker logs.");
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-fitscript-green/30 bg-fitscript-green/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FlaskConical size={18} className="shrink-0 text-fitscript-green" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ops-text">Send to {defaultLab} for testing</div>
            <div className="flex items-center gap-1 text-[11px] text-ops-text-muted"><CalendarClock size={11} /> Auto-posts to Slack every Monday 9am</div>
          </div>
        </div>
        <button type="button" onClick={post} disabled={busy} className={ui.primary}><Send size={14} /> {busy ? "Posting…" : "Post now"}</button>
      </div>
      {msg && <div className="mt-2 text-xs text-ops-text-muted">{msg}</div>}
    </div>
  );
}

function SectionCard({ section }: { section: SummarySection }) {
  const [copied, setCopied] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function copy() {
    await navigator.clipboard.writeText(section.message);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }
  async function push() {
    if (!section.count) return;
    setPushing(true); setMsg(null);
    try {
      const r = await api<{ ok: boolean; anyConfigured: boolean; slack?: { ok: boolean }; whatsapp?: { sent: number } }>("/notify/push", { method: "POST", body: JSON.stringify({ message: section.message }) });
      if (!r.anyConfigured) { setMsg("No alert channel connected on the tracker."); return; }
      const parts = [r.slack?.ok && "Slack", r.whatsapp?.sent && `WhatsApp (${r.whatsapp.sent})`].filter(Boolean);
      setMsg(parts.length ? `Pushed to ${parts.join(" + ")}.` : "Push failed.");
    } catch (e: any) { setMsg(e.message); } finally { setPushing(false); }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-ops-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ops-border bg-ops-bg/40 px-4 py-2.5">
        <span className="text-sm font-semibold text-ops-text">{section.emoji} {section.title} <span className="font-normal text-ops-text-muted">· {section.count}</span></span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={copy} className={`${ui.ghost} px-2.5 py-1.5 text-xs`}>{copied ? <><Check size={13} className="text-fitscript-green" /> Copied</> : <><Copy size={13} /> Copy</>}</button>
          <button type="button" onClick={push} disabled={pushing || !section.count} className={`${ui.primary} px-2.5 py-1.5 text-xs`}><Send size={13} /> {pushing ? "Pushing…" : "Push"}</button>
        </div>
      </div>
      <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-sans text-xs leading-relaxed text-ops-text">{section.message}</pre>
      {msg && <div className="border-t border-ops-border px-4 py-2 text-xs text-ops-text-muted">{msg}</div>}
    </div>
  );
}
