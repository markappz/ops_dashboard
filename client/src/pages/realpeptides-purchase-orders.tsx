import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { api, ui, type Sku } from "./coa/api";
import { applyTargetWeeks } from "./coa/order-pdf";
import { PurchaseOrders } from "./coa/PurchaseOrders";
import { RequestChangeButton } from "../components/change-request";

/**
 * Real Peptides purchase orders — its own top-level tab (split out of the
 * Inventory tab). Targets still follow the "Stock up for" setting chosen on
 * Inventory, so recommended order quantities match what that tab shows.
 */

type Velocity = Record<string, { units: Record<number, number>; weekly: number }>;

function readTargetWeeks(): number | null {
  try { const v = localStorage.getItem("rp-target-weeks"); return v ? Number(v) : null; } catch { return null; }
}

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
    queryFn: async () => (await fetch("/api/ops/realpeptides/inventory-stats?windows=28,56", { credentials: "include" })).json() as Promise<{ bySku?: Velocity }>,
    staleTime: 5 * 60_000,
  });
  const velocity = statsQ.data?.bySku ?? {};
  const rawSkus = useMemo(
    () => (skusQ.data?.skus ?? []).filter((s) => s.requires_coa).sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [skusQ.data],
  );
  const skus = useMemo(() => applyTargetWeeks(rawSkus, velocity, readTargetWeeks()), [rawSkus, velocity]);

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Purchase orders"
        subtitle="One PO per supplier. Ordered quantities count as on-order; check-ins stock in what actually arrived, box by box."
        actions={<RequestChangeButton area="inventory" company="realpeptides" className={ui.ghost} />}
      />
      {flash && <div className="mb-5 rounded-xl border border-fitscript-green/30 bg-fitscript-green/10 p-3 text-sm text-fitscript-green">{flash}</div>}
      {canEdit
        ? <PurchaseOrders skus={skus} velocity={velocity} onSay={say} />
        : <div className="rounded-2xl border border-ops-border bg-ops-surface p-10 text-center text-sm text-ops-text-muted">You don't have access to purchase orders.</div>}
    </div>
  );
}
