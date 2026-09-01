import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryError, hasApiError } from "../components/query-error";
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
    slack: { configured: boolean; webhookTail: string; label: string };
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

type Tab = "general" | "admins" | "audit";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-brand-blue-500" : "bg-red-400"}`} />
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
  const { data, isLoading, isError, error, refetch } = useQuery<SettingsData>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
  });

  if (isLoading) return <div className="text-sm text-ops-text-muted">Loading settings…</div>;
  if (isError || !data || hasApiError(data)) {
    return <QueryError context="Settings" data={data} error={error as Error | null} onRetry={() => refetch()} />;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "General" },
    { key: "admins", label: "Team" },
    { key: "audit", label: "Admin Log" },
  ];

  return (
    <div className="max-w-5xl">
      <PageHero
        eyebrow="System"
        title="Settings"
        subtitle="Session, admin allowlist, environment, and the audit trail of every admin action."
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
      {tab === "admins" && <AdminsTab currentAdminEmail={data?.session?.email ?? ""} />}
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
        <p className="text-xs text-ops-text-muted">
          {data.adminEmails.length} admin{data.adminEmails.length === 1 ? "" : "s"} currently configured. Manage them in the <span className="text-brand-blue-500 font-semibold">Team</span> tab — add or remove without touching env vars or redeploying.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Auth</h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ops-text-muted shrink-0">Session secret</span>
              <span className="flex items-center gap-2">
                <StatusDot ok={data.auth.sessionSecretConfigured} />
                <span className="text-ops-text">{data.auth.sessionSecretConfigured ? "set" : "missing"}</span>
              </span>
            </div>
            <div>
              <div className="text-ops-text-muted mb-1">Redirect URI</div>
              <div className="text-ops-text text-[11px] font-mono break-all bg-ops-bg border border-ops-border rounded-lg px-2.5 py-1.5">
                {data.auth.adminRedirectUri || "—"}
              </div>
            </div>
          </div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Environment</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ops-text-muted shrink-0">NODE_ENV</span>
              <span className={`text-xs font-mono px-2 py-0.5 rounded shrink-0 ${
                data.env.nodeEnv === "production"
                  ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30"
                  : "bg-amber-500/10 text-amber-500 border border-amber-500/30"
              }`}>{data.env.nodeEnv}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ops-text-muted shrink-0">Port</span>
              <span className="text-ops-text font-mono">{data.env.port}</span>
            </div>
          </div>
        </div>
      </div>
    </>
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

      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-x-auto">
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
          <table className="w-full min-w-[720px] text-sm">
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

const ROLE_CHIP: Record<string, string> = {
  admin: "bg-brand-blue-500/15 text-brand-blue-400",
  viewer: "bg-ops-border text-ops-text-muted",
};

function PermissionPicker({ catalog, value, onChange }: {
  catalog: PermissionInfo[]; value: string[]; onChange: (v: string[]) => void;
}) {
  if (!catalog.length) return null;
  return (
    <div className="space-y-1.5">
      {catalog.map((perm) => {
        const on = value.includes(perm.key);
        return (
          <label key={perm.key} className="flex cursor-pointer items-start gap-2" title={perm.detail}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? value.filter((k) => k !== perm.key) : [...value, perm.key])}
              className="mt-0.5 accent-brand-blue-500"
            />
            <span className="text-xs text-ops-text">{perm.label}
              <span className="block text-[10px] text-ops-text-muted">{perm.detail}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function MemberRow({ member, role, isMe, lastMember, catalog, editing, onEdit, onSave, onRemove }: {
  member: AdminRow; role: "admin" | "viewer"; isMe: boolean; lastMember: boolean;
  catalog: PermissionInfo[]; editing: boolean;
  onEdit: () => void; onSave: (patch: { role?: "admin" | "viewer"; permissions?: string[] }) => void; onRemove: () => void;
}) {
  const [draftRole, setDraftRole] = useState<"admin" | "viewer">(role);
  const [draftPerms, setDraftPerms] = useState<string[]>(member.permissions ?? []);
  const labelFor = (key: string) => catalog.find((c) => c.key === key)?.label ?? key;

  return (
    <>
      <tr className="border-b border-ops-border last:border-b-0">
        <td className="px-4 py-3 text-ops-text">
          {member.email}
          {isMe && <span className="ml-2 text-[10px] font-semibold text-brand-blue-400">(you)</span>}
        </td>
        <td className="px-4 py-3">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ROLE_CHIP[role]}`}>{role}</span>
          {role === "viewer" && (member.permissions ?? []).map((perm) => (
            <span key={perm} className="ml-1.5 rounded-full bg-brand-blue-500/10 px-2 py-0.5 text-[10px] text-brand-blue-400" title={labelFor(perm)}>
              +{perm}
            </span>
          ))}
        </td>
        <td className="px-4 py-3 text-ops-text-muted text-xs">{member.added_by ?? "—"}</td>
        <td className="px-4 py-3 text-ops-text-muted text-xs">{timeAgo(member.added_at)}</td>
        <td className="px-4 py-3 text-ops-text-muted text-xs">{member.note ?? "—"}</td>
        <td className="px-4 py-3 text-right whitespace-nowrap">
          <button onClick={onEdit} className="text-[11px] font-semibold text-brand-blue-400 hover:text-brand-blue-300">
            {editing ? "Close" : "Edit"}
          </button>
          {isMe ? (
            <span className="ml-3 text-[11px] text-ops-text-subtle italic">self</span>
          ) : lastMember ? (
            <span className="ml-3 text-[11px] text-ops-text-subtle italic">only admin</span>
          ) : (
            <button onClick={onRemove} className="ml-3 text-[11px] font-semibold text-red-400 hover:text-red-300">
              Remove
            </button>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="border-b border-ops-border bg-ops-bg/40">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex flex-wrap items-start gap-4">
              <div className="inline-flex rounded-lg border border-ops-border bg-ops-bg p-0.5">
                {(["admin", "viewer"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setDraftRole(r)}
                    disabled={isMe && r === "viewer"}
                    title={isMe && r === "viewer" ? "You can't demote yourself" : undefined}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-40 ${
                      draftRole === r ? "bg-brand-blue-500 text-white" : "text-ops-text-muted hover:text-ops-text"
                    }`}
                  >
                    {r === "admin" ? "Admin — full access" : "Viewer — read-only + picks"}
                  </button>
                ))}
              </div>
              {draftRole === "viewer" && (
                <PermissionPicker catalog={catalog} value={draftPerms} onChange={setDraftPerms} />
              )}
              <button
                type="button"
                onClick={() => onSave({ role: draftRole, permissions: draftRole === "viewer" ? draftPerms : [] })}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white hover:opacity-95"
              >
                Save
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Admins tab ────────────────────────────────────────────────────

interface AdminRow {
  email: string;
  added_by: string | null;
  added_at: string;
  note: string | null;
  role: "admin" | "viewer";
  permissions: string[];
  has_password: boolean;
}

interface PermissionInfo { key: string; label: string; detail: string }

function AdminsTab({ currentAdminEmail }: { currentAdminEmail: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery<{ admins: AdminRow[]; catalog: PermissionInfo[] }>({
    queryKey: ["ops-admins"],
    queryFn: () => fetch("/api/ops/admins").then((r) => r.json()),
  });
  const [newEmail, setNewEmail] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "viewer">("admin");
  const [newPerms, setNewPerms] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const admins = data?.admins ?? [];
  const catalog = data?.catalog ?? [];
  const me = currentAdminEmail.toLowerCase();

  const addAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setAdding(true);
    setActionMsg(null);
    try {
      const r = await fetch("/api/ops/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          note: newNote.trim() || undefined,
          role: newRole,
          permissions: newRole === "viewer" ? newPerms : [],
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setActionMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
      } else {
        setActionMsg({ tone: "ok", text: `✓ Added ${email} as ${newRole === "admin" ? "an admin" : "a viewer"}. They can sign in now.` });
        setNewEmail("");
        setNewNote("");
        setNewRole("admin");
        setNewPerms([]);
        queryClient.invalidateQueries({ queryKey: ["ops-admins"] });
      }
    } catch (err: any) {
      setActionMsg({ tone: "bad", text: err.message });
    } finally {
      setAdding(false);
    }
  };

  const removeAdmin = async (email: string) => {
    if (!confirm(`Remove ${email} from admins? They lose dashboard access immediately.`)) return;
    setActionMsg(null);
    try {
      const r = await fetch(`/api/ops/admins/${encodeURIComponent(email)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setActionMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
      } else {
        setActionMsg({ tone: "ok", text: `✓ Removed ${email}.` });
        refetch();
      }
    } catch (err: any) {
      setActionMsg({ tone: "bad", text: err.message });
    }
  };

  const saveMember = async (email: string, patch: { role?: "admin" | "viewer"; permissions?: string[] }) => {
    setActionMsg(null);
    try {
      const r = await fetch(`/api/ops/admins/${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setActionMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
      } else {
        setActionMsg({ tone: "ok", text: `✓ Updated ${email}.` });
        setEditing(null);
        queryClient.invalidateQueries({ queryKey: ["ops-admins"] });
      }
    } catch (err: any) {
      setActionMsg({ tone: "bad", text: err.message });
    }
  };

  return (
    <>
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 mb-5">
        <h3 className="text-sm font-semibold text-ops-text mb-1">Add team member</h3>
        <p className="text-[11px] text-ops-text-muted mb-3">
          Admins get full access to everything. Viewers see every page read-only, plus exactly the write permissions you tick below. Sign-in works immediately — Google account, or a password set from this table for shared mailboxes.
        </p>
        <form onSubmit={addAdmin} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="email@fitscript.me"
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
            required
            autoComplete="email"
          />
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Note (optional, e.g. role / why)"
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
          />
          <button
            type="submit"
            disabled={adding || !newEmail.trim()}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 hover:opacity-95 whitespace-nowrap"
          >
            {adding ? "Adding…" : newRole === "admin" ? "Add admin" : "Add viewer"}
          </button>
        </form>
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <div className="inline-flex rounded-lg border border-ops-border bg-ops-bg p-0.5">
            {(["admin", "viewer"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setNewRole(r)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  newRole === r ? "bg-brand-blue-500 text-white" : "text-ops-text-muted hover:text-ops-text"
                }`}
              >
                {r === "admin" ? "Admin — full access" : "Viewer — read-only + picks"}
              </button>
            ))}
          </div>
          {newRole === "viewer" && (
            <PermissionPicker catalog={catalog} value={newPerms} onChange={setNewPerms} />
          )}
        </div>
        {actionMsg && (
          <div className={`mt-3 px-3 py-2 rounded-lg text-xs ${
            actionMsg.tone === "ok"
              ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30"
              : "bg-red-500/10 text-red-400 border border-red-500/30"
          }`}>
            {actionMsg.text}
          </div>
        )}
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
        <div className="px-4 py-3 border-b border-ops-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ops-text">
            {admins.length} admin{admins.length === 1 ? "" : "s"}
          </h3>
          <span className="text-[11px] text-ops-text-subtle">DB-backed · cache 60s</span>
        </div>
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-ops-text-muted">Loading…</div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-red-400">Failed to load admins.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ops-text-muted border-b border-ops-border">
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Access</th>
                  <th className="px-4 py-2 font-semibold">Added by</th>
                  <th className="px-4 py-2 font-semibold">Added</th>
                  <th className="px-4 py-2 font-semibold">Note</th>
                  <th className="px-4 py-2 font-semibold w-0"></th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => {
                  const isMe = a.email.toLowerCase() === me;
                  const role = a.role ?? "admin";
                  const isEditing = editing === a.email;
                  return (
                    <MemberRow
                      key={a.email}
                      member={a}
                      role={role}
                      isMe={isMe}
                      lastMember={admins.length <= 1}
                      catalog={catalog}
                      editing={isEditing}
                      onEdit={() => setEditing(isEditing ? null : a.email)}
                      onSave={(patch) => saveMember(a.email, patch)}
                      onRemove={() => removeAdmin(a.email)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
