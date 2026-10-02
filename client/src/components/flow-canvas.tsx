import { useMemo } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge, type NodeProps, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Mail, Zap, ShieldCheck, Eye } from "lucide-react";

/**
 * Flow Builder canvas (facelift follow-on, 2026-10-02) — the Klaviyo-style visual map of a
 * live engine flow. Phase 1 is read-only wiring: trigger → delay-labelled edges → email nodes
 * carrying live 90d stats; clicking an email opens the same engine-render preview the review
 * table uses. Creating/editing flow STRUCTURE on the canvas is phase 2 (gated — it touches the
 * send engine).
 */

export interface CanvasStep {
  stepIndex: number;
  subject: string;
  delayHours: number;
  handAuthored: boolean;
  edited?: "live" | "draft";
  sends?: number;
  openRate?: number | null;
  clickRate?: number | null;
}

export interface CanvasFlow {
  key: string;
  banner: string;
  exitOnPurchase: boolean;
  steps: CanvasStep[];
  revenueCents?: number;
}

const fmtDelay = (h: number) => (h === 0 ? "immediately" : h % 24 === 0 ? `wait ${h / 24}d` : `wait ${h}h`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function TriggerNode({ data }: NodeProps) {
  const d = data as unknown as { banner: string; exitOnPurchase: boolean; revenueCents?: number };
  return (
    <div className="w-[260px] rounded-2xl bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 p-4 text-white shadow-[0_8px_30px_-8px_rgba(46,91,255,0.55)]">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/80">
        <Zap size={12} /> Trigger
      </div>
      <div className="mt-1 text-sm font-bold leading-snug">{d.banner}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {d.exitOnPurchase && (
          <span className="flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold">
            <ShieldCheck size={10} /> exits on purchase
          </span>
        )}
        {!!d.revenueCents && d.revenueCents > 0 && (
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold">
            ${Math.round(d.revenueCents / 100).toLocaleString()} · 90d
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-white/70" />
    </div>
  );
}

function EmailNode({ data }: NodeProps) {
  const d = data as unknown as CanvasStep & { onPreview: () => void };
  return (
    <div
      onClick={d.onPreview}
      className="group w-[260px] cursor-pointer rounded-2xl border border-ops-border bg-ops-surface p-3.5 shadow-card transition-all hover:-translate-y-px hover:border-brand-blue-500/50 hover:shadow-card-lg"
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ops-border" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ops-text-muted">
          <Mail size={12} className="text-brand-blue-400" /> Email {d.stepIndex + 1}
        </div>
        <Eye size={12} className="text-ops-text-subtle opacity-0 transition group-hover:opacity-100" />
      </div>
      <div className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-ops-text">{d.subject}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {d.edited === "live" ? (
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">✏️ edited</span>
        ) : d.handAuthored ? (
          <span className="rounded-full border border-brand-blue-500/30 bg-brand-blue-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-brand-blue-400">Josh's copy</span>
        ) : (
          <span className="rounded-full border border-ops-border px-1.5 py-0.5 text-[9px] text-ops-text-muted">engine</span>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-ops-text-muted">
          {d.sends != null ? `${d.sends.toLocaleString()} sent · ${pct(d.openRate)} open · ${pct(d.clickRate)} click` : "no sends yet"}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-ops-border" />
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, email: EmailNode };

export function FlowCanvas({ flow, onPreview }: { flow: CanvasFlow; onPreview: (stepIndex: number, subject: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { banner: flow.banner, exitOnPurchase: flow.exitOnPurchase, revenueCents: flow.revenueCents }, draggable: true },
      ...flow.steps.map((s, i) => ({
        id: `step-${s.stepIndex}`,
        type: "email",
        position: { x: 30, y: 150 + i * 150 },
        data: { ...s, onPreview: () => onPreview(s.stepIndex, s.subject) },
        draggable: true,
      })),
    ];
    const edges: Edge[] = flow.steps.map((s, i) => ({
      id: `e-${i}`,
      source: i === 0 ? "trigger" : `step-${flow.steps[i - 1].stepIndex}`,
      target: `step-${s.stepIndex}`,
      label: fmtDelay(s.delayHours),
      labelStyle: { fontSize: 10, fontWeight: 600, fill: "rgb(var(--ops-text-muted))" },
      labelBgStyle: { fill: "rgb(var(--ops-bg))", fillOpacity: 0.9 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
      animated: true,
      style: { stroke: "rgb(var(--ops-border-strong, var(--ops-border)))", strokeWidth: 1.5 },
    }));
    return { nodes, edges };
  }, [flow, onPreview]);

  return (
    <div className="h-[560px] overflow-hidden rounded-2xl border border-ops-border bg-ops-bg/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.4}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1.2} color="rgb(var(--ops-border))" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
