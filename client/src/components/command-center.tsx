import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHero } from "./page-hero";
import { DateRangePicker, rangeDays, type DateRange } from "./date-range-picker";

/**
 * The Command Center kit — the pieces every brand overview is built from so
 * they look and behave the same: tiles with deltas, sections with as-of hints,
 * a health strip, one hero with Refresh + the date range picker. Every tile
 * reads the same feed its tab does and polls every minute.
 */

export const MINUTE = 60_000;
export const usd = (n: number | undefined | null) => (n ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();
export const clock = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
export const get = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

export function rangeLabel(r: DateRange): string {
  if (r.key === "custom") return `${r.from.toLocaleDateString()} – ${r.to.toLocaleDateString()}`;
  return r.label.toLowerCase();
}
export function rangeShort(r: DateRange): string {
  if (r.key === "custom") return `${rangeDays(r)}d custom`;
  if (r.key === "today") return "today";
  return r.label.replace("Last ", "").replace(" days", "d").replace(" hours", "h").toLowerCase();
}

export function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return null;
  if (!prev) return <span className="ml-1.5 text-xs font-medium text-ops-text-muted">new</span>;
  const d = ((cur - prev) / prev) * 100;
  const good = invert ? d < 0 : d > 0;
  const cls = Math.abs(d) < 1 ? "text-ops-text-muted" : good ? "text-fitscript-green" : "text-red-400";
  return <span className={`ml-1.5 text-xs font-medium ${cls}`}>{d > 0 ? "+" : ""}{d.toFixed(0)}%</span>;
}

export type Tone = "warn" | "bad" | "good" | "info";
export function Card({ label, value, sub, accent, tone, to }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: boolean; tone?: Tone; to?: string }) {
  const color = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : tone === "info" ? "text-violet-400" : accent ? "text-brand-blue-500" : "text-ops-text";
  const body = (
    <div className="h-full rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card transition hover:border-ops-text-muted/40 md:p-5">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link href={to} className="block">{body}</Link> : body;
}

export function Section({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ops-text">{title}</h2>
        {hint && <span className="text-right text-xs text-ops-text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export type HealthRow = [name: string, state: "ok" | "bad" | "off" | "…", note: string];
export function Health({ rows }: { rows: HealthRow[] }) {
  return (
    <Section title="Integration health">
      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 md:grid-cols-4">
        {rows.map(([name, state, note]) => (
          <div key={name} className="flex items-center justify-between gap-3 rounded-lg border border-ops-border bg-ops-surface px-3 py-2">
            <span className="shrink-0 text-ops-text">{name}</span>
            <span className="flex min-w-0 items-center gap-2 text-xs text-ops-text-muted"><span className="truncate" title={note}>{note}</span><span className={`h-2 w-2 shrink-0 rounded-full ${state === "ok" ? "bg-fitscript-green" : state === "bad" ? "bg-red-400" : state === "off" ? "bg-ops-border" : "bg-yellow-500"}`} /></span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Zero-dependency daily bars with hover values — the same sparkline on every brand. */
export function DailyBars({ rows, money, label }: { rows: { date: string; value: number }[]; money?: boolean; label: string }) {
  if (!rows.length) return <div className="text-sm text-ops-text-muted">Nothing in this window.</div>;
  const max = Math.max(...rows.map((d) => d.value), 1);
  const fmt = (v: number) => (money ? usd(v) : num(v));
  return (
    <div>
      <div className="flex h-32 items-end gap-[3px]">
        {rows.map((d) => (
          <div key={d.date} className="group relative flex-1 rounded-t bg-fitscript-green/70 transition hover:bg-fitscript-green" style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }}>
            <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ops-bg px-1.5 py-0.5 text-[10px] text-ops-text shadow group-hover:block">{d.date.slice(5)} · {fmt(d.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-ops-text-muted"><span>{rows[0]?.date}</span><span>peak {fmt(max)} · {label}</span><span>{rows[rows.length - 1]?.date}</span></div>
    </div>
  );
}

export function Breakdown({ rows, money, empty }: { rows: { key: string; count: number; value: number }[]; money?: boolean; empty: string }) {
  if (!rows.length) return <div className="text-sm text-ops-text-muted">{empty}</div>;
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="text-sm">
          <div className="flex justify-between gap-3"><span className="truncate text-ops-text" title={r.key}>{r.key}</span><span className="shrink-0 tabular-nums text-ops-text-muted">{money ? usd(r.value) : num(r.value)} · {num(r.count)} · {Math.round((r.value / total) * 100)}%</span></div>
          <div className="mt-1 h-1.5 rounded bg-ops-border"><div className="h-full rounded bg-brand-blue-500" style={{ width: `${(r.value / total) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-1 text-base font-medium text-ops-text">{title}</div>
      {subtitle && <div className="mb-4 text-xs text-ops-text-muted">{subtitle}</div>}
      {children}
    </div>
  );
}

/** Hero with Refresh + range picker; `keys` are the react-query keys Refresh invalidates. */
export function CommandHero({ eyebrow, subtitle, range, setRange, keys, refreshing, onRefresh }: {
  eyebrow: string; subtitle: string; range: DateRange; setRange: (r: DateRange) => void; keys: string[]; refreshing: boolean; onRefresh?: () => void;
}) {
  const qc = useQueryClient();
  const refresh = () => { onRefresh?.(); for (const k of keys) qc.invalidateQueries({ queryKey: [k] }); };
  return (
    <PageHero
      eyebrow={eyebrow}
      title="Command Center"
      subtitle={`${subtitle} Live: tiles refresh every minute.`}
      actions={
        <>
          <button type="button" onClick={refresh} disabled={refreshing} title="Re-pull everything now" className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text hover:border-ops-text-muted disabled:opacity-60">
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh
          </button>
          <DateRangePicker value={range} onChange={setRange} />
        </>
      }
    />
  );
}
