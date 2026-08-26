import { thumbUrl, type Sku, type Family, type Status, type Doc } from "./api";

// Worst-first so a family's rolled-up status reflects its most urgent variant.
const SEVERITY: Status[] = ["expired", "untested", "expiring", "fresh", "n/a"];

function worst(a: Status, b: Status): Status {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b;
}

/** Group flat SKUs into one Family per product (variants = doses/forms). */
export function groupFamilies(skus: Sku[]): Family[] {
  const map = new Map<string, Family>();
  for (const s of skus) {
    const f = map.get(s.family_key);
    if (!f) {
      map.set(s.family_key, {
        key: s.family_key,
        label: s.family_label,
        thumbnail: thumbUrl(s),
        variants: [s],
        status: s.status,
        docCount: s.doc_count,
      });
    } else {
      f.variants.push(s);
      f.status = worst(f.status, s.status);
      f.docCount += s.doc_count;
      if (!f.thumbnail) f.thumbnail = thumbUrl(s);
    }
  }
  return [...map.values()].sort((a, b) => {
    const d = SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status);
    return d !== 0 ? d : a.label.localeCompare(b.label);
  });
}

/** Best-guess test date from a COA filename (MMDDYY token), else 0. */
export function docDate(d: Doc): number {
  const m = d.file_name.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const [, mm, dd, yy] = m;
    const t = Date.parse(`20${yy}-${mm}-${dd}T00:00:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  return Date.parse(d.uploaded_at) || 0;
}

/** COA files newest-first. */
export function sortCoasByDate(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => docDate(b) - docDate(a));
}

/** Short variant label = the dose/form part after the family name. */
export function variantLabel(sku: Sku, familyName?: string): string {
  let s = sku.product_name;
  if (familyName && s.toLowerCase().startsWith(familyName.toLowerCase())) {
    s = s.slice(familyName.length);
  } else {
    const parts = s.split(/\s+[-—]\s+/);
    if (parts.length > 1) s = parts.slice(1).join(" - ");
  }
  s = s.replace(/^[\s\-—:]+/, "").trim();
  return s || sku.product_name;
}
