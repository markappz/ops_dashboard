import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Marketing and Leads for pawgen.
 *
 * Every field optional: an error body carries only `error`, so the compiler
 * forces a guard at each read — the bug class that white-screened the orders tab.
 */

interface Marketing {
  coverage?: { paidOrders: number; attributed: number; unattributed: number; attributedRevenue: number };
  bySource?: Row[];
  byMedium?: Row[];
  byCampaign?: Row[];
  byLanding?: Row[];
  byReferrer?: Row[];
  error?: string;
}
type Row = { key: string; orders: number; revenue: number };

interface Ga4 {
  connected?: boolean;
  totals?: { sessions?: number; users?: number; newUsers?: number; pageViews?: number };
  sources?: { channel: string; sessions: number; users: number; pageViews: number }[];
  error?: string;
}

interface Leads {
  totals?: { leads: number; converted: number; conversionRate: number; revenueFromLeads: number };
  bySource?: Record<string, number>;
  series?: { date: string; leads: number }[];
  recent?: { email: string; source: string | null; created_at: string; guide_sent: boolean | null; converted: boolean; revenue: number }[];
  error?: string;
}

const usd = (n: number) => `$${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number | undefined) => (n ?? 0).toLocaleString();

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" }) {
  const c = tone === "good" ? "text-fitscript-green" : tone === "warn" ? "text-yellow-500" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${c}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ops-text-muted">{hint}</div>}
    </div>
  );
}

function Bars({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  const total = rows.reduce((s, r) => s + r.revenue, 0) || 1;
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">{title}</div>
      {rows.length === 0 ? (
        <div className="text-sm text-ops-text-muted">{empty}</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.key}>
              <div className="flex justify-between gap-3 text-sm">
                <span className="truncate text-ops-text" title={r.key}>{r.key}</span>
                <span className="shrink-0 text-ops-text-muted">{usd(r.revenue)} · {r.orders}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-ops-border">
                <div className="h-1.5 rounded-full bg-fitscript-green/70" style={{ width: `${(r.revenue / total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PawgenMarketing() {
  const m = useQuery<Marketing>({
    queryKey: ["pawgen-marketing"],
    queryFn: async () => {
      const r = await fetch("/api/ops/pawgen/marketing", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });
  const ga = useQuery<Ga4>({
    queryKey: ["pawgen-ga4-marketing"],
    queryFn: async () => {
      const r = await fetch("/api/ops/ga4/overview?company=pawgen&range=30", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  const c = m.data?.coverage;
  const pct = c && c.paidOrders ? Math.round((c.attributed / c.paidOrders) * 100) : 0;

  return (
    <div>
      <PageHero eyebrow="pawgen" title="Marketing" subtitle="Where paid orders came from, and how traffic reaches the site." />

      {m.data?.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{m.data.error}</div>
      )}

      {c && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Paid orders" value={num(c.paidOrders)} />
            <Stat label="With attribution" value={`${num(c.attributed)}`} hint={`${pct}% of orders`} tone={pct < 50 ? "warn" : "good"} />
            <Stat label="Attributed revenue" value={usd(c.attributedRevenue)} />
            <Stat label="Sessions (30d)" value={num(ga.data?.totals?.sessions)} hint="from Google Analytics" />
          </div>

          {c.unattributed > 0 && (
            <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm">
              <span className="font-medium text-yellow-500">{c.unattributed} paid orders have no source recorded.</span>{" "}
              <span className="text-ops-text-muted">
                First-touch attribution was added to checkout recently, so orders placed before that carry nothing — they are
                <em> not</em> direct traffic, they are simply unknown. The percentage above should climb from here.
              </span>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Bars title="Revenue by source" rows={m.data?.bySource ?? []} empty="No attributed orders yet." />
            <Bars title="Revenue by medium" rows={m.data?.byMedium ?? []} empty="No attributed orders yet." />
            <Bars title="Revenue by campaign" rows={m.data?.byCampaign ?? []} empty="No campaign-tagged orders yet — add utm_campaign to your ad links." />
            <Bars title="Revenue by landing page" rows={m.data?.byLanding ?? []} empty="No landing pages recorded yet." />
          </div>

          <div className="mt-4">
            <Bars
              title="Traffic by channel (Google Analytics, 30d)"
              rows={(ga.data?.sources ?? []).map((s) => ({ key: s.channel, orders: s.users, revenue: s.sessions }))}
              empty={ga.data?.connected === false ? "Google Analytics isn't connected — see Integrations." : "No traffic recorded yet."}
            />
            <p className="mt-2 text-xs text-ops-text-muted">
              Channel bars show sessions and users, not revenue — GA4 doesn&apos;t see pawgen&apos;s orders.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export function PawgenLeads() {
  const { data, isLoading } = useQuery<Leads>({
    queryKey: ["pawgen-leads"],
    queryFn: async () => {
      const r = await fetch("/api/ops/pawgen/leads", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });
  const t = data?.totals;
  const max = Math.max(...(data?.series ?? []).map((d) => d.leads), 1);

  return (
    <div>
      <PageHero eyebrow="pawgen" title="Leads" subtitle="Dosing-guide signups, and how many became customers." />

      {data?.error && <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>}
      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}

      {t && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Total leads" value={num(t.leads)} />
            <Stat label="Became customers" value={num(t.converted)} tone={t.converted > 0 ? "good" : undefined} />
            <Stat label="Conversion rate" value={`${t.conversionRate}%`} hint="leads who placed a paid order" />
            <Stat label="Revenue from leads" value={usd(t.revenueFromLeads)} />
          </div>

          <div className="mb-4 rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
            <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">Signups per day (30d)</div>
            <div className="flex h-28 items-end gap-[3px]">
              {(data?.series ?? []).map((d) => (
                <div
                  key={d.date}
                  className="flex-1 rounded-sm bg-fitscript-green/70 hover:bg-fitscript-green transition-colors"
                  style={{ height: `${Math.max(2, (d.leads / max) * 100)}%` }}
                  title={`${d.date} · ${d.leads} leads`}
                />
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Guide sent</th>
                  <th className="px-4 py-3 font-medium">Bought</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recent ?? []).map((l, i) => (
                  <tr key={i} className="border-b border-ops-border/50 last:border-0">
                    <td className="px-4 py-2.5 text-ops-text">{l.email}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{l.source ?? "—"}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{l.guide_sent ? "yes" : "no"}</td>
                    <td className="px-4 py-2.5">
                      {l.converted ? (
                        <span className="rounded bg-fitscript-green/15 px-2 py-0.5 text-xs font-medium text-fitscript-green">
                          {usd(l.revenue)}
                        </span>
                      ) : (
                        <span className="text-ops-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{new Date(l.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(data?.recent ?? []).length >= 100 && (
            <p className="mt-2 text-xs text-ops-text-muted">Showing the 100 most recent of {num(t.leads)} leads.</p>
          )}
        </>
      )}
    </div>
  );
}
