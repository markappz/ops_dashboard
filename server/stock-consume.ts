/**
 * Everything that ships via ShippingEasy deducts stock — Paul, 2026-09-17.
 *
 * Retail site orders already do (realpeptides-inventory.ts). This adds the two
 * flows that were bypassing the tracker entirely (550 vials shipped undeducted
 * between 09-03 and 09-17):
 *
 *  - Real Peptides WHOLESALE (/api/ops-wholesale): PAID = queued for
 *    ShippingEasy → hold; SHIPPED → deduct. Sheet items carry DP-* codes and
 *    display names, not tracker codes — WS_SKU_MAP pins the names the tracker's
 *    fuzzy matcher provably fails on (blends, ambiguous doses); everything else
 *    matches by name and lands in the same unmatched banner Justin watches.
 *
 *  - pawgen K9-REPAIR (orders in pawgen's own DB): the product IS the WOLVE
 *    10/10 stack (Paul, 09-17) — packs of 1/2/4 vials × quantity — plus BAC
 *    add-on vials. paid → hold; the ShippingEasy webhook's "shipped" → deduct.
 *
 * Both replay into the tracker's idempotent /api/orders/consume under WS-* /
 * PG-* order ids, deliberately WITHOUT windowStart: that release heuristic
 * assumes the batch covers every order in its window, which is only true for
 * the retail feed. A cancelled hold therefore stays held until the tracker's
 * 30-day stale-hold surfacing catches it — rare, visible, never silent.
 */
import { pawgenPool } from "./db";

const WS_SINCE = process.env.RP_WS_SYNC_SINCE || "2026-09-03T00:00:00Z"; // covers the 6 undeducted shipments Paul approved
const PG_SINCE = process.env.PAWGEN_STOCK_SINCE || "2026-09-17T18:00:00Z"; // forward-only: earlier pawgen sales may be in physical counts
const EVERY_MS = 10 * 60_000;
const WS_DAYS = 60;

function siteCfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}
function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  return token ? { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token } : null;
}

/** "Trinity-X (GLP3-RT)" + "10 mg" → "trinityx|10mg" — parentheticals out, punctuation out. */
function wsKey(product: string, strength: string): string {
  const canon = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9+/]+/g, "");
  return `${canon(product)}|${canon(strength)}`;
}

/**
 * Only the names the tracker's matcher verifiably cannot resolve (tested
 * against normalizeForMatch): blends whose dose lists mangle the core, and
 * 5-Amino 50mg, which is ambiguous between tablets and injectable (the
 * wholesale sheet sells vials). Codes copied from the live tracker catalog —
 * never guessed.
 */
const WS_SKU_MAP: Record<string, string> = {
  "5amino1mq|50mg": "RP-5amino50V",
  "adamax|10mg": "RP-Ada10V",
  "glow|50/10/10mg": "RP-GLOW50V",
  "klow|50/10/10/10mg": "RP-KLOW80V",
  "wolverine|10/10mg": "RP-WOLV10V",
  "wolverine|5/5mg": "RP-WOLV5V",
};

const WOLVE_10_SKU = "RP-WOLV10V";
const BAC_SKU = "RP-BAC10V";

interface ConsumeOrder { id: string; number: string; createdAt: string; status: string; items: { sku?: string; name: string; qty: number }[] }
export interface ConsumeResult { at: string; applied: number; alreadyApplied: number; unmatched: string[]; error?: string }

