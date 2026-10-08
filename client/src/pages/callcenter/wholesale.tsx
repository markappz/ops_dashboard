import { Building2, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { PageHero } from "../../components/page-hero";
import { useCc, Badge, STATE_META, fmtWhen } from "./api";

interface Inquiry {
  id: number;
  request_id: number;
  business_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  lines: Array<{ product: string; variant: string | null; qty: number | null; notes: string | null }>;
  labeling: { label_needs?: string | null };
  timing: string | null;
  stage: string;
  quote_owner: string | null;
  quote_ref: string | null;
  created_at: string;
  state: string;
  owner_email: string | null;
  callback_window_raw: string | null;
  channel: string | null;
  from_number: string | null;
}

const STAGE: Record<string, { label: string; cls: string }> = {
  inquiry: { label: "New inquiry", cls: "bg-fitscript-green/15 text-fitscript-green" },
  draft_quote: { label: "Existing quote", cls: "bg-sky-500/15 text-sky-400" },
  approved_quote: { label: "Approved quote", cls: "bg-violet-500/15 text-violet-400" },
  order: { label: "Order", cls: "bg-amber-500/15 text-amber-500" },
  payment: { label: "Payment", cls: "bg-emerald-500/15 text-emerald-400" },
};

export default function CallCenterWholesale() {
  const q = useCc<{ inquiries: Inquiry[] }>(["wholesale"], "/wholesale", { refetchInterval: 60_000 });
  const list = q.data?.inquiries ?? [];

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides · Call Center"
        title="Wholesale requests"
        subtitle="Inquiries the agents captured — exact products, quantities, labeling and timing. Quotes themselves live in the Wholesale tab; callers with an existing quote link to it instead of becoming a new lead."
        actions={
          <Link href="/realpeptides/wholesale" className="inline-flex items-center gap-1.5 rounded-xl border border-ops-border bg-ops-surface px-4 py-2 text-sm font-medium text-ops-text hover:border-ops-border-strong">
            <Building2 className="h-4 w-4" /> Wholesale pipeline <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        }
      />

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading wholesale requests…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.data && !list.length && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-10 text-center text-sm text-ops-text-muted shadow-card">
          No call-center wholesale requests yet. They appear when Sloane saves one live on a call or chat.
        </div>
      )}

      <div className="space-y-2">
        {list.map((w) => (
          <div key={w.id} className="rounded-xl border border-ops-border bg-ops-surface px-4 py-3 shadow-card">
            <div className="flex flex-wrap items-center gap-2">
              <Badge meta={STAGE[w.stage] ?? STAGE.inquiry} />
              <Badge meta={STATE_META[w.state]} />
              <span className="font-medium text-ops-text">{w.business_name || w.contact_name || w.contact_email || w.from_number || "Unknown business"}</span>
              {w.quote_ref && <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-400">existing order {w.quote_ref}</span>}
              <span className="ml-auto text-xs text-ops-text-muted">{fmtWhen(w.created_at)} · {w.owner_email || "unassigned"}</span>
            </div>
            <div className="mt-1.5 grid gap-x-6 gap-y-1 text-sm text-ops-text-muted sm:grid-cols-2">
              <div>
                {(w.lines ?? []).length
                  ? (w.lines as any[]).map((l, i) => (
                      <div key={i} className="text-ops-text">{l.product}{l.variant ? ` · ${l.variant}` : ""}{l.qty ? ` × ${l.qty}` : ""}{l.notes ? <span className="text-ops-text-muted"> — {l.notes}</span> : null}</div>
                    ))
                  : <span>No line items captured.</span>}
              </div>
              <div className="space-y-0.5 text-xs">
                {w.contact_name && <div>Contact: {w.contact_name}</div>}
                {w.contact_phone && <div>Phone: {w.contact_phone}</div>}
                {w.contact_email && <div>Email: {w.contact_email}</div>}
                {w.labeling?.label_needs && <div>Labeling: {w.labeling.label_needs}</div>}
                {w.timing && <div>Timing: {w.timing}</div>}
                {w.callback_window_raw && <div>Asked for: “{w.callback_window_raw}”</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
