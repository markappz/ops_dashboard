import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";
import type React from "react";
import { PageHero } from "../components/page-hero";

interface SettingsData {
  session: { email: string | null; ttlDays: number };
  adminEmails: string[];
  integrations: {
    database: { configured: boolean; label: string };
    ai: { configured: boolean; provider: string; region: string | null; label: string };
    stripe: { configured: boolean; keyMode: string; keyTail: string; label: string };
    klaviyo: { configured: boolean; keyTail: string; conversionMetricOverride: string | null; label: string };
    googleOAuth: { configured: boolean; clientIdTail: string; label: string };
    metaAds: { configured: boolean; adAccountId: string | null; tokenTail: string; apiVersion: string; label: string };
    clomark: { configured: boolean; businessIdConfigured: boolean; baseUrl: string | null; tokenTail: string; businessIdTail: string; label: string };
  };
  auth: { sessionSecretConfigured: boolean; adminRedirectUri: string | null };
  env: { nodeEnv: string; port: string };
}

interface AdminAction {
  id: number;
  admin_email: string;
  action_type: string;
  target_kind: string;
  target_id: string;
  target_label: string | null;
  status: "ok" | "failed";
  error: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface ActionsResp {
  actions: AdminAction[];
  totals: { ok: number; failed: number };
  byKind: Array<{ target_kind: string; count: number }>;
}

type Tab = "general" | "integrations" | "audit";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-brand-blue-500" : "bg-red-400"}`} />
  );
}

