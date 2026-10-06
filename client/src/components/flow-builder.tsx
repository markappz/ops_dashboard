import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlow, Background, Controls, type Node, type Edge, type NodeProps, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X, Zap, Mail, Plus, Trash2, Loader2, Eye, Code2, ArrowUp, ArrowDown, Play, Pause, Send, Users, GitFork } from "lucide-react";

/**
 * Visual flow builder (phase 2 + conditional splits, 2026-10-02) — create and edit ops-built
 * email sequences on a canvas, Klaviyo-style, including an open/click split: shared emails,
 * then "did they open/click the last email?" → YES arm / NO arm. Everything is DRAFT-first:
 * the engine ignores drafts entirely, activation is explicit, and segment enrollment is a
 * server-enforced two-step.
 *
 * Split semantics (mirrors the engine): the split checks ONCE, `splitWaitHours` after the last
 * shared email sends; both arms proceed from that moment. Arm-first delays are the split's wait.
 */

export type Branch = "yes" | "no";
export interface BuilderStep { delayHours: number; subject: string; html: string; branch?: Branch }
export interface BuilderFlow {
  id?: string;
  key?: string;
  name: string;
  status: "draft" | "active" | "paused";
  trigger: { type: "optin" | "first-purchase" | "segment-oneshot"; segment?: string };
  exitOnPurchase: boolean;
  splitOn?: "opened" | "clicked" | null;
  steps: BuilderStep[];
}

