import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Sku } from "./api";

/** What we're counting: finished product (vials/units) or printed vial labels. */
export type InvItem = "product" | "label";

export const stockNum = (v: number | string | null) => (v === null || v === "" || v === undefined ? null : Number(v));
export const stockOf = (s: Sku, item: InvItem) => stockNum(item === "label" ? s.label_stock : s.current_stock);
export const idealOf = (s: Sku, item: InvItem) => stockNum(item === "label" ? s.label_ideal : s.ideal_stock);

/** Below target (target set) — or flat out with a recorded count.
 *  Sunset products (do_not_replenish) are never "low": we sell what's left. */
export function isLow(s: Sku, item: InvItem = "product"): boolean {
  if (s.do_not_replenish) return false;
  const cur = stockOf(s, item);
  const ideal = idealOf(s, item);
  if (ideal !== null && ideal > 0) return (cur ?? 0) < ideal;
  return cur !== null && cur <= 0;
}

export function orderQty(s: Sku, item: InvItem = "product"): number | null {
  if (s.do_not_replenish) return null;
  const cur = stockOf(s, item);
  const ideal = idealOf(s, item);
  // Vials already on an open PO don't need re-ordering; vials held by paid
  // orders are as good as gone, so they count against the position.
  const onOrder = item === "product" ? stockNum(s.on_order) ?? 0 : 0;
  const held = item === "product" ? stockNum(s.held) ?? 0 : 0;
  const need = ideal !== null && ideal > 0 ? Math.max(0, Math.ceil(ideal - ((cur ?? 0) - held) - onOrder)) : null;
  if (need === null) return null; // no target set — flag it, let the human fill the quantity in
  // Manufacturer boxes come in tens: 28 → 30, 34 → 40 (Justin, 09-03).
  return item === "product" ? Math.ceil(need / 10) * 10 : need;
}

const TITLES: Record<InvItem, { title: string; file: string; qtyHead: string }> = {
  product: { title: "Purchase Order — Restock Request", file: "order", qtyHead: "ORDER QTY" },
  label: { title: "Label Print Order — Vial Labels", file: "label-order", qtyHead: "PRINT QTY" },
};

/**
 * Restock PDF for everything below target — products go to the manufacturer,
 * labels to the printer. Rows without a target get a blank qty to fill in.
 */
export function downloadOrderPdf(skus: Sku[], item: InvItem = "product"): number {
  const rows = skus
    .filter((s) => isLow(s, item))
    .sort((a, b) => (stockOf(a, item) ?? 0) - (stockOf(b, item) ?? 0) || a.product_name.localeCompare(b.product_name));
  if (!rows.length) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const meta = TITLES[item];
  const doc = new jsPDF();
  const W = doc.internal.pageSize.getWidth();

  doc.setFillColor(17, 24, 39);
  doc.rect(0, 0, W, 34, "F");
  doc.setTextColor(212, 175, 55);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("REAL PEPTIDES", 14, 15);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.text(meta.title, 14, 24);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Date: ${today}`, W - 14, 15, { align: "right" });
  doc.text(`Items: ${rows.length}`, W - 14, 21, { align: "right" });

  autoTable(doc, {
    startY: 40,
    head: [["#", "Product", "SKU", "Form", "On hand", "Target", meta.qtyHead]],
    body: rows.map((s, i) => {
      const q = orderQty(s, item);
      return [
        String(i + 1),
        s.product_name,
        s.sku_code,
        s.form ?? "",
        String(stockOf(s, item) ?? 0),
        idealOf(s, item) ?? "—",
        q === null ? "____" : String(q),
      ];
    }),
    styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: [17, 24, 39], textColor: [212, 175, 55], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 62 },
      4: { halign: "right", cellWidth: 18 },
      5: { halign: "right", cellWidth: 16 },
      6: { halign: "right", fontStyle: "bold", cellWidth: 24 },
    },
    alternateRowStyles: { fillColor: [246, 247, 249] },
    didDrawPage: () => {
      const H = doc.internal.pageSize.getHeight();
      doc.setFontSize(8);
      doc.setTextColor(130);
      doc.text("Generated from ops.fitscript.me — Real Peptides inventory. Quantities marked ____ need a target set.", 14, H - 8);
    },
  });

  doc.save(`real-peptides-${meta.file}-${today}.pdf`);
  return rows.length;
}

/** A specific purchase order as a sendable PDF. */
export function downloadPoPdf(po: { id: number; supplier: string | null; created_at: string; items: { sku_code: string; product_name: string; qty: number }[] }): void {
  const doc = new jsPDF();
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(17, 24, 39);
  doc.rect(0, 0, W, 34, "F");
  doc.setTextColor(212, 175, 55);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("REAL PEPTIDES", 14, 15);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.text(`Purchase Order #${po.id}${po.supplier ? ` — ${po.supplier}` : ""}`, 14, 24);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Date: ${String(po.created_at).slice(0, 10)}`, W - 14, 15, { align: "right" });
  doc.text(`Lines: ${po.items.length}`, W - 14, 21, { align: "right" });
  const totalUnits = po.items.reduce((a, i) => a + Number(i.qty), 0);
  autoTable(doc, {
    startY: 40,
    head: [["#", "Product", "SKU", "QTY"]],
    body: po.items.map((i, n) => [String(n + 1), i.product_name, i.sku_code, Number(i.qty).toLocaleString()]),
    foot: [["", "", `${po.items.length} lines`, totalUnits.toLocaleString()]],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [17, 24, 39], textColor: [212, 175, 55], fontStyle: "bold" },
    footStyles: { fillColor: [246, 247, 249], textColor: [17, 24, 39], fontStyle: "bold", halign: "right" },
    columnStyles: { 0: { cellWidth: 8 }, 3: { halign: "right", fontStyle: "bold", cellWidth: 22 } },
    alternateRowStyles: { fillColor: [246, 247, 249] },
  });
  doc.save(`real-peptides-po-${po.id}.pdf`);
}