async function postConsume(orders: ConsumeOrder[]): Promise<ConsumeResult> {
  const tracker = trackerCfg();
  if (!tracker) return { at: new Date().toISOString(), applied: 0, alreadyApplied: 0, unmatched: [], error: "tracker not configured" };
  if (!orders.length) return { at: new Date().toISOString(), applied: 0, alreadyApplied: 0, unmatched: [] };
  // No windowStart on purpose — see the header comment.
  const r = await fetch(`${tracker.base}/api/orders/consume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tracker.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ orders }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await r.text();
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new Error(`consume ${r.status}: ${raw.replace(/<[^>]*>/g, " ").trim().slice(0, 120)}`); }
  if (!r.ok) throw new Error(j.error || `consume ${r.status}`);
  return {
    at: new Date().toISOString(),
    applied: (j.held ?? 0) + (j.deducted ?? 0),
    alreadyApplied: j.alreadyApplied ?? j.skipped ?? 0,
    unmatched: j.unmatched ?? [],
  };
}

export let lastWholesaleSync: ConsumeResult | null = null;
export let lastPawgenSync: ConsumeResult | null = null;

export async function runWholesaleConsume(): Promise<ConsumeResult | null> {
  const site = siteCfg();
  if (!site || !trackerCfg()) return null;
  try {
    const r = await fetch(`${site.base}/api/ops-wholesale?days=${WS_DAYS}`, {
      headers: { Authorization: `Bearer ${site.token}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`ops-wholesale ${r.status}`);
    const j = await r.json();
    const list: any[] = j.orders ?? j.inquiries ?? [];
    const orders: ConsumeOrder[] = [];
    for (const o of list) {
      const status = String(o.status ?? "");
      if (status !== "PAID" && status !== "SHIPPED") continue;
      const created = String(o.createdAt ?? o.created_at ?? "");
      if (!o.ref || !created || created < WS_SINCE) continue;
      const items = (o.items ?? [])
        .map((i: any) => ({
          sku: WS_SKU_MAP[wsKey(String(i.product ?? ""), String(i.strength ?? ""))],
          name: `${i.product ?? ""} - ${i.strength ?? ""}`.trim(),
          qty: Math.max(0, Number(i.vials ?? 0)),
        }))
        .filter((i: any) => i.qty > 0);
      if (!items.length) continue;
      orders.push({ id: `WS-${o.ref}`, number: String(o.ref), createdAt: created, status: status === "SHIPPED" ? "fulfilled" : "paid", items });
    }
    lastWholesaleSync = await postConsume(orders);
    if (lastWholesaleSync.applied) console.log(`[OPS][RP] wholesale stock consume: ${lastWholesaleSync.applied} applied${lastWholesaleSync.unmatched.length ? `, unmatched: ${lastWholesaleSync.unmatched.join(" | ")}` : ""}`);
  } catch (e: any) {
    console.error("[OPS][RP] wholesale stock consume:", e.message);
    lastWholesaleSync = { at: new Date().toISOString(), applied: 0, alreadyApplied: 0, unmatched: [], error: e.message };
  }
  return lastWholesaleSync;
}

export async function runPawgenConsume(): Promise<ConsumeResult | null> {
  if (!pawgenPool || !trackerCfg()) return null;
  try {
    const { rows } = await pawgenPool.query(
      `SELECT id, order_no, created_at, pack_id, quantity, bac_addon_qty, fulfillment_status
         FROM orders
        WHERE payment_status = 'paid' AND fulfillment_status != 'cancelled' AND created_at >= $1
        ORDER BY created_at DESC LIMIT 500`, [PG_SINCE]);
    const orders: ConsumeOrder[] = [];
    for (const o of rows) {
      // "2-pack" × quantity → vials of the stack; pack id's leading integer is the pack size.
      const packSize = Math.max(1, parseInt(String(o.pack_id), 10) || 1);
      const vials = packSize * Math.max(1, Number(o.quantity ?? 1));
      const items: ConsumeOrder["items"] = [{ sku: WOLVE_10_SKU, name: "Wolverine Peptide Stack - BPC-157 10mg / TB-500 10mg", qty: vials }];
      const bac = Math.max(0, Number(o.bac_addon_qty ?? 0));
      if (bac) items.push({ sku: BAC_SKU, name: "Bacteriostatic Water - 10ml", qty: bac });
      orders.push({
        id: `PG-${o.id}`,
        number: String(o.order_no ?? o.id),
        createdAt: new Date(o.created_at).toISOString(),
        status: o.fulfillment_status === "shipped" ? "fulfilled" : "paid",
        items,
      });
    }
    lastPawgenSync = await postConsume(orders);
    if (lastPawgenSync.applied) console.log(`[OPS][PAWGEN] stock consume: ${lastPawgenSync.applied} applied (WOLVE 10/10${rows.some((r: any) => r.bac_addon_qty > 0) ? " + BAC add-ons" : ""})`);
  } catch (e: any) {
    console.error("[OPS][PAWGEN] stock consume:", e.message);
    lastPawgenSync = { at: new Date().toISOString(), applied: 0, alreadyApplied: 0, unmatched: [], error: e.message };
  }
  return lastPawgenSync;
}

export function startStockConsumeLoops() {
  const tick = async () => {
    await runWholesaleConsume();
    await runPawgenConsume();
  };
  setTimeout(tick, 20_000); // let the boot settle; retail sync kicks first
  setInterval(tick, EVERY_MS);
  console.log("[OPS] wholesale + pawgen stock consume loops started");
}
