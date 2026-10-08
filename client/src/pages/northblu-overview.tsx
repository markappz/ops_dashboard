import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Mail, Users, MousePointerClick, Eye, Search, Globe } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { StatCard } from "../components/stat";
import { EmailHealthCard, type EmailHealthData } from "../components/email-health-card";
import { DateRangePicker, rangeDays, useDateRange } from "../components/date-range-picker";

/**
 * North Blu Command Center (2026-10-07, Paul: "/northblu was just the email
 * tab — doesn't make sense"). Email-first brand, so the overview composes the
 * three sources it actually has — the email engine summary, GA4 and GSC — in
 * the same shape as every other brand overview: PageHero + the shared
 * DateRangePicker + StatCards, with honest connect-states for anything not
 * wired yet. No new server endpoints; the tabs' own feeds power the tiles so
 * numbers here always equal the tabs (DECISIONS 09-04 rule).
 */

interface EmailSummary {
  configured: boolean;
  hint?: string;
  totals?: {
    marketableContacts?: number;
    newContacts?: number;
    sends: number;
    openRate: number | null;
    clickRate: number | null;
    lifetime?: { sends: number; opens: number; clicks: number };
  };
  health?: EmailHealthData | null;
}
interface Ga4 { connected?: boolean; error?: string; totals?: { sessions?: number; users?: number; pageViews?: number } }
interface Gsc { connected?: boolean; error?: string; totals?: { clicks?: number; impressions?: number; ctr?: number; position?: number } }

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || r.statusText);
  return r.json();
}

export default function NorthbluOverview() {
  const [range, setRange] = useDateRange("northblu-overview");
  const days = rangeDays(range);

  const email = useQuery<EmailSummary>({
    queryKey: ["nb-email", days],
    queryFn: () => get(`/api/ops/northblu/email?range=${days}`),
    refetchInterval: 60_000,
  });
  const ga4 = useQuery<Ga4>({
    queryKey: ["nb-ga4", days],
    queryFn: () => get(`/api/ops/ga4/overview?company=northblu&range=${days}`),
    refetchInterval: 5 * 60_000,
  });
  const gsc = useQuery<Gsc>({
    queryKey: ["nb-gsc", days],
    queryFn: () => get(`/api/ops/gsc/overview?company=northblu&range=${days}`),
    refetchInterval: 5 * 60_000,
  });

  const t = email.data?.totals;
  const g = ga4.data?.totals;
  const s = gsc.data?.totals;
  const rl = range.label;

  return (
    <div>
      <PageHero
        eyebrow="North Blu"
        title="Command Center"
        subtitle="North Blu at a glance — list growth, email performance, site traffic and search. Tiles read the same feeds as their tabs."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      {email.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(email.error as Error).message}</div>}
      {email.data && !email.data.configured && (
        <div className="mb-5 rounded-2xl border border-ops-border bg-ops-surface p-6 text-sm text-ops-text-muted shadow-card">
          {email.data.hint || "North Blu's email engine isn't connected yet."}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard i={0} label="Marketable contacts" icon={<Users />} number={t?.marketableContacts ?? 0} accent
          sub={t?.newContacts != null ? `+${t.newContacts.toLocaleString()} · ${rl}` : undefined} to="/northblu/audience" />
        <StatCard i={1} label={`Sends · ${rl}`} icon={<Mail />} number={t?.sends ?? 0} to="/northblu/email" />
        <StatCard i={2} label={`Open rate · ${rl}`} icon={<Eye />} value={pct(t?.openRate)} />
        <StatCard i={3} label={`Click rate · ${rl}`} icon={<MousePointerClick />} value={pct(t?.clickRate)} />
        <StatCard i={4} label={`Sessions · ${rl}`} icon={<Globe />}
          value={ga4.data?.connected === false ? "—" : (g?.sessions ?? 0).toLocaleString()}
          sub={ga4.data?.connected === false ? "GA4 not connected" : g?.users != null ? `${g.users.toLocaleString()} users` : undefined}
          tone={ga4.data?.connected === false ? "warn" : undefined} to="/northblu/traffic" />
        <StatCard i={5} label={`Search clicks · ${rl}`} icon={<Search />}
          value={gsc.data?.connected === false ? "—" : (s?.clicks ?? 0).toLocaleString()}
          sub={gsc.data?.connected === false ? "GSC not connected" : s?.impressions != null ? `${s.impressions.toLocaleString()} impressions` : undefined}
          tone={gsc.data?.connected === false ? "warn" : undefined} to="/northblu/seo" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {email.data?.health
            ? <EmailHealthCard health={email.data.health} rangeLabel={rl} />
            : <div className="rounded-xl border border-ops-border bg-ops-surface p-5 text-sm text-ops-text-muted shadow-card">Email health appears once the engine reports a window of sends.</div>}
        </div>
        <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
          <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Lifetime email</div>
          {t?.lifetime ? (
            <div className="space-y-2 text-sm text-ops-text">
              <div className="flex justify-between"><span>Sends</span><span className="tabular-nums">{t.lifetime.sends.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Opens</span><span className="tabular-nums">{t.lifetime.opens.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Clicks</span><span className="tabular-nums">{t.lifetime.clicks.toLocaleString()}</span></div>
            </div>
          ) : (
            <div className="text-sm text-ops-text-muted">{email.isLoading ? "Loading…" : "No lifetime stats from the engine yet."}</div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-ops-border pt-3 text-xs">
            <Link href="/northblu/broadcasts" className="font-medium text-brand-blue-500 hover:underline">Broadcasts →</Link>
            <Link href="/northblu/compose" className="font-medium text-brand-blue-500 hover:underline">Compose →</Link>
            <Link href="/northblu/integrations" className="font-medium text-brand-blue-500 hover:underline">Integrations →</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
