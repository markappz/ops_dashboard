import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { DateRangePicker, rangeQuery, useDateRange } from "../components/date-range-picker";

/**
 * Affiliates for Real Peptides.
 *
 * Header figures come from the site's own program-summary library (the same
 * numbers the monthly program report emails), so this tab, the affiliate
 * portal and the client report always agree. The table is window activity
 * plus anyone the program still owes — a silent affiliate with a balance is
 * exactly who gets forgotten. Money is dollars end to end on this feed.
 */

interface AffRow {
  id: string;
  wpId: number;
  name: string | null;
  email: string;
  slug: string | null;
  group: string | null;
  status: "PENDING" | "ACTIVE" | "INACTIVE" | "REJECTED";
  visits: number;
  referrals: number;
  earned: number;
  conversionRate: number;
  unpaid: number;
  paidToDate: number;
}
interface Data {
  configured?: boolean;
  pending?: boolean;
  hint?: string;
  error?: string;
  program?: {
    referrals: number;
    commission: string;
    visits: number;
    conversionRate: string;
    totalOwed: string;
    newApplications: number;
    pendingReview: number;
    flagged: number;
    topAffiliates: { name: string; earned: string; referrals: number }[];
  };
  statuses?: Record<string, number>;
  totalAffiliates?: number;
  affiliates?: AffRow[];
}

const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();
const usd = (n: number | string | undefined | null) =>
  Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const get = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());
const MINUTE = 60_000;

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "text-fitscript-green border-fitscript-green/40 bg-fitscript-green/10",
  PENDING: "text-amber-500 border-amber-500/40 bg-amber-500/10",
  INACTIVE: "text-ops-text-muted border-ops-border bg-ops-bg",
  REJECTED: "text-red-400 border-red-400/40 bg-red-400/10",
};

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" }) {
  const color = tone === "good" ? "text-fitscript-green" : tone === "warn" ? "text-amber-500" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
}

export default function RealPeptidesAffiliates() {
  const [range, setRange] = useDateRange("realpeptides");
  const q = useQuery<Data>({
    queryKey: ["rp-affiliates", rangeQuery(range)],
    queryFn: () => get(`/api/ops/realpeptides/affiliates?${rangeQuery(range)}`),
    refetchInterval: 5 * MINUTE,
    staleTime: MINUTE,
  });
  const d = q.data;
  const p = d?.program;
  const rows = d?.affiliates ?? [];

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Affiliates"
        subtitle="The program the monthly report describes — same numbers, live, plus every affiliate the window touched or the program still owes."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      {q.isLoading && <div className="rounded-xl border border-ops-border bg-ops-surface px-4 py-3 text-sm text-ops-text-muted">Loading…</div>}
      {d && !d.configured && <div className="rounded-xl border border-ops-border bg-ops-surface px-4 py-3 text-sm text-ops-text-muted">{d.hint}</div>}
      {d?.pending && <div className="rounded-xl border border-ops-border bg-ops-surface px-4 py-3 text-sm text-ops-text-muted">{d.hint}</div>}
      {d?.error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{d.error}</div>}

      {p && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Referral visits" value={num(p.visits)} />
            <Stat label="Referrals (sales)" value={num(p.referrals)} sub={`${p.conversionRate}% of visits convert`} />
            <Stat label="Commission this range" value={usd(p.commission)} tone="good" />
            <Stat label="Owed to affiliates (all-time)" value={usd(p.totalOwed)} tone="warn" sub="Unpaid balance across the whole program" />
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-ops-border bg-ops-surface px-3 py-1">
              {num(d?.totalAffiliates)} affiliates · {num(d?.statuses?.ACTIVE)} active · {num(d?.statuses?.PENDING)} pending review
            </span>
            {p.newApplications > 0 && (
              <span className="rounded-full border border-fitscript-green/40 bg-fitscript-green/10 px-3 py-1 text-fitscript-green">
                {num(p.newApplications)} new application{p.newApplications === 1 ? "" : "s"} in range
              </span>
            )}
            {p.flagged > 0 && (
              <span className="rounded-full border border-red-400/40 bg-red-400/10 px-3 py-1 text-red-400">
                {num(p.flagged)} flagged referral{p.flagged === 1 ? "" : "s"} — review on the site admin
              </span>
            )}
          </div>

          <div className="mt-6 rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <div className="border-b border-ops-border px-4 py-3">
              <div className="text-sm font-semibold">Affiliates in this range</div>
              <div className="text-xs text-ops-text-muted">Sorted by commission earned in the range; includes anyone still owed money. Manage payouts and approvals in the site admin.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-[0.08em] text-ops-text-muted">
                    <th className="px-4 py-2 font-medium">Affiliate</th>
                    <th className="px-4 py-2 font-medium">Group</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Visits</th>
                    <th className="px-4 py-2 text-right font-medium">Referrals</th>
                    <th className="px-4 py-2 text-right font-medium">Conv.</th>
                    <th className="px-4 py-2 text-right font-medium">Earned (range)</th>
                    <th className="px-4 py-2 text-right font-medium">Unpaid</th>
                    <th className="px-4 py-2 text-right font-medium">Paid to date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-ops-border/60">
                      <td className="max-w-[260px] px-4 py-2">
                        <div className="truncate font-medium" title={r.name ?? r.email}>{r.name ?? r.email}</div>
                        <div className="truncate text-xs text-ops-text-muted" title={r.email}>
                          /ref/{r.slug ?? r.wpId}{r.name ? ` · ${r.email}` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-ops-text-muted">{r.group ?? "—"}</td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[r.status] ?? STATUS_TONE.INACTIVE}`}>
                          {r.status.toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{num(r.visits)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{num(r.referrals)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.visits > 0 ? `${r.conversionRate}%` : "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">{usd(r.earned)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${r.unpaid > 0 ? "text-amber-500 font-medium" : ""}`}>{usd(r.unpaid)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-ops-text-muted">{usd(r.paidToDate)}</td>
                    </tr>
                  ))}
                  {!rows.length && !q.isLoading && (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-ops-text-muted">No affiliate activity in this range and nothing owed.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
