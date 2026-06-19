import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { PageHero } from "../components/page-hero";

type Tab = "orders" | "panels" | "mappings" | "catalog";
type Env = "sandbox" | "production";

const j = (url: string) => fetch(url).then((r) => r.json());

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ordered: "bg-blue-500/15 text-blue-400",
    requisition_ready: "bg-blue-500/15 text-blue-400",
    awaiting_appointment: "bg-yellow-500/15 text-yellow-400",
    appointment_scheduled: "bg-yellow-500/15 text-yellow-400",
    shipped: "bg-purple-500/15 text-purple-400",
    sample_collected: "bg-purple-500/15 text-purple-400",
    processing_at_lab: "bg-purple-500/15 text-purple-400",
    partial_results: "bg-teal-500/15 text-teal-400",
    completed: "bg-fitscript-green/15 text-fitscript-green",
    cancelled: "bg-red-500/15 text-red-400",
    failed: "bg-red-500/15 text-red-400",
    refunded: "bg-red-500/15 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${colors[status] || "bg-ops-border text-ops-text-muted"}`}>
      {(status || "—").replace(/_/g, " ")}
    </span>
  );
}

const money = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const dt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

export default function Labs() {
  const [tab, setTab] = useState<Tab>("orders");
  const [env, setEnv] = useState<Env>("sandbox");
  const qc = useQueryClient();

  return (
    <div className="space-y-6">
      <PageHero title="Labs" subtitle="Manage Junction lab tests, panel mappings, and live order status." />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-ops-card border border-ops-border rounded-lg p-1">
          {(["orders", "panels", "mappings", "catalog"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition ${tab === t ? "bg-fitscript-green text-black" : "text-ops-text-muted hover:text-ops-text"}`}>
              {t}
            </button>
          ))}
        </div>
        {(tab === "mappings" || tab === "catalog") && (
          <div className="inline-flex rounded-lg border border-ops-border overflow-hidden">
            {(["sandbox", "production"] as Env[]).map((e) => (
              <button
                key={e}
                onClick={() => setEnv(e)}
                className={`px-4 py-1.5 text-sm font-medium transition ${
                  env === e
                    ? "bg-fitscript-green text-black"
                    : "bg-ops-card text-ops-text-muted hover:text-ops-text"
                }`}
              >
                {e === "sandbox" ? "Sandbox" : "Production"}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === "orders" && <OrdersTab qc={qc} />}
      {tab === "panels" && <PanelsTab />}
      {tab === "mappings" && <MappingsTab env={env} qc={qc} />}
      {tab === "catalog" && <CatalogTab env={env} qc={qc} />}
    </div>
  );
}

// ── Orders ──────────────────────────────────────────────────────────────────
function OrdersTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{ orders: any[] }>({
    queryKey: ["labs-orders"], queryFn: () => j("/api/ops/labs/orders?limit=200"),
  });
  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: "refresh" | "refund" | "cancel" }) =>
      fetch(`/api/ops/labs/orders/${id}/${kind}`, { method: "POST" }).then(async (r) => ({ ok: r.ok, body: await r.json() })),
    onSuccess: ({ ok, body }) => {
      if (!ok) { alert(body?.error || "Action failed"); return; }
      qc.invalidateQueries({ queryKey: ["labs-orders"] });
      if (selected) qc.invalidateQueries({ queryKey: ["labs-order", selected] });
    },
  });
  const refresh = { mutate: (id: string) => action.mutate({ id, kind: "refresh" }), isPending: action.isPending };

  if (isLoading) return <Loading />;
  const orders = data?.orders ?? [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 bg-ops-card border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg text-ops-text-muted text-xs uppercase">
            <tr><th className="text-left p-3">Panel</th><th className="text-left p-3">Customer</th><th className="text-left p-3">Method</th><th className="text-left p-3">Status</th><th className="text-left p-3">Created</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} onClick={() => setSelected(o.id)}
                className={`border-t border-ops-border cursor-pointer hover:bg-ops-bg/50 ${selected === o.id ? "bg-ops-bg/50" : ""}`}>
                <td className="p-3 text-ops-text">{o.panel_name || o.panel_slug}<span className="ml-1 text-xs text-ops-text-muted">[{o.junction_env}]</span></td>
                <td className="p-3 text-ops-text-muted">{o.user_email || "—"}</td>
                <td className="p-3 text-ops-text-muted">{(o.collection_method || "").replace(/_/g, " ")}</td>
                <td className="p-3"><StatusBadge status={o.status} /></td>
                <td className="p-3 text-ops-text-muted text-xs">{dt(o.created_at)}</td>
              </tr>
            ))}
            {!orders.length && <tr><td colSpan={5} className="p-6 text-center text-ops-text-muted">No Junction orders yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <OrderDetail id={selected}
        onRefresh={(id) => refresh.mutate(id)}
        onRefund={(id) => { if (confirm("Refund this order's payment? Marks it refunded.")) action.mutate({ id, kind: "refund" }); }}
        onCancel={(id) => { if (confirm("Cancel at Junction AND refund the customer?")) action.mutate({ id, kind: "cancel" }); }}
        busy={action.isPending} />
    </div>
  );
}

function OrderDetail({ id, onRefresh, onRefund, onCancel, busy }: { id: string | null; onRefresh: (id: string) => void; onRefund: (id: string) => void; onCancel: (id: string) => void; busy: boolean }) {
  const { data } = useQuery<{ order: any; biomarkers: any[]; events: any[] }>({
    queryKey: ["labs-order", id], queryFn: () => j(`/api/ops/labs/orders/${id}`), enabled: !!id,
  });
  if (!id) return <div className="bg-ops-card border border-ops-border rounded-xl p-6 text-ops-text-muted text-sm">Select an order to see detail, status timeline, and biomarkers.</div>;
  if (!data?.order) return <Loading />;
  const o = data.order;
  const terminal = ["completed", "cancelled", "refunded", "failed"].includes(o.status);
  return (
    <div className="bg-ops-card border border-ops-border rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div><div className="font-semibold text-ops-text">{o.panel_name || o.panel_slug}</div><div className="text-xs text-ops-text-muted">{o.user_email}</div></div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => onRefresh(id)} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md bg-fitscript-green/15 text-fitscript-green font-medium hover:bg-fitscript-green/25 disabled:opacity-50">↻ Refresh</button>
        {o.status !== "refunded" && (
          <button onClick={() => onRefund(id)} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-amber-500/15 text-amber-400 font-medium hover:bg-amber-500/25 disabled:opacity-50">Refund</button>
        )}
        {!terminal && (
          <button onClick={() => onCancel(id)} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-red-500/15 text-red-400 font-medium hover:bg-red-500/25 disabled:opacity-50">Cancel + refund</button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <Field label="Status" value={<StatusBadge status={o.status} />} />
        <Field label="Low-level" value={o.low_level_status || "—"} />
        <Field label="Method" value={(o.collection_method || "").replace(/_/g, " ")} />
        <Field label="Env" value={o.junction_env} />
        <Field label="Requisition" value={o.requisition_pdf_key
          ? <a className="text-ops-accent underline" href={`/api/ops/labs/orders/${o.id}/requisition.pdf`} target="_blank" rel="noreferrer">Open PDF</a>
          : (o.requisition_url ? "✓ (not stored)" : "—")} />
        <Field label="Results PDF" value={o.results_pdf_key
          ? <a className="text-ops-accent underline" href={`/api/ops/labs/orders/${o.id}/results.pdf`} target="_blank" rel="noreferrer">Open PDF</a>
          : "—"} />
      </div>
      {data.biomarkers?.length > 0 && (
        <div><div className="text-xs uppercase text-ops-text-muted mb-1">Biomarkers ({data.biomarkers.length})</div>
          <div className="max-h-40 overflow-auto text-xs space-y-0.5">
            {data.biomarkers.map((b, i) => <div key={i} className="flex justify-between"><span className="text-ops-text">{b.biomarker_name}</span><span className="text-ops-text-muted">{b.value}{b.unit}</span></div>)}
          </div></div>
      )}
      <div><div className="text-xs uppercase text-ops-text-muted mb-1">Event timeline</div>
        <div className="max-h-40 overflow-auto text-xs space-y-1">
          {(data.events || []).map((e, i) => <div key={i} className="flex justify-between gap-2"><span className="text-ops-text">{e.event_type}</span><span className="text-ops-text-muted whitespace-nowrap">{dt(e.created_at)}</span></div>)}
          {!data.events?.length && <div className="text-ops-text-muted">No events.</div>}
        </div></div>
    </div>
  );
}

// ── Mappings ──────────────────────────────────────────────────────────────────
function MappingsTab({ env, qc }: { env: Env; qc: ReturnType<typeof useQueryClient> }) {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<{ mappings: any[] }>({
    queryKey: ["labs-mappings", env], queryFn: () => j(`/api/ops/labs/mappings?env=${env}`),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      fetch(`/api/ops/labs/mappings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["labs-mappings", env] }),
  });
  if (isLoading) return <Loading />;
  const mappings = data?.mappings ?? [];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => navigate(`/labs/mapping/new?env=${env}`)} className="text-sm px-4 py-1.5 rounded-lg bg-fitscript-green text-black font-medium hover:opacity-90">+ Add Mapping</button>
      </div>
      <div className="bg-ops-card border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg text-ops-text-muted text-xs uppercase">
            <tr><th className="text-left p-3">Panel</th><th className="text-left p-3">Method</th><th className="text-left p-3">Junction Test</th><th className="text-left p-3">Price (ours / Junction)</th><th className="text-left p-3">Image</th><th className="text-left p-3">Enabled</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id} className="border-t border-ops-border hover:bg-ops-bg/40 cursor-pointer" onClick={() => navigate(`/labs/mapping/${m.id}`)}>
                <td className="p-3 text-ops-text">{m.display_name || m.panel_slug}<div className="text-xs text-ops-text-muted">{m.panel_slug}</div></td>
                <td className="p-3 text-ops-text-muted">{(m.collection_method || "").replace(/_/g, " ")}</td>
                <td className="p-3 text-ops-text-muted">{m.test_name || m.junction_lab_test_id?.slice(0, 8) + "…"}</td>
                <td className="p-3">
                  <div className="text-ops-text">
                    {money(m.price_cents ?? m.panel_price_cents)}
                    {m.price_cents != null && <span className="ml-1 text-[10px] text-fitscript-green">override</span>}
                  </div>
                  <div className="text-xs text-ops-text-muted">Junction {money(m.test_price_cents)}</div>
                </td>
                <td className="p-3">{m.image_url ? <img src={m.image_url} alt="" className="w-8 h-8 rounded object-cover" /> : <span className="text-xs text-ops-text-muted">—</span>}</td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => toggle.mutate({ id: m.id, enabled: !m.enabled })} disabled={toggle.isPending}
                    className={`relative w-10 h-5 rounded-full transition ${m.enabled ? "bg-fitscript-green" : "bg-ops-border"}`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition ${m.enabled ? "translate-x-5" : ""}`} />
                  </button>
                </td>
                <td className="p-3"><span className="text-xs text-fitscript-green">Edit →</span></td>
              </tr>
            ))}
            {!mappings.length && <tr><td colSpan={7} className="p-6 text-center text-ops-text-muted">No mappings for {env}. Click "+ Add Mapping".</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Catalog ──────────────────────────────────────────────────────────────────
function CatalogTab({ env, qc }: { env: Env; qc: ReturnType<typeof useQueryClient> }) {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<{ tests: any[]; lastSynced: string | null }>({
    queryKey: ["labs-catalog", env], queryFn: () => j(`/api/ops/labs/catalog?env=${env}`),
  });
  const sync = useMutation({
    mutationFn: () => fetch("/api/ops/labs/catalog/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ env }) }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["labs-catalog", env] }),
  });
  const tests = data?.tests ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-ops-text-muted">{data?.lastSynced ? `Last synced ${dt(data.lastSynced)}` : "Never synced"}</div>
        <div className="flex gap-2">
          <button onClick={() => navigate("/labs/builder")}
            className="text-sm px-4 py-1.5 rounded-lg border border-fitscript-green text-fitscript-green font-medium hover:bg-fitscript-green/10">
            + Build Lab Test
          </button>
          <button onClick={() => sync.mutate()} disabled={sync.isPending}
            className="text-sm px-4 py-1.5 rounded-lg bg-fitscript-green text-black font-medium hover:opacity-90 disabled:opacity-50">
            {sync.isPending ? "Syncing…" : "↻ Sync from Junction"}
          </button>
        </div>
      </div>
      {sync.data && <div className="text-xs text-fitscript-green">Synced {sync.data.count} tests.</div>}
      <div className="bg-ops-card border border-ops-border rounded-xl overflow-hidden">
        {isLoading ? <Loading /> : (
          <table className="w-full text-sm">
            <thead className="bg-ops-bg text-ops-text-muted text-xs uppercase">
              <tr><th className="text-left p-3">Name</th><th className="text-left p-3">Method</th><th className="text-left p-3">Lab</th><th className="text-left p-3">Price</th><th className="text-left p-3">Markers</th><th className="text-left p-3">Status</th></tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.junction_lab_test_id} className="border-t border-ops-border">
                  <td className="p-3 text-ops-text">{t.name}</td>
                  <td className="p-3 text-ops-text-muted">{(t.method || "").replace(/_/g, " ")}</td>
                  <td className="p-3 text-ops-text-muted">{t.lab_name || "—"}</td>
                  <td className="p-3 text-ops-text-muted">{money(t.price_cents)}</td>
                  <td className="p-3 text-ops-text-muted">{t.marker_count ?? "—"}</td>
                  <td className="p-3"><span className={`text-xs ${t.status === "active" ? "text-fitscript-green" : "text-ops-text-muted"}`}>{t.status}</span></td>
                </tr>
              ))}
              {!tests.length && <tr><td colSpan={6} className="p-6 text-center text-ops-text-muted">No cached tests. Click "Sync from Junction".</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Panels (product catalog CMS) ──────────────────────────────────────────────
function PanelsTab() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<{ panels: any[] }>({
    queryKey: ["labs-panels"], queryFn: () => j("/api/ops/labs/panels"),
  });
  if (isLoading) return <Loading />;
  // Hide sandbox test panels from the production catalog view (kept in the DB
  // for sandbox order testing; they're already hidden on the live storefront).
  const panels = (data?.panels ?? []).filter((p: any) => !String(p.slug || "").startsWith("sandbox-"));
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => navigate("/labs/panel/new")} className="text-sm px-4 py-1.5 rounded-lg bg-fitscript-green text-black font-medium hover:opacity-90">+ New Panel</button>
      </div>
      <div className="bg-ops-card border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg text-ops-text-muted text-xs uppercase">
            <tr><th className="text-left p-3">Panel</th><th className="text-left p-3">Type</th><th className="text-left p-3">Price</th><th className="text-left p-3">Markers</th><th className="text-left p-3">Active</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {panels.map((p) => (
              <tr key={p.slug} className="border-t border-ops-border hover:bg-ops-bg/40 cursor-pointer" onClick={() => navigate(`/labs/panel/${p.slug}`)}>
                <td className="p-3 text-ops-text">{p.name}<div className="text-xs text-ops-text-muted">{p.slug}</div></td>
                <td className="p-3 text-ops-text-muted">{p.panel_type || "—"}</td>
                <td className="p-3 text-ops-text-muted">{money(p.price_cents)}</td>
                <td className="p-3 text-ops-text-muted">{p.markers_count ?? "—"}</td>
                <td className="p-3"><span className={`text-xs ${p.is_active ? "text-fitscript-green" : "text-ops-text-muted"}`}>{p.is_active ? "live" : "hidden"}</span></td>
                <td className="p-3"><span className="text-xs text-fitscript-green">Edit →</span></td>
              </tr>
            ))}
            {!panels.length && <tr><td colSpan={6} className="p-6 text-center text-ops-text-muted">No panels.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: any }) {
  return <div><div className="text-xs uppercase text-ops-text-muted">{label}</div><div className="text-ops-text">{value}</div></div>;
}
function Loading() { return <div className="bg-ops-card border border-ops-border rounded-xl p-8 text-center text-ops-text-muted text-sm">Loading…</div>; }
