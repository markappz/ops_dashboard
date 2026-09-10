/**
 * Dirt's Real Peptides toolbox — inventory, purchase orders, suppliers, COA
 * tests and dashboard change requests, in plain English. Every write goes
 * through the same tracker API the Inventory and COA tabs use, stamped with
 * the admin's email, so it lands in Recent stock moves and the audit log
 * exactly like a click would.
 */
import { createChangeRequest } from "./change-requests";
import { runRpImageSync } from "./realpeptides-images";
import { runTargetRefresh } from "./realpeptides-targets";
import { velocityBySku } from "./realpeptides-inventory";

type Ctx = { adminEmail: string };
export interface RpToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: any, ctx: Ctx) => Promise<unknown>;
  write?: boolean;
}

function tracker() {
  const token = process.env.COA_OPS_TOKEN;
  if (!token) throw new Error("COA tracker not configured on ops (COA_OPS_TOKEN)");
  return { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token };
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const t = tracker();
  const r = await fetch(`${t.base}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let body: any; try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(body?.error || `tracker ${path} → ${r.status}`);
  return body;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Resolve "bpc 10mg" / "RP-BPC10V" / a numeric id to one SKU, or explain the ambiguity. */
async function findSku(query: string | number): Promise<any> {
  const { skus } = await call("/skus");
  if (typeof query === "number" || /^\d+$/.test(String(query))) {
    const s = skus.find((x: any) => x.id === Number(query));
    if (s) return s;
  }
  const q = norm(String(query));
  const exact = skus.filter((s: any) => norm(s.sku_code) === q || norm(s.product_name) === q);
  if (exact.length === 1) return exact[0];
  const words = q.split(" ");
  const hits = skus.filter((s: any) => { const hay = `${norm(s.product_name)} ${norm(s.sku_code)}`; return words.every((w) => hay.includes(w)); });
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No product matches "${query}". Try the SKU code (e.g. RP-BPC10V).`);
  throw new Error(`"${query}" matches ${hits.length} products: ${hits.slice(0, 6).map((s: any) => `${s.product_name} (${s.sku_code})`).join("; ")}. Say which.`);
}

const brief = (s: any) => ({ id: s.id, sku_code: s.sku_code, product_name: s.product_name, in_stock: Number(s.current_stock ?? 0), held: Number(s.held ?? 0), on_order: Number(s.on_order ?? 0), target: s.ideal_stock == null ? null : Number(s.ideal_stock), supplier: s.supplier ?? null, coa_status: s.status, do_not_replenish: !!s.do_not_replenish });

