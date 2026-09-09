import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { rangeQuery, useDateRange, type DateRange } from "../components/date-range-picker";
import { Card, CommandHero, DailyBars, Delta, Health, Panel, Section, MINUTE, clock, get, num, usd, rangeLabel, rangeShort, type HealthRow } from "../components/command-center";

/**
 * PeptideU Command Center — the education app's health on the same kit as the
 * other brands: membership and MRR, growth in the chosen window vs the previous
 * one, what members actually did, and every queue that needs a human.
 */

interface Counts {
  signups: number; onboarded: number; active_learners: number; lessons_completed: number; quiz_attempts: number; quiz_passes: number;
  questions: number; askers: number; coa_scans: number; posts: number; comments: number; oh_rsvps: number; research_logs: number;
  drawing_entries: number; memberships_granted: number; active_members: number;
}
interface Cmd {
  configured?: boolean; hint?: string; generatedAt?: string;
  window?: { from: string; to: string; days: number; custom: boolean };
  current?: Counts; previous?: Counts; today?: Counts;
  members?: { total: number; premium: number; comped: number; paying: number; mrrEstimate: number; arrEstimate: number; conversion: number; onboarded: number; activated: number; graduates: number; expiring14d: number };
  queues?: { peptideRequests: number; brandRequests: number; featureRequests: number; libraryUpdates: number; drawingsScheduled: number };
  series?: { date: string; signups: number; learners: number }[];
}

const pct = (n: number | undefined) => `${((n ?? 0) * 100).toFixed(1)}%`;

function MembersRow({ d }: { d?: Cmd }) {
  const m = d?.members;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card label="MRR (est.)" accent to="/peptideu/members" value={m ? usd(m.mrrEstimate) : "…"} sub={m ? `${num(m.paying)} paying premium × plan · ARR ${usd(m.arrEstimate)}` : undefined} />
      <Card label="Premium members" to="/peptideu/members" value={m ? num(m.premium) : "…"} sub={m ? `${num(m.comped)} comped · ${pct(m.conversion)} of ${num(m.total)} members` : undefined} />
      <Card label="Total members" to="/peptideu/members" value={m ? num(m.total) : "…"} sub={m ? `${num(m.onboarded)} onboarded · ${num(m.activated)} completed a lesson` : undefined} />
      <Card label="Renewals due · 14d" to="/peptideu/members" value={m ? num(m.expiring14d) : "…"} tone={m?.expiring14d ? "warn" : undefined} sub="premium expiring soon" />
    </div>
  );
}

function GrowthRow({ d, range }: { d?: Cmd; range: DateRange }) {
  const c = d?.current; const p = d?.previous; const rl = rangeShort(range);
  const v = (k: keyof Counts) => (c ? <>{num(c[k])}<Delta cur={c[k]} prev={p?.[k] ?? 0} /></> : "…");
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label={`Signups · ${rl}`} to="/peptideu/members" value={v("signups")} tone={c?.signups ? "good" : undefined} sub={d?.today ? `${num(d.today.signups)} in the last 24h` : undefined} />
      <Card label={`Onboarded · ${rl}`} value={v("onboarded")} sub={c ? `${c.signups ? Math.round((c.onboarded / c.signups) * 100) : 0}% of new signups` : undefined} />
      <Card label={`Active members · ${rl}`} value={v("active_members")} sub="learned, asked, posted, logged or scanned" />
      <Card label={`Lessons completed · ${rl}`} to="/peptideu/curriculum" value={v("lessons_completed")} sub={c ? `${num(c.active_learners)} learners · ${c.quiz_attempts ? Math.round((c.quiz_passes / c.quiz_attempts) * 100) : 0}% quiz pass` : undefined} />
      <Card label={`Memberships granted · ${rl}`} to="/peptideu/drawing" value={v("memberships_granted")} sub="lifetime / comp grants" />
    </div>
  );
}

function EngagementRow({ d, range }: { d?: Cmd; range: DateRange }) {
  const c = d?.current; const p = d?.previous; const rl = rangeShort(range);
  const v = (k: keyof Counts) => (c ? <>{num(c[k])}<Delta cur={c[k]} prev={p?.[k] ?? 0} /></> : "…");
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label={`Professor questions · ${rl}`} to="/peptideu/questions" value={v("questions")} sub={c ? `${num(c.askers)} members asking` : undefined} />
      <Card label={`Commons posts · ${rl}`} to="/peptideu/moderation" value={v("posts")} sub={c ? `${num(c.comments)} comments` : undefined} />
      <Card label={`COA scans · ${rl}`} value={v("coa_scans")} sub="document analysis" />
      <Card label={`Research logs · ${rl}`} value={v("research_logs")} sub="private tracking entries" />
      <Card label={`Office hours RSVPs · ${rl}`} value={v("oh_rsvps")} sub={c ? `${num(c.drawing_entries)} drawing entries earned` : undefined} />
    </div>
  );
}

