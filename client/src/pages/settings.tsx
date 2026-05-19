import { useQuery } from "@tanstack/react-query";

interface SettingsData {
  session: { email: string | null; ttlDays: number };
  adminEmails: string[];
  integrations: {
    database: { configured: boolean; label: string };
    ai: {
      configured: boolean;
      provider: string;
      region: string | null;
      label: string;
    };
    stripe: {
      configured: boolean;
      keyMode: string;
      keyTail: string;
      label: string;
    };
    klaviyo: {
      configured: boolean;
      keyTail: string;
      conversionMetricOverride: string | null;
      label: string;
    };
    googleOAuth: {
      configured: boolean;
      clientIdTail: string;
      label: string;
    };
    metaAds: {
      configured: boolean;
      adAccountId: string | null;
      tokenTail: string;
      apiVersion: string;
      label: string;
    };
  };
  auth: {
    sessionSecretConfigured: boolean;
    adminRedirectUri: string | null;
  };
  env: { nodeEnv: string; port: string };
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        ok ? "bg-fitscript-green" : "bg-red-400"
      }`}
    />
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
  description: string;
}) {
  return (
    <div className="flex items-start gap-4 py-4 border-b border-ops-border last:border-0">
      <div className="pt-1">
        <StatusDot ok={configured} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-ops-text">{name}</span>
          {badges?.map((b, i) => (
            <span
              key={i}
              className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                b.tone === "warn"
                  ? "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                  : b.tone === "info"
                    ? "bg-blue-500/10 text-blue-300 border border-blue-500/30"
                    : "bg-ops-bg text-ops-text-muted border border-ops-border"
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
        <div className="text-xs text-ops-text-muted mt-1">{description}</div>
      </div>
      <div className="text-xs text-ops-text-muted">
        {configured ? "Configured" : "Not configured"}
      </div>
    </div>
  );
}

async function logout() {
  await fetch("/api/ops/auth/logout", { method: "POST" });
  window.location.href = "/";
}

export default function Settings() {
  const { data, isLoading, isError } = useQuery<SettingsData>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
  });

  if (isLoading) {
    return <div className="text-sm text-ops-text-muted">Loading settings…</div>;
  }

  if (isError || !data) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
        Failed to load settings.
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Settings</h1>
        <p className="text-sm text-ops-text-muted mt-1">
          Session, integrations, and environment for this ops dashboard instance.
        </p>
      </div>

      {/* Session */}
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-5">
        <h3 className="text-sm font-semibold text-ops-text mb-4">Session</h3>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <div className="text-xs text-ops-text-muted uppercase tracking-wider">Signed in as</div>
            <div className="text-sm text-ops-text font-medium mt-1">
              {data.session.email || "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-ops-text-muted uppercase tracking-wider">Session TTL</div>
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

      {/* Admin allowlist */}
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
                    ? "bg-fitscript-green/10 text-fitscript-green border border-fitscript-green/30"
                    : "bg-ops-bg text-ops-text-muted border border-ops-border"
                }`}
              >
                {e}
                {e === data.session.email && " (you)"}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Integrations */}
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-5">
        <h3 className="text-sm font-semibold text-ops-text mb-1">Integrations</h3>
        <p className="text-xs text-ops-text-muted mb-1">
          Status derived from env vars at process start. Restart the dashboard after changing any value.
        </p>
        <div>
          <IntegrationRow
            name="RDS PostgreSQL"
            configured={data.integrations.database.configured}
            description={data.integrations.database.label}
          />
          <IntegrationRow
            name="AI"
            configured={data.integrations.ai.configured}
            badges={[
              { label: data.integrations.ai.provider },
              ...(data.integrations.ai.region
                ? [{ label: data.integrations.ai.region, tone: "info" as const }]
                : []),
            ]}
            description={data.integrations.ai.label}
          />
          <IntegrationRow
            name="Stripe"
            configured={data.integrations.stripe.configured}
            badges={
              data.integrations.stripe.configured
                ? [
                    {
                      label: data.integrations.stripe.keyMode,
                      tone:
                        data.integrations.stripe.keyMode === "live"
                          ? ("warn" as const)
                          : ("info" as const),
                    },
                    { label: data.integrations.stripe.keyTail },
                  ]
                : []
            }
            description={data.integrations.stripe.label}
          />
          <IntegrationRow
            name="Klaviyo"
            configured={data.integrations.klaviyo.configured}
            badges={
              data.integrations.klaviyo.configured
                ? [
                    { label: data.integrations.klaviyo.keyTail },
                    ...(data.integrations.klaviyo.conversionMetricOverride
                      ? [
                          {
                            label: `Conv: ${data.integrations.klaviyo.conversionMetricOverride}`,
                            tone: "info" as const,
                          },
                        ]
                      : []),
                  ]
                : []
            }
            description={data.integrations.klaviyo.label}
          />
          <IntegrationRow
            name="Google OAuth"
            configured={data.integrations.googleOAuth.configured}
            badges={
              data.integrations.googleOAuth.configured
                ? [{ label: data.integrations.googleOAuth.clientIdTail }]
                : []
            }
            description={data.integrations.googleOAuth.label}
          />
          <IntegrationRow
            name="Meta Ads"
            configured={data.integrations.metaAds.configured}
            badges={
              data.integrations.metaAds.configured
                ? [
                    { label: data.integrations.metaAds.apiVersion, tone: "info" as const },
                    {
                      label: `act_${data.integrations.metaAds.adAccountId}`,
                    },
                    { label: data.integrations.metaAds.tokenTail },
                  ]
                : []
            }
            description={data.integrations.metaAds.label}
          />
        </div>
      </div>

      {/* Auth + Env */}
      <div className="grid grid-cols-2 gap-5">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Auth</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ops-text-muted">Session secret</span>
              <span className="flex items-center gap-2">
                <StatusDot ok={data.auth.sessionSecretConfigured} />
                <span className="text-ops-text">
                  {data.auth.sessionSecretConfigured ? "set" : "missing"}
                </span>
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-ops-text-muted shrink-0">Redirect URI</span>
              <span className="text-ops-text text-xs font-mono text-right break-all">
                {data.auth.adminRedirectUri || "—"}
              </span>
            </div>
          </div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Environment</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ops-text-muted">NODE_ENV</span>
              <span
                className={`text-xs font-mono px-2 py-0.5 rounded ${
                  data.env.nodeEnv === "production"
                    ? "bg-fitscript-green/10 text-fitscript-green border border-fitscript-green/30"
                    : "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                }`}
              >
                {data.env.nodeEnv}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ops-text-muted">Port</span>
              <span className="text-ops-text font-mono">{data.env.port}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
