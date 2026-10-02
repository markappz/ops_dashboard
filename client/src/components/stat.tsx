import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";

/**
 * Stat primitives v2 — the facelift's first components (P1, 2026-10-02). The rules they encode:
 * numbers animate once on arrival (600ms ease-out count-up, instant under reduced-motion),
 * every headline figure carries its delta vs the previous period as a signed pill, trends get a
 * real sparkline instead of prose, and cards lift on hover without bouncing. Everything derives
 * from the ops-* tokens so both themes come free.
 */

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Animated number: counts from the previously shown value to the new one. */
export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString());
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    if (reduced() || fromRef.current === value) { fromRef.current = value; setShown(value); return; }
    const from = fromRef.current;
    fromRef.current = value;
    const t0 = performance.now();
    const dur = 600;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tabular-nums">{fmt(shown)}</span>;
}

/** Signed change vs the previous period. `invert` for metrics where down is good. */
export function DeltaPill({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return null;
  const pct = prev ? ((cur - prev) / prev) * 100 : 100;
  if (!isFinite(pct) || Math.abs(pct) < 0.05) return null;
  const up = pct > 0;
  const good = invert ? !up : up;
  return (
    <span
      className={`ml-2 inline-flex translate-y-[-2px] items-center gap-0.5 rounded-full px-1.5 py-0.5 align-middle text-[10.5px] font-semibold tabular-nums ${
        good ? "bg-fitscript-green/10 text-fitscript-green" : "bg-red-500/10 text-red-400"
      }`}
      title="vs previous period"
    >
      <svg viewBox="0 0 10 10" className={`h-2 w-2 ${up ? "" : "rotate-180"}`} fill="currentColor"><path d="M5 1l4 5H1z" /></svg>
      {Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** Tiny area sparkline, drawn from the theme's currentColor. Endpoint emphasized. */
export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  if (!points || points.length < 2) return null;
  const w = 120, h = 34, pad = 3;
  const max = Math.max(...points), min = Math.min(...points);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${h - pad}L${x(0).toFixed(1)},${h - pad}Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className ?? "h-[34px] w-[120px]"} aria-hidden="true">
      <path d={area} fill="currentColor" opacity="0.1" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r="2.4" fill="currentColor" />
    </svg>
  );
}

type Tone = "good" | "warn" | "bad" | "info";

export function StatCard({ label, value, number, format, sub, delta, spark, accent, tone, to, i = 0 }: {
  label: string;
  /** Preformatted node, OR pass `number` (+ optional `format`) for the count-up treatment. */
  value?: React.ReactNode;
  number?: number;
  format?: (n: number) => string;
  sub?: React.ReactNode;
  delta?: { cur: number; prev: number; invert?: boolean };
  spark?: number[];
  accent?: boolean;
  tone?: Tone;
  to?: string;
  /** Index in the grid for the staggered entrance. */
  i?: number;
}) {
  const color =
    tone === "bad" ? "text-red-400"
    : tone === "warn" ? "text-yellow-500"
    : tone === "good" ? "text-fitscript-green"
    : tone === "info" ? "text-violet-400"
    : accent ? "text-brand-blue-500"
    : "text-ops-text";
  const body = (
    <div
      className="ops-rise group relative h-full overflow-hidden rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card transition-all duration-200 hover:-translate-y-px hover:border-ops-border-strong hover:shadow-card-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
    >
      {accent && <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-blue-500/70 to-transparent" />}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
        {spark && <div className={`-mt-1 shrink-0 opacity-80 ${accent ? "text-brand-blue-500" : "text-ops-text-muted"}`}><Sparkline points={spark} /></div>}
      </div>
      <div className={`text-2xl font-bold tracking-tight ${color}`}>
        {value === "…"
          ? <span className="ops-skeleton inline-block h-7 w-24 rounded-md align-middle" aria-label="loading" />
          : number !== undefined ? <CountUp value={number} format={format} /> : value}
        {delta && <DeltaPill {...delta} />}
      </div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link href={to} className="block h-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-blue-500/60">{body}</Link> : body;
}