function QueuesRow({ d }: { d?: Cmd }) {
  const q = d?.queues;
  const tone = (n?: number) => (n ? "warn" : "good");
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label="Peptide requests" to="/peptideu/requests" value={q ? num(q.peptideRequests) : "…"} tone={tone(q?.peptideRequests)} sub="waiting for approval" />
      <Card label="Brand requests" to="/peptideu/requests" value={q ? num(q.brandRequests) : "…"} tone={tone(q?.brandRequests)} sub="waiting for approval" />
      <Card label="Feature requests" to="/peptideu/features" value={q ? num(q.featureRequests) : "…"} tone={tone(q?.featureRequests)} sub="pending review" />
      <Card label="Library updates" to="/peptideu/library" value={q ? num(q.libraryUpdates) : "…"} tone={tone(q?.libraryUpdates)} sub="regulatory changes to approve" />
      <Card label="Drawings scheduled" to="/peptideu/drawing" value={q ? num(q.drawingsScheduled) : "…"} tone={q?.drawingsScheduled ? "info" : undefined} sub="monthly sweepstakes" />
    </div>
  );
}

export default function PeptideuOverview() {
  const [range, setRange] = useDateRange("peptideu-overview");
  const rq = rangeQuery(range);
  const q = useQuery<Cmd>({ queryKey: ["peptideu-command", rq], queryFn: () => get(`/api/ops/peptideu/command?${rq}`), refetchInterval: MINUTE });
  const d = q.data;
  const signups = useMemo(() => (d?.series ?? []).map((r) => ({ date: r.date, value: r.signups })), [d]);
  const learners = useMemo(() => (d?.series ?? []).map((r) => ({ date: r.date, value: r.learners })), [d]);
  const m = d?.members;
  const funnel = m ? [
    { label: "Signed up", n: m.total }, { label: "Onboarded", n: m.onboarded }, { label: "Completed a lesson", n: m.activated }, { label: "Graduates", n: m.graduates }, { label: "Premium", n: m.premium },
  ] : [];

  const health: HealthRow[] = [
    ["PeptideU database", d?.configured ? "ok" : q.isError ? "bad" : d ? "off" : "…", d?.configured ? `as of ${clock(d.generatedAt)}` : d?.hint ?? (q.error as Error)?.message ?? ""],
    ["App Store", "off", "revenue is estimated from premium × plan"],
  ];

  return (
    <div>
      <CommandHero eyebrow="PeptideU" subtitle="The education app at a glance — membership, growth, what members did, and every queue that needs a human." range={range} setRange={setRange} keys={["peptideu-command"]} refreshing={q.isFetching} />

      {d && !d.configured && <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">{d.hint}</div>}
      {q.isError && <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}

      <MembersRow d={d} />

      <Section title="Growth" hint={d?.window ? `vs the previous ${d.window.days} days` : undefined}>
        <GrowthRow d={d} range={range} />
      </Section>

      <Section title="Engagement" hint="what members did in the window">
        <EngagementRow d={d} range={range} />
      </Section>

      <Section title="Needs a human" hint="queues across the app">
        <QueuesRow d={d} />
      </Section>

      <Section title={`Activity · ${rangeLabel(range)}`}>
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Signups by day" subtitle={`${num(d?.current?.signups)} in the window`}><DailyBars rows={signups} label="signups" /></Panel>
          <Panel title="Learners by day" subtitle="members who completed a lesson"><DailyBars rows={learners} label="learners" /></Panel>
          <Panel title="Member funnel" subtitle="all time">
            <div className="space-y-2">
              {funnel.map((f) => (
                <div key={f.label} className="text-sm">
                  <div className="flex justify-between"><span className="text-ops-text">{f.label}</span><span className="tabular-nums text-ops-text-muted">{num(f.n)} · {m?.total ? Math.round((f.n / m.total) * 100) : 0}%</span></div>
                  <div className="mt-1 h-1.5 rounded bg-ops-border"><div className="h-full rounded bg-brand-blue-500" style={{ width: `${m?.total ? (f.n / m.total) * 100 : 0}%` }} /></div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </Section>

      <Health rows={health} />
    </div>
  );
}
