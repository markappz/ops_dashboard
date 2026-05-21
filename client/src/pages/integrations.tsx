import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type React from "react";
import { useEffect, useState } from "react";
import { PageHero } from "../components/page-hero";
import { IntegrationEditModal } from "../components/integration-edit-modal";

interface ConnectionsData {
  googleConfigured: boolean;
  google: {
    connected: boolean;
    email?: string;
    ga4PropertyId?: string;
    gscSiteUrl?: string;
    connectedAt?: string;
  };
}

interface GA4Property {
  propertyId: string;
  displayName: string;
  account: string;
}

interface GSCSite {
  url: string;
  permission: string;
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [location] = useLocation();
  const [toast, setToast] = useState<string | null>(null);

  // Show toast on successful connection
  useEffect(() => {
    if (location.includes("google_connected=true")) {
      setToast("Google account connected successfully");
      queryClient.invalidateQueries({ queryKey: ["ops-connections"] });
      queryClient.invalidateQueries({ queryKey: ["ops-ga4-properties"] });
      queryClient.invalidateQueries({ queryKey: ["ops-gsc-sites"] });
      setTimeout(() => setToast(null), 4000);
    }
    if (location.includes("google_error")) {
      setToast("Google connection failed — try again");
      setTimeout(() => setToast(null), 4000);
    }
  }, [location]);

  const { data } = useQuery<ConnectionsData>({
    queryKey: ["ops-connections"],
    queryFn: () => fetch("/api/ops/connections").then((r) => r.json()),
  });

  const { data: ga4Props } = useQuery<{ properties: GA4Property[] }>({
    queryKey: ["ops-ga4-properties"],
    queryFn: () => fetch("/api/ops/ga4/properties").then((r) => r.json()),
    enabled: !!data?.google?.connected,
  });

  const { data: gscSites } = useQuery<{ sites: GSCSite[] }>({
    queryKey: ["ops-gsc-sites"],
    queryFn: () => fetch("/api/ops/gsc/sites").then((r) => r.json()),
    enabled: !!data?.google?.connected,
  });

  const { data: klaviyo } = useQuery<{
    configured: boolean;
    connected: boolean;
    organization?: string | null;
    defaultSenderEmail?: string | null;
    error?: string;
  }>({
    queryKey: ["klaviyo-status"],
    queryFn: () => fetch("/api/ops/klaviyo/status").then((r) => r.json()),
  });

  const handleDisconnect = async () => {
    if (!confirm("Disconnect Google account?")) return;
    await fetch("/api/ops/google/disconnect", { method: "POST" });
    queryClient.invalidateQueries({ queryKey: ["ops-connections"] });
    setToast("Google disconnected");
    setTimeout(() => setToast(null), 3000);
  };

