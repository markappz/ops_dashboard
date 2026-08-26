import { atLab, needsSend, type Sku } from "./api";

const HEADERS = [
  "Product", "SKU", "Form", "Status", "Days left", "Action needed",
  "Last test date", "Expires", "Lab", "Lot", "At lab since", "Sent to",
  "COA files", "Stock",
];

const ACTION: Record<string, string> = {
  fresh: "None — current",
  expiring: "Retest soon",
  expired: "Send to lab",
  untested: "Send to lab",
  "n/a": "No COA required",
};

function esc(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(s: Sku): (string | number | null)[] {
  return [
    s.product_name,
    s.sku_code,
    s.form,
    s.status,
    s.daysLeft,
    atLab(s) ? "At lab — awaiting results" : ACTION[s.status] ?? "",
    s.coa_test_date,
    s.coa_expiry_date,
    s.coa_lab_name,
    s.coa_lot,
    atLab(s) ? s.test_sent_date : null,
    atLab(s) ? s.test_lab_name : null,
    s.doc_count,
    s.current_stock,
  ];
}

/** Download the whole catalog's COA state as one spreadsheet-ready CSV. */
export function exportSummaryCsv(skus: Sku[]): void {
  // Urgent first, same worst-first order the grid uses.
  const rank: Record<string, number> = { expired: 0, untested: 1, expiring: 2, fresh: 3, "n/a": 4 };
  const sorted = [...skus].sort((a, b) => {
    const send = Number(needsSend(b)) - Number(needsSend(a));
    return send || (rank[a.status] - rank[b.status]) || a.product_name.localeCompare(b.product_name);
  });
  const lines = [HEADERS, ...sorted.map(row)].map((r) => r.map(esc).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `real-peptides-coa-summary-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
