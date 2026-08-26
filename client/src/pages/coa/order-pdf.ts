import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Sku } from "./api";

export const stockNum = (v: number | string | null) => (v === null || v === "" ? null : Number(v));

/** Below target (ideal set) — or flat out of stock. */
export function isLow(s: Sku): boolean {
  const cur = stockNum(s.current_stock);
  const ideal = stockNum(s.ideal_stock);
  if (ideal !== null && ideal > 0) return (cur ?? 0) < ideal;
  return cur !== null && cur <= 0;
}

export function orderQty(s: Sku): number | null {
  const cur = stockNum(s.current_stock);
  const ideal = stockNum(s.ideal_stock);
  if (ideal !== null && ideal > 0) return Math.max(0, Math.ceil(ideal - (cur ?? 0)));
  return null; // no target set — flag it, let the human fill the quantity in
}

/**
 * Purchase-order PDF for everything below target — ready to send to the
 * manufacturer. Rows without an ideal stock get a blank qty to fill in by hand.
 */
export function downloadOrderPdf(skus: Sku[]): number {
  const rows = skus
    .filter((s) => s.requires_coa !== false || true) // every active product counts for ordering
    .filter(isLow)
    .sort((a, b) => (stockNum(a.current_stock) ?? 0) - (stockNum(b.current_stock) ?? 0) || a.product_name.localeCompare(b.product_name));
  if (!rows.length) return 0;

  const today = new Date().toISOString().slice(0, 10);
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
  doc.text("Purchase Order — Restock Request", 14, 24);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Date: ${today}`, W - 14, 15, { align: "right" });
  doc.text(`Items: ${rows.length}`, W - 14, 21, { align: "right" });

  autoTable(doc, {
    startY: 40,
    head: [["#", "Product", "SKU", "Form", "On hand", "Target", "ORDER QTY"]],
    body: rows.map((s, i) => {
      const q = orderQty(s);
      return [
        String(i + 1),
        s.product_name,
        s.sku_code,
        s.form ?? "",
        String(stockNum(s.current_stock) ?? 0),
        stockNum(s.ideal_stock) ?? "—",
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

  doc.save(`real-peptides-order-${today}.pdf`);
  return rows.length;
}
