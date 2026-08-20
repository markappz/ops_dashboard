/** Talks to the COA tracker through ops' token-gated proxy. */
export const API = "/api/ops/realpeptides/coa/api";

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

export interface Sku {
  id: number;
  sku_code: string;
  product_name: string;
  product_url: string | null;
  thumbnail_url: string | null;
  form: string | null;
  current_stock: number | null;
  requires_coa: boolean;
  coa_test_date: string | null;
  coa_expiry_date: string | null;
  coa_lab_name: string | null;
  coa_file_name: string | null;
  test_status: string | null;
  doc_count: number;
  status: "fresh" | "expiring" | "expired" | "untested" | "n/a";
  daysLeft: number | null;
  family_key: string;
  family_label: string;
}

export type Status = Sku["status"];

export interface Family {
  key: string;
  label: string;
  thumbnail: string | null;
  variants: Sku[];
  status: Status;
  docCount: number;
}

export interface Coa {
  id: number;
  test_date: string;
  expiry_date: string;
  result: string;
  lab_name: string | null;
  purity: string | null;
  source?: string;
  source_ref?: string | null;
}

export interface Doc {
  id: number;
  file_name: string;
  doc_type: string;
  mime_type: string | null;
  size_bytes: number | null;
  source: string;
  category: string;
  brand?: string;
  uploaded_at: string;
}

export interface SkuDetail {
  sku: Sku & { coa_name: string | null; product_id: string | null };
  coas: Coa[];
  tests: { id: number; status: string; notes: string | null; created_at: string; sent_date?: string | null; lab_name?: string | null }[];
  documents: Doc[];
}

export const STATUS_TEXT: Record<string, string> = {
  fresh: "All current", expiring: "Expiring soon", expired: "Retest needed", untested: "Needs COA", "n/a": "No COA required",
};

export const DOT: Record<string, string> = {
  fresh: "bg-fitscript-green", expiring: "bg-yellow-500", expired: "bg-red-400", untested: "bg-ops-text-muted", "n/a": "bg-ops-border",
};

export const PILL: Record<string, string> = {
  fresh: "bg-fitscript-green/15 text-fitscript-green",
  expiring: "bg-yellow-500/15 text-yellow-500",
  expired: "bg-red-500/15 text-red-400",
  untested: "bg-ops-border text-ops-text-muted",
  "n/a": "bg-ops-border text-ops-text-muted",
};

export const ui = {
  input: "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-fitscript-green focus:outline-none",
  label: "mb-1 block text-[11px] uppercase tracking-wider text-ops-text-muted",
  primary: "inline-flex items-center justify-center gap-1.5 rounded-lg bg-fitscript-green px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 hover:bg-fitscript-green/90",
  ghost: "inline-flex items-center justify-center gap-1.5 rounded-lg border border-ops-border bg-ops-surface px-3 py-2 text-sm text-ops-text-muted transition hover:text-ops-text disabled:opacity-40",
  modal: "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-2 backdrop-blur-sm sm:p-4",
  sheet: "my-4 w-full rounded-2xl border border-ops-border bg-ops-surface shadow-card sm:my-8",
};
