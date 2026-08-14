import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Leads for Real Peptides — Moosend + Campaign Refinery.
 *
 * NOT Klaviyo: that's FitScript's platform. RP's lists live in these two, so
 * both render as independent cards — one missing key or one API outage degrades
 * that card alone.
 *
 * Deliberately no "became a customer" column: WooCommerce isn't readable, so
 * conversion is genuinely unknown here and is not guessed at.
 */

interface MoosendData {
  configured?: boolean;
  hint?: string;
  error?: string;
  totalActive?: number;
  lists?: { id: string; name: string; active: number; unsubscribed: number; bounced: number }[];
}

interface CrData {
  configured?: boolean;
  hint?: string;
  error?: string;
  shape?: string;
  returned?: number;
  recentCount?: number;
  datedContacts?: number;
  recent?: { email: string; created_at: string | null }[];
}

interface Leads {
  range?: number;
  moosend?: MoosendData;
  campaignRefinery?: CrData;
  error?: string;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString();

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-1 text-base font-medium text-ops-text">{title}</div>
      <div className="mb-4 text-xs text-ops-text-muted">{subtitle}</div>
      {children}
    </div>
  );
}

function NotConfigured({ hint }: { hint?: string }) {
  return <div className="text-sm text-ops-text-muted">{hint ?? "Not configured."}</div>;
}

function Failed({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
  );
}

function Moosend({ d }: { d: MoosendData }) {
  if (d.configured === false) return <NotConfigured hint={d.hint} />;
  if (d.error) return <Failed error={d.error} />;
  const lists = d.lists ?? [];
  return (
    <>
      <div className="mb-4">
        <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">Active subscribers</div>
        <div className="mt-1 text-3xl font-semibold text-ops-text">{num(d.totalActive)}</div>
        <div className="mt-1 text-xs text-ops-text-muted">across {lists.length} list{lists.length === 1 ? "" : "s"}</div>
      </div>
      {lists.length === 0 ? (
        <div className="text-sm text-ops-text-muted">No mailing lists in this account.</div>
      ) : (
        <div className="space-y-2">
          {lists.map((l) => (
            <div key={l.id} className="flex justify-between gap-3 text-sm">
              <span className="truncate text-ops-text" title={l.name}>{l.name}</span>
              <span className="shrink-0 text-ops-text-muted">
                {num(l.active)} active
                {l.unsubscribed > 0 && <span className="text-ops-text-subtle"> · {num(l.unsubscribed)} unsub</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CampaignRefinery({ d, range }: { d: CrData; range?: number }) {
  if (d.configured === false) return <NotConfigured hint={d.hint} />;
  if (d.error) return <Failed error={d.error} />;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">New ({range ?? 30}d)</div>
          <div className="mt-1 text-3xl font-semibold text-ops-text">{num(d.recentCount)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">Contacts returned</div>
          <div className="mt-1 text-3xl font-semibold text-ops-text">{num(d.returned)}</div>
          <div className="mt-1 text-xs text-ops-text-muted">this page, not the account total</div>
        </div>
      </div>

      {d.datedContacts === 0 && (d.returned ?? 0) > 0 && (
        <div className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-500">
          None of the returned contacts carry a signup date, so the {range ?? 30}-day count can&apos;t be
          computed. Tell me the field name Campaign Refinery uses and it&apos;s a one-line fix.
        </div>
      )}

      {(d.recent ?? []).length === 0 ? (
        <div className="text-sm text-ops-text-muted">No signups in this window.</div>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {(d.recent ?? []).map((c, i) => (
            <div key={i} className="flex justify-between gap-3 text-sm">
              <span className="truncate text-ops-text" title={c.email}>{c.email}</span>
              <span className="shrink-0 text-ops-text-muted">
                {c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function RealPeptidesLeads() {
  const { data, isLoading } = useQuery<Leads>({
    queryKey: ["realpeptides-leads"],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/leads?range=30", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Leads"
        subtitle="List growth from Moosend and Campaign Refinery."
      />

      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>
      )}

      {data && !data.error && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Moosend" subtitle="Mailing lists and active subscriber counts">
              <Moosend d={data.moosend ?? {}} />
            </Card>
            <Card title="Campaign Refinery" subtitle="Contacts and recent signups">
              <CampaignRefinery d={data.campaignRefinery ?? {}} range={data.range} />
            </Card>
          </div>

          <p className="mt-4 text-xs text-ops-text-muted">
            No conversion or revenue figures here — WooCommerce isn&apos;t readable, so whether a lead
            became a customer is genuinely unknown rather than zero. Each platform is configured
            independently; one being down never blanks the other.
          </p>
        </>
      )}
    </div>
  );
}
