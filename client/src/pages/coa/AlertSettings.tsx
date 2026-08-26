import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Trash2, Plus, Send, CheckCircle2, AlertCircle, FlaskConical } from "lucide-react";
import { api, ui, type Lab } from "./api";

interface TeamMember { id: number; name: string; whatsapp_number: string | null }
interface Status { slackReady: boolean; whatsappReady: boolean; from: string; recipients: number }

export function AlertSettings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["coa-notify-status"], queryFn: () => api<Status>("/notify/status") });
  const team = useQuery({ queryKey: ["coa-team"], queryFn: () => api<TeamMember[]>("/team") });
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    if (!name.trim() || !number.trim()) return;
    await api("/team", { method: "POST", body: JSON.stringify({ name, whatsapp_number: number }) });
    setName(""); setNumber("");
    qc.invalidateQueries({ queryKey: ["coa-team"] });
  }
  async function remove(id: number) {
    await api(`/team/${id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: ["coa-team"] });
  }
  async function test() {
    setTesting(true); setMsg(null);
    try {
      const r = await api<{ ok: boolean; anyConfigured: boolean; error?: string }>("/notify/test", { method: "POST" });
      setMsg(!r.anyConfigured ? "No channel connected — the tracker needs SLACK_WEBHOOK_URL." : r.ok ? "Test sent to #coa-alerts." : `Send failed: ${r.error || "see tracker logs"}`);
    } catch (e: any) { setMsg(e.message); } finally { setTesting(false); }
  }

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-lg`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <h2 className="text-base font-semibold text-ops-text">COA alerts</h2>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-4 p-5">
          <LabsPanel />
          <Channel ok={status.data?.slackReady} title="Slack" okText="Daily status + Monday lab list post to #coa-alerts" offText="The tracker has no SLACK_WEBHOOK_URL set." />
          <Channel ok={status.data?.whatsappReady} title="WhatsApp (Twilio)" okText={`Sending from ${status.data?.from}`} offText="Optional — Twilio credentials on the tracker enable it." />
          <button type="button" onClick={test} disabled={testing} className={`w-full ${ui.primary}`}><Send size={15} /> {testing ? "Sending…" : "Send test message"}</button>
          {msg && <div className="text-xs text-ops-text-muted">{msg}</div>}
          {status.data?.whatsappReady && (
            <div>
              <div className={ui.label}>WhatsApp recipients</div>
              <div className="space-y-2">
                {team.data?.length ? team.data.map((m) => (
                  <div key={m.id} className="flex items-center justify-between rounded-lg border border-ops-border bg-ops-bg px-3 py-2">
                    <div className="text-sm"><span className="font-medium text-ops-text">{m.name}</span><span className="ml-2 font-mono text-xs text-ops-text-muted">{m.whatsapp_number || "—"}</span></div>
                    <button type="button" onClick={() => remove(m.id)} className="p-1 text-ops-text-muted hover:text-red-400"><Trash2 size={15} /></button>
                  </div>
                )) : <div className="text-xs text-ops-text-muted">No recipients yet.</div>}
                <div className="flex flex-wrap gap-2">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={`${ui.input} min-w-[7rem] flex-1`} />
                  <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+1 305 555 1234" className={`${ui.input} min-w-[9rem] flex-[1.3]`} />
                  <button type="button" onClick={add} className={ui.primary}><Plus size={15} /></button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Which labs we send products to; the default is what one-click "Mark sent" uses. */
function LabsPanel() {
  const qc = useQueryClient();
  const labs = useQuery({ queryKey: ["coa-labs"], queryFn: () => api<{ labs: Lab[] }>("/labs") });
  const [name, setName] = useState("");
  const bump = () => qc.invalidateQueries({ queryKey: ["coa-labs"] });

  async function add() {
    if (!name.trim()) return;
    await api("/labs", { method: "POST", body: JSON.stringify({ name }) });
    setName(""); bump();
  }
  const setDefault = (id: number) => api(`/labs/${id}`, { method: "PATCH", body: JSON.stringify({ is_default: true }) }).then(bump);
  const remove = (id: number) => api(`/labs/${id}`, { method: "DELETE" }).then(bump);

  return (
    <div>
      <div className={ui.label}><span className="inline-flex items-center gap-1"><FlaskConical size={10} /> Testing labs</span></div>
      <div className="space-y-2">
        {(labs.data?.labs ?? []).map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded-lg border border-ops-border bg-ops-bg px-3 py-2">
            <div className="text-sm">
              <span className="font-medium text-ops-text">{l.name}</span>
              {l.is_default
                ? <span className="ml-2 rounded-full bg-fitscript-green/15 px-2 py-0.5 text-[10px] font-semibold text-fitscript-green">default</span>
                : <button type="button" onClick={() => setDefault(l.id)} className="ml-2 text-[11px] text-ops-text-muted underline hover:text-ops-text">make default</button>}
            </div>
            {!l.is_default && <button type="button" onClick={() => remove(l.id)} className="p-1 text-ops-text-muted hover:text-red-400" title="Remove from pick list"><Trash2 size={15} /></button>}
          </div>
        ))}
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a lab (e.g. 9x Testing)" className={`${ui.input} flex-1`} />
          <button type="button" onClick={add} className={ui.primary}><Plus size={15} /></button>
        </div>
        <p className="text-[11px] text-ops-text-muted">The default lab is what "Mark sent" and the Monday digest use. Removing a lab only hides it from pickers — history keeps its name.</p>
      </div>
    </div>
  );
}

function Channel({ ok, title, okText, offText }: { ok?: boolean; title: string; okText: string; offText: string }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${ok ? "border-fitscript-green/30 bg-fitscript-green/5" : "border-ops-border bg-ops-bg/40"}`}>
      {ok ? <CheckCircle2 className="text-fitscript-green" size={20} /> : <AlertCircle className="text-ops-text-muted" size={20} />}
      <div className="text-sm">
        <div className="font-semibold text-ops-text">{title} {ok ? "connected" : "not connected"}</div>
        <div className="text-xs text-ops-text-muted">{ok ? okText : offText}</div>
      </div>
    </div>
  );
}
