/**
 * Reporting window shared by the Real Peptides routes: either `range=N` days
 * (trailing, ending now) or an explicit `from`/`to` (ISO, inclusive) from the
 * date picker. Also carries the previous window of equal length for deltas.
 */
const DAY = 86_400_000;

export interface Window {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  days: number;
  custom: boolean;
  /** Query-string fragment to forward to the site: `from=&to=` or `days=`. */
  site: string;
  /** Stable cache key. */
  key: string;
}

function parse(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function windowOf(q: Record<string, unknown>, fallbackDays = 30): Window {
  const now = new Date();
  const from = parse(q.from);
  const to = parse(q.to);
  if (from && to && to > from) {
    const end = to > now ? now : to;
    const span = to.getTime() - from.getTime();
    const days = Math.max(1, Math.round(span / DAY));
    return { from, to: end, prevFrom: new Date(from.getTime() - span), prevTo: from, days, custom: true,
      site: `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      key: `${from.toISOString()}..${to.toISOString()}` };
  }
  const n = parseInt(String(q.range ?? q.days ?? fallbackDays), 10);
  const days = Number.isFinite(n) && n > 0 && n <= 365 ? n : fallbackDays;
  return { from: new Date(now.getTime() - days * DAY), to: now, prevFrom: new Date(now.getTime() - 2 * days * DAY), prevTo: new Date(now.getTime() - days * DAY),
    days, custom: false, site: `days=${days}`, key: `d${days}` };
}

/**
 * Evict expired entries before inserting. Live preset windows mint a new
 * `from..to` key every minute, so an unpruned window-keyed Map grows without
 * bound for the life of the process.
 */
export function pruneCache<V extends { at: number }>(cache: Map<string, V>, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}
