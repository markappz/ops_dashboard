import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageHero } from "../components/page-hero";

/**
 * Per-company integrations. ONE component for every brand — the company comes in
 * as a prop, so adding a fourth (Real Peptides) is a nav entry + a route, not a
 * new page.
 *
 * Each brand holds its OWN Google connection: pawgen's analytics live under
 * hello@pawgen.com, FitScript's under a different account entirely. Connecting
 * one must never disturb another, which is why every call here carries ?company=.
 */

interface Connections {
  company?: string;
  googleConfigured?: boolean;
  google?: { connected: boolean; email?: string; ga4PropertyId?: string | null; gscSiteUrl?: string | null; connectedAt?: string };
  error?: string;
}
interface Props { properties?: { propertyId: string; displayName: string; account?: string }[] }
interface Sites { sites?: { url: string; permission?: string }[] }

export default function CompanyIntegrations({ company, label }: { company: string; label: string }) {
  const qc = useQueryClient();
  const [ga4, setGa4] = useState("");
  const [gsc, setGsc] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const conn = useQuery<Connections>({
    queryKey: ["connections", company],
    queryFn: async () => {
      const r = await fetch(`/api/ops/connections?company=${company}`, { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  const connected = conn.data?.google?.connected === true;

  const props = useQuery<Props>({
    queryKey: ["ga4-properties", company],
    enabled: connected,
    queryFn: async () => (await fetch(`/api/ops/ga4/properties?company=${company}`, { credentials: "include" })).json(),
  });
  const sites = useQuery<Sites>({
    queryKey: ["gsc-sites", company],
    enabled: connected,
    queryFn: async () => (await fetch(`/api/ops/gsc/sites?company=${company}`, { credentials: "include" })).json(),
  });

  // Seed the selects from what's already stored, once it arrives.
  useEffect(() => {
    setGa4(conn.data?.google?.ga4PropertyId ?? "");
    setGsc(conn.data?.google?.gscSiteUrl ?? "");
  }, [conn.data?.google?.ga4PropertyId, conn.data?.google?.gscSiteUrl]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/ops/google/config", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, ga4PropertyId: ga4 || null, gscSiteUrl: gsc || null }),
      });
      await qc.invalidateQueries({ queryKey: ["connections", company] });
      // The data tabs cache per company — drop them so they refetch against the
      // newly chosen property instead of showing the old one.
      await qc.invalidateQueries({ queryKey: [`${company}-ga4`] });
      await qc.invalidateQueries({ queryKey: [`${company}-gsc`] });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    await fetch("/api/ops/google/disconnect", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company }),
    });
    qc.invalidateQueries({ queryKey: ["connections", company] });
  };

  return (
    <div>
      <PageHero
        eyebrow={label}
        title="Integrations"
        subtitle={`Connect and choose the data sources for ${label}. Each brand keeps its own — connecting here won't affect the others.`}
      />

      <div className="max-w-3xl space-y-4">
        <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-base font-medium text-ops-text">Google Analytics &amp; Search Console</div>
              {conn.isLoading ? (
                <div className="mt-1 text-sm text-ops-text-muted">Checking…</div>
              ) : connected ? (
                <div className="mt-1 text-sm text-ops-text-muted">
                  Connected as <span className="text-ops-text">{conn.data?.google?.email}</span>
                </div>
              ) : (
                <div className="mt-1 text-sm text-ops-text-muted">
                  Not connected. Authorise the Google account that owns {label}&apos;s analytics.
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <a
                href={`/api/ops/google/connect?company=${company}`}
                className="rounded-lg bg-fitscript-green px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                {connected ? "Reconnect" : "Connect Google"}
              </a>
              {connected && (
                <button
                  type="button"
                  onClick={disconnect}
                  className="rounded-lg border border-ops-border px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text"
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>

          {connected && (
            <div className="mt-5 grid gap-4 border-t border-ops-border pt-5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[11px] uppercase tracking-wider text-ops-text-muted">GA4 property</span>
                <select
                  value={ga4}
                  onChange={(e) => { setGa4(e.target.value); setSaved(false); }}
                  className="w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text"
                >
                  <option value="">— none selected —</option>
                  {(props.data?.properties ?? []).map((p) => (
                    <option key={p.propertyId} value={p.propertyId}>
                      {p.displayName} ({p.propertyId})
                    </option>
                  ))}
                </select>
                {props.isLoading && <span className="mt-1 block text-xs text-ops-text-muted">Loading properties…</span>}
                {!props.isLoading && (props.data?.properties ?? []).length === 0 && (
                  <span className="mt-1 block text-xs text-ops-text-muted">
                    No properties visible to this account.
                  </span>
                )}
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[11px] uppercase tracking-wider text-ops-text-muted">Search Console site</span>
                <select
                  value={gsc}
                  onChange={(e) => { setGsc(e.target.value); setSaved(false); }}
                  className="w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text"
                >
                  <option value="">— none selected —</option>
                  {(sites.data?.sites ?? []).map((s) => (
                    <option key={s.url} value={s.url}>{s.url}</option>
                  ))}
                </select>
                {sites.isLoading && <span className="mt-1 block text-xs text-ops-text-muted">Loading sites…</span>}
              </label>

              <div className="sm:col-span-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="rounded-lg bg-fitscript-green px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save selection"}
                </button>
                {saved && <span className="text-sm text-fitscript-green">Saved — the Traffic and SEO tabs will use these.</span>}
              </div>
            </div>
          )}
        </div>

        <p className="text-xs text-ops-text-muted">
          Google shows an &ldquo;unverified app&rdquo; warning during connect — that&apos;s expected for an internal
          tool requesting analytics scopes. Choose <em>Advanced → Go to ops.fitscript.me</em> to continue.
        </p>
      </div>
    </div>
  );
}
