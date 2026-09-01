import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Loader2, FlaskConical, Copy, Send, MapPin, Check } from "lucide-react";
import { api, ui, atLab, type Sku, type Lab } from "./api";

/**
 * Lab shipment builder: every product that needs testing — expired, untested,
 * expiring — in one list, whichever mix of statuses is toggled on. Pick the
 * lab (its shipping address rides along), push the list to Slack for the
 * fulfilment team, and everything on it flips to "at the lab" in one stroke.
 */

const STATUS_TOGGLES = [
  { key: "expired", label: "Expired" },
  { key: "untested", label: "No COA" },
  { key: "expiring", label: "Expiring soon" },
] as const;

const STATUS_TONE: Record<string, string> = {
  expired: "text-red-400",
  untested: "text-red-400",
  expiring: "text-yellow-500",
};

export function LabOrder({ skus, onClose, onSay, onChanged }: {
  skus: Sku[]; onClose: () => void; onSay: (m: string) => void; onChanged: () => void;
}) {
  const [statuses, setStatuses] = useState<Set<string>>(new Set(["expired", "untested", "expiring"]));
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [labName, setLabName] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const labsQ = useQuery({ queryKey: ["coa-labs"], queryFn: () => api<{ labs: Lab[] }>("/labs") });
  const labs = labsQ.data?.labs ?? [];
  const lab = labs.find((l) => l.name === labName) ?? labs[0] ?? null;

  const candidates = useMemo(
    () => skus
      .filter((s) => s.requires_coa && statuses.has(s.status) && !atLab(s))
      .sort((a, b) => a.status.localeCompare(b.status) || a.product_name.localeCompare(b.product_name)),
    [skus, statuses],
  );
  const picked = candidates.filter((s) => !excluded.has(s.id));

  const messagePreview = useMemo(() => {
    const lines = picked.map((s) => `• ${s.product_name} (${s.sku_code})`);
    return [
      `🧪 Lab shipment — ${picked.length} product${picked.length === 1 ? "" : "s"} to ${lab?.name ?? "the lab"}`,
      "",
      ...lines,
      "",
      lab?.address ? `📦 Ship to:\n${lab.address}` : "📦 Ship to: (no address on file — add it below)",
    ].join("\n");
  }, [picked, lab]);

  const toggleStatus = (key: string) => {
    const next = new Set(statuses);
    next.has(key) ? next.delete(key) : next.add(key);
    setStatuses(next);
  };
  const toggleSku = (id: number) => {
    const next = new Set(excluded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExcluded(next);
  };

  async function saveAddress() {
    if (!lab || addressDraft === null) return;
    try {
      await api(`/labs/${lab.id}`, { method: "PATCH", body: JSON.stringify({ address: addressDraft }) });
      await labsQ.refetch();
      setAddressDraft(null);
      onSay(`Shipping address saved for ${lab.name}.`);
    } catch (e: any) { onSay(`Failed: ${e.message}`); }
  }

  async function copyList() {
    try {
      await navigator.clipboard.writeText(messagePreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { onSay("Couldn't reach the clipboard — select the preview text instead."); }
  }

  async function pushAndMark() {
    if (!picked.length) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; count: number; pushed: { slack?: { ok: boolean } | null; anyConfigured: boolean } | null }>(
        "/lab-orders",
        { method: "POST", body: JSON.stringify({ sku_ids: picked.map((s) => s.id), lab: lab?.name, push: true }) },
      );
      const slackOk = r.pushed?.slack?.ok;
      onSay(slackOk
        ? `Sent to Slack — ${r.count} products marked at ${lab?.name}.`
        : `${r.count} products marked at ${lab?.name}. Slack push ${r.pushed?.anyConfigured ? "failed — use Copy list" : "isn't connected — use Copy list"}.`);
      onChanged();
      onClose();
    } catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-3xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ops-text"><FlaskConical size={16} /> Send to lab</h2>
            <p className="text-xs text-ops-text-muted">Build the shipment list, push it to Slack for fulfilment, and everything on it goes to "at the lab".</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {STATUS_TOGGLES.map((t) => (
                <button key={t.key} type="button" onClick={() => toggleStatus(t.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    statuses.has(t.key) ? "border-fitscript-green bg-fitscript-green/10 text-fitscript-green" : "border-ops-border text-ops-text-muted hover:text-ops-text"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-ops-text-muted">
              Lab
              <select value={lab?.name ?? ""} onChange={(e) => setLabName(e.target.value)}
                className="rounded-lg border border-ops-border bg-ops-bg px-2 py-1.5 text-xs text-ops-text focus:border-fitscript-green focus:outline-none">
                {labs.map((l) => <option key={l.id} value={l.name}>{l.name}{l.is_default ? " (default)" : ""}</option>)}
              </select>
            </label>
          </div>

          {lab && (
            <div className="rounded-xl border border-ops-border bg-ops-bg/40 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ops-text-muted">
                <MapPin size={11} /> {lab.name} shipping address
              </div>
              {addressDraft === null ? (
                <div className="flex items-start justify-between gap-3">
                  <span className={`whitespace-pre-line text-xs ${lab.address ? "text-ops-text" : "text-red-400"}`}>
                    {lab.address || "No address on file — the Slack message will say so."}
                  </span>
                  <button type="button" onClick={() => setAddressDraft(lab.address ?? "")}
                    className="shrink-0 text-[11px] font-semibold text-fitscript-green underline-offset-2 hover:underline">
                    {lab.address ? "Edit" : "Add address"}
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea value={addressDraft} onChange={(e) => setAddressDraft(e.target.value)} rows={3}
                    placeholder={"Kovera Labs\n123 Science Way, Suite 4\nAustin, TX 78701"} className={`${ui.input} text-xs`} autoFocus />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setAddressDraft(null)} className={`${ui.ghost} px-2.5 py-1.5 text-xs`}>Cancel</button>
                    <button type="button" onClick={saveAddress} className={`${ui.primary} px-2.5 py-1.5 text-xs`}>Save address</button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto rounded-xl border border-ops-border">
            {candidates.length ? (
              <ul className="divide-y divide-ops-border/50 text-sm">
                {candidates.map((s) => {
                  const on = !excluded.has(s.id);
                  return (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-ops-bg/40">
                        <input type="checkbox" checked={on} onChange={() => toggleSku(s.id)} className="accent-fitscript-green" />
                        <span className="min-w-0 flex-1 truncate text-ops-text">{s.product_name} <span className="text-[11px] text-ops-text-muted">({s.sku_code})</span></span>
                        <span className={`shrink-0 text-[11px] font-semibold uppercase ${STATUS_TONE[s.status] ?? "text-ops-text-muted"}`}>
                          {s.status === "untested" ? "no coa" : s.status}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="py-10 text-center text-sm text-ops-text-muted">Nothing needs testing in the selected statuses.</div>
            )}
          </div>

          {picked.length > 0 && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-ops-border bg-ops-bg/40 p-3 font-mono text-[11px] leading-relaxed text-ops-text-muted">{messagePreview}</pre>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={copyList} disabled={!picked.length} className={ui.ghost}>
              {copied ? <Check size={15} className="text-fitscript-green" /> : <Copy size={15} />} {copied ? "Copied" : "Copy list"}
            </button>
            <button type="button" onClick={pushAndMark} disabled={busy || !picked.length} className={ui.primary}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Push to Slack & mark {picked.length} at the lab
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