  const handleSaveProperty = async (ga4PropertyId?: string, gscSiteUrl?: string) => {
    await fetch("/api/ops/google/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ga4PropertyId, gscSiteUrl }),
    });
    queryClient.invalidateQueries({ queryKey: ["ops-connections"] });
    setToast("Saved");
    setTimeout(() => setToast(null), 2000);
  };

  const google = data?.google;
  const configured = data?.googleConfigured;

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div className="fixed top-20 right-8 px-4 py-3 rounded-lg text-sm font-medium z-50 shadow-lg bg-fitscript-green text-white">
          {toast}
        </div>
      )}

      <PageHero
        eyebrow="System"
        title="Integrations"
        subtitle="Connect external services to fuel your dashboard with live data."
      />

      {/* Google Account */}
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card mb-6">
        <div className="px-6 py-4 border-b border-ops-border flex items-center gap-3">
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          <h2 className="text-lg font-semibold text-ops-text">Google Account</h2>
        </div>
        <div className="px-6 py-5">
          {google?.connected ? (
            <div className="space-y-5">
              {/* Connected status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-green-400" />
                  <div>
                    <div className="text-sm font-medium text-ops-text">Connected</div>
                    {google.email && <div className="text-xs text-ops-text-muted">{google.email}</div>}
                  </div>
                </div>
                <button onClick={handleDisconnect}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20">
                  Disconnect
                </button>
              </div>

              {/* GA4 Property Selector */}
              <div>
                <label className="text-sm font-medium text-ops-text mb-2 block">Google Analytics 4 Property</label>
                <p className="text-xs text-ops-text-muted mb-2">Select the GA4 property to pull analytics data from</p>
                <select
                  value={google.ga4PropertyId || ""}
                  onChange={(e) => handleSaveProperty(e.target.value, undefined)}
                  className="bg-ops-bg border border-ops-border rounded-lg px-4 py-2.5 text-sm text-ops-text w-full focus:outline-none focus:border-fitscript-green"
                >
                  <option value="">Select a property...</option>
                  {ga4Props?.properties.map((p) => (
                    <option key={p.propertyId} value={p.propertyId}>
                      {p.displayName} ({p.account}) — {p.propertyId}
                    </option>
                  ))}
                </select>
              </div>

              {/* GSC Site Selector */}
              <div>
                <label className="text-sm font-medium text-ops-text mb-2 block">Google Search Console Site</label>
                <p className="text-xs text-ops-text-muted mb-2">Select the site to pull search performance data from</p>
                <select
                  value={google.gscSiteUrl || ""}
                  onChange={(e) => handleSaveProperty(undefined, e.target.value)}
                  className="bg-ops-bg border border-ops-border rounded-lg px-4 py-2.5 text-sm text-ops-text w-full focus:outline-none focus:border-fitscript-green"
                >
                  <option value="">Select a site...</option>
                  {gscSites?.sites.map((s) => (
                    <option key={s.url} value={s.url}>
                      {s.url} ({s.permission})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm text-ops-text-muted mb-4">
                Connect your Google account to pull real search performance and analytics data into the dashboard.
              </p>
              {configured ? (
                <a href="/api/ops/google/connect"
                  className="inline-flex items-center gap-2 px-5 py-3 text-sm rounded-lg bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 transition-colors shadow-sm font-medium">
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                  Connect with Google
                </a>
              ) : (
                <div className="bg-ops-bg rounded-lg p-4">
                  <p className="text-sm text-yellow-400 font-medium mb-2">Google credentials not configured</p>
                  <p className="text-xs text-ops-text-muted mb-2">Add these to your .env file:</p>
                  <code className="block bg-ops-surface px-3 py-2 rounded text-xs font-mono text-ops-text-muted">
                    GOOGLE_CLIENT_ID=your_client_id<br />
                    GOOGLE_CLIENT_SECRET=your_client_secret<br />
                    OPS_GOOGLE_REDIRECT_URI=http://localhost:5001/api/ops/google/callback
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Managed integrations — 2-up grid on tablet+, stacked on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5 mb-6">
        {/* Stripe — read-only card (no Edit yet) */}
        <ReadOnlyCard
          title="Stripe"
          status={{ kind: "ok", text: "Connected", detail: "Via STRIPE_SECRET_KEY · subscriptions, payments, MRR" }}
          note="Self-serve key swap deferred — too risky for a quick paste."
        />

        {/* Klaviyo */}
        <ManagedIntegrationCard
          title="Klaviyo"
          integration="klaviyo"
          status={
            !klaviyo?.configured
              ? { kind: "off", text: "Not connected", detail: "Add a private API key to surface campaigns, flows, and lists." }
              : klaviyo.connected
                ? { kind: "ok", text: klaviyo.organization ? `Connected — ${klaviyo.organization}` : "Connected", detail: klaviyo.defaultSenderEmail ? `Default sender: ${klaviyo.defaultSenderEmail}` : "Campaigns, flows, lists, segments" }
                : { kind: "error", text: "Connection error", detail: klaviyo.error || "API key was rejected" }
          }
          onUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ["klaviyo-status"] });
            queryClient.invalidateQueries({ queryKey: ["ops-settings"] });
          }}
        />

        <SlackManagedCard />
        <MetaAdsManagedCard />
        <ClomarkManagedCard />

        {/* Coming Soon */}
        {[
          { name: "Google Ads", desc: "Search ad spend, conversions, ROAS" },
          { name: "TikTok Ads", desc: "TikTok ad spend, conversions" },
        ].map((s) => (
          <div key={s.name} className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-semibold text-ops-text">{s.name}</h2>
              <span className="text-[10px] tracking-wider uppercase text-ops-text-subtle font-semibold px-1.5 py-0.5 rounded bg-ops-bg border border-ops-border">Soon</span>
            </div>
            <p className="text-xs text-ops-text-muted">{s.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Self-serve managed integration card ────────────────────────────

interface ManagedStatus {
  kind: "ok" | "off" | "error";
  text: string;
  detail?: string;
}

function ManagedIntegrationCard({
  title,
  integration,
  status,
  onUpdated,
  extraActions,
  extraStatus,
}: {
  title: string;
  integration: "klaviyo" | "slack" | "meta-ads" | "clomark";
  status: ManagedStatus;
  onUpdated: () => void;
  extraActions?: React.ReactNode;
  extraStatus?: string | null;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setTestRes(null);
    try {
      const r = await fetch(`/api/ops/integrations/${integration}/test`, { method: "POST" });
      const j = await r.json().catch(() => ({ ok: false, error: "bad response" }));
      setTestRes(j);
    } catch (e: any) {
      setTestRes({ ok: false, error: e.message });
    } finally {
      setTesting(false);
      setTimeout(() => setTestRes(null), 6000);
    }
  };

  const dotColor =
    status.kind === "ok" ? "bg-brand-blue-500" : status.kind === "error" ? "bg-red-400" : "bg-ops-text-muted/40";

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />
          <h2 className="text-sm font-semibold text-ops-text truncate">{title}</h2>
        </div>
        <div className="flex gap-1.5 shrink-0 flex-wrap">
          {extraActions}
          <button
            onClick={test}
            disabled={testing}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors ${
              testRes?.ok
                ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30"
                : testRes && !testRes.ok
                  ? "bg-red-500/10 text-red-400 border border-red-500/30"
                  : "bg-ops-bg text-ops-text-muted border border-ops-border hover:text-ops-text hover:border-brand-blue-400/40"
            }`}
          >
            {testing ? "…" : testRes?.ok ? "✓ OK" : testRes && !testRes.ok ? "Failed" : "Test"}
          </button>
          <button
            onClick={() => setEditOpen(true)}
            className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white hover:opacity-95 shadow-[0_2px_8px_-2px_rgba(46,91,255,0.4)]"
          >
            Edit
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-1.5">
        <div className="text-sm font-medium text-ops-text">{status.text}</div>
        {status.detail && <div className="text-xs text-ops-text-muted break-words leading-snug">{status.detail}</div>}
        {testRes && (
          <div
            className={`text-[11px] rounded-lg border px-2 py-1.5 mt-2 ${
              testRes.ok
                ? "bg-brand-blue-500/5 border-brand-blue-400/20 text-brand-blue-500"
                : "bg-red-500/5 border-red-500/20 text-red-400"
            }`}
          >
            {testRes.ok ? testRes.detail : testRes.error}
          </div>
        )}
        {extraStatus && (
          <div className="text-[11px] rounded-lg border px-2 py-1.5 mt-2 bg-ops-bg border-ops-border text-ops-text-muted">
            {extraStatus}
          </div>
        )}
      </div>
      {editOpen && (
        <IntegrationEditModal
          integration={integration}
          title={title}
          onClose={() => setEditOpen(false)}
          onSaved={onUpdated}
        />
      )}
    </div>
  );
}

function ReadOnlyCard({
  title,
  status,
  note,
}: {
  title: string;
  status: ManagedStatus;
  note?: string;
}) {
  const dotColor =
    status.kind === "ok" ? "bg-brand-blue-500" : status.kind === "error" ? "bg-red-400" : "bg-ops-text-muted/40";
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 flex flex-col">
      <div className="flex items-center gap-2.5 mb-3">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />
        <h2 className="text-sm font-semibold text-ops-text truncate">{title}</h2>
      </div>
      <div className="text-sm font-medium text-ops-text">{status.text}</div>
      {status.detail && <div className="text-xs text-ops-text-muted mt-1 leading-snug">{status.detail}</div>}
      {note && <div className="text-[10.5px] text-ops-text-subtle mt-2 italic">{note}</div>}
    </div>
  );
}

function SlackManagedCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ integrations: { slack: { configured: boolean; webhookTail: string; label: string } } }>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
  });
  const slack = data?.integrations.slack;
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  const sendDigest = async () => {
    setSending(true);
    setSentMsg(null);
    try {
      const r = await fetch("/api/ops/dirt/daily-report", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      setSentMsg(j.posted ? "✓ Digest posted to Slack" : `Failed: ${j.error || "unknown"}`);
    } catch (e: any) {
      setSentMsg(`Failed: ${e.message}`);
    } finally {
      setSending(false);
      setTimeout(() => setSentMsg(null), 6000);
    }
  };

  return (
    <ManagedIntegrationCard
      title="Slack alerts"
      integration="slack"
      status={
        slack?.configured
          ? { kind: "ok", text: "Connected", detail: `Webhook ${slack.webhookTail} · 15-min scan alerts + daily 8am digest` }
          : { kind: "off", text: "Not configured", detail: "Add an incoming webhook URL to receive DIRT alerts outside the dashboard." }
      }
      onUpdated={() => queryClient.invalidateQueries({ queryKey: ["ops-settings"] })}
      extraActions={
        slack?.configured ? (
          <button
            onClick={sendDigest}
            disabled={sending}
            className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-ops-bg border border-ops-border text-ops-text-muted hover:text-ops-text hover:border-brand-blue-400/40 transition-colors disabled:opacity-50"
            title="Fire today's digest now"
          >
            {sending ? "…" : "Send digest"}
          </button>
        ) : null
      }
      extraStatus={sentMsg}
    />
  );
}

function MetaAdsManagedCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ integrations: { metaAds: { configured: boolean; adAccountId: string | null; tokenTail: string; apiVersion: string } } }>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
  });
  const meta = data?.integrations.metaAds;
  return (
    <ManagedIntegrationCard
      title="Meta Ads"
      integration="meta-ads"
      status={
        meta?.configured
          ? { kind: "ok", text: "Configured", detail: `act_${meta.adAccountId} · token ${meta.tokenTail} · ${meta.apiVersion}` }
          : { kind: "off", text: "Not configured", detail: "Connect Facebook + Instagram ad spend, ROAS, conversions." }
      }
      onUpdated={() => queryClient.invalidateQueries({ queryKey: ["ops-settings"] })}
    />
  );
}

function ClomarkManagedCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ integrations: { clomark: { configured: boolean; businessIdConfigured: boolean; baseUrl: string | null; tokenTail: string; businessIdTail: string } } }>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
  });
  const c = data?.integrations.clomark;
  const fullyConfigured = !!(c?.configured && c?.businessIdConfigured);
  return (
    <ManagedIntegrationCard
      title="Clomark — Content pipeline"
      integration="clomark"
      status={
        fullyConfigured
          ? { kind: "ok", text: "Configured", detail: `${c!.baseUrl} · business ${c!.businessIdTail} · token ${c!.tokenTail}` }
          : { kind: "off", text: c?.configured ? "Business ID pending" : "Not configured", detail: "Powers /content (keyword research, AI drafts, bulk publish)." }
      }
      onUpdated={() => queryClient.invalidateQueries({ queryKey: ["ops-settings"] })}
    />
  );
}