const b64 = (x: string) => btoa(String.fromCharCode(...new TextEncoder().encode(x)));
const postTo = async (company: string, body: unknown) => {
  const r = await fetch(`/api/ops/${company}/marketing/custom-flow`, {
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
  const d = data as unknown as { step: BuilderStep; label: string; selected: boolean; onSelect: () => void };
  return (
    <div onClick={d.onSelect}
      className={`w-[250px] cursor-pointer rounded-2xl border bg-ops-surface p-3.5 shadow-card transition ${d.selected ? "border-brand-blue-500 ring-2 ring-brand-blue-500/30" : "border-ops-border hover:border-brand-blue-500/50"}`}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ops-border" />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ops-text-muted">
        <Mail size={12} className="text-brand-blue-400" /> {d.label}
      </div>
      <div className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-ops-text">{d.step.subject || <span className="italic text-ops-text-subtle">no subject yet</span>}</div>
      <div className="mt-1.5 text-[10px] text-ops-text-muted">{d.step.html.trim() ? `${Math.round(d.step.html.length / 1024)}kb HTML` : "empty body"}</div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-ops-border" />
    </div>
  );
}

function BSplitNode({ data }: NodeProps) {
  const d = data as unknown as { splitOn: "opened" | "clicked"; waitHours: number; selected: boolean; onSelect: () => void };
  return (
    <div onClick={d.onSelect}
      className={`w-[250px] cursor-pointer rounded-2xl border-2 bg-ops-surface p-3.5 shadow-card transition ${d.selected ? "border-violet-500 ring-2 ring-violet-500/30" : "border-violet-500/50 hover:border-violet-500"}`}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ops-border" />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-400"><GitFork size={12} /> Split</div>
      <div className="mt-1 text-xs font-bold text-ops-text">Did they {d.splitOn === "clicked" ? "click" : "open"} the last email?</div>
      <div className="mt-0.5 text-[10px] text-ops-text-muted">checks once, {fmtDelay(d.waitHours).replace("wait ", "")} after it sends</div>
      <Handle id="yes" type="source" position={Position.Bottom} style={{ left: "25%" }} className="!h-2 !w-2 !border-0 !bg-emerald-400" />
      <Handle id="no" type="source" position={Position.Bottom} style={{ left: "75%" }} className="!h-2 !w-2 !border-0 !bg-red-400" />
    </div>
  );
}

function BAddNode({ data }: NodeProps) {
  const d = data as unknown as { label: string; onAdd: () => void };
  return (
    <div onClick={d.onAdd}
      className="flex w-[250px] cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-dashed border-ops-border bg-ops-bg/40 px-3 py-4 text-xs font-semibold text-ops-text-muted transition hover:border-brand-blue-500/60 hover:text-ops-text">
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ops-border" />
      <Plus size={14} /> {d.label}
    </div>
  );
}

const nodeTypes = { btrigger: BTriggerNode, bemail: BEmailNode, bsplit: BSplitNode, badd: BAddNode };

type Sel = number | "trigger" | "split" | null;

export function FlowBuilder({ company, initial, onClose, onSaved }: { company: string; initial?: Partial<BuilderFlow>; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const post = (body: unknown) => postTo(company, body);
  // The RP key predates the multi-brand tabs — keep it so saved inboxes survive.
  const inboxKey = company === "realpeptides" ? "rp-test-inbox" : `ops-test-inbox-${company}`;
  const [flow, setFlow] = useState<BuilderFlow>({
    name: "", status: "draft", trigger: { type: "optin" }, exitOnPurchase: true, splitOn: null, steps: [],
    ...initial,
  } as BuilderFlow);
  const [sel, setSel] = useState<Sel>("trigger");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [testTo, setTestTo] = useState(() => { try { return localStorage.getItem(inboxKey) ?? ""; } catch { return ""; } });
  const [enrollPreview, setEnrollPreview] = useState<{ recipients: number; segment: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const segments = useQuery({
    queryKey: ["ops-marketing-segments", company],
    queryFn: async () => (await fetch(`/api/ops/${company}/marketing/segments`, { credentials: "include" })).json() as
      Promise<{ all: number; segments: { slug: string; count: number }[] }>,
    staleTime: 5 * 60_000,
  });

  // Derived groups over the one flat, ordered array (shared → yes → no).
  const shared = flow.steps.filter((s) => !s.branch);
  const yesArm = flow.steps.filter((s) => s.branch === "yes");
  const noArm = flow.steps.filter((s) => s.branch === "no");
  const hasSplit = !!flow.splitOn;
  const splitWait = yesArm[0]?.delayHours ?? noArm[0]?.delayHours ?? 24;
  const flatIndex = (step: BuilderStep) => flow.steps.indexOf(step);
  const armFirst = (i: number) => hasSplit && (flow.steps[i] === yesArm[0] || flow.steps[i] === noArm[0]);

  const reorder = (steps: BuilderStep[]) => [...steps.filter((s) => !s.branch), ...steps.filter((s) => s.branch === "yes"), ...steps.filter((s) => s.branch === "no")];
  const setStep = (i: number, patch: Partial<BuilderStep>) =>
    setFlow((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const addStep = (branch?: Branch) => {
    setFlow((f) => {
      const group = f.steps.filter((s) => s.branch === branch || (!branch && !s.branch));
      const step: BuilderStep = { delayHours: branch ? (group.length ? 24 : splitWait) : group.length === 0 && !branch ? 0 : 24, subject: "", html: "", branch };
      const steps = reorder([...f.steps, step]);
      setTimeout(() => setSel(steps.indexOf(step)), 0);
      return { ...f, steps };
    });
  };

  const removeStep = (i: number) => {
    const victim = flow.steps[i];
    if (!victim.branch && shared.length === 1 && hasSplit) { setMsg({ tone: "bad", text: "Remove the split first — it needs a shared email to test." }); return; }
    setFlow((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }));
    setSel("trigger");
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    setFlow((f) => {
      const s = f.steps[i];
      const group = f.steps.filter((x) => x.branch === s.branch);
      const gi = group.indexOf(s);
      const gj = gi + dir;
      if (gj < 0 || gj >= group.length) return f;
      const newGroup = [...group];
      [newGroup[gi], newGroup[gj]] = [newGroup[gj], newGroup[gi]];
      const others = f.steps.filter((x) => x.branch !== s.branch);
      const steps = reorder([...others, ...newGroup]);
      setTimeout(() => setSel(steps.indexOf(s)), 0);
      return { ...f, steps };
    });
  };

  const addSplit = () => {
    if (!shared.length) { setMsg({ tone: "bad", text: "Add a shared email first — the split tests its opens/clicks." }); return; }
    setFlow((f) => ({ ...f, splitOn: "opened" }));
    setSel("split");
  };
  const removeSplit = () => {
    setFlow((f) => ({ ...f, splitOn: null, steps: f.steps.filter((s) => !s.branch) }));
    setSel("trigger");
  };
  const setSplitWait = (h: number) =>
    setFlow((f) => ({
      ...f,
      steps: f.steps.map((s) => {
        const ya = f.steps.filter((x) => x.branch === "yes")[0];
        const na = f.steps.filter((x) => x.branch === "no")[0];
        return s === ya || s === na ? { ...s, delayHours: h } : s;
      }),
    }));

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [{ id: "trigger", type: "btrigger", position: { x: 0, y: 0 }, data: { flow, selected: sel === "trigger", onSelect: () => setSel("trigger") } }];
    const edges: Edge[] = [];
    const edgeStyle = { stroke: "rgb(var(--ops-border))", strokeWidth: 1.5 };
    const lbl = (text: string) => ({
      label: text, labelStyle: { fontSize: 10, fontWeight: 600, fill: "rgb(var(--ops-text-muted))" },
      labelBgStyle: { fill: "rgb(var(--ops-bg))", fillOpacity: 0.9 }, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 6,
    });
    let y = 140;
    let prev = "trigger";
    shared.forEach((s) => {
      const i = flatIndex(s);
      nodes.push({ id: `s${i}`, type: "bemail", position: { x: 25, y }, data: { step: s, label: `Email ${shared.indexOf(s) + 1}`, selected: sel === i, onSelect: () => setSel(i) } });
      edges.push({ id: `e${i}`, source: prev, target: `s${i}`, animated: true, ...lbl(fmtDelay(s.delayHours)), style: edgeStyle });
      prev = `s${i}`; y += 140;
    });
    if (!hasSplit) {
      nodes.push({ id: "add-shared", type: "badd", position: { x: 25, y }, data: { label: "Add email", onAdd: () => addStep() } });
      edges.push({ id: "e-add", source: prev, target: "add-shared", style: { ...edgeStyle, strokeDasharray: "4 4" } });
      if (shared.length) {
        nodes.push({ id: "add-split", type: "badd", position: { x: 320, y }, data: { label: "Add split (open/click)", onAdd: addSplit } });
        edges.push({ id: "e-add-split", source: prev, target: "add-split", style: { ...edgeStyle, strokeDasharray: "4 4" } });
      }
    } else {
      nodes.push({ id: "split", type: "bsplit", position: { x: 25, y }, data: { splitOn: flow.splitOn, waitHours: splitWait, selected: sel === "split", onSelect: () => setSel("split") } });
      edges.push({ id: "e-split", source: prev, target: "split", animated: true, ...lbl(fmtDelay(splitWait)), style: edgeStyle });
      y += 150;
      const arm = (steps: BuilderStep[], branch: Branch, x: number, handle: string, color: string) => {
        let aPrev = "split";
        let ay = y;
        steps.forEach((s, ai) => {
          const i = flatIndex(s);
          nodes.push({ id: `s${i}`, type: "bemail", position: { x, y: ay }, data: { step: s, label: `${branch === "yes" ? "YES" : "NO"} · email ${ai + 1}`, selected: sel === i, onSelect: () => setSel(i) } });
          edges.push({
            id: `e${i}`, source: aPrev, target: `s${i}`, animated: true,
            ...(aPrev === "split" ? { sourceHandle: handle, ...lbl(branch === "yes" ? "YES" : "NO") } : lbl(fmtDelay(s.delayHours))),
            style: { stroke: color, strokeWidth: 1.5 },
          });
          aPrev = `s${i}`; ay += 140;
        });
        nodes.push({ id: `add-${branch}`, type: "badd", position: { x, y: ay }, data: { label: `Add ${branch.toUpperCase()} email`, onAdd: () => addStep(branch) } });
        edges.push({ id: `e-add-${branch}`, source: aPrev, target: `add-${branch}`, ...(aPrev === "split" ? { sourceHandle: handle, ...lbl(branch === "yes" ? "YES" : "NO") } : {}), style: { stroke: color, strokeWidth: 1.5, strokeDasharray: "4 4" } });
      };
      arm(yesArm, "yes", -150, "yes", "rgba(52,199,123,0.55)");
      arm(noArm, "no", 200, "no", "rgba(239,68,68,0.5)");
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, sel]);

  async function save(): Promise<{ id: string; key: string } | null> {
    if (!flow.name.trim()) { setMsg({ tone: "bad", text: "Name the flow first." }); return null; }
    if (!flow.steps.length) { setMsg({ tone: "bad", text: "Add at least one email." }); return null; }
    if (hasSplit && !yesArm.length && !noArm.length) { setMsg({ tone: "bad", text: "The split has no arm emails — add one or remove the split." }); return null; }
    setBusy("save"); setMsg(null);
    try {
      const ordered = reorder(flow.steps);
      const j = await post({
        action: "custom-flow-save", id: flow.id, name: flow.name, trigger: flow.trigger, exitOnPurchase: flow.exitOnPurchase,
        splitOn: hasSplit ? flow.splitOn : null,
        steps: ordered.map((s, i) => ({ index: i, delayHours: s.delayHours, subject: s.subject, html_b64: b64(s.html), branch: s.branch ?? null })),
      });
      setFlow((f) => ({ ...f, id: j.id, key: j.key }));
      setMsg({ tone: "ok", text: flow.status === "active" ? "Saved — live flow updated (next sweep uses the new copy)." : "Draft saved." });
      onSaved(); qc.invalidateQueries({ queryKey: ["ops-custom-flows", company] });
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

  async function deleteFlow() {
    if (!flow.id) return;
    setBusy("delete");
    try {
      await post({ action: "custom-flow-delete", id: flow.id });
      onSaved(); onClose();
    } catch (e: any) { setMsg({ tone: "bad", text: e.message }); setConfirmDelete(false); } finally { setBusy(null); }
  }

  async function sendTest(i: number) {
    const saved = await save();
    if (!saved || !testTo.trim()) return;
    try { localStorage.setItem(inboxKey, testTo.trim()); } catch {}
    setBusy("test");
    try {
      const orderedIndex = reorder(flow.steps).indexOf(flow.steps[i]);
      await post({ action: "custom-flow-test", flowKey: saved.key, stepIndex: orderedIndex, to: testTo.trim() });
      setMsg({ tone: "ok", text: `Test sent to ${testTo.trim()}.` });
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
      setMsg({ tone: "ok", text: `Enrolled ${j.enrolled.toLocaleString()} contacts — first email per its delay.` });
    } catch (e: any) { setEnrollPreview(null); setMsg({ tone: "bad", text: e.message }); } finally { setBusy(null); }
  }

  const s = typeof sel === "number" ? flow.steps[sel] : null;
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
        {flow.id && flow.status !== "active" && (
          confirmDelete ? (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-red-400">Delete this flow and its enrollments?</span>
              <button type="button" disabled={busy !== null} onClick={() => void deleteFlow()} className="rounded-lg bg-red-500 px-2.5 py-1.5 font-bold text-white disabled:opacity-40">
                {busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : "Delete"}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-ops-text-muted hover:text-ops-text">Keep</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-lg p-2 text-ops-text-muted hover:text-red-400" aria-label="Delete flow"><Trash2 size={15} /></button>
          )
        )}
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
            minZoom={0.25} maxZoom={1.4} nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }}>
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
          ) : sel === "split" && hasSplit ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-bold text-ops-text"><GitFork size={14} className="text-violet-400" /> Conditional split</h3>
                <button type="button" onClick={removeSplit} className="flex items-center gap-1 rounded p-1.5 text-xs text-ops-text-muted hover:text-red-400">
                  <Trash2 size={13} /> Remove split
                </button>
              </div>
              <p className="text-[11px] text-ops-text-muted">Tests engagement on the <b>last shared email</b> once, after the wait below. YES = they {flow.splitOn === "clicked" ? "clicked" : "opened"}; NO = they didn't. Removing the split deletes both arms' emails.</p>
              <div className="space-y-2">
                {(["opened", "clicked"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setFlow((f) => ({ ...f, splitOn: k }))}
                    className={`block w-full rounded-xl border p-3 text-left transition ${flow.splitOn === k ? "border-violet-500 bg-violet-500/5" : "border-ops-border hover:border-ops-border-strong"}`}>
                    <div className="text-xs font-bold text-ops-text">{k === "opened" ? "Opened the email" : "Clicked a link"}</div>
                    <div className="text-[11px] text-ops-text-muted">{k === "opened" ? "any open (clicks count as opens)" : "stricter — needs a link click"}</div>
                  </button>
                ))}
              </div>
              <label className="block text-xs text-ops-text-muted">Wait before checking
                <div className="mt-1 flex items-center gap-2">
                  <input type="number" min={1} value={splitWait % 24 === 0 ? splitWait / 24 : splitWait}
                    onChange={(e) => { const v = Math.max(1, Number(e.target.value) || 1); setSplitWait(splitWait % 24 === 0 ? v * 24 : v); }}
                    className={`${input} w-24`} />
                  <select value={splitWait % 24 === 0 ? "days" : "hours"}
                    onChange={(e) => { const n = splitWait % 24 === 0 ? splitWait / 24 : splitWait; setSplitWait(e.target.value === "days" ? n * 24 : n); }}
                    className={`${input} w-28`}>
                    <option value="days">days</option><option value="hours">hours</option>
                  </select>
                </div>
                <span className="mt-1 block text-[10px] text-ops-text-subtle">Both arms start at this moment — the engagement window is exactly this wait.</span>
              </label>
            </div>
          ) : s ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-ops-text">
                  {s.branch ? `${s.branch.toUpperCase()} arm · ` : ""}Email {(s.branch ? (s.branch === "yes" ? yesArm : noArm) : shared).indexOf(s) + 1}
                </h3>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => moveStep(sel as number, -1)} className="rounded p-1.5 text-ops-text-muted hover:text-ops-text disabled:opacity-30" aria-label="Move up"><ArrowUp size={14} /></button>
                  <button type="button" onClick={() => moveStep(sel as number, 1)} className="rounded p-1.5 text-ops-text-muted hover:text-ops-text disabled:opacity-30" aria-label="Move down"><ArrowDown size={14} /></button>
                  <button type="button" onClick={() => removeStep(sel as number)} className="rounded p-1.5 text-ops-text-muted hover:text-red-400" aria-label="Delete step"><Trash2 size={14} /></button>
                </div>
              </div>
              {armFirst(sel as number) ? (
                <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-[11px] text-ops-text-muted">
                  Sends at the split check ({fmtDelay(splitWait)} after the last shared email) — the wait is set on the split node.
                </div>
              ) : (
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
              )}
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
            <div className="text-xs text-ops-text-muted">Select the trigger, the split, or an email on the canvas — or add your first email.</div>
          )}
        </div>
      </div>
    </div>
  );
}
