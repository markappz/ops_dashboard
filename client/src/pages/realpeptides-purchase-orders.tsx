import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { api, ui, type Sku } from "./coa/api";
import { PurchaseOrdersPanel } from "./coa/PurchaseOrders";
import { RequestChangeButton } from "../components/change-request";

/**
 * Real Peptides Purchase Orders — its own tab (used to be a modal off the
 * Inventory page). Reads the same tracker proxy as Inventory for SKUs and
 * velocity; the panel carries the status filters so open/draft work stays up top.
 */

type Velocity = Record<string, { units: Record<number, number>; weekly: number }>;
interface Stats { bySku?: Velocity }

export default function RealPeptidesPurchaseOrders() {
  const [flash, setFlash] = useState<string | null>(null);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 5000); };

  const { data: me } = useQuery<{ role: string; permissions?: string[] }>({
    queryKey: ["ops-me"],
    queryFn: async () => (await fetch("/api/ops/auth/me", { credentials: "include" })).json(),
    staleTime: Infinity,
  });
  const canEdit = me?.role === "admin" || (me?.permissions ?? []).includes("realpeptides:coa-upload");

  const skusQ = useQuery({ queryKey: ["coa-skus"], queryFn: () => api<{ skus: Sku[] }>("/skus"), retry: false });
  const statsQ = useQuery({
    queryKey: ["rp-inventory-stats", "28,56"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/inventory-stats?windows=28,56", { credentials: "include" })).json() as Promise<Stats>,
    staleTime: 5 * 60_000,
  });
  const velocity = statsQ.data?.bySku ?? {};
  const skus = useMemo(
    () => (skusQ.data?.skus ?? []).filter((s) => s.requires_coa).sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [skusQ.data],
  );
  const err = skusQ.error as Error | null;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Purchase Orders"
        subtitle="One PO per supplier. Ordered quantities count as on-order; check-ins stock in what actually arrived, box by box. Filter by status to focus on open and draft work."
        actions={<RequestChangeButton area="inventory" company="realpeptides" className={ui.ghost} />}
      />

      {flash && <div className="mb-5 rounded-xl border border-fitscript-green/30 bg-fitscript-green/10 p-3 text-sm text-fitscript-green">{flash}</div>}
      {err && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">Couldn't reach the COA tracker: {err.message}</div>}

      {skusQ.isLoading
        ? <div className="py-16 text-center text-sm text-ops-text-muted">Loading purchase orders…</div>
        : <PurchaseOrdersPanel skus={skus} velocity={velocity} canEdit={canEdit} onSay={say} />}
    </div>
  );
}
