import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Marketing for Real Peptides — first-party pixel, not orders.
 *
 * RP's store is WooCommerce and no API credentials exist for it, so this page
 * reports traffic and where it came from, and says so plainly. It never shows a
 * revenue figure it can't source.
 */

type Row = { key: string; sessions: number; visitors: number };

interface Marketing {
  pixelInstalled?: boolean;
  range?: number;
  totals?: { sessions: number; visitors: number; page_views: number };
  daily?: { date: string; sessions: number; visitors: number }[];
  bySource?: Row[];
  byMedium?: Row[];
  byCampaign?: Row[];
  byLanding?: Row[];
  byReferrer?: Row[];
  byProperty?: Row[];
  error?: string;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString();

const SNIPPET = `<script src="https://ops.fitscript.me/t.js" defer></script>`;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ops-text">{value}</div>
      {hint && <div className="mt-1 text-xs text-ops-text-muted">{hint}</div>}
    </div>
  );
}

function Bars({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  const total = rows.reduce((s, r) => s + r.sessions, 0) || 1;
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
                <span className="shrink-0 text-ops-text-muted">{num(r.sessions)} sessions · {num(r.visitors)} visitors</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-ops-border">
                <div className="h-1.5 rounded-full bg-fitscript-green/70" style={{ width: `${(r.sessions / total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InstallPixel() {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-6 shadow-card">
      <div className="text-lg font-medium text-ops-text">The tracking pixel isn&apos;t reporting yet</div>
      <p className="mt-2 max-w-2xl text-sm text-ops-text-muted">
        No events have ever arrived from a Real Peptides origin. That means the pixel isn&apos;t installed —
        not that nobody visited. Add this one line before <code>&lt;/head&gt;</code> on realpeptides.co and on
        the three lead-magnet funnels; data starts appearing within minutes.
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-ops-border bg-ops-bg p-4 text-xs text-ops-text">
        {SNIPPET}
      </pre>
      <p className="mt-3 text-xs text-ops-text-muted">
        WordPress: any header-snippet plugin, or the child theme&apos;s <code>header.php</code>. The ingest
        endpoint only accepts origins on its allowlist — realpeptides.co, fatlossbible.co,
        peptideplaybook.com and hairgrowthprotocol.com are already on it, and all four report as
        Real Peptides.
      </p>
    </div>
  );
}

export default function RealPeptidesMarketing() {
  const { data, isLoading } = useQuery<Marketing>({
    queryKey: ["realpeptides-marketing"],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/marketing?range=30", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  const max = Math.max(...(data?.daily ?? []).map((d) => d.sessions), 1);

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Marketing"
        subtitle="Where traffic to the store and the funnels comes from, measured first-party."
      />

      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>
      )}

      {!isLoading && data && !data.error && (
        <>
          <div className="mb-6 rounded-xl border border-ops-border bg-ops-surface p-4 text-sm text-ops-text-muted">
            <span className="font-medium text-ops-text">No revenue on this page.</span> WooCommerce has no
            API credentials yet, so orders are not readable — everything here is sessions and sources. Add a
            read-only WooCommerce key and revenue attribution can join it.
          </div>

          {data.pixelInstalled === false ? (
            <InstallPixel />
          ) : (
            <>
              <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
                <Stat label="Sessions (30d)" value={num(data.totals?.sessions)} />
                <Stat label="Visitors (30d)" value={num(data.totals?.visitors)} hint="unique browsers" />
                <Stat label="Page views (30d)" value={num(data.totals?.page_views)} />
              </div>

              <div className="mb-4 rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
                <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">Sessions per day (30d)</div>
                <div className="flex h-28 items-end gap-[3px]">
                  {(data.daily ?? []).map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 rounded-sm bg-fitscript-green/70 transition-colors hover:bg-fitscript-green"
                      style={{ height: `${Math.max(2, (d.sessions / max) * 100)}%` }}
                      title={`${d.date} · ${d.sessions} sessions`}
                    />
                  ))}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Bars title="By property" rows={data.byProperty ?? []} empty="No landing hosts recorded yet." />
                <Bars title="By source" rows={data.bySource ?? []} empty="No tagged sources yet — add utm_source to ad links." />
                <Bars title="By medium" rows={data.byMedium ?? []} empty="No tagged mediums yet." />
                <Bars title="By campaign" rows={data.byCampaign ?? []} empty="No campaign-tagged traffic yet." />
                <Bars title="Top landing pages" rows={data.byLanding ?? []} empty="No landing pages recorded yet." />
                <Bars title="Top referrers" rows={data.byReferrer ?? []} empty="No referrers recorded yet." />
              </div>

              <p className="mt-3 text-xs text-ops-text-muted">
                &ldquo;(none)&rdquo; is untagged traffic — direct visits plus any link without UTM parameters. It is
                shown rather than folded into &ldquo;direct&rdquo;, which would overstate direct.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