export const RP_READ_TOOLS: RpToolDef[] = [
  {
    name: "rp_inventory",
    description: "Real Peptides inventory: every product's stock on hand, held by paid orders, on order, target, supplier and COA status. Optional filter: below_target, out_of_stock, needs_coa, or a search string.",
    input_schema: { type: "object", properties: { filter: { type: "string", description: "below_target | out_of_stock | needs_coa | free text" } }, required: [] },
    handler: async ({ filter }) => {
      const { skus } = await call("/skus");
      let list = skus.filter((s: any) => s.active !== false);
      const f = String(filter || "").trim().toLowerCase();
      if (f === "below_target") list = list.filter((s: any) => s.ideal_stock != null && Number(s.current_stock ?? 0) - Number(s.held ?? 0) + Number(s.on_order ?? 0) < Number(s.ideal_stock) && !s.do_not_replenish);
      else if (f === "out_of_stock") list = list.filter((s: any) => Number(s.current_stock ?? 0) <= 0);
      else if (f === "needs_coa") list = list.filter((s: any) => s.status === "expired" || s.status === "untested");
      else if (f) { const q = norm(f); list = list.filter((s: any) => `${norm(s.product_name)} ${norm(s.sku_code)}`.includes(q)); }
      return { count: list.length, products: list.map(brief) };
    },
  },
  {
    name: "rp_product",
    description: "One Real Peptides product in detail (stock, target, cover weeks, supplier, COA dates, recent stock moves). Accepts a name, SKU code or id.",
    input_schema: { type: "object", properties: { product: { type: "string" } }, required: ["product"] },
    handler: async ({ product }) => {
      const s = await findSku(product);
      const log = await call(`/skus/${s.id}/stock-log?limit=15`);
      return { ...brief(s), cover_weeks: s.cover_weeks, coa_test_date: s.coa_test_date, coa_expiry_date: s.coa_expiry_date, test_status: s.test_status, recent_moves: log.log };
    },
  },
  {
    name: "rp_velocity",
    description: "Real Peptides sales velocity per SKU (units sold in the last 7/28/56 days and weekly rate) from Woo history + live site orders.",
    input_schema: { type: "object", properties: { product: { type: "string", description: "optional name/SKU to narrow" } }, required: [] },
    handler: async ({ product }) => {
      const v = await velocityBySku([7, 28, 56]);
      if (!product) return { bySku: v.bySku, unmatched: v.unmatched };
      const s = await findSku(product);
      return { product: brief(s), velocity: v.bySku[s.sku_code] ?? null };
    },
  },
  {
    name: "rp_purchase_orders",
    description: "Real Peptides purchase orders with lines, status (draft/ordered/received/cancelled), supplier and received quantities.",
    input_schema: { type: "object", properties: { status: { type: "string", description: "optional: draft | ordered | received | cancelled" } }, required: [] },
    handler: async ({ status }) => {
      const { pos } = await call("/pos");
      return { pos: pos.filter((p: any) => !status || p.status === status) };
    },
  },
  {
    name: "rp_suppliers",
    description: "Supplier roster for Real Peptides and how many products are assigned to each.",
    input_schema: { type: "object", properties: {}, required: [] },
    handler: async () => call("/suppliers"),
  },
];

