import type { Family, Sku } from "./api";
import { variantLabel } from "./families";

export interface SummarySection {
  key: string;
  emoji: string;
  title: string;
  count: number;
  message: string;   // ready to copy/paste or push to WhatsApp
}

const atLab = (v: Sku) => v.test_status === "in_testing" || v.test_status === "sent";

/** Build per-family lines for variants matching `pick`. */
function lines(families: Family[], pick: (v: Sku) => boolean): { count: number; body: string } {
  const out: string[] = [];
  let count = 0;
  for (const f of families) {
    const vs = f.variants.filter(pick);
    if (!vs.length) continue;
    count += vs.length;
    const labels = vs.map((v) => variantLabel(v, f.label)).join(", ");
    out.push(`• ${f.label} — ${labels}`);
  }
  return { count, body: out.join("\n") };
}

function section(emoji: string, title: string, key: string, families: Family[], pick: (v: Sku) => boolean): SummarySection {
  const { count, body } = lines(families, pick);
  const header = `${emoji} Real Peptides COA — ${title} (${count})`;
  return { key, emoji, title, count, message: count ? `${header}\n\n${body}` : header };
}

export function buildSummary(families: Family[]): SummarySection[] {
  return [
    section("🔴", "Send in for testing", "send", families,
      (v) => (v.status === "expired" || v.status === "untested") && !atLab(v)),
    section("🟡", "Expiring soon", "expiring", families,
      (v) => v.status === "expiring"),
    section("🧪", "At the lab — awaiting results", "atlab", families, atLab),
  ];
}
