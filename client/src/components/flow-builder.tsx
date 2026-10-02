import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlow, Background, Controls, type Node, type Edge, type NodeProps, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X, Zap, Mail, Plus, Trash2, Loader2, Eye, Code2, ArrowUp, ArrowDown, Play, Pause, Send, Users } from "lucide-react";

/**
 * Visual flow builder (phase 2, 2026-10-02) — create and edit ops-built email sequences on a
 * canvas, Klaviyo-style. Everything here is DRAFT-first: the engine ignores drafts entirely,
 * activation is an explicit action, and segment enrollment is a server-enforced two-step
 * (counts first, nothing enrolls without confirm).
 */

export interface BuilderStep { delayHours: number; subject: string; html: string }
export interface BuilderFlow {
  id?: string;
  key?: string;
  name: string;
  status: "draft" | "active" | "paused";
  trigger: { type: "optin" | "first-purchase" | "segment-oneshot"; segment?: string };
  exitOnPurchase: boolean;
  steps: BuilderStep[];
}

const b64 = (x: string) => btoa(String.fromCharCode(...new TextEncoder().encode(x)));
const post = async (body: unknown) => {
  const r = await fetch("/api/ops/realpeptides/marketing/custom-flow", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

const TRIGGERS: { key: BuilderFlow["trigger"]["type"]; label: string; hint: string }[] = [
  { key: "optin", label: "Joins the list", hint: "fires on every guide/offer opt-in" },
  { key: "first-purchase", label: "Places an order", hint: "fires on order completion" },
  { key: "segment-oneshot", label: "Segment (one-shot)", hint: "you enroll a segment manually, once" },
];

const fmtDelay = (h: number) => (h === 0 ? "immediately" : h % 24 === 0 ? `wait ${h / 24}d` : `wait ${h}h`);

function BTriggerNode({ data }: NodeProps) {
  const d = data as unknown as { flow: BuilderFlow; selected: boolean; onSelect: () => void };
  const t = TRIGGERS.find((x) => x.key === d.flow.trigger.type);
  return (
    <div onClick={d.onSelect}
      className={`w-[250px] cursor-pointer rounded-2xl bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 p-4 text-white shadow-[0_8px_30px_-8px_rgba(46,91,255,0.55)] transition ${d.selected ? "ring-2 ring-white/70" : ""}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/80"><Zap size={12} /> Trigger</div>
      <div className="mt-1 text-sm font-bold">{t?.label}{d.flow.trigger.type === "segment-oneshot" && d.flow.trigger.segment ? ` · ${d.flow.trigger.segment}` : ""}</div>
      <div className="mt-0.5 text-[10px] text-white/70">{t?.hint}</div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-white/70" />
    </div>
  );
}

function BEmailNode({ data }: NodeProps) {
  const d = data as unknown as { step: BuilderStep; index: number; selected: boolean; onSelect: () => void };
  return (
    <div onClick={d.onSelect}
      className={`w-[250px] cursor-pointer rounded-2xl border bg-ops-surface p-3.5 shadow-card transition ${d.selected ? "border-brand-blue-500 ring-2 ring-brand-blue-500/30" : "border-ops-border hover:border-brand-blue-500/50"}`}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ops-border" />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ops-text-muted">
        <Mail size={12} className="text-brand-blue-400" /> Email {d.index + 1}
      </div>
      <div className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-ops-text">{d.step.subject || <span className="italic text-ops-text-subtle">no subject yet</span>}</div>
      <div className="mt-1.5 text-[10px] text-ops-text-muted">{d.step.html.trim() ? `${Math.round(d.step.html.length / 1024)}kb HTML` : "empty body"}</div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-ops-border" />
    </div>
  );
}

function BAddNode({ data }: NodeProps) {
  const d = data as unknown as { onAdd: () => void };
  return (
    <div onClick={d.onAdd}
      className="flex w-[250px] cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-dashed border-ops-border bg-ops-bg/40 px-3 py-4 text-xs font-semibold text-ops-text-muted transition hover:border-brand-blue-500/60 hover:text-ops-text">
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ops-border" />
      <Plus size={14} /> Add email
    </div>
  );
}

const nodeTypes = { btrigger: BTriggerNode, bemail: BEmailNode, badd: BAddNode };

export function FlowBuilder({ initial, onClose, onSaved }: { initial?: Partial<BuilderFlow>; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [flow, setFlow] = useState<BuilderFlow>({
    name: "", status: "draft", trigger: { type: "optin" }, exitOnPurchase: true, steps: [],
    ...initial,
  } as BuilderFlow);
  const [sel, setSel] = useState<number | "trigger" | null>("trigger");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [testTo, setTestTo] = useState(() => { try { return localStorage.getItem("rp-test-inbox") ?? ""; } catch { return ""; } });
  const [enrollPreview, setEnrollPreview] = useState<{ recipients: number; segment: string } | null>(null);

  const segments = useQuery({
    queryKey: ["rp-marketing-segments"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/marketing/segments", { credentials: "include" })).json() as
      Promise<{ all: number; segments: { slug: string; count: number }[] }>,
    staleTime: 5 * 60_000,
  });

  const setStep = (i: number, patch: Partial<BuilderStep>) =>
    setFlow((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const addStep = () => {
    setFlow((f) => ({ ...f, steps: [...f.steps, { delayHours: f.steps.length === 0 ? 0 : 24, subject: "", html: "" }] }));
    setSel(flow.steps.length);
  };
  const removeStep = (i: number) => { setFlow((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) })); setSel("trigger"); };
  const moveStep = (i: number, dir: -1 | 1) => {
    setFlow((f) => {
      const steps = [...f.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return f;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...f, steps };
    });
    setSel(i + dir);
  };

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [
      { id: "trigger", type: "btrigger", position: { x: 0, y: 0 }, data: { flow, selected: sel === "trigger", onSelect: () => setSel("trigger") } },
      ...flow.steps.map((s, i) => ({
        id: `s${i}`, type: "bemail", position: { x: 25, y: 140 + i * 140 },
        data: { step: s, index: i, selected: sel === i, onSelect: () => setSel(i) },
      })),
      { id: "add", type: "badd", position: { x: 25, y: 140 + flow.steps.length * 140 }, data: { onAdd: addStep } },
    ];
    const edges: Edge[] = [
      ...flow.steps.map((s, i) => ({
        id: `e${i}`, source: i === 0 ? "trigger" : `s${i - 1}`, target: `s${i}`,
        label: fmtDelay(s.delayHours), animated: true,
        labelStyle: { fontSize: 10, fontWeight: 600, fill: "rgb(var(--ops-text-muted))" },
        labelBgStyle: { fill: "rgb(var(--ops-bg))", fillOpacity: 0.9 }, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 6,
        style: { stroke: "rgb(var(--ops-border))", strokeWidth: 1.5 },
      })),
      { id: "eadd", source: flow.steps.length ? `s${flow.steps.length - 1}` : "trigger", target: "add", style: { stroke: "rgb(var(--ops-border))", strokeDasharray: "4 4" } },
    ];
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, sel]);

  async function save(): Promise<{ id: string; key: string } | null> {
    if (!flow.name.trim()) { setMsg({ tone: "bad", text: "Name the flow first." }); return null; }
    if (!flow.steps.length) { setMsg({ tone: "bad", text: "Add at least one email." }); return null; }
    setBusy("save"); setMsg(null);
    try {
      const j = await post({
        action: "custom-flow-save", id: flow.id, name: flow.name, trigger: flow.trigger, exitOnPurchase: flow.exitOnPurchase,
        steps: flow.steps.map((s, i) => ({ index: i, delayHours: s.delayHours, subject: s.subject, html_b64: b64(s.html) })),
      });
      setFlow((f) => ({ ...f, id: j.id, key: j.key }));
      setMsg({ tone: "ok", text: flow.status === "active" ? "Saved — live flow updated (next sweep uses the new copy)." : "Draft saved." });
      onSaved(); qc.invalidateQueries({ queryKey: ["rp-custom-flows"] });
      return j;
    } catch (e: any) { setMsg({ tone: "bad", text: e.message }); return null; } finally { setBusy(null); }
  }

  async function setStatus(status: "active" | "paused" | "draft") {
    const saved = await save();
    if (!saved) return;
    setBusy("status");
    try {
      await post({ action: "custom-flow-status", id: saved.id, status });
      setFlow((f) => ({ ...f, status }));
      setMsg({ tone: "ok", text: status === "active" ? "Flow is LIVE — matching contacts enroll from now on." : `Flow ${status}.` });
      onSaved();
    } catch (e: any) { setMsg({ tone: "bad", text: e.message }); } finally { setBusy(null); }
  }

  async function sendTest(i: number) {
    const saved = await save();
    if (!saved || !testTo.trim()) return;
    try { localStorage.setItem("rp-test-inbox", testTo.trim()); } catch {}
    setBusy("test");
    try {
      await post({ action: "custom-flow-test", flowKey: saved.key, stepIndex: i, to: testTo.trim() });
      setMsg({ tone: "ok", text: `Test of email ${i + 1} sent to ${testTo.trim()}.` });
    } catch (e: any) { setMsg({ tone: "bad", text: e.message }); } finally { setBusy(null); }
  }

  async function enrollSegment(confirmed: boolean) {
    if (flow.status !== "active") { setMsg({ tone: "bad", text: "Activate the flow first — drafts never enroll anyone." }); return; }
    setBusy("enroll");
    try {
      const j = await post({
        action: "custom-flow-enroll-segment", flowKey: flow.key,
        segment: flow.trigger.segment || undefined, ...(confirmed ? { confirm: true } : {}),
      });
      if (j.preview) { setEnrollPreview({ recipients: j.recipients, segment: j.segment }); return; }
      setEnrollPreview(null);
      setMsg({ tone: "ok", text: `Enrolled ${j.enrolled.toLocaleString()} contacts — first email per the step 1 delay.` });
    } catch (e: any) { setEnrollPreview(null); setMsg({ tone: "bad", text: e.message }); } finally { setBusy(null); }
  }

  const s = sel !== "trigger" && sel !== null ? flow.steps[sel] : null;
  const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ops-bg">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ops-border bg-ops-surface px-4 py-3">
        <input value={flow.name} onChange={(e) => setFlow((f) => ({ ...f, name: e.target.value }))}
          placeholder="Name this flow…" autoFocus={!flow.id}
          className="min-w-[200px] flex-1 bg-transparent text-base font-bold text-ops-text placeholder:text-ops-text-muted focus:outline-none" />
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
          flow.status === "active" ? "bg-emerald-500/15 text-emerald-400" : flow.status === "paused" ? "bg-amber-500/15 text-amber-400" : "bg-ops-border text-ops-text-muted"}`}>
          {flow.status}
        </span>
        {flow.status !== "active" ? (
          <button type="button" disabled={busy !== null} onClick={() => setStatus("active")}
            className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-500 px-3.5 py-2 text-xs font-bold text-white disabled:opacity-40">
            {busy === "status" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Activate
          </button>
        ) : (
          <button type="button" disabled={busy !== null} onClick={() => setStatus("paused")}
            className="flex items-center gap-1.5 rounded-lg border border-amber-500/50 px-3.5 py-2 text-xs font-bold text-amber-400 disabled:opacity-40">
            <Pause size={13} /> Pause
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => void save()}
          className="rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : "Save"}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-ops-text-muted hover:text-ops-text" aria-label="Close"><X size={18} /></button>
      </div>

      {msg && (
        <div className={`shrink-0 border-b px-4 py-2 text-xs ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>{msg.text}</div>
      )}
      {enrollPreview && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
          <span className="text-xs text-amber-300">
            Enroll <b>{enrollPreview.recipients.toLocaleString()}</b> contacts ({enrollPreview.segment === "all" ? "everyone mailable" : `segment ${enrollPreview.segment}`}) into this flow? Email 1 sends on its delay. No undo.
          </span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setEnrollPreview(null)} className="text-xs text-ops-text-muted hover:text-ops-text">Cancel</button>
            <button type="button" disabled={busy !== null} onClick={() => enrollSegment(true)}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40">
              {busy === "enroll" ? <Loader2 size={13} className="animate-spin" /> : `Enroll ${enrollPreview.recipients.toLocaleString()} now`}
            </button>
          </span>
        </div>
      )}

      {/* Canvas + editor panel */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-[300px] flex-1">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.3} maxZoom={1.4} nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }}>
            <Background gap={22} size={1.2} color="rgb(var(--ops-border))" />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
        </div>

        <div className="w-full shrink-0 overflow-y-auto border-t border-ops-border bg-ops-surface p-4 lg:w-[420px] lg:border-l lg:border-t-0">
          {sel === "trigger" ? (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-ops-text">Trigger</h3>
              <div className="space-y-2">
                {TRIGGERS.map((t) => (
                  <button key={t.key} type="button" onClick={() => setFlow((f) => ({ ...f, trigger: { ...f.trigger, type: t.key } }))}
                    className={`block w-full rounded-xl border p-3 text-left transition ${flow.trigger.type === t.key ? "border-brand-blue-500 bg-brand-blue-500/5" : "border-ops-border hover:border-ops-border-strong"}`}>
                    <div className="text-xs font-bold text-ops-text">{t.label}</div>
                    <div className="text-[11px] text-ops-text-muted">{t.hint}</div>
                  </button>
                ))}
              </div>
              {flow.trigger.type === "segment-oneshot" && (
                <label className="block text-xs text-ops-text-muted">Segment
                  <select value={flow.trigger.segment ?? ""} onChange={(e) => setFlow((f) => ({ ...f, trigger: { ...f.trigger, segment: e.target.value || undefined } }))} className={`${input} mt-1`}>
                    <option value="">Everyone mailable{segments.data ? ` (${segments.data.all.toLocaleString()})` : ""}</option>
                    {(segments.data?.segments ?? []).map((sg) => <option key={sg.slug} value={sg.slug}>{sg.slug} ({sg.count.toLocaleString()})</option>)}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-ops-text">
                <input type="checkbox" checked={flow.exitOnPurchase} onChange={(e) => setFlow((f) => ({ ...f, exitOnPurchase: e.target.checked }))} className="h-4 w-4 accent-[#2E5BFF]" />
                Exit on purchase — stop the sequence the moment they buy
              </label>
              {flow.trigger.type === "segment-oneshot" && (
                <button type="button" disabled={busy !== null || flow.status !== "active" || !!enrollPreview} onClick={() => enrollSegment(false)}
                  title={flow.status !== "active" ? "Activate first — drafts never enroll anyone" : "Shows the live count first; nothing enrolls until you confirm"}
                  className="flex items-center gap-1.5 rounded-lg border border-ops-border px-3.5 py-2 text-xs font-bold text-ops-text hover:bg-ops-bg disabled:opacity-40">
                  <Users size={13} /> Enroll segment…
                </button>
              )}
            </div>
          ) : s ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-ops-text">Email {(sel as number) + 1}</h3>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => moveStep(sel as number, -1)} disabled={sel === 0} className="rounded p-1.5 text-ops-text-muted hover:text-ops-text disabled:opacity-30" aria-label="Move up"><ArrowUp size={14} /></button>
                  <button type="button" onClick={() => moveStep(sel as number, 1)} disabled={(sel as number) === flow.steps.length - 1} className="rounded p-1.5 text-ops-text-muted hover:text-ops-text disabled:opacity-30" aria-label="Move down"><ArrowDown size={14} /></button>
                  <button type="button" onClick={() => removeStep(sel as number)} className="rounded p-1.5 text-ops-text-muted hover:text-red-400" aria-label="Delete step"><Trash2 size={14} /></button>
                </div>
              </div>
              <label className="block text-xs text-ops-text-muted">Wait before this email
                <div className="mt-1 flex items-center gap-2">
                  <input type="number" min={0} value={s.delayHours % 24 === 0 ? s.delayHours / 24 : s.delayHours}
                    onChange={(e) => { const v = Math.max(0, Number(e.target.value) || 0); setStep(sel as number, { delayHours: s.delayHours % 24 === 0 ? v * 24 : v }); }}
                    className={`${input} w-24`} />
                  <select value={s.delayHours % 24 === 0 ? "days" : "hours"}
                    onChange={(e) => { const n = s.delayHours % 24 === 0 ? s.delayHours / 24 : s.delayHours; setStep(sel as number, { delayHours: e.target.value === "days" ? n * 24 : n }); }}
                    className={`${input} w-28`}>
                    <option value="days">days</option><option value="hours">hours</option>
                  </select>
                  <span className="text-[11px] text-ops-text-muted">{fmtDelay(s.delayHours)}</span>
                </div>
              </label>
              <label className="block text-xs text-ops-text-muted">Subject
                <input value={s.subject} onChange={(e) => setStep(sel as number, { subject: e.target.value })} className={`${input} mt-1`} placeholder="Subject line…" />
              </label>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-ops-text-muted">Body HTML · {"{{firstName}}"} and {"{{siteUrl}}"} substitute at send</span>
                  <button type="button" onClick={() => setPreview(!preview)} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue-400 hover:text-brand-blue-300">
                    {preview ? <Code2 size={12} /> : <Eye size={12} />} {preview ? "Edit" : "Preview"}
                  </button>
                </div>
                {preview && s.html.trim() ? (
                  <iframe title="Step preview" sandbox="" srcDoc={s.html} className="h-[300px] w-full rounded-lg border border-ops-border bg-white" />
                ) : (
                  <textarea value={s.html} onChange={(e) => setStep(sel as number, { html: e.target.value })} rows={11}
                    placeholder="<p>Hey {{firstName}},</p>…  (paste from the AI composer or your design tool)"
                    className={`${input} font-mono text-xs leading-relaxed`} />
                )}
              </div>
              <div className="flex items-center gap-1.5 border-t border-ops-border pt-3">
                <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="test inbox…"
                  className="w-44 rounded-lg border border-ops-border bg-ops-bg px-2.5 py-2 text-xs text-ops-text placeholder:text-ops-text-muted focus:outline-none" />
                <button type="button" disabled={busy !== null || !testTo.trim() || !s.subject || !s.html.trim()} onClick={() => sendTest(sel as number)}
                  className="flex items-center gap-1.5 rounded-lg border border-ops-border px-3 py-2 text-xs font-semibold text-ops-text hover:bg-ops-bg disabled:opacity-40">
                  {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : <Send size={12} />} Send test
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-ops-text-muted">Select the trigger or an email on the canvas to edit it — or add your first email.</div>
          )}
        </div>
      </div>
    </div>
  );
}