export const RP_WRITE_TOOLS: RpToolDef[] = [
  {
    name: "rp_adjust_stock",
    description: "Add or remove units of a Real Peptides product (delta, e.g. +250 or -12), or set the exact count with `set`. Logged as a manual move by the admin.",
    input_schema: { type: "object", properties: { product: { type: "string" }, delta: { type: "number" }, set: { type: "number" }, note: { type: "string" } }, required: ["product"] },
    write: true,
    handler: async ({ product, delta, set, note }, { adminEmail }) => {
      const s = await findSku(product);
      const body: any = { by: adminEmail, note: note || (set !== undefined ? "manual count (Dirt)" : (delta ?? 0) > 0 ? "manual add (Dirt)" : "manual remove (Dirt)") };
      if (set !== undefined && set !== null) body.set = set; else body.delta = delta;
      const r = await call(`/skus/${s.id}/stock`, { method: "POST", body: JSON.stringify(body) });
      return { product: s.product_name, now_in_stock: r.current_stock, logged_as: body.note, by: adminEmail };
    },
  },
  {
    name: "rp_set_product",
    description: "Update a Real Peptides product's target on hand, cover weeks, supplier, do-not-replenish flag, site alias (coa_name) or backorder message.",
    input_schema: { type: "object", properties: { product: { type: "string" }, target: { type: "number" }, cover_weeks: { type: "number" }, supplier: { type: "string" }, do_not_replenish: { type: "boolean" }, site_alias: { type: "string" }, backorder_message: { type: "string" } }, required: ["product"] },
    write: true,
    handler: async ({ product, target, cover_weeks, supplier, do_not_replenish, site_alias, backorder_message }, { adminEmail }) => {
      const s = await findSku(product);
      const patch: any = { by: adminEmail };
      if (target !== undefined) patch.ideal_stock = target;
      if (cover_weeks !== undefined) patch.cover_weeks = cover_weeks;
      if (supplier !== undefined) patch.supplier = supplier;
      if (do_not_replenish !== undefined) patch.do_not_replenish = do_not_replenish;
      if (site_alias !== undefined) patch.coa_name = site_alias;
      if (backorder_message !== undefined) patch.backorder_message = backorder_message;
      const r = await call(`/skus/${s.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      return brief({ ...s, ...r });
    },
  },
  {
    name: "rp_add_product",
    description: "Add a new Real Peptides product or variant to the tracker: name, SKU code, optional supplier, target, cover weeks, starting stock, site alias, needs_coa (default true).",
    input_schema: { type: "object", properties: { product_name: { type: "string" }, sku_code: { type: "string" }, supplier: { type: "string" }, target: { type: "number" }, cover_weeks: { type: "number" }, starting_stock: { type: "number" }, site_alias: { type: "string" }, needs_coa: { type: "boolean" }, product_url: { type: "string" } }, required: ["product_name", "sku_code"] },
    write: true,
    handler: async (a, { adminEmail }) => {
      const r = await call("/skus", { method: "POST", body: JSON.stringify({ product_name: a.product_name, sku_code: a.sku_code, supplier: a.supplier ?? null, ideal_stock: a.target ?? null, cover_weeks: a.cover_weeks ?? null, initial_stock: a.starting_stock ?? null, coa_name: a.site_alias ?? null, requires_coa: a.needs_coa !== false, product_url: a.product_url ?? null, by: adminEmail }) });
      return brief(r);
    },
  },
  {
    name: "rp_create_po",
    description: "Create a draft purchase order for one supplier. With no lines given, it pre-fills every product below target for that supplier with the recommended quantity (target − stock − on-order, rounded up to tens). Lines: [{product, qty}].",
    input_schema: { type: "object", properties: { supplier: { type: "string" }, lines: { type: "array", items: { type: "object", properties: { product: { type: "string" }, qty: { type: "number" } }, required: ["product", "qty"] } }, note: { type: "string" }, mark_ordered: { type: "boolean", description: "also mark it ordered right away (default false)" } }, required: ["supplier"] },
    write: true,
    handler: async ({ supplier, lines, note, mark_ordered }, { adminEmail }) => {
      const { skus } = await call("/skus");
      let items: { sku_id: number; qty: number }[] = [];
      if (Array.isArray(lines) && lines.length) {
        for (const l of lines) { const s = await findSku(l.product); items.push({ sku_id: s.id, qty: Number(l.qty) }); }
      } else {
        for (const s of skus) {
          if (s.supplier !== supplier || s.do_not_replenish || s.ideal_stock == null) continue;
          const need = Number(s.ideal_stock) - (Number(s.current_stock ?? 0) - Number(s.held ?? 0)) - Number(s.on_order ?? 0);
          if (need > 0) items.push({ sku_id: s.id, qty: Math.ceil(need / 10) * 10 });
        }
      }
      if (!items.length) return { created: false, reason: `Nothing below target for ${supplier}` };
      const po = await call("/pos", { method: "POST", body: JSON.stringify({ supplier, note: note || null, items, by: adminEmail }) });
      if (mark_ordered) await call(`/pos/${po.id}`, { method: "PATCH", body: JSON.stringify({ status: "ordered", by: adminEmail }) });
      return { created: true, po_id: po.id, supplier, lines: po.items.length, units: po.items.reduce((a: number, i: any) => a + Number(i.qty), 0), status: mark_ordered ? "ordered" : "draft", download: `Open Inventory → POs → PO #${po.id} → PDF` };
    },
  },
  {
    name: "rp_po_status",
    description: "Change a Real Peptides PO's status: ordered (draft→ordered), draft (un-order, nothing received), received (stock in all remaining), cancelled. Or delete it (open POs with nothing received).",
    input_schema: { type: "object", properties: { po_id: { type: "number" }, status: { type: "string", description: "ordered | draft | received | cancelled | delete" } }, required: ["po_id", "status"] },
    write: true,
    handler: async ({ po_id, status }, { adminEmail }) => {
      if (status === "delete") { await call(`/pos/${po_id}`, { method: "DELETE" }); return { po_id, deleted: true }; }
      const r = await call(`/pos/${po_id}`, { method: "PATCH", body: JSON.stringify({ status, by: adminEmail }) });
      return { po_id, status: r.status };
    },
  },
  {
    name: "rp_po_checkin",
    description: "Check in a delivery against an ordered PO: lines [{product, qty}] of what arrived. Stock moves are audited. close_short=true closes the PO with anything left marked never received.",
    input_schema: { type: "object", properties: { po_id: { type: "number" }, lines: { type: "array", items: { type: "object", properties: { product: { type: "string" }, qty: { type: "number" } }, required: ["product", "qty"] } }, close_short: { type: "boolean" } }, required: ["po_id", "lines"] },
    write: true,
    handler: async ({ po_id, lines, close_short }, { adminEmail }) => {
      const { pos } = await call("/pos");
      const po = pos.find((p: any) => p.id === Number(po_id));
      if (!po) throw new Error(`PO #${po_id} not found`);
      const resolved: { item_id: number; qty: number }[] = [];
      for (const l of lines) {
        const s = await findSku(l.product);
        const item = po.items.find((i: any) => i.sku_id === s.id);
        if (!item) throw new Error(`${s.product_name} isn't on PO #${po_id}`);
        resolved.push({ item_id: item.id, qty: Number(l.qty) });
      }
      return call(`/pos/${po_id}/checkin`, { method: "POST", body: JSON.stringify({ lines: resolved, close: !!close_short, by: adminEmail }) });
    },
  },
  {
    name: "rp_assign_suppliers",
    description: "Auto-assign suppliers by product type (capsules/tablets → Mike, sprays & serums → Caleb, vials → Ming). Only unassigned products unless overwrite=true.",
    input_schema: { type: "object", properties: { overwrite: { type: "boolean" } }, required: [] },
    write: true,
    handler: async ({ overwrite }) => call("/skus/assign-suppliers", { method: "POST", body: JSON.stringify({ overwrite: !!overwrite }) }),
  },
  {
    name: "rp_refresh_targets",
    description: "Recompute every Real Peptides target from the last 8 weeks of sales right now (the same job that runs every 4 weeks).",
    input_schema: { type: "object", properties: {}, required: [] },
    write: true,
    handler: async () => { const r = await runTargetRefresh("manual"); return { changed: r.changed, unchanged: r.unchanged, skipped: r.skipped, sample: r.changes.slice(0, 10) }; },
  },
  {
    name: "rp_sync_images",
    description: "Pull product photos from realpeptides.co into the tracker for products missing one (force=true re-pulls all).",
    input_schema: { type: "object", properties: { force: { type: "boolean" } }, required: [] },
    write: true,
    handler: async ({ force }) => runRpImageSync(!!force),
  },
  {
    name: "request_dashboard_change",
    description: "File a change request for the ops dashboard itself (a new column, a button, a report, a fix). It's queued, posted to Slack, and Claude Code builds it into a pull request for Paul to approve. Use when the user wants the dashboard to work differently — not for data changes.",
    input_schema: { type: "object", properties: { title: { type: "string" }, details: { type: "string", description: "what should change and why, as specifically as the user said it" }, area: { type: "string", description: "e.g. inventory, coa, orders, email, leads" }, company: { type: "string", description: "realpeptides | fitscript | pawgen | peptideu" } }, required: ["title", "details"] },
    write: true,
    handler: async ({ title, details, area, company }, { adminEmail }) => {
      const r = await createChangeRequest({ title, body: details, area, company, requestedBy: adminEmail });
      return { request_id: r.id, status: r.status, note: r.status === "building" ? "Claude Code is building it; Paul gets a Slack ping and approves in Settings → Requests." : `Queued for a human: ${r.error || ""}` };
    },
  },
];
