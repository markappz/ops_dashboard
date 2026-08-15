import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Traffic (GA4) and SEO (Search Console) for ANY brand.
 *
 * Both read the same company-scoped endpoints FitScript uses, with ?company=<slug>,
 * so each brand gets its own property/site rather than FitScript's numbers. Adding a
 * brand is a route with props — there is no per-brand copy of this file.
 *
 * Until Google is connected these render an honest "not connected" state that says
 * what to do — not an empty chart implying zero traffic.
 */

// Shapes match what the endpoints ACTUALLY return (verified against prod) — the
// GA4 route sends `totals`/`sources[].channel`, not `summary`/`sources[].source`.
interface Ga4 {
  connected?: boolean;
  error?: string;
  totals?: { sessions?: number; users?: number; newUsers?: number; pageViews?: number };
  daily?: { date: string; sessions: number; users: number; pageViews: number; bounceRate: number; avgDuration: number }[];
  sources?: { channel: string; sessions: number; users: number; pageViews: number }[];
  topPages?: { page: string; views: number; avgDuration: number }[];
}

/**
 * NOTE the string types on per-row `ctr`/`position`: the server already calls
 * `.toFixed(1)` on both before sending (see google-auth.ts), so they arrive as
 * STRINGS while the `totals` equivalents are numbers. Typing them as numbers is
 * what crashed this page — `q.position.toFixed(1)` on a string. content.tsx had
 * it right; the pawgen page this was generalized from did not, and only escaped
 * because pawgen has no Search Console data to render.
 *
 * Both are already scaled to percent units too — never multiply them again.
 */
interface Gsc {
  connected?: boolean;
  error?: string;
  totals?: { clicks?: number; impressions?: number; ctr?: number; position?: number };
  daily?: { date: string; clicks: number; impressions: number }[];
  topQueries?: { query: string; clicks: number; impressions: number; ctr: string; position: string }[];
  topPages?: { page: string; clicks: number; impressions: number }[];
}

export interface BrandProps {
  /** URL slug + ?company= value, e.g. "pawgen" */
  company: string;
  /** Display name, e.g. "Real Peptides" */
  label: string;
  /** Bare domain, used only in the empty-state copy */
  domain: string;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString();

/** Accepts the string-or-number the two Google routes mix, never NaN. */
const toNum = (v: number | string | undefined) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Both routes hand back CTR already scaled to percent (e.g. 3.4 means 3.4%), so
 * this only formats. The previous version guessed from magnitude — `n <= 1 ?
 * n*100 : n` — which silently reported a genuine 0.8% CTR as 80%.
 */
const pct = (v: number | string | undefined) => `${toNum(v).toFixed(1)}%`;

function NotConnected({ what, company, label }: { what: "traffic" | "seo"; company: string; label: string }) {
  const product = what === "traffic" ? "Google Analytics" : "Search Console";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-8 text-center shadow-card">
      <div className="text-lg font-medium text-ops-text">{product} isn&apos;t connected for {label}</div>
      <p className="mx-auto mt-2 max-w-md text-sm text-ops-text-muted">
        This tab needs authorisation to read the data back. Connect the Google account that owns
        the {label} property, then pick it from the list.
      </p>
      <a
        href={`/api/ops/google/connect?company=${company}`}
        className="mt-5 inline-block rounded-lg bg-fitscript-green px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Connect Google for {label}
      </a>
      <p className="mt-3 text-xs text-ops-text-muted">
        Each brand holds its own connection — connecting here won&apos;t disturb the others.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ops-text">{value}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
            {head.map((h) => (
              <th key={h} className="px-4 py-3 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={head.length} className="px-4 py-8 text-center text-ops-text-muted">No data yet.</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-ops-border/50 last:border-0">
              {r.map((c, j) => (
                <td key={j} className={`px-4 py-2.5 ${j === 0 ? "text-ops-text" : "text-ops-text-muted"}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CompanyTraffic({ company, label }: BrandProps) {
  const { data, isLoading } = useQuery<Ga4>({
    queryKey: [`${company}-ga4`],
    queryFn: async () => {
      const r = await fetch(`/api/ops/ga4/overview?company=${company}&range=30`, { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Traffic request failed (HTTP ${r.status})` }; }
    },
  });

  return (
    <div>
      <PageHero eyebrow={label} title="Site Traffic" subtitle="Visitors, sessions and sources from Google Analytics." />
      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {!isLoading && data?.connected === false && <NotConnected what="traffic" company={company} label={label} />}
      {!isLoading && data?.connected !== false && data?.error && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">{data.error}</div>
      )}
      {data?.totals && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Users" value={num(data.totals.users)} />
            <Stat label="Sessions" value={num(data.totals.sessions)} />
            <Stat label="New users" value={num(data.totals.newUsers)} />
            <Stat label="Page views" value={num(data.totals.pageViews)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Table
              head={["Top page", "Views", "Avg time"]}
              rows={(data.topPages ?? []).map((p) => [p.page, num(p.views), `${Math.round(p.avgDuration)}s`])}
            />
            <Table
              head={["Channel", "Users", "Sessions"]}
              rows={(data.sources ?? []).map((s) => [s.channel, num(s.users), num(s.sessions)])}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function CompanySeo({ company, label, domain }: BrandProps) {
  const { data, isLoading } = useQuery<Gsc>({
    queryKey: [`${company}-gsc`],
    queryFn: async () => {
      const r = await fetch(`/api/ops/gsc/overview?company=${company}&range=30`, { credentials: "include" });
      try { return await r.json(); } catch { return { error: `SEO request failed (HTTP ${r.status})` }; }
    },
  });

  return (
    <div>
      <PageHero eyebrow={label} title="SEO" subtitle="Search impressions, clicks and ranking queries from Search Console." />
      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {!isLoading && data?.connected === false && <NotConnected what="seo" company={company} label={label} />}
      {!isLoading && data?.connected !== false && data?.error && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">{data.error}</div>
      )}
      {data?.totals && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Clicks" value={num(data.totals.clicks)} />
            <Stat label="Impressions" value={num(data.totals.impressions)} />
            <Stat label="CTR" value={pct(data.totals.ctr)} />
            <Stat label="Avg position" value={toNum(data.totals.position).toFixed(1)} />
          </div>
          {(data.topQueries ?? []).length === 0 && (
            <div className="mb-4 rounded-xl border border-ops-border bg-ops-surface p-4 text-sm text-ops-text-muted">
              Search Console has no data for {domain} yet. It typically takes a couple of days after
              verification before Google reports impressions — this fills in on its own.
            </div>
          )}
          <div className="grid gap-4">
            <Table
              head={["Query", "Clicks", "Impressions", "CTR", "Position"]}
              rows={(data.topQueries ?? []).map((q) => [
                q.query,
                num(q.clicks),
                num(q.impressions),
                pct(q.ctr),
                toNum(q.position).toFixed(1),
              ])}
            />
            <Table head={["Page", "Clicks", "Impressions"]} rows={(data.topPages ?? []).map((p) => [p.page, num(p.clicks), num(p.impressions)])} />
          </div>
        </>
      )}
    </div>
  );
}