function IntegrationRow({
  name,
  configured,
  badges,
  description,
}: {
  name: string;
  configured: boolean;
  badges?: Array<{ label: string; tone?: "neutral" | "warn" | "info" }>;
  description: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-4 border-b border-ops-border last:border-0">
      <div className="pt-1"><StatusDot ok={configured} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-ops-text">{name}</span>
          {badges?.map((b, i) => (
            <span
              key={i}
              className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                b.tone === "warn"
                  ? "bg-amber-500/10 text-amber-500 border border-amber-500/30"
                  : b.tone === "info"
                    ? "bg-brand-blue-50 text-brand-blue-500 border border-brand-blue-200/60 dark:bg-brand-blue-500/10 dark:border-brand-blue-400/30"
                    : "bg-ops-bg text-ops-text-muted border border-ops-border"
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
        <div className="text-xs text-ops-text-muted mt-1">{description}</div>
      </div>
      <div className="text-xs text-ops-text-muted">{configured ? "Configured" : "Not configured"}</div>
    </div>
  );
}

async function logout() {
  await fetch("/api/ops/auth/logout", { method: "POST" });
  window.location.href = "/";
}

function formatActionType(t: string): string {
  return t.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatTargetKind(k: string): string {
  return k.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>("general");
  const { data, isLoading, isError } = useQuery<SettingsData>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
  });

  const { data: connections } = useQuery<{
    google: { connected: boolean; email?: string; ga4PropertyId?: string; gscSiteUrl?: string };
  }>({
    queryKey: ["ops-connections"],
    queryFn: () => fetch("/api/ops/connections").then((r) => r.json()),
  });

  if (isLoading) return <div className="text-sm text-ops-text-muted">Loading settings…</div>;
  if (isError || !data) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
        Failed to load settings.
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "General" },
    { key: "integrations", label: "Integrations" },
    { key: "audit", label: "Admin Log" },
  ];

  return (
    <div className="max-w-5xl">
      <PageHero
        eyebrow="System"
        title="Settings"
        subtitle="Session, integrations, environment, and the audit trail of every admin action."
      />

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-ops-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? "border-brand-blue-500 text-brand-blue-500"
                : "border-transparent text-ops-text-muted hover:text-ops-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && <GeneralTab data={data} />}
      {tab === "integrations" && <IntegrationsTab data={data} connections={connections} />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

function GeneralTab({ data }: { data: SettingsData }) {
  return (
    <>
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-5">
        <h3 className="text-sm font-semibold text-ops-text mb-4">Session</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <div className="text-[10px] text-ops-text-muted uppercase tracking-wider">Signed in as</div>
            <div className="text-sm text-ops-text font-medium mt-1">{data.session.email || "—"}</div>
          </div>
          <div>
            <div className="text-[10px] text-ops-text-muted uppercase tracking-wider">Session TTL</div>
            <div className="text-sm text-ops-text mt-1">{data.session.ttlDays} days</div>
          </div>
          <div className="flex items-end">
            <button
              onClick={logout}
              className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-5">
        <h3 className="text-sm font-semibold text-ops-text mb-1">Admin allowlist</h3>
        <p className="text-xs text-ops-text-muted mb-3">
          From the <code className="bg-ops-bg px-1 py-0.5 rounded">ADMIN_EMAILS</code> env var. Add another admin by appending to this list and redeploying.
        </p>
        {data.adminEmails.length === 0 ? (
          <div className="text-sm text-red-400">No admins configured. Anyone with a session cookie could be denied — fix this immediately.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.adminEmails.map((e) => (
              <span
                key={e}
                className={`text-xs font-mono px-2 py-1 rounded ${
                  e === data.session.email
                    ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30"
                    : "bg-ops-bg text-ops-text-muted border border-ops-border"
                }`}
              >
                {e}{e === data.session.email && " (you)"}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Auth</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ops-text-muted">Session secret</span>
              <span className="flex items-center gap-2">
                <StatusDot ok={data.auth.sessionSecretConfigured} />
                <span className="text-ops-text">{data.auth.sessionSecretConfigured ? "set" : "missing"}</span>
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-ops-text-muted shrink-0">Redirect URI</span>
              <span className="text-ops-text text-xs font-mono text-right break-all">{data.auth.adminRedirectUri || "—"}</span>
            </div>
          </div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Environment</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ops-text-muted">NODE_ENV</span>
              <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                data.env.nodeEnv === "production"
                  ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30"
                  : "bg-amber-500/10 text-amber-500 border border-amber-500/30"
              }`}>{data.env.nodeEnv}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ops-text-muted">Port</span>
              <span className="text-ops-text font-mono">{data.env.port}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function IntegrationsTab({
  data,
  connections,
}: {
  data: SettingsData;
  connections: { google: { connected: boolean; email?: string; ga4PropertyId?: string; gscSiteUrl?: string } } | undefined;
}) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <h3 className="text-sm font-semibold text-ops-text mb-1">Integration status</h3>
      <p className="text-xs text-ops-text-muted mb-1">
        Status derived from env vars at process start. Full connect/disconnect controls live in{" "}
        <Link href="/integrations" className="text-brand-blue-500 hover:underline">Integrations →</Link>
      </p>
      <div>
        <IntegrationRow name="RDS PostgreSQL" configured={data.integrations.database.configured} description={data.integrations.database.label} />
        <IntegrationRow
          name="AI"
          configured={data.integrations.ai.configured}
          badges={[
            { label: data.integrations.ai.provider },
            ...(data.integrations.ai.region ? [{ label: data.integrations.ai.region, tone: "info" as const }] : []),
          ]}
          description={data.integrations.ai.label}
        />
        <IntegrationRow
          name="Stripe"
          configured={data.integrations.stripe.configured}
          badges={data.integrations.stripe.configured ? [
            { label: data.integrations.stripe.keyMode, tone: data.integrations.stripe.keyMode === "live" ? ("warn" as const) : ("info" as const) },
            { label: data.integrations.stripe.keyTail },
          ] : []}
          description={data.integrations.stripe.label}
        />
        <IntegrationRow
          name="Klaviyo"
          configured={data.integrations.klaviyo.configured}
          badges={data.integrations.klaviyo.configured ? [
            { label: data.integrations.klaviyo.keyTail },
            ...(data.integrations.klaviyo.conversionMetricOverride
              ? [{ label: `Conv: ${data.integrations.klaviyo.conversionMetricOverride}`, tone: "info" as const }]
              : []),
          ] : []}
          description={data.integrations.klaviyo.label}
        />
        <IntegrationRow
          name="Google OAuth"
          configured={data.integrations.googleOAuth.configured && !!connections?.google?.connected}
          badges={(() => {
            if (!data.integrations.googleOAuth.configured) return [];
            const out: Array<{ label: string; tone?: "neutral" | "warn" | "info" }> = [{ label: data.integrations.googleOAuth.clientIdTail }];
            if (connections?.google?.connected) {
              if (connections.google.ga4PropertyId) out.push({ label: "GA4 selected", tone: "info" });
              if (connections.google.gscSiteUrl) out.push({ label: "GSC selected", tone: "info" });
              if (!connections.google.ga4PropertyId || !connections.google.gscSiteUrl)
                out.push({ label: "Property pending", tone: "warn" });
            } else {
              out.push({ label: "Not connected", tone: "warn" });
            }
            return out;
          })()}
          description={
            <>
              {data.integrations.googleOAuth.label}.{" "}
              {data.integrations.googleOAuth.configured && !connections?.google?.connected && (
                <Link href="/integrations" className="text-brand-blue-500 hover:underline">Connect now →</Link>
              )}
            </>
          }
        />
        <IntegrationRow
          name="Meta Ads"
          configured={data.integrations.metaAds.configured}
          badges={data.integrations.metaAds.configured ? [
            { label: data.integrations.metaAds.apiVersion, tone: "info" as const },
            { label: `act_${data.integrations.metaAds.adAccountId}` },
            { label: data.integrations.metaAds.tokenTail },
          ] : []}
          description={data.integrations.metaAds.label}
        />
        <IntegrationRow
          name="Clomark"
          configured={data.integrations.clomark.configured && data.integrations.clomark.businessIdConfigured}
          badges={(() => {
            if (!data.integrations.clomark.configured) return [];
            const out: Array<{ label: string; tone?: "neutral" | "warn" | "info" }> = [{ label: data.integrations.clomark.tokenTail }];
            if (data.integrations.clomark.businessIdConfigured) {
              out.push({ label: data.integrations.clomark.businessIdTail, tone: "info" as const });
            } else {
              out.push({ label: "Business ID pending", tone: "warn" as const });
            }
            return out;
          })()}
          description={data.integrations.clomark.label}
        />
      </div>
    </div>
  );
}

function AuditTab() {
  const [kindFilter, setKindFilter] = useState<string>("");
  const [adminFilter, setAdminFilter] = useState<string>("");

  const params = new URLSearchParams({ limit: "100" });
  if (kindFilter) params.set("target_kind", kindFilter);
  if (adminFilter) params.set("admin_email", adminFilter);

  const { data, isLoading } = useQuery<ActionsResp>({
    queryKey: ["ops-admin-actions", kindFilter, adminFilter],
    queryFn: () => fetch(`/api/ops/admin-actions?${params.toString()}`).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const actions = data?.actions || [];
  const totals = data?.totals;
  const byKind = data?.byKind || [];
  const uniqueAdmins = Array.from(new Set(actions.map((a) => a.admin_email)));

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-[10px] text-ops-text-muted uppercase tracking-wider mb-2">Total</div>
          <div className="text-2xl font-bold text-ops-text">{actions.length.toLocaleString()}</div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-[10px] text-ops-text-muted uppercase tracking-wider mb-2">Successful</div>
          <div className="text-2xl font-bold text-brand-blue-500">{totals?.ok ?? 0}</div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-[10px] text-ops-text-muted uppercase tracking-wider mb-2">Failed</div>
          <div className={`text-2xl font-bold ${(totals?.failed ?? 0) > 0 ? "text-red-400" : "text-ops-text-muted"}`}>{totals?.failed ?? 0}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-5">
        <div>
          <label className="block text-[10px] text-ops-text-muted uppercase tracking-wider mb-1">Target kind</label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
          >
            <option value="">All</option>
            {byKind.map((b) => (
              <option key={b.target_kind} value={b.target_kind}>
                {formatTargetKind(b.target_kind)} ({b.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-ops-text-muted uppercase tracking-wider mb-1">Admin</label>
          <select
            value={adminFilter}
            onChange={(e) => setAdminFilter(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
          >
            <option value="">All</option>
            {uniqueAdmins.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        {(kindFilter || adminFilter) && (
          <div className="flex items-end">
            <button
              onClick={() => { setKindFilter(""); setAdminFilter(""); }}
              className="px-3 py-1.5 text-xs text-ops-text-muted hover:text-ops-text"
            >Clear filters</button>
          </div>
        )}
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="w-6 h-6 border-2 border-brand-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        ) : actions.length === 0 ? (
          <div className="p-8 text-center text-sm text-ops-text-muted">
            No admin actions yet. Pause/Activate a flow on{" "}
            <Link href="/email" className="text-brand-blue-500 hover:underline">Email</Link>{" "}to write the first row.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
              <tr>
                <th className="text-left px-5 py-3 font-medium">When</th>
                <th className="text-left px-5 py-3 font-medium">Admin</th>
                <th className="text-left px-5 py-3 font-medium">Action</th>
                <th className="text-left px-5 py-3 font-medium">Target</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border">
              {actions.map((a) => (
                <tr key={a.id} className="hover:bg-ops-surface-hover">
                  <td className="px-5 py-3 text-ops-text-muted text-xs">
                    <div>{timeAgo(a.created_at)}</div>
                    <div className="text-[10px] opacity-60">{new Date(a.created_at).toLocaleString()}</div>
                  </td>
                  <td className="px-5 py-3 text-ops-text text-xs">{a.admin_email}</td>
                  <td className="px-5 py-3 text-ops-text font-medium">{formatActionType(a.action_type)}</td>
                  <td className="px-5 py-3">
                    <div className="text-sm text-ops-text">
                      {a.target_label || <span className="text-ops-text-muted italic">unnamed</span>}
                    </div>
                    <div className="text-[10px] text-ops-text-muted font-mono">
                      {formatTargetKind(a.target_kind)} · {a.target_id}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    {a.status === "ok" ? (
                      <span className="text-xs font-medium text-brand-blue-500">OK</span>
                    ) : (
                      <div>
                        <span className="text-xs font-medium text-red-400">Failed</span>
                        {a.error && (
                          <div className="text-[10px] text-red-300/70 max-w-[200px] truncate" title={a.error}>
                            {a.error}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
