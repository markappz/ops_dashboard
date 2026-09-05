import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Leads for Real Peptides.
 *
 * realpeptides.co's Postgres is the CRM and mirrors every segment to Resend, so
 * the site's /api/ops-contacts IS the Resend list. Campaign Refinery (and the
 * Moosend funnels that fed it) stopped receiving signups at the 2026-08-24
 * launch — they stay here as the pre-launch archive, clearly labelled.
 */

interface Contacts {
  configured?: boolean;
  hint?: string;
  error?: string;
  generatedAt?: string;
  days?: number;
  totals?: { total: number; marketable: number; unsubscribed: number; suppressed: number; buyers: number; leads: number };
  new?: { today: number; week: number; month: number; window: number };
  bySource?: { source: string; count: number }[];
  daily?: { date: string; count: number }[];
  recent?: { email: string; name: string | null; source: string; createdAt: string; unsubscribed: boolean; buyer: boolean }[];
}

interface Legacy {
  range?: number;
  moosend?: { configured?: boolean; error?: string; totalActive?: number; lists?: { id: string; name: string; active: number }[] };
  campaignRefinery?: { configured?: boolean; error?: string; total?: number; recentCount?: number };
}

const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();
const get = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());
const MINUTE = 60_000;

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "muted" }) {
  const color = tone === "good" ? "text-fitscript-green" : tone === "muted" ? "text-ops-text-muted" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-1 text-base font-medium text-ops-text">{title}</div>
      {subtitle && <div className="mb-4 text-xs text-ops-text-muted">{subtitle}</div>}
      {children}
    </div>
  );
}

function Totals({ c }: { c: Contacts }) {
  const t = c.totals;
  const n = c.new;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
      <Stat label="Contacts" value={num(t?.total)} sub={`${num(t?.marketable)} mailable`} />
      <Stat label="Buyers" value={num(t?.buyers)} sub="at least one paid order" />
      <Stat label="Leads" value={num(t?.leads)} sub="mailable, never bought" />
      <Stat label="Unsubscribed" value={num(t?.unsubscribed)} sub={`${num(t?.suppressed)} bounced/complained`} tone="muted" />
      <Stat label="New · today" value={num(n?.today)} sub="last 24 hours" tone={n?.today ? "good" : undefined} />
      <Stat label="New · 7 days" value={num(n?.week)} sub={n?.week ? `${Math.round(n.week / 7)}/day` : undefined} />
      <Stat label="New · 30 days" value={num(n?.month)} sub={n?.month ? `${Math.round(n.month / 30)}/day` : undefined} />
    </div>
  );
}

function DailyBars({ daily }: { daily: { date: string; count: number }[] }) {
  if (!daily.length) return <div className="text-sm text-ops-text-muted">No signups in this window.</div>;
  const max = Math.max(...daily.map((d) => d.count), 1);
  return (
    <div className="flex h-36 items-end gap-[3px]">
      {daily.map((d) => (
        <div key={d.date} className="group relative flex-1 rounded-t bg-fitscript-green/70 transition hover:bg-fitscript-green" style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }}>
          <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ops-bg px-1.5 py-0.5 text-[10px] text-ops-text shadow group-hover:block">{d.date.slice(5)} · {d.count}</span>
        </div>
      ))}
    </div>
  );
}

function Sources({ rows, total }: { rows: { source: string; count: number }[]; total: number }) {
  if (!rows.length) return <div className="text-sm text-ops-text-muted">Nothing captured in this window.</div>;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.source} className="text-sm">
          <div className="flex justify-between gap-3"><span className="truncate text-ops-text">{r.source}</span><span className="shrink-0 tabular-nums text-ops-text-muted">{num(r.count)} · {total ? Math.round((r.count / total) * 100) : 0}%</span></div>
          <div className="mt-1 h-1.5 rounded bg-ops-border"><div className="h-full rounded bg-brand-blue-500" style={{ width: `${total ? (r.count / total) * 100 : 0}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function Recent({ rows }: { rows: NonNullable<Contacts["recent"]> }) {
  if (!rows.length) return <div className="text-sm text-ops-text-muted">No contacts yet.</div>;
  return (
    <div className="max-h-96 space-y-1.5 overflow-y-auto">
      {rows.map((c) => (
        <div key={c.email} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-ops-text" title={c.email}>{c.email}{c.name ? <span className="text-ops-text-muted"> · {c.name}</span> : null}</span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-ops-text-muted">
            {c.buyer && <span className="rounded-full bg-fitscript-green/15 px-2 py-0.5 text-[10px] font-semibold text-fitscript-green">buyer</span>}
            {c.unsubscribed && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">unsub</span>}
            <span className="truncate">{c.source}</span>
            <span>{new Date(c.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function LegacyLists({ range }: { range: number }) {
  const { data } = useQuery<Legacy>({ queryKey: ["rp-leads", range], queryFn: () => get(`/api/ops/realpeptides/leads?range=${range}`), staleTime: 15 * MINUTE });
  const cr = data?.campaignRefinery;
  const ms = data?.moosend;
  return (
    <Panel title="Pre-launch archive" subtitle="Campaign Refinery + Moosend stopped receiving signups when realpeptides.co relaunched on Aug 24, 2026. Their contacts were imported into the CRM above.">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div><div className="text-[11px] uppercase tracking-wider text-ops-text-muted">Campaign Refinery</div><div className="mt-1 text-xl font-semibold text-ops-text">{cr?.configured === false ? "—" : cr?.error ? "!" : num(cr?.total)}</div><div className="text-xs text-ops-text-muted">{cr?.error ?? `${num(cr?.recentCount)} new in ${range}d`}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-ops-text-muted">Moosend</div><div className="mt-1 text-xl font-semibold text-ops-text">{ms?.configured === false ? "—" : ms?.error ? "!" : num(ms?.totalActive)}</div><div className="text-xs text-ops-text-muted">{ms?.configured === false ? "not connected" : ms?.error ?? `${(ms?.lists ?? []).length} lists`}</div></div>
      </div>
    </Panel>
  );
}

export default function RealPeptidesLeads() {
  const [range, setRange] = useState(30);
  const q = useQuery<Contacts>({ queryKey: ["rp-contacts", range], queryFn: () => get(`/api/ops/realpeptides/contacts?range=${range}`), refetchInterval: MINUTE });
  const c = q.data;
  const asOf = c?.generatedAt ? new Date(c.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Leads"
        subtitle={`realpeptides.co's CRM is the list of record and mirrors every segment to Resend.${asOf ? ` Live · as of ${asOf}.` : ""}`}
        actions={
          <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text focus:border-fitscript-green focus:outline-none">
            {[7, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}
          </select>
        }
      />

      {q.isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {(q.isError || c?.error) && <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{c?.error ?? (q.error as Error)?.message}</div>}
      {c?.configured === false && <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">{c.hint}</div>}

      {c?.configured && (
        <div className="space-y-6">
          <Totals c={c} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Panel title={`Signups · last ${range} days`} subtitle={`${num(c.new?.window)} new contacts in the window`}>
                <DailyBars daily={c.daily ?? []} />
              </Panel>
            </div>
            <Panel title="By source" subtitle="Where they were captured">
              <Sources rows={c.bySource ?? []} total={c.new?.window ?? 0} />
            </Panel>
          </div>
          <Panel title="Latest signups" subtitle="Newest 50 contacts">
            <Recent rows={c.recent ?? []} />
          </Panel>
          <LegacyLists range={range} />
        </div>
      )}
    </div>
  );
}
