import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Leads for Real Peptides — Klaviyo profiles from RP's own account.
 *
 * Deliberately has no "became a customer" column: WooCommerce isn't readable,
 * so conversion is genuinely unknown here and is not guessed at.
 */

interface Leads {
  configured?: boolean;
  hint?: string;
  range?: number;
  truncated?: boolean;
  totals?: { leads: number; lists: number };
  lists?: { id: string; name: string; profiles: number }[];
  series?: { date: string; leads: number }[];
  bySource?: { key: string; leads: number }[];
  recent?: { email: string; source: string; created_at: string | null }[];
  error?: string;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString();

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ops-text">{value}</div>
      {hint && <div className="mt-1 text-xs text-ops-text-muted">{hint}</div>}
    </div>
  );
}

function NotConfigured({ hint }: { hint?: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-6 shadow-card">
      <div className="text-lg font-medium text-ops-text">Real Peptides&apos; Klaviyo isn&apos;t connected</div>
      <p className="mt-2 max-w-2xl text-sm text-ops-text-muted">
        {hint ?? "RP_KLAVIYO_API_KEY is not set."} This is a different account from FitScript&apos;s, so it
        needs its own private key — the existing <code>KLAVIYO_API_KEY</code> would report FitScript&apos;s
        subscribers under Real Peptides, which is worse than showing nothing.
      </p>
      <p className="mt-3 text-xs text-ops-text-muted">
        Klaviyo → Settings → API keys → Create private key, read-only scopes for Profiles and Lists.
        Store it in <code>prod/ops-secrets</code> and reference it <code>valueFrom</code> on the task
        definition, like the other secrets.
      </p>
    </div>
  );
}

export default function RealPeptidesLeads() {
  const { data, isLoading } = useQuery<Leads>({
    queryKey: ["realpeptides-leads"],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/leads?range=30", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  const max = Math.max(...(data?.series ?? []).map((d) => d.leads), 1);

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Leads"
        subtitle="Guide signups and list growth from Real Peptides' Klaviyo."
      />

      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>
      )}
      {!isLoading && data?.configured === false && <NotConfigured hint={data.hint} />}

      {data?.configured && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Stat label="New leads (30d)" value={num(data.totals?.leads)} />
            <Stat label="Lists" value={num(data.totals?.lists)} hint="one per funnel, typically" />
            <Stat
              label="Largest list"
              value={num(data.lists?.[0]?.profiles)}
              hint={data.lists?.[0]?.name ?? "—"}
            />
          </div>

          {data.truncated && (
            <div className="mb-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">
              More than 1,000 profiles were created in this window — the counts above cover the first 1,000
              only. Say the word and this moves to a Klaviyo aggregate query instead of paging profiles.
            </div>
          )}

          <div className="mb-4 rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
            <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">Signups per day (30d, UTC)</div>
            <div className="flex h-28 items-end gap-[3px]">
              {(data.series ?? []).map((d) => (
                <div
                  key={d.date}
                  className="flex-1 rounded-sm bg-fitscript-green/70 transition-colors hover:bg-fitscript-green"
                  style={{ height: `${Math.max(2, (d.leads / max) * 100)}%` }}
                  title={`${d.date} · ${d.leads} leads`}
                />
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
              <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">Lists</div>
              {(data.lists ?? []).length === 0 ? (
                <div className="text-sm text-ops-text-muted">No lists in this account.</div>
              ) : (
                <div className="space-y-2">
                  {(data.lists ?? []).map((l) => (
                    <div key={l.id} className="flex justify-between gap-3 text-sm">
                      <span className="truncate text-ops-text" title={l.name}>{l.name}</span>
                      <span className="shrink-0 text-ops-text-muted">{num(l.profiles)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
              <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">By source (30d)</div>
              {(data.bySource ?? []).length === 0 ? (
                <div className="text-sm text-ops-text-muted">No signups in this window.</div>
              ) : (
                <div className="space-y-2">
                  {(data.bySource ?? []).map((s) => (
                    <div key={s.key} className="flex justify-between gap-3 text-sm">
                      <span className="truncate text-ops-text" title={s.key}>{s.key}</span>
                      <span className="shrink-0 text-ops-text-muted">{num(s.leads)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-ops-text-muted">
                &ldquo;(not tagged)&rdquo; means the form didn&apos;t write a source property onto the profile —
                fixable in the funnel, not here.
              </p>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Signed up</th>
                </tr>
              </thead>
              <tbody>
                {(data.recent ?? []).length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-8 text-center text-ops-text-muted">No signups in the last 30 days.</td></tr>
                )}
                {(data.recent ?? []).map((l, i) => (
                  <tr key={i} className="border-b border-ops-border/50 last:border-0">
                    <td className="px-4 py-2.5 text-ops-text">{l.email}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{l.source}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">
                      {l.created_at ? new Date(l.created_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
