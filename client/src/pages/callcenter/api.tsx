/** Shared fetch helpers + types for the Call Center pages. */
import { useQuery } from "@tanstack/react-query";

export const BASE = "/api/ops/realpeptides/callcenter";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...(init?.body ? { headers: { "Content-Type": "application/json" } } : {}),
    ...init,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || r.statusText);
  return r.json();
}

export function useCc<T>(key: unknown[], path: string, opts?: { refetchInterval?: number }) {
  return useQuery<T>({
    queryKey: ["cc", ...key],
    queryFn: () => api<T>(path),
    refetchInterval: opts?.refetchInterval,
  });
}

export interface Conversation {
  id: number;
  external_id: string;
  channel: "voice" | "chat" | "sms";
  call_type: string | null;
  direction: string | null;
  from_number: string | null;
  agent_id: string | null;
  agent_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  provider_status: string | null;
  disconnect_reason: string | null;
  summary: string | null;
  intent: string | null;
  analysis_status: string;
  is_test: boolean;
  contact_name: string | null;
  business_name: string | null;
  request_count: number;
  open_state: string | null;
}

export interface CcRequest {
  id: number;
  conversation_id: number | null;
  contact_id: number | null;
  kind: string;
  reason: string | null;
  queue: string;
  concern: string | null;
  intent: string | null;
  product_refs: Array<{ name?: string; qty?: number | null }>;
  order_reference: string | null;
  wholesale_refs: Record<string, any>;
  priority: string;
  state: string;
  owner_email: string | null;
  contact_permission: boolean | null;
  contact_channel: string | null;
  callback_window_raw: string | null;
  callback_at: string | null;
  callback_tz: string | null;
  needs_scheduling: boolean;
  due_at: string | null;
  snoozed_until: string | null;
  snooze_reason: string | null;
  resolution: string | null;
  source: string;
  created_at: string;
  // joins
  external_id?: string;
  channel?: string;
  from_number?: string | null;
  conversation_summary?: string | null;
  contact_name?: string | null;
  business_name?: string | null;
  phone_e164?: string | null;
  email_norm?: string | null;
  attempt_count?: number;
  last_attempt_at?: string | null;
}

export const STATE_META: Record<string, { label: string; cls: string }> = {
  new: { label: "New", cls: "bg-fitscript-green/15 text-fitscript-green" },
  assigned: { label: "Assigned", cls: "bg-sky-500/15 text-sky-400" },
  in_progress: { label: "In progress", cls: "bg-amber-500/15 text-amber-500" },
  awaiting_customer: { label: "Awaiting customer", cls: "bg-violet-500/15 text-violet-400" },
  scheduled: { label: "Scheduled", cls: "bg-sky-500/15 text-sky-400" },
  resolved: { label: "Resolved", cls: "bg-emerald-500/15 text-emerald-400" },
  closed_no_action: { label: "Closed — no action", cls: "bg-ops-border text-ops-text-muted" },
};

export const QUEUE_LABEL: Record<string, string> = {
  support: "Customer support",
  wholesale: "Wholesale",
  sales_recovery: "Sales recovery",
  affiliate: "Affiliates",
  triage: "Triage",
};

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function Badge({ meta }: { meta?: { label: string; cls: string } }) {
  if (!meta) return null;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>;
}
